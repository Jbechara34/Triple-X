'use strict';

/**
 * EXPERIMENTAL - mirrors app/lib/blocks.js, but for Tari (XTM) merge-mined
 * blocks. Unlike XMR-via-P2Pool, Tari is currently solo-mined per p2pool's
 * own --merge-mine docs - a submitted share only pays out XTM when it also
 * happens to meet Tari's full network difficulty.
 *
 * CONFIRMED against tari-project/tari's real source, not guessed - two
 * earlier regex attempts here each produced real false positives (matching
 * unrelated log lines that happened to contain "mined"/"found" near
 * "block"+a height, see git history). base_node/comms_interface/
 * local_interface.rs's submit_block() - which is what p2pool's merge-mining
 * SubmitBlock gRPC call routes through - forwards into the exact same
 * handler every P2P-received block goes through
 * (comms_interface/inbound_handlers.rs's handle_block()), which logs at
 * INFO:
 *   "Block #{height} ({hash}) received from {source}"
 * `{source}` is "remote peer: <id>" for every block synced from the network
 * (happens constantly during normal sync - NOT a block this node found) or
 * the literal "local services" only when it came from this node's own
 * submission path. That's the one unambiguous signal this detector needs.
 */

const fsp = require('fs/promises');
const path = require('path');
const config = require('./config');
const discordNotify = require('./discordNotify');

// Not a flat "base_node.log" - see app/server.js's identical constant for
// why (the official minotari_node image's own log4rs config splits output
// into a base_node/ subdirectory).
const LOG_FILE = process.env.MINOTARI_LOG_FILE || '/data/minotari-logs/base_node/base_layer.log';
const STATE_DIR = process.env.STATE_DIR || '/data/state';
const STATE_FILE = path.join(STATE_DIR, 'tari-blocks-state.json');

const MAX_BLOCKS = 200;
const MIN_SAVE_INTERVAL_MS = 60 * 1000; // see app/lib/blocks.js's identical constant - batch writes instead of rewriting the whole state file every poll tick

// See header comment - "local services" is the part that's actually
// diagnostic; "Block #N (hash) received from" alone happens for every block
// during normal sync too.
const BLOCK_FOUND_RE = /Block #(\d+)[^\n]*received from local services/i;
const TIMESTAMP_PREFIX_RE = /^(\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2})/;

let state = {
  offset: 0,
  blocks: [], // { height, detectedAt, raw }
};

async function loadState() {
  try {
    const raw = await fsp.readFile(STATE_FILE, 'utf8');
    state = { ...state, ...JSON.parse(raw) };
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.error('[tariBlocks] failed to load state:', err.message);
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
    console.error('[tariBlocks] failed to save state:', err.message);
  } finally {
    saveQueued = false;
  }
}

// Batches writes instead of saving on every poll tick with a new line -
// `force` (a block was just found) bypasses the throttle.
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
  const heightMatch = line.match(BLOCK_FOUND_RE);
  if (!heightMatch) return;

  const tsMatch = line.match(TIMESTAMP_PREFIX_RE);
  const detectedAt = tsMatch ? tsMatch[1] : new Date().toISOString();
  const height = Number(heightMatch[1]);

  state.blocks.unshift({ height, detectedAt, raw: line.trim() });
  state.blocks = state.blocks.slice(0, MAX_BLOCKS);

  if (config.readSettings().discordNotifyXtmBlocks) {
    discordNotify.send(`🟢 **Tari (XTM) block found!**${height ? ` Height ${height}` : ''}`);
  }
}

async function pollOnce() {
  let fh;
  try {
    fh = await fsp.open(LOG_FILE, 'r');
    const stat = await fh.stat();

    if (stat.size < state.offset) {
      state.offset = 0; // rotated/truncated
    }

    const toRead = stat.size - state.offset;
    if (toRead <= 0) {
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
      const before = state.blocks.length;
      parseLine(line);
      if (state.blocks.length !== before) {
        blockFound = true;
        dirty = true;
      }
    }
    await maybeSaveState(blockFound);
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.error('[tariBlocks] log poll failed:', err.message);
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

module.exports = { start, getBlocks, LOG_FILE };
