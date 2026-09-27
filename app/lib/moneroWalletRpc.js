'use strict';

// Talks to monero-wallet-rpc (see docker-compose.yml monero-wallet-rpc
// service) for the Wallet tab's "Create Monero Wallet" flow. Runs in
// --wallet-dir mode, so wallets are managed by name over RPC rather than one
// fixed file at startup - ensureWalletOpen() below creates the "dashboard"
// wallet on first-ever use and opens it on every later call (monero-wallet-rpc
// doesn't keep a wallet open across its own restarts).
//
// Also calls get_balance and transfer (Send tab) - unlike the read-only
// design this module started with, this now CAN move funds. Amounts are
// kept as decimal strings end-to-end and converted with BigInt (see
// xmrToAtomicUnits) rather than JS Number, since a plain float can't
// represent atomic units exactly and this is real money.

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

// Monero has 12 decimal places ("atomic units" = piconero).
const ATOMIC_DECIMALS = 12;

// Converts a decimal XMR amount string (e.g. "1.5") to a BigInt count of
// atomic units. BigInt (not Number) because atomic-unit amounts can exceed
// Number.MAX_SAFE_INTEGER and this is real money - a float would silently
// round the wrong way.
function xmrToAtomicUnits(amountStr) {
  const trimmed = String(amountStr).trim();
  if (!/^\d+(\.\d{1,12})?$/.test(trimmed)) {
    const err = new Error('Amount must be a positive decimal number with up to 12 decimal places.');
    err.statusCode = 400;
    throw err;
  }
  const [whole, frac = ''] = trimmed.split('.');
  const fracPadded = (frac + '0'.repeat(ATOMIC_DECIMALS)).slice(0, ATOMIC_DECIMALS);
  const atomic = BigInt(whole) * (10n ** BigInt(ATOMIC_DECIMALS)) + BigInt(fracPadded);
  if (atomic <= 0n) {
    const err = new Error('Amount must be greater than zero.');
    err.statusCode = 400;
    throw err;
  }
  return atomic;
}

// Converts an atomic-unit amount (Number or BigInt, as monero-wallet-rpc
// returns it) to a plain XMR decimal string for display.
function atomicUnitsToXmr(atomic) {
  const base = 10n ** BigInt(ATOMIC_DECIMALS);
  const value = BigInt(atomic);
  const whole = value / base;
  const frac = (value % base).toString().padStart(ATOMIC_DECIMALS, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : `${whole}`;
}

async function getBalance() {
  await ensureWalletOpen();
  const result = await jsonRpc('get_balance', { account_index: 0 });
  return {
    balance: atomicUnitsToXmr(result.balance),
    unlockedBalance: atomicUnitsToXmr(result.unlocked_balance),
  };
}

// Sends XMR from the dashboard's wallet. amountStr is a decimal XMR string
// (e.g. "0.5"), converted to atomic units via BigInt above so the exact
// amount requested is what actually gets sent - never a float-rounded
// approximation. Returns the tx hash and the actual network fee paid (both
// come back from monero-wallet-rpc itself, not computed here).
async function transfer(address, amountStr) {
  // Validate the amount before making any network call - a bad amount
  // should fail instantly, not get masked by an 8-second RPC timeout if the
  // wallet also happens to be unreachable.
  const atomicAmount = xmrToAtomicUnits(amountStr);
  await ensureWalletOpen();
  // monero-wallet-rpc's JSON-RPC amount field is an unsigned 64-bit integer.
  // JS's JSON.stringify can't safely serialize a BigInt or an integer beyond
  // Number.MAX_SAFE_INTEGER without precision loss, so refuse rather than
  // silently sending the wrong amount - a single-transfer amount this large
  // is not a realistic case for this dashboard.
  if (atomicAmount > BigInt(Number.MAX_SAFE_INTEGER)) {
    const err = new Error('Amount is too large to send in a single transfer through this dashboard.');
    err.statusCode = 400;
    throw err;
  }
  const result = await jsonRpc('transfer', {
    destinations: [{ address, amount: Number(atomicAmount) }],
    account_index: 0,
    priority: 0, // default priority, matches monero-wallet-rpc's own default
    get_tx_key: false,
  });
  return {
    txHash: result.tx_hash,
    feeXmr: atomicUnitsToXmr(result.fee),
    amountXmr: atomicUnitsToXmr(atomicAmount),
  };
}

module.exports = {
  ensureWalletOpen,
  getAddress,
  getSeedWords,
  getBalance,
  transfer,
};
