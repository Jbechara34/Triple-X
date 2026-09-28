'use strict';

// Wallet tab's "Recover Wallet" button for the Tari wallet - restarts the
// minotari-wallet container with recovery seed words instead of letting it
// come back up as whatever wallet is already on disk. Requires the same
// Docker socket mount as the Settings tab's Import Blockchain feature (see
// dockerControl.js), since minotari_console_wallet only picks up seed words
// at process startup - there's no live "restore" RPC call on its running
// gRPC interface the way monero-wallet-rpc has one (see moneroWalletRpc.js's
// restoreFromSeed for that simpler case, which never has to touch Docker).
//
// Unlike Monero's restore (which always keeps the old wallet file on disk
// and just points the app at a new one), Tari's console wallet keeps a
// single wallet database per data directory, so recovering necessarily
// wipes the old one - see wipeWalletData. Either way, no on-chain funds are
// ever at risk; only the local wallet database file is touched.

const fs = require('fs');
const path = require('path');
const dockerControl = require('./dockerControl');
const minotariWalletRpc = require('./minotariWalletRpc');

const WALLET_DATA_DIR = process.env.MINOTARI_WALLET_DATA_DIR || '/data/minotari-wallet';
const RECOVERY_FILE = path.join(WALLET_DATA_DIR, 'recover-seed-words.txt');
const SERVICE_NAME = 'minotari-wallet';
// Preserved across a wipe so the wallet keeps starting unattended
// (--non-interactive) with the same local encryption password - see
// docker/minotari-wallet/entrypoint.sh.
const KEEP_FILENAMES = new Set(['.wallet-password']);
const WALLET_READY_TIMEOUT_MS = 120000;

let state = {
  status: 'idle', // idle | stopping | wiping | starting | waiting-for-wallet | done | error
  message: '',
  startedAt: null,
  finishedAt: null,
};

function getState() {
  return { ...state };
}

function isBusy() {
  return !['idle', 'done', 'error'].includes(state.status);
}

function setState(patch) {
  state = { ...state, ...patch };
}

function wipeWalletData() {
  let entries;
  try {
    entries = fs.readdirSync(WALLET_DATA_DIR);
  } catch {
    return; // nothing on disk yet - fine
  }
  for (const name of entries) {
    if (KEEP_FILENAMES.has(name)) continue;
    fs.rmSync(path.join(WALLET_DATA_DIR, name), { recursive: true, force: true });
  }
}

// Polls the wallet's gRPC interface until it answers - confirms the
// container came back up and finished loading, not that the full blockchain
// rescan for past transactions has completed (that can take a while longer
// and keeps running in the background regardless).
function waitForWalletReady(timeoutMs) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = async () => {
      try {
        await minotariWalletRpc.getAddress();
        resolve();
        return;
      } catch {
        // still starting/recovering
      }
      if (Date.now() - start > timeoutMs) {
        reject(new Error('Wallet did not come back up within the expected time. It may still be recovering in the background - check its logs.'));
        return;
      }
      setTimeout(tick, 3000);
    };
    tick();
  });
}

// Kicks off recovery in the background - the caller (the API route) gets an
// immediate response, and the frontend polls getState() for progress.
async function startRecovery(seedWords) {
  if (isBusy()) {
    throw new Error('A wallet recovery is already in progress.');
  }
  const seed = (Array.isArray(seedWords) ? seedWords.join(' ') : String(seedWords)).trim();
  if (!seed || seed.split(/\s+/).length < 12) {
    const err = new Error('Seed phrase looks incomplete.');
    err.statusCode = 400;
    throw err;
  }

  const dockerReady = await dockerControl.isDockerAvailable();
  if (!dockerReady) {
    const err = new Error("Wallet recovery requires Docker socket access, which isn't currently enabled. See the Settings tab's Import Blockchain instructions for how to add it.");
    err.statusCode = 403;
    throw err;
  }

  setState({
    status: 'stopping',
    message: 'Stopping Tari wallet...',
    startedAt: new Date().toISOString(),
    finishedAt: null,
  });

  (async () => {
    try {
      await dockerControl.stopService(SERVICE_NAME);

      setState({ status: 'wiping', message: 'Clearing old wallet data...' });
      wipeWalletData();
      fs.mkdirSync(WALLET_DATA_DIR, { recursive: true });
      fs.writeFileSync(RECOVERY_FILE, `${seed}\n`, { mode: 0o600 });

      setState({ status: 'starting', message: 'Starting Tari wallet in recovery mode...' });
      await dockerControl.startService(SERVICE_NAME);

      setState({ status: 'waiting-for-wallet', message: 'Waiting for the wallet to come back up...' });
      await waitForWalletReady(WALLET_READY_TIMEOUT_MS);

      setState({
        status: 'done',
        message: 'Wallet recovered. It will keep scanning the blockchain for existing funds in the background.',
        finishedAt: new Date().toISOString(),
      });
    } catch (err) {
      setState({ status: 'error', message: err.message, finishedAt: new Date().toISOString() });
      // Best-effort - if the wallet never came back up on its own, at least
      // try once more rather than leaving it stopped.
      try {
        await dockerControl.startService(SERVICE_NAME);
      } catch {
        // already surfaced via state.message
      }
    } finally {
      try {
        fs.unlinkSync(RECOVERY_FILE);
      } catch {
        // already removed by the entrypoint - fine
      }
    }
  })();
}

function reset() {
  if (isBusy()) {
    throw new Error('Cannot reset while a recovery is in progress.');
  }
  state = { status: 'idle', message: '', startedAt: null, finishedAt: null };
}

module.exports = {
  getState,
  isBusy,
  startRecovery,
  reset,
};
