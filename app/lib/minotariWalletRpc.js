'use strict';

// Talks to minotari_console_wallet's gRPC interface (see docker-compose.yml
// minotari-wallet service) for the Wallet tab. Also reads balance and sends
// funds (Transfer RPC) - unlike the read-only design this module started
// with. EXPERIMENTAL, not yet verified against a live wallet. Note: unlike
// minotari-node's grpc_server_allow_methods, minotari_console_wallet's gRPC
// has no per-method allow-list as of writing (tari-project/tari#8016) - one
// set of credentials/network access gates all wallet RPCs, not just the ones
// this dashboard calls. That's an upstream limitation, not something fixable
// here; the wallet's gRPC port is only reachable from other containers on
// this stack's internal Docker network, never published to the host.

const path = require('path');
const grpc = require('@grpc/grpc-js');
const protoLoader = require('@grpc/proto-loader');

const GRPC_HOST = process.env.MINOTARI_WALLET_HOST || 'minotari-wallet';
const GRPC_PORT = process.env.MINOTARI_WALLET_GRPC_PORT || '18143';
const TIMEOUT_MS = 4000;

const packageDef = protoLoader.loadSync(path.join(__dirname, '..', 'proto', 'wallet_address.proto'), {
  keepCase: true,
  longs: Number,
  enums: String,
  defaults: true,
});
const Wallet = grpc.loadPackageDefinition(packageDef).tari.rpc.Wallet;

let client = null;
function getClient() {
  if (!client) {
    client = new Wallet(`${GRPC_HOST}:${GRPC_PORT}`, grpc.credentials.createInsecure());
  }
  return client;
}

// { address } (base58, interactive form - the same style as a normal Tari
// payout address) or throws.
function getAddress() {
  return new Promise((resolve, reject) => {
    const deadline = new Date(Date.now() + TIMEOUT_MS);
    getClient().GetCompleteAddress({}, { deadline }, (err, res) => {
      if (err) {
        reject(err);
        return;
      }
      resolve({ address: res.interactive_address_base58 || null });
    });
  });
}

// 1 XTM = 1,000,000 microMinotari (µT) - Tari's smallest unit, confirmed
// against tari-project's own integration guide.
const MICROTARI_DECIMALS = 6;

function microTariToXtm(microTari) {
  const base = 10n ** BigInt(MICROTARI_DECIMALS);
  const value = BigInt(microTari);
  const whole = value / base;
  const frac = (value % base).toString().padStart(MICROTARI_DECIMALS, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : `${whole}`;
}

// XTM decimal string -> BigInt microTari. BigInt (not Number) for the same
// reason as moneroWalletRpc.js's xmrToAtomicUnits - this is real money and a
// float can't represent it exactly.
function xtmToMicroTari(amountStr) {
  const trimmed = String(amountStr).trim();
  if (!/^\d+(\.\d{1,6})?$/.test(trimmed)) {
    const err = new Error('Amount must be a positive decimal number with up to 6 decimal places.');
    err.statusCode = 400;
    throw err;
  }
  const [whole, frac = ''] = trimmed.split('.');
  const fracPadded = (frac + '0'.repeat(MICROTARI_DECIMALS)).slice(0, MICROTARI_DECIMALS);
  const microTari = BigInt(whole) * (10n ** BigInt(MICROTARI_DECIMALS)) + BigInt(fracPadded);
  if (microTari <= 0n) {
    const err = new Error('Amount must be greater than zero.');
    err.statusCode = 400;
    throw err;
  }
  return microTari;
}

function getBalance() {
  return new Promise((resolve, reject) => {
    const deadline = new Date(Date.now() + TIMEOUT_MS);
    getClient().GetBalance({}, { deadline }, (err, res) => {
      if (err) {
        reject(err);
        return;
      }
      resolve({
        availableBalance: microTariToXtm(res.available_balance || 0),
        pendingIncoming: microTariToXtm(res.pending_incoming_balance || 0),
        pendingOutgoing: microTariToXtm(res.pending_outgoing_balance || 0),
      });
    });
  });
}

// Current network fee rate (µT per gram of transaction weight), averaged
// over the last few blocks. Transfer's fee_per_gram is a required field with
// no server-side default (confirmed against tari-project/tari's gRPC wallet
// server), so this has to be queried before every send rather than
// hardcoded - a stale hardcoded value could either overpay or get the
// transaction stuck.
function getFeePerGramEstimate() {
  return new Promise((resolve, reject) => {
    const deadline = new Date(Date.now() + TIMEOUT_MS);
    getClient().GetFeePerGramStats({ block_count: 10 }, { deadline }, (err, res) => {
      if (err) {
        reject(err);
        return;
      }
      const stats = res.fee_per_gram_stats || [];
      // Most recent block's average, or a conservative fallback if the
      // chain has no recent fee data yet (e.g. right after this node synced).
      const feePerGram = stats.length > 0 ? Number(stats[0].average_fee_per_gram) : 5;
      resolve(feePerGram > 0 ? feePerGram : 5);
    });
  });
}

// Sends XTM one-sided-to-stealth-address (the standard payment type for
// sending to someone else's address - see PaymentRecipient.PaymentType in
// wallet_address.proto). Returns the transaction id and the actual amount
// sent; Tari's Transfer RPC doesn't return the fee paid directly, so the fee
// estimate shown to the user before confirming is what they're told to
// expect, not re-derived here.
async function transfer(address, amountStr) {
  const microTariAmount = xtmToMicroTari(amountStr);
  if (microTariAmount > BigInt(Number.MAX_SAFE_INTEGER)) {
    const err = new Error('Amount is too large to send in a single transfer through this dashboard.');
    err.statusCode = 400;
    throw err;
  }
  const feePerGram = await getFeePerGramEstimate();
  return new Promise((resolve, reject) => {
    const deadline = new Date(Date.now() + TIMEOUT_MS);
    getClient().Transfer({
      recipients: [{
        address,
        amount: Number(microTariAmount),
        fee_per_gram: feePerGram,
        payment_type: 'ONE_SIDED_TO_STEALTH_ADDRESS',
      }],
      single_tx: true,
    }, { deadline }, (err, res) => {
      if (err) {
        reject(err);
        return;
      }
      const result = (res.results || [])[0];
      if (!result || !result.is_success) {
        reject(new Error((result && result.failure_message) || 'Transfer failed for an unknown reason.'));
        return;
      }
      resolve({
        transactionId: String(result.transaction_id),
        amountXtm: microTariToXtm(microTariAmount),
        feePerGram,
      });
    });
  });
}

module.exports = {
  getAddress,
  getBalance,
  transfer,
};
