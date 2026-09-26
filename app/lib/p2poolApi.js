'use strict';

/**
 * P2Pool doesn't run its own HTTP server for stats - when started with
 * `--data-api <dir> --local-api --stratum-api`, it writes/updates plain JSON
 * files inside <dir>. We mount that directory (see docker-compose.yml,
 * volume `p2pool-api`) read-only into this container and just read the
 * files off disk. Paths, per p2pool's source (src/p2pool_api.cpp):
 *
 *   <dir>/local/stratum   - this node's stratum server + miner-facing stats
 *   <dir>/network/stats   - current Monero network height/difficulty/reward
 *   <dir>/pool/stats      - p2pool sidechain-wide stats (hashrate, miners, blocks found)
 *
 * Field names below are best-effort based on the public p2pool/XMRig-adjacent
 * tooling ecosystem (Gupax, p2pool.observer, node-cryptonote-pool-style
 * pool/stats). P2Pool versions have changed this format before, so every
 * accessor here is defensive: unknown/missing fields degrade to `null`
 * instead of throwing, and the raw JSON is always returned alongside the
 * parsed view so the UI (or you, while developing) can inspect it directly.
 * If your installed p2pool version uses different keys, adjust the getters
 * below - the file paths themselves are stable.
 */

const fs = require('fs/promises');
const path = require('path');

const DATA_API_DIR = process.env.P2POOL_DATA_API_DIR || '/data/p2pool-api';

async function readJsonFile(relPath) {
  const full = path.join(DATA_API_DIR, relPath);
  try {
    const raw = await fs.readFile(full, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    console.error(`[p2poolApi] failed to read/parse ${full}:`, err.message);
    return null;
  }
}

function num(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

async function getLocalStratum() {
  const raw = await readJsonFile('local/stratum');
  if (!raw) return { raw: null, connected: false };
  return {
    raw,
    connected: true,
    hashrate15m: num(raw.hashrate_15m),
    hashrate1h: num(raw.hashrate_1h),
    hashrate24h: num(raw.hashrate_24h),
    totalHashes: num(raw.total_hashes),
    sharesFound: num(raw.shares_found),
    sharesFailed: num(raw.shares_failed),
    averageEffort: num(raw.average_effort),
    currentEffort: num(raw.current_effort),
    connections: num(raw.connections),
    incomingConnections: num(raw.incoming_connections),
  };
}

async function getNetworkStats() {
  const raw = await readJsonFile('network/stats');
  if (!raw) return { raw: null, connected: false };
  return {
    raw,
    connected: true,
    difficulty: num(raw.difficulty),
    height: num(raw.height),
    hash: raw.hash || null,
    reward: num(raw.reward),
    timestamp: num(raw.timestamp),
  };
}

async function getPoolStats() {
  const raw = await readJsonFile('pool/stats');
  if (!raw) return { raw: null, connected: false };
  const stats = raw.pool_statistics || raw;
  return {
    raw,
    connected: true,
    hashRate: num(stats.hashRate),
    miners: num(stats.miners),
    totalHashes: num(stats.totalHashes),
    lastBlockFound: stats.lastBlockFound ?? null,
    totalBlocksFound: num(stats.totalBlocksFound),
    poolList: raw.pool_list || null,
  };
}

async function getAll() {
  const [stratum, network, pool] = await Promise.all([
    getLocalStratum(),
    getNetworkStats(),
    getPoolStats(),
  ]);
  return { stratum, network, pool, dataApiDir: DATA_API_DIR };
}

module.exports = {
  DATA_API_DIR,
  getLocalStratum,
  getNetworkStats,
  getPoolStats,
  getAll,
};
