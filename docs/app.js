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

function agoFull(t) {
  const age = ago(t);
  return age === 'now' ? 'just now' : age === '—' ? age : `${age} ago`;
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

const agentLabel = { claude: 'Claude', codex: 'Codex', chatgpt: 'ChatGPT', task: 'Task', ada: 'Ada' };

/* ---------------- render ---------------- */
function render() {
  if (!data) return;
  renderPresence();
  limitKey = ''; // renderLimits redraws the accounts too, so the LIMIT badges match
  renderLimits();
  renderPC();
  renderFlow();
  renderChat();
  renderStrip();
  renderActivity();
  renderWork();
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

function higgsfieldCard(a) {
  const hasCredits = !a.error && Number.isFinite(a.credits) && a.credits >= 0;
  return `
    <article class="acct" data-svc="higgsfield">
      <div class="a-head">
        <span class="a-name">${esc(a.name)}</span>
        ${a.plan ? `<span class="pill r">${esc(a.plan)}</span>` : ''}
        <span class="a-fresh">${a.asOf ? `updated <span data-ago="${a.asOf}" data-full-ago>${agoFull(a.asOf)}</span>` : ''}</span>
      </div>
      <div class="a-email">${esc(a.email || 'not signed in')}</div>
      <div class="a-surf">${(a.surfaces || []).map((s) => `<span class="pill">${esc(s)}</span>`).join('')}</div>
      ${a.error ? `<div class="a-err">${esc(a.error)}</div>` : ''}
      ${hasCredits ? `<div class="a-credits"><strong>${esc(a.credits.toLocaleString(undefined, { maximumFractionDigits: 20 }))}</strong><span>credits</span></div>` : '<div class="a-credit-empty">Credit balance unavailable</div>'}
      <p class="a-note">${esc(a.shared || '')}</p>
    </article>`;
}

// Usage-limit banners. The collector sends data.limits; a flag whose reset time has passed is ignored here
// too, so a banner never outlives its reset even if the feed is a little stale.
const limitNames = { claude: 'Claude', chatgpt: 'ChatGPT / Codex' };
let limitKey = '';
const activeLimits = () => (data?.limits || []).filter((l) => l?.limited && limitNames[l.service] && (!l.resetsAt || l.resetsAt > Date.now()));
const isLimited = (service) => activeLimits().some((l) => l.service === service);

function renderLimits() {
  const list = activeLimits();
  const key = JSON.stringify(list.map((l) => [l.service, l.resetText, l.resetsAt]));
  if (key === limitKey) return;
  limitKey = key;
  $('#limits').innerHTML = list.map((l) => `
    <div class="limit-banner" role="alert" data-svc="${esc(l.service)}">
      <span class="lb-ico">!</span>
      <div><b>${esc(limitNames[l.service])} limit reached</b><span>${l.resetText ? `resets ${esc(l.resetText)}` : 'reset time unknown'}</span></div>
    </div>`).join('');
  renderAccounts();
}

function renderAccounts() {
  const el = $('#accts');
  const list = data.accounts || [];
  if (!list.length) { el.innerHTML = '<div class="empty tile">No account info yet — the collector adds it once it restarts.</div>'; return; }
  el.innerHTML = list.map((a) => a.service === 'higgsfield' ? higgsfieldCard(a) : `
    <article class="acct" data-svc="${esc(a.service)}">
      <div class="a-head">
        <span class="a-name">${esc(a.name)}</span>
        ${a.plan ? `<span class="pill r">${esc(a.plan)}</span>` : ''}
        ${isLimited(a.service) ? '<span class="pill limit">LIMIT</span>' : ''}
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


// Refresh relative times and the connection badge every few seconds.
function tickClock() {
  document.querySelectorAll('[data-ago]').forEach((el) => { el.textContent = (el.hasAttribute('data-full-ago') ? agoFull : ago)(Number(el.dataset.ago)); });
  document.querySelectorAll('[data-until]').forEach((el) => { el.textContent = until(Number(el.dataset.until)); });
  document.querySelectorAll('[data-since]').forEach((el) => { el.textContent = since(Number(el.dataset.since)); });
  syncJobActions();
  if (data) { renderLimits(); renderStrip(); }
  if (!data || paused) return;
  const age = Date.now() - (data.generatedAt || 0);
  if (!lastFetchOk) return;
  if (wsLive && age < 20e3) setConn('rt', 'realtime');
  else if (Date.now() - lastFetchOk > STALE_MS) setConn('err', 'offline');
  else if (age > STALE_MS) setConn('stale', `laptop quiet ${ago(data.generatedAt)}`);
  else setConn('ok', `live · ${ago(data.generatedAt)}`);
}

/* ---------------- ada chat ---------------- */
let chatKey = '';               // skip re-rendering when nothing changed
const outbox = new Map();       // cid -> { text, t, failed, why }
const openJobs = new Set();
let approvalTarget = null; // Job id + approval challenge only; never a PIN.
const pendingJobActions = new Set();
let brainPref = { agent: 'claude', model: '' };
try { brainPref = { ...brainPref, ...JSON.parse(localStorage.getItem('ada-brain') || '{}') }; } catch {}
const rid = () => [...crypto.getRandomValues(new Uint8Array(6))].map((b) => b.toString(16).padStart(2, '0')).join('');
const ICON = {
  spin: '<svg class="spin" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" opacity=".25"/><path d="M21 12a9 9 0 0 0-9-9"/></svg>',
  ok: '<svg viewBox="0 0 24 24"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>',
  bad: '<svg viewBox="0 0 24 24"><path d="M12 7v6M12 17h.01"/><circle cx="12" cy="12" r="9"/></svg>',
  wait: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
  chev: '<svg class="chev" viewBox="0 0 24 24"><path d="m9 6 6 6-6 6"/></svg>',
};
const ADA_MARK = '<svg viewBox="0 0 64 64"><path d="M32 6 58 56H6Z" fill="none" stroke="currentColor" stroke-width="5"/><circle cx="32" cy="40" r="6" fill="currentColor"/></svg>';

// Minimal Markdown: fences, headings, lists, paragraphs; inline code/bold/italic/links.
// Everything is escaped first, so model output can't inject markup.
function md(src) {
  const inline = (s) => esc(s)
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')
    .replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,!?]|$)/g, '$1<i>$2</i>')
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  const out = [];
  const parts = String(src || '').split(/```[^\n]*\n?/);
  parts.forEach((part, i) => {
    if (i % 2) { out.push(`<pre><code>${esc(part.replace(/\n$/, ''))}</code></pre>`); return; }
    let list = null;
    const close = () => { if (list) { out.push(`</${list}>`); list = null; } };
    let para = [];
    const flush = () => { if (para.length) { out.push(`<p>${para.map(inline).join('<br>')}</p>`); para = []; } };
    for (const line of part.split('\n')) {
      const h = line.match(/^(#{1,4})\s+(.*)/);
      const ul = line.match(/^\s*[-*•]\s+(.*)/);
      const ol = line.match(/^\s*\d+[.)]\s+(.*)/);
      if (h) { flush(); close(); out.push(`<h4>${inline(h[2])}</h4>`); }
      else if (ul || ol) {
        flush();
        const kind = ul ? 'ul' : 'ol';
        if (list !== kind) { close(); out.push(`<${kind}>`); list = kind; }
        out.push(`<li>${inline((ul || ol)[1])}</li>`);
      } else if (!line.trim()) { flush(); close(); }
      else { close(); para.push(line); }
    }
    flush(); close();
  });
  return out.join('');
}

function dur(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}
const since = (t) => dur(Date.now() - t);

const jobMode = (j) => j.mode === 'full' || j.mode === 'ops' ? j.mode : 'safe';
const modeBadge = (j) => jobMode(j) === 'safe' ? '' : `<span class="mode-badge" data-mode="${jobMode(j)}">${jobMode(j).toUpperCase()}</span>`;
const approvalOpen = (j) => j?.status === 'awaiting-approval' && Number.isFinite(j.approvalExpiresAt) && Date.now() < j.approvalExpiresAt;
const currentJob = (id) => data?.chat?.jobs?.find((j) => j.id === id);
function operationText(j) {
  const op = j.operation;
  return op ? JSON.stringify({ name: op.name, cwd: op.cwd, command: op.command, args: op.args }, null, 2) : String(j.op || 'Operation unavailable');
}

function jobInstructions(j) {
  if (jobMode(j) === 'safe') return `<div class="md">${md(j.prompt || '')}</div>`;
  return `<pre class="job-instructions">${esc(jobMode(j) === 'ops' ? operationText(j) : j.prompt || '')}</pre>`;
}

function approvalControls(j) {
  if (j.status !== 'awaiting-approval') return '';
  const enabled = wsLive && approvalOpen(j) && data?.chat?.fullModePinSet && !pendingJobActions.has(j.id);
  return `<div class="approval-info">
    <p class="tl-warn" data-approval-expires="${j.approvalExpiresAt}">${approvalOpen(j) ? `Approval expires in ${dur(j.approvalExpiresAt - Date.now())}.` : 'Approval expired. Ask Ada to propose the job again.'}</p>
    ${!data?.chat?.fullModePinSet ? '<p class="tl-warn">Set an approval PIN on the laptop: <code>node tools/set-fullmode-pin.mjs</code></p>' : ''}
    <div class="job-buttons"><button class="tl-approve" data-approve="${esc(j.id)}" type="button" ${enabled ? '' : 'disabled'}>Approve with PIN</button><button class="tl-cancel" data-deny="${esc(j.id)}" type="button" ${wsLive && approvalOpen(j) && !pendingJobActions.has(j.id) ? '' : 'disabled'}>Deny</button></div>
  </div>`;
}

// A worker job, drawn like an agent tool call: one line, tap to expand.
function jobCard(j) {
  if (!j) return '';
  const mode = jobMode(j), awaiting = j.status === 'awaiting-approval';
  const live = j.status === 'running' || j.status === 'queued';
  const icon = j.status === 'running' ? ICON.spin : j.status === 'queued' || awaiting ? ICON.wait : j.status === 'done' ? ICON.ok : ICON.bad;
  const time = j.status === 'running' ? `<span data-since="${j.startedAt}">${since(j.startedAt)}</span>`
    : j.status === 'queued' ? 'queued' : j.endedAt && j.startedAt ? dur(j.endedAt - j.startedAt) : j.status;
  return `<details class="tool" data-s="${esc(j.status)}" data-mode="${mode}" data-agent="${esc(j.agent)}" data-job="${esc(j.id)}" ${openJobs.has(j.id) || awaiting ? 'open' : ''}>
    <summary>
      <span class="tl-ico">${icon}</span>
      <span class="tl-main">
        <span class="tl-title">${modeBadge(j)}${esc(j.title)}</span>
        <span class="tl-sub">${esc(agentLabel[j.agent] || j.agent)}${j.model ? ` · ${esc(j.model)}` : ''} · ${esc(short(j.folder).split(' / ').pop())}</span>
      </span>
      <span class="tl-time">${time}</span>${ICON.chev}
    </summary>
    <div class="tl-body">
      <div class="tl-row"><b>Folder</b><span>${esc(mode === 'safe' ? short(j.folder) : j.folder)}</span></div>
      ${mode !== 'safe' ? `<div class="tl-row"><b>Agent</b><span>${esc(mode === 'ops' ? 'Collector · allowlisted operation' : brainLabel(j))}</span></div><div class="tl-row"><b>Mode</b><span>${mode.toUpperCase()} · approval for this job only</span></div>` : ''}
      ${j.result ? `<div class="tl-sec"><b>${j.status === 'done' ? 'Result' : 'What happened'}</b><div class="md">${md(j.result)}</div></div>` : ''}
      ${j.denied ? `<div class="tl-warn">${mode === 'safe' ? 'Safe mode' : 'Tool permissions'} blocked: ${esc(j.denied.join(', '))}</div>` : ''}
      <div class="tl-sec dim"><b>${mode === 'ops' ? 'Exact operation' : "Ada's instructions"}</b>${jobInstructions(j)}</div>
      ${approvalControls(j)}
      ${mode !== 'safe' && j.status === 'running' ? `<button class="tl-cancel" data-kill="${esc(j.id)}" type="button" ${wsLive ? '' : 'disabled'}>Kill job</button>` : live ? `<button class="tl-cancel" data-cancel="${esc(j.id)}" type="button">Cancel job</button>` : ''}
    </div>
  </details>`;
}

// Live strip of active workers, pinned under the chat header. Redrawn on every snapshot (render) and tick.
// Approve/Deny/Kill use the same data attributes and handlers as the job cards (jobActionClick).
const ACTIVE_JOB = ['awaiting-approval', 'running', 'queued', 'killing'];
const STRIP_MAX = 5;
let stripOpen = false;
let stripKey = '';

function stripStatus(j) {
  if (j.status === 'awaiting-approval') return approvalOpen(j) ? 'waiting for your approval' : 'approval expired';
  return j.status === 'killing' ? 'stopping' : j.status;
}

function stripRow(j) {
  const mode = jobMode(j);
  const icon = j.status === 'running' || j.status === 'killing' ? ICON.spin : ICON.wait;
  const from = j.status === 'running' ? j.startedAt : j.createdAt;
  const since0 = Number.isFinite(from) ? from : Date.now();
  const kill = mode !== 'safe' && j.status === 'running' ? `<button class="tl-cancel" data-kill="${esc(j.id)}" type="button" ${wsLive ? '' : 'disabled'}>Kill job</button>` : '';
  return `<div class="ws-row" role="button" tabindex="0" data-s="${esc(j.status)}" data-mode="${mode}" data-agent="${esc(j.agent)}" data-focus="${esc(j.id)}">
    <div class="ws-line">
      <span class="tl-ico">${icon}</span>
      <span class="tl-main">
        <span class="tl-title">${modeBadge(j)}${esc(j.title)}</span>
        <span class="tl-sub">${esc(agentLabel[j.agent] || j.agent)} · ${esc(short(j.folder).split(' / ').pop())} · ${esc(stripStatus(j))}</span>
      </span>
      <span class="tl-time"><span data-since="${since0}">${since(since0)}</span></span>
    </div>
    ${kill}${approvalControls(j)}
  </div>`;
}

function renderStrip() {
  const el = $('#work-strip');
  const rank = (j) => ACTIVE_JOB.indexOf(j.status);
  const jobs = (data?.chat?.jobs || []).filter((j) => ACTIVE_JOB.includes(j.status)).sort((a, b) => rank(a) - rank(b));
  const key = JSON.stringify([jobs, jobs.map(approvalOpen), wsLive, data?.chat?.fullModePinSet, stripOpen]);
  if (key === stripKey) return;
  stripKey = key;

  const waiting = jobs.filter((j) => j.status === 'awaiting-approval').length;
  const working = jobs.length - waiting;
  const count = [working ? `${working} working` : '', waiting ? `${waiting} to approve` : ''].filter(Boolean).join(' · ');
  $('#ch-count').textContent = count ? ` · ${count}` : '';
  const badge = $('#tab-badge');
  badge.hidden = !jobs.length;
  badge.textContent = String(jobs.length);

  el.hidden = !jobs.length;
  if (!jobs.length) { el.innerHTML = ''; stripOpen = false; return; }
  const shown = stripOpen ? jobs : jobs.slice(0, STRIP_MAX);
  const more = jobs.length - STRIP_MAX;
  el.innerHTML = shown.map(stripRow).join('')
    + (more > 0 ? `<button class="ws-more" data-ws-more type="button">${stripOpen ? 'Show less' : `+${more} more`}</button>` : '');
  syncJobActions();
}

// Scroll to a job's card in the chat and open it.
function focusJobCard(id) {
  const card = [...document.querySelectorAll('#chat-log details[data-job]')].find((d) => d.dataset.job === id);
  if (!card) return;
  card.open = true;
  openJobs.add(id);
  card.scrollIntoView({ behavior: 'smooth', block: 'center' });
  card.classList.add('ws-flash');
  setTimeout(() => card.classList.remove('ws-flash'), 1600);
}

function stripClick(e) {
  if (jobActionClick(e)) return;
  if (e.target.closest('[data-ws-more]')) { stripOpen = !stripOpen; renderStrip(); return; }
  const row = e.target.closest('[data-focus]');
  if (row) focusJobCard(row.dataset.focus);
}

function adaHead(t, b) {
  return `<div class="ada-head"><span class="ada-av">${ADA_MARK}</span><b>Ada</b>${b?.agent ? `<span class="via" data-agent="${esc(b.agent)}">${esc(brainLabel(b))}</span>` : ''}${t ? `<time data-ago="${t}">${ago(t)}</time>` : ''}</div>`;
}

function brainLabel(b) { return `${agentLabel[b.agent] || b.agent}${b.model ? ` · ${b.model}` : ''}`; }

function renderChat() {
  const chat = data?.chat;
  const log = $('#chat-log');
  if (!chat?.thread) {
    log.innerHTML = '<li class="empty">Chat is off — the laptop collector needs a restart with the new version.</li>';
    return;
  }
  const t = chat.thread;
  const pending = [...outbox.entries()].filter(([cid]) => !t.messages.some((m) => m.cid === cid));
  const jobs = new Map((chat.jobs || []).map((j) => [j.id, j]));
  const busy = !!t.busy;

  const key = JSON.stringify([t, pending, chat.jobs, chat.fullModePinSet, brainPref, wsLive]);
  if (key === chatKey) return;
  chatKey = key;

  $('#chat-sub').textContent = `${chat.memory ? 'memory loaded' : 'memory offline'} · safe by default`;
  const chip = $('#brain-btn');
  chip.innerHTML = `<i data-agent="${esc(brainPref.agent)}"></i>${esc(brainLabel(brainPref))}<svg viewBox="0 0 24 24"><path d="m7 10 5 5 5-5"/></svg>`;
  const models = chat.brains?.[brainPref.agent] || [''];
  $('#brain-models').innerHTML = models.map((m) => `<button type="button" data-model="${esc(m)}" class="${m === brainPref.model ? 'on' : ''}">${m ? esc(m) : 'Default model'}</button>`).join('');
  document.querySelectorAll('#brain-seg button').forEach((b) => b.classList.toggle('on', b.dataset.brain === brainPref.agent));

  const nearBottom = window.innerHeight + window.scrollY >= document.body.scrollHeight - 160;
  const rows = [];
  if (!t.messages.length && !pending.length) {
    rows.push(`<li class="hero">
      <div class="hero-mark">${ADA_MARK}</div>
      <h3>Back again, Nefer.</h3>
      <p>Talk to me about anything. Project jobs use safe mode by default. OPS and FULL jobs wait for your approval and PIN, separately for every job.</p>
      <div class="suggest">
        <button type="button" data-suggest="What's going on across my projects right now?">What's going on across my projects?</button>
        <button type="button" data-suggest="Which of my projects have uncommitted changes, and what are they?">Which projects have uncommitted work?</button>
        <button type="button" data-suggest="Where did we leave off? What's the next step?">Where did we leave off?</button>
      </div>
    </li>`);
  } else if (t.total > t.messages.length) {
    rows.push(`<li class="msg sys">Showing the latest ${t.messages.length} of ${t.total} messages</li>`);
  }
  const visibleJobIds = new Set(t.messages.flatMap((m) => m.jobs || []));
  const olderPending = (chat.jobs || []).filter((j) => j.status === 'awaiting-approval' && !visibleJobIds.has(j.id));
  if (olderPending.length) rows.push(`<li class="msg ada"><h3 class="sec">Awaiting your approval</h3><div class="tools">${olderPending.map(jobCard).join('')}</div></li>`);
  for (const m of t.messages) {
    if (m.role === 'user') rows.push(`<li class="msg me"><div class="bubble">${esc(m.text)}</div></li>`);
    else if (m.role === 'ada') {
      const cards = (m.jobs || []).map((id) => jobCard(jobs.get(id))).join('');
      rows.push(`<li class="msg ada">${adaHead(m.t, m)}<div class="md">${md(m.text)}</div>${cards ? `<div class="tools">${cards}</div>` : ''}</li>`);
    } else if (m.reset) rows.push(`<li class="divider"><span>Fresh context</span></li>`);
    else if (m.role === 'system') rows.push(`<li class="msg sys">${esc(m.text)}</li>`);
  }
  for (const [cid, o] of pending) {
    rows.push(`<li class="msg me ${o.failed ? 'failed' : 'sending'}"><div class="bubble">${esc(o.text)}</div>
      <span class="m-state">${o.failed ? `Not delivered${o.why ? ` (${esc(o.why)})` : ''} · <button type="button" class="link" data-retry="${cid}">Retry</button>` : 'Sending…'}</span></li>`);
  }
  if (busy) rows.push(`<li class="msg ada">${adaHead(null, t.brain)}<div class="thinking">Thinking</div></li>`);
  log.innerHTML = rows.join('');
  syncJobActions();

  // Send turns into stop while Ada is thinking (until you type something to queue).
  const send = $('#chat-send');
  const stopMode = busy && !$('#chat-input').value.trim();
  send.classList.toggle('stop', stopMode);
  send.setAttribute('aria-label', stopMode ? 'Stop' : 'Send');
  send.disabled = !wsLive;
  $('#chat-hint').textContent = wsLive ? '' : 'Laptop not connected';
  $('#chat-reset').disabled = busy;
  if (nearBottom || pending.length) requestAnimationFrame(() => window.scrollTo({ top: document.body.scrollHeight }));
}

async function sendCmd(cmd) {
  if (!wsLive || !ws || ws.readyState !== 1) throw new Error('not connected');
  if (!keyCache.key) throw new Error('locked');
  ws.send(JSON.stringify(await seal({ kind: 'cmd', ts: Date.now(), ...cmd })));
}

async function sendChat(text, cid = rid()) {
  const o = { text, t: Date.now(), failed: false, why: '' };
  outbox.set(cid, o);
  chatKey = '';
  renderChat();
  try {
    await sendCmd({ type: 'say', id: cid, text, brain: { ...brainPref } });
  } catch (e) {
    console.warn('[ada] send failed', e);
    o.failed = true; o.why = e.message;
  }
  // No echo from the laptop within 25s: offer a retry.
  setTimeout(() => {
    if (outbox.get(cid) && !data?.chat?.thread?.messages.some((m) => m.cid === cid)) { o.failed = true; o.why ||= 'laptop didn’t answer'; chatKey = ''; renderChat(); }
  }, 25e3);
  chatKey = '';
  renderChat();
}

function setSheet(id, open) {
  if (id === '#approval-sheet' && !open) { $('#approval-pin').value = ''; approvalTarget = null; }
  $(id).hidden = !open;
  document.body.classList.toggle('sheet-open', !!document.querySelector('.sheet:not([hidden])'));
}

function syncJobActions() {
  document.querySelectorAll('[data-approval-expires]').forEach((el) => {
    const left = Number(el.dataset.approvalExpires) - Date.now();
    el.textContent = left > 0 ? `Approval expires in ${dur(left)}.` : 'Approval expired. Ask Ada to propose the job again.';
  });
  document.querySelectorAll('[data-approve], [data-deny], [data-kill]').forEach((el) => {
    const id = el.dataset.approve || el.dataset.deny || el.dataset.kill;
    const j = currentJob(id);
    const allowed = el.dataset.kill ? j?.status === 'running' && jobMode(j) !== 'safe' : approvalOpen(j) && (!el.dataset.approve || data?.chat?.fullModePinSet);
    el.disabled = !wsLive || !allowed || pendingJobActions.has(id);
  });
  if (approvalTarget) {
    const j = currentJob(approvalTarget.id);
    const ready = wsLive && data?.chat?.fullModePinSet && approvalOpen(j) && j.approvalId === approvalTarget.approval;
    $('#approval-submit').disabled = !ready;
    if (!ready) {
      $('#approval-pin').value = '';
      $('#approval-error').textContent = !wsLive ? 'Laptop not connected. Reconnect before approving.' : 'This approval is no longer available. Close and review the current job card.';
    }
  }
}

function openApproval(j) {
  if (!wsLive || !approvalOpen(j) || !data?.chat?.fullModePinSet) return;
  approvalTarget = { id: j.id, approval: j.approvalId };
  $('#approval-pin').value = '';
  $('#approval-error').textContent = '';
  $('#approval-title').textContent = `Approve ${jobMode(j).toUpperCase()} job`;
  $('#approval-review').textContent = `${j.title}\nFolder: ${j.folder}\nAgent: ${jobMode(j) === 'ops' ? 'Collector' : brainLabel(j)}\n\n${jobMode(j) === 'ops' ? operationText(j) : j.prompt || ''}`;
  setSheet('#approval-sheet', true);
  syncJobActions();
  $('#approval-pin').focus();
}

async function sendJobAction(button, cmd) {
  pendingJobActions.add(cmd.job);
  syncJobActions();
  try { await sendCmd({ id: rid(), ...cmd }); button.textContent = 'Sent'; }
  catch { button.textContent = 'Not sent — retry'; pendingJobActions.delete(cmd.job); syncJobActions(); }
  // Commands are not retried automatically. The next attempt always needs a new tap.
  setTimeout(() => { pendingJobActions.delete(cmd.job); syncJobActions(); }, 10000);
}

function jobActionClick(e) {
  const approve = e.target.closest('[data-approve]');
  if (approve) { openApproval(currentJob(approve.dataset.approve)); return true; }
  const deny = e.target.closest('[data-deny]');
  if (deny) {
    const j = currentJob(deny.dataset.deny);
    if (approvalOpen(j)) sendJobAction(deny, { type: 'deny', job: j.id, approval: j.approvalId });
    return true;
  }
  const kill = e.target.closest('[data-kill]');
  if (kill) { sendJobAction(kill, { type: 'kill', job: kill.dataset.kill }); return true; }
  return false;
}

function saveBrain() { try { localStorage.setItem('ada-brain', JSON.stringify(brainPref)); } catch {} }

function bindChat() {
  const input = $('#chat-input');
  const grow = () => { input.style.height = 'auto'; input.style.height = `${Math.min(input.scrollHeight, 168)}px`; chatKey = ''; if (data) renderChat(); };
  input.addEventListener('input', grow);
  input.addEventListener('keydown', (e) => {
    // Desktop: Enter sends, Shift+Enter is a new line. Phones keep Enter for new lines.
    if (e.key === 'Enter' && !e.shiftKey && matchMedia('(pointer: fine)').matches) { e.preventDefault(); $('#composer').requestSubmit(); }
  });
  $('#composer').addEventListener('submit', (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) {
      if (data?.chat?.thread?.busy) sendCmd({ type: 'stop', id: rid() }).catch(() => {});
      return;
    }
    if (!wsLive) return;
    input.value = '';
    sendChat(text);
    grow();
  });
  $('#chat-menu').addEventListener('click', () => setSheet('#chat-sheet', true));
  $('#brain-btn').addEventListener('click', () => setSheet('#brain-sheet', true));
  document.querySelectorAll('.sheet').forEach((s) => s.addEventListener('click', (e) => { if (e.target === s || e.target.closest('[data-close]')) setSheet(`#${s.id}`, false); }));
  $('#approval-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const target = approvalTarget;
    const j = target && currentJob(target.id);
    if (!j || !approvalOpen(j) || j.approvalId !== target.approval || !wsLive) { syncJobActions(); return; }
    let pin = $('#approval-pin').value;
    $('#approval-pin').value = '';
    if (!pin) { $('#approval-error').textContent = 'Enter your approval PIN.'; return; }
    $('#approval-submit').disabled = true;
    try {
      await sendCmd({ type: 'approve', id: rid(), job: target.id, approval: target.approval, pin });
      setSheet('#approval-sheet', false);
    } catch {
      $('#approval-error').textContent = 'Approval was not sent. Re-enter the PIN to try again.';
      syncJobActions();
    } finally { pin = ''; }
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#approval-sheet').hidden) setSheet('#approval-sheet', false); });
  $('#chat-reset').addEventListener('click', () => {
    sendCmd({ type: 'reset', id: rid() }).catch(() => {});
    setSheet('#chat-sheet', false);
  });
  $('#brain-seg').addEventListener('click', (e) => {
    const b = e.target.closest('[data-brain]'); if (!b) return;
    brainPref = { agent: b.dataset.brain, model: '' };
    saveBrain(); chatKey = ''; renderChat();
  });
  $('#brain-models').addEventListener('click', (e) => {
    const b = e.target.closest('[data-model]'); if (!b) return;
    brainPref.model = b.dataset.model;
    saveBrain(); chatKey = ''; renderChat(); setSheet('#brain-sheet', false);
  });
  $('#work-strip').addEventListener('click', stripClick);
  $('#work-strip').addEventListener('keydown', (e) => {
    if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('[data-focus]')) { e.preventDefault(); focusJobCard(e.target.dataset.focus); }
  });
  $('#chat-log').addEventListener('click', (e) => {
    if (jobActionClick(e)) return;
    const sg = e.target.closest('[data-suggest]');
    if (sg) { input.value = sg.dataset.suggest; grow(); input.focus(); return; }
    const c = e.target.closest('[data-cancel]');
    if (c) { c.disabled = true; c.textContent = 'Cancelling…'; sendCmd({ type: 'cancel', id: rid(), job: c.dataset.cancel }).catch(() => {}); return; }
    const r = e.target.closest('[data-retry]');
    if (r) { const o = outbox.get(r.dataset.retry); if (o) { outbox.delete(r.dataset.retry); sendChat(o.text); } }
  });
  // Remember which job cards are expanded across re-renders.
  $('#chat-log').addEventListener('toggle', (e) => {
    const d = e.target; if (!d.dataset?.job) return;
    if (d.open) openJobs.add(d.dataset.job); else openJobs.delete(d.dataset.job);
  }, true);
}

/* ---------------- activity (tasks + log) ---------------- */
let actFilter = 'all';
const openTasks = new Set();

function dayLabel(t) {
  const d = new Date(t), now = new Date();
  const days = Math.round((new Date(now.toDateString()) - new Date(d.toDateString())) / 86400e3);
  return days === 0 ? 'Today' : days === 1 ? 'Yesterday' : d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
}

function taskCard(k) {
  const live = k.status === 'running' || k.status === 'queued';
  const icon = k.status === 'running' ? ICON.spin : k.status === 'queued' ? ICON.wait : k.status === 'done' ? ICON.ok : ICON.bad;
  return `<details class="tool act-task" data-s="${esc(k.status)}" data-mode="${jobMode(k)}" data-agent="${esc(k.agent || 'task')}" data-task="${esc(k.id)}" ${openTasks.has(k.id) || live ? 'open' : ''}>
    <summary>
      <span class="tl-ico">${icon}</span>
      <span class="tl-main">
        <span class="tl-title">${modeBadge(k)}${esc(k.title)}</span>
        <span class="tl-sub">${esc(agentLabel[k.agent] || k.agent || 'Task')}${k.by === 'ada-chat' ? ' · from Ada chat' : ''}${k.cwd ? ` · ${esc(short(k.cwd).split(' / ').pop())}` : ''}</span>
      </span>
      <span class="tl-time">${live && k.startedAt ? `<span data-since="${k.startedAt}">${since(k.startedAt)}</span>` : `<span data-ago="${k.updatedAt}">${ago(k.updatedAt)}</span>`}</span>${ICON.chev}
    </summary>
    <div class="tl-body">
      ${k.cwd ? `<div class="tl-row"><b>Folder</b><span>${esc(short(k.cwd))}</span></div>` : ''}
      ${k.preview ? `<div class="tl-sec"><div class="md">${md(k.preview)}</div></div>` : ''}
      ${k.outputs?.length ? `<div class="tl-row"><b>Outputs</b><span>${k.outputs.map((o) => esc(o.path.split(/[\\/]/).pop())).join(', ')}</span></div>` : ''}
      ${jobMode(k) !== 'safe' && k.status === 'running' ? `<button class="tl-cancel" data-kill="${esc(k.id)}" type="button" ${wsLive ? '' : 'disabled'}>Kill job</button>` : ''}
    </div>
  </details>`;
}

function renderActivity() {
  const tasks = data.tasks || [];
  const approvals = (data.chat?.jobs || []).filter((j) => j.status === 'awaiting-approval');
  $('#act-approvals').innerHTML = approvals.length ? `<h2 class="sec">Awaiting approval <small>${approvals.length}</small></h2>${approvals.map(jobCard).join('')}` : '';
  const running = tasks.filter((k) => k.status === 'running' || k.status === 'queued');
  $('#act-running').innerHTML = running.length
    ? `<h2 class="sec">In progress <small>${running.length}</small></h2>${running.map(taskCard).join('')}` : '';

  const items = [];
  if (actFilter !== 'agents' && actFilter !== 'you') {
    for (const k of tasks) if (!running.includes(k)) items.push({ t: k.updatedAt, task: k });
  }
  if (actFilter !== 'tasks') {
    for (const i of data.timeline || []) {
      if (i.kind === 'task') continue; // drawn as task cards
      if (actFilter === 'you' && i.kind !== 'prompt') continue;
      items.push({ t: i.t, item: i });
    }
  }
  items.sort((a, b) => b.t - a.t);
  let day = '';
  const rows = [];
  for (const x of items.slice(0, 120)) {
    const d = dayLabel(x.t);
    if (d !== day) { day = d; rows.push(`<li class="act-day">${d}</li>`); }
    if (x.task) { rows.push(`<li class="act-card">${taskCard(x.task)}</li>`); continue; }
    const i = x.item;
    rows.push(`<li class="act-row ${i.error ? 'err' : ''}" data-agent="${esc(i.agent)}" data-kind="${esc(i.kind)}">
      <span class="ar-dot"></span>
      <div class="ar-body">
        <div class="ar-meta"><b>${i.kind === 'prompt' ? 'You' : esc(agentLabel[i.agent] || i.agent)}</b>${i.cwd ? `<span>${esc(short(i.cwd).split(' / ').pop())}</span>` : ''}<time data-ago="${i.t}">${ago(i.t)}</time></div>
        <div class="ar-text">${esc(i.text)}</div>
      </div>
    </li>`);
  }
  $('#act-list').innerHTML = rows.length ? rows.join('') : '<li class="empty">Nothing here yet.</li>';
  syncJobActions();
}

function bindActivity() {
  $('#view-activity').addEventListener('click', jobActionClick);
  $('#act-filter').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    actFilter = b.dataset.f;
    document.querySelectorAll('#act-filter button').forEach((x) => x.classList.toggle('on', x === b));
    renderActivity();
  });
  $('#view-activity').addEventListener('toggle', (e) => {
    const d = e.target; if (!d.dataset?.task) return;
    if (d.open) openTasks.add(d.dataset.task); else openTasks.delete(d.dataset.task);
  }, true);
}

/* ---------------- ui ---------------- */
function show(view) {
  document.querySelectorAll('.view').forEach((v) => { v.hidden = v.dataset.view !== view; });
  document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === view));
  document.body.classList.toggle('in-chat', view === 'chat');
  window.scrollTo({ top: view === 'chat' ? document.body.scrollHeight : 0 });
  try { sessionStorage.setItem('ada-tab', view); } catch {}
}

function lock(msg = '') {
  setSheet('#approval-sheet', false);
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
  if (!document.querySelector(`.view[data-view="${tab}"]`)) tab = 'now';
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
  bindActivity();
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
