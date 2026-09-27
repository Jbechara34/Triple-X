'use strict';

// Talks to the host's Docker daemon via the socket mounted into this
// container (see docker-compose.yml - only present when the Settings tab's
// "Import Blockchain" feature is in use, since this is real control over
// the host). Scoped to exactly one thing: stop/start the monerod container,
// which the import flow needs to do safely around copying data into its
// volume. Nothing here touches any other container.

const Docker = require('dockerode');

const docker = new Docker({ socketPath: '/var/run/docker.sock' });

// Docker Compose labels every container it creates with
// com.docker.compose.service=<service name> regardless of how the platform
// names/prefixes the container itself - this finds monerod's container the
// same way whether it's named "triple-x_monerod" (plain docker-compose.yml)
// or "<app-id>_monerod_1" (Umbrel/5tratumOS), with no extra labels needed.
const MONEROD_LABEL = 'com.docker.compose.service=monerod';

async function findMonerodContainer() {
  const containers = await docker.listContainers({
    all: true,
    filters: JSON.stringify({ label: [MONEROD_LABEL] }),
  });
  if (containers.length === 0) {
    throw new Error('monerod container not found - is the stack running?');
  }
  return docker.getContainer(containers[0].Id);
}

async function isMonerodRunning() {
  try {
    const container = await findMonerodContainer();
    const info = await container.inspect();
    return info.State.Running === true;
  } catch {
    return false;
  }
}

async function stopMonerod() {
  const container = await findMonerodContainer();
  const info = await container.inspect();
  if (!info.State.Running) return;
  await container.stop({ t: 30 }); // graceful SIGTERM, 30s before SIGKILL
}

async function startMonerod() {
  const container = await findMonerodContainer();
  const info = await container.inspect();
  if (info.State.Running) return;
  await container.start();
}

module.exports = {
  isMonerodRunning,
  stopMonerod,
  startMonerod,
};
