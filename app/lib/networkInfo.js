'use strict';

/**
 * LAN + WAN IPv4 address for the Miner Configuration card (Pool tab) - so a
 * miner on the same network can use the LAN address/port directly, and
 * someone forwarding the stratum port for a remote rig knows the WAN address
 * to give it. Neither is knowable from inside the container by just reading
 * local state: the LAN IP needs the host's own network interfaces, and the
 * WAN IP isn't visible to the container at all (it's whatever address the
 * router/ISP shows the internet), so that one has to ask an external "what's
 * my IP" service.
 */

const os = require('os');
const https = require('https');

function getLanIp() {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name] || []) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return null;
}

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

module.exports = { getLanIp, getWanIp };
