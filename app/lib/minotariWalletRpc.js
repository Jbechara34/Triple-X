'use strict';

// Talks to minotari_console_wallet's gRPC interface (see docker-compose.yml
// minotari-wallet service) for the Wallet tab's "Create Tari Wallet" flow.
// Only ever reads the wallet's own receive address - never balance, never
// transactions, never anything that could move funds. EXPERIMENTAL, not yet
// verified against a live wallet.

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

module.exports = {
  getAddress,
};
