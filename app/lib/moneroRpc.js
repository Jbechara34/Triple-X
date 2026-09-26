'use strict';

// Talks to monerod's RPC ports. Nothing here ever touches the wallet - monerod
// runs without a wallet RPC in this stack; payouts go directly to the address
// configured for p2pool (see docker/p2pool/entrypoint.sh).

const RPC_HOST = process.env.MONEROD_HOST || 'monerod';
const RPC_PORT = process.env.MONEROD_RPC_PORT || '18081';
const RPC_BASE = `http://${RPC_HOST}:${RPC_PORT}`;

const TIMEOUT_MS = 4000;

async function fetchWithTimeout(url, opts = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...opts, signal: controller.signal });
    return res;
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
    throw new Error(`monerod RPC HTTP ${res.status}`);
  }
  const body = await res.json();
  if (body.error) {
    throw new Error(`monerod RPC error: ${body.error.message || JSON.stringify(body.error)}`);
  }
  return body.result;
}

// GET /get_info is the plain REST endpoint (no json_rpc wrapper needed).
async function getInfo() {
  const res = await fetchWithTimeout(`${RPC_BASE}/get_info`);
  if (!res.ok) {
    throw new Error(`monerod /get_info HTTP ${res.status}`);
  }
  return res.json();
}

async function isReachable() {
  try {
    await getInfo();
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  RPC_BASE,
  jsonRpc,
  getInfo,
  isReachable,
};
