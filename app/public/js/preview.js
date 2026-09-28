'use strict';

// Shared data-fetch/render logic for the UI redesign candidates (ui-v1/v2/v3
// .html). Each variant has totally different markup/CSS, but uses the same
// element IDs for anything data-driven, so one script drives all of them -
// every lookup is guarded so a variant that omits an element just skips it
// instead of throwing.

function setText(id, val) {
  const el = document.getElementById(id);
  if (!el) return;
  const str = String(val);
  if (el.textContent !== str && el.textContent !== '—' && el.dataset.pvInit) {
    el.classList.remove('pv-value-flash');
    void el.offsetWidth; // restart the animation if it's still running
    el.classList.add('pv-value-flash');
  }
  el.dataset.pvInit = '1';
  el.textContent = str;
}

function setWidth(id, pct) {
  const el = document.getElementById(id);
  if (el) el.style.width = `${pct}%`;
}

function toggleClass(id, cls, on) {
  const el = document.getElementById(id);
  if (el) el.classList.toggle(cls, !!on);
}

// Drives a .status-light dot: 'red' (offline/unreachable), 'orange'
// (starting up/syncing), 'green' (running and good). Passing null/undefined
// clears all state classes, leaving the light at its default muted gray -
// used for "not applicable" states like a disabled optional feature.
function setStatusLight(id, state) {
  const el = document.getElementById(id);
  if (!el) return;
  el.classList.remove('status-red', 'status-orange', 'status-green');
  if (state) el.classList.add(`status-${state}`);
}

const RING_CIRCUMFERENCE = 188.5; // 2 * PI * r, r=30 (see .pv-ring-fill / the SVG's r="30")
function setRing(fillId, labelId, pct, isGood, inProgressColor) {
  const fill = document.getElementById(fillId);
  const label = document.getElementById(labelId);
  const clamped = Math.max(0, Math.min(100, pct));
  if (fill) {
    fill.style.strokeDashoffset = String(RING_CIRCUMFERENCE * (1 - clamped / 100));
    fill.style.stroke = isGood ? '#4caf6a' : (inProgressColor || 'var(--orange)');
  }
  if (label) label.textContent = `${clamped.toFixed(0)}%`;
}

function fmtHashrate(h) {
  if (h === null || h === undefined) return '—';
  const units = ['H/s', 'KH/s', 'MH/s', 'GH/s'];
  let val = h;
  let i = 0;
  while (val >= 1000 && i < units.length - 1) {
    val /= 1000;
    i += 1;
  }
  return `${val.toFixed(2)} ${units[i]}`;
}

function fmtDifficulty(d) {
  if (d === null || d === undefined) return '—';
  return Number(d).toLocaleString();
}

function fmtTime(t) {
  if (!t) return '—';
  const d = new Date(t);
  if (Number.isNaN(d.getTime())) return String(t);
  return d.toLocaleString();
}

