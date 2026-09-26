'use strict';

const REFRESH_MS = 15000;

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------
const tabButtons = document.querySelectorAll('nav.tabs button');
const tabPanels = {
  main: document.getElementById('tab-main'),
  pool: document.getElementById('tab-pool'),
  blocks: document.getElementById('tab-blocks'),
  logs: document.getElementById('tab-logs'),
  settings: document.getElementById('tab-settings'),
};

function showTab(name) {
  Object.entries(tabPanels).forEach(([key, el]) => {
    el.style.display = key === name ? '' : 'none';
  });
  tabButtons.forEach((btn) => btn.classList.toggle('active', btn.dataset.tab === name));
  if (name === 'logs') {
    startLogStreams();
  } else {
    stopLogStreams();
  }
  refreshActiveTab();
}

tabButtons.forEach((btn) => btn.addEventListener('click', () => showTab(btn.dataset.tab)));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
async function getJSON(url, opts) {
  const res = await fetch(url, opts);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Request failed (${res.status})`);
  }
  return res.json();
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

function showToast(msg) {
  const toast = document.getElementById('toast');
  toast.textContent = msg;
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), 3200);
}

document.body.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-copy]');
  if (!btn) return;
  const input = document.querySelector(btn.dataset.copy);
  if (!input) return;
  navigator.clipboard.writeText(input.value).then(() => showToast('Copied to clipboard'));
});

// ---------------------------------------------------------------------------
// Main tab
// ---------------------------------------------------------------------------
async function refreshMain() {
  let data;
  try {
    data = await getJSON('/api/status');
  } catch (err) {
    console.error(err);
    return;
  }

  const sync = data.sync || {};
  if (sync.error) {
    document.getElementById('main-sync-value').textContent = 'Node unreachable';
    document.getElementById('main-sync-sub').textContent = sync.error;
    document.getElementById('main-sync-bar').style.width = '0%';
  } else {
    const pct = sync.targetHeight ? Math.min(100, (sync.height / sync.targetHeight) * 100) : 0;
    document.getElementById('main-sync-value').textContent = sync.synchronized ? 'Synchronized' : 'Synchronizing…';
    document.getElementById('main-sync-sub').textContent = `Height ${sync.height ?? '—'} / ${sync.targetHeight ?? '—'} (${pct.toFixed(1)}%)`;
    document.getElementById('main-sync-bar').style.width = `${pct}%`;
  }

  document.getElementById('main-hashrate').textContent = fmtHashrate(data.hashrate?.hashrate1h);

  document.getElementById('main-diff').textContent = fmtDifficulty(data.difficulty?.bestShare);
  document.getElementById('main-diff-sub').textContent = `Network: ${fmtDifficulty(data.difficulty?.network)}`;

  const checklist = data.readiness || {};
  document.querySelectorAll('#main-checklist .status-dot').forEach((dot) => {
    const key = dot.dataset.check;
    dot.classList.toggle('ok', !!checklist[key]);
    dot.classList.toggle('bad', !checklist[key]);
  });

  // Sidebar summary (mirrors the main tab's key numbers)
  document.getElementById('sidebar-hashrate').textContent = fmtHashrate(data.hashrate?.hashrate1h);
  if (!sync.error) {
    const pct = sync.targetHeight ? Math.min(100, (sync.height / sync.targetHeight) * 100) : 0;
    document.getElementById('sidebar-sync-bar').style.width = `${pct}%`;
  } else {
    document.getElementById('sidebar-sync-bar').style.width = '0%';
  }
  const daemonBar = document.getElementById('sidebar-daemon-bar');
  const daemonLabel = document.getElementById('sidebar-daemon-label');
  if (checklist.stratumRunning) {
    daemonBar.style.width = '100%';
    daemonLabel.textContent = 'P2Pool is running';
  } else {
    daemonBar.style.width = '0%';
    daemonLabel.textContent = 'P2Pool is not running';
  }
}

// ---------------------------------------------------------------------------
// Pool tab
// ---------------------------------------------------------------------------
const poolModeSelect = document.getElementById('pool-mode-select');

async function refreshPool() {
  const mode = poolModeSelect.value;
  let data;
  try {
    data = await getJSON(`/api/pool?mode=${encodeURIComponent(mode)}`);
  } catch (err) {
    console.error(err);
    return;
  }

  document.getElementById('pool-mode-note').textContent = data.note || '';

  document.getElementById('pool-workers-count').textContent = data.workersConnected ?? '—';
  document.getElementById('pool-last-share').textContent = fmtTime(data.lastShareAt);

  document.getElementById('pool-net-diff').textContent = fmtDifficulty(data.network?.difficulty);
  document.getElementById('pool-net-sub').textContent = `RandomX · Height ${data.network?.height ?? '—'}`;

  const hr = data.hashrate || {};
  const row = document.getElementById('pool-hashrate-row');
  row.innerHTML = [hr.hashrate1m, hr.hashrate15m, null, hr.hashrate1h, hr.hashrate6h, hr.hashrate24h, hr.hashrate7d]
    .map((v, i) => (i === 2 ? `<td>${fmtHashrate(hr.hashrate15m)}</td>` : `<td>${fmtHashrate(v)}</td>`))
    .join('');
  // Note: columns are 1m/5m/15m/1h/6h/24h/7d per the spec; p2pool's local API
  // (see lib/p2poolApi.js) currently only reports 15m/1h/24h, the rest render as "—".

  document.getElementById('pool-best-since').textContent = fmtDifficulty(data.bestShare?.sinceBlock);
  document.getElementById('pool-best-alltime').textContent = fmtDifficulty(data.bestShare?.allTime);

  const workersBody = document.getElementById('pool-workers-body');
  if (data.workers && data.workers.length) {
    workersBody.innerHTML = data.workers
      .map((w) => `<tr><td>${escapeHtml(w.name)}</td><td>${w.shares}</td><td>${fmtTime(w.lastSeen)}</td></tr>`)
      .join('');
  } else {
    workersBody.innerHTML = '<tr><td colspan="3" class="empty-state">No workers connected yet.</td></tr>';
  }

  document.getElementById('pool-miner-url').value = data.minerConfig?.url || '—';
  document.getElementById('pool-payout-address').value = data.minerConfig?.payoutAddress || 'Not configured — set this in Settings';
}

poolModeSelect.addEventListener('change', refreshPool);

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------------------------------------------------------------------------
// Blocks tab
// ---------------------------------------------------------------------------
async function refreshBlocks() {
  let data;
  try {
    data = await getJSON('/api/blocks');
  } catch (err) {
    console.error(err);
    return;
  }

  const body = document.getElementById('blocks-body');
  if (data.blocks && data.blocks.length) {
    body.innerHTML = data.blocks
      .map(
        (b) => `<tr>
          <td>${b.height ?? '—'}</td>
          <td>${fmtTime(b.detectedAt)}</td>
          <td class="mono">${b.hash ? b.hash.slice(0, 16) + '…' : '—'}</td>
          <td>${b.explorerUrl ? `<a href="${b.explorerUrl}" target="_blank" rel="noopener">View on explorer</a>` : '—'}</td>
        </tr>`
      )
      .join('');
  } else {
    body.innerHTML = '<tr><td colspan="4" class="empty-state">No blocks found yet. This can take a long time depending on total P2Pool network hashrate — that\'s normal.</td></tr>';
  }

  const hint = document.getElementById('blocks-address-hint');
  const withAddr = (data.blocks || []).find((b) => b.addressExplorerUrl);
  hint.innerHTML = withAddr
    ? `Cross-check payouts to your address directly: <a href="${withAddr.addressExplorerUrl}" target="_blank" rel="noopener">view your address on ${data.explorerBaseUrl}</a>.`
    : 'Set a payout address in Settings to get a direct link for verifying payouts.';
}

// ---------------------------------------------------------------------------
// Logs tab - live tail via Server-Sent Events, like `tail -f` in a terminal.
// ---------------------------------------------------------------------------
const MAX_CLIENT_LOG_LINES = 500;
let logStreams = [];

function renderLogBox(el, result) {
  if (!result) return;
  if (result.error && (!result.lines || !result.lines.length)) {
    el.textContent = result.error;
    return;
  }
  el.textContent = result.lines.join('\n') || 'No log output yet.';
  el.scrollTop = el.scrollHeight;
}

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
    renderLogBox(el, result);
    el.dataset.hasContent = result.lines && result.lines.length ? '1' : '';
  });
  es.addEventListener('append', (e) => {
    appendLogLines(el, JSON.parse(e.data));
  });
  es.onerror = () => {
    // EventSource auto-reconnects on transient drops; nothing to do here.
  };
  return es;
}

function startLogStreams() {
  if (logStreams.length) return;
  logStreams = [
    openLogStream('monerod', document.getElementById('logs-monerod')),
    openLogStream('p2pool', document.getElementById('logs-p2pool')),
  ];
}

function stopLogStreams() {
  logStreams.forEach((es) => es.close());
  logStreams = [];
}

// ---------------------------------------------------------------------------
// Settings tab
// ---------------------------------------------------------------------------
async function loadSettings() {
  let data;
  try {
    data = await getJSON('/api/settings');
  } catch (err) {
    console.error(err);
    return;
  }
  document.getElementById('settings-wallet').value = data.walletAddress || '';
  document.getElementById('settings-pool-mode').value = data.poolMode || 'standard';
  poolModeSelect.value = data.poolMode || 'standard';
  setSidebarPoolMode(data.poolMode || 'standard');
}

function setSidebarPoolMode(mode) {
  const label = { standard: 'Standard', mini: 'Mini', nano: 'Nano' }[mode] || mode;
  document.getElementById('sidebar-pool-mode').textContent = label;
}

document.getElementById('settings-save').addEventListener('click', async () => {
  const status = document.getElementById('settings-status');
  const btn = document.getElementById('settings-save');
  btn.disabled = true;
  status.textContent = 'Saving…';
  status.classList.remove('warn');
  try {
    await getJSON('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        walletAddress: document.getElementById('settings-wallet').value.trim(),
        poolMode: document.getElementById('settings-pool-mode').value,
      }),
    });
    status.textContent = 'Saved. P2Pool will pick up the change within a few seconds.';
    showToast('Settings saved');
    setSidebarPoolMode(document.getElementById('settings-pool-mode').value);
  } catch (err) {
    status.textContent = err.message;
    status.classList.add('warn');
  } finally {
    btn.disabled = false;
  }
});

// ---------------------------------------------------------------------------
// Polling
// ---------------------------------------------------------------------------
function refreshActiveTab() {
  const active = document.querySelector('nav.tabs button.active')?.dataset.tab || 'main';
  if (active === 'main') refreshMain();
  if (active === 'pool') refreshPool();
  if (active === 'blocks') refreshBlocks();
  // 'logs' is excluded - it stays live via Server-Sent Events (see startLogStreams).
}

// ---------------------------------------------------------------------------
// Titlebar: theme toggle + explorer link
// ---------------------------------------------------------------------------
const THEME_KEY = 'p2pool-dashboard-theme';
function applyTheme(theme) {
  document.documentElement.classList.toggle('light', theme === 'light');
}
try {
  applyTheme(localStorage.getItem(THEME_KEY) || 'dark');
} catch (err) {
  applyTheme('dark');
}
document.getElementById('tb-theme').addEventListener('click', () => {
  const next = document.documentElement.classList.contains('light') ? 'dark' : 'light';
  applyTheme(next);
  try { localStorage.setItem(THEME_KEY, next); } catch (err) { /* ignore */ }
});

getJSON('/api/blocks')
  .then((data) => {
    if (data.explorerBaseUrl) document.getElementById('tb-explorer').href = data.explorerBaseUrl;
  })
  .catch(() => {});

loadSettings();
refreshActiveTab();
setInterval(refreshActiveTab, REFRESH_MS);
