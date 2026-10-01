'use strict';

// Demo/showcase mode - injects realistic, animated fake data instead of
// hitting the real backend, so this dashboard can be recorded/screenshotted
// on a box with no real monerod/p2pool/wallet stack running (or one that's
// mid-sync / has no real traffic yet). Entirely client-side: it wraps
// window.fetch and only intercepts the specific API paths this file knows
// how to fake, before preview.js's own fetch calls ever run.
//
// Activate with ?demo=1 on the URL. Nothing here runs otherwise - this file
// is inert (a single early return) on a normal page load, so it's safe to
// ship without a build step or removing it before recording.
//
// Optional extra flags:
//   &external=1 - show the Monero wallet as an externally-managed address
//                 (the Settings-configured-but-never-created-here card)
//                 instead of a full app-created wallet with balance/send.
(function () {
  const params = new URLSearchParams(location.search);
  if (params.get('demo') !== '1') return;

  console.info('[demo-mode] Active - all API responses on this page are simulated, not from a real node/pool/wallet.');

  const showExternalMonero = params.get('external') === '1';
  const START = Date.now();
  const elapsed = () => (Date.now() - START) / 1000;
  const jitter = (spread) => (Math.random() - 0.5) * spread;

  const DEMO_XMR_ADDRESS =
    '48oNaTLmY4iNGgpJHDvSpCzj9JXCLzxc7LU6dEsrOJhFHbaVJgMY7fXTfDMoK79atJvXPYzsq7HGeMc1LmxCXTPQ2rPjP5V';
  const DEMO_TARI_ADDRESS =
    '14a1c5a6f2b8e0d9c3f7a2b5e8d1c4f7a0b3e6d9c2f5a8b1e4d7c0f3a6b9e2d5c8f1a4b7e0d3c6f9a2b5e8d1c4f7a0b3';

  // ---------------------------------------------------------------------
  // A "world" of slowly-evolving numbers, computed fresh on every request
  // from elapsed time so overview/pool/blocks stay consistent with each
  // other and drift naturally instead of jumping around randomly.
  // ---------------------------------------------------------------------
  const BASE_HEIGHT = 3182450;
  const BASE_TARI_HEIGHT = 91520;
  const NETWORK_DIFF_BASE = 407_612_384_912;

  const WORKER_DEFS = [
    { name: 'rig-01', bornAgoSec: 3600 * 30, shareEvery: 9, bestDifficulty: 612_000_000 },
    { name: 'rig-02-gpu', bornAgoSec: 3600 * 10, shareEvery: 14, bestDifficulty: 208_000_000 },
    { name: 'nuc-miner', bornAgoSec: 3600 * 4, shareEvery: 22, bestDifficulty: 74_000_000 },
  ];

  function buildWorld() {
    const t = elapsed();
    const height = BASE_HEIGHT + Math.floor(t / 118); // ~2 min/block
    const tariHeight = BASE_TARI_HEIGHT + Math.floor(t / 14);
    const networkDiff = Math.round(NETWORK_DIFF_BASE + Math.sin(t / 600) * 1_500_000_000);
    const poolHashrate = 1_150_000 + Math.sin(t / 240) * 80_000;
    const yourHashrate1h = 42_500 + Math.sin(t / 90) * 3500 + jitter(400);
    const yourHashrate15m = yourHashrate1h + jitter(1500);
    const yourHashrate24h = 41_800 + Math.sin(t / 900) * 2000;

    const workers = WORKER_DEFS.map((w) => {
      const shares = Math.floor(t / w.shareEvery) + 12;
      const currentDifficulty = Math.round(480_000 + Math.sin(t / 50 + w.name.length) * 60_000);
      return {
        name: w.name,
        shares,
        firstSeen: new Date(START - w.bornAgoSec * 1000).toISOString(),
        lastSeen: new Date(Date.now() - Math.random() * 8000).toISOString(),
        active: true,
        bestDifficulty: w.bestDifficulty,
        currentDifficulty,
      };
    });
    const totalShares = workers.reduce((s, w) => s + w.shares, 0);
    workers.forEach((w) => {
      w.sharePercent = totalShares ? (w.shares / totalShares) * 100 : 0;
      w.bestDifficultyPercent = Math.min(100, (w.bestDifficulty / networkDiff) * 100);
    });

    return { t, height, tariHeight, networkDiff, poolHashrate, yourHashrate1h, yourHashrate15m, yourHashrate24h, workers };
  }

  // A 4th block "arrives" partway through the recording for a nice on-camera
  // moment, then stays found for the rest of the session.
  const staticXmrBlocks = [
    { height: BASE_HEIGHT - 4021, hash: 'a3f1c9e7d2b4568901234567890abcdef1234567890abcdef1234567890abcd', detectedAt: new Date(START - 86400000 * 6).toISOString() },
    { height: BASE_HEIGHT - 1187, hash: 'b7e2d4a9f10236547890abcdef1234567890abcdef1234567890abcdef12345', detectedAt: new Date(START - 86400000 * 2).toISOString() },
  ];
  let bonusBlockAdded = false;
  function getXmrBlocks() {
    if (!bonusBlockAdded && elapsed() > 40) {
      bonusBlockAdded = true;
      staticXmrBlocks.unshift({
        height: BASE_HEIGHT + Math.floor(elapsed() / 118),
        hash: 'f9024681357bace0246813579bdf0246813579bdf0246813579bdf024681357',
        detectedAt: new Date().toISOString(),
      });
    }
    return staticXmrBlocks;
  }
  const staticXtmBlocks = [
    { height: BASE_TARI_HEIGHT - 340, hash: 'c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2', detectedAt: new Date(START - 86400000 * 3).toISOString(), raw: 'BLOCK FOUND: height 91180' },
  ];

  // ---------------------------------------------------------------------
  // Import Blockchain lifecycle - drives itself once /start is "called",
  // mirroring app/lib/blockchainImport.js's real state machine.
  // ---------------------------------------------------------------------
  let importState = { status: 'idle', message: '', percent: null, startedAt: null, finishedAt: null, outputTail: [] };
  function startDemoImport() {
    importState = { status: 'stopping', message: 'Stopping monerod...', percent: null, startedAt: Date.now(), finishedAt: null, outputTail: [] };
    setTimeout(() => {
      importState.status = 'copying';
      importState.message = 'Copying blockchain data...';
      importState.percent = 0;
      const copyStart = Date.now();
      const COPY_MS = 16000;
      const iv = setInterval(() => {
        const pct = Math.min(100, Math.round(((Date.now() - copyStart) / COPY_MS) * 100));
        importState.percent = pct;
        importState.outputTail.push(`${pct}%`);
        if (importState.outputTail.length > 20) importState.outputTail.shift();
        if (pct >= 100) {
          clearInterval(iv);
          importState.status = 'fixing-permissions';
          importState.message = 'Fixing file ownership...';
          setTimeout(() => {
            importState.status = 'starting';
            importState.message = 'Starting monerod...';
            setTimeout(() => {
              importState.status = 'done';
              importState.message = 'Import complete - monerod is back up with the imported data.';
              importState.finishedAt = Date.now();
            }, 2500);
          }, 2000);
        }
      }, 400);
    }, 1500);
  }

  const DEMO_SEED_WORDS = [
    'demo', 'seed', 'phrase', 'never', 'a', 'real', 'wallet', 'showcase',
    'video', 'only', 'simulated', 'data', 'triple', 'x', 'dashboard',
    'monero', 'tari', 'merge', 'mining', 'p2pool', 'sample', 'words', 'not', 'funds',
  ];

  function json(body, status) {
    return new Response(JSON.stringify(body), {
      status: status || 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const realFetch = window.fetch.bind(window);

  window.fetch = async function (input, init) {
    const rawUrl = typeof input === 'string' ? input : input.url;
    const url = new URL(rawUrl, location.origin);
    const path = url.pathname;
    const method = (init && init.method) || (input instanceof Request ? input.method : 'GET') || 'GET';

    if (path === '/api/status') {
      const w = buildWorld();
      return json({
        readiness: {
          nodeRpc: true,
          payoutAddressConfigured: true,
          blockchainSynced: true,
          stratumRunning: true,
          moneroPortOpen: true,
          p2poolPortOpen: true,
          minotariPortOpen: true,
        },
        sync: { height: w.height, targetHeight: w.height, synchronized: true, status: 'OK' },
        hashrate: { hashrate1h: w.yourHashrate1h, hashrate15m: w.yourHashrate15m, hashrate24h: w.yourHashrate24h },
        difficulty: { bestShare: 210_000_000, network: w.networkDiff },
        p2pool: {
          running: true,
          height: w.height,
          connections: WORKER_DEFS.length,
          incomingConnections: WORKER_DEFS.length,
          sharesFound: w.workers.reduce((s, x) => s + x.shares, 0),
          sharesFailed: 2,
        },
        node: {
          version: '0.18.5.1',
          nettype: 'mainnet',
          connectionsOut: 12,
          connectionsIn: 12,
          whitePeers: 4821,
          greyPeers: 15032,
          txPoolSize: 18,
          txCount: 45_812_903,
        },
        poolMode: 'standard',
        tari: {
          enabled: true,
          blocksFound: staticXtmBlocks.length,
          nodeSync: { height: w.tariHeight, targetHeight: w.tariHeight, synchronized: true },
        },
      });
    }

    if (path === '/api/pool') {
      const w = buildWorld();
      const requestedMode = (url.searchParams.get('mode') || 'standard').toLowerCase();
      return json({
        requestedMode,
        activeMode: 'standard',
        viewingActiveNode: true,
        note: null,
        workersConnected: w.workers.length,
        hashrate: {
          hashrate15m: w.yourHashrate15m,
          hashrate1h: w.yourHashrate1h,
          hashrate24h: w.yourHashrate24h,
        },
        network: {
          difficulty: w.networkDiff,
          height: w.height,
          reward: 600_000_000_000,
          algorithm: 'RandomX',
          minersOnSidechain: 1834,
          totalBlocksFound: 5122,
          sidechainSharesFound: 8_231_904,
          sidechainHashrate: w.poolHashrate,
          etaSeconds: w.networkDiff / w.poolHashrate,
          soloEtaSeconds: w.networkDiff / w.yourHashrate1h,
        },
        bestShare: { sinceBlock: 210_000_000, allTime: 612_000_000 },
        shares: { found: w.workers.reduce((s, x) => s + x.shares, 0), failed: 2 },
        observer: null,
        lastShareAt: new Date(Date.now() - 4000).toISOString(),
        workers: w.workers,
        minerConfig: {
          url: `${url.hostname}:3333`,
          payoutAddress: DEMO_XMR_ADDRESS,
          exampleWorkerLogin: `${DEMO_XMR_ADDRESS}.worker-name`,
          instructions: [
            'Point your miner (e.g. XMRig) at the URL above.',
            'Use any username you like to identify this worker - it is not checked or validated.',
            'Leave the password blank or use "x" - it is not checked.',
            'Example: ./xmrig -o <URL> -u my-rig-name -p x',
          ],
        },
        tari: { enabled: true, payoutAddress: DEMO_TARI_ADDRESS, blocksFound: staticXtmBlocks.length },
      });
    }

    if (path === '/api/blocks') {
      if (url.searchParams.get('coin') === 'xtm') {
        return json({ blocks: staticXtmBlocks, explorerBaseUrl: null });
      }
      const list = getXmrBlocks().map((b) => ({
        ...b,
        explorerUrl: `https://xmrchain.net/block/${b.height}`,
        addressExplorerUrl: `https://xmrchain.net/search?value=${DEMO_XMR_ADDRESS}`,
      }));
      return json({ blocks: list, explorerBaseUrl: 'https://xmrchain.net' });
    }

    if (path === '/api/settings' && method === 'GET') {
      return json({
        walletAddress: DEMO_XMR_ADDRESS,
        poolMode: 'standard',
        tariAddress: DEMO_TARI_ADDRESS,
        observerEnabled: false,
        logsTabEnabled: true,
        p2poolLightMode: false,
        p2poolNoRandomx: false,
        p2poolNoCache: false,
        importBlockchainEnabled: true,
        discordWebhookUrl: '',
        discordNotifyXmrBlocks: true,
        discordNotifyXtmBlocks: true,
        discordNotifyShares: false,
      });
    }
    if (path === '/api/settings' && method === 'POST') {
      return json({ ok: true });
    }

    if (path === '/api/wallet/tari' && method === 'GET') {
      return json({ address: DEMO_TARI_ADDRESS, seedAvailable: true, external: false, externalAddress: null });
    }
    if (path === '/api/wallet/tari/balance') {
      return json({ availableBalance: '1245.328910', pendingIncoming: '3.500000', pendingOutgoing: '0.000000' });
    }
    if (path === '/api/wallet/tari/reveal-seed' && method === 'POST') {
      return json({ words: DEMO_SEED_WORDS });
    }
    if (path === '/api/wallet/tari/send' && method === 'POST') {
      return json({ transactionId: 'demo-' + Math.random().toString(36).slice(2, 10), amountXtm: '10.000000', feePerGram: '5' });
    }

    if (path === '/api/wallet/monero' && method === 'GET') {
      if (showExternalMonero) {
        return json({ address: null, seedAvailable: false, external: true, externalAddress: DEMO_XMR_ADDRESS });
      }
      return json({ address: DEMO_XMR_ADDRESS, seedAvailable: true, external: false, externalAddress: null });
    }
    if (path === '/api/wallet/monero/balance') {
      return json({ balance: '12.482910000000', unlockedBalance: '11.982910000000' });
    }
    if (path === '/api/wallet/monero/reveal-seed' && method === 'POST') {
      return json({ words: DEMO_SEED_WORDS });
    }
    if (path === '/api/wallet/monero/send' && method === 'POST') {
      return json({ txHash: 'a1b2c3'.repeat(10).slice(0, 64), amountXmr: '1.000000000000', feeXmr: '0.000012340000' });
    }

    if (path === '/api/blockchain-import/status' && method === 'GET') {
      return json(importState);
    }
    if (path === '/api/blockchain-import/start' && method === 'POST') {
      if (!['idle', 'done', 'error'].includes(importState.status)) {
        return json({ error: 'An import is already in progress.' }, 409);
      }
      startDemoImport();
      return json({ started: true });
    }
    if (path === '/api/blockchain-import/reset' && method === 'POST') {
      importState = { status: 'idle', message: '', percent: null, startedAt: null, finishedAt: null, outputTail: [] };
      return json({ ok: true });
    }

    return realFetch(input, init);
  };
})();
