'use strict';

// Shared data-fetch/render logic for the UI redesign candidates (ui-v1/v2/v3
// .html). Each variant has totally different markup/CSS, but uses the same
// element IDs for anything data-driven, so one script drives all of them -
// every lookup is guarded so a variant that omits an element just skips it
// instead of throwing.

function setText(id, val) {
  const el = document.getElementById(id);
  if (el) el.textContent = val;
}

function setWidth(id, pct) {
  const el = document.getElementById(id);
  if (el) el.style.width = `${pct}%`;
}

function toggleClass(id, cls, on) {
  const el = document.getElementById(id);
  if (el) el.classList.toggle(cls, !!on);
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

async function getJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Request failed (${res.status})`);
  return res.json();
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
  if (sync.error) {
    setText('pv-sync-value', 'Node unreachable');
    setText('pv-sync-sub', sync.error);
    setWidth('pv-sync-bar', 0);
  } else {
    const pct = sync.targetHeight ? Math.min(100, (sync.height / sync.targetHeight) * 100) : 0;
    setText('pv-sync-value', sync.synchronized ? 'Synchronized' : 'Synchronizing…');
    setText('pv-sync-sub', `Height ${sync.height ?? '—'} / ${sync.targetHeight ?? '—'} (${pct.toFixed(1)}%)`);
    setWidth('pv-sync-bar', pct);
  }

  setText('pv-hashrate', fmtHashrate(status.hashrate?.hashrate1h));
  setText('pv-diff', fmtDifficulty(status.difficulty?.bestShare));
  setText('pv-diff-sub', `Network: ${fmtDifficulty(status.difficulty?.network)}`);

  const node = status.node || {};
  setText('pv-peers-out', node.connectionsOut ?? '—');
  setText('pv-peers-in', node.connectionsIn ?? '—');
  setText('pv-peers-sub', node.whitePeers != null ? `${node.whitePeers} known peers` : '—');
  setText('pv-node-version', node.version ? `Monero ${node.version}${node.nettype ? ` · ${node.nettype}` : ''}` : '—');

  setText('pv-p2pool-connections', status.p2pool?.connections ?? '—');
  setText('pv-shares-found', status.p2pool?.sharesFound ?? '—');
  setText('pv-shares-failed', status.p2pool?.sharesFailed ?? '—');

  setText('pv-workers-count', pool.workersConnected ?? '—');
  setText('pv-net-diff', fmtDifficulty(pool.network?.difficulty));
  setText('pv-net-height', pool.network?.height ?? '—');
  setText('pv-net-miners', pool.network?.minersOnSidechain ?? '—');
  setText('pv-net-blocks', pool.network?.totalBlocksFound ?? '—');
  setText('pv-net-reward', pool.network?.reward != null ? `${(pool.network.reward / 1e12).toFixed(6)} XMR` : '—');
  setText('pv-pool-mode', { standard: 'Standard', mini: 'Mini', nano: 'Nano' }[settings.poolMode] || settings.poolMode);
  setText('pv-miner-url', pool.minerConfig?.url || '—');
  setText('pv-payout-address', settings.walletAddress || 'Not configured');

  const tari = status.tari || {};
  setText('pv-tari-status', tari.enabled ? (status.p2pool?.running ? 'Merge mining' : 'Waiting on XMR mining') : 'Not configured');
  setText('pv-tari-blocks', tari.blocksFound ?? 0);
  const nodeSync = tari.nodeSync;
  if (!nodeSync) {
    setText('pv-minotari-label', 'Not running');
    setWidth('pv-minotari-bar', 0);
  } else {
    const pct = nodeSync.targetHeight ? Math.min(100, (nodeSync.height / nodeSync.targetHeight) * 100) : 0;
    setText('pv-minotari-label', nodeSync.synchronized ? 'Synchronized' : 'Synchronizing');
    setWidth('pv-minotari-bar', pct);
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

  renderMiningScene(!!status.p2pool?.running, !!tari.enabled);
}

refreshAll();
setInterval(refreshAll, 10000);
