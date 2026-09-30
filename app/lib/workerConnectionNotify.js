'use strict';

/**
 * Discord alert when a miner (worker) connects to or disconnects from this
 * node's stratum port - see the Pool tab's live worker list (lib/p2poolApi.js
 * getLocalStratum().workers, sourced straight from p2pool's own local/stratum
 * API) for where the connected-worker set comes from. This module just polls
 * that same set on its own schedule and diffs it against the previous poll,
 * independent of whether anyone has the dashboard open.
 */

const config = require('./config');
const discordNotify = require('./discordNotify');
const p2poolApi = require('./p2poolApi');

const POLL_INTERVAL_MS = 15000;

// Keyed by worker name (falls back to IP address for a not-logged-in
// client, same as the Pool tab's worker list) - just tracks "currently
// connected" across polls so we only alert on the transition, not every tick.
let previouslyConnected = new Set();
let started = false;
let initialized = false;

async function pollOnce() {
  let workers;
  try {
    const stratum = await p2poolApi.getLocalStratum();
    workers = stratum.workers || [];
  } catch {
    return; // p2pool's API files not readable this tick - try again next poll
  }

  const currentlyConnected = new Set(workers.map((w) => w.name || w.address));

  // First poll after startup just establishes the baseline - without this,
  // every worker already connected when the container starts would fire a
  // false "connected" alert.
  if (!initialized) {
    initialized = true;
    previouslyConnected = currentlyConnected;
    return;
  }

  if (!config.readSettings().discordNotifyWorkerConnections) {
    previouslyConnected = currentlyConnected;
    return;
  }

  for (const name of currentlyConnected) {
    if (!previouslyConnected.has(name)) {
      discordNotify.send(`🟢 **Worker connected:** \`${name}\``);
    }
  }
  for (const name of previouslyConnected) {
    if (!currentlyConnected.has(name)) {
      discordNotify.send(`🔴 **Worker disconnected:** \`${name}\``);
    }
  }

  previouslyConnected = currentlyConnected;
}

function start() {
  if (started) return;
  started = true;
  pollOnce();
  setInterval(pollOnce, POLL_INTERVAL_MS);
}

module.exports = { start };
