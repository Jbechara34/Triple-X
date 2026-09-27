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
  } else {
    const pct = sync.targetHeight ? Math.min(100, (sync.height / sync.targetHeight) * 100) : 0;
    setText('pv-bc-title', sync.synchronized ? `Synchronized ${pct.toFixed(0)}%` : `Syncing ${pct.toFixed(0)}%`);
    setText('pv-bc-sub', node.version ? `Monero ${node.version}${node.nettype ? ` · ${node.nettype}` : ''}` : '—');
    setRing('pv-bc-ring', 'pv-bc-ring-label', pct, sync.synchronized);
    setText('pv-bc-height', sync.height ?? '—');
    setText('pv-bc-target', sync.targetHeight ?? '—');
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
    { key: 'moneroPortOpen', label: 'Monero P2P Port', good: 'Open (Ready)', bad: 'Closed', desc: 'Accepting inbound peer connections - port 18080 is forwarded correctly.', badDesc: 'No inbound peer connections yet - forward port 18080 on your router.' },
    { key: 'p2poolPortOpen', label: 'P2Pool P2P Port', good: 'Open (Ready)', bad: 'Closed', desc: 'Accepting inbound sidechain peer connections - your P2Pool port is forwarded correctly.', badDesc: 'No inbound P2Pool peers yet - forward your P2Pool p2p port (37889 Standard / 37888 Mini / 37890 Nano) on your router.' },
    { key: 'minotariPortOpen', label: 'Tari P2P Port', good: 'Open (Ready)', bad: 'Closed', desc: 'Accepting inbound peer connections - port 18189 is forwarded correctly (or Tari merge-mining is off).', badDesc: 'No inbound peer connections yet - forward port 18189 on your router.' },
  ];
  const readiness = status.readiness || {};
  const readyCount = checks.filter((c) => readiness[c.key]).length;
  const checkGrid = document.getElementById('pv-check-grid');
  if (checkGrid) {
    checkGrid.innerHTML = checks
      .map((c) => {
        const ok = !!readiness[c.key];
        return `<div class="pv-check-item">
          <div class="pv-check-head"><span class="pv-check-label">${c.label}</span></div>
          <div class="pv-check-status ${ok ? 'good' : 'bad'}">${ok ? c.good : c.bad}</div>
          <div class="pv-check-desc">${ok ? c.desc : c.badDesc}</div>
        </div>`;
      })
      .join('');
  }
  const readyPill = document.getElementById('pv-ready-pill');
  if (readyPill) {
    readyPill.textContent = `${readyCount}/${checks.length} checks ready`;
    readyPill.classList.toggle('good', readyCount === checks.length);
    readyPill.classList.toggle('bad', readyCount < checks.length);
  }
  setText(
    'pv-ready-summary',
    readyCount === checks.length
      ? 'Node, pool, and Stratum are all ready.'
      : `${checks.length - readyCount} of ${checks.length} checks still need attention - see below.`
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
    const allReady = readyCount === checks.length;
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
  } else {
    const pct = nodeSync.targetHeight ? Math.min(100, (nodeSync.height / nodeSync.targetHeight) * 100) : 0;
    setText('pv-minotari-label', nodeSync.synchronized ? 'Synchronized' : 'Synchronizing');
    setWidth('pv-minotari-bar', pct);
    setText('pv-tari-bc-title', nodeSync.synchronized ? `Synchronized ${pct.toFixed(0)}%` : `Syncing ${pct.toFixed(0)}%`);
    setText('pv-tari-bc-sub', 'Minotari Node · mainnet');
    setRing('pv-tari-bc-ring', 'pv-tari-bc-ring-label', pct, nodeSync.synchronized, 'var(--tari)');
    setText('pv-tari-bc-height', nodeSync.height ?? '—');
    setText('pv-tari-bc-target', nodeSync.targetHeight ?? '—');
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
        }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || 'Save failed');
      if (status) status.textContent = 'Saved. P2Pool will pick up the change within a few seconds.';
      applyLogsTabVisibility(!!document.getElementById('pv-settings-logs-tab-enabled')?.checked);
      refreshAll();
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

wireTabs();
wireWalletTab();
wireThemeControls();
wireSettingsSave();
loadSettingsForm();
startLogStreamsIfPresent();
refreshAll();
refreshWalletTab();
setInterval(refreshAll, 10000);
setInterval(refreshWalletTab, 15000);
