'use strict';

// The "generate-once, show-once" half of the Wallet tab: minotari_console_wallet
// is started with --seed-words-file-name (see docker-compose.yml), which it
// writes to ONLY the first time it ever creates a wallet - never again on
// later restarts of an existing wallet. This module lets the seed be read
// and shown exactly once: revealSeedWords() reads the file and immediately
// deletes it, so a page refresh or a second visit to the Wallet tab can
// never show it again. Nothing here is ever written back to disk.

const fs = require('fs');

const SEED_FILE = process.env.MINOTARI_WALLET_SEED_FILE || '/data/minotari-wallet/seed-words.txt';

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
};
