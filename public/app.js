// Claude Code Sessions Dashboard — front-end.
// Polls the local API for real session state and renders the Organic-styled UI.
import { icon } from './icons.js';

const $ = (sel, root = document) => root.querySelector(sel);
const el = (id) => document.getElementById(id);

// ── persisted prefs ──────────────────────────────────────────────────────────
const prefs = loadPrefs();
function loadPrefs() {
  const d = { pollMs: 5000, autoRefresh: true, group: 'repo', sort: 'attention' };
  try { return { ...d, ...JSON.parse(localStorage.getItem('ccd-prefs') || '{}') }; } catch { return d; }
}
function savePrefs() { try { localStorage.setItem('ccd-prefs', JSON.stringify(prefs)); } catch {} }

// ── app state ────────────────────────────────────────────────────────────────
const state = {
  view: 'sessions',
  data: null,           // /api/state payload
  usage: null,
  usageDays: 7,
  history: null,
  filter: 'live', // roster defaults to live sessions; "Open" reveals the rest
  lastFetch: 0,
  openSession: null,
};

let pollTimer = null;

// ── formatting helpers ───────────────────────────────────────────────────────
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (n) => (n == null ? '—' : '$' + (n < 10 ? n.toFixed(2) : n < 1000 ? n.toFixed(0) : (n / 1000).toFixed(1) + 'k'));
const money2 = (n) => '$' + Number(n || 0).toFixed(2);

function ago(ms) {
  if (!ms) return '—';
  const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (s < 10) return 'now';
  if (s < 60) return s + 's';
  const m = Math.floor(s / 60);
  if (m < 60) return m + 'm';
  const h = Math.floor(m / 60);
  if (h < 24) return h + 'h';
  return Math.floor(h / 24) + 'd';
}
const agoTs = (iso) => (iso ? ago(new Date(iso).getTime()) : '—');
function elapsed(startMs) {
  if (!startMs) return '—';
  const s = Math.floor((Date.now() - startMs) / 1000);
  const m = Math.floor(s / 60), h = Math.floor(m / 60);
  if (h > 0) return h + 'h' + (m % 60) + 'm';
  if (m > 0) return m + 'm';
  return s + 's';
}

// ── API ──────────────────────────────────────────────────────────────────────
async function api(path) {
  const r = await fetch(path, { headers: { accept: 'application/json' } });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}
async function postAction(body) {
  const r = await fetch('/api/action', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return r.json();
}

// ── toast ────────────────────────────────────────────────────────────────────
let toastTimer;
function toast(msg) {
  let t = $('.toast');
  if (!t) { t = document.createElement('div'); t.className = 'toast'; document.body.appendChild(t); }
  t.textContent = msg;
  requestAnimationFrame(() => t.classList.add('in'));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('in'), 2200);
}
async function copy(text) {
  try { await navigator.clipboard.writeText(text); toast('Copied'); }
  catch { toast('Copy failed — ' + text); }
}

// ── top bar ──────────────────────────────────────────────────────────────────
const TABS = [
  ['sessions', 'dashboard', 'Sessions'],
  ['usage', 'chart', 'Usage'],
  ['history', 'history', 'History'],
  ['settings', 'settings', 'Settings'],
];
function renderTabs() {
  el('tabs').innerHTML = TABS.map(([id, ic, label]) =>
    `<button class="tab" data-tab="${id}" ${state.view === id ? 'aria-current="page"' : ''}>${icon(ic, { size: 16 })}<span>${label}</span></button>`
  ).join('');
  el('tabs').querySelectorAll('.tab').forEach((b) => b.onclick = () => switchView(b.dataset.tab));
}
function renderTopRight() {
  const s = state.data && state.data.summary;
  const age = Date.now() - state.lastFetch;
  const live = age < (prefs.pollMs + 3000);
  const stale = s && s.stale > 0;
  const cls = live && !stale ? 'sync' : 'sync stale';
  const label = live ? 'live' : 'synced ' + ago(state.lastFetch);
  const cost = s ? money2(s.costToday) : '—';
  el('topbar-right').innerHTML =
    `<span class="chip static tiny">${icon('dollar', { size: 13 })} ${cost} today</span>` +
    `<span class="${cls}"><span class="pulse"></span>${label}</span>` +
    `<button class="btn btn-icon btn-secondary" id="refresh-btn" title="Refresh now">${icon('refresh', { size: 16 })}</button>`;
  const rb = el('refresh-btn');
  if (rb) rb.onclick = () => { rb.querySelector('.ico').classList.add('spin'); refresh(true); };
}

