'use strict';

// The "generate-once, show-once" half of the Wallet tab: minotari_console_wallet
// is started with --seed-words-file-name (see docker-compose.yml), which it
// writes to ONLY the first time it ever creates a wallet - never again on
// later restarts of an existing wallet. This module lets the seed be read
// and shown exactly once: revealSeedWords() reads the file and immediately
// deletes it, so a page refresh or a second visit to the Wallet tab can
// never show it again. Nothing here is ever written back to disk.
//
// Also backs the Wallet tab's "Create Wallet" button (requestWalletCreation)
// - minotari-wallet's entrypoint.sh does NOT start minotari_console_wallet
// on its own the very first time the container ever runs; it waits for this
// request file before ever generating a wallet, so a wallet isn't silently
// created just because the container exists. See docker/minotari-wallet/
// entrypoint.sh for the waiting side of this.

const fs = require('fs');
const path = require('path');

const SEED_FILE = process.env.MINOTARI_WALLET_SEED_FILE || '/data/minotari-wallet/seed-words.txt';
const CREATE_REQUEST_FILE = process.env.MINOTARI_WALLET_CREATE_REQUEST_FILE || '/data/minotari-wallet/create-wallet-requested';

// Drops the request file onto the volume shared with the minotari-wallet
// container - its entrypoint polls for exactly this, so no container
// restart (and no Docker socket) is needed just to create a wallet.
function requestWalletCreation() {
  fs.mkdirSync(path.dirname(CREATE_REQUEST_FILE), { recursive: true });
  fs.writeFileSync(CREATE_REQUEST_FILE, '');
}

function seedAvailable() {
  try {
    return fs.existsSync(SEED_FILE) && fs.statSync(SEED_FILE).size > 0;
  } catch {
    return false;
  }
}

// Returns the seed phrase as an array of words, or null if it was already
// revealed (or a wallet was never freshly created). Deletes the file on the
// way out, success or failure, so a crash mid-request can't leave it
// readable-but-unlisted.
function revealSeedWords() {
  let contents = null;
  try {
    contents = fs.readFileSync(SEED_FILE, 'utf8');
  } catch {
    return null;
  } finally {
    try {
      fs.unlinkSync(SEED_FILE);
    } catch {
      // already gone, or never existed - fine either way
    }
  }
  const words = contents.trim().split(/\s+/).filter(Boolean);
  return words.length ? words : null;
}

module.exports = {
  seedAvailable,
  revealSeedWords,
  requestWalletCreation,
};
