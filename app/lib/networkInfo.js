'use strict';

/**
 * WAN IPv4 address for the Miner Configuration card (Pool tab), for someone
 * forwarding the stratum port for a remote rig. Not knowable from inside the
 * container by reading local state (it's whatever address the router/ISP
 * shows the internet), so this asks an external "what's my IP" service.
 * (The LAN address doesn't need this module at all - server.js just uses the
 * incoming request's own Host header, since the browser loading the page is
 * necessarily already on the LAN. An earlier version tried reading the
 * container's own network interfaces for this, which returned the Docker
 * bridge network's internal IP - e.g. 172.18.0.5 - instead of the host
 * machine's real LAN address, since this container isn't on
 * network_mode: host.)
 */

const https = require('https');

// Cached - this changes rarely (only when your ISP re-assigns your WAN
// address) and querying it on every poll would be a needless external call
// on every dashboard refresh.
const WAN_CACHE_MS = 10 * 60 * 1000;
let wanCache = { ip: null, fetchedAt: 0 };
let wanInFlight = null;

function fetchWanIp() {
  return new Promise((resolve) => {
    const req = https.get('https://api.ipify.org?format=json', { timeout: 5000 }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        try {
          resolve(JSON.parse(body).ip || null);
        } catch {
          resolve(null);
        }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

async function getWanIp() {
  const now = Date.now();
  if (wanCache.ip && now - wanCache.fetchedAt < WAN_CACHE_MS) {
    return wanCache.ip;
  }
  if (!wanInFlight) {
    wanInFlight = fetchWanIp().then((ip) => {
      wanInFlight = null;
      if (ip) wanCache = { ip, fetchedAt: Date.now() };
      return ip;
    });
  }
  return wanInFlight;
}

module.exports = { getWanIp };