function fmtDuration(seconds) {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return '—';
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  if (days > 0) return `${days}d ${hours}h`;
  const minutes = Math.floor((seconds % 3600) / 60);
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

async function getJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Request failed (${res.status})`);
  return res.json();
}

// ---------------------------------------------------------------------------
// Rolling-history sparklines (Pool tab) - kept in-memory client-side only, no
// backend time-series storage. Resets on page reload; that's an accepted
// trade-off to avoid adding a database for two small graphs.
// ---------------------------------------------------------------------------
const MAX_SPARK_POINTS = 60; // 10 minutes at the 10s refresh interval
const sparkHistory = { hashrate: [], difficulty: [] };

function pushSparkPoint(key, value) {
  if (value === null || value === undefined || !Number.isFinite(value)) return;
  const arr = sparkHistory[key];
  arr.push(value);
  if (arr.length > MAX_SPARK_POINTS) arr.shift();
}

function renderSparkline(svgId, values) {
  const svg = document.getElementById(svgId);
  if (!svg) return;
  if (values.length < 2) {
    svg.innerHTML = '';
    return;
  }
  const [w, h] = [300, 70];
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const points = values.map((v, i) => {
    const x = (i / (values.length - 1)) * w;
    const y = h - ((v - min) / range) * (h - 6) - 3;
    return [x, y];
  });
  const lineD = points.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const fillD = `${lineD} L${w},${h} L0,${h} Z`;
  svg.innerHTML = `<path class="pv-spark-fill" d="${fillD}" /><path class="pv-spark-line" d="${lineD}" />`;
}

function renderMiningScene(xmrActive, xtmEnabled) {
  const xtmActive = xtmEnabled && xmrActive;
  ['xmr', 'xtm'].forEach((coin) => {
    const active = coin === 'xmr' ? xmrActive : xtmActive;
    toggleClass(`mining-half-${coin}`, 'is-active', active);
    toggleClass(`mining-half-${coin}`, 'is-idle', !active);
    toggleClass(`embedded-coin-${coin}`, 'is-active', active);
    toggleClass(`logo-glow-${coin}`, 'is-active', active);
  });
  setText('mining-xmr-state', xmrActive ? 'Mining' : 'Idle');
  toggleClass('mining-xmr-state', 'state-xmr-active', xmrActive);
  setText('mining-xtm-state', xtmEnabled ? (xtmActive ? 'Merge mining' : 'Waiting on XMR mining') : 'Not configured');
  toggleClass('mining-xtm-state', 'state-xtm-active', xtmActive);
  toggleClass('mining-combined', 'any-active', xmrActive || xtmActive);
}

async function refreshAll() {
  let status = null;
  let pool = null;
  let blocksData = null;
  let settings = null;
  try {
    [status, pool, blocksData, settings] = await Promise.all([
      getJSON('/api/status'),
      getJSON('/api/pool'),
      getJSON('/api/blocks'),
      getJSON('/api/settings'),
    ]);
  } catch (err) {
    console.error('[preview] refresh failed', err);
    return;
  }

  const sync = status.sync || {};
  const node = status.node || {};
  if (sync.error) {
    setText('pv-bc-title', 'Unreachable');
    setText('pv-bc-sub', sync.error);
    setRing('pv-bc-ring', 'pv-bc-ring-label', 0, false);
    setStatusLight('pv-bc-status-dot', 'red');
  } else {
    const pct = sync.targetHeight ? Math.min(100, (sync.height / sync.targetHeight) * 100) : 0;
    setText('pv-bc-title', sync.synchronized ? `Synchronized ${pct.toFixed(0)}%` : `Syncing ${pct.toFixed(0)}%`);
    setText('pv-bc-sub', node.version ? `Monero ${node.version}${node.nettype ? ` · ${node.nettype}` : ''}` : '—');
    setRing('pv-bc-ring', 'pv-bc-ring-label', pct, sync.synchronized);
    setText('pv-bc-height', sync.height ?? '—');
    setText('pv-bc-target', sync.targetHeight ?? '—');
    setStatusLight('pv-bc-status-dot', sync.synchronized ? 'green' : 'orange');
  }
  setText('pv-bc-peers', node.connectionsIn != null ? `${node.connectionsIn} / ${node.connectionsOut ?? '—'}` : '—');
  setText('pv-bc-txpool', node.txPoolSize != null ? `${node.txPoolSize} txs` : '—');

  const p2poolRunning = !!status.p2pool?.running;
  setText('pv-p2p-sub', p2poolRunning ? `${status.p2pool?.connections ?? 0} connections · Port ${(pool.minerConfig?.url || '').split(':').pop() || '—'}` : 'Not running');
  const p2pPill = document.getElementById('pv-p2p-pill');
  if (p2pPill) {
    p2pPill.textContent = p2poolRunning ? 'Open' : 'Closed';
    p2pPill.classList.toggle('good', p2poolRunning);
    p2pPill.classList.toggle('bad', !p2poolRunning);
  }
  setText('pv-p2p-workers', pool.workersConnected ?? '—');
  setText('pv-p2p-hashrate', fmtHashrate(status.hashrate?.hashrate1h));
  setText('pv-p2p-diff', fmtDifficulty(pool.network?.difficulty));
  setText('pv-p2p-eta', fmtDuration(pool.network?.etaSeconds));

  const checks = [
    { key: 'nodeRpc', label: 'Node RPC', good: 'Synced', bad: 'Unreachable', desc: 'Node RPC is online and synchronized.', badDesc: 'Node RPC is not reachable yet.' },
    { key: 'blockchainSynced', label: 'Blockchain Sync', good: 'Synchronized', bad: 'Syncing', desc: 'Chain is synchronized and ready for pool traffic.', badDesc: 'Still catching up to the network tip.' },
    { key: 'payoutAddressConfigured', label: 'Payout Address', good: 'Configured', bad: 'Missing', desc: 'Block rewards have a payout target.', badDesc: 'Set a wallet address in Settings.' },
    { key: 'stratumRunning', label: 'Stratum', good: 'Open', bad: 'Closed', desc: 'Remote miners can connect.', badDesc: 'P2Pool is not running yet.' },
  ];
  // Each port gets its own stacked row with a status light (red = closed,
  // green = open) rather than being a card among the general checks above.
  // The Tari row only appears once Tari merge-mining is actually configured
  // (a wallet address is set) - before that there's no real port to check,
  // and showing a permanently-green light for a feature that's off would be
  // misleading rather than reassuring.
  const portChecks = [
    { key: 'moneroPortOpen', label: 'Monero P2P Port', good: 'Open (Ready)', bad: 'Closed', desc: 'Accepting inbound peer connections - port 18080 is forwarded correctly.', badDesc: 'No inbound peer connections yet - forward port 18080 on your router.' },
    { key: 'p2poolPortOpen', label: 'P2Pool P2P Port', good: 'Open (Ready)', bad: 'Closed', desc: 'Accepting inbound sidechain peer connections - your P2Pool port is forwarded correctly.', badDesc: 'No inbound P2Pool peers yet - forward your P2Pool p2p port on your router.' },
    ...(settings.tariAddress
      ? [{ key: 'minotariPortOpen', label: 'Tari P2P Port', good: 'Open (Ready)', bad: 'Closed', desc: 'Accepting inbound peer connections - port 18189 is forwarded correctly.', badDesc: 'No inbound peer connections yet - forward port 18189 on your router.' }]
      : []),
  ];
  const allChecks = [...checks, ...portChecks];
  const readiness = status.readiness || {};
  const readyCount = allChecks.filter((c) => readiness[c.key]).length;
  const checkGrid = document.getElementById('pv-check-grid');
  if (checkGrid) {
    checkGrid.innerHTML = checks
      .map((c) => {
        // Blockchain Sync gets a three-way state instead of just good/bad -
        // "not running" (monerod unreachable) is a different problem than
        // "still syncing" (monerod is up, just not caught up yet), and
        // collapsing both into one red "Syncing" was misleading.
        if (c.key === 'blockchainSynced') {
          const nodeUp = !!readiness.nodeRpc;
          const synced = !!readiness.blockchainSynced;
          const cls = !nodeUp ? 'bad' : (synced ? 'good' : 'warn');
          const text = !nodeUp ? 'Not Running' : (synced ? 'Synced' : 'Syncing');
          const desc = !nodeUp
            ? 'monerod is not reachable yet.'
            : (synced ? 'Chain is synchronized and ready for pool traffic.' : 'Still catching up to the network tip.');
          return `<div class="pv-check-item">
            <div class="pv-check-head"><span class="pv-check-label">${c.label}</span></div>
            <div class="pv-check-status ${cls}">${text}</div>
            <div class="pv-check-desc">${desc}</div>
          </div>`;
        }
        const ok = !!readiness[c.key];
        return `<div class="pv-check-item">
          <div class="pv-check-head"><span class="pv-check-label">${c.label}</span></div>
          <div class="pv-check-status ${ok ? 'good' : 'bad'}">${ok ? c.good : c.bad}</div>
          <div class="pv-check-desc">${ok ? c.desc : c.badDesc}</div>
        </div>`;
      })
      .join('');
  }

  // P2Pool only ever listens on ONE p2p port at a time - whichever matches
  // the active Pool Type (see docker/p2pool/entrypoint.sh's --mini/--nano
  // case block). The other two are expected to be closed, not a problem to
  // fix, so they get a neutral "not in use" light instead of a false-alarm
  // red one. This is display-only - only the active mode's port counts
  // toward the readiness check above (there's only one p2poolPortOpen key).
  const P2POOL_PORTS = {
    standard: { name: 'Standard', port: 37889 },
    mini: { name: 'Mini', port: 37888 },
    nano: { name: 'Nano', port: 37890 },
  };
  const activePoolMode = P2POOL_PORTS[settings.poolMode] ? settings.poolMode : 'standard';
  const p2poolOk = !!readiness.p2poolPortOpen;
  const p2poolRows = Object.entries(P2POOL_PORTS).map(([mode, info]) => {
    if (mode !== activePoolMode) {
      return {
        light: null,
        label: `P2Pool P2P Port (${info.name})`,
        statusClass: '',
        statusText: 'Not in use',
        desc: `Pool Type is set to ${P2POOL_PORTS[activePoolMode].name} - this port isn't being listened on.`,
      };
    }
    return {
      light: p2poolOk ? 'status-green' : 'status-red',
      label: `P2Pool P2P Port (${info.name})`,
      statusClass: p2poolOk ? 'good' : 'bad',
      statusText: p2poolOk ? 'Open (Ready)' : 'Closed',
      desc: p2poolOk
        ? `Accepting inbound sidechain peer connections - port ${info.port} is forwarded correctly.`
        : `No inbound P2Pool peers yet - forward port ${info.port} on your router.`,
    };
  });

  const portList = document.getElementById('pv-port-list');
  if (portList) {
    const otherRows = portChecks
      .filter((c) => c.key !== 'p2poolPortOpen')
      .map((c) => {
        const ok = !!readiness[c.key];
        return {
          light: ok ? 'status-green' : 'status-red',
          label: c.label,
          statusClass: ok ? 'good' : 'bad',
          statusText: ok ? c.good : c.bad,
          desc: ok ? c.desc : c.badDesc,
        };
      });
    // Monero's port row first, then the 3 P2Pool port rows together, then
    // Tari (if configured) - keeps the stack grouped by what it's checking.
    const rows = [otherRows[0], ...p2poolRows, ...otherRows.slice(1)].filter(Boolean);
    portList.innerHTML = rows
      .map(
        (r) => `<div class="pv-port-row">
          <span class="status-light ${r.light || ''}"></span>
          <span class="pv-port-label">${r.label}</span>
          <span class="pv-port-status-text ${r.statusClass}">${r.statusText}</span>
          <span class="pv-port-desc">${r.desc}</span>
        </div>`
      )
      .join('');
  }
  const readyPill = document.getElementById('pv-ready-pill');
  if (readyPill) {
    readyPill.textContent = `${readyCount}/${allChecks.length} checks ready`;
    readyPill.classList.toggle('good', readyCount === allChecks.length);
    readyPill.classList.toggle('bad', readyCount < allChecks.length);
  }
  setText(
    'pv-ready-summary',
    readyCount === allChecks.length
      ? 'Node, pool, and Stratum are all ready.'
      : `${allChecks.length - readyCount} of ${allChecks.length} checks still need attention - see below.`
  );

  setText('pv-workers-count', pool.workersConnected ?? '—');
  setText('pv-net-diff', fmtDifficulty(pool.network?.difficulty));
  setText('pv-net-height', pool.network?.height ?? '—');
  setText('pv-net-miners', pool.network?.minersOnSidechain ?? '—');
  setText('pv-net-shares', fmtDifficulty(pool.network?.sidechainSharesFound));
  setText('pv-net-blocks', pool.network?.totalBlocksFound ?? '—');
  setText('pv-net-reward', pool.network?.reward != null ? `${(pool.network.reward / 1e12).toFixed(6)} XMR` : '—');
  setText('pv-net-eta', fmtDuration(pool.network?.etaSeconds));
  setText('pv-pool-mode', { standard: 'Standard', mini: 'Mini', nano: 'Nano' }[settings.poolMode] || settings.poolMode);
  setText('pv-header-mode', { standard: 'Standard', mini: 'Mini', nano: 'Nano' }[settings.poolMode] || settings.poolMode);

  const headerStatus = document.getElementById('pv-header-status');
  if (headerStatus) {
    const allReady = readyCount === allChecks.length;
    headerStatus.textContent = allReady ? 'Running' : (readyCount > 0 ? 'Starting' : 'Offline');
    headerStatus.classList.toggle('good', allReady);
    headerStatus.classList.toggle('bad', !allReady && readyCount === 0);
  }
  setText('pv-miner-url', pool.minerConfig?.url || '—');
  setText('pv-payout-address', settings.walletAddress || 'Not configured');
  setText('pv-worker-login', pool.minerConfig?.exampleWorkerLogin || 'Set a payout address in Settings first');

  pushSparkPoint('hashrate', pool.hashrate?.hashrate1h);
  pushSparkPoint('difficulty', pool.network?.difficulty);
  renderSparkline('pv-graph-hashrate', sparkHistory.hashrate);
  renderSparkline('pv-graph-difficulty', sparkHistory.difficulty);

  const tari = status.tari || {};
  setText('pv-tari-status', tari.enabled ? (status.p2pool?.running ? 'Merge mining' : 'Waiting on XMR mining') : 'Not configured');
  setText('pv-tari-blocks', tari.blocksFound ?? 0);
  const nodeSync = tari.nodeSync;
  if (!nodeSync) {
    setText('pv-minotari-label', 'Not running');
    setWidth('pv-minotari-bar', 0);
    setText('pv-tari-bc-title', tari.enabled ? 'Not running' : 'Not configured');
    setText('pv-tari-bc-sub', '—');
    setRing('pv-tari-bc-ring', 'pv-tari-bc-ring-label', 0, false, 'var(--tari)');
    // Not configured is a deliberate, non-error state (Tari merge-mining is
    // optional) - leave the light at its neutral default rather than red,
    // same reasoning as minotariPortOpen always reading "good" in that case.
    setStatusLight('pv-tari-bc-status-dot', tari.enabled ? 'red' : null);
  } else {
    const pct = nodeSync.targetHeight ? Math.min(100, (nodeSync.height / nodeSync.targetHeight) * 100) : 0;
    setText('pv-minotari-label', nodeSync.synchronized ? 'Synchronized' : 'Synchronizing');
    setWidth('pv-minotari-bar', pct);
    setText('pv-tari-bc-title', nodeSync.synchronized ? `Synchronized ${pct.toFixed(0)}%` : `Syncing ${pct.toFixed(0)}%`);
    setText('pv-tari-bc-sub', 'Minotari Node · mainnet');
    setRing('pv-tari-bc-ring', 'pv-tari-bc-ring-label', pct, nodeSync.synchronized, 'var(--tari)');
    setText('pv-tari-bc-height', nodeSync.height ?? '—');
    setText('pv-tari-bc-target', nodeSync.targetHeight ?? '—');
    setStatusLight('pv-tari-bc-status-dot', nodeSync.synchronized ? 'green' : 'orange');
  }

  const blocksBody = document.getElementById('pv-blocks-body');
  if (blocksBody) {
    const list = (blocksData.blocks || []).slice(0, 6);
    blocksBody.innerHTML = list.length
      ? list
          .map(
            (b) => `<tr><td>${b.height ?? '—'}</td><td>${fmtTime(b.detectedAt)}</td><td class="mono">${
              b.hash ? b.hash.slice(0, 12) + '…' : '—'
            }</td></tr>`
          )
          .join('')
      : '<tr><td colspan="3" class="pv-empty">No blocks found yet — normal, this can take a while.</td></tr>';
  }

  // Hash rate pill row (1m/15m/1h/6h/24h/7d - see lib/p2poolApi.js for which
  // columns p2pool's local API actually reports today; others render "—").
  const hr = pool.hashrate || {};
  setText('pv-hr-main', fmtHashrate(hr.hashrate1h));
  const HR_PILL_COLORS = ['var(--orange)', 'var(--tari)', '#4a9eff', '#ffb020', '#4caf6a', '#b98ce0'];
  const hrPeriods = [
    ['1m', hr.hashrate1m], ['15m', hr.hashrate15m], ['1h', hr.hashrate1h],
    ['6h', hr.hashrate6h], ['24h', hr.hashrate24h], ['7d', hr.hashrate7d],
  ];
  const hrPills = document.getElementById('pv-hr-pills');
  if (hrPills) {
    hrPills.innerHTML = hrPeriods
      .map(
        ([label, val], i) =>
          `<span class="pv-hr-pill" style="background:${HR_PILL_COLORS[i]}"><span class="pv-hr-pill-period">${label}</span>${fmtHashrate(val)}</span>`
      )
      .join('');
  }

  setText('pv-net-diff-main', fmtDifficulty(pool.network?.difficulty));
  setText('pv-net-diff-sub', `RandomX · Height ${pool.network?.height ?? '—'}`);
  setText('pv-pool-connect-url', `stratum+tcp://${pool.minerConfig?.url || '—'}`);
  setText('pv-last-share', fmtTime(pool.lastShareAt));

  setText('pv-best-since', fmtDifficulty(pool.bestShare?.sinceBlock));
  setText('pv-best-alltime', fmtDifficulty(pool.bestShare?.allTime));

  // Worker Details - each worker gets a card with a ring showing how close
  // their single best share has gotten to the real network difficulty
  // (bestDifficultyPercent, see server.js) - the more "filled in" the ring,
  // the closer that worker came to actually finding a block. A small home
  // miner sitting near 0% is expected, not a bug.
  const WORKER_RING_CIRCUMFERENCE = 138.2; // 2 * PI * r, r=22
  const workersGrid = document.getElementById('pv-workers-grid');
  if (workersGrid) {
    workersGrid.innerHTML = (pool.workers || []).length
      ? pool.workers
          .map((w) => {
            const sharePct = w.sharePercent ?? 0;
            const diffPct = Math.max(0, Math.min(100, w.bestDifficultyPercent ?? 0));
            const dotIdx = w.name.lastIndexOf('.');
            const address = dotIdx > 0 ? w.name.slice(0, dotIdx) : null;
            const label = dotIdx > 0 ? w.name.slice(dotIdx + 1) : w.name;
            const shortAddress = address && address.length > 20 ? `${address.slice(0, 10)}…${address.slice(-6)}` : address;
            const ringOffset = WORKER_RING_CIRCUMFERENCE * (1 - diffPct / 100);
            return `<div class="pv-worker-card">
              <div class="pv-worker-info">
                <div class="pv-worker-name">${escapeHtml(label)}</div>
                ${shortAddress ? `<div class="pv-worker-address">${escapeHtml(shortAddress)}</div>` : ''}
                <div class="pv-worker-meta">
                  <span class="pv-worker-meta-item"><strong>${w.shares}</strong> shares</span>
                  <span class="pv-worker-meta-item">Last seen <strong>${fmtTime(w.lastSeen)}</strong></span>
                  <span class="pv-worker-meta-item">${sharePct.toFixed(1)}% of your total shares</span>
                </div>
                <div class="pv-worker-share-bar-track"><div class="pv-worker-share-bar-fill" style="width:${sharePct.toFixed(1)}%"></div></div>
              </div>
              <div class="pv-worker-ring" title="Best share difficulty vs current network difficulty">
                <svg viewBox="0 0 56 56">
                  <circle class="pv-worker-ring-track" cx="28" cy="28" r="22" />
                  <circle class="pv-worker-ring-fill" cx="28" cy="28" r="22" style="stroke-dasharray:${WORKER_RING_CIRCUMFERENCE};stroke-dashoffset:${ringOffset}" />
                </svg>
                <div class="pv-worker-ring-label">${diffPct >= 1 ? diffPct.toFixed(0) : diffPct.toFixed(2)}%<br>diff</div>
              </div>
            </div>`;
          })
          .join('')
      : '<div class="pv-empty">No workers connected yet.</div>';
  }

  // Tari payout address + XTM blocks table
  setText('pv-tari-address', pool.tari?.payoutAddress || '—');
  let tariBlocksData = null;
  try {
    tariBlocksData = await getJSON('/api/blocks?coin=xtm');
  } catch (err) { /* non-fatal */ }
  const tariBlocksBody = document.getElementById('pv-tari-blocks-body');
  if (tariBlocksBody && tariBlocksData) {
    tariBlocksBody.innerHTML = (tariBlocksData.blocks || []).length
      ? tariBlocksData.blocks
          .map((b) => `<tr><td>${b.height ?? '—'}</td><td>${fmtTime(b.detectedAt)}</td><td class="mono" style="font-size:11px">${escapeHtml(b.raw || '—')}</td></tr>`)
          .join('')
      : '<tr><td colspan="3" class="pv-empty">No XTM blocks found yet, or Tari merge-mining isn\'t configured.</td></tr>';
  }

  // Optional P2Pool Observer card (see lib/p2poolObserver.js) - only shown
  // when the user opted in from Settings. When it's hidden (the default),
  // Worker Details would otherwise sit alone in a half-width row with empty
  // space next to it - expand it to full width in that case instead.
  const observerCard = document.getElementById('pv-observer-card');
  const workerDetailsCard = document.getElementById('pv-worker-details-card');
  if (observerCard) {
    const observer = pool.observer;
    const showObserver = !!(observer && !observer.error);
    observerCard.style.display = showObserver ? '' : 'none';
    if (workerDetailsCard) {
      workerDetailsCard.classList.toggle('v1-half', showObserver);
      workerDetailsCard.classList.toggle('v1-full', !showObserver);
    }
    if (showObserver) {
      setText('pv-observer-miners', observer.globalMiners ?? '—');
      setText('pv-observer-shares', observer.yourShares?.totalShares ?? '—');
      setText('pv-observer-last-share', observer.yourShares?.lastShareAt ? fmtTime(observer.yourShares.lastShareAt) : '—');
      setText('pv-observer-versions', `P2Pool ${observer.p2poolVersion || '—'} · Monero ${observer.moneroVersion || '—'}`);
      const link = document.getElementById('pv-observer-link');
      if (link) link.href = observer.explorerUrl || '#';
    }
  }

  renderMiningScene(!!status.p2pool?.running, !!tari.enabled);
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------------------------------------------------------------------------
// Settings (load once, save on click) - present only on variants that include
// the settings form; every lookup is guarded so others just skip this.
// ---------------------------------------------------------------------------
async function loadSettingsForm() {
  const walletEl = document.getElementById('pv-settings-wallet');
  if (!walletEl) return; // this variant has no settings form
  let data;
  try {
    data = await getJSON('/api/settings');
  } catch (err) {
    return;
  }
  walletEl.value = data.walletAddress || '';
  const poolModeEl = document.getElementById('pv-settings-pool-mode');
  if (poolModeEl) poolModeEl.value = data.poolMode || 'standard';
  const tariEl = document.getElementById('pv-settings-tari-address');
  if (tariEl) tariEl.value = data.tariAddress || '';
  const observerEl = document.getElementById('pv-settings-observer-enabled');
  if (observerEl) observerEl.checked = !!data.observerEnabled;
  const logsTabEl = document.getElementById('pv-settings-logs-tab-enabled');
  if (logsTabEl) logsTabEl.checked = data.logsTabEnabled !== false;
  applyLogsTabVisibility(data.logsTabEnabled !== false);
  const lightModeEl = document.getElementById('pv-settings-p2pool-light-mode');
  if (lightModeEl) lightModeEl.checked = !!data.p2poolLightMode;
  const noRandomxEl = document.getElementById('pv-settings-p2pool-no-randomx');
  if (noRandomxEl) noRandomxEl.checked = !!data.p2poolNoRandomx;
  const noCacheEl = document.getElementById('pv-settings-p2pool-no-cache');
  if (noCacheEl) noCacheEl.checked = !!data.p2poolNoCache;
  const importEnabledEl = document.getElementById('pv-settings-import-enabled');
  if (importEnabledEl) importEnabledEl.checked = !!data.importBlockchainEnabled;
  applyImportSectionVisibility(!!data.importBlockchainEnabled);
  const discordWebhookEl = document.getElementById('pv-settings-discord-webhook');
  if (discordWebhookEl) discordWebhookEl.value = data.discordWebhookUrl || '';
  const discordXmrEl = document.getElementById('pv-settings-discord-notify-xmr');
  if (discordXmrEl) discordXmrEl.checked = data.discordNotifyXmrBlocks !== false;
  const discordXtmEl = document.getElementById('pv-settings-discord-notify-xtm');
  if (discordXtmEl) discordXtmEl.checked = data.discordNotifyXtmBlocks !== false;
  const discordSharesEl = document.getElementById('pv-settings-discord-notify-shares');
  if (discordSharesEl) discordSharesEl.checked = !!data.discordNotifyShares;
}

