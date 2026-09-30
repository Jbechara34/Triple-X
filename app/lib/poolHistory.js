'use strict';

/**
 * Server-side hashrate/difficulty history for the Pool tab's two history
 * graphs - see app/public/js/preview.js. Previously these graphs only kept a
 * 60-point in-memory buffer on the CLIENT side (reset on every page reload,
 * ~10 minutes of history at the 10s refresh interval) - nowhere near the
 * CK Pool-style dashboard's much longer view. This persists samples to disk
 * on its own schedule (independent of whether anyone has the dashboard
 * open), the same way lib/blocks.js and lib/tariBlocks.js already persist
 * their own state, so a real history survives page reloads and backend
 * restarts.
 */

const fsp = require('fs/promises');
const path = require('path');
const p2poolApi = require('./p2poolApi');

const STATE_DIR = process.env.STATE_DIR || '/data/state';
const STATE_FILE = path.join(STATE_DIR, 'pool-history.json');

const SAMPLE_INTERVAL_MS = 60 * 1000; // one point per minute
const RETENTION_MS = 24 * 60 * 60 * 1000; // keep 24h - 1440 points at 1/min, a small JSON file
const MIN_SAVE_INTERVAL_MS = 60 * 1000; // one point per tick anyway, so this just avoids saving an unchanged file if a tick's read failed

let state = {
  samples: [], // { t, hashrate15m, hashrate1h, hashrate24h, sidechainDifficulty }
};

async function loadState() {
  try {
    const raw = await fsp.readFile(STATE_FILE, 'utf8');
    state = { ...state, ...JSON.parse(raw) };
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.error('[poolHistory] failed to load state:', err.message);
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
    await fsp.writeFile(tmp, JSON.stringify(state));
    await fsp.rename(tmp, STATE_FILE);
  } catch (err) {
    console.error('[poolHistory] failed to save state:', err.message);
  } finally {
    saveQueued = false;
  }
}

let lastSavedAt = 0;
async function maybeSaveState() {
  const now = Date.now();
  if (now - lastSavedAt < MIN_SAVE_INTERVAL_MS) return;
  lastSavedAt = now;
  await saveState();
}

async function pollOnce() {
  let stratum;
  let pool;
  try {
    [stratum, pool] = await Promise.all([p2poolApi.getLocalStratum(), p2poolApi.getPoolStats()]);
  } catch {
    return; // p2pool's API files not readable this tick - try again next poll
  }
  if (!stratum.connected && !pool.connected) return; // p2pool not running - nothing to sample

  const now = Date.now();
  state.samples.push({
    t: now,
    hashrate15m: stratum.hashrate15m,
    hashrate1h: stratum.hashrate1h,
    hashrate24h: stratum.hashrate24h,
    sidechainDifficulty: pool.sidechainDifficulty,
  });

  const cutoff = now - RETENTION_MS;
  while (state.samples.length && state.samples[0].t < cutoff) {
    state.samples.shift();
  }

  await maybeSaveState();
}

const POLL_INTERVAL_MS = SAMPLE_INTERVAL_MS;
let started = false;
function start() {
  if (started) return;
  started = true;
  loadState().then(() => {
    pollOnce();
    setInterval(pollOnce, POLL_INTERVAL_MS);
  });
}

function getSamples() {
  return state.samples;
}

module.exports = { start, getSamples };
