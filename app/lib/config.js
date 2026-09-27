'use strict';

const fs = require('fs');
const path = require('path');

// This directory is a shared Docker volume (see docker-compose.yml -> config-data).
// The p2pool container's entrypoint.sh polls settings.json from the same volume so
// that changes saved here are picked up (and p2pool restarted) automatically.
const CONFIG_DIR = process.env.CONFIG_DIR || '/data/config';
const CONFIG_FILE = path.join(CONFIG_DIR, 'settings.json');

const VALID_MODES = ['standard', 'mini', 'nano'];

const DEFAULTS = {
  walletAddress: '',
  poolMode: 'standard', // standard | mini | nano  (see README: maps to --mini / --nano flags)
  // Optional Tari (XTM) merge-mining payout address - EXPERIMENTAL. Leave
  // blank to keep mining XMR only (see docker/p2pool/entrypoint.sh).
  tariAddress: '',
  // Off by default - enabling this sends your payout address to the public
  // git.gammaspectra.live/P2Pool/observer service (over clearnet) to fetch
  // your lifetime share history. See lib/p2poolObserver.js.
  observerEnabled: false,
  // On by default (unchanged from before this setting existed) - lets users
  // who don't need it hide the Logs tab from the nav instead of leaving it
  // always visible.
  logsTabEnabled: true,
  // Optional P2Pool memory-usage flags (see docker/p2pool/entrypoint.sh) -
  // all off by default, unchanged behavior unless a user opts in.
  p2poolLightMode: false,
  p2poolNoRandomx: false,
  p2poolNoCache: false,
  updatedAt: null,
};

function ensureDir() {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
}

function readSettings() {
  try {
    const raw = fs.readFileSync(CONFIG_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return { ...DEFAULTS, ...parsed };
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.error('[config] failed to read settings.json:', err.message);
    }
    return { ...DEFAULTS };
  }
}

// Very permissive validation: a real Monero mainnet primary address is 95
// base58 characters starting with 4 (or 4...integrated addresses are 106
// chars, not supported by p2pool). We only do a light sanity check here and
// let monerod/p2pool be the source of truth - they will refuse a bad address.
function isPlausibleMoneroAddress(addr) {
  if (typeof addr !== 'string') return false;
  const trimmed = addr.trim();
  return /^4[0-9AB][1-9A-HJ-NP-Za-km-z]{93}$/.test(trimmed);
}

function writeSettings(update) {
  ensureDir();
  const current = readSettings();

  const next = { ...current };

  if (typeof update.walletAddress === 'string') {
    const addr = update.walletAddress.trim();
    if (addr && !isPlausibleMoneroAddress(addr)) {
      const err = new Error(
        'That does not look like a valid Monero primary address (should be 95 characters, starting with 4). ' +
        'Subaddresses (starting with 8) are not supported by P2Pool.'
      );
      err.statusCode = 400;
      throw err;
    }
    next.walletAddress = addr;
  }

  if (typeof update.poolMode === 'string') {
    const mode = update.poolMode.trim().toLowerCase();
    if (!VALID_MODES.includes(mode)) {
      const err = new Error(`poolMode must be one of: ${VALID_MODES.join(', ')}`);
      err.statusCode = 400;
      throw err;
    }
    next.poolMode = mode;
  }

  if (typeof update.tariAddress === 'string') {
    // No format validation - Tari's address encoding isn't pinned down here
    // yet (EXPERIMENTAL feature). p2pool/the Tari node are the source of
    // truth and will reject a bad address.
    next.tariAddress = update.tariAddress.trim();
  }

  if (typeof update.observerEnabled === 'boolean') {
    next.observerEnabled = update.observerEnabled;
  }

  if (typeof update.logsTabEnabled === 'boolean') {
    next.logsTabEnabled = update.logsTabEnabled;
  }

  if (typeof update.p2poolLightMode === 'boolean') {
    next.p2poolLightMode = update.p2poolLightMode;
  }

  if (typeof update.p2poolNoRandomx === 'boolean') {
    next.p2poolNoRandomx = update.p2poolNoRandomx;
  }

  if (typeof update.p2poolNoCache === 'boolean') {
    next.p2poolNoCache = update.p2poolNoCache;
  }

  next.updatedAt = new Date().toISOString();

  // Atomic-ish write so the p2pool entrypoint never reads a half-written file.
  const tmpFile = `${CONFIG_FILE}.tmp`;
  fs.writeFileSync(tmpFile, JSON.stringify(next, null, 2));
  fs.renameSync(tmpFile, CONFIG_FILE);

  return next;
}

module.exports = {
  CONFIG_FILE,
  VALID_MODES,
  readSettings,
  writeSettings,
  isPlausibleMoneroAddress,
};