// Shows/hides the whole Import Blockchain panel based on the hidden
// importBlockchainEnabled setting - this isn't just cosmetic, the backend
// refuses every /api/blockchain-import/* route unless it's actually saved
// as true, so a hidden panel accurately reflects what will/won't work.
function applyImportSectionVisibility(enabled) {
  const panel = document.getElementById('pv-import-panel');
  if (panel) panel.style.display = enabled ? '' : 'none';
}

// Hides the Logs tab button entirely (not just its content) when disabled in
// Settings, and switches away from it first if it's the currently active tab.
function applyLogsTabVisibility(enabled) {
  const logsBtn = document.querySelector('[data-tabbtn="logs"]');
  if (!logsBtn) return;
  logsBtn.style.display = enabled ? '' : 'none';
  const logsOption = document.querySelector('#pv-tab-select option[value="logs"]');
  if (logsOption) logsOption.disabled = !enabled;
  const activeViaSelect = document.getElementById('pv-tab-select')?.value === 'logs';
  if (!enabled && (logsBtn.classList.contains('active') || activeViaSelect)) {
    document.querySelector('[data-tabbtn="overview"]')?.click();
  }
}

function wireSettingsSave() {
  const btn = document.getElementById('pv-settings-save');
  if (!btn) return;
  btn.addEventListener('click', async () => {
    const status = document.getElementById('pv-settings-status');
    btn.disabled = true;
    if (status) status.textContent = 'Saving…';
    try {
      const res = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          walletAddress: document.getElementById('pv-settings-wallet').value.trim(),
          poolMode: document.getElementById('pv-settings-pool-mode')?.value,
          tariAddress: document.getElementById('pv-settings-tari-address')?.value.trim() || '',
          observerEnabled: !!document.getElementById('pv-settings-observer-enabled')?.checked,
          logsTabEnabled: !!document.getElementById('pv-settings-logs-tab-enabled')?.checked,
          p2poolLightMode: !!document.getElementById('pv-settings-p2pool-light-mode')?.checked,
          p2poolNoRandomx: !!document.getElementById('pv-settings-p2pool-no-randomx')?.checked,
          p2poolNoCache: !!document.getElementById('pv-settings-p2pool-no-cache')?.checked,
          importBlockchainEnabled: !!document.getElementById('pv-settings-import-enabled')?.checked,
          discordWebhookUrl: document.getElementById('pv-settings-discord-webhook')?.value.trim() || '',
          discordNotifyXmrBlocks: !!document.getElementById('pv-settings-discord-notify-xmr')?.checked,
          discordNotifyXtmBlocks: !!document.getElementById('pv-settings-discord-notify-xtm')?.checked,
          discordNotifyShares: !!document.getElementById('pv-settings-discord-notify-shares')?.checked,
        }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || 'Save failed');
      if (status) status.textContent = 'Saved. P2Pool will pick up the change within a few seconds.';
      applyLogsTabVisibility(!!document.getElementById('pv-settings-logs-tab-enabled')?.checked);
      applyImportSectionVisibility(!!document.getElementById('pv-settings-import-enabled')?.checked);
      refreshAll();
    } catch (err) {
      if (status) status.textContent = err.message;
    } finally {
      btn.disabled = false;
    }
  });
}

