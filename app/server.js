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
const discordNotify = require('./lib/discordNotify');
const tariBlocks = require('./lib/tariBlocks');
const minotariRpc = require('./lib/minotariRpc');
const minotariWalletRpc = require('./lib/minotariWalletRpc');
const tariWallet = require('./lib/tariWallet');
const tariWalletRecovery = require('./lib/tariWalletRecovery');
const moneroWalletRpc = require('./lib/moneroWalletRpc');
const moneroWalletState = require('./lib/moneroWalletState');
const p2poolObserver = require('./lib/p2poolObserver');
const logs = require('./lib/logs');
const blockchainImport = require('./lib/blockchainImport');
const networkInfo = require('./lib/networkInfo');
const p2poolCommand = require('./lib/p2poolCommand');
const workerConnectionNotify = require('./lib/workerConnectionNotify');
const minotariLifecycle = require('./lib/minotariLifecycle');
const poolHistory = require('./lib/poolHistory');

const app = express();
app.use(express.json());

// Real RPC/validation errors (bad address, insufficient funds, transfer
// rejected, etc.) are useful to show the user verbatim. A raw network
// failure (Node's "fetch failed", or gRPC's "UNAVAILABLE: Name resolution
// failed") just means the wallet container isn't reachable yet - show that
// instead of the underlying library's low-level wording.
function friendlyWalletError(err, walletLabel) {
  if (err.statusCode) return err.message; // a validation error we threw ourselves
  const raw = err.message || String(err);
  if (/fetch failed|ECONNREFUSED|ENOTFOUND|UNAVAILABLE|Name resolution failed/i.test(raw)) {
    return `${walletLabel} wallet not reachable - it may still be starting up. Try again in a moment.`;
  }
  return raw;
}

const PORT = process.env.PORT || 3000;

// Single source of truth for the header's on-screen version badge (see
// public/index.html #pv-app-version/#pv-app-stage) - it used to be a
// hardcoded string baked into the HTML and got left on "Alpha-9" through
// this entire Alpha-10 release since nothing pointed back at it as a step to
// update. Bump this, not the HTML, on every release.
const APP_VERSION = 'v1.0-Alpha14';

