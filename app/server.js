'use strict';

const path = require('path');
const express = require('express');

const config = require('./lib/config');
const moneroRpc = require('./lib/moneroRpc');
const p2poolApi = require('./lib/p2poolApi');
const blocks = require('./lib/blocks');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

// Clearnet block explorer used to let you independently verify a found block
// paid out to your address. Point this at an .onion explorer (reached via a
// Tor proxy in your environment) if you'd rather not use clearnet - see
// README.md "Block explorer" section.
const EXPLORER_BASE_URL = process.env.EXPLORER_BASE_URL || 'https://xmrchain.net';

const STRATUM_PORT = process.env.P2POOL_STRATUM_PORT || '3333';

// ---------------------------------------------------------------------------
// Status / readiness (Main tab)
// ---------------------------------------------------------------------------
app.get('/api/status', async (req, res) => {
  const settings = config.readSettings();

  let nodeInfo = null;
  let nodeError = null;
  try {
    nodeInfo = await moneroRpc.getInfo();
  } catch (err) {
    nodeError = err.message;
  }

  const p2pool = await p2poolApi.getAll();

  const rpcOk = !!nodeInfo && nodeInfo.status === 'OK';
  const syncOk = rpcOk && nodeInfo.synchronized === true;
  const payoutConfigured = !!settings.walletAddress;
  const stratumOk = p2pool.stratum.connected;

  const bestShareDifficulty = p2pool.stratum.currentEffort; // best-effort proxy, see p2poolApi.js
  const networkDifficulty = p2pool.network.difficulty ?? (nodeInfo ? nodeInfo.difficulty : null);

  res.json({
    readiness: {
      nodeRpc: rpcOk,
      payoutAddressConfigured: payoutConfigured,
      blockchainSynced: syncOk,
      stratumRunning: stratumOk,
    },
    sync: nodeInfo
      ? {
          height: nodeInfo.height,
          targetHeight: nodeInfo.target_height || nodeInfo.height,
          synchronized: nodeInfo.synchronized === true,
          status: nodeInfo.status,
        }
      : { error: nodeError },
    hashrate: {
      hashrate1h: p2pool.stratum.hashrate1h,
      hashrate15m: p2pool.stratum.hashrate15m,
      hashrate24h: p2pool.stratum.hashrate24h,
    },
    difficulty: {
      bestShare: bestShareDifficulty,
      network: networkDifficulty,
    },
    poolMode: settings.poolMode,
  });
});

// ---------------------------------------------------------------------------
// Pool tab
// ---------------------------------------------------------------------------
app.get('/api/pool', async (req, res) => {
  const settings = config.readSettings();
  const requestedMode = (req.query.mode || settings.poolMode || 'standard').toLowerCase();

  const p2pool = await p2poolApi.getAll();
  const workers = blocks.getWorkers().filter((w) => w.active);

  const runningDifferentMode = requestedMode !== settings.poolMode;

  res.json({
    requestedMode,
    activeMode: settings.poolMode,
    viewingActiveNode: !runningDifferentMode,
    note: runningDifferentMode
      ? `This node is mining on the "${settings.poolMode}" sidechain. Switch modes in Settings to mine (and view live stats for) "${requestedMode}".`
      : null,
    workersConnected: workers.length,
    hashrate: {
      hashrate15m: p2pool.stratum.hashrate15m,
      hashrate1h: p2pool.stratum.hashrate1h,
      hashrate24h: p2pool.stratum.hashrate24h,
      // 1m / 6h / 7d aren't provided by p2pool's local/stratum file as of
      // writing (see lib/p2poolApi.js) - shown as null until available.
      hashrate1m: null,
      hashrate6h: null,
      hashrate7d: null,
    },
    network: {
      difficulty: p2pool.network.difficulty,
      height: p2pool.network.height,
      algorithm: 'RandomX',
    },
    bestShare: {
      sinceBlock: p2pool.stratum.currentEffort,
      allTime: p2pool.stratum.averageEffort,
    },
    lastShareAt: workers.length
      ? workers.reduce((a, b) => (a.lastSeen > b.lastSeen ? a : b)).lastSeen
      : null,
    workers,
    minerConfig: {
      url: `${req.hostname}:${STRATUM_PORT}`,
      payoutAddress: settings.walletAddress || null,
      instructions: [
        'Point your miner (e.g. XMRig) at the URL above.',
        'Use any username you like to identify this worker - it is not checked or validated.',
        'Leave the password blank or use "x" - it is not checked.',
        'Example: ./xmrig -o <URL> -u my-rig-name -p x',
      ],
    },
  });
});

// ---------------------------------------------------------------------------
// Blocks tab
// ---------------------------------------------------------------------------
app.get('/api/blocks', (req, res) => {
  const settings = config.readSettings();
  const list = blocks.getBlocks().map((b) => ({
    ...b,
    explorerUrl: b.height ? `${EXPLORER_BASE_URL}/block/${b.height}` : null,
    addressExplorerUrl: settings.walletAddress
      ? `${EXPLORER_BASE_URL}/search?value=${settings.walletAddress}`
      : null,
  }));
  res.json({ blocks: list, explorerBaseUrl: EXPLORER_BASE_URL });
});

// ---------------------------------------------------------------------------
// Settings tab
// ---------------------------------------------------------------------------
app.get('/api/settings', (req, res) => {
  const settings = config.readSettings();
  res.json(settings);
});

app.post('/api/settings', (req, res) => {
  try {
    const updated = config.writeSettings(req.body || {});
    res.json(updated);
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Static frontend
// ---------------------------------------------------------------------------
app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

blocks.start();

app.listen(PORT, () => {
  console.log(`monero-p2pool-dashboard listening on :${PORT}`);
});
