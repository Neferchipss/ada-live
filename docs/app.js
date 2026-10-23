// Ada Live — fetches the encrypted feed, decrypts it in the browser with the password, renders.
// The only thing it can send is an Ada chat message, sealed with the same key; the laptop
// drops anything else, and Ada's workers run in safe mode.

const $ = (s) => document.querySelector(s);
const STORE_KEY = 'ada-live-key';
const STALE_MS = 2.5 * 60e3;

let config = { source: 'local', path: 'data/live.enc.json', pollSec: 10 };
let password = null;
let keyCache = { salt: null, key: null };
let data = null;
let lastFetchOk = 0;
let lastEtag = '';
let timer = null;
let workFilter = 'active';
let kindFilter = '';
const KIND = { pages: 'Live site', github: 'GitHub', git: 'Local git', local: 'Local' };
const openProjects = new Set();

/* ---------------- crypto ---------------- */
const b64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const toB64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));

async function keyFor(env) {
  if (keyCache.key && keyCache.salt === env.salt) return keyCache.key;
  if (!password) throw new Error('locked');
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']);
  const key = await crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt: b64(env.salt), iterations: env.iter },
    base, { name: 'AES-GCM', length: 256 }, true, ['decrypt', 'encrypt']);
  keyCache = { salt: env.salt, key };
  return key;
}

async function decrypt(env) {
  const key = await keyFor(env);
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64(env.iv) }, key, b64(env.ct));
  let bytes = plain;
  if (env.gz) {
    const stream = new Blob([plain]).stream().pipeThrough(new DecompressionStream('gzip'));
    bytes = await new Response(stream).arrayBuffer();
  }
  return JSON.parse(new TextDecoder().decode(bytes));
}

// Same envelope the laptop uses, uncompressed. The laptop only acts on what this key opens.
async function seal(obj) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, keyCache.key, new TextEncoder().encode(JSON.stringify(obj)));
  return { v: 1, kdf: 'pbkdf2-sha256', iter: 600000, salt: keyCache.salt, iv: toB64(iv), gz: false, ct: toB64(ct) };
}

function rememberKey() {
  crypto.subtle.exportKey('raw', keyCache.key).then((raw) => {
    try { localStorage.setItem(STORE_KEY, JSON.stringify({ salt: keyCache.salt, k: toB64(raw) })); } catch {}
  });
}

async function restoreKey() {
  try {
    const s = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
    if (!s) return false;
    const key = await crypto.subtle.importKey('raw', b64(s.k), 'AES-GCM', true, ['decrypt', 'encrypt']);
    keyCache = { salt: s.salt, key };
    return true;
  } catch { return false; }
}

/* ---------------- feed ---------------- */
async function fetchEnvelope() {
  if (config.source === 'local') {
    const r = await fetch(`${config.path}?t=${Date.now()}`, { cache: 'no-store' });
    if (!r.ok) throw new Error(`feed ${r.status}`);
    return r.json();
  }
  if (config.source === 'github') return fetchGithub();
  throw new Error(`unknown source "${config.source}"`);
}

// GitHub: the API is fresh but allows 60 uncached reads/hour per IP; unchanged
// polls come back 304 (served from browser cache) and don't count. If the limit
// is hit, fall back to raw.githubusercontent.com (can lag up to ~5 min) until reset.
let rawUntil = 0;
async function fetchGithub() {
  const { owner, repo, branch, file } = config;
  if (Date.now() > rawUntil) {
    const r = await fetch(`https://api.github.com/repos/${owner}/${repo}/contents/${file}?ref=${branch}`, {
      cache: 'no-cache',
      headers: { Accept: 'application/vnd.github.raw+json' },
    });
    if (r.ok) return r.json();
    if (r.status === 403 || r.status === 429) {
      const reset = Number(r.headers.get('x-ratelimit-reset')) * 1000;
      rawUntil = reset > Date.now() ? reset : Date.now() + 10 * 60e3;
    } else {
      throw new Error(`feed ${r.status}`);
    }
  }
  const r = await fetch(`https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${file}?t=${Math.floor(Date.now() / 60e3)}`);
  if (!r.ok) throw new Error(`feed ${r.status}`);
  return r.json();
}

/* ---------------- realtime relay ---------------- */
// While the relay socket is open, snapshots arrive every few seconds and polling pauses.
// If it drops, polling the GitHub feed takes over until it reconnects.
let ws = null;
let wsBackoff = 2000;
let wsLive = false;

function connectRelay() {
  if (!config.relayUrl || ws || paused) return;
  try { ws = new WebSocket(`${config.relayUrl.replace(/^http/, 'ws').replace(/\/$/, '')}/ws?role=viewer`); }
  catch { ws = null; return; }
  ws.onopen = () => { wsBackoff = 2000; wsLive = true; clearTimeout(timer); if (data) renderChat(); };
  ws.onmessage = async (ev) => {
    try {
      const env = JSON.parse(ev.data);
      if (!env.ct || env.iv === lastEtag) return;
      data = await decrypt(env);
      lastEtag = env.iv;
      lastFetchOk = Date.now();
      render();
    } catch (e) { console.warn('[ada] relay message', e); }
  };
  ws.onclose = () => {
    ws = null;
    const was = wsLive;
    wsLive = false;
    if (!keyCache.key) return; // locked
    if (data) renderChat();
    if (was) poll();
    setTimeout(connectRelay, wsBackoff);
    wsBackoff = Math.min(wsBackoff * 2, 60000);
  };
}