// Sync-speed-derived ETA for the Overview tab's blockchain cards - neither
// monerod nor minotari_node's RPC exposes an ETA directly, so this tracks
// the height/timestamp from the previous /api/status poll per chain and
// derives blocks-per-second from the delta. Module-scope state (not
// per-request) is required for this to mean anything across polls.
const heightHistory = {};
function estimateSyncEtaSeconds(chain, height, targetHeight) {
  const now = Date.now();
  const prev = heightHistory[chain];
  heightHistory[chain] = { height, t: now };
  if (!prev || height == null || targetHeight == null) return null;
  const remaining = targetHeight - height;
  if (remaining <= 0) return 0;
  const elapsedSec = (now - prev.t) / 1000;
  const blocksGained = height - prev.height;
  if (elapsedSec <= 0 || blocksGained <= 0) return null; // not enough signal yet this tick
  const blocksPerSec = blocksGained / elapsedSec;
  return remaining / blocksPerSec;
}

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
// and app/lib/tariBlocks.js. Not a flat "base_node.log" - the official
// minotari_node image's own log4rs config splits output by category into a
// base_node/ subdirectory; base_layer.log is the one that actually carries
// the general startup/sync/mempool activity this app parses.
const MINOTARI_LOG_FILE = process.env.MINOTARI_LOG_FILE || '/data/minotari-logs/base_node/base_layer.log';

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

  // Only meaningful once nodeInfo itself succeeded - a second RPC call, so
  // failure here shouldn't take down the rest of /api/status.
  let lastBlockHeader = null;
  if (nodeInfo) {
    try {
      lastBlockHeader = await moneroRpc.getLastBlockHeader();
    } catch {
      lastBlockHeader = null;
    }
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

  let minotariNetworkState = null;
  try {
    minotariNetworkState = await minotariRpc.getNetworkState();
  } catch {
    minotariNetworkState = null;
  }

  const rpcOk = !!nodeInfo && nodeInfo.status === 'OK';
  const syncOk = rpcOk && nodeInfo.synchronized === true;
  const payoutConfigured = !!settings.walletAddress;
  const stratumOk = p2pool.stratum.connected;

  const bestShareDifficulty = p2pool.stratum.currentEffort; // best-effort proxy, see p2poolApi.js
  const networkDifficulty = p2pool.network.difficulty ?? (nodeInfo ? nodeInfo.difficulty : null);

  // Best-effort "is this port actually reachable from the internet" signal
  // for each p2p-facing service - none of them can test their own external
  // reachability, but a service accepting *inbound* connections (not just
  // making outbound ones itself) is strong evidence its port is open and
  // forwarded correctly. Right after startup these can read false for a
  // while even on a correctly forwarded port, simply because no peer has
  // connected in yet.
  const moneroPortOpen = rpcOk && (nodeInfo.incoming_connections_count ?? 0) > 0;
  const p2poolPortOpen = !!p2pool.p2p.connected && (p2pool.p2p.incomingConnections ?? 0) > 0;
  // Tari merge-mining is optional - don't fail this check for someone who
  // has never enabled it (settings.tariAddress blank).
  const minotariPortOpen = !settings.tariAddress || (!!minotariNetworkState && minotariNetworkState.numConnections > 0);

  res.json({
    appVersion: APP_VERSION,
    readiness: {
      nodeRpc: rpcOk,
      payoutAddressConfigured: payoutConfigured,
      blockchainSynced: syncOk,
      stratumRunning: stratumOk,
      moneroPortOpen,
      p2poolPortOpen,
      minotariPortOpen,
    },
    sync: nodeInfo
      ? {
          height: nodeInfo.height,
          targetHeight: nodeInfo.target_height || nodeInfo.height,
          synchronized: nodeInfo.synchronized === true,
          status: nodeInfo.status,
          // pruning_seed is 0 on a full/archival node, non-zero on a pruned
          // one (this stack's own monerod always runs --prune-blockchain -
          // see docker-compose.yml - so this should normally read true).
          pruned: (nodeInfo.pruning_seed ?? 0) !== 0,
          etaSeconds: estimateSyncEtaSeconds('monero', nodeInfo.height, nodeInfo.target_height || nodeInfo.height),
          lastBlockAt: lastBlockHeader ? lastBlockHeader.timestamp * 1000 : null,
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
          // Bytes on disk for the blockchain data dir, straight from
          // get_info - not previously surfaced anywhere in the UI.
          databaseSizeBytes: nodeInfo.database_size ?? null,
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
            etaSeconds: estimateSyncEtaSeconds(
              'minotari',
              minotariSync.localHeight,
              minotariSync.tipHeight || minotariSync.localHeight
            ),
          }
        : null,
      // Peer count, for the Overview card's Peers tile - separate from
      // minotariPortOpen above (that's a reachability signal, this is the
      // raw number to display). null (not 0) when the node is unreachable.
      peers: minotariNetworkState ? minotariNetworkState.numConnections : null,
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
  // Live, real-time connected-worker list straight from p2pool's own
  // local/stratum API (updated every ~20s by p2pool itself, independent of
  // whether that worker has ever submitted a share yet) - see
  // lib/p2poolApi.js's parseWorkerEntry. This is the authoritative "who's
  // connected right now" source: unlike lib/blocks.js's SHARE FOUND log
  // parsing, a worker shows up the moment it connects and disappears the
  // moment it disconnects, instead of waiting for/depending on a share.
  const liveWorkers = p2pool.stratum.workers || [];
  // Lifetime share history (count, best/current difficulty) is only ever
  // observable from the log (p2pool's local API doesn't expose it), so we
  // still merge that in by worker name where we have it.
  const shareHistory = new Map(blocks.getWorkers().map((w) => [w.name, w]));
  const workers = liveWorkers.map((lw) => {
    const name = lw.name || lw.address;
    const hist = shareHistory.get(lw.name);
    return {
      name,
      address: lw.address,
      connectedSeconds: lw.connectedSeconds,
      currentDifficulty: lw.difficulty ?? hist?.currentDifficulty ?? 0,
      hashrate: lw.hashrate,
      shares: hist?.shares ?? 0,
      firstSeen: hist?.firstSeen ?? null,
      lastSeen: hist?.lastSeen ?? null,
      bestDifficulty: hist?.bestDifficulty ?? 0,
    };
  });

  const runningDifferentMode = requestedMode !== settings.poolMode;
  const wanIp = await networkInfo.getWanIp();

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
      // Your own connected miners/workers - NOT the sidechain-wide miner
      // count (that was the "Miners" tile's original meaning, from p2pool's
      // pool/stats "miners" field - swapped out per explicit request to show
      // yours instead). Same live count as the Workers tile elsewhere (see
      // p2poolApi.js's local/stratum workers array).
      minersOnSidechain: workers.length,
      // Blocks YOU found, not the sidechain-wide total (p2pool's pool/stats
      // "totalBlocksFound" counts every block anyone on this mode has ever
      // found). blocks.getBlocks() is already filtered to blocks p2pool
      // itself cryptographically attributed to this node's configured wallet
      // address (see lib/blocks.js BLOCK_FOUND_BY_YOU_RE - p2pool compares
      // the winning share's actual wallet, not a display string, against
      // --wallet, so "by you" is a real address match, not a guess).
      totalBlocksFound: blocks.getBlocks().length,
      sidechainSharesFound: p2pool.pool.sidechainSharesFound,
      // Sidechain-wide hashrate (all miners), not just this node's - the
      // right denominator for a pool-wide "time to find a block" estimate.
      sidechainHashrate: p2pool.pool.hashRate,
      // Standard mining ETA formula: expected seconds = difficulty / hashrate
      // (hashes/sec). Null if either input is missing/zero rather than
      // dividing by zero or showing a nonsense number. This uses the real
      // Monero mainchain difficulty, so it's the actual "how often does
      // P2Pool as a whole find a real XMR block" figure - correctly
      // different for standard/mini/nano since each mode's sidechain
      // hashrate differs, exactly like p2pool.observer's own per-mode
      // calculators (p2pool.observer / mini.p2pool.observer / nano.p2pool.observer).
      etaSeconds:
        p2pool.network.difficulty && p2pool.pool.hashRate
          ? p2pool.network.difficulty / p2pool.pool.hashRate
          : null,
      // Sidechain's own difficulty (see lib/p2poolApi.js sidechainDifficulty)
      // - this is what determines P2Pool SHARE cadence, as distinct from
      // etaSeconds above (real Monero BLOCK cadence). Each mode retargets
      // this independently (10s target for standard/mini, 30s for nano -
      // confirmed in p2pool's own src/side_chain.cpp).
      //
      // shareEtaSeconds divides by THIS NODE's OWN hashrate, not the
      // sidechain-wide pool hashrate - confirmed directly against
      // p2pool.observer's own "Average Share Time Calculator"
      // (p2pool.observer / mini.p2pool.observer / nano.p2pool.observer,
      // "Your Share Mean"): at a 7 KH/s test hashrate its numbers only match
      // sidechainDifficulty / 7000, not sidechainDifficulty / pool-wide
      // hashrate. That's the right framing anyway - a miner cares how often
      // *their own* node finds a share, not the pool-wide average (which is
      // just the ~10s/30s design target by construction and not a useful
      // number to compute).
      sidechainDifficulty: p2pool.pool.sidechainDifficulty,
      shareEtaSeconds:
        p2pool.pool.sidechainDifficulty && p2pool.stratum.hashrate1h
          ? p2pool.pool.sidechainDifficulty / p2pool.stratum.hashrate1h
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
    // Straight from p2pool's own last_share_found_time (see lib/p2poolApi.js)
    // - real-time and not dependent on our own log parsing having caught up.
    lastShareAt: p2pool.stratum.lastShareFoundTime,
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
    // currentDifficulty (passed through from lib/blocks.js via the ...w
    // spread below): the difficulty of this worker's most recent share -
    // P2Pool's stratum uses vardiff, so this approximates the difficulty
    // target this worker is mining at right now, distinct from
    // bestDifficulty (their all-time record, which only trends upward).
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
      // LAN address is whatever host the browser actually used to reach this
      // page (req.hostname) - reading the container's own network interfaces
      // (the old approach) returned the Docker bridge network's internal IP
      // (e.g. 172.18.0.5), not the host machine's real LAN-facing address,
      // since this container isn't on network_mode: host. The browser is
      // necessarily already on the LAN to have loaded this page at all, so
      // its own Host header is the correct LAN address by construction. WAN
      // address needs an external "what's my IP" lookup (see
      // lib/networkInfo.js) and is null until that first resolves.
      lanUrl: `${req.hostname}:${STRATUM_PORT}`,
      wanUrl: wanIp ? `${wanIp}:${STRATUM_PORT}` : null,
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

// Pool tab's Hash Rate History / Network Difficulty History graphs - real
// persisted history (see lib/poolHistory.js), not just a client-side buffer
// that resets on reload.
app.get('/api/pool/history', (req, res) => {
  res.json({ samples: poolHistory.getSamples() });
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

// P2Pool log viewer's command button - sends a command into p2pool's own
// stdin console (see lib/p2poolCommand.js); the response prints to p2pool's
// stdout, which is already streamed into the log above.
app.post('/api/p2pool/command', async (req, res) => {
  const command = (req.body || {}).command;
  try {
    await p2poolCommand.sendCommand(command);
    res.json({ ok: true });
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
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

// Settings tab's "Send Test Notification" button - accepts an explicit URL
// so a webhook can be tried before it's saved, falling back to whatever's
// already in Settings if none is given.
app.post('/api/discord/test', async (req, res) => {
  const { webhookUrl } = req.body || {};
  try {
    await discordNotify.sendTest(typeof webhookUrl === 'string' ? webhookUrl.trim() : undefined);
    res.json({ sent: true });
  } catch (err) {
    res.status(err.statusCode || 502).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Wallet tab - EXPERIMENTAL "generate-once, show-once" wallet creation.
// This dashboard never holds funds and never re-shows a seed phrase once
// revealed - see lib/tariWallet.js and docker-compose.yml's
// --seed-words-file-name flag on minotari-wallet for how that's enforced.
// Neither wallet is ever created automatically just because the stack is
// running - both need an explicit "Create Wallet" click first (see
// tariWallet.js's requestWalletCreation and moneroWalletRpc.js's
// createWallet).
// ---------------------------------------------------------------------------
app.get('/api/wallet/tari', async (req, res) => {
  let address = null;
  try {
    ({ address } = await minotariWalletRpc.getAddress());
  } catch (err) {
    // Wallet not reachable yet (still starting, still waiting for a Create
    // Wallet click, or not run in this stack) - not an error the user needs
    // a stack trace for.
  }
  // Same "external wallet" case as /api/wallet/monero above - a Tari
  // merge-mining address saved in Settings that this dashboard never
  // created itself.
  const externalAddress = address ? null : (config.readSettings().tariAddress || null);
  res.json({
    address,
    seedAvailable: tariWallet.seedAvailable(),
    external: !!externalAddress,
    externalAddress,
  });
});

// The Tari wallet container waits for this before it ever generates a
// wallet - see docker/minotari-wallet/entrypoint.sh. No Docker socket
// needed (unlike Recover Wallet): the container is already running and
// just polls for this file on the volume it shares with the app.
app.post('/api/wallet/tari/create', (req, res) => {
  try {
    tariWallet.requestWalletCreation();
    res.json({ requested: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
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

app.get('/api/wallet/tari/balance', async (req, res) => {
  try {
    const balance = await minotariWalletRpc.getBalance();
    res.json(balance);
  } catch (err) {
    res.status(502).json({ error: 'Tari wallet not reachable yet.' });
  }
});

// Real funds-moving endpoint - see lib/minotariWalletRpc.js's transfer().
// Recipient address and amount are the only inputs trusted from the
// request; the actual fee rate is fetched fresh from the network, never
// taken from the client.
app.post('/api/wallet/tari/send', async (req, res) => {
  const { address, amount } = req.body || {};
  if (typeof address !== 'string' || !address.trim()) {
    res.status(400).json({ error: 'A recipient address is required.' });
    return;
  }
  try {
    const result = await minotariWalletRpc.transfer(address.trim(), amount);
    res.json(result);
  } catch (err) {
    res.status(err.statusCode || 502).json({ error: friendlyWalletError(err, 'Tari') });
  }
});

// Wallet tab's "Recover Wallet" button (Tari side) - restarts minotari-wallet
// with the given seed words. See lib/tariWalletRecovery.js for why this
// needs the Docker socket (unlike Monero's recovery, below, which doesn't).
app.get('/api/wallet/tari/recover/status', (req, res) => {
  res.json(tariWalletRecovery.getState());
});

app.post('/api/wallet/tari/recover', async (req, res) => {
  const { seedWords } = req.body || {};
  if (typeof seedWords !== 'string' || !seedWords.trim()) {
    res.status(400).json({ error: 'Seed phrase is required.' });
    return;
  }
  try {
    await tariWalletRecovery.startRecovery(seedWords);
    res.json({ started: true });
  } catch (err) {
    res.status(err.statusCode || 409).json({ error: err.message });
  }
});

app.post('/api/wallet/tari/recover/reset', (req, res) => {
  try {
    tariWalletRecovery.reset();
    res.json({ ok: true });
  } catch (err) {
    res.status(409).json({ error: err.message });
  }
});

app.get('/api/wallet/monero', async (req, res) => {
  let address = null;
  try {
    ({ address } = await moneroWalletRpc.getAddress());
  } catch (err) {
    // monero-wallet-rpc not reachable yet, or still syncing with monerod -
    // not an error the user needs a stack trace for.
  }
  // No wallet was ever created here, but a payout address is saved in
  // Settings anyway - that address belongs to a wallet this dashboard
  // doesn't hold keys for (a hardware wallet, mobile wallet, exchange,
  // etc.). The Wallet tab shows that as its own state rather than offering
  // "Create Wallet", which would generate an unrelated wallet with no
  // connection to the address actually receiving payouts.
  const externalAddress = address ? null : (config.readSettings().walletAddress || null);
  res.json({
    address,
    seedAvailable: address ? !moneroWalletState.seedRevealed() : false,
    external: !!externalAddress,
    externalAddress,
  });
});

// Explicit "Create Wallet" click - see moneroWalletRpc.js's ensureWalletOpen
// for why this is the only place that ever creates one.
app.post('/api/wallet/monero/create', async (req, res) => {
  try {
    const result = await moneroWalletRpc.createWallet();
    res.json(result);
  } catch (err) {
    res.status(502).json({ error: 'Monero wallet not reachable yet.' });
  }
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

app.get('/api/wallet/monero/balance', async (req, res) => {
  try {
    const balance = await moneroWalletRpc.getBalance();
    res.json(balance);
  } catch (err) {
    res.status(502).json({ error: 'Monero wallet not reachable yet.' });
  }
});

// Wallet tab's "Recover Wallet" button (Monero side) - see
// lib/moneroWalletRpc.js's restoreFromSeed for why this can run as a single
// synchronous RPC call rather than the stop/wipe/restart dance Tari's
// recovery needs (no Docker socket required for this one).
app.post('/api/wallet/monero/recover', async (req, res) => {
  const { seedWords, restoreHeight } = req.body || {};
  if (typeof seedWords !== 'string' || !seedWords.trim()) {
    res.status(400).json({ error: 'Seed phrase is required.' });
    return;
  }
  const parsedHeight = restoreHeight === undefined || restoreHeight === '' ? 0 : Number(restoreHeight);
  if (!Number.isInteger(parsedHeight) || parsedHeight < 0) {
    res.status(400).json({ error: 'Restore height must be a non-negative whole number, or left blank.' });
    return;
  }
  try {
    const result = await moneroWalletRpc.restoreFromSeed(seedWords, parsedHeight);
    res.json(result);
  } catch (err) {
    res.status(err.statusCode || 502).json({ error: err.message });
  }
});

// Real funds-moving endpoint - see lib/moneroWalletRpc.js's transfer().
app.post('/api/wallet/monero/send', async (req, res) => {
  const { address, amount } = req.body || {};
  if (!config.isPlausibleMoneroAddress(address)) {
    res.status(400).json({
      error: 'That does not look like a valid Monero primary address (should be 95 characters, starting with 4). ' +
        'Subaddresses (starting with 8) are not supported.',
    });
    return;
  }
  try {
    const result = await moneroWalletRpc.transfer(address.trim(), amount);
    res.json(result);
  } catch (err) {
    res.status(err.statusCode || 502).json({ error: friendlyWalletError(err, 'Monero') });
  }
});

// ---------------------------------------------------------------------------
// Settings tab - hidden, opt-in "Import Blockchain" feature. See
// lib/blockchainImport.js and lib/dockerControl.js. Every route below
// refuses to do anything unless importBlockchainEnabled is on, even if
// called directly - the setting isn't just a UI show/hide.
// ---------------------------------------------------------------------------
app.get('/api/blockchain-import/status', (req, res) => {
  res.json(blockchainImport.getState());
});

app.post('/api/blockchain-import/start', async (req, res) => {
  if (!config.readSettings().importBlockchainEnabled) {
    res.status(403).json({ error: 'Blockchain import is disabled. Enable it in Settings first.' });
    return;
  }
  const { host, port, username, authMethod, password, privateKey, remotePath } = req.body || {};
  if (typeof host !== 'string' || !host.trim()) {
    res.status(400).json({ error: 'A host is required.' });
    return;
  }
  if (typeof username !== 'string' || !username.trim()) {
    res.status(400).json({ error: 'A username is required.' });
    return;
  }
  if (typeof remotePath !== 'string' || !remotePath.trim()) {
    res.status(400).json({ error: 'A remote path is required.' });
    return;
  }
  const portNum = Number(port) || 22;
  if (authMethod === 'key') {
    if (typeof privateKey !== 'string' || !privateKey.trim()) {
      res.status(400).json({ error: 'A private key is required for key authentication.' });
      return;
    }
  } else if (authMethod === 'password') {
    if (typeof password !== 'string' || !password) {
      res.status(400).json({ error: 'A password is required for password authentication.' });
      return;
    }
  } else {
    res.status(400).json({ error: "authMethod must be 'key' or 'password'." });
    return;
  }
  try {
    await blockchainImport.startImport({
      host: host.trim(),
      port: portNum,
      username: username.trim(),
      authMethod,
      password,
      privateKey,
      remotePath: remotePath.trim(),
    });
    res.json({ started: true });
  } catch (err) {
    res.status(409).json({ error: err.message });
  }
});

app.post('/api/blockchain-import/reset', (req, res) => {
  try {
    blockchainImport.reset();
    res.json({ ok: true });
  } catch (err) {
    res.status(409).json({ error: err.message });
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
workerConnectionNotify.start();
minotariLifecycle.start();
poolHistory.start();

app.listen(PORT, () => {
  console.log(`Triple X listening on :${PORT}`);
});
