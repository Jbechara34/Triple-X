'use strict';

// Settings tab's (hidden, opt-in) "Import Blockchain" feature - pulls a
// pre-synced monerod data directory from another machine over SSH/rsync,
// so a new install doesn't have to sync from the network. Stops monerod
// first (writing into a live LMDB environment risks corrupting it), copies,
// fixes ownership, then restarts it - see dockerControl.js for the
// stop/start half of this.
//
// Credential handling: a password is passed to sshpass via the SSHPASS
// environment variable (not a command-line flag, which would be visible to
// anyone who can run `ps` on the host) and is never written to disk, logged,
// or included in any state/error the frontend can read. A private key is
// written to a temp file with mode 0600 (readable only by the process that
// created it) and deleted immediately after the transfer, success or not.

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const dockerControl = require('./dockerControl');

const IMPORT_TARGET_DIR = process.env.MONEROD_IMPORT_TARGET_DIR || '/data/monerod-import-target';
const KNOWN_HOSTS_FILE = process.env.SSH_KNOWN_HOSTS_FILE || '/data/state/ssh-known-hosts';
// UID/GID the monerod container's own user runs as - see
// docker/monerod/Dockerfile ("useradd -r -u 1000 ... monero").
const MONERO_UID_GID = '1000:1000';

let state = {
  status: 'idle', // idle | stopping | copying | fixing-permissions | starting | done | error
  message: '',
  percent: null,
  startedAt: null,
  finishedAt: null,
  // Last few lines of rsync's own output, for troubleshooting - never
  // contains credentials, since those are passed via env var / a deleted
  // temp file and rsync itself never echoes them back.
  outputTail: [],
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

function appendOutputLine(line) {
  const trimmed = line.trim();
  if (!trimmed) return;
  state.outputTail.push(trimmed);
  if (state.outputTail.length > 20) state.outputTail.shift();
  // rsync --info=progress2 prints lines containing e.g. "45%"
  const match = trimmed.match(/(\d{1,3})%/);
  if (match) state.percent = Math.min(100, Number(match[1]));
}

function runRsync({ host, port, username, authMethod, password, privateKey, remotePath }) {
  return new Promise((resolve, reject) => {
    let keyFile = null;
    const cleanupKeyFile = () => {
      if (keyFile) fs.unlink(keyFile, () => {});
    };

    try {
      fs.mkdirSync(path.dirname(KNOWN_HOSTS_FILE), { recursive: true });
    } catch {
      // non-fatal - ssh will just fail to write it and we'll surface that below
    }

    const sshBaseArgs = [
      '-p', String(port),
      '-o', 'StrictHostKeyChecking=accept-new',
      '-o', `UserKnownHostsFile=${KNOWN_HOSTS_FILE}`,
      '-o', 'BatchMode=yes',
      '-o', 'ConnectTimeout=15',
    ];

    const env = { ...process.env };
    let sshCommand;
    if (authMethod === 'key') {
      keyFile = path.join(os.tmpdir(), `import-key-${Date.now()}-${Math.random().toString(36).slice(2)}`);
      fs.writeFileSync(keyFile, privateKey.endsWith('\n') ? privateKey : `${privateKey}\n`, { mode: 0o600 });
      sshCommand = ['ssh', ...sshBaseArgs, '-i', keyFile].join(' ');
    } else {
      env.SSHPASS = password;
      sshCommand = ['sshpass', '-e', 'ssh', ...sshBaseArgs].join(' ');
    }

    const remoteSpec = `${username}@${host}:${remotePath.replace(/\/+$/, '')}/`;
    const rsyncArgs = ['-a', '--info=progress2', '-e', sshCommand, remoteSpec, `${IMPORT_TARGET_DIR}/`];

    const child = spawn('rsync', rsyncArgs, { env });

    let stderrTail = '';
    child.stdout.on('data', (chunk) => {
      chunk.toString('utf8').split(/\r|\n/).forEach(appendOutputLine);
    });
    child.stderr.on('data', (chunk) => {
      const text = chunk.toString('utf8');
      stderrTail = (stderrTail + text).slice(-2000);
      text.split(/\r|\n/).forEach(appendOutputLine);
    });

    child.on('error', (err) => {
      cleanupKeyFile();
      reject(err);
    });

    child.on('close', (code) => {
      cleanupKeyFile();
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`rsync exited with code ${code}${stderrTail ? ` - ${stderrTail.trim().slice(-300)}` : ''}`));
      }
    });
  });
}

function fixOwnership() {
  return new Promise((resolve, reject) => {
    const child = spawn('chown', ['-R', MONERO_UID_GID, IMPORT_TARGET_DIR]);
    let stderrTail = '';
    child.stderr.on('data', (chunk) => { stderrTail += chunk.toString('utf8'); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`chown exited with code ${code}${stderrTail ? `: ${stderrTail.trim()}` : ''}`));
    });
  });
}

// Kicks off the import in the background - the caller (the API route) gets
// an immediate response, and the frontend polls getState() for progress.
// Whatever happens, monerod always ends up restarted (the finally block) so
// a failed import never leaves the node stopped.
async function startImport(params) {
  if (isBusy()) {
    throw new Error('An import is already in progress.');
  }
  setState({
    status: 'stopping',
    message: 'Stopping monerod...',
    percent: null,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    outputTail: [],
  });

  (async () => {
    try {
      await dockerControl.stopMonerod();

      setState({ status: 'copying', message: 'Copying blockchain data...' });
      await runRsync(params);

      setState({ status: 'fixing-permissions', message: 'Fixing file ownership...', percent: 100 });
      await fixOwnership();

      setState({ status: 'starting', message: 'Starting monerod...' });
      await dockerControl.startMonerod();

      setState({ status: 'done', message: 'Import complete. monerod is starting back up.', finishedAt: new Date().toISOString() });
    } catch (err) {
      setState({ status: 'error', message: err.message, finishedAt: new Date().toISOString() });
      try {
        await dockerControl.startMonerod();
      } catch {
        // If this also fails, the state's error message is already visible
        // to the user - they'll need to start monerod manually.
      }
    }
  })();
}

function reset() {
  if (isBusy()) {
    throw new Error('Cannot reset while an import is in progress.');
  }
  state = { status: 'idle', message: '', percent: null, startedAt: null, finishedAt: null, outputTail: [] };
}

module.exports = {
  getState,
  isBusy,
  startImport,
  reset,
};