function disconnectRelay() {
  if (ws) { const w = ws; ws = null; w.onclose = null; w.close(); }
  wsLive = false;
}

let paused = false;

async function poll() {
  clearTimeout(timer);
  if (wsLive || paused) return;
  try {
    const env = await fetchEnvelope();
    const tag = env.iv;
    if (tag !== lastEtag) {
      data = await decrypt(env);
      lastEtag = tag;
      render();
    }
    lastFetchOk = Date.now();
  } catch (e) {
    console.warn('[ada] poll failed', e);
    if (e.name === 'OperationError') { lock('That password no longer opens the feed.'); return; }
    setConn('err', 'offline');
  }
  timer = setTimeout(poll, (config.pollSec || 10) * 1000);
}

/* ---------------- helpers ---------------- */
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function ago(t) {
  if (!t) return '—';
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 45) return 'now';
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  if (s < 86400 * 30) return `${Math.round(s / 86400)}d`;
  return `${Math.round(s / 86400 / 30)}mo`;
}

function short(p) {
  if (!p) return '';
  const norm = p.replace(/\//g, '\\');
  const root = (data?.workRoot || '').toLowerCase();
  if (root && norm.toLowerCase().startsWith(root)) {
    return norm.slice(root.length).replace(/^\\/, '').replace(/\\/g, ' / ') || 'Work';
  }
  // Outside the work folder: just the last folder name.
  return `… / ${norm.split('\\').filter(Boolean).pop()}`;
}

function heat(t) {
  if (!t) return 0;
  const h = (Date.now() - t) / 3600e3;
  if (h < 0.25) return 1;
  if (h < 2) return 0.8;
  if (h < 24) return 0.5;
  if (h < 24 * 7) return 0.22;
  return 0;
}

function setConn(cls, text) {
  const c = $('#conn');
  c.className = `conn ${cls}`;
  $('#conn-text').textContent = text;
}

const agentLabel = { claude: 'Claude', codex: 'Codex', chatgpt: 'ChatGPT', task: 'Task' };

/* ---------------- render ---------------- */
function render() {
  if (!data) return;
  renderPresence();
  renderAccounts();
  renderPC();
  renderFlow();
  renderChat();
  renderTasks();
  renderWork();
  renderLog();
  tickClock();
}

function renderPresence() {
  const a = data.ada || {};
  const el = $('#presence');
  el.dataset.s = a.status || 'idle';
  const word = { working: 'Working', blocked: 'Blocked', idle: 'Idle' }[a.status] || 'Idle';
  el.innerHTML = `
    <div class="p-head">
      <div class="orb"><svg viewBox="0 0 54 54"><circle class="ring" cx="27" cy="27" r="24"/><circle class="arc" cx="27" cy="27" r="24"/><circle class="core" cx="27" cy="27" r="7"/></svg></div>
      <div>
        <div class="p-status">${word}</div>
        <div class="p-note">${esc(a.statusNote || '')}${a.since ? ` · <span data-ago="${a.since}">${ago(a.since)}</span>` : ''}</div>
      </div>
    </div>
    ${a.session ? `
      <div class="p-title">${esc(a.session.title)}</div>
      <div class="p-where">
        <span class="pill r">${esc(short(a.session.cwd) || 'no folder')}</span>
        ${a.session.remote ? '<span class="pill">remote control</span>' : ''}
      </div>` : ''}
    ${a.step ? `<div class="p-step"><b>CURRENT STEP</b><span>${esc(a.step)}</span></div>` : ''}
    ${a.thought ? `<p class="p-thought">${esc(a.thought)}</p>` : ''}
    <div class="p-meta">
      ${a.session?.model ? `<span>${esc(a.session.model)}</span>` : ''}
      <span>${a.activeSessions || 0} active session${a.activeSessions === 1 ? '' : 's'}</span>
      <span>${esc(data.host || '')}</span>
    </div>`;
}

// Sparkline path for a 0-100 series (nulls break the line).
function spark(values) {
  const v = values || [];
  if (v.length < 2) return '<svg class="spark"></svg>';
  const w = 100, h = 30, n = v.length - 1;
  let line = '', pen = false;
  v.forEach((y, i) => {
    if (y == null) { pen = false; return; }
    const px = ((i / n) * w).toFixed(2), py = (h - (Math.min(100, Math.max(0, y)) / 100) * (h - 2) - 1).toFixed(2);
    line += `${pen ? 'L' : 'M'}${px},${py}`;
    pen = true;
  });
  const firstX = (v.findIndex((y) => y != null) / n) * w;
  const area = line ? `${line}L${w},${h}L${firstX.toFixed(2)},${h}Z` : '';
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none"><path class="a" d="${area}"/><path class="l" d="${line}"/></svg>`;
}

function tile(m, label, val, unit, sub, series, level = '') {
  return `<div class="tile ${level}" data-m="${m}">
    <div class="t-top"><span class="t-label">${label}</span><span class="t-val">${val ?? '—'}<small>${val != null ? unit : ''}</small></span></div>
    ${sub ? `<div class="t-sub">${sub}</div>` : ''}
    ${spark(series)}
  </div>`;
}

function until(t) {
  const m = Math.max(0, Math.round((t - Date.now()) / 60000));
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

function meter(label, w) {
  if (!w) return '';
  const lvl = w.pct >= 90 ? 'crit' : w.pct >= 70 ? 'hot' : '';
  const when = w.reset ? 'reset' : w.resetsAt ? `resets in <span data-until="${w.resetsAt}">${until(w.resetsAt)}</span>` : '';
  return `<div class="meter ${lvl}">
    <div class="m-top"><span class="t-label">${label}</span><span class="m-pct">${w.pct}<small>%</small></span></div>
    <div class="bar"><i style="width:${Math.min(100, w.pct)}%"></i></div>
    <div class="t-sub">${when}</div>
  </div>`;
}

function renderAccounts() {
  const el = $('#accts');
  const list = data.accounts || [];
  if (!list.length) { el.innerHTML = '<div class="empty tile">No account info yet — the collector adds it once it restarts.</div>'; return; }
  el.innerHTML = list.map((a) => `
    <article class="acct" data-svc="${esc(a.service)}">
      <div class="a-head">
        <span class="a-name">${esc(a.name)}</span>
        ${a.plan ? `<span class="pill r">${esc(a.plan)}</span>` : ''}
        <span class="a-fresh">${a.live ? 'live' : a.asOf ? `as of <span data-ago="${a.asOf}">${ago(a.asOf)}</span>` : ''}</span>
      </div>
      <div class="a-email">${esc(a.email || 'not signed in')}</div>
      <div class="a-surf">${(a.surfaces || []).map((s) => `<span class="pill">${esc(s)}</span>`).join('')}</div>
      ${a.error ? `<div class="a-err">${esc(a.error)}</div>` : ''}
      <div class="meters">${meter('Session · 5h', a.session)}${meter('Weekly', a.weekly)}</div>
      ${a.extra ? `<div class="t-sub">${esc(a.extra)}</div>` : ''}
      <p class="a-note">${esc(a.shared || '')}</p>
    </article>`).join('');
}

function renderPC() {
  const s = data.stats;
  const el = $('#pc');
  if (!s?.now) { el.innerHTML = '<div class="empty tile wide">No stats yet — the collector sends them once it restarts.</div>'; $('#pc-name').textContent = ''; return; }
  const n = s.now, h = s.history || {}, g = n.gpu;
  const span = h.cpu?.length ? Math.round((h.cpu.length * (h.step || 3000)) / 60000) : 0;
  $('#pc-name').textContent = `${esc(data.host || '')} · last ${span} min`;
  const lvl = (v, hot, crit) => (v == null ? '' : v >= crit ? 'crit' : v >= hot ? 'hot' : '');
  // Memory clock collapse (e.g. 810 MHz) is the throttle signature seen on this laptop.
  const memThrottled = g?.clkMem != null && g.clkMem < 2000 && g.util > 30;
  el.innerHTML = [
    tile('cpu', 'CPU', n.cpu, '%', `${n.cores} threads`, h.cpu, lvl(n.cpu, 85, 97)),
    tile('ram', 'RAM', n.ramUsedGB, ` / ${n.ramTotalGB} GB`, `${Math.round((n.ramUsedGB / n.ramTotalGB) * 100)}% used`, h.ram, lvl((n.ramUsedGB / n.ramTotalGB) * 100, 85, 95)),
    g ? tile('gpu', 'GPU', g.util, '%', esc(n.gpuName.replace(/NVIDIA GeForce /, '')), h.gpu, lvl(g.util, 95, 101)) : '',
    g ? tile('vram', 'VRAM', g.memUsed != null ? +(g.memUsed / 1024).toFixed(1) : null, ` / ${Math.round(g.memTotal / 1024)} GB`, `${Math.round((g.memUsed / g.memTotal) * 100)}% used`, h.vram, lvl((g.memUsed / g.memTotal) * 100, 85, 95)) : '',
    g ? `<div class="tile wide ${lvl(g.temp, 80, 87)}" data-m="temp">
        <div class="t-top"><span class="t-label">GPU temp</span><span class="t-val">${g.temp ?? '—'}<small>°C</small></span></div>
        <div class="gpu-line">
          ${g.power != null ? `<span class="pill">${g.power.toFixed(0)} W</span>` : ''}
          ${g.clkGr != null ? `<span class="pill">core ${g.clkGr} MHz</span>` : ''}
          ${g.clkMem != null ? `<span class="pill ${memThrottled ? 'warn' : ''}">mem ${g.clkMem} MHz</span>` : ''}
          ${g.fan != null ? `<span class="pill">fan ${g.fan}%</span>` : ''}
          ${(g.throttle || []).map((r) => `<span class="pill warn">throttling: ${esc(r)}</span>`).join('')}
          ${memThrottled ? '<span class="pill warn">memory clock collapsed</span>' : ''}
        </div>
        ${spark(h.temp?.map((t) => (t == null ? null : t)))}
      </div>` : '',
  ].join('');
}

function flowItems() {
  const now = Date.now();
  const items = [];
  const taskSessions = new Set((data.tasks || []).map((k) => k.session).filter(Boolean));
  for (const s of data.sessions || []) {
    if (s.parent) continue; // Codex sub-agents roll up into their parent
    if (taskSessions.has(s.id)) continue; // shown as its delegated task instead
    if (s.status === 'idle' && now - s.lastActivity > 6 * 3600e3) continue;
    items.push({
      agent: s.agent, status: s.status, title: s.title, step: s.status === 'idle' ? (s.statusNote || '') : s.step,
      cwd: s.cwd, t: s.lastActivity, images: s.images?.length || 0,
    });
  }
  for (const k of data.tasks || []) {
    if ((k.status === 'done' || k.status === 'failed') && now - (k.endedAt || 0) > 6 * 3600e3) continue;
    items.push({
      agent: k.agent || 'task', status: k.status === 'running' || k.status === 'queued' ? 'working' : 'idle',
      title: k.title, step: k.preview || k.status, cwd: k.cwd, t: k.updatedAt, images: k.outputs?.length || 0, task: true,
    });
  }
  const rank = { working: 0, blocked: 1, idle: 2 };
  return items.sort((x, y) => rank[x.status] - rank[y.status] || y.t - x.t);
}

function renderFlow() {
  const items = flowItems();
  $('#flow-count').textContent = items.length ? `${items.filter((i) => i.status !== 'idle').length} live · ${items.length} in the last 6h` : '';
  const arrow = '<svg viewBox="0 0 24 24"><path d="M5 12h14M13 6l6 6-6 6"/></svg>';
  $('#flow').innerHTML = `
    <div class="f-hub"><div class="node">A</div><span>Ada · orchestrator</span></div>
    ${items.length ? items.map((i) => `
      <div class="f-row" data-agent="${esc(i.agent)}" data-s="${esc(i.status)}">
        <div class="f-card">
          <div class="f-top">
            <span class="badge">${esc(agentLabel[i.agent] || i.agent)}${i.task ? ' task' : ''}</span>
            <span class="f-title">${esc(i.title)}</span>
            <span class="ago" data-ago="${i.t}">${ago(i.t)}</span>
          </div>
          ${i.step ? `<div class="f-step">${esc(i.step)}</div>` : ''}
          ${i.images ? `<div class="f-imgs">${i.images} image${i.images > 1 ? 's' : ''} generated</div>` : ''}
          ${i.cwd ? `<div class="f-to">${arrow}${esc(short(i.cwd))}</div>` : ''}
        </div>
      </div>`).join('') : '<div class="empty">Nothing has moved in the last 6 hours.</div>'}`;
}

function renderTasks() {
  const tasks = data.tasks || [];
  $('#tasks').innerHTML = tasks.length ? tasks.map((k) => `
    <div class="task" data-agent="${esc(k.agent || 'task')}">
      <div class="f-top">
        <span class="badge">${esc(agentLabel[k.agent] || k.agent || 'task')}</span>
        <span class="f-title">${esc(k.title)}</span>
        <span class="st ${esc(k.status)}">${esc(k.status)}</span>
      </div>
      ${k.preview ? `<div class="f-step">${esc(k.preview)}</div>` : ''}
      <div class="f-to"><span data-ago="${k.updatedAt}">${ago(k.updatedAt)}</span>${k.cwd ? ` · ${esc(short(k.cwd))}` : ''}${k.outputs?.length ? ` · ${k.outputs.length} output${k.outputs.length > 1 ? 's' : ''}` : ''}</div>
    </div>`).join('')
    : '<div class="empty">No delegated tasks yet.<br>When Ada hands work to Codex or ChatGPT, each job shows up here with its state and output.</div>';
}

function renderWork() {
  const q = $('#search').value.trim().toLowerCase();
  const now = Date.now();
  let list = (data.projects || []).slice();
  if (workFilter === 'active') list = list.filter((p) => now - (p.lastActivity || 0) < 24 * 3600e3 || p.agents?.some((a) => a.status !== 'idle'));
  if (workFilter === 'week') list = list.filter((p) => now - (p.lastActivity || 0) < 7 * 24 * 3600e3);
  if (q) list = list.filter((p) => `${p.group || ''} ${p.name}`.toLowerCase().includes(q));
  if (kindFilter) list = list.filter((p) => p.kind === kindFilter);
  list.sort((a, b) => (b.lastActivity || 0) - (a.lastActivity || 0));
  $('#work-count').textContent = `${list.length} of ${(data.projects || []).length}`;

  if (!list.length) {
    $('#work').innerHTML = `<div class="empty">${workFilter === 'active' ? 'Nothing touched in the last 24 hours.' : 'No matching projects.'}</div>`;
    return;
  }
  // Group by client folder, groups ordered by their freshest project.
  const groups = new Map();
  for (const p of list) {
    const g = p.group || 'C:\\Work';
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(p);
  }
  $('#work').innerHTML = [...groups].map(([g, ps]) => `
    <div class="group">
      <h3><span>${esc(g)}</span><span>${ps.length}</span></h3>
      ${ps.map(projectCard).join('')}
    </div>`).join('');
  $('#work').querySelectorAll('details').forEach((d) => d.addEventListener('toggle', () => {
    d.open ? openProjects.add(d.dataset.path) : openProjects.delete(d.dataset.path);
  }));
}

function projectCard(p) {
  const live = p.agents?.some((a) => a.status !== 'idle');
  const agents = [...new Map((p.agents || []).map((a) => [a.agent + a.status, a])).values()];
  const git = p.git;
  return `
    <details class="proj${live ? ' live' : ''}" style="--heat:${heat(p.lastActivity)}" data-path="${esc(p.path)}" ${openProjects.has(p.path) ? 'open' : ''}>
      <summary>
        <div class="pj-top">
          <span class="pj-name">${esc(p.name)}</span>
          ${agents.map((a) => `<span class="dot${a.status !== 'idle' ? ' w' : ''}" data-agent="${esc(a.agent)}" title="${esc(agentLabel[a.agent])} ${esc(a.status)}"></span>`).join('')}
          <span class="ago" data-ago="${p.lastActivity || 0}">${ago(p.lastActivity)}</span>
        </div>
        <div class="pj-sub">
          <span class="kind" data-kind="${esc(p.kind || 'local')}">${KIND[p.kind] || 'Local'}${p.private === true ? ' · private' : p.private === false && p.kind !== 'pages' ? ' · public' : ''}</span>
          ${git ? `<span class="pill">⎇ ${esc(git.branch)}</span>${git.changed ? `<span class="pill r">${git.changed} changed</span>` : '<span class="pill">clean</span>'}` : ''}
          ${live ? `<span class="pill r">agent working</span>` : ''}
          ${p.looseOnly ? '<span class="pill">loose files</span>' : ''}
        </div>
      </summary>
      <div class="pj-body">
        <div class="pj-path">${esc(p.path)}</div>
        ${p.site || p.repo ? `<div class="pj-links">
          ${p.site ? `<a href="${esc(p.site)}" target="_blank" rel="noopener">${esc(p.site.replace(/^https?:\/\//, '').replace(/\/$/, ''))} ↗</a>` : ''}
          ${p.repo ? `<a href="${esc(p.url)}" target="_blank" rel="noopener">github.com/${esc(p.repo)} ↗</a>` : ''}
        </div>` : ''}
        ${git?.last ? `<div class="commit">${esc(git.last.hash)} · ${esc(git.last.subject)} · <span data-ago="${git.last.t}">${ago(git.last.t)}</span></div>` : ''}
        ${p.recent?.length ? `<div>Recently changed</div><ul>${p.recent.map((r) => `<li><span>${esc(r.file)}</span><span data-ago="${r.t}">${ago(r.t)}</span></li>`).join('')}</ul>` : '<div>No files found.</div>'}
      </div>
    </details>`;
}

function renderLog() {
  const items = data.timeline || [];
  $('#log').innerHTML = items.length ? items.map((i) => `
    <li data-agent="${esc(i.agent)}" data-kind="${esc(i.kind)}" class="${i.error ? 'err' : ''}">
      <div class="lg-meta"><b>${esc(agentLabel[i.agent] || i.agent)}</b><span data-ago="${i.t}">${ago(i.t)}</span><span>${esc(short(i.cwd).split(' / ').pop())}</span></div>
      <div class="lg-text">${i.kind === 'prompt' ? 'You: ' : ''}${esc(i.text)}</div>
    </li>`).join('') : '<div class="empty">No activity yet.</div>';
}

// Refresh relative times and the connection badge every few seconds.
function tickClock() {
  document.querySelectorAll('[data-ago]').forEach((el) => { el.textContent = ago(Number(el.dataset.ago)); });
  document.querySelectorAll('[data-until]').forEach((el) => { el.textContent = until(Number(el.dataset.until)); });
  document.querySelectorAll('[data-since]').forEach((el) => { el.textContent = since(Number(el.dataset.since)); });
  if (!data || paused) return;
  const age = Date.now() - (data.generatedAt || 0);
  if (!lastFetchOk) return;
  if (wsLive && age < 20e3) setConn('rt', 'realtime');
  else if (Date.now() - lastFetchOk > STALE_MS) setConn('err', 'offline');
  else if (age > STALE_MS) setConn('stale', `laptop quiet ${ago(data.generatedAt)}`);
  else setConn('ok', `live · ${ago(data.generatedAt)}`);
}

/* ---------------- ada chat ---------------- */
const NEW = '__new__';
let chatThread = null;          // selected thread id, or NEW
let chatKey = '';               // skip re-rendering when nothing changed
const outbox = new Map();       // cid -> { thread, text, t, failed }
const openJobs = new Set();
let brainPref = { agent: 'claude', model: '' };
try { brainPref = { ...brainPref, ...JSON.parse(localStorage.getItem('ada-brain') || '{}') }; } catch {}
const rid = () => [...crypto.getRandomValues(new Uint8Array(6))].map((b) => b.toString(16).padStart(2, '0')).join('');

// Small, safe formatting: escape first, then `code`, **bold**, and line breaks via CSS.
const fmt = (s) => esc(s).replace(/`([^`\n]+)`/g, '<code>$1</code>').replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>');

function dur(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}
const since = (t) => dur(Date.now() - t);

function jobCard(j) {
  if (!j) return '';
  const live = j.status === 'running' || j.status === 'queued';
  const time = j.status === 'running' ? `<span data-since="${j.startedAt}">${since(j.startedAt)}</span>`
    : j.endedAt && j.startedAt ? dur(j.endedAt - j.startedAt) : '';
  return `<div class="job" data-s="${esc(j.status)}" data-agent="${esc(j.agent)}">
    <div class="j-top">
      <span class="j-dot"></span>
      <span class="j-title">${esc(j.title)}</span>
      <span class="j-status">${esc(j.status)}${time ? ` · ${time}` : ''}</span>
    </div>
    <div class="j-meta">
      <span class="pill">${esc(agentLabel[j.agent] || j.agent)}${j.model ? ` · ${esc(j.model)}` : ''}</span>
      <span class="pill">${esc(short(j.folder))}</span>
      ${live ? `<button class="j-cancel" data-cancel="${esc(j.id)}" type="button">Cancel</button>` : ''}
    </div>
    ${j.result || j.prompt ? `<details data-job="${esc(j.id)}" ${openJobs.has(j.id) ? 'open' : ''}>
      <summary>${j.result ? 'Result' : 'Instructions'}</summary>
      ${j.result ? `<div class="j-text">${fmt(j.result)}</div>` : ''}
      ${j.denied ? `<div class="j-denied">Safe mode blocked: ${esc(j.denied.join(', '))}</div>` : ''}
      <div class="j-prompt"><b>Ada's instructions</b>${fmt(j.prompt || '')}</div>
    </details>` : ''}
  </div>`;
}

function renderChat() {
  const chat = data?.chat;
  const log = $('#chat-log');
  if (!chat) {
    log.innerHTML = '<li class="empty">Chat is off — the laptop collector needs a restart with the new version.</li>';
    return;
  }
  const threads = chat.threads || [];
  if (!chatThread || (chatThread !== NEW && !threads.some((t) => t.id === chatThread) && ![...outbox.values()].some((o) => o.thread === chatThread))) {
    chatThread = threads[0]?.id || NEW;
  }
  const t = threads.find((x) => x.id === chatThread);
  const pending = [...outbox.entries()].filter(([cid, o]) => o.thread === chatThread && !t?.messages.some((m) => m.cid === cid));
  const jobs = new Map((chat.jobs || []).map((j) => [j.id, j]));

  const key = JSON.stringify([chatThread, t, pending, chat.jobs?.filter((j) => j.thread === chatThread), brainPref, wsLive, threads.map((x) => x.id + x.title)]);
  if (key === chatKey) return;
  chatKey = key;

  // Conversation picker.
  const sel = $('#chat-thread');
  sel.innerHTML = threads.map((x) => `<option value="${esc(x.id)}">${esc(x.title)}</option>`).join('')
    + (chatThread !== NEW && !t ? `<option value="${esc(chatThread)}">New chat…</option>` : '')
    + `<option value="${NEW}">＋ New chat</option>`;
  sel.value = chatThread;
  $('#chat-archive').hidden = !t || t.busy;

  // Brain: pick for a new chat, fixed once it starts.
  const brainEl = $('#chat-brain');
  if (t) {
    brainEl.innerHTML = `<span class="pill r">${esc(agentLabel[t.brain.agent])}${t.brain.model ? ` · ${esc(t.brain.model)}` : ''}</span><span class="pill">safe mode</span>`;
  } else {
    const models = chat.brains?.[brainPref.agent] || [''];
    brainEl.innerHTML = `
      <div class="seg" role="group" aria-label="Ada runs on">
        <button type="button" data-brain="claude" class="${brainPref.agent === 'claude' ? 'on' : ''}">Claude</button>
        <button type="button" data-brain="codex" class="${brainPref.agent === 'codex' ? 'on' : ''}">Codex</button>
      </div>
      <select id="chat-model" aria-label="Model">${models.map((m) => `<option value="${esc(m)}" ${m === brainPref.model ? 'selected' : ''}>${m ? esc(m) : 'default model'}</option>`).join('')}</select>`;
  }

  const nearBottom = window.innerHeight + window.scrollY >= document.body.scrollHeight - 120;
  const rows = [];
  if (!t && !pending.length) {
    rows.push(`<li class="empty">Tell Ada what you need. She reads your Work folder, picks the projects, and hands the jobs to Claude or Codex workers in safe mode — they can edit files in their own folder and nothing else.</li>`);
  }
  for (const m of t?.messages || []) {
    if (m.role === 'user') rows.push(`<li class="msg me"><div class="bubble">${fmt(m.text)}</div><time data-ago="${m.t}">${ago(m.t)}</time></li>`);
    else if (m.role === 'ada') rows.push(`<li class="msg ada"><div class="bubble">${fmt(m.text)}</div>${(m.jobs || []).map((id) => jobCard(jobs.get(id))).join('')}<time data-ago="${m.t}">${ago(m.t)}</time></li>`);
    else if (m.role === 'job') {
      const j = jobs.get(m.job);
      rows.push(`<li class="msg note" data-s="${esc(j?.status || '')}">${esc(m.text)}</li>`);
    } else rows.push(`<li class="msg sys">${fmt(m.text)}</li>`);
  }
  for (const [cid, o] of pending) {
    rows.push(`<li class="msg me ${o.failed ? 'failed' : 'sending'}"><div class="bubble">${fmt(o.text)}</div>
      <time>${o.failed ? `not delivered · <button type="button" class="link" data-retry="${cid}">retry</button>` : 'sending…'}</time></li>`);
  }
  if (t?.busy) rows.push(`<li class="msg ada thinking"><div class="bubble"><i></i><i></i><i></i></div><button type="button" class="link" data-stop="${esc(t.id)}">stop</button></li>`);
  log.innerHTML = rows.join('');

  const canSend = wsLive;
  $('#chat-send').disabled = !canSend;
  $('#chat-hint').textContent = canSend ? '' : 'Not connected to the laptop right now — messages can’t be sent until it’s back.';
  if (nearBottom) requestAnimationFrame(() => window.scrollTo({ top: document.body.scrollHeight }));
}

async function sendCmd(cmd) {
  if (!wsLive || !ws) throw new Error('offline');
  ws.send(JSON.stringify(await seal({ kind: 'cmd', ts: Date.now(), ...cmd })));
}

async function sendChat(text, cid = rid(), thread = chatThread) {
  if (thread === NEW || !thread) thread = rid();
  chatThread = thread;
  outbox.set(cid, { thread, text, t: Date.now(), failed: false });
  chatKey = '';
  renderChat();
  try {
    await sendCmd({ type: 'say', id: cid, thread, text, brain: { ...brainPref } });
  } catch { outbox.get(cid).failed = true; }
  // No echo from the laptop within 25s: offer a retry.
  setTimeout(() => {
    const o = outbox.get(cid);
    const t = data?.chat?.threads?.find((x) => x.id === thread);
    if (o && !t?.messages.some((m) => m.cid === cid)) { o.failed = true; chatKey = ''; renderChat(); }
  }, 25e3);
  chatKey = '';
  renderChat();
}

function bindChat() {
  const input = $('#chat-input');
  const grow = () => { input.style.height = 'auto'; input.style.height = `${Math.min(input.scrollHeight, 160)}px`; };
  input.addEventListener('input', grow);
  input.addEventListener('keydown', (e) => {
    // Desktop: Enter sends, Shift+Enter is a new line. Phones keep Enter for new lines.
    if (e.key === 'Enter' && !e.shiftKey && matchMedia('(pointer: fine)').matches) { e.preventDefault(); $('#composer').requestSubmit(); }
  });
  $('#composer').addEventListener('submit', (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text || !wsLive) return;
    input.value = '';
    grow();
    sendChat(text);
  });
  $('#chat-thread').addEventListener('change', (e) => { chatThread = e.target.value; chatKey = ''; renderChat(); });
  $('#chat-archive').addEventListener('click', () => {
    if (!chatThread || chatThread === NEW) return;
    sendCmd({ type: 'archive', id: rid(), thread: chatThread }).catch(() => {});
    chatThread = NEW; chatKey = ''; renderChat();
  });
  $('#chat-brain').addEventListener('click', (e) => {
    const b = e.target.closest('[data-brain]'); if (!b) return;
    brainPref = { agent: b.dataset.brain, model: '' };
    try { localStorage.setItem('ada-brain', JSON.stringify(brainPref)); } catch {}
    chatKey = ''; renderChat();
  });
  $('#chat-brain').addEventListener('change', (e) => {
    if (e.target.id !== 'chat-model') return;
    brainPref.model = e.target.value;
    try { localStorage.setItem('ada-brain', JSON.stringify(brainPref)); } catch {}
  });
  $('#chat-log').addEventListener('click', (e) => {
    const c = e.target.closest('[data-cancel]');
    if (c) { c.disabled = true; c.textContent = 'Cancelling…'; sendCmd({ type: 'cancel', id: rid(), job: c.dataset.cancel }).catch(() => {}); return; }
    const s = e.target.closest('[data-stop]');
    if (s) { s.textContent = 'stopping…'; sendCmd({ type: 'stop', id: rid(), thread: s.dataset.stop }).catch(() => {}); return; }
    const r = e.target.closest('[data-retry]');
    if (r) { const o = outbox.get(r.dataset.retry); if (o) { outbox.delete(r.dataset.retry); sendChat(o.text, rid(), o.thread); } }
  });
  // Remember which job details are expanded across re-renders.
  $('#chat-log').addEventListener('toggle', (e) => {
    const d = e.target; if (!d.dataset?.job) return;
    if (d.open) openJobs.add(d.dataset.job); else openJobs.delete(d.dataset.job);
  }, true);
}

/* ---------------- ui ---------------- */
function show(view) {
  document.querySelectorAll('.view').forEach((v) => { v.hidden = v.dataset.view !== view; });
  document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === view));
  window.scrollTo({ top: view === 'chat' ? document.body.scrollHeight : 0 });
  try { sessionStorage.setItem('ada-tab', view); } catch {}
}

function lock(msg = '') {
  clearTimeout(timer);
  disconnectRelay();
  password = null;
  keyCache = { salt: null, key: null };
  data = null;
  lastEtag = '';
  try { localStorage.removeItem(STORE_KEY); } catch {}
  $('#app').hidden = true;
  $('#login').hidden = false;
  $('#login-error').textContent = msg;
  $('#password').value = '';
}

async function unlock(e) {
  e.preventDefault();
  const btn = $('#unlock');
  btn.disabled = true;
  btn.textContent = 'Decrypting…';
  $('#login-error').textContent = '';
  password = $('#password').value;
  try {
    const env = await fetchEnvelope();
    data = await decrypt(env);
    lastEtag = env.iv;
    lastFetchOk = Date.now();
    if ($('#remember').checked) rememberKey();
    password = null; // the derived key is enough from here on
    enterApp();
  } catch (err) {
    password = null;
    keyCache = { salt: null, key: null };
    $('#login-error').textContent = err.name === 'OperationError' ? 'Wrong password.' : `Can't reach the feed (${err.message}).`;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Unlock';
  }
}