// Settings tab's "Send Test Notification" button - tests whatever URL is
// currently typed in the field, even if it hasn't been saved yet.
function wireDiscordTest() {
  const btn = document.getElementById('pv-discord-test');
  const status = document.getElementById('pv-discord-test-status');
  if (!btn) return;
  btn.addEventListener('click', async () => {
    const webhookUrl = document.getElementById('pv-settings-discord-webhook')?.value.trim() || '';
    btn.disabled = true;
    if (status) status.textContent = 'Sending...';
    try {
      const res = await fetch('/api/discord/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ webhookUrl }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || 'Failed to send test notification');
      if (status) status.textContent = 'Sent - check your Discord channel.';
    } catch (err) {
      if (status) status.textContent = err.message;
    } finally {
      btn.disabled = false;
    }
  });
}

// ---------------------------------------------------------------------------
// Copy-to-clipboard buttons (data-copy="#some-input")
// ---------------------------------------------------------------------------
document.body.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-copy]');
  if (!btn) return;
  const input = document.querySelector(btn.dataset.copy);
  if (!input) return;
  navigator.clipboard.writeText(input.value).then(
    () => {
      const original = btn.textContent;
      btn.textContent = 'Copied!';
      setTimeout(() => { btn.textContent = original; }, 1500);
    },
    () => { /* clipboard permission denied - nothing useful to do */ }
  );
});

// ---------------------------------------------------------------------------
// Logs - live tail via Server-Sent Events, present only on variants with a
// logs section.
// ---------------------------------------------------------------------------
const MAX_CLIENT_LOG_LINES = 500;

function appendLogLines(el, lines) {
  const wasAtBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 4;
  const isPlaceholder = !el.dataset.hasContent;
  const existing = isPlaceholder ? [] : el.textContent.split('\n');
  const combined = existing.concat(lines).slice(-MAX_CLIENT_LOG_LINES);
  el.textContent = combined.join('\n');
  el.dataset.hasContent = '1';
  if (wasAtBottom) el.scrollTop = el.scrollHeight;
}