// ── view switching ───────────────────────────────────────────────────────────
function switchView(view) {
  state.view = view;
  renderTabs();
  render();
  if (view === 'usage' && !state.usage) loadUsage();
  if (view === 'history' && !state.history) loadHistory();
}

// ── data loads ───────────────────────────────────────────────────────────────
async function refresh(force) {
  try {
    const data = await api('/api/state');
    state.data = data;
    state.lastFetch = Date.now();
    renderTopRight();
    if (state.view === 'sessions') renderSessions();
  } catch (e) {
    el('topbar-right') && (renderTopRight());
  }
}
async function loadUsage() {
  try { state.usage = await api('/api/usage?days=' + state.usageDays); if (state.view === 'usage') renderUsage(); }
  catch {}
}
async function loadHistory() {
  try { state.history = await api('/api/history'); if (state.view === 'history') renderHistory(); }
  catch {}
}

// ── render dispatch ──────────────────────────────────────────────────────────
function render() {
  if (state.view === 'sessions') renderSessions();
  else if (state.view === 'usage') renderUsage();
  else if (state.view === 'history') renderHistory();
  else if (state.view === 'settings') renderSettings();
}

// ── SESSIONS view (option 2b: action queue + roster wall) ────────────────────
function renderSessions() {
  const data = state.data;
  const view = el('view');
  if (!data) { view.innerHTML = loading('Reading sessions…'); return; }
  const s = data.summary;
  const waiting = data.sessions.filter((x) => x.attention);

  view.innerHTML = `
    <div class="view-head">
      <h1>Sessions</h1>
      <span class="view-sub">${s.live} live · ${s.running} running · ${s.attention} need you · ${s.open} open in desktop</span>
    </div>
    ${renderQueue(waiting)}
    ${renderWall(data.sessions)}
  `;
  wireSessions();
}

