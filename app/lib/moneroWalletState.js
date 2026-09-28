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

const DEFAULT_WALLET_NAME = 'dashboard';

function read() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return { seedRevealed: false, activeWalletName: DEFAULT_WALLET_NAME };
  }
}

function write(patch) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  const next = { ...read(), ...patch };
  const tmpFile = `${STATE_FILE}.tmp`;
  fs.writeFileSync(tmpFile, JSON.stringify(next, null, 2));
  fs.renameSync(tmpFile, STATE_FILE);
}

function seedRevealed() {
  return !!read().seedRevealed;
}

function markSeedRevealed() {
  write({ seedRevealed: true });
}

// Which monero-wallet-rpc --wallet-dir entry this dashboard currently talks
// to. Normally always "dashboard" - only changes when Recover Wallet
// restores a seed into a freshly-named wallet file (see
// moneroWalletRpc.js's restoreFromSeed), since monero-wallet-rpc's
// restore_deterministic_wallet refuses to overwrite a filename that already
// has a wallet on disk.
function getActiveWalletName() {
  return read().activeWalletName || DEFAULT_WALLET_NAME;
}

// Recovering a wallet the user already holds the seed phrase for doesn't
// need the same one-time-reveal protection a freshly-generated wallet does -
// marking it revealed here just means the app won't offer to "reveal" a
// seed the user just typed in themselves.
function setActiveWalletName(name) {
  write({ activeWalletName: name, seedRevealed: true });
}

module.exports = {
  seedRevealed,
  markSeedRevealed,
  getActiveWalletName,
  setActiveWalletName,
};
