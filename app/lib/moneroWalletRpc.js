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
//
// Also backs the Wallet tab's "Recover Wallet" button (restoreFromSeed) -
// see moneroWalletState.js for why the active wallet's filename isn't
// always the fixed "dashboard" name.

const moneroWalletState = require('./moneroWalletState');

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

// Opens the active wallet - does NOT create one. A wallet is only ever
// created by createWallet() below, in response to the Wallet tab's explicit
// "Create Wallet" button - never silently, just because something happened
// to call this first. Throws a clear, user-facing 404 if no wallet exists
// yet, so callers (and the routes that use them) can tell "no wallet yet"
// apart from "RPC unreachable".
async function ensureWalletOpen() {
  const walletName = moneroWalletState.getActiveWalletName();
  try {
    await jsonRpc('open_wallet', { filename: walletName });
  } catch (err) {
    // "Failed to open wallet" (code -1) when it doesn't exist yet is
    // expected before the user has ever created one - anything else (wrong
    // daemon, RPC down) should still surface as-is.
    if (!/failed to open/i.test(err.message)) throw err;
    const notCreatedErr = new Error('This wallet has not been created yet - use the Create Wallet button on the Wallet tab.');
    notCreatedErr.statusCode = 404;
    throw notCreatedErr;
  }
}

// Idempotent: creates the active wallet if it doesn't exist yet, or just
// confirms it's open if it already does (so clicking "Create Wallet" twice,
// or on a page that already has one, is harmless).
async function createWallet() {
  const walletName = moneroWalletState.getActiveWalletName();
  try {
    await jsonRpc('open_wallet', { filename: walletName });
    return { created: false };
  } catch (err) {
    if (!/failed to open/i.test(err.message)) throw err;
  }
  await jsonRpc('create_wallet', { filename: walletName, language: WALLET_LANGUAGE });
  return { created: true };
}

// Returns { address: null } (not an error) if no wallet has been created
// yet - the Wallet tab uses that to show a "Create Wallet" button instead of
// an error message.
async function getAddress() {
  try {
    await ensureWalletOpen();
  } catch (err) {
    if (err.statusCode === 404) return { address: null };
    throw err;
  }
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

// Restores a wallet from a 25-word mnemonic seed phrase, for the Wallet
// tab's "Recover Wallet" button (e.g. after losing the app-state/monero
// volume, or moving to a fresh install). monero-wallet-rpc's
// restore_deterministic_wallet refuses to write over a filename that
// already has a wallet on disk, so this always restores into a NEW,
// uniquely-named wallet file rather than the current active one - then
// switches the active wallet name to it, so every later call (balance,
// send, address) transparently talks to the recovered wallet instead.
// The old wallet's files are left on disk untouched (never deleted), so
// restoring never destroys funds even if the recovery itself was a mistake.
async function restoreFromSeed(seedWords, restoreHeight) {
  const seed = (Array.isArray(seedWords) ? seedWords.join(' ') : String(seedWords)).trim();
  if (!seed || seed.split(/\s+/).length < 12) {
    const err = new Error('Seed phrase looks incomplete - Monero seed phrases are normally 25 words.');
    err.statusCode = 400;
    throw err;
  }
  const height = Number.isInteger(restoreHeight) && restoreHeight >= 0 ? restoreHeight : 0;
  const newWalletName = `recovered-${Date.now()}`;

  // Best-effort - if nothing is open yet this just fails harmlessly, and we
  // don't want a stuck-open old wallet to block restoring into the new one.
  try {
    await jsonRpc('close_wallet');
  } catch {
    // ignore
  }

  await jsonRpc('restore_deterministic_wallet', {
    filename: newWalletName,
    seed,
    restore_height: height,
    language: WALLET_LANGUAGE,
  });

  moneroWalletState.setActiveWalletName(newWalletName);
  const result = await jsonRpc('get_address', { account_index: 0 });
  return { address: result.address };
}

module.exports = {
  ensureWalletOpen,
  createWallet,
  getAddress,
  getSeedWords,
  getBalance,
  transfer,
  restoreFromSeed,
};
