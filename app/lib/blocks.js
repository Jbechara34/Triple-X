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

const LOG_FILE = process.env.P2POOL_LOG_FILE || '/data/p2pool-logs/p2pool.log';
const STATE_DIR = process.env.STATE_DIR || '/data/state';
const STATE_FILE = path.join(STATE_DIR, 'blocks-state.json');

const MAX_BLOCKS = 200;
const WORKER_STALE_MS = 24 * 60 * 60 * 1000; // drop workers not seen in 24h from the "active" view

// Best-effort patterns - see header comment.
const BLOCK_FOUND_RE = /BLOCK FOUND[^\n]*?height[:\s]+(\d+)[^\n]*/i;
const HEIGHT_ONLY_RE = /height[:\s]+(\d+)/i;
const HASH_RE = /\b([0-9a-f]{64})\b/i;
const SHARE_FOUND_RE = /SHARE FOUND[^\n]*?user[:\s]+([^\s,]+)/i;
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

let saveQueued = false;
async function saveState() {
  if (saveQueued) return;
  saveQueued = true;
  try {
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

function parseLine(line) {
  const tsMatch = line.match(TIMESTAMP_PREFIX_RE);
  const detectedAt = tsMatch ? tsMatch[1] : new Date().toISOString();

  if (/BLOCK FOUND/i.test(line)) {
    const heightMatch = line.match(BLOCK_FOUND_RE) || line.match(HEIGHT_ONLY_RE);
    const hashMatch = line.match(HASH_RE);
    state.blocks.unshift({
      height: heightMatch ? Number(heightMatch[1]) : null,
      hash: hashMatch ? hashMatch[1] : null,
      detectedAt,
      raw: line.trim(),
    });
    state.blocks = state.blocks.slice(0, MAX_BLOCKS);
    return;
  }

  if (/SHARE FOUND/i.test(line)) {
    const userMatch = line.match(SHARE_FOUND_RE);
    const name = userMatch ? userMatch[1] : 'unknown';
    const entry = state.workers[name] || { shares: 0, firstSeen: detectedAt };
    entry.shares += 1;
    entry.lastSeen = detectedAt;
    state.workers[name] = entry;
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
    if (toRead <= 0) return;

    const buf = Buffer.alloc(toRead);
    await fh.read(buf, 0, toRead, state.offset);
    state.offset = stat.size;

    const text = buf.toString('utf8');
    const lines = text.split('\n');
    let changed = false;
    for (const line of lines) {
      if (!line.trim()) continue;
      if (/BLOCK FOUND|SHARE FOUND/i.test(line)) {
        parseLine(line);
        changed = true;
      }
    }
    if (changed) await saveState();
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
  }));
}

module.exports = { start, getBlocks, getWorkers, LOG_FILE };