function renderQueue(waiting) {
  if (!waiting.length) {
    return `<div class="queue"><div class="queue-empty">
      ${icon('check', { size: 30, cls: 'ico' })}
      <div class="big" style="margin-top:8px">You're all caught up</div>
      <div class="muted" style="margin-top:4px">No session is waiting on you right now.</div>
    </div></div>`;
  }
  const cards = waiting.map((x, i) => `
    <div class="qcard" data-id="${esc(x.id)}">
      <div class="qcard-top">
        <span class="dot waiting"></span>
        <span class="qcard-repo">${esc(x.repo)}</span>
        <span class="spacer"></span>
        <span class="muted tiny mono">${ago(x.lastActivityMs)}</span>
      </div>
      <div class="qcard-branch">${icon('git-branch', { size: 11 })} ${esc(x.branch || x.worktree || '—')}</div>
      <div class="qcard-ask">${askIcon(x.attentionKind)}<span>${esc(x.statusReason)}</span></div>
      <div class="qcard-actions">
        <button class="btn btn-primary tiny" data-act="desktop" data-id="${esc(x.id)}" style="font-size:13px;padding:6px 14px">${icon('external', { size: 14 })} Open in Desktop</button>
        <div class="qcard-subactions">
          ${x.pr ? `<a class="chip" href="${esc(x.pr.url)}" target="_blank" rel="noopener">${icon('git-pr', { size: 13 })} #${x.pr.number}</a>` : ''}
          <button class="chip" data-act="open" data-id="${esc(x.id)}">Details</button>
        </div>
      </div>
    </div>`).join('');
  return `
    <section class="queue">
      <div class="queue-head">
        ${icon('inbox', { size: 20 })}
        <span class="queue-title">Waiting on you</span>
        <span class="qcount">${waiting.length}</span>
        <span class="spacer"></span>
        <span class="muted tiny">oldest ${ago(Math.min(...waiting.map((w) => w.lastActivityMs)))} ago</span>
      </div>
      <div class="queue-body"><div class="qcards">${cards}</div></div>
    </section>`;
}
function askIcon(kind) {
  if (kind === 'permission') return icon('alert', { size: 15 });
  if (kind === 'question') return icon('question', { size: 15 });
  return icon('message', { size: 15 });
}

function renderWall(sessions) {
  const filtered = state.filter === 'all' ? sessions : state.filter === 'live' ? sessions.filter((x) => x.live) : sessions.filter((x) => x.status === state.filter);
  const counts = { all: sessions.length, live: 0, waiting: 0, running: 0, idle: 0, open: 0 };
  sessions.forEach((x) => { counts[x.status]++; if (x.live) counts.live++; });

  // group by repo, groups with attention first
  const groups = new Map();
  for (const x of filtered) {
    if (!groups.has(x.repo)) groups.set(x.repo, []);
    groups.get(x.repo).push(x);
  }
  const ordered = [...groups.entries()].sort((a, b) => {
    const aAttn = a[1].some((x) => x.attention), bAttn = b[1].some((x) => x.attention);
    if (aAttn !== bAttn) return aAttn ? -1 : 1;
    return b[1].length - a[1].length;
  });

  const bar = `
    <div class="wall-bar">
      ${filterChip('all', 'All ' + counts.all)}
      ${filterChip('live', 'Live ' + counts.live)}
      ${filterChip('waiting', 'Waiting ' + counts.waiting, 'accent')}
      ${filterChip('running', 'Running ' + counts.running)}
      ${filterChip('idle', 'Idle ' + counts.idle)}
      ${filterChip('open', 'Open ' + counts.open)}
      <span class="spacer"></span>
      <span class="chip static tiny muted">${icon('git-branch', { size: 12 })} grouped by repo</span>
    </div>`;

  const body = ordered.length ? ordered.map(([repo, rows]) => `
    <div class="repo-group">
      <div class="repo-head">
        <span class="name">${esc(repo)}</span>
        <span class="muted tiny mono">${rows.length}</span>
        <span class="rule"></span>
        ${rows.some((r) => r.attention) ? `<span class="chip accent tiny static">${rows.filter((r) => r.attention).length} need you</span>` : ''}
      </div>
      ${rows.map(sessionRow).join('')}
    </div>`).join('') : `<div class="empty-state">No ${state.filter} sessions.</div>`;

  return `<section class="wall">${bar}${body}<div class="wall-foot muted tiny">Status is derived from each session's transcript on disk — see Settings for how.</div></section>`;
}

function filterChip(key, label, kind = '') {
  const active = state.filter === key ? 'active' : '';
  return `<button class="chip ${kind} ${active}" data-filter="${key}">${esc(label)}</button>`;
}

function sessionRow(x) {
  const freshCls = x.stale ? 'stale' : 'ok';
  const freshBlock = x.live
    ? `<span class="fresh ${freshCls}"><span class="pulse" style="width:6px;height:6px"></span>${x.ageMs < 15000 ? 'live' : 'synced ' + ago(x.lastActivityMs)}</span>`
    : `<span class="fresh off">not running</span>`;
  const timeCol = x.live ? elapsed(x.startedAt) : ago(x.lastActivityMs) + ' ago';
  return `
    <button class="srow ${x.attention ? 'attn' : ''} ${x.live ? '' : 'open'}" data-id="${esc(x.id)}">
      <span class="s-id"><span class="dot ${x.status}"></span></span>
      <span class="s-repo">
        <span class="top">${esc(x.repo)}${x.pr ? `<span class="pr-badge">${icon('git-pr', { size: 12 })}#${x.pr.number}</span>` : ''}</span>
        <span class="sub">${esc(x.branch || x.worktree || x.cwd || '')}</span>
      </span>
      <span class="s-task">
        <span class="title">${esc(x.title)}</span>
        <span class="reason ${x.status}">${x.attention ? askIcon(x.attentionKind) : icon('dot', { size: 9 })} ${esc(x.statusReason)}</span>
      </span>
      <span class="s-model">
        ${esc(x.modelLabel)}
        ${freshBlock}
      </span>
      <span class="s-time">${timeCol}</span>
      <span class="s-cost">${money2(x.cost)}</span>
      <span class="s-go">${icon('chevron-right', { size: 16 })}</span>
    </button>`;
}

function wireSessions() {
  const view = el('view');
  view.querySelectorAll('[data-filter]').forEach((b) => b.onclick = () => { state.filter = b.dataset.filter; renderSessions(); });
  view.querySelectorAll('.srow').forEach((b) => b.onclick = () => openDrawer(b.dataset.id));
  view.querySelectorAll('.qcard [data-act]').forEach((b) => b.onclick = (e) => {
    e.stopPropagation();
    const id = b.dataset.id;
    if (b.dataset.act === 'open') openDrawer(id);
    else if (b.dataset.act === 'desktop') openDesktop(id);
  });
}

// ── session drawer ───────────────────────────────────────────────────────────
function sessionById(id) { return state.data && state.data.sessions.find((s) => s.id === id); }

async function openDrawer(id) {
  const s = sessionById(id);
  if (!s) return;
  state.openSession = id;
  const root = el('drawer-root');
  root.innerHTML = `
    <div class="drawer-backdrop" id="dback"></div>
    <aside class="drawer" role="dialog" aria-label="Session detail">
      <div class="drawer-head">
        <div class="row1">
          <span class="dot ${s.status}"></span>
          <h3>${esc(s.repo)}</h3>
          <span class="spacer"></span>
          <button class="btn btn-icon btn-secondary" id="dclose">${icon('x', { size: 16 })}</button>
        </div>
        <div class="mono tiny muted" style="margin-top:4px">${icon('git-branch', { size: 12 })} ${esc(s.branch || s.worktree || '—')}</div>
        <div class="drawer-meta">
          <span class="chip static tiny">${icon('cpu', { size: 12 })} ${esc(s.modelLabel)}</span>
          <span class="chip static tiny">${icon('clock', { size: 12 })} ${elapsed(s.startedAt)}</span>
          <span class="chip static tiny">${icon('dollar', { size: 12 })} ${money2(s.cost)}</span>
          <span class="chip static tiny">${s.messages} msgs</span>
          ${s.pr ? `<a class="chip tiny" href="${esc(s.pr.url)}" target="_blank" rel="noopener">${icon('git-pr', { size: 12 })} #${s.pr.number} ${icon('external', { size: 11 })}</a>` : ''}
        </div>
      </div>
      <div class="drawer-body" id="dbody">${loading('Loading transcript…')}</div>
      <div class="drawer-actions" id="dactions"></div>
    </aside>`;
  requestAnimationFrame(() => { $('.drawer').classList.add('in'); $('.drawer-backdrop').classList.add('in'); });
  el('dclose').onclick = closeDrawer;
  el('dback').onclick = closeDrawer;

  renderDrawerActions(s);
  await fillDrawerBody(s);
}

function renderDrawerActions(s) {
  const box = el('dactions');
  if (!box) return;
  box.innerHTML = `
    <button class="btn btn-primary" data-a="desktop">${icon('external', { size: 15 })} Open in Claude Desktop</button>
    <button class="btn btn-secondary" data-a="terminal" ${s.live ? 'disabled title="Session is running — resume in a terminal is for stopped sessions"' : ''}>${icon('terminal', { size: 15 })} Resume in terminal</button>
    <button class="btn btn-secondary" data-a="reveal">${icon('folder', { size: 15 })} Reveal</button>
    <span class="spacer"></span>
    ${s.live ? `<button class="btn btn-secondary" data-a="kill" style="color:var(--color-accent-700)">${icon('x', { size: 15 })} Kill</button>` : ''}`;
  box.querySelector('[data-a="desktop"]').onclick = () => openDesktop(s.id);
  if (!s.live) box.querySelector('[data-a="terminal"]').onclick = () => openTerminal(s.id);
  box.querySelector('[data-a="reveal"]').onclick = async () => {
    const r = await postAction({ action: 'reveal', cwd: s.cwd });
    toast(r.ok ? 'Opened in Finder' : 'Could not open folder');
  };
  const killBtn = box.querySelector('[data-a="kill"]');
  if (killBtn) killBtn.onclick = () => confirmKill(s);
}

async function fillDrawerBody(s) {
  const body = el('dbody');
  if (!body) return;
  let detail = null;
  try { detail = await api('/api/session/' + encodeURIComponent(s.id)); } catch {}
  const askBlock = s.attention ? `
    <div>
      <div class="section-label">Waiting on you</div>
      <div class="ask-box" style="margin-top:6px">${askIcon(s.attentionKind)} ${esc(s.statusReason)}</div>
    </div>` : '';
  const cmd = `cd ${shellQuote(s.cwd)} && claude --resume ${s.id}`;
  const cmdBlock = `
    <div>
      <div class="section-label">Resume this session</div>
      <div class="cmd" style="margin-top:6px"><span>${esc(cmd)}</span>${s.live ? '' : `<button class="btn btn-ghost tiny" id="runcmd" title="Open in your default terminal">${icon('terminal', { size: 14 })} Run</button>`}<button class="btn btn-ghost tiny" id="copycmd" title="Copy command">${icon('copy', { size: 14 })}</button></div>
      ${s.live ? '<div class="tiny muted" style="margin-top:5px">Running now — stop it first to resume in a terminal. Copy the command for later.</div>' : ''}
    </div>`;
  const prBlock = s.pr ? `<div id="prstate"><div class="section-label">Pull request</div><div class="muted tiny" style="margin-top:6px">Checking ${esc(s.pr.repository)} #${s.pr.number}…</div></div>` : '';
  const tail = detail && detail.tail && detail.tail.length ? `
    <div>
      <div class="section-label">Recent transcript</div>
      <div class="transcript" style="margin-top:8px">
        ${detail.tail.slice(-14).map((m) => `<div class="tmsg ${m.role}"><span class="who">${m.role === 'assistant' ? 'Claude' : 'You'}</span><span class="txt">${esc(m.text)}</span></div>`).join('')}
      </div>
    </div>` : '<div class="muted tiny">No transcript preview available.</div>';

  body.innerHTML = askBlock + cmdBlock + prBlock + tail;
  const cc = el('copycmd'); if (cc) cc.onclick = () => copy(cmd);
  const rc = el('runcmd'); if (rc) rc.onclick = () => openTerminal(s.id);
  if (s.pr) loadPrState(s.pr);
}

async function loadPrState(pr) {
  try {
    const { state: st } = await api(`/api/pr?repo=${encodeURIComponent(pr.repository)}&number=${pr.number}`);
    const box = el('prstate');
    if (!box) return;
    if (!st) { box.innerHTML = `<div class="section-label">Pull request</div><a class="chip tiny" href="${esc(pr.url)}" target="_blank" rel="noopener" style="margin-top:6px">#${pr.number} on ${esc(pr.repository)} ${icon('external', { size: 11 })}</a>`; return; }
    const checks = st.checks || { total: 0, failing: 0, pending: 0 };
    const checkTxt = checks.total === 0 ? 'no checks' : checks.failing ? `${checks.failing} failing` : checks.pending ? `${checks.pending} pending` : 'all passing';
    box.innerHTML = `
      <div class="section-label">Pull request · ${esc(pr.repository)} #${pr.number}</div>
      <div class="prstate" style="margin-top:8px">
        <div class="cell"><div class="k">State</div><div class="v"><span class="state-pill state-${esc(st.state)}">${esc(st.state)}</span></div></div>
        <div class="cell"><div class="k">Checks</div><div class="v" style="font-size:14px">${esc(checkTxt)}</div></div>
        <div class="cell"><div class="k">Files</div><div class="v">${st.changedFiles ?? '—'}</div></div>
      </div>
      <a class="chip tiny" href="${esc(pr.url)}" target="_blank" rel="noopener" style="margin-top:8px">Open PR ${icon('external', { size: 11 })}</a>`;
  } catch {}
}

// Open a session in Claude Desktop via its deep-link scheme. Prefers the
// desktop's own `local_` id (what the scheme matches on); falls back to the CLI
// id. Note: on packaged desktop builds the jump-to-session route is behind a
// feature gate, so this reliably foregrounds the app but may not navigate.
async function openDesktop(id) {
  const s = sessionById(id);
  const deskId = (s && s.desktopId) || id;
  const r = await postAction({ action: 'open-desktop', id: deskId });
  toast(r.ok ? 'Opening Claude Desktop…' : 'Could not open: ' + (r.error || ''));
}
function goToSession(id) {
  const s = sessionById(id);
  if (!s) return;
  copy(`cd ${shellQuote(s.cwd)} && claude --resume ${s.id}`);
  toast('Resume command copied — paste it in a terminal');
}
// macOS: launch the session in the user's default terminal app.
async function openTerminal(id) {
  const s = sessionById(id);
  if (!s) return;
  const r = await postAction({ action: 'open-terminal', id: s.id, cwd: s.cwd });
  toast(r.ok ? 'Resuming in your terminal…' : 'Could not open terminal: ' + (r.error || ''));
}
function shellQuote(p) { return `'${String(p).replace(/'/g, `'\\''`)}'`; }

function closeDrawer() {
  const d = $('.drawer'), b = $('.drawer-backdrop');
  if (d) d.classList.remove('in');
  if (b) b.classList.remove('in');
  state.openSession = null;
  setTimeout(() => { el('drawer-root').innerHTML = ''; }, 220);
}

function confirmKill(s) {
  const root = el('dialog-root');
  root.innerHTML = `
    <div class="dialog-backdrop" id="kb">
      <div class="dialog" role="alertdialog">
        <div class="dialog-title">Kill this session?</div>
        <div class="dialog-body">This sends <span class="mono">SIGTERM</span> to <span class="mono">${esc(s.repo)}</span> (pid ${s.pid}). Any unsaved work in that Claude Code process stops. This can't be undone.</div>
        <div class="dialog-actions">
          <button class="btn btn-secondary" id="kcancel">Cancel</button>
          <button class="btn btn-primary" id="kok" style="background:var(--color-accent-700)">Kill session</button>
        </div>
      </div>
    </div>`;
  const done = () => root.innerHTML = '';
  el('kcancel').onclick = done;
  el('kb').onclick = (e) => { if (e.target.id === 'kb') done(); };
  el('kok').onclick = async () => {
    const r = await postAction({ action: 'kill', pid: s.pid });
    done();
    toast(r.ok ? `Killed ${s.repo}` : 'Kill failed: ' + (r.error || ''));
    if (r.ok) { closeDrawer(); refresh(true); }
  };
}

// ── USAGE view ───────────────────────────────────────────────────────────────
function renderUsage() {
  const view = el('view');
  const u = state.usage;
  if (!u) { view.innerHTML = loading('Aggregating usage…'); return; }
  const peak = Math.max(...u.series.map((d) => d.cost), 0.0001);
  const repoMax = Math.max(...u.byRepo.map((r) => r.cost), 0.0001);
  const modelMax = Math.max(...u.byModel.map((m) => m.cost), 0.0001);

  view.innerHTML = `
    <div class="view-head">
      <h1>Usage</h1>
      <span class="view-sub">Spend across every session on this machine</span>
      <span class="spacer"></span>
      <div class="seg" role="group" aria-label="Range">
        <label class="seg-opt"><input type="radio" name="rng" ${u.range === 7 ? 'checked' : ''} value="7">7 days</label>
        <label class="seg-opt"><input type="radio" name="rng" ${u.range === 30 ? 'checked' : ''} value="30">30 days</label>
      </div>
    </div>
    <div class="tiles">
      <div class="tile"><div class="k">${icon('dollar', { size: 13 })} Total spend</div><div class="v accent">${money2(u.totalCost)}</div><div class="foot">last ${u.range} days</div></div>
      <div class="tile"><div class="k">${icon('cpu', { size: 13 })} Tokens</div><div class="v">${(u.totalTokens / 1e6).toFixed(1)}M</div><div class="foot">incl. cache</div></div>
      <div class="tile"><div class="k">${icon('dashboard', { size: 13 })} Sessions</div><div class="v">${u.sessionCount}</div><div class="foot">active in range</div></div>
      <div class="tile"><div class="k">${icon('chart', { size: 13 })} Daily avg</div><div class="v">${money2(u.totalCost / u.range)}</div><div class="foot">per day</div></div>
    </div>
    <div class="panel">
      <h4>Spend per day</h4>
      <div class="bars">
        ${(() => {
          const n = u.series.length;
          const dense = n > 12; // 30-day view: too many bars to label every one
          const lblEvery = dense ? Math.ceil(n / 8) : 1;
          return u.series.map((d, i) => {
            const h = Math.max(3, (d.cost / peak) * 100);
            const isPeak = d.cost === peak && d.cost > 0;
            const showVal = !dense || isPeak;
            // In dense mode, space labels evenly from the right so "today" (the
            // last bar) is always labeled and no two labels collide.
            const showLbl = !dense || (n - 1 - i) % lblEvery === 0;
            return `<div class="bar-col"><span class="bar-val">${showVal && d.cost >= 1 ? '$' + d.cost.toFixed(0) : ''}</span><div class="bar ${isPeak ? 'peak' : ''}" style="height:${h}%"></div><span class="bar-lbl">${showLbl ? d.date.slice(5) : ''}</span></div>`;
          }).join('');
        })()}
      </div>
    </div>
    <div class="panel">
      <h4>By repository</h4>
      <div class="breakdown">
        ${u.byRepo.map((r) => `<div class="brow"><span class="lab">${esc(r.repo)}</span><span class="track"><span class="fill" style="width:${(r.cost / repoMax) * 100}%"></span></span><span class="amt">${money2(r.cost)}</span></div>`).join('') || '<div class="muted tiny">No spend in range.</div>'}
      </div>
    </div>
    <div class="panel">
      <h4>By model</h4>
      <div class="breakdown">
        ${u.byModel.filter((m) => m.cost > 0).map((m) => `<div class="brow"><span class="lab">${esc(m.label)}</span><span class="track"><span class="fill alt" style="width:${(m.cost / modelMax) * 100}%"></span></span><span class="amt">${money2(m.cost)}</span></div>`).join('') || '<div class="muted tiny">No spend in range.</div>'}
      </div>
    </div>`;
  view.querySelectorAll('input[name="rng"]').forEach((r) => r.onchange = () => { state.usageDays = Number(r.value); state.usage = null; renderUsage(); loadUsage(); });
}

// ── HISTORY view ─────────────────────────────────────────────────────────────
function renderHistory() {
  const view = el('view');
  const h = state.history;
  if (!h) { view.innerHTML = loading('Loading history…'); return; }
  view.innerHTML = `
    <div class="view-head">
      <h1>History</h1>
      <span class="view-sub">Recently-ended sessions — ${h.rows.length} shown</span>
    </div>
    <section class="wall">
      <div class="wall-bar"><span class="chip static tiny muted">${icon('history', { size: 12 })} newest first</span></div>
      ${h.rows.map(historyRow).join('') || '<div class="empty-state">No ended sessions found.</div>'}
    </section>`;
  view.querySelectorAll('.hrow').forEach((r) => r.onclick = async () => {
    const deskId = r.dataset.desktop || r.dataset.id;
    const res = await postAction({ action: 'open-desktop', id: deskId });
    toast(res.ok ? 'Opening Claude Desktop…' : 'Could not open');
  });
  view.querySelectorAll('.hrow [data-pr]').forEach((a) => a.onclick = (e) => e.stopPropagation());
}
function historyRow(r) {
  const outLabel = r.outcome === 'pr' ? (r.pr ? `PR #${r.pr.number}` : 'PR') : r.outcome === 'empty' ? 'empty' : 'ended';
  return `
    <button class="hrow" data-id="${esc(r.id)}" data-desktop="${esc(r.desktopId || '')}" title="Open in Claude Desktop">
      <span><span class="dot idle"></span></span>
      <span class="s-repo"><span class="top">${esc(r.repo)}</span><span class="sub">${esc(r.branch || r.worktree || '')}</span></span>
      <span class="s-task"><span class="title">${esc(r.title)}</span><span class="reason idle">${icon('cpu', { size: 11 })} ${esc(r.modelLabel)} · ${r.messages} msgs</span></span>
      <span>${r.pr ? `<a class="outcome pr" data-pr href="${esc(r.pr.url)}" target="_blank" rel="noopener">${icon('git-pr', { size: 12 })} #${r.pr.number}</a>` : `<span class="outcome ${r.outcome}">${icon('clock', { size: 12 })} ${esc(outLabel)}</span>`}</span>
      <span class="s-cost">${money2(r.cost)}</span>
      <span class="s-time muted tiny">${agoTs(r.endedAt)}</span>
    </button>`;
}

// ── SETTINGS view ────────────────────────────────────────────────────────────
function renderSettings() {
  const view = el('view');
  const sw = (s) => s / 1000 + 's';
  view.innerHTML = `
    <div class="view-head"><h1>Settings</h1><span class="view-sub">This dashboard reads your real, local Claude Code state</span></div>
    <div class="panel">
      <h4>Refresh</h4>
      <div class="setrow">
        <div class="txt"><div class="t">Auto-refresh session state</div><div class="d">Poll the local API on an interval while the Sessions view is open</div></div>
        <button class="switch" role="switch" aria-checked="${prefs.autoRefresh}" data-toggle="autoRefresh"></button>
      </div>
      <div class="setrow">
        <div class="txt"><div class="t">Poll interval</div><div class="d">How often live session state is re-read</div></div>
        <div class="seg">
          ${[3000, 5000, 10000].map((ms) => `<label class="seg-opt"><input type="radio" name="poll" value="${ms}" ${prefs.pollMs === ms ? 'checked' : ''}>${sw(ms)}</label>`).join('')}
        </div>
      </div>
    </div>
    <div class="panel">
      <h4>How status is determined</h4>
      <p class="note">Every signal here is derived from files Claude Code already writes to <span class="mono">~/.claude</span> — nothing is mocked. A session is <b>live</b> when its process (from <span class="mono">~/.claude/sessions/&lt;pid&gt;.json</span>) is still running. Everything else comes from its transcript:</p>
      <div class="setrow"><span class="dot waiting"></span><div class="txt"><div class="t">Waiting on you</div><div class="d">The last turn is an unanswered tool call that has sat idle (a permission prompt), or Claude finished its turn and is awaiting your reply. Attention cards surface these.</div></div></div>
      <div class="setrow"><span class="dot running"></span><div class="txt"><div class="t">Running</div><div class="d">The transcript was written to within the last 15 seconds — Claude is actively working.</div></div></div>
      <div class="setrow"><span class="dot idle"></span><div class="txt"><div class="t">Idle</div><div class="d">A live process with no transcript activity for over 10 minutes.</div></div></div>
      <div class="setrow"><span class="dot open"></span><div class="txt"><div class="t">Open in desktop</div><div class="d">A recently-active session with <b>no running process</b> — resumable, and what Claude Desktop keeps in its sidebar. Approximated as active within the last 7 days (the desktop's archive flag isn't on disk), so the roster matches the sidebar's breadth. These never enter the action queue.</div></div></div>
      <p class="note callout" style="margin-top:12px">${icon('alert', { size: 14 })} Because disk state can't distinguish a permission prompt from a slow tool with certainty, "needs permission" is a best-effort heuristic. Approving or replying happens in the session itself — <b>Open in Claude Desktop</b> brings the app to the front, or <b>Copy resume</b> gives you the <span class="mono">claude --resume</span> command for a terminal.</p>
      <p class="note" style="margin-top:10px">${icon('external', { size: 13 })} <b>About "Open in Desktop":</b> it uses the desktop's own <span class="mono">claude://code/continue?session=&lt;id&gt;</span> scheme, resolved to the desktop's <span class="mono">local_</span> session id. On <b>packaged</b> desktop builds that jump-to-session route is currently behind a feature gate, so the button reliably foregrounds Claude Desktop but may not land on the exact chat until the gate is enabled — at which point it starts working with no change here. Sessions started directly from the CLI (not via the desktop) have no desktop id and can't be targeted.</p>
    </div>
    <div class="panel">
      <h4>Cost model</h4>
      <p class="note">Costs are computed from token usage in each transcript at Anthropic list prices (Opus $5/$25, Sonnet 5 $2/$10, Fable $10/$50 per 1M in/out), with cache writes at 1.25× and cache reads at 0.1× the input rate. They're an estimate of API-equivalent spend, not a bill.</p>
    </div>`;
  view.querySelector('[data-toggle="autoRefresh"]').onclick = (e) => {
    prefs.autoRefresh = !prefs.autoRefresh; savePrefs();
    e.currentTarget.setAttribute('aria-checked', prefs.autoRefresh);
    startPolling();
  };
  view.querySelectorAll('input[name="poll"]').forEach((r) => r.onchange = () => { prefs.pollMs = Number(r.value); savePrefs(); startPolling(); });
}

// ── shared ───────────────────────────────────────────────────────────────────
function loading(msg) { return `<div class="empty-state">${icon('refresh', { size: 22, cls: 'spin' })}<div style="margin-top:10px">${esc(msg)}</div></div>`; }

function startPolling() {
  if (pollTimer) clearInterval(pollTimer);
  if (!prefs.autoRefresh) return;
  pollTimer = setInterval(() => { if (document.visibilityState === 'visible') refresh(); }, prefs.pollMs);
}

// keep the "synced Ns ago" label ticking even between polls
setInterval(() => { if (state.data) renderTopRight(); }, 1000);

document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { if (state.openSession) closeDrawer(); } });

// ── boot ─────────────────────────────────────────────────────────────────────
async function boot() {
  renderTabs();
  render();
  await refresh(true);
  startPolling();
}
boot();