function enterApp() {
  $('#login').hidden = true;
  $('#app').hidden = false;
  let tab = 'now';
  try { tab = sessionStorage.getItem('ada-tab') || 'now'; } catch {}
  show(tab);
  render();
  timer = setTimeout(poll, (config.pollSec || 10) * 1000);
  connectRelay();
}

let configReady;
async function boot() {
  // Hook the form first so an early submit never falls through to a page reload.
  $('#login-form').addEventListener('submit', async (e) => { e.preventDefault(); await configReady; unlock(e); });
  configReady = (async () => {
    try { config = { ...config, ...(await (await fetch('config.json', { cache: 'no-store' })).json()) }; } catch {}
  })();
  await configReady;
  // Served from the laptop itself: read the local file the collector writes.
  if (['localhost', '127.0.0.1'].includes(location.hostname)) config = { ...config, source: 'local', path: 'data/live.enc.json', pollSec: 10 };
  $('#lock').addEventListener('click', () => lock());
  $('#tabs').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) show(b.dataset.tab); });
  $('#work-filter').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    workFilter = b.dataset.f;
    document.querySelectorAll('#work-filter button').forEach((x) => x.classList.toggle('on', x === b));
    renderWork();
  });
  $('#search').addEventListener('input', () => renderWork());
  bindChat();
  $('#kind-filter').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    kindFilter = b.dataset.k;
    document.querySelectorAll('#kind-filter button').forEach((x) => x.classList.toggle('on', x === b));
    renderWork();
  });
  // A tab hidden for a minute disconnects (so the laptop stops streaming and GitHub
  // isn't polled); it reconnects the moment it's visible again.
  let hideTimer = null;
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      hideTimer = setTimeout(() => { paused = true; clearTimeout(timer); disconnectRelay(); setConn('', 'paused'); }, 60e3);
      return;
    }
    clearTimeout(hideTimer);
    if (!keyCache.key || !data) return;
    if (paused) { paused = false; connectRelay(); }
    poll();
  });
  setInterval(tickClock, 5000);

  if (!crypto.subtle) {
    $('#login-error').textContent = 'This page needs HTTPS (or localhost) to decrypt.';
    return;
  }
  if (await restoreKey()) {
    try {
      const env = await fetchEnvelope();
      if (env.salt === keyCache.salt) {
        data = await decrypt(env);
        lastEtag = env.iv;
        lastFetchOk = Date.now();
        enterApp();
        return;
      }
    } catch { /* fall through to the password screen */ }
    lock();
  }
}

boot();
