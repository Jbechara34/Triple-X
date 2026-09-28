'use strict';

// Talks to the host's Docker daemon via the socket mounted into this
// container (see docker-compose.yml - only present when the Settings tab's
// "Import Blockchain" feature is in use, since this is real control over
// the host). Started out scoped to just monerod (for the import flow, which
// needs to stop it safely around copying data into its volume) and was later
// generalized to any compose service by name, for the Wallet tab's "Recover
// Wallet" flow, which needs to restart minotari-wallet with recovery seed
// words. Nothing here touches a container outside this stack.

const Docker = require('dockerode');

const docker = new Docker({ socketPath: '/var/run/docker.sock' });

// Docker Compose labels every container it creates with
// com.docker.compose.service=<service name> regardless of how the platform
// names/prefixes the container itself - this finds a service's container the
// same way whether it's named "triple-x_<service>" (plain docker-compose.yml)
// or "<app-id>_<service>_1" (Umbrel/5tratumOS), with no extra labels needed.
async function findServiceContainer(serviceName) {
  const containers = await docker.listContainers({
    all: true,
    filters: JSON.stringify({ label: [`com.docker.compose.service=${serviceName}`] }),
  });
  if (containers.length === 0) {
    throw new Error(`${serviceName} container not found - is the stack running?`);
  }
  return docker.getContainer(containers[0].Id);
}

async function isServiceRunning(serviceName) {
  try {
    const container = await findServiceContainer(serviceName);
    const info = await container.inspect();
    return info.State.Running === true;
  } catch {
    return false;
  }
}

async function stopService(serviceName) {
  const container = await findServiceContainer(serviceName);
  const info = await container.inspect();
  if (!info.State.Running) return;
  await container.stop({ t: 30 }); // graceful SIGTERM, 30s before SIGKILL
}

async function startService(serviceName) {
  const container = await findServiceContainer(serviceName);
  const info = await container.inspect();
  if (info.State.Running) return;
  await container.start();
}

// Whether the Docker socket is actually mounted and reachable - both the
// import and wallet-recovery features need this, and it's off by default
// (the socket mount is opt-in, added manually per the Settings instructions),
// so callers use this to give a clear "not enabled" message instead of a raw
// connection error.
async function isDockerAvailable() {
  try {
    await docker.ping();
    return true;
  } catch {
    return false;
  }
}

async function isMonerodRunning() {
  return isServiceRunning('monerod');
}

async function stopMonerod() {
  return stopService('monerod');
}

async function startMonerod() {
  return startService('monerod');
}

module.exports = {
  isDockerAvailable,
  isServiceRunning,
  stopService,
  startService,
  isMonerodRunning,
  stopMonerod,
  startMonerod,
};
