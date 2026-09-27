'use strict';

// Tracks whether this dashboard has already shown the Monero wallet's seed
// phrase once. Unlike Tari's seed-words file (a separate export that gets
// deleted - see lib/tariWallet.js), Monero's mnemonic is derived from the
// wallet's own spend key via query_key and stays retrievable from
// monero-wallet-rpc for as long as the wallet exists. So "generate-once,
// show-once" for Monero is enforced here, at the application layer: once
// revealed is true, the /api/wallet/monero/reveal-seed route refuses to call
// query_key again. (Someone with direct RPC/CLI access to the
// monero-wallet-rpc container could still retrieve it - this flag only
// stops a second reveal through this dashboard's own UI.)

const fs = require('fs');
const path = require('path');

const STATE_FILE = process.env.MONERO_WALLET_STATE_FILE || '/data/state/monero-wallet.json';

function read() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return { seedRevealed: false };
  }
}

function seedRevealed() {
  return !!read().seedRevealed;
}

function markSeedRevealed() {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  const tmpFile = `${STATE_FILE}.tmp`;
  fs.writeFileSync(tmpFile, JSON.stringify({ seedRevealed: true }, null, 2));
  fs.renameSync(tmpFile, STATE_FILE);
}

module.exports = {
  seedRevealed,
  markSeedRevealed,
};
