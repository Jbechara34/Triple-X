'use strict';

/**
 * Auto-stops minotari-node/minotari-wallet when Tari merge-mining isn't
 * configured, and starts them back up the moment it is - see the Settings
 * tab's "Automatically stop Minotari when unused" toggle
 * (autoManageMinotariEnabled, off by default, same Docker-socket
 * requirement/warning as the existing Import Blockchain feature).
 *
 * Why this matters: docker-compose.yml starts minotari-node
 * (restart: unless-stopped) unconditionally, and it always fully syncs and
 * stores the complete Tari chain - confirmed directly against Tari's own
 * config schema (common/config/tari.config.json in tari-project/tari) that
 * minotari_node has NO pruning/archival-vs-pruned option at all, unlike
 * monerod's --prune-blockchain. So for the (likely common, since merge-
 * mining is marked EXPERIMENTAL) case of someone never setting a Tari
 * address, that's a full, always-growing blockchain node syncing and
 * writing to disk for a feature that isn't even in use - real, avoidable
 * disk/CPU/host-I/O load.
 */

const config = require('./config');
const dockerControl = require('./dockerControl');

const POLL_INTERVAL_MS = 60000;
const MINOTARI_SERVICES = ['minotari-node', 'minotari-wallet'];

async function pollOnce() {
  const settings = config.readSettings();
  if (!settings.autoManageMinotariEnabled) return;

  if (!(await dockerControl.isDockerAvailable())) return; // socket not mounted/reachable - nothing to do

  const shouldRun = !!settings.tariAddress;

  for (const service of MINOTARI_SERVICES) {
    try {
      const running = await dockerControl.isServiceRunning(service);
      if (shouldRun && !running) {
        console.log(`[minotariLifecycle] Tari address configured - starting ${service}`);
        await dockerControl.startService(service);
      } else if (!shouldRun && running) {
        console.log(`[minotariLifecycle] no Tari address configured - stopping ${service} to save resources`);
        await dockerControl.stopService(service);
      }
    } catch (err) {
      console.error(`[minotariLifecycle] failed to reconcile ${service}:`, err.message);
    }
  }
}

let started = false;
function start() {
  if (started) return;
  started = true;
  pollOnce();
  setInterval(pollOnce, POLL_INTERVAL_MS);
}

module.exports = { start };
