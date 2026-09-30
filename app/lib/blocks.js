'use strict';

/**
 * P2Pool's local JSON API (local/stratum, network/stats, pool/stats) does not
 * expose a "blocks my node found" history or a per-worker breakdown - those
 * only exist in the running process's console/log output. So we tail
 * p2pool's log file (docker/p2pool/entrypoint.sh redirects p2pool's stdout
 * there) and look for two kinds of lines:
 *
 *   - "BLOCK FOUND" - the sidechain found a full Monero block. We record it
 *     and link out to a block explorer so you can independently verify the
 *     payout landed on your configured wallet address, per the requirement
 *     that blocks-found be confirmed against a Monero blockchain explorer.
 *   - "SHARE FOUND" - a connected worker submitted a valid share. p2pool
 *     logs the stratum username here (see p2pool changelog: "Decode custom
 *     user from stratum client, display stratum client+user on SHARE FOUND
 *     ... message"), which is the only place a per-worker identity shows up.
 *
 * IMPORTANT: exact log wording can change between p2pool releases. If blocks
 * or workers stop showing up after an update, run:
 *   docker compose logs p2pool | grep -i "found"
 * and adjust BLOCK_FOUND_RE / SHARE_FOUND_RE below to match.
 *
 * State is persisted to /data/state so it survives a backend restart, and
 * the log is read incrementally via a byte offset instead of being
 * re-parsed from scratch every poll.
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const config = require('./config');
const discordNotify = require('./discordNotify');

// Same default this app's server.js uses for building explorer links - kept
// here too so a block-found Discord alert can include one without server.js
// having to reach into this module's internals.
const EXPLORER_BASE_URL = process.env.EXPLORER_BASE_URL || 'https://xmrchain.net';

const LOG_FILE = process.env.P2POOL_LOG_FILE || '/data/p2pool-logs/p2pool.log';
const STATE_DIR = process.env.STATE_DIR || '/data/state';
const STATE_FILE = path.join(STATE_DIR, 'blocks-state.json');

const MAX_BLOCKS = 200;
const WORKER_STALE_MS = 24 * 60 * 60 * 1000; // drop workers not seen in 24h from the "active" view
const WORKER_PRUNE_MS = 90 * 24 * 60 * 60 * 1000; // forget workers not seen in 90 days entirely, so state.workers doesn't grow forever over a long-running install
const MIN_SAVE_INTERVAL_MS = 60 * 1000; // during active mining almost every 15s poll tick has new shares - rewriting the whole state file (all blocks + all workers) that often is wasted disk I/O for a cache that only needs to survive a restart, so batch writes to at most once/minute (a found block still flushes immediately, see maybeSaveState)

// p2pool prints "BLOCK FOUND" on EVERY node in the sidechain whenever ANY
// participant's share reaches Monero's network difficulty, not just the one
// whose miner actually found it - confirmed directly against p2pool's own
// source (src/side_chain.cpp, SideChain::add_external_block): the message
// itself says "...was mined by you" or "...was mined by someone else in this
// p2pool" depending on whether the winning share's wallet matches this
// node's configured payout wallet. Without checking for "by you" here, this
// list previously recorded every block anyone on the whole sidechain found.
const BLOCK_FOUND_BY_YOU_RE = /BLOCK FOUND[^\n]*?\bby you\b/i;
// Best-effort patterns - see header comment.
const BLOCK_FOUND_RE = /BLOCK FOUND[^\n]*?height[:\s]+(\d+)[^\n]*/i;
const HEIGHT_ONLY_RE = /height[:\s]+(\d+)/i;
const HASH_RE = /\b([0-9a-f]{64})\b/i;
const SHARE_FOUND_RE = /SHARE FOUND[^\n]*?user[:\s]+([^\s,]+)/i;
// p2pool's own log line (see src/stratum_server.cpp): "SHARE FOUND: mainchain
// height H, sidechain height H2, diff D, client ADDR, user USER, effort E%" -
// "diff" here is that specific share's sidechain difficulty, which is what
// lets us track each worker's best (highest-difficulty) share seen, the same
// "record share vs network difficulty" concept p2pool's own bestShare stats
// already use pool-wide (see p2poolApi.js currentEffort/averageEffort).
const SHARE_DIFF_RE = /SHARE FOUND[^\n]*?diff[:\s]+(\d+)/i;
const TIMESTAMP_PREFIX_RE = /^(\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2})/;

let state = {
  offset: 0,
  blocks: [], // { height, hash, detectedAt, raw }
  workers: {}, // { [name]: { shares, firstSeen, lastSeen } }
};

async function loadState() {
  try {
    const raw = await fsp.readFile(STATE_FILE, 'utf8');
    state = { ...state, ...JSON.parse(raw) };
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.error('[blocks] failed to load state:', err.message);
    }
  }
}

function pruneStaleWorkers() {
  const now = Date.now();
  for (const [name, w] of Object.entries(state.workers)) {
    if (now - new Date(w.lastSeen).getTime() > WORKER_PRUNE_MS) {
      delete state.workers[name];
    }
  }
}

