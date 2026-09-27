'use strict';

// Keep the process alive on unexpected errors instead of crashing - an
// uncaught error anywhere (a bad response from monerod/p2pool, a flaky
// filesystem read, etc.) would otherwise kill the whole dashboard and, under
// `restart: on-failure`, loop it endlessly instead of just logging and
// carrying on. This is a monitoring dashboard, not a system of record, so
// staying up in a possibly-degraded state beats restarting.
process.on('unhandledRejection', (reason) => {
  console.error('[server] Unhandled promise rejection:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[server] Uncaught exception:', err);
});

const path = require('path');
const express = require('express');

const config = require('./lib/config');
const moneroRpc = require('./lib/moneroRpc');
const p2poolApi = require('./lib/p2poolApi');
const blocks = require('./lib/blocks');
const tariBlocks = require('./lib/tariBlocks');
const minotariRpc = require('./lib/minotariRpc');
const minotariWalletRpc = require('./lib/minotariWalletRpc');
const tariWallet = require('./lib/tariWallet');
const moneroWalletRpc = require('./lib/moneroWalletRpc');
const moneroWalletState = require('./lib/moneroWalletState');
const p2poolObserver = require('./lib/p2poolObserver');
const logs = require('./lib/logs');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

// Clearnet block explorer used to let you independently verify a found block
// paid out to your address. Point this at an .onion explorer (reached via a
// Tor proxy in your environment) if you'd rather not use clearnet - see
// README.md "Block explorer" section.
const EXPLORER_BASE_URL = process.env.EXPLORER_BASE_URL || 'https://xmrchain.net';

const STRATUM_PORT = process.env.P2POOL_STRATUM_PORT || '3333';

// Written by monerod itself (--log-file, see docker-compose.yml) into a
// volume shared read-only with this container - see README.md "Logs tab".
const MONEROD_LOG_FILE = process.env.MONEROD_LOG_FILE || '/data/monerod-logs/monerod.log';