function openLogStream(source, el) {
  el.dataset.hasContent = '';
  const es = new EventSource(`/api/logs/stream?source=${encodeURIComponent(source)}`);
  es.addEventListener('init', (e) => {
    const result = JSON.parse(e.data);
    if (result.error && (!result.lines || !result.lines.length)) {
      el.textContent = result.error;
      return;
    }
    el.textContent = (result.lines || []).join('\n') || 'No log output yet.';
    el.dataset.hasContent = result.lines && result.lines.length ? '1' : '';
    el.scrollTop = el.scrollHeight;
  });
  es.addEventListener('append', (e) => appendLogLines(el, JSON.parse(e.data)));
  return es;
}

function startLogStreamsIfPresent() {
  const monerod = document.getElementById('pv-logs-monerod');
  if (!monerod) return; // this variant has no logs section
  openLogStream('monerod', monerod);
  openLogStream('p2pool', document.getElementById('pv-logs-p2pool'));
  openLogStream('minotari', document.getElementById('pv-logs-minotari'));
}

// ---------------------------------------------------------------------------
// Theme (light/dark) + color palette toggles - present only on variants with
// these titlebar buttons.
// ---------------------------------------------------------------------------
function wireThemeControls() {
  // Each control has a header copy (desktop) and a Settings-tab copy
  // (always present, primary on mobile where the header ones are hidden via
  // CSS) - both ids are wired to the same state so either one works.
  const themeBtns = ['tb-theme', 'pv-settings-theme'].map((id) => document.getElementById(id)).filter(Boolean);
  if (themeBtns.length) {
    const THEME_KEY = 'p2pool-dashboard-theme';
    const applyTheme = (theme) => document.documentElement.classList.toggle('light', theme === 'light');
    try { applyTheme(localStorage.getItem(THEME_KEY) || 'dark'); } catch (err) { applyTheme('dark'); }
    themeBtns.forEach((btn) => btn.addEventListener('click', () => {
      const next = document.documentElement.classList.contains('light') ? 'dark' : 'light';
      applyTheme(next);
      try { localStorage.setItem(THEME_KEY, next); } catch (err) { /* ignore */ }
    }));
  }

  const paletteBtns = ['tb-palette', 'pv-settings-palette'].map((id) => document.getElementById(id)).filter(Boolean);
  if (paletteBtns.length) {
    const PALETTE_KEY = 'p2pool-dashboard-palette';
    const PALETTES = [
      { id: 'classic', label: 'Monero Classic' },
      { id: 'tari', label: 'Tari Nebula' },
      { id: 'molten', label: 'Molten Cave' },
    ];
    let current = 'classic';
    const apply = (id) => {
      if (id === 'classic') document.documentElement.removeAttribute('data-theme');
      else document.documentElement.setAttribute('data-theme', id);
      const label = `Color theme: ${PALETTES.find((p) => p.id === id)?.label || id} (click to cycle)`;
      paletteBtns.forEach((btn) => { btn.title = label; });
    };
    try { current = localStorage.getItem(PALETTE_KEY) || 'classic'; } catch (err) { /* ignore */ }
    apply(current);
    paletteBtns.forEach((btn) => btn.addEventListener('click', () => {
      const idx = PALETTES.findIndex((p) => p.id === current);
      current = PALETTES[(idx + 1) % PALETTES.length].id;
      apply(current);
      try { localStorage.setItem(PALETTE_KEY, current); } catch (err) { /* ignore */ }
    }));
  }

  const explorerLinks = ['tb-explorer', 'pv-settings-explorer'].map((id) => document.getElementById(id)).filter(Boolean);
  if (explorerLinks.length) {
    getJSON('/api/blocks').then((data) => {
      if (data.explorerBaseUrl) explorerLinks.forEach((a) => { a.href = data.explorerBaseUrl; });
    }).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Tabs (data-tabbtn / data-tabpanel) - present only on variants that split
// content into tabs; others just skip this.
// ---------------------------------------------------------------------------
function wireTabs() {
  const buttons = document.querySelectorAll('[data-tabbtn]');
  if (!buttons.length) return;
  const panels = document.querySelectorAll('[data-tabpanel]');
  const select = document.getElementById('pv-tab-select');
  function show(name) {
    panels.forEach((p) => { p.style.display = p.dataset.tabpanel === name ? '' : 'none'; });
    buttons.forEach((b) => b.classList.toggle('active', b.dataset.tabbtn === name));
    if (select && select.value !== name) select.value = name;
  }
  buttons.forEach((b) => b.addEventListener('click', () => show(b.dataset.tabbtn)));
  if (select) select.addEventListener('change', () => show(select.value));
}

// ---------------------------------------------------------------------------
// Wallet tab - address display + one-time seed-phrase reveal, one config
// per coin. Present only on variants that include these elements.
// ---------------------------------------------------------------------------
const MASKED_ADDRESS = '•••• •••• •••• ••••';

const WALLET_COINS = [
  {
    apiBase: '/api/wallet/tari',
    unit: 'XTM',
    settingsField: 'tariAddress',
    useLabel: 'Saved as your Tari merge-mining address.',
    // Renders GET .../balance's { availableBalance, pendingIncoming, pendingOutgoing }.
    renderBalance(data) {
      setText('pv-wallet-tari-balance-available', `${data.availableBalance} XTM`);
      setText('pv-wallet-tari-balance-pending-in', `${data.pendingIncoming} XTM`);
      setText('pv-wallet-tari-balance-pending-out', `${data.pendingOutgoing} XTM`);
      setText('pv-wallet-tari-card-balance', `${data.availableBalance} XTM`);
    },
    cardAddressId: 'pv-wallet-tari-card-address',
    cardToggleId: 'pv-wallet-tari-card-toggle',
    // Renders the successful POST .../send result { transactionId, amountXtm, feePerGram }.
    sendResultText(result) {
      return `Sent ${result.amountXtm} XTM. Transaction ID: ${result.transactionId} (fee rate used: ${result.feePerGram} µT/gram).`;
    },
    ids: {
      address: 'pv-wallet-tari-address',
      addressField: 'pv-wallet-tari-address-field',
      createBtn: 'pv-wallet-tari-create',
      createStatus: 'pv-wallet-tari-create-status',
      useBtn: 'pv-wallet-tari-use',
      useStatus: 'pv-wallet-tari-use-status',
      step1: 'pv-wallet-reveal-step1',
      confirm: 'pv-wallet-reveal-confirm',
      step2: 'pv-wallet-reveal-step2',
      cancel: 'pv-wallet-reveal-cancel',
      grid: 'pv-wallet-seed-grid',
      intro: 'pv-wallet-seed-intro',
      sendAddress: 'pv-wallet-tari-send-address',
      sendAmount: 'pv-wallet-tari-send-amount',
      sendStep1: 'pv-wallet-tari-send-step1',
      sendConfirm: 'pv-wallet-tari-send-confirm',
      sendConfirmText: 'pv-wallet-tari-send-confirm-text',
      sendStep2: 'pv-wallet-tari-send-step2',
      sendCancel: 'pv-wallet-tari-send-cancel',
      sendStatus: 'pv-wallet-tari-send-status',
    },
  },
  {
    apiBase: '/api/wallet/monero',
    unit: 'XMR',
    settingsField: 'walletAddress',
    useLabel: 'Saved as your Monero payout address.',
    // Renders GET .../balance's { balance, unlockedBalance } (both XMR decimal strings).
    renderBalance(data) {
      setText('pv-wallet-xmr-balance-available', `${data.unlockedBalance} XMR`);
      setText('pv-wallet-xmr-balance-total', `${data.balance} XMR`);
      setText('pv-wallet-xmr-card-balance', `${data.unlockedBalance} XMR`);
    },
    cardAddressId: 'pv-wallet-xmr-card-address',
    cardToggleId: 'pv-wallet-xmr-card-toggle',
    // Renders the successful POST .../send result { txHash, amountXmr, feeXmr }.
    sendResultText(result) {
      return `Sent ${result.amountXmr} XMR (fee ${result.feeXmr} XMR). Tx hash: ${result.txHash}`;
    },
    ids: {
      address: 'pv-wallet-xmr-address',
      addressField: 'pv-wallet-xmr-address-field',
      createBtn: 'pv-wallet-xmr-create',
      createStatus: 'pv-wallet-xmr-create-status',
      useBtn: 'pv-wallet-xmr-use',
      useStatus: 'pv-wallet-xmr-use-status',
      step1: 'pv-wallet-xmr-reveal-step1',
      confirm: 'pv-wallet-xmr-reveal-confirm',
      step2: 'pv-wallet-xmr-reveal-step2',
      cancel: 'pv-wallet-xmr-reveal-cancel',
      grid: 'pv-wallet-xmr-seed-grid',
      sendAddress: 'pv-wallet-xmr-send-address',
      sendAmount: 'pv-wallet-xmr-send-amount',
      sendStep1: 'pv-wallet-xmr-send-step1',
      sendConfirm: 'pv-wallet-xmr-send-confirm',
      sendConfirmText: 'pv-wallet-xmr-send-confirm-text',
      sendStep2: 'pv-wallet-xmr-send-step2',
      sendCancel: 'pv-wallet-xmr-send-cancel',
      sendStatus: 'pv-wallet-xmr-send-status',
      intro: 'pv-wallet-xmr-seed-intro',
    },
  },
];

async function refreshWalletTab() {
  for (const coin of WALLET_COINS) {
    const addressEl = document.getElementById(coin.ids.address);
    if (!addressEl) continue; // this variant has no such wallet section
    let data;
    try {
      data = await getJSON(coin.apiBase);
    } catch (err) {
      continue;
    }
    addressEl.value = data.address || 'Wallet not reachable yet';

    // No wallet exists yet (as opposed to "exists but RPC is unreachable") -
    // show the Create Wallet button instead of the address/use-address UI.
    const createBtn = document.getElementById(coin.ids.createBtn);
    const addressField = document.getElementById(coin.ids.addressField);
    const useBtn = document.getElementById(coin.ids.useBtn);
    if (createBtn && addressField && useBtn) {
      const hasWallet = !!data.address;
      createBtn.style.display = hasWallet ? 'none' : '';
      addressField.style.display = hasWallet ? '' : 'none';
      useBtn.style.display = hasWallet ? '' : 'none';
    }

    if (coin.cardAddressId) {
      const cardAddressEl = document.getElementById(coin.cardAddressId);
      if (cardAddressEl) {
        cardAddressEl.dataset.fullAddress = data.address || '';
        // Don't clobber the masked/revealed state on every poll - only set
        // the initial text once, when the element has no state yet.
        if (cardAddressEl.dataset.revealed === undefined) {
          cardAddressEl.dataset.revealed = 'false';
          cardAddressEl.textContent = data.address ? MASKED_ADDRESS : '—';
        } else if (cardAddressEl.dataset.revealed === 'true') {
          cardAddressEl.textContent = data.address || '—';
        }
      }
    }
    const revealBtn = document.getElementById(coin.ids.step1);
    const intro = document.getElementById(coin.ids.intro);
    if (revealBtn && !data.seedAvailable) {
      revealBtn.style.display = 'none';
      if (intro) intro.textContent = 'No seed backup is available - it was already revealed once, or this wallet was restored from an existing seed rather than freshly created.';
    }

    if (document.getElementById(coin.ids.sendAddress)) {
      try {
        const balance = await getJSON(`${coin.apiBase}/balance`);
        coin.renderBalance(balance);
      } catch (err) {
        // Wallet balance not reachable yet - leave the "—" placeholders.
      }
    }
  }
}

function wireWalletTab() {
  for (const coin of WALLET_COINS) {
    const createBtn = document.getElementById(coin.ids.createBtn);
    if (createBtn) {
      createBtn.addEventListener('click', async () => {
        const status = document.getElementById(coin.ids.createStatus);
        createBtn.disabled = true;
        if (status) status.textContent = 'Creating wallet...';
        try {
          const res = await fetch(`${coin.apiBase}/create`, { method: 'POST' });
          const body = await res.json();
          if (!res.ok) throw new Error(body.error || 'Failed to create wallet');
          if (status) status.textContent = 'Wallet creation requested - it may take a few seconds to appear.';
          refreshWalletTab();
        } catch (err) {
          if (status) status.textContent = err.message;
        } finally {
          createBtn.disabled = false;
        }
      });
    }

    const useBtn = document.getElementById(coin.ids.useBtn);
    if (useBtn) {
      useBtn.addEventListener('click', async () => {
        const status = document.getElementById(coin.ids.useStatus);
        const address = document.getElementById(coin.ids.address).value;
        if (!address || address === 'Wallet not reachable yet') return;
        try {
          await fetch('/api/settings', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ [coin.settingsField]: address }),
          });
          if (status) status.textContent = coin.useLabel;
          refreshAll();
        } catch (err) {
          if (status) status.textContent = 'Failed to save - try again.';
        }
      });
    }

    const step1 = document.getElementById(coin.ids.step1);
    const confirmBox = document.getElementById(coin.ids.confirm);
    const step2 = document.getElementById(coin.ids.step2);
    const cancelBtn = document.getElementById(coin.ids.cancel);
    if (step1 && confirmBox && step2 && cancelBtn) {
      step1.addEventListener('click', () => {
        step1.style.display = 'none';
        confirmBox.style.display = '';
      });
      cancelBtn.addEventListener('click', () => {
        confirmBox.style.display = 'none';
        step1.style.display = '';
      });
      step2.addEventListener('click', async () => {
        step2.disabled = true;
        try {
          const res = await fetch(`${coin.apiBase}/reveal-seed`, { method: 'POST' });
          const body = await res.json();
          if (!res.ok) throw new Error(body.error || 'Reveal failed');
          const grid = document.getElementById(coin.ids.grid);
          grid.innerHTML = body.words.map((w, i) => `<span style="display:inline-block;width:110px;">${i + 1}. ${escapeHtml(w)}</span>`).join('');
          grid.style.display = '';
          confirmBox.style.display = 'none';
        } catch (err) {
          confirmBox.querySelector('.hint').textContent = err.message;
          step2.disabled = false;
        }
      });
    }

    wireWalletSend(coin);
    wireWalletCardToggle(coin);
  }
}

