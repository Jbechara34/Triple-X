'use strict';

// Talks to monero-wallet-rpc (see docker-compose.yml monero-wallet-rpc
// service) for the Wallet tab's "Create Monero Wallet" flow. Runs in
// --wallet-dir mode, so wallets are managed by name over RPC rather than one
// fixed file at startup - ensureWalletOpen() below creates the "dashboard"
// wallet on first-ever use and opens it on every later call (monero-wallet-rpc
// doesn't keep a wallet open across its own restarts).
//
// Only ever calls create_wallet/open_wallet/get_address/query_key - nothing
// that can move funds (no transfer, no sweep).

const WALLET_NAME = 'dashboard';
const WALLET_LANGUAGE = 'English';

const RPC_HOST = process.env.MONERO_WALLET_RPC_HOST || 'monero-wallet-rpc';
const RPC_PORT = process.env.MONERO_WALLET_RPC_PORT || '18084';
const RPC_BASE = `http://${RPC_HOST}:${RPC_PORT}`;
const TIMEOUT_MS = 8000; // wallet creation/opening can be slower than a plain status poll

async function fetchWithTimeout(url, opts = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { ...opts, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function jsonRpc(method, params = {}) {
  const res = await fetchWithTimeout(`${RPC_BASE}/json_rpc`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: '0', method, params }),
  });
  if (!res.ok) {
    throw new Error(`monero-wallet-rpc HTTP ${res.status}`);
  }
  const body = await res.json();
  if (body.error) {
    throw new Error(`monero-wallet-rpc error: ${body.error.message || JSON.stringify(body.error)}`);
  }
  return body.result;
}

// Idempotent: opens the wallet if it already exists, creates it (implicitly
// opening it) if this is the very first call ever made against this
// instance's wallet-dir volume.
async function ensureWalletOpen() {
  try {
    await jsonRpc('open_wallet', { filename: WALLET_NAME });
    return { created: false };
  } catch (err) {
    // "Failed to open wallet" (code -1) when it doesn't exist yet is
    // expected on first run - anything else (wrong daemon, RPC down) should
    // still surface as an error instead of masking it with a bad create call.
    if (!/failed to open/i.test(err.message)) throw err;
  }
  await jsonRpc('create_wallet', { filename: WALLET_NAME, language: WALLET_LANGUAGE });
  return { created: true };
}

async function getAddress() {
  await ensureWalletOpen();
  const result = await jsonRpc('get_address', { account_index: 0 });
  return { address: result.address };
}

// 25-word mnemonic seed, derived from the wallet's own spend key - unlike
// Tari's one-time export file, this isn't a separate artifact that can be
// deleted out from under the wallet, so "shown once" for Monero is enforced
// by our own app state (lib/moneroWalletState.js), not by the seed itself
// becoming unrecoverable.
async function getSeedWords() {
  await ensureWalletOpen();
  const result = await jsonRpc('query_key', { key_type: 'mnemonic' });
  return result.key.trim().split(/\s+/).filter(Boolean);
}

module.exports = {
  ensureWalletOpen,
  getAddress,
  getSeedWords,
};