// EXPERIMENTAL - Tari (XTM) merge-mining, see docker/p2pool/entrypoint.sh
// and app/lib/tariBlocks.js.
const MINOTARI_LOG_FILE = process.env.MINOTARI_LOG_FILE || '/data/minotari-logs/base_node.log';

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

  // EXPERIMENTAL - minotari_node's own gRPC sync progress, independent of
  // whether p2pool has merge-mining enabled, so the sidebar bar can show
  // "Not running" / "Synchronizing" / "Synchronized" for the node itself.
  let minotariSync = null;
  try {
    minotariSync = await minotariRpc.getSyncProgress();
  } catch {
    minotariSync = null;
  }

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
    p2pool: {
      running: stratumOk,
      // p2pool's own view of the Monero chain height, via its connection to
      // monerod - compared against monerod's own height/target below, this
      // is what lets the sidebar show P2Pool's sync progress.
      height: p2pool.network.height,
      // Miners connected to YOUR p2pool node's stratum port (not the whole
      // sidechain - see network.minersOnSidechain in /api/pool for that).
      connections: p2pool.stratum.connections,
      incomingConnections: p2pool.stratum.incomingConnections,
      sharesFound: p2pool.stratum.sharesFound,
      sharesFailed: p2pool.stratum.sharesFailed,
    },
    // Straight from monerod's own get_info - peer counts and daemon identity,
    // not previously surfaced anywhere in the UI.
    node: nodeInfo
      ? {
          version: nodeInfo.version || null,
          nettype: nodeInfo.nettype || (nodeInfo.mainnet ? 'mainnet' : null),
          connectionsOut: nodeInfo.outgoing_connections_count ?? null,
          connectionsIn: nodeInfo.incoming_connections_count ?? null,
          whitePeers: nodeInfo.white_peerlist_size ?? null,
          greyPeers: nodeInfo.grey_peerlist_size ?? null,
          txPoolSize: nodeInfo.tx_pool_size ?? null,
          txCount: nodeInfo.tx_count ?? null,
        }
      : null,
    poolMode: settings.poolMode,
    // EXPERIMENTAL Tari (XTM) merge-mining - "enabled" just reflects whether
    // a Tari address is configured (p2pool only adds --merge-mine when one
    // is), not whether the Tari node/wallet are actually up.
    tari: {
      enabled: !!settings.tariAddress,
      blocksFound: tariBlocks.getBlocks().length,
      // EXPERIMENTAL - real gRPC sync progress from minotari_node itself.
      // null (not {reachable:false}) when the node is unreachable/not up
      // yet, so the frontend can show "Not running" without guessing why.
      nodeSync: minotariSync
        ? {
            height: minotariSync.localHeight,
            targetHeight: minotariSync.tipHeight || minotariSync.localHeight,
            synchronized: minotariSync.synced,
          }
        : null,
    },
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

  // Optional (see lib/config.js observerEnabled) - the public P2Pool
  // Observer service, queried for network-wide info always when enabled,
  // and for this node's own lifetime shares when a payout address is set.
  // Never called unless the user opted in, since it sends the address to a
  // third party over clearnet.
  let observer = null;
  if (settings.observerEnabled) {
    try {
      const [poolInfo, minerInfo] = await Promise.all([
        p2poolObserver.getPoolInfo(requestedMode),
        settings.walletAddress ? p2poolObserver.getMinerInfo(requestedMode, settings.walletAddress) : null,
      ]);
      observer = {
        globalMiners: poolInfo?.sidechain?.miners ?? null,
        p2poolVersion: poolInfo?.versions?.p2pool?.version ?? null,
        moneroVersion: poolInfo?.versions?.monero?.version ?? null,
        yourShares: minerInfo
          ? {
              lastShareHeight: minerInfo.last_share_height ?? null,
              lastShareAt: minerInfo.last_share_timestamp ? minerInfo.last_share_timestamp * 1000 : null,
              totalShares: Array.isArray(minerInfo.shares)
                ? minerInfo.shares.reduce((sum, s) => sum + (s.shares || 0), 0)
                : null,
            }
          : null,
        explorerUrl: p2poolObserver.explorerUrlFor(requestedMode, settings.walletAddress),
      };
    } catch (err) {
      observer = { error: err.message };
    }
  }

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
      reward: p2pool.network.reward,
      algorithm: 'RandomX',
      // Sidechain-wide (all miners on this P2Pool mode), not just this node -
      // from p2pool's own pool/stats file (see lib/p2poolApi.js).
      minersOnSidechain: p2pool.pool.miners,
      totalBlocksFound: p2pool.pool.totalBlocksFound,
      sidechainSharesFound: p2pool.pool.sidechainSharesFound,
      // Sidechain-wide hashrate (all miners), not just this node's - the
      // right denominator for a pool-wide "time to find a block" estimate.
      sidechainHashrate: p2pool.pool.hashRate,
      // Standard mining ETA formula: expected seconds = difficulty / hashrate
      // (hashes/sec). Null if either input is missing/zero rather than
      // dividing by zero or showing a nonsense number.
      etaSeconds:
        p2pool.network.difficulty && p2pool.pool.hashRate
          ? p2pool.network.difficulty / p2pool.pool.hashRate
          : null,
    },
    bestShare: {
      sinceBlock: p2pool.stratum.currentEffort,
      allTime: p2pool.stratum.averageEffort,
    },
    shares: {
      found: p2pool.stratum.sharesFound,
      failed: p2pool.stratum.sharesFailed,
    },
    // null unless enabled in Settings - see comment above where it's built.
    observer,
    lastShareAt: workers.length
      ? workers.reduce((a, b) => (a.lastSeen > b.lastSeen ? a : b)).lastSeen
      : null,
    // sharePercent: this worker's proportion of shares among your own
    // connected workers (not sidechain-wide) - a real, honest stat straight
    // from what we actually track (see lib/blocks.js), unlike a per-worker
    // "odds of finding a block" which P2Pool's PPLNS payout model doesn't
    // really support computing per-worker.
    // bestDifficultyPercent: this worker's single highest-difficulty share
    // seen, as a percentage of the current Monero network difficulty - the
    // same "record share vs target" concept as the pool-wide bestShare
    // stats above, just tracked per worker via the SHARE FOUND log lines
    // (see lib/blocks.js SHARE_DIFF_RE). Expect this to sit near 0% for a
    // typical home miner - that's normal, not a bug.
    workers: (() => {
      const totalShares = workers.reduce((sum, w) => sum + w.shares, 0);
      const networkDiff = p2pool.network.difficulty;
      return workers.map((w) => ({
        ...w,
        sharePercent: totalShares ? (w.shares / totalShares) * 100 : 0,
        bestDifficultyPercent: networkDiff && w.bestDifficulty ? Math.min(100, (w.bestDifficulty / networkDiff) * 100) : 0,
      }));
    })(),
    minerConfig: {
      url: `${req.hostname}:${STRATUM_PORT}`,
      payoutAddress: settings.walletAddress || null,
      // Example worker login, so the Miner Configuration card can show a
      // ready-to-copy value instead of just prose describing the format.
      exampleWorkerLogin: settings.walletAddress ? `${settings.walletAddress}.worker-name` : null,
      instructions: [
        'Point your miner (e.g. XMRig) at the URL above.',
        'Use any username you like to identify this worker - it is not checked or validated.',
        'Leave the password blank or use "x" - it is not checked.',
        'Example: ./xmrig -o <URL> -u my-rig-name -p x',
      ],
    },
    // EXPERIMENTAL Tari (XTM) merge-mining - same workers/hashrate above
    // also mine XTM once this is enabled, at no extra cost. Tari is
    // currently solo-mined (see docker/p2pool/entrypoint.sh), so there's no
    // separate pool hashrate/difficulty to show here yet - just whether
    // it's on and what it's found.
    tari: {
      enabled: !!settings.tariAddress,
      payoutAddress: settings.tariAddress || null,
      blocksFound: tariBlocks.getBlocks().length,
    },
  });
});

