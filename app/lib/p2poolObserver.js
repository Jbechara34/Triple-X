'use strict';

// Optional integration with the public P2Pool Observer service
// (https://git.gammaspectra.live/P2Pool/observer, hosted at p2pool.observer)
// - a community-run indexer that tracks the full share chain across all
// miners, not just what our own local p2pool node has cached. Off by
// default (see lib/config.js observerEnabled) because using it means
// sending your payout address to a third party over clearnet.
//
// Endpoints used (verified against the live service, no auth required):
//   GET https://<subdomain>/api/pool_info                - network-wide stats
//   GET https://<subdomain>/api/miner_info/<address>      - one miner's lifetime shares

const TIMEOUT_MS = 6000;
const CACHE_MS = 60000; // be polite to a free, donation-funded public service

const SUBDOMAIN_BY_MODE = {
  standard: 'p2pool.observer',
  mini: 'mini.p2pool.observer',
  nano: 'nano.p2pool.observer',
};

const cache = new Map(); // key -> { at, value }

async function fetchJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`p2pool.observer HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function cached(key, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  const value = await fn();
  cache.set(key, { at: Date.now(), value });
  return value;
}

function hostFor(mode) {
  return SUBDOMAIN_BY_MODE[mode] || SUBDOMAIN_BY_MODE.standard;
}

// Network-wide sidechain stats - miner count, height, difficulty, p2pool /
// monerod recommended versions.
async function getPoolInfo(mode) {
  const host = hostFor(mode);
  return cached(`pool_info:${host}`, () => fetchJson(`https://${host}/api/pool_info`));
}

// One address's lifetime share history on this sidechain, independent of
// whether our own local p2pool node has been restarted/lost its ephemeral
// local API state.
async function getMinerInfo(mode, address) {
  const host = hostFor(mode);
  return cached(`miner_info:${host}:${address}`, () =>
    fetchJson(`https://${host}/api/miner_info/${encodeURIComponent(address)}`)
  );
}

function explorerUrlFor(mode, address) {
  const host = hostFor(mode);
  return address ? `https://${host}/miner/${encodeURIComponent(address)}` : `https://${host}/`;
}

module.exports = {
  getPoolInfo,
  getMinerInfo,
  explorerUrlFor,
};