// Show/hide toggle for the wallet card's address - masked by default
// (MASKED_ADDRESS), full address on click. The full value came from the
// wallet's own API response (stored in the element's dataset by
// refreshWalletTab), never re-fetched here.
function wireWalletCardToggle(coin) {
  const toggle = document.getElementById(coin.cardToggleId);
  const addressEl = document.getElementById(coin.cardAddressId);
  if (!toggle || !addressEl) return;
  toggle.addEventListener('click', () => {
    const revealed = addressEl.dataset.revealed === 'true';
    const next = !revealed;
    addressEl.dataset.revealed = String(next);
    const full = addressEl.dataset.fullAddress || '';
    addressEl.textContent = next ? (full || '—') : (full ? MASKED_ADDRESS : '—');
    toggle.title = next ? 'Hide address' : 'Show address';
  });
}

// Two-step confirm for sending funds - deliberately no "estimate fee first"
// round trip (Tari's Transfer RPC doesn't expose one, and adding a Monero
// do_not_relay/relay two-phase flow just for this would be a lot of added
// complexity for a home dashboard). The address and amount are shown back to
// the user in the confirmation step so there's still a real chance to catch
// a typo before anything irreversible happens.
function wireWalletSend(coin) {
  const addressInput = document.getElementById(coin.ids.sendAddress);
  const amountInput = document.getElementById(coin.ids.sendAmount);
  const step1 = document.getElementById(coin.ids.sendStep1);
  const confirmBox = document.getElementById(coin.ids.sendConfirm);
  const confirmText = document.getElementById(coin.ids.sendConfirmText);
  const step2 = document.getElementById(coin.ids.sendStep2);
  const cancelBtn = document.getElementById(coin.ids.sendCancel);
  const status = document.getElementById(coin.ids.sendStatus);
  if (!addressInput || !step1 || !confirmBox || !step2 || !cancelBtn) return;

  step1.addEventListener('click', () => {
    const address = addressInput.value.trim();
    const amount = amountInput.value.trim();
    if (status) status.textContent = '';
    if (!address || !amount) {
      if (status) status.textContent = 'Enter a recipient address and an amount first.';
      return;
    }
    confirmText.textContent = `Send ${amount} ${coin.unit} to ${address}? This cannot be undone.`;
    step1.style.display = 'none';
    confirmBox.style.display = '';
  });

  cancelBtn.addEventListener('click', () => {
    confirmBox.style.display = 'none';
    step1.style.display = '';
  });

  step2.addEventListener('click', async () => {
    step2.disabled = true;
    const address = addressInput.value.trim();
    const amount = amountInput.value.trim();
    try {
      const res = await fetch(`${coin.apiBase}/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ address, amount }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || 'Send failed');
      if (status) status.textContent = coin.sendResultText(body);
      addressInput.value = '';
      amountInput.value = '';
      confirmBox.style.display = 'none';
      step1.style.display = '';
      refreshWalletTab();
    } catch (err) {
      if (status) status.textContent = err.message;
    } finally {
      step2.disabled = false;
    }
  });
}

// ---------------------------------------------------------------------------
// Import Blockchain (Settings tab, hidden until enabled) - two-step confirm
// like the wallet Send/Reveal flows, then polls /status while the backend
// stops monerod, copies, fixes ownership, and restarts it.
// ---------------------------------------------------------------------------
let importPollTimer = null;

function wireImportForm() {
  const authSelect = document.getElementById('pv-import-auth-method');
  const keyField = document.getElementById('pv-import-key-field');
  const passwordField = document.getElementById('pv-import-password-field');
  if (authSelect) {
    authSelect.addEventListener('change', () => {
      const isKey = authSelect.value === 'key';
      if (keyField) keyField.style.display = isKey ? '' : 'none';
      if (passwordField) passwordField.style.display = isKey ? 'none' : '';
    });
  }

  const step1 = document.getElementById('pv-import-step1');
  const confirmBox = document.getElementById('pv-import-confirm');
  const confirmText = document.getElementById('pv-import-confirm-text');
  const step2 = document.getElementById('pv-import-step2');
  const cancelBtn = document.getElementById('pv-import-cancel');
  const status = document.getElementById('pv-import-status');
  if (!step1 || !confirmBox || !step2 || !cancelBtn) return;

  step1.addEventListener('click', () => {
    const host = document.getElementById('pv-import-host').value.trim();
    const remotePath = document.getElementById('pv-import-remote-path').value.trim();
    if (status) status.textContent = '';
    if (!host || !remotePath) {
      if (status) status.textContent = 'Enter a host and remote path first.';
      return;
    }
    confirmText.textContent = `This will stop monerod, copy ${remotePath} from ${host} into place, then restart monerod. Continue?`;
    step1.style.display = 'none';
    confirmBox.style.display = '';
  });

  cancelBtn.addEventListener('click', () => {
    confirmBox.style.display = 'none';
    step1.style.display = '';
  });

  step2.addEventListener('click', async () => {
    step2.disabled = true;
    const payload = importFormPayload({ remotePath: document.getElementById('pv-import-remote-path').value.trim() });
    try {
      const res = await fetch('/api/blockchain-import/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || 'Failed to start import');
      // Clear credential fields from the DOM immediately - they've been sent,
      // no reason to leave them sitting in an input.
      document.getElementById('pv-import-private-key').value = '';
      document.getElementById('pv-import-password').value = '';
      confirmBox.style.display = 'none';
      startImportPolling();
    } catch (err) {
      if (status) status.textContent = err.message;
      step2.disabled = false;
    }
  });
}

function startImportPolling() {
  const progress = document.getElementById('pv-import-progress');
  const message = document.getElementById('pv-import-progress-message');
  const bar = document.getElementById('pv-import-progress-bar');
  const step1 = document.getElementById('pv-import-step1');
  const status = document.getElementById('pv-import-status');
  if (progress) progress.style.display = '';
  if (step1) step1.style.display = 'none';
  if (importPollTimer) clearInterval(importPollTimer);

  const poll = async () => {
    let data;
    try {
      data = await getJSON('/api/blockchain-import/status');
    } catch (err) {
      return; // transient - try again next tick
    }
    if (message) message.textContent = data.message || data.status;
    if (bar) bar.style.width = `${data.percent ?? (data.status === 'idle' ? 0 : 10)}%`;
    if (data.status === 'done' || data.status === 'error') {
      clearInterval(importPollTimer);
      importPollTimer = null;
      if (status) status.textContent = data.status === 'error' ? `Import failed: ${data.message}` : data.message;
      if (step1) {
        step1.style.display = '';
        step1.disabled = false;
      }
      const step2 = document.getElementById('pv-import-step2');
      if (step2) step2.disabled = false;
      refreshWalletTab();
      refreshAll();
    }
  };
  poll();
  importPollTimer = setInterval(poll, 3000);
}

// In case a page reload happens mid-import, resume polling if one's already
// running server-side rather than showing a stale "Start Import" button.
async function resumeImportPollingIfActive() {
  const panel = document.getElementById('pv-import-panel');
  if (!panel) return;
  try {
    const data = await getJSON('/api/blockchain-import/status');
    if (data.status && !['idle', 'done', 'error'].includes(data.status)) {
      startImportPolling();
    }
  } catch {
    // import feature not enabled/reachable - nothing to resume
  }
}

// ---------------------------------------------------------------------------
// Remote folder browser (Import Blockchain's "Browse..." button) - a real
// listing of the OTHER machine's folders over SFTP (see
// /api/blockchain-import/browse), since a native browser file picker could
// only ever show files from whatever machine is running the browser.
// ---------------------------------------------------------------------------
let browseCurrentPath = '';

function importFormPayload(extra) {
  const authMethod = document.getElementById('pv-import-auth-method').value;
  const payload = {
    host: document.getElementById('pv-import-host').value.trim(),
    port: document.getElementById('pv-import-port').value.trim() || '22',
    username: document.getElementById('pv-import-username').value.trim(),
    authMethod,
    ...extra,
  };
  if (authMethod === 'key') {
    payload.privateKey = document.getElementById('pv-import-private-key').value;
  } else {
    payload.password = document.getElementById('pv-import-password').value;
  }
  return payload;
}

async function browseFetch(remotePath) {
  const status = document.getElementById('pv-browse-status');
  const list = document.getElementById('pv-browse-list');
  if (status) status.textContent = 'Loading…';
  try {
    const res = await fetch('/api/blockchain-import/browse', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(importFormPayload({ remotePath })),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || 'Failed to browse');
    browseCurrentPath = body.path;
    renderBrowseList(body.path, body.entries);
    if (status) status.textContent = '';
  } catch (err) {
    if (status) status.textContent = err.message;
    if (list) list.innerHTML = '';
  }
}

function renderBrowseList(path, entries) {
  const pathEl = document.getElementById('pv-browse-current-path');
  if (pathEl) pathEl.textContent = path;
  const list = document.getElementById('pv-browse-list');
  if (!list) return;

  const rows = [];
  const trimmed = path.replace(/\/+$/, '');
  if (trimmed && trimmed !== '') {
    const parent = trimmed.split('/').slice(0, -1).join('/') || '/';
    rows.push({ label: '.. (up one level)', path: parent });
  }
  entries.filter((e) => e.isDirectory).forEach((e) => {
    rows.push({ label: `${e.name}/`, path: `${trimmed}/${e.name}` });
  });

  if (rows.length === 0) {
    list.innerHTML = '<div class="hint" style="padding:8px;">No subfolders here.</div>';
    return;
  }
  list.innerHTML = rows
    .map((r, i) => `<div class="pv-browse-item" data-idx="${i}">${escapeHtml(r.label)}</div>`)
    .join('');
  list.querySelectorAll('.pv-browse-item').forEach((el, i) => {
    el.addEventListener('click', () => browseFetch(rows[i].path));
  });
}

function wireBrowseModal() {
  const browseBtn = document.getElementById('pv-import-browse-btn');
  const modal = document.getElementById('pv-browse-modal');
  const cancelBtn = document.getElementById('pv-browse-cancel');
  const selectBtn = document.getElementById('pv-browse-select');
  if (!browseBtn || !modal || !cancelBtn || !selectBtn) return;

  browseBtn.addEventListener('click', () => {
    const host = document.getElementById('pv-import-host').value.trim();
    const username = document.getElementById('pv-import-username').value.trim();
    const status = document.getElementById('pv-import-status');
    if (!host || !username) {
      if (status) status.textContent = 'Enter Host and Username first, then Browse.';
      return;
    }
    modal.style.display = 'flex';
    document.getElementById('pv-browse-list').innerHTML = '';
    browseFetch(document.getElementById('pv-import-remote-path').value.trim());
  });

  cancelBtn.addEventListener('click', () => {
    modal.style.display = 'none';
  });

  selectBtn.addEventListener('click', () => {
    if (browseCurrentPath) {
      document.getElementById('pv-import-remote-path').value = browseCurrentPath;
    }
    modal.style.display = 'none';
  });
}

// ---------------------------------------------------------------------------
// Wallet tab - "Recover Wallet" (restore from seed phrase). Monero's restore
// is a single RPC call (see server.js's /api/wallet/monero/recover); Tari's
// needs the wallet container restarted with the seed words, so it polls a
// status endpoint the same way Import Blockchain does above.
// ---------------------------------------------------------------------------
function wireMoneroRecovery() {
  const step1 = document.getElementById('pv-wallet-xmr-recover-step1');
  const form = document.getElementById('pv-wallet-xmr-recover-form');
  const seedInput = document.getElementById('pv-wallet-xmr-recover-seed');
  const heightInput = document.getElementById('pv-wallet-xmr-recover-height');
  const step2 = document.getElementById('pv-wallet-xmr-recover-step2');
  const cancelBtn = document.getElementById('pv-wallet-xmr-recover-cancel');
  const status = document.getElementById('pv-wallet-xmr-recover-status');
  if (!step1 || !form || !step2 || !cancelBtn) return;

  step1.addEventListener('click', () => {
    step1.style.display = 'none';
    form.style.display = '';
  });
  cancelBtn.addEventListener('click', () => {
    form.style.display = 'none';
    step1.style.display = '';
    if (status) status.textContent = '';
  });
  step2.addEventListener('click', async () => {
    const seedWords = seedInput.value.trim();
    if (!seedWords) {
      if (status) status.textContent = 'Enter the seed phrase first.';
      return;
    }
    const heightRaw = heightInput.value.trim();
    step2.disabled = true;
    if (status) status.textContent = 'Restoring wallet...';
    try {
      const res = await fetch('/api/wallet/monero/recover', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ seedWords, restoreHeight: heightRaw ? Number(heightRaw) : 0 }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || 'Recovery failed');
      seedInput.value = '';
      heightInput.value = '';
      if (status) status.textContent = `Wallet recovered. New address: ${body.address}`;
      form.style.display = 'none';
      step1.style.display = '';
      refreshWalletTab();
    } catch (err) {
      if (status) status.textContent = err.message;
    } finally {
      step2.disabled = false;
    }
  });
}

let tariRecoveryPollTimer = null;

function pollTariRecoveryStatus() {
  clearTimeout(tariRecoveryPollTimer);
  const step1 = document.getElementById('pv-wallet-tari-recover-step1');
  const progress = document.getElementById('pv-wallet-tari-recover-progress');
  const progressMessage = document.getElementById('pv-wallet-tari-recover-progress-message');
  const status = document.getElementById('pv-wallet-tari-recover-status');
  if (!step1) return;
  tariRecoveryPollTimer = setTimeout(async () => {
    let state;
    try {
      state = await getJSON('/api/wallet/tari/recover/status');
    } catch (err) {
      pollTariRecoveryStatus();
      return;
    }
    if (progressMessage) progressMessage.textContent = state.message || state.status;
    if (state.status === 'done' || state.status === 'error') {
      if (progress) progress.style.display = 'none';
      step1.style.display = '';
      if (status) status.textContent = state.message;
      if (state.status === 'done') refreshWalletTab();
      return;
    }
    pollTariRecoveryStatus();
  }, 2500);
}

function wireTariRecovery() {
  const step1 = document.getElementById('pv-wallet-tari-recover-step1');
  const form = document.getElementById('pv-wallet-tari-recover-form');
  const seedInput = document.getElementById('pv-wallet-tari-recover-seed');
  const step2 = document.getElementById('pv-wallet-tari-recover-step2');
  const cancelBtn = document.getElementById('pv-wallet-tari-recover-cancel');
  const status = document.getElementById('pv-wallet-tari-recover-status');
  const progress = document.getElementById('pv-wallet-tari-recover-progress');
  if (!step1 || !form || !step2 || !cancelBtn) return;

  step1.addEventListener('click', () => {
    step1.style.display = 'none';
    form.style.display = '';
  });
  cancelBtn.addEventListener('click', () => {
    form.style.display = 'none';
    step1.style.display = '';
    if (status) status.textContent = '';
  });
  step2.addEventListener('click', async () => {
    const seedWords = seedInput.value.trim();
    if (!seedWords) {
      if (status) status.textContent = 'Enter the seed phrase first.';
      return;
    }
    step2.disabled = true;
    if (status) status.textContent = '';
    try {
      const res = await fetch('/api/wallet/tari/recover', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ seedWords }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || 'Recovery failed to start');
      seedInput.value = '';
      form.style.display = 'none';
      if (progress) progress.style.display = '';
      pollTariRecoveryStatus();
    } catch (err) {
      if (status) status.textContent = err.message;
    } finally {
      step2.disabled = false;
    }
  });
}

// If a recovery was already in progress server-side when the page loads
// (e.g. the page was refreshed mid-recovery), pick the poll loop back up -
// same idea as resumeImportPollingIfActive.
async function resumeTariRecoveryPollingIfActive() {
  const progress = document.getElementById('pv-wallet-tari-recover-progress');
  const form = document.getElementById('pv-wallet-tari-recover-form');
  const step1 = document.getElementById('pv-wallet-tari-recover-step1');
  if (!progress) return;
  let state;
  try {
    state = await getJSON('/api/wallet/tari/recover/status');
  } catch (err) {
    return;
  }
  if (['idle', 'done', 'error'].includes(state.status)) return;
  if (form) form.style.display = 'none';
  if (step1) step1.style.display = 'none';
  progress.style.display = '';
  const progressMessage = document.getElementById('pv-wallet-tari-recover-progress-message');
  if (progressMessage) progressMessage.textContent = state.message || state.status;
  pollTariRecoveryStatus();
}

// ---------------------------------------------------------------------------
// Settings tab - "Which Pool Type Should I Use?" hashrate checker. Pre-fills
// from THIS node's own locally tracked miner hashrate (p2pool's local
// stratum-api, same source the Pool tab's Hash Rate stat uses) - never an
// external/live pull. The brackets themselves are the same rule-of-thumb
// numbers shown in the table above, not a live calculation.
// ---------------------------------------------------------------------------
const POOL_ADVISOR_NANO_MAX_HS = 5000;
const POOL_ADVISOR_MINI_MAX_HS = 40000;

function poolAdvisorRecommend(hashrateHs) {
  if (hashrateHs < POOL_ADVISOR_NANO_MAX_HS) return 'nano';
  if (hashrateHs < POOL_ADVISOR_MINI_MAX_HS) return 'mini';
  return 'standard';
}

const POOL_MODE_LABELS = { standard: 'Standard (Main Chain)', mini: 'Mini', nano: 'Nano' };

async function wirePoolAdvisor() {
  const hashrateInput = document.getElementById('pv-pool-advisor-hashrate');
  const unitSelect = document.getElementById('pv-pool-advisor-unit');
  const checkBtn = document.getElementById('pv-pool-advisor-check');
  const hint = document.getElementById('pv-pool-advisor-hint');
  const result = document.getElementById('pv-pool-advisor-result');
  if (!hashrateInput || !unitSelect || !checkBtn) return;

  try {
    const status = await getJSON('/api/status');
    const hs = status.hashrate?.hashrate1h ?? status.hashrate?.hashrate15m;
    if (hs) {
      // Pick whichever unit keeps the prefilled number readable (1-3 digits).
      let unit = 1;
      if (hs >= 1000000) unit = 1000000;
      else if (hs >= 1000) unit = 1000;
      hashrateInput.value = (hs / unit).toFixed(unit === 1 ? 0 : 2);
      unitSelect.value = String(unit);
      if (hint) hint.textContent = `Auto-filled from this node's own combined miner hashrate (${fmtHashrate(hs)}, last hour). Override it to check a different number.`;
    }
  } catch (err) {
    // No local hashrate available yet - leave the field blank for manual entry.
  }

  checkBtn.addEventListener('click', () => {
    const raw = Number(hashrateInput.value);
    if (!raw || raw <= 0) {
      if (result) result.textContent = 'Enter a hashrate first.';
      return;
    }
    const hashrateHs = raw * Number(unitSelect.value);
    const recommended = poolAdvisorRecommend(hashrateHs);
    const current = document.getElementById('pv-settings-pool-mode')?.value || 'standard';
    if (result) {
      result.textContent = recommended === current
        ? `At ${fmtHashrate(hashrateHs)}, ${POOL_MODE_LABELS[current]} is already a good fit.`
        : `At ${fmtHashrate(hashrateHs)}, ${POOL_MODE_LABELS[recommended]} is likely a better fit than your current ${POOL_MODE_LABELS[current]} setting - this is a rule of thumb, not a hard rule.`;
    }
  });
}

wireTabs();
wireWalletTab();
wireThemeControls();
wireSettingsSave();
wireImportForm();
wireBrowseModal();
wireMoneroRecovery();
wireTariRecovery();
wirePoolAdvisor();
wireDiscordTest();
loadSettingsForm();
resumeImportPollingIfActive();
resumeTariRecoveryPollingIfActive();
startLogStreamsIfPresent();
refreshAll();
refreshWalletTab();
setInterval(refreshAll, 10000);
setInterval(refreshWalletTab, 15000);
