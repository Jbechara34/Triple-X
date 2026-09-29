'use strict';

/**
 * EXPERIMENTAL - mirrors app/lib/blocks.js, but for Tari (XTM) merge-mined
 * blocks. Unlike XMR-via-P2Pool, Tari is currently solo-mined per p2pool's
 * own --merge-mine docs - a submitted share only pays out XTM when it also
 * happens to meet Tari's full network difficulty.
 *
 * IMPORTANT: the exact log wording minotari_node uses when it successfully
 * mines/submits a block has NOT been confirmed against a live node - this
 * regex is a best-effort guess (same caveat app/lib/blocks.js already
 * documents for p2pool's own log wording). If XTM blocks stop showing up
 * after this ships, run:
 *   docker compose logs minotari-node | grep -i "block"
 * and adjust BLOCK_FOUND_RE below to match what you actually see.
 */

const fsp = require('fs/promises');
const path = require('path');
const config = require('./config');
const discordNotify = require('./discordNotify');

const LOG_FILE = process.env.MINOTARI_LOG_FILE || '/data/minotari-logs/base_node.log';
const STATE_DIR = process.env.STATE_DIR || '/data/state';
const STATE_FILE = path.join(STATE_DIR, 'tari-blocks-state.json');

const MAX_BLOCKS = 200;
const MIN_SAVE_INTERVAL_MS = 60 * 1000; // see app/lib/blocks.js's identical constant - batch writes instead of rewriting the whole state file every poll tick

// Best-effort - see header comment.
const BLOCK_FOUND_RE = /\b(mined|found|submitted)\b[^\n]*\bblock\b[^\n]*?(?:height|#)[:\s]+(\d+)/i;
const HEIGHT_ONLY_RE = /(?:height|#)[:\s]+(\d+)/i;
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
  if (!/mined|block found|submitted block/i.test(line)) return;

  const tsMatch = line.match(TIMESTAMP_PREFIX_RE);
  const detectedAt = tsMatch ? tsMatch[1] : new Date().toISOString();
  const heightMatch = line.match(BLOCK_FOUND_RE) || line.match(HEIGHT_ONLY_RE);
  const height = heightMatch ? Number(heightMatch[heightMatch.length - 1]) : null;

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