let saveQueued = false;
async function saveState() {
  if (saveQueued) return;
  saveQueued = true;
  try {
    pruneStaleWorkers();
    await fsp.mkdir(STATE_DIR, { recursive: true });
    const tmp = `${STATE_FILE}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(state, null, 2));
    await fsp.rename(tmp, STATE_FILE);
  } catch (err) {
    console.error('[blocks] failed to save state:', err.message);
  } finally {
    saveQueued = false;
  }
}

// Batches writes (see MIN_SAVE_INTERVAL_MS above) instead of saving on every
// single poll tick that had new log lines. `force` (a block was just found)
// bypasses the throttle - that event is rare and worth persisting right away.
let dirty = false;
let lastSavedAt = 0;
async function maybeSaveState(force) {
  if (!dirty) return;
  const now = Date.now();
  if (!force && now - lastSavedAt < MIN_SAVE_INTERVAL_MS) return;
  dirty = false;
  lastSavedAt = now;
  await saveState();
}

function parseLine(line) {
  const tsMatch = line.match(TIMESTAMP_PREFIX_RE);
  const detectedAt = tsMatch ? tsMatch[1] : new Date().toISOString();

  if (/BLOCK FOUND/i.test(line)) {
    if (!BLOCK_FOUND_BY_YOU_RE.test(line)) return; // someone else's block - not this node's payout address
    const heightMatch = line.match(BLOCK_FOUND_RE) || line.match(HEIGHT_ONLY_RE);
    const hashMatch = line.match(HASH_RE);
    const height = heightMatch ? Number(heightMatch[1]) : null;
    const hash = hashMatch ? hashMatch[1] : null;
    state.blocks.unshift({ height, hash, detectedAt, raw: line.trim() });
    state.blocks = state.blocks.slice(0, MAX_BLOCKS);

    if (config.readSettings().discordNotifyXmrBlocks) {
      const link = hash ? `${EXPLORER_BASE_URL}/search?value=${hash}` : (height ? `${EXPLORER_BASE_URL}/block/${height}` : null);
      discordNotify.send(`🟠 **Monero block found!**${height ? ` Height ${height}` : ''}${link ? `\n${link}` : ''}`);
    }
    return;
  }

  if (/SHARE FOUND/i.test(line)) {
    const userMatch = line.match(SHARE_FOUND_RE);
    const name = userMatch ? userMatch[1] : 'unknown';
    const diffMatch = line.match(SHARE_DIFF_RE);
    const diff = diffMatch ? Number(diffMatch[1]) : null;
    const entry = state.workers[name] || { shares: 0, firstSeen: detectedAt, bestDifficulty: 0 };
    entry.shares += 1;
    entry.lastSeen = detectedAt;
    if (diff !== null && diff > (entry.bestDifficulty || 0)) {
      entry.bestDifficulty = diff;
    }
    // The difficulty this specific share was submitted at - P2Pool's stratum
    // uses vardiff (auto-adjusts each worker's target over time), so this is
    // the closest thing to "what difficulty is this worker mining at right
    // now", as opposed to bestDifficulty (their all-time highest, which only
    // trends upward and doesn't reflect a worker's current setting).
    if (diff !== null) {
      entry.currentDifficulty = diff;
    }
    state.workers[name] = entry;

    if (config.readSettings().discordNotifyShares) {
      discordNotify.send(`🟡 **P2Pool share found!** Worker \`${name}\`${diff ? ` (difficulty ${diff})` : ''} - counts toward your next PPLNS payout.`);
    }
  }
}

async function pollOnce() {
  let fh;
  try {
    fh = await fsp.open(LOG_FILE, 'r');
    const stat = await fh.stat();

    // Log rotated/truncated (e.g. by logrotate) - start over from the top.
    if (stat.size < state.offset) {
      state.offset = 0;
    }

    const toRead = stat.size - state.offset;
    if (toRead <= 0) {
      // No new log lines this tick, but a previous tick may still be
      // waiting out the save throttle below - give it a chance to flush.
      await maybeSaveState();
      return;
    }

    const buf = Buffer.alloc(toRead);
    await fh.read(buf, 0, toRead, state.offset);
    state.offset = stat.size;

    const text = buf.toString('utf8');
    const lines = text.split('\n');
    let blockFound = false;
    for (const line of lines) {
      if (!line.trim()) continue;
      if (/BLOCK FOUND/i.test(line)) blockFound = true;
      if (/BLOCK FOUND|SHARE FOUND/i.test(line)) {
        parseLine(line);
        dirty = true;
      }
    }
    await maybeSaveState(blockFound);
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.error('[blocks] log poll failed:', err.message);
    }
  } finally {
    if (fh) await fh.close();
  }
}

const POLL_INTERVAL_MS = 15000;
let started = false;
function start() {
  if (started) return;
  started = true;
  loadState().then(() => {
    pollOnce();
    setInterval(pollOnce, POLL_INTERVAL_MS);
  });
}

function getBlocks() {
  return state.blocks;
}

function getWorkers() {
  const now = Date.now();
  return Object.entries(state.workers).map(([name, w]) => ({
    name,
    shares: w.shares,
    firstSeen: w.firstSeen,
    lastSeen: w.lastSeen,
    active: now - new Date(w.lastSeen).getTime() < WORKER_STALE_MS,
    bestDifficulty: w.bestDifficulty || 0,
    currentDifficulty: w.currentDifficulty || 0,
  }));
}

module.exports = { start, getBlocks, getWorkers, LOG_FILE };
