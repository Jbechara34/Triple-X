'use strict';

// Talks to minotari_node's gRPC interface (base_node.grpc_address in
// docker-compose.yml) to get real sync progress for the sidebar Minotari
// Node bar. EXPERIMENTAL - not yet verified against a live node.
//
// Only the one RPC this dashboard needs (GetSyncProgress) is vendored into
// proto/base_node_sync.proto, with field numbers copied verbatim from
// tari-project/tari's own base_node.proto so it decodes correctly against
// the real server despite declaring none of the other RPCs/messages.

const path = require('path');
const grpc = require('@grpc/grpc-js');
const protoLoader = require('@grpc/proto-loader');

const GRPC_HOST = process.env.MINOTARI_NODE_HOST || 'minotari-node';
const GRPC_PORT = process.env.MINOTARI_NODE_GRPC_PORT || '18142';
const TIMEOUT_MS = 4000;

const packageDef = protoLoader.loadSync(path.join(__dirname, '..', 'proto', 'base_node_sync.proto'), {
  keepCase: true,
  longs: Number,
  enums: String,
  defaults: true,
});
const BaseNode = grpc.loadPackageDefinition(packageDef).tari.rpc.BaseNode;

let client = null;
function getClient() {
  if (!client) {
    client = new BaseNode(`${GRPC_HOST}:${GRPC_PORT}`, grpc.credentials.createInsecure());
  }
  return client;
}

// { tipHeight, localHeight, state, synced } or throws.
function getSyncProgress() {
  return new Promise((resolve, reject) => {
    const deadline = new Date(Date.now() + TIMEOUT_MS);
    getClient().GetSyncProgress({}, { deadline }, (err, res) => {
      if (err) {
        reject(err);
        return;
      }
      resolve({
        tipHeight: Number(res.tip_height) || 0,
        localHeight: Number(res.local_height) || 0,
        state: res.state,
        synced: res.state === 'DONE',
      });
    });
  });
}

module.exports = {
  getSyncProgress,
};