// ---------------------------------------------------------------------------
// Blocks tab
// ---------------------------------------------------------------------------
app.get('/api/blocks', (req, res) => {
  const settings = config.readSettings();

  if (req.query.coin === 'xtm') {
    // EXPERIMENTAL - no XTM block explorer wired up here yet, so no
    // explorerUrl/addressExplorerUrl (unlike the XMR list below).
    res.json({ blocks: tariBlocks.getBlocks(), explorerBaseUrl: null });
    return;
  }

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
// Logs tab
// ---------------------------------------------------------------------------
app.get('/api/logs', async (req, res) => {
  const [monerod, p2pool, minotari] = await Promise.all([
    logs.tailFile(MONEROD_LOG_FILE),
    logs.tailFile(blocks.LOG_FILE),
    logs.tailFile(MINOTARI_LOG_FILE),
  ]);
  res.json({ monerod, p2pool, minotari });
});

const LOG_SOURCES = {
  monerod: () => MONEROD_LOG_FILE,
  p2pool: () => blocks.LOG_FILE,
  minotari: () => MINOTARI_LOG_FILE,
};

// Live tail (Server-Sent Events) - like `tail -f`. ?source=monerod|p2pool|minotari
app.get('/api/logs/stream', (req, res) => {
  const getFile = LOG_SOURCES[req.query.source] || LOG_SOURCES.monerod;
  const stop = logs.attachTailStream(res, getFile());
  req.on('close', stop);
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
// Wallet tab - EXPERIMENTAL "generate-once, show-once" wallet creation.
// This dashboard never holds funds and never re-shows a seed phrase once
// revealed - see lib/tariWallet.js and docker-compose.yml's
// --seed-words-file-name flag on minotari-wallet for how that's enforced.
// ---------------------------------------------------------------------------
app.get('/api/wallet/tari', async (req, res) => {
  let address = null;
  try {
    ({ address } = await minotariWalletRpc.getAddress());
  } catch (err) {
    // Wallet not reachable yet (still starting, or not run in this stack) -
    // not an error the user needs a stack trace for.
  }
  res.json({ address, seedAvailable: tariWallet.seedAvailable() });
});

// POST (not GET) because this is a one-time, side-effecting reveal - it
// deletes the seed file from disk as part of returning it.
app.post('/api/wallet/tari/reveal-seed', (req, res) => {
  const words = tariWallet.revealSeedWords();
  if (!words) {
    res.status(404).json({ error: 'No seed phrase available - it was already revealed, or this wallet was restored rather than freshly created.' });
    return;
  }
  res.json({ words });
});

app.get('/api/wallet/monero', async (req, res) => {
  let address = null;
  try {
    ({ address } = await moneroWalletRpc.getAddress());
  } catch (err) {
    // monero-wallet-rpc not reachable yet, or still syncing with monerod -
    // not an error the user needs a stack trace for.
  }
  res.json({ address, seedAvailable: address ? !moneroWalletState.seedRevealed() : false });
});

// POST (not GET) - side-effecting, marks the seed as revealed so it can
// never be shown through this dashboard again (see lib/moneroWalletState.js
// for why this can't be enforced by deleting anything, unlike Tari's flow).
app.post('/api/wallet/monero/reveal-seed', async (req, res) => {
  if (moneroWalletState.seedRevealed()) {
    res.status(404).json({ error: 'This seed phrase was already revealed once through this dashboard.' });
    return;
  }
  try {
    const words = await moneroWalletRpc.getSeedWords();
    moneroWalletState.markSeedRevealed();
    res.json({ words });
  } catch (err) {
    res.status(502).json({ error: err.message });
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
tariBlocks.start();

app.listen(PORT, () => {
  console.log(`monero-p2pool-dashboard listening on :${PORT}`);
});
