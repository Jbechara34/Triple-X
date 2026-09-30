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

// p2pool writes each connected stratum client as a single comma-joined
// string (not a nested JSON object) - confirmed directly against p2pool's
// own source (src/stratum_server.cpp, StratumServer::api_update_local_stats):
//   "<ip-address>,<seconds-connected>,<current-difficulty>,<hashrate-h/s>,<custom-user-or-"not logged in">"
// custom-user is the exact string the miner logged in with (e.g.
// "<address>.<worker-name>"), unquoted commas inside it would break this
// split, but p2pool itself rejects commas in stratum usernames so this is
// safe in practice. This is real-time (reflects who's connected to THIS
// node's stratum port right now, updated every ~20s by p2pool itself) -
// unlike lib/blocks.js's worker list, which is reconstructed from "SHARE
// FOUND" log lines and so only learns about/updates a worker when it
// submits a share (which can take a very long time on low-hashrate/low-
// vardiff setups, and never notices a disconnect).
function parseWorkerEntry(entry) {
  if (typeof entry !== 'string') return null;
  const parts = entry.split(',');
  if (parts.length < 5) return null;
  const [address, connectedSecondsStr, diffStr, hashrateStr, ...userParts] = parts;
  // The custom-user field is the only one that can itself have contained the
  // delimiter in theory - rejoin anything after the 4 fixed fields.
  const customUser = userParts.join(',');
  return {
    address: address || null,
    connectedSeconds: num(Number(connectedSecondsStr)),
    difficulty: num(Number(diffStr)),
    hashrate: num(Number(hashrateStr)),
    loggedIn: customUser !== 'not logged in',
    name: customUser !== 'not logged in' ? customUser : null,
  };
}

async function getLocalStratum() {
  const raw = await readJsonFile('local/stratum');
  if (!raw) return { raw: null, connected: false, workers: [] };
  const workers = Array.isArray(raw.workers)
    ? raw.workers.map(parseWorkerEntry).filter(Boolean)
    : [];
  return {
    raw,
    connected: true,
    hashrate15m: num(raw.hashrate_15m),
    hashrate1h: num(raw.hashrate_1h),
    hashrate24h: num(raw.hashrate_24h),
    totalHashes: num(raw.total_hashes),
    sharesFound: num(raw.shares_found),
    sharesFailed: num(raw.shares_failed),
    // Unix seconds (p2pool's own time_t) when THIS node last saw a valid
    // share - straight from p2pool itself, real-time and independent of our
    // own log parsing. 0 before this node's very first share ever.
    lastShareFoundTime: raw.last_share_found_time ? num(raw.last_share_found_time) * 1000 : null,
    averageEffort: num(raw.average_effort),
    currentEffort: num(raw.current_effort),
    connections: num(raw.connections),
    incomingConnections: num(raw.incoming_connections),
    // Real-time connected stratum clients - see parseWorkerEntry above.
    workers,
  };
}

// local/p2p carries this node's OWN sidechain p2p connection state - not to
// be confused with local/stratum's connections (miners connecting to this
// node's stratum port). Field names confirmed directly against p2pool's own
// source (src/p2p_server.cpp, api_update_local_stats()).
async function getLocalP2p() {
  const raw = await readJsonFile('local/p2p');
  if (!raw) return { raw: null, connected: false };
  return {
    raw,
    connected: true,
    connections: num(raw.connections),
    incomingConnections: num(raw.incoming_connections),
    peerListSize: num(raw.peer_list_size),
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
    // Every sidechain height increment is one share found by some miner on
    // this P2Pool mode, ever - the PPLNS-relevant "shares found" counter,
    // distinct from totalBlocksFound (actual Monero blocks, which is rare).
    // See p2pool's own p2pool.cpp api_update_pool_stats() for the source.
    sidechainSharesFound: num(stats.sidechainHeight),
    pplnsWindowSize: num(stats.pplnsWindowSize),
    // The PPLNS sidechain's own difficulty - NOT the Monero mainchain
    // difficulty (that's network/stats' difficulty, above). This is what a
    // share-time ETA needs to divide by, and it differs by pool mode
    // (standard/mini/nano each retarget independently to hit their own
    // target share time - see docker/p2pool/entrypoint.sh's --mini/--nano).
    // Confirmed directly against p2pool's own source (src/p2pool.cpp,
    // api_update_pool_stats(): the JSON field is literally "sidechainDifficulty").
    sidechainDifficulty: num(stats.sidechainDifficulty),
    poolList: raw.pool_list || null,
  };
}

async function getAll() {
  const [stratum, network, pool, p2p] = await Promise.all([
    getLocalStratum(),
    getNetworkStats(),
    getPoolStats(),
    getLocalP2p(),
  ]);
  return { stratum, network, pool, p2p, dataApiDir: DATA_API_DIR };
}

module.exports = {
  DATA_API_DIR,
  getLocalStratum,
  getNetworkStats,
  getPoolStats,
  getLocalP2p,
  getAll,
};
