// Ada Live — fetches the encrypted feed, decrypts it in the browser with the password, renders.
// The only thing it can send is an Ada chat message, sealed with the same key; the laptop
// drops anything else, and Ada's workers run in safe mode.

import { pendingApprovals, openApprovals, soonestExpiry, resolvedGroups, outcomeLabel, countdown, newApprovals, approvalMessage, needsPinRetry, noteKey, RETRY_TAG, selectable, pruneSelection, selectAll, selectOps, toggleSelection, selectionView, batchEntries, batchMessage } from './approvals.mjs?v=sv-7';
import { PROJECT_LIMIT, todayStats, needsAttention, attentionView, waitingApprovals, nowGroups, byProject, projectOf, timelineRows, taskTitle, parseDismissed, addDismissed, removeDismissed } from './activity-model.mjs?v=sv-7';
import { ctxView, ctxNeedsFresh } from './context.mjs?v=sv-7';
import { buildSessionMap, activeCount, RECENT_ID, ribbonSessions } from './session-map.mjs?v=sv-7';

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
let unpushedFirst = false;
const KIND = { pages: 'Live site', github: 'GitHub', git: 'Local git', local: 'Local' };
const openProjects = new Set();
const openGit = new Set();

/* ---------------- crypto ---------------- */
const b64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const toB64 = (buf) => {
  // Chunked: spreading a whole upload chunk into fromCharCode would overflow the call stack.
  const u = new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < u.length; i += 0x8000) bin += String.fromCharCode(...u.subarray(i, i + 0x8000));
  return btoa(bin);
};

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
      if (env.m === 1) { onMediaChunk(env); return; } // attachment bytes, not a snapshot
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
// One failing section must not stop the rest, block unlock, or hide itself: log it and show a red line.
const shownErrors = new Set();
function showError(label, err) {
  const msg = `${label}: ${err?.message || err}`;
  console.error('[ada]', label, err);
  if (shownErrors.has(msg)) return;
  shownErrors.add(msg);
  const bar = $('#err-bar');
  if (!bar) return;
  const line = document.createElement('div');
  line.className = 'err-line';
  line.textContent = msg;
  line.addEventListener('click', () => { line.remove(); shownErrors.delete(msg); if (!bar.children.length) bar.hidden = true; });
  bar.appendChild(line);
  bar.hidden = false;
}
function guarded(name, fn) {
  try { return fn(); } catch (err) { showError(`Section ${name} failed`, err); }
}

function render() {
  if (!data) return;
  guarded('presence', renderPresence);
  guarded('limits', () => { limitKey = ''; /* renderLimits redraws the accounts too, so the LIMIT badges match */ renderLimits(); });
  guarded('pc', renderPC);
  guarded('flow', renderFlow);
  guarded('chat', renderChat);
  guarded('strip', renderStrip);
  guarded('activity', renderActivity);
  guarded('work', renderWork);
  guarded('clock', tickClock);
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
      ${hasCredits ? `<div class="a-credits"><strong>${esc(a.credits.toLocaleString(undefined, { maximumFractionDigits: 2 }))}</strong><span>credits${Number.isFinite(a.planCredits) ? ` of ${esc(a.planCredits.toLocaleString())} plan` : ''}</span></div>` : '<div class="a-credit-empty">Credit balance unavailable</div>'}
      ${hasCredits && Number.isFinite(a.renewsAt) ? `<div class="t-sub">plan renews ${esc(new Date(a.renewsAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }))}</div>` : ''}
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
      title: taskTitle(k), step: k.preview || k.status, cwd: k.cwd, t: k.updatedAt, images: k.outputs?.length || 0, task: true,
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
  gitByPath = new Map((data.gitActivity || []).map((g) => [g.path, g]));
  const unpushedN = (p) => gitByPath.get(p.path)?.ahead || 0;
  // With the Unpushed chip on, projects holding unpushed commits stay visible whatever the time filter says.
  const keep = (p) => unpushedFirst && unpushedN(p) > 0;
  if (workFilter === 'active') list = list.filter((p) => keep(p) || now - (p.lastActivity || 0) < 24 * 3600e3 || p.agents?.some((a) => a.status !== 'idle'));
  if (workFilter === 'week') list = list.filter((p) => keep(p) || now - (p.lastActivity || 0) < 7 * 24 * 3600e3);
  if (q) list = list.filter((p) => `${p.group || ''} ${p.name}`.toLowerCase().includes(q));
  if (kindFilter) list = list.filter((p) => p.kind === kindFilter);
  list.sort((a, b) => (unpushedFirst ? (unpushedN(b) > 0) - (unpushedN(a) > 0) : 0) || (b.lastActivity || 0) - (a.lastActivity || 0));
  const totalUnpushed = (data.projects || []).filter((p) => unpushedN(p) > 0).length;
  const chip = $('#unpushed-chip');
  chip.textContent = totalUnpushed ? `Unpushed · ${totalUnpushed}` : 'Unpushed';
  chip.classList.toggle('on', unpushedFirst);
  chip.setAttribute('aria-pressed', String(unpushedFirst));
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
  $('#work').querySelectorAll('details.proj').forEach((d) => d.addEventListener('toggle', () => {
    d.open ? openProjects.add(d.dataset.path) : openProjects.delete(d.dataset.path);
  }));
  $('#work').querySelectorAll('details.gitx').forEach((d) => d.addEventListener('toggle', () => {
    d.open ? openGit.add(d.dataset.path) : openGit.delete(d.dataset.path);
  }));
}

let gitByPath = new Map();
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

// Collapsible Git section for a GitHub project: status, last push, commits, pushes. Every value is escaped.
function gitSection(p, g) {
  g = { ...g, commits: g.commits || [], pushes: g.pushes || [] };
  const onGithub = g.remoteBranch ? '' : ' · branch not on GitHub';
  const status = [g.branch || 'detached HEAD', `${g.ahead} not pushed${onGithub}`, `${g.behind} behind`, `${g.dirty} uncommitted`].join(' · ');
  const lastPush = g.lastPush
    ? `Last push: <span data-ago="${g.lastPush}" data-full-ago>${agoFull(g.lastPush)}</span>`
    : (g.reflog ? 'never pushed from this laptop' : 'No push history on this laptop (fresh clone or reflog expired)');
  const commits = g.commits.length ? g.commits.map((c) => `<li class="gx-c"><code>${esc(c.h)}</code><span class="gx-s">${esc(c.s)}</span>${c.pushed ? '' : '<span class="gx-np">not pushed</span>'}<span class="gx-m">${esc(c.a)} · <span data-ago="${c.t}">${ago(c.t)}</span></span></li>`).join('') : '<li class="gx-none">No commits yet.</li>';
  const pushes = g.pushes.length
    ? g.pushes.map((e) => `<li class="gx-p" data-k="${esc(e.kind)}"><span class="gx-s">${e.kind === 'pushed' ? 'Pushed' : 'Fetched'}${e.n != null ? ' ' + plural(e.n, 'commit') : ''}${e.branch ? ' · ' + esc(e.branch) : ''}</span><code>${e.from ? esc(e.from) : 'new'} → ${esc(e.to)}</code><span class="gx-m" data-ago="${e.t}">${ago(e.t)}</span></li>`).join('')
    : `<li class="gx-none">${g.reflog ? 'No pushes recorded.' : 'No reflog on this laptop, so no push history.'}</li>`;
  return `<details class="gitx" data-path="${esc(p.path)}" ${openGit.has(p.path) ? 'open' : ''}>
    <summary><b>Git</b><span class="gx-status${g.ahead ? ' warn' : ''}">${esc(status)}</span></summary>
    <div class="gx-last">${lastPush}</div>
    <div class="gx-h">Commits</div><ul class="gx-list">${commits}</ul>
    <div class="gx-h">Pushes</div><ul class="gx-list">${pushes}</ul>
    <a class="gx-open" href="${esc(g.url)}" target="_blank" rel="noopener">View on GitHub ↗</a>
  </details>`;
}

function projectCard(p) {
  const live = p.agents?.some((a) => a.status !== 'idle');
  const agents = [...new Map((p.agents || []).map((a) => [a.agent + a.status, a])).values()];
  const git = p.git;
  const gx = gitByPath.get(p.path);
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
          ${gx?.ahead ? `<span class="pill r">${gx.ahead} not pushed</span>` : ''}
          ${live ? `<span class="pill r">agent working</span>${ctxBar(p.agents.find((a) => a.status !== 'idle' && a.context)?.context)}` : ''}
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
        ${gx ? gitSection(p, gx) : ''}
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
let approvalTarget = null; // Job id + approval challenge + refusal key only; never a PIN.
let approvalTimer = null;
let apprSel = new Set(); // job ids ticked in the Approvals sheet (ids only; survives snapshots, pruned in renderApprovals)
let batchTarget = null; // { entries: [{ id, approval }], baseKey, submitting, notice, sendTimer, refocus }; never a PIN
let batchTimer = null; // 1s tick while the PIN dialog is open (expiry + lockout countdowns)
const pendingJobActions = new Set();
let brainPref = { agent: 'claude', model: '' };
try { brainPref = { ...brainPref, ...JSON.parse(localStorage.getItem('ada-brain') || '{}') }; } catch {}
brainPref.agent = 'claude'; // Ada's head is always Claude; an older saved Codex choice is dropped
if (!['', 'opus', 'sonnet', 'haiku'].includes(brainPref.model)) brainPref.model = '';
const rid = () => [...crypto.getRandomValues(new Uint8Array(6))].map((b) => b.toString(16).padStart(2, '0')).join('');
const ICON = {
  spin: '<svg class="spin" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" opacity=".25"/><path d="M21 12a9 9 0 0 0-9-9"/></svg>',
  ok: '<svg viewBox="0 0 24 24"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>',
  bad: '<svg viewBox="0 0 24 24"><path d="M12 7v6M12 17h.01"/><circle cx="12" cy="12" r="9"/></svg>',
  wait: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
  chev: '<svg class="chev" viewBox="0 0 24 24"><path d="m9 6 6 6-6 6"/></svg>',
};
const ADA_MARK = '<svg viewBox="0 0 64 64"><path d="M32 6 58 56H6Z" fill="none" stroke="currentColor" stroke-width="5"/><circle cx="32" cy="40" r="6" fill="currentColor"/></svg>';

/* ---------------- attachments: media from Ada, uploads from the phone ---------------- */
// Bytes arrive as sealed chunks over the relay socket, only when asked for by id. Images load as they
// scroll into view; video and files load only when tapped. Nothing is stored beyond this page's memory.
const media = new Map();       // "id" | "id:poster" -> { state, url, mime, n, parts, ... }
const mediaQueue = [];
let mediaActive = 0;
let mediaVer = 0;              // bumps whenever a download changes, so the chat re-renders
let hint = '';
let hintTimer = null;
const MEDIA_CACHE_BYTES = 120 * 1024 * 1024;
const mKey = (id, part) => (part === 'poster' ? `${id}:poster` : id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const kb = (n) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB` : `${(n / 1048576).toFixed(n < 10485760 ? 1 : 0)} MB`);

function flash(msg) {
  hint = msg;
  const el = $('#chat-hint');
  if (el) el.textContent = msg;
  clearTimeout(hintTimer);
  hintTimer = setTimeout(() => { hint = ''; chatKey = ''; if (data) renderChat(); }, 5000);
}

function mediaChanged() { mediaVer++; chatKey = ''; if (data) renderChat(); }

function fetchMedia(id, part = 'main') {
  const k = mKey(id, part);
  let m = media.get(k);
  if (m?.state === 'ready') return Promise.resolve(m);
  if (m?.promise && m.state !== 'error') return m.promise;
  m = { id, part, state: 'queued', n: 0, parts: new Map(), tries: 0, last: Date.now(), size: 0, mime: '' };
  media.set(k, m);
  m.promise = new Promise((res, rej) => { m.res = res; m.rej = rej; });
  m.promise.catch(() => {});
  mediaQueue.push(m);
  pumpMedia();
  return m.promise;
}

function retryMedia(id, part) {
  const m = media.get(mKey(id, part === 'poster' ? 'poster' : 'main'));
  if (m?.state === 'error') media.delete(mKey(id, part === 'poster' ? 'poster' : 'main'));
  fetchMedia(id, part === 'poster' ? 'poster' : 'main');
  mediaChanged();
}

function pumpMedia() {
  while (mediaActive < 2 && mediaQueue.length) startMedia(mediaQueue.shift());
}

async function requestMedia(m, need) {
  await sendCmd({ type: 'media-get', id: rid(), media: m.id, ...(m.part === 'poster' ? { part: 'poster' } : {}), ...(need ? { need } : {}) });
}

async function startMedia(m) {
  mediaActive++;
  m.state = 'loading';
  m.last = Date.now();
  try { await requestMedia(m); } catch (e) { return endMedia(m, 'error', 'not connected'); }
  // No progress for 10 s: ask again for just the missing chunks, three times at most.
  m.timer = setInterval(async () => {
    if (Date.now() - m.last < 10000) return;
    if (m.tries >= 3) return endMedia(m, 'error', 'timed out');
    m.tries++;
    m.last = Date.now();
    const need = [];
    for (let i = 0; i < m.n && need.length < 800; i++) if (!m.parts.has(i)) need.push(i);
    try { await requestMedia(m, m.n ? need : undefined); } catch { endMedia(m, 'error', 'not connected'); }
  }, 2000);
}

function endMedia(m, state, err = '') {
  if (m.state !== 'loading' && m.state !== 'queued') return;
  clearInterval(m.timer);
  m.state = state;
  m.err = err;
  m.parts = null;
  mediaActive = Math.max(0, mediaActive - 1);
  if (state === 'error') m.rej(new Error(err)); else m.res(m);
  pumpMedia();
  evictMedia();
  mediaChanged();
}

async function onMediaChunk(env) {
  let o;
  try { o = await decrypt(env); } catch { return; }
  if (o.sv) { onSvChunk(o); return; } // a session-viewer reply, not attachment bytes
  const m = media.get(mKey(o.id, o.part === 'poster' ? 'poster' : 'main'));
  if (!m || m.state !== 'loading') return;
  if (o.err) return endMedia(m, 'error', String(o.err));
  m.n = o.n; m.size = o.size; m.mime = o.mime; m.last = Date.now();
  if (!m.parts.has(o.i)) m.parts.set(o.i, b64(o.d));
  m.onprogress?.(m.parts.size, m.n);
  if (m.parts.size < m.n) return;
  const blob = new Blob([...Array(m.n).keys()].map((i) => m.parts.get(i)), { type: m.mime });
  m.url = URL.createObjectURL(blob);
  m.bytes = blob.size;
  endMedia(m, 'ready');
}

// Keep the in-memory copies bounded; the oldest finished ones go first (they reload on demand).
function evictMedia() {
  const ready = [...media.entries()].filter(([, m]) => m.state === 'ready');
  let total = ready.reduce((s, [, m]) => s + (m.bytes || 0), 0);
  for (const [k, m] of ready) {
    if (total <= MEDIA_CACHE_BYTES) break;
    if (m === viewing) continue;
    URL.revokeObjectURL(m.url);
    total -= m.bytes || 0;
    media.delete(k);
  }
}

let lazyObserver = null;
function observeLazy() {
  const els = document.querySelectorAll('#chat-log [data-lazy]');
  if (!els.length) return;
  lazyObserver ||= new IntersectionObserver((entries) => {
    for (const en of entries) {
      if (!en.isIntersecting) continue;
      lazyObserver.unobserve(en.target);
      const [id, part] = en.target.dataset.lazy.split(':');
      const m = media.get(mKey(id, part === 'poster' ? 'poster' : 'main'));
      if (!m || m.state === 'queued') fetchMedia(id, part === 'poster' ? 'poster' : 'main').catch(() => {});
    }
  }, { rootMargin: '240px' });
  els.forEach((el) => {
    const [id, part] = el.dataset.lazy.split(':');
    if (media.get(mKey(id, part === 'poster' ? 'poster' : 'main'))?.state === 'error') return; // tap to retry
    lazyObserver.observe(el);
  });
}

const PLAY = '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>';
const clock = (s) => { s = Math.round(s || 0); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };

function attHtml(a) {
  const cap = a.caption ? `<div class="att-cap">${esc(a.caption)}</div>` : '';
  const note = (txt, state) => `<div class="att" data-state="${state}"><div class="att-note">${txt}</div></div>`;
  if (a.state === 'processing') return note(`${ICON.spin} Preparing ${esc(a.name)}…`, 'processing');
  if (a.state === 'failed') return note(`${esc(a.name)} could not be sent: ${esc(a.error || 'failed')}`, 'failed');
  if (a.state === 'expired') return note(`${esc(a.name)} · expired, no longer on the laptop`, 'expired');
  if (a.kind === 'image' || a.kind === 'video') {
    const part = a.kind === 'video' ? 'poster' : 'main';
    const m = media.get(mKey(a.id, part));
    const wantPic = a.kind === 'image' || a.poster;
    let pic;
    if (m?.state === 'ready') pic = `<img src="${m.url}" alt="${esc(a.name)}">`;
    else if (a.thumb) pic = `<img class="blur" ${wantPic && m?.state !== 'error' ? `data-lazy="${a.id}${part === 'poster' ? ':poster' : ''}"` : ''} src="${a.thumb}" alt="" ${a.w && a.h ? `style="aspect-ratio:${a.w}/${a.h}"` : ''}>`;
    else pic = `<div class="ph" ${wantPic ? `data-lazy="${a.id}${part === 'poster' ? ':poster' : ''}"` : ''}>${m?.state === 'error' ? `tap to retry · ${esc(m.err)}` : esc(a.name)}</div>`;
    const play = a.kind === 'video' ? `<span class="att-play"><i>${PLAY}</i></span>${a.dur ? `<span class="att-dur">${clock(a.dur)}</span>` : ''}` : '';
    return `<div class="att wide" data-kind="${a.kind}"><button type="button" class="att-pic" data-open="${a.id}" aria-label="${a.kind === 'video' ? 'Play' : 'Open'} ${esc(a.name)}">${pic}${play}</button>${cap}</div>`;
  }
  const ext = (a.name.split('.').pop() || 'file').slice(0, 4);
  const dl = a.dl !== false;
  return `<div class="att"><button type="button" class="att-file" ${dl ? `data-open="${a.id}"` : 'disabled'}><span class="ext">${esc(ext)}</span><span><b>${esc(a.name)}</b><small>${kb(a.size)}${dl ? ' · tap to download' : ' · too large to download here'}</small></span></button>${cap}</div>`;
}

const attsHtml = (m) => (m.atts?.length ? `<div class="atts">${m.atts.map(attHtml).join('')}</div>` : '');

/* ---- full-screen viewer ---- */
let viewing = null;
const findAtt = (id) => {
  for (const m of data?.chat?.thread?.messages || []) { const a = m.atts?.find((x) => x.id === id); if (a) return a; }
  return null;
};

function closeViewer() {
  const v = $('#viewer');
  v.querySelector('video')?.pause();
  if (viewing) viewing.onprogress = null;
  viewing = null;
  v.hidden = true;
  $('#viewer-body').innerHTML = '';
}

function openViewer(id) {
  const a = findAtt(id);
  if (!a) return;
  const body = $('#viewer-body');
  $('#viewer-cap').textContent = [a.name, a.caption].filter(Boolean).join(' — ');
  $('#viewer').hidden = false;
  const say = (html) => { body.innerHTML = `<div class="vmsg">${html}</div>`; };
  const show = (m) => {
    if (a.kind === 'image') body.innerHTML = `<img src="${m.url}" alt="${esc(a.name)}">`;
    else if (a.kind === 'video') body.innerHTML = `<video src="${m.url}" controls playsinline autoplay></video>`;
    else body.innerHTML = `<div class="vmsg"><a href="${m.url}" download="${esc(a.name)}" style="color:var(--text)">Save ${esc(a.name)}</a>${/pdf|text/.test(m.mime) ? ` · <a href="${m.url}" target="_blank" rel="noopener" style="color:var(--text)">Open</a>` : ''}</div>`;
    if (a.kind === 'file') { const l = document.createElement('a'); l.href = m.url; l.download = a.name; l.click(); }
  };
  const have = media.get(mKey(id, 'main'));
  if (have?.state === 'ready') { viewing = have; return show(have); }
  const poster = a.kind === 'video' && media.get(mKey(id, 'poster'))?.url;
  say(`${poster ? `<img src="${poster}" alt="" style="max-height:50vh;opacity:.6;display:block;margin:0 auto 14px">` : ''}${ICON.spin} Loading ${esc(a.name)}…`);
  const p = fetchMedia(id, 'main');
  const m = media.get(mKey(id, 'main'));
  viewing = m;
  m.onprogress = (got, n) => { if (viewing === m) { const el = body.querySelector('.vmsg'); if (el) el.lastChild.textContent = ` Loading ${a.name}… ${Math.round((got / n) * 100)}%`; } };
  p.then((r) => { if (viewing === m) show(r); }).catch((e) => { if (viewing === m) say(`Couldn’t load ${esc(a.name)}: ${esc(e.message)}<br><br><button type="button" class="link" id="viewer-retry">Try again</button>`); });
}

/* ---- uploads from the phone ---- */
const ALLOWED_UPLOAD = /\.(png|jpe?g|webp|gif|mp4|webm|mov|pdf|txt|md|json|csv)$/i;
const staged = [];            // { key, file, name, size, kind, url, state: ready | sending | sent | failed, sent, n, err, up }
let group = null;             // the batch being sent: { grp, files, note }
let lastChunkAt = 0;
const CHUNK_GAP_MS = 260;     // ~230 chunks/min: stays under the relay's per-socket upload budget

const groupBusy = () => !!group && staged.some((f) => f.state === 'sending');
const kindOfFile = (f) => (/^image\//.test(f.type) || /\.(png|jpe?g|webp|gif)$/i.test(f.name) ? 'image' : /^video\//.test(f.type) || /\.(mp4|webm|mov)$/i.test(f.name) ? 'video' : 'file');

function addFiles(list) {
  const cfg = data?.chat?.media || {};
  const maxBytes = cfg.maxUpload || 25 * 1048576;
  const maxFiles = cfg.maxFiles || 10;
  const problems = [];
  for (const file of list) {
    if (staged.length >= maxFiles) { problems.push(`at most ${maxFiles} files at once`); break; }
    if (/\.hei[cf]$/i.test(file.name)) { problems.push(`${file.name}: HEIC isn’t supported (set the camera to Most Compatible)`); continue; }
    if (!ALLOWED_UPLOAD.test(file.name)) { problems.push(`${file.name}: type not allowed`); continue; }
    if (file.size > maxBytes) { problems.push(`${file.name}: over ${kb(maxBytes)}`); continue; }
    if (!file.size) { problems.push(`${file.name}: empty`); continue; }
    const kind = kindOfFile(file);
    staged.push({ key: rid(), file, name: file.name, size: file.size, kind, url: kind === 'file' ? '' : URL.createObjectURL(file), state: 'ready', sent: 0, n: 0, err: '', up: '' });
  }
  if (problems.length) flash(problems.join(' · '));
  renderStaged();
}

function removeStaged(key) {
  const i = staged.findIndex((f) => f.key === key);
  if (i < 0 || staged[i].state === 'sending') return;
  if (staged[i].url) URL.revokeObjectURL(staged[i].url);
  staged.splice(i, 1);
  renderStaged();
}

function clearStaged() {
  for (const f of staged) if (f.url) URL.revokeObjectURL(f.url);
  staged.length = 0;
  group = null;
  renderStaged();
}

function renderStaged() {
  const box = $('#staged');
  box.hidden = !staged.length;
  box.innerHTML = staged.map((f) => {
    const pic = f.kind === 'image' ? `<img src="${f.url}" alt="">` : f.kind === 'video' ? `<video src="${f.url}#t=0.1" preload="metadata" muted playsinline></video>` : esc((f.name.split('.').pop() || 'file').slice(0, 4).toUpperCase());
    const pct = f.state === 'sent' ? 100 : f.n ? Math.round((f.sent / f.n) * 100) : 0;
    return `<div class="stg ${f.state === 'failed' ? 'bad' : ''}" data-key="${f.key}">
      <div class="stg-pic">${pic}</div><div class="stg-name">${esc(f.name)}</div>
      ${f.state === 'sending' || f.state === 'sent' ? `<div class="stg-bar"><i style="width:${pct}%"></i></div>` : ''}
      ${f.state === 'failed' ? `<div class="stg-err">${esc(f.err || 'failed')}</div>` : ''}
      ${f.state === 'sending' ? '' : `<button type="button" class="stg-x" data-rm="${f.key}" aria-label="Remove ${esc(f.name)}">×</button>`}
    </div>`;
  }).join('');
  const send = $('#chat-send');
  if (send) send.classList.toggle('stop', !!data?.chat?.thread?.busy && !$('#chat-input').value.trim() && !staged.length);
}

function setProgress(f) {
  const bar = document.querySelector(`.stg[data-key="${f.key}"] .stg-bar i`);
  if (bar) bar.style.width = `${Math.round((f.sent / f.n) * 100)}%`;
}

async function waitSend() {
  for (;;) {
    if (!wsLive || !ws || ws.readyState !== 1) throw new Error('not connected');
    const gap = lastChunkAt + CHUNK_GAP_MS - Date.now();
    if (ws.bufferedAmount < 600000 && gap <= 0) break;
    await sleep(Math.max(20, gap));
  }
  lastChunkAt = Date.now();
}

async function uploadFile(f, g, note) {
  const cs = data?.chat?.media?.chunk || 48 * 1024;
  f.n = Math.ceil(f.size / cs);
  const head = { up: f.up, grp: g.grp, gn: g.files.length, n: f.n, cs, size: f.size, name: f.name, mime: f.file.type || '' };
  const sendChunk = async (i) => {
    const buf = await f.file.slice(i * cs, Math.min(f.size, (i + 1) * cs)).arrayBuffer();
    await waitSend();
    await sendCmd({ type: 'upload-chunk', id: rid(), ...head, i, d: toB64(buf), ...(i === 0 ? { note, brain: { ...brainPref } } : {}) }, true);
  };
  for (let i = 0; i < f.n; i++) { await sendChunk(i); f.sent = i + 1; setProgress(f); }
  // The laptop reports what it holds in the next snapshots; resend anything it is missing.
  for (let round = 0; round < 5; round++) {
    await sleep(4000);
    const st = data?.chat?.uploads?.find((u) => u.id === f.up);
    if (data?.chat?.thread?.messages.some((m) => m.grp === g.grp) || st?.state === 'done') { f.state = 'sent'; return; }
    if (st?.state === 'failed') throw new Error(st.reason || 'refused');
    if (st?.state === 'receiving') for (const i of st.miss || []) await sendChunk(i);
    else if (!st && round >= 1) for (let i = 0; i < f.n; i++) await sendChunk(i);
  }
  throw new Error('the laptop never confirmed');
}

async function startUploads(note) {
  const files = staged.filter((f) => f.state === 'ready');
  if (!files.length) return;
  const g = { grp: rid(), files, note };
  group = g;
  for (const f of files) { f.up = rid(); f.state = 'sending'; f.sent = 0; f.err = ''; }
  renderStaged();
  chatKey = ''; if (data) renderChat();
  for (const [idx, f] of files.entries()) {
    try { await uploadFile(f, g, idx === 0 ? note : ''); }
    catch (e) { f.state = 'failed'; f.err = e.message; }
    renderStaged();
  }
}

// Once the laptop has posted the message for this batch, the staged chips have done their job.
function watchUploadedGroup(t) {
  if (group && t.messages.some((m) => m.grp === group.grp)) clearStaged();
}

function bindAttach() {
  const input = $('#file-input');
  $('#attach-btn').addEventListener('click', () => { if (!$('#attach-btn').disabled) input.click(); });
  input.addEventListener('change', () => { addFiles([...input.files]); input.value = ''; });
  $('#staged').addEventListener('click', (e) => { const x = e.target.closest('[data-rm]'); if (x) removeStaged(x.dataset.rm); });
  $('#viewer-close').addEventListener('click', closeViewer);
  $('#viewer').addEventListener('click', (e) => {
    if (e.target.id === 'viewer-retry') { const id = findAttByViewer(); if (id) { retryMedia(id, 'main'); openViewer(id); } return; }
    if (e.target.id === 'viewer' || e.target.id === 'viewer-body') closeViewer();
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#viewer').hidden) closeViewer(); });
}
const findAttByViewer = () => viewing?.id || null;

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

// Context usage as a pill: "ctx 27% · 268k / 1M" with a 4px bar inside. Unknown window size: "ctx 258k", no bar, no percentage.
function ctxBar(c) {
  const v = ctxView(c);
  if (!v) return '';
  return `<span class="ctx${v.level ? ` ${v.level}` : ''}" title="${esc(v.title)}"><span class="ctx-t">${esc(v.chip)}</span>${v.pct === null ? '' : `<i class="ctx-bar"><b style="width:${Math.min(100, Math.max(0, v.pct))}%"></b></i>`}</span>`;
}
// The context a running worker or session reports, looked up in the active-work map by its id.
function workerCtx(id) {
  for (const g of data?.activeMap || []) for (const w of g.workers || []) if (w.id === id && w.context) return w.context;
  return null;
}

// Under "Ada" in the chat header: how full her current session is. Only for the brain the chip shows.
function renderCtx() {
  const el = $('#chat-ctx');
  const c = data?.chat?.thread?.context;
  const v = c && c.agent === brainPref.agent ? ctxView(c) : null;
  el.hidden = !v;
  $('#chat-sub').hidden = !!v && !!data?.chat?.memory; // the "memory loaded" note is dropped when the ctx line is there; "offline" always shows
  el.innerHTML = v ? `${c.model ? `<span class="ch-model">${esc(c.model)}</span>` : ''}${ctxBar(c)}${ctxNeedsFresh(v) ? ' <button type="button" class="link ctx-fresh" data-fresh>Fresh context</button>' : ''}` : '';
}

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
  const retry = needsPinRetry(j, Date.now()) ? `<button class="appr-retry" data-approve="${esc(j.id)}" type="button">${RETRY_TAG}</button>` : '';
  return `<div class="approval-info">
    ${retry}
    <p class="tl-warn" data-approval-expires="${j.approvalExpiresAt}">${approvalOpen(j) ? `Approval expires in ${dur(j.approvalExpiresAt - Date.now())}.` : 'Approval expired. Ask Ada to propose the job again.'}</p>
    ${!data?.chat?.fullModePinSet ? '<p class="tl-warn">Set an approval PIN on the laptop: <code>node tools/set-fullmode-pin.mjs</code></p>' : ''}
    <div class="job-buttons"><button class="tl-approve" data-approve="${esc(j.id)}" type="button" ${enabled ? '' : 'disabled'}>Approve with PIN</button><button class="tl-cancel" data-deny="${esc(j.id)}" type="button" ${wsLive && approvalOpen(j) && !pendingJobActions.has(j.id) ? '' : 'disabled'}>Deny</button></div>
  </div>`;
}

// A queued job the collector is holding back because someone is already working in (or around) its folder.
// "Run anyway" only skips that check; ops/full jobs still need their own approval and PIN.
function holdControls(j) {
  if (j.status !== 'queued' || !j.holdReason) return '';
  return `<div class="hold-info"><p class="tl-warn">Held: ${esc(j.holdReason)}. It starts by itself when that ends.</p><button class="tl-cancel" data-override="${esc(j.id)}" type="button" ${wsLive && !pendingJobActions.has(j.id) ? '' : 'disabled'}>Run anyway</button></div>`;
}

// A worker job, drawn like an agent tool call: one line, tap to expand.
function jobCard(j, ctx = '') {
  if (!j) return '';
  const mode = jobMode(j), awaiting = j.status === 'awaiting-approval';
  const live = j.status === 'running' || j.status === 'queued';
  const icon = j.status === 'running' ? ICON.spin : j.status === 'queued' || awaiting ? ICON.wait : j.status === 'done' ? ICON.ok : ICON.bad;
  const time = j.status === 'running' ? `<span data-since="${j.startedAt}">${since(j.startedAt)}</span>`
    : j.status === 'queued' ? (j.holdReason ? 'held' : 'queued') : j.endedAt && j.startedAt ? dur(j.endedAt - j.startedAt) : j.status;
  return `<details class="tool" data-s="${esc(j.status)}" data-mode="${mode}" data-agent="${esc(j.agent)}" data-job="${esc(j.id)}" ${openJobs.has(j.id) || awaiting || (j.status === 'queued' && j.holdReason) ? 'open' : ''}>
    <summary>
      <span class="tl-ico">${icon}</span>
      <span class="tl-main">
        <span class="tl-title">${modeBadge(j)}${esc(j.title)}</span>
        <span class="tl-sub">${esc(agentLabel[j.agent] || j.agent)}${j.model ? ` · ${esc(j.model)}` : ''} · ${esc(short(j.folder).split(' / ').pop())}</span>
        ${ctx}
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
      ${holdControls(j)}
      ${mode !== 'safe' && j.status === 'running' ? `<button class="tl-cancel" data-kill="${esc(j.id)}" type="button" ${wsLive ? '' : 'disabled'}>Kill job</button>` : live ? `<button class="tl-cancel" data-cancel="${esc(j.id)}" type="button">Cancel job</button>` : ''}
    </div>
  </details>`;
}

// Live strip of active workers, pinned under the chat header. Redrawn on every snapshot (render) and tick.
// Approve/Deny/Kill use the same data attributes and handlers as the job cards (jobActionClick).
const ACTIVE_JOB = ['awaiting-approval', 'running', 'queued', 'killing'];
let stripPref = false; // the user's own expand/collapse choice; a pending approval forces it open
try { stripPref = localStorage.getItem('ada-strip') === '1'; } catch {}
let stripKey = '';

function stripStatus(j) {
  if (j.status === 'awaiting-approval') return approvalOpen(j) ? 'waiting for approval' : 'approval expired';
  if (j.status === 'queued' && j.holdReason) return 'held';
  return j.status === 'killing' ? 'stopping' : j.status;
}

const SRC_LABEL = { terminal: 'Terminal', 'ada-job': 'Ada job', task: 'Task' };
// Subline: "Folder · status". The agent is named only when it is not the usual one (Claude).
const subline = (...parts) => parts.filter(Boolean).join(' · ');
const agentTag = (a) => (a && a !== 'claude' ? agentLabel[a] || a : '');

function stripRow(it) {
  if (it.ext) return extRow(it);
  const j = it.job;
  const mode = jobMode(j);
  const held = j.status === 'queued' && j.holdReason;
  const icon = j.status === 'running' || j.status === 'killing' ? ICON.spin : ICON.wait;
  const from = j.status === 'running' ? j.startedAt : j.createdAt;
  const since0 = Number.isFinite(from) ? from : Date.now();
  const review = j.status === 'awaiting-approval' ? `<button class="ws-review" data-review="${esc(j.id)}" type="button">Review</button>` : '';
  const retry = needsPinRetry(j, Date.now()) ? `<button class="appr-retry" data-approve="${esc(j.id)}" type="button">${RETRY_TAG}</button>` : '';
  const kill = mode !== 'safe' && j.status === 'running' ? `<button class="tl-cancel" data-kill="${esc(j.id)}" type="button" ${wsLive ? '' : 'disabled'}>Kill job</button>` : '';
  return `<div class="ws-row" role="button" tabindex="0" data-s="${esc(j.status)}"${held ? ' data-held="1"' : ''} data-mode="${mode}" data-agent="${esc(j.agent)}" data-focus="${esc(j.id)}"${svOpenAttr(j.agent, j.session)}>
    <div class="ws-line">
      <span class="tl-ico">${icon}</span>
      <span class="tl-main">
        <span class="tl-title">${modeBadge(j)}${esc(j.title)}</span>
        <span class="tl-sub">${esc(subline(it.sub, stripStatus(j), agentTag(j.agent)))}</span>
        ${it.ctx ? ctxBar(it.ctx) : ''}
      </span>
      <span class="tl-time"><span data-since="${since0}">${since(since0)}</span></span>
    </div>
    ${kill}${retry}${review}${holdControls(j)}
  </div>`;
}

// Someone else's work (a terminal session or a delegated task): read-only, Ada can't kill or approve it.
function extRow({ w, sub }) {
  const label = w.status === 'blocked' ? 'waiting on you' : 'working';
  return `<div class="ws-row ws-ext" data-s="${esc(w.status)}" data-agent="${esc(w.agent)}"${svOpenAttr(w.agent, w.id)}>
    <div class="ws-line">
      <span class="tl-ico">${w.status === 'blocked' ? ICON.wait : ICON.spin}</span>
      <span class="tl-main">
        <span class="tl-title">${esc(w.title || 'Session')}</span>
        <span class="tl-sub">${esc(subline(SRC_LABEL[w.source] || w.source, sub, label, agentTag(w.agent)))}</span>
        ${ctxBar(w.context)}
      </span>
      <span class="tl-time"><span data-ago="${w.since}">${ago(w.since)}</span></span>
    </div>
  </div>`;
}

// A terminal row that is really one of Ada's own workers. The collector filters these too; this is the second net.
const isAdaWorker = (w, jobs) => /^\s*Job from Ada\b/i.test(w.title || '') || jobs.some((j) => j.session && j.session === w.id);

// Everything active, as rows grouped by project: Ada's jobs (full controls) plus terminal sessions and tasks from the active-work map.
function stripItems() {
  const rank = (j) => ACTIVE_JOB.indexOf(j.status);
  const all = data?.chat?.jobs || [];
  const jobs = all.filter((j) => ACTIVE_JOB.includes(j.status));
  const place = new Map(); // job id -> the map group it sits in
  const items = [];
  for (const g of data?.activeMap || []) {
    for (const w of g.workers) {
      if (w.source === 'ada-job') place.set(w.id, { g, w });
      else if (w.source === 'terminal' && isAdaWorker(w, all)) continue;
      else items.push({ ext: true, project: g.project, sub: g.subfolder, w, r: 9 });
    }
  }
  for (const j of jobs) {
    const { g, w } = place.get(j.id) || {};
    items.push({ job: j, project: g?.project || short(j.folder).split(' / ').pop(), sub: g?.subfolder || '', r: rank(j), ...(w?.context ? { ctx: w.context } : {}) });
  }
  return items.sort((a, b) => a.project.localeCompare(b.project) || a.r - b.r);
}

// One line that names the work: "● Screenshot live page… · 12s · +1 in terminal ›" (the most recent job and its timer, then a
// short summary of the rest). Approvals are part of it (amber "1 to approve · 4:52"), so there is no separate bar.
function stripSummary(items, jobs) {
  const now = Date.now();
  const awaiting = jobs.filter((j) => j.status === 'awaiting-approval');
  const toApprove = awaiting.filter(approvalOpen).length;
  const expired = awaiting.length - toApprove;
  const held = jobs.filter((j) => j.status === 'queued' && j.holdReason).length;
  const term = items.length - jobs.length;
  const working = jobs.length - awaiting.length - held;
  const soon = soonestExpiry(jobs, now);
  const time = toApprove && soon ? ` · <span data-appr-left>${countdown(soon - now)}</span>` : '';
  const startOf = (it) => { const t0 = it.job ? (it.job.status === 'running' ? it.job.startedAt : it.job.createdAt) : it.w.since; return Number.isFinite(t0) ? t0 : now; };
  if (awaiting.length) {
    const parts = [working ? `${working} working` : '', toApprove ? `${toApprove} to approve` : '', expired ? `${expired} expired` : '', held ? `${held} held` : '', term ? `${term} in terminal` : ''].filter(Boolean);
    return `<span class="ws-dot"></span><span class="ws-sum-t">${esc(parts.join(' · '))}${time}</span>`;
  }
  // The lead is the most recent running Ada job, else the most recent item of any kind.
  const cand = items.filter((i) => i.job && i.job.status !== 'queued').length ? items.filter((i) => i.job && i.job.status !== 'queued') : items;
  const lead = cand.reduce((m, it) => (startOf(it) > startOf(m) ? it : m), cand[0]);
  const rest = items.filter((i) => i !== lead);
  const rj = rest.filter((i) => i.job), rt = rest.length - rj.length;
  const rHeld = rj.filter((i) => i.job.status === 'queued' && i.job.holdReason).length;
  const rWork = rj.length - rHeld;
  const more = [rWork ? `${rWork} working` : '', rHeld ? `${rHeld} held` : '', rt ? `${rt} in terminal` : ''].filter(Boolean);
  const t = startOf(lead);
  const title = lead.job ? lead.job.title : lead.w.title || 'Session';
  return `<span class="ws-dot"></span><span class="ws-sum-t"><span class="ws-lead">${esc(title)}</span> · <span data-since="${t}">${since(t)}</span>${more.length ? ` · +${esc(more.join(', '))}` : ''}</span>`;
}

function renderStrip() {
  const el = $('#work-strip');
  const items = stripItems();
  const jobs = items.filter((i) => i.job).map((i) => i.job);
  const waiting = jobs.some((j) => j.status === 'awaiting-approval');
  const open = stripPref; // rows only on tap; a waiting approval does not grow the header (its line is amber and opens the approvals sheet)
  const key = JSON.stringify([items, jobs.map((j) => [approvalOpen(j), needsPinRetry(j, Date.now())]), wsLive, data?.chat?.fullModePinSet, open]);
  if (key === stripKey) { renderApprovals(); return; }
  stripKey = key;

  $('#ch-count').textContent = '';
  const badge = $('#tab-badge');
  badge.hidden = !jobs.length; // real jobs only: read-only terminal rows are not counted
  badge.textContent = String(jobs.length);

  el.hidden = !items.length;
  if (!items.length) { el.innerHTML = ''; renderApprovals(); return; }
  const multi = new Set(items.map((i) => i.project)).size > 1; // a project header only helps when there are several
  let project = null;
  const rows = open ? items.map((it) => {
    const head = multi && it.project !== project ? `<div class="ws-proj">${esc(it.project)}</div>` : '';
    project = it.project;
    return head + stripRow(it);
  }).join('') : '';
  const s0 = waiting ? 'awaiting-approval' : 'working';
  el.innerHTML = `<div class="ws-head"><button class="ws-sum" ${waiting ? 'data-ws-appr aria-haspopup="dialog"' : 'data-ws-toggle'} type="button" data-s="${s0}">${stripSummary(items, jobs)}</button><button class="ws-exp" data-ws-toggle type="button" aria-expanded="${open}" aria-label="${open ? 'Hide' : 'Show'} workers" data-s="${s0}"><span class="ws-chev">›</span></button></div>${open ? `<div class="ws-rows">${rows}</div>` : ''}`;
  syncJobActions();
  renderApprovals();
}

/* ---------------- Approvals panel ---------------- */
// The strip's amber line opens a sheet listing every job awaiting approval.
// Buttons are approvalControls(): the same data-approve/data-deny handlers and PIN dialog as the job cards.
const BASE_TITLE = document.title;
let seenApprovals = null; // null until the first snapshot, which only seeds
let apprKey = '';

function approvalItem(j) {
  const mode = jobMode(j);
  const op = mode === 'ops' ? j.operation : null;
  const controls = approvalOpen(j) ? approvalControls(j) : '<p class="tl-warn">Expired</p><div class="job-buttons"><button class="tl-approve" type="button" disabled>Expired</button></div>';
  const now = Date.now();
  const pick = selectable(j, now) ? `<label class="appr-pick"><input type="checkbox" data-pick="${esc(j.id)}" ${apprSel.has(j.id) ? 'checked' : ''}>Select</label>` : '';
  const m = approvalOpen(j) ? approvalMessage(j, now) : null;
  const why = m && (m.kind === 'mismatch' || m.kind === 'locked' || (m.kind === 'wrong-pin' && apprSel.has(j.id))) ? `<p class="appr-why">${esc(m.text)}</p>` : '';
  return `<article class="appr-item" data-appr="${esc(j.id)}" data-mode="${mode}"${apprSel.has(j.id) ? ' data-picked' : ''}>
    ${pick}
    <div class="tl-title">${modeBadge(j)}${esc(j.title)}</div>
    ${why}
    <div class="tl-row"><b>Agent</b><span>${esc(mode === 'ops' ? 'Collector · allowlisted operation' : brainLabel(j))}</span></div>
    <div class="tl-row"><b>Project</b><span>${esc(short(j.folder).split(' / ').pop())}</span></div>
    <div class="tl-row"><b>Folder</b><span>${esc(mode === 'safe' ? short(j.folder) : j.folder)}</span></div>
    ${op ? `<div class="tl-row"><b>Operation</b><span>${esc(op.name || '')}</span></div>` : ''}
    <div class="tl-sec dim"><b>${mode === 'ops' ? 'Exact operation' : 'Instructions'}</b>${jobInstructions(j)}</div>
    ${controls}
  </article>`;
}

function renderApprovals() {
  const jobs = data?.chat?.jobs || [];
  const now = Date.now();
  const pending = pendingApprovals(jobs, now);
  const open = openApprovals(jobs, now);
  const hist = resolvedGroups(jobs, now);
  apprSel = pruneSelection(apprSel, jobs, now);

  const found = newApprovals(jobs, seenApprovals, now);
  seenApprovals = found.seen;
  if (found.fresh.length) {
    try { navigator.vibrate?.(100); } catch {}
    openApprovalsPanel(found.fresh[0].id);
  }

  document.title = open.length ? `(${open.length}) ${BASE_TITLE}` : BASE_TITLE;
  const soon = soonestExpiry(jobs, now);
  document.querySelectorAll('[data-appr-left]').forEach((el) => { el.textContent = soon ? countdown(soon - now) : ''; });

  const key = JSON.stringify([pending.map((j) => [j.id, approvalOpen(j), noteKey(j)]), hist.ran.map((j) => [j.id, j.status]), hist.lapsed.map((j) => j.id), wsLive, data?.chat?.fullModePinSet, [...apprSel]]);
  if (key === apprKey) return;
  apprKey = key;
  const act = document.activeElement;
  const focused = act?.dataset?.approve ? 'approve' : act?.dataset?.deny ? 'deny' : act?.dataset?.pick ? 'pick' : null;
  const focusedId = focused && act.dataset[focused];
  $('#appr-list').innerHTML = pending.length ? pending.map(approvalItem).join('') : '<p class="appr-empty">Nothing waiting for approval.</p>';
  const sv = selectionView(apprSel, jobs, now);
  $('#appr-select').hidden = !open.length;
  $('#appr-sel-ops').hidden = !open.some((j) => j.mode === 'ops');
  $('#appr-actions').hidden = !sv.n;
  $('#appr-batch-approve').textContent = `Approve ${sv.n}`;
  $('#appr-batch-deny').textContent = `Deny ${sv.n}`;
  $('#appr-batch-approve').disabled = !wsLive || !data?.chat?.fullModePinSet;
  $('#appr-batch-deny').disabled = !wsLive;
  const histN = hist.ran.length + hist.lapsed.length;
  $('#act-hist').hidden = !histN; // no rows, no section: nothing renders, no heading, no margin
  $('#act-hist-sum').textContent = `Past approvals · ${histN}`;
  const histRow = (j, cls = '') => {
    const t = j.endedAt || j.startedAt || j.createdAt;
    return `<li${cls ? ` class="${cls}"` : ''}><span>${modeBadge(j)}${esc(j.title)}</span><em>${esc(outcomeLabel(j))}</em><time data-ago="${t}">${ago(t)}</time></li>`;
  };
  // Approvals that never ran are not failures: they sit in their own muted group.
  $('#act-hist-list').innerHTML = hist.ran.map((j) => histRow(j)).join('')
    + (hist.lapsed.length ? `<li class="hist-h">Expired / denied</li>${hist.lapsed.map((j) => histRow(j, 'lapsed')).join('')}` : '');
  if (focused) [...document.querySelectorAll(`#appr-list [data-${focused}]`)].find((b) => b.dataset[focused] === focusedId)?.focus();
  syncJobActions();
}

function openApprovalsPanel(id) {
  apprKey = '';
  setSheet('#approvals-sheet', true);
  renderApprovals();
  const el = id && [...document.querySelectorAll('#appr-list [data-appr]')].find((n) => n.dataset.appr === id);
  if (!el) return;
  el.scrollIntoView({ block: 'nearest', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  el.classList.add('flash');
  setTimeout(() => el.classList.remove('flash'), 1600);
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
  const rv = e.target.closest('[data-review]');
  if (rv) { openApprovalsPanel(rv.dataset.review); return; }
  if (e.target.closest('[data-ws-appr]')) { openApprovalsPanel(); return; }
  if (e.target.closest('[data-ws-toggle]')) { stripPref = !stripPref; try { localStorage.setItem('ada-strip', stripPref ? '1' : '0'); } catch {} renderStrip(); return; }
  const so = e.target.closest('[data-sv-open]');
  if (so) { const [a, id] = so.dataset.svOpen.split('|'); selectSession(a, id); return; }
  const row = e.target.closest('[data-focus]');
  if (row) focusJobCard(row.dataset.focus);
}

function adaHead(t, b) {
  return `<div class="ada-head"><span class="ada-av">${ADA_MARK}</span><b>Ada</b>${b?.agent ? `<span class="via" data-agent="${esc(b.agent)}">${esc(brainLabel(b))}</span>` : ''}${t ? `<time data-ago="${t}">${ago(t)}</time>` : ''}</div>`;
}

function tookText(ms) { const s = Math.max(1, Math.round(ms / 1000)); return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`; }

function brainLabel(b) { return `${agentLabel[b.agent] || b.agent}${b.model ? ` · ${b.model}` : ''}`; }

function renderChat() {
  const chat = data?.chat;
  const log = $('#chat-log');
  if (!chat?.thread) {
    log.innerHTML = '<li class="empty">Chat is off — the laptop collector needs a restart with the new version.</li>';
    return;
  }
  svChrome();
  if (svSel) { renderSv(); return; }
  const t = chat.thread;
  const pending = [...outbox.entries()].filter(([cid]) => !t.messages.some((m) => m.cid === cid));
  const jobs = new Map((chat.jobs || []).map((j) => [j.id, j]));
  const busy = !!t.busy;

  const key = JSON.stringify([t, pending, chat.jobs, chat.fullModePinSet, brainPref, wsLive, mediaVer, chat.media]);
  if (key === chatKey) return;
  chatKey = key;

  $('#chat-sub').textContent = chat.memory ? 'memory loaded' : 'memory offline';
  const chip = $('#brain-btn');
  chip.innerHTML = `<i data-agent="${esc(brainPref.agent)}"></i>${esc(brainLabel(brainPref))}<svg viewBox="0 0 24 24"><path d="m7 10 5 5 5-5"/></svg>`;
  const models = chat.brains?.[brainPref.agent] || [''];
  $('#brain-models').innerHTML = models.map((m) => `<button type="button" data-model="${esc(m)}" class="${m === brainPref.model ? 'on' : ''}">${m ? esc(m) : 'Default model'}</button>`).join('');

  renderCtx();
  const nearBottom = log.scrollHeight - log.scrollTop - (log.clientHeight || 0) < 160; // the log scrolls inside its own container
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
  const lastAda = t.messages.findLast((m) => m.role === 'ada');
  for (const m of t.messages) {
    if (m.role === 'user') rows.push(`<li class="msg me">${m.text ? `<div class="bubble">${esc(m.text)}</div>` : ''}${attsHtml(m)}</li>`);
    else if (m.role === 'ada') {
      const cards = (m.jobs || []).map((id) => jobCard(jobs.get(id))).join('');
      rows.push(`<li class="msg ada">${adaHead(m.t, m)}<div class="md">${md(m.text)}</div>${attsHtml(m)}${cards ? `<div class="tools">${cards}</div>` : ''}${m === lastAda && Number.isFinite(m.took) && !busy ? `<div class="took">replied in ${tookText(m.took)}</div>` : ''}</li>`);
    } else if (m.reset) rows.push(`<li class="divider"><span>Fresh context</span></li>`);
    else if (m.role === 'system') rows.push(`<li class="msg sys">${esc(m.text)}</li>`);
  }
  for (const [cid, o] of pending) {
    rows.push(`<li class="msg me ${o.failed ? 'failed' : 'sending'}"><div class="bubble">${esc(o.text)}</div>
      <span class="m-state">${o.failed ? `Not delivered${o.why ? ` (${esc(o.why)})` : ''} · <button type="button" class="link" data-retry="${cid}">Retry</button>` : 'Sending…'}</span></li>`);
  }
  if (busy) {
    // Same markup as the final message, so the streamed bubble is replaced in place. Status comes from the CLI's own tool events.
    const st = t.streaming;
    const text = st?.text || '';
    rows.push(`<li class="msg ada streaming">${adaHead(null, t.brain)}${text ? `<div class="md">${md(text)}</div>` : ''}${st?.status || !text ? `<div class="thinking">${esc(st?.status || 'Thinking')}</div>` : ''}</li>`);
  }
  log.innerHTML = rows.join('');
  syncJobActions();

  // Send turns into stop while Ada is thinking (until you type something to queue).
  const send = $('#chat-send');
  const stopMode = busy && !$('#chat-input').value.trim() && !staged.length;
  send.classList.toggle('stop', stopMode);
  send.setAttribute('aria-label', stopMode ? 'Stop' : 'Send');
  send.disabled = !wsLive;
  $('#chat-hint').textContent = hint || (!wsLive ? 'Laptop not connected' : chat.media && !chat.media.relay ? 'Files need the relay update' : '');
  $('#attach-btn').disabled = !wsLive || !chat.media?.relay;
  watchUploadedGroup(t);
  observeLazy();
  $('#chat-reset').disabled = busy;
  if (nearBottom || pending.length) requestAnimationFrame(() => { log.scrollTop = log.scrollHeight; });
}

async function sendCmd(cmd, upload = false) {
  if (!wsLive || !ws || ws.readyState !== 1) throw new Error('not connected');
  if (!keyCache.key) throw new Error('locked');
  const env = await seal({ kind: 'cmd', ts: Date.now(), ...cmd });
  // {"up":1, marks an upload chunk so the relay gives it the bigger size and its own rate budget.
  ws.send(JSON.stringify(upload ? { up: 1, ...env } : env));
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
  if (id === '#approval-sheet' && !open) { $('#approval-pin').value = ''; clearTimeout(approvalTarget?.sendTimer); approvalTarget = null; clearInterval(approvalTimer); approvalTimer = null; }
  if (id === '#batch-sheet' && !open) { $('#batch-pin').value = ''; clearTimeout(batchTarget?.sendTimer); batchTarget = null; clearInterval(batchTimer); batchTimer = null; }
  $(id).hidden = !open;
  document.body.classList.toggle('sheet-open', !!document.querySelector('.sheet:not([hidden])'));
}

function syncJobActions() {
  document.querySelectorAll('[data-approval-expires]').forEach((el) => {
    const left = Number(el.dataset.approvalExpires) - Date.now();
    el.textContent = left > 0 ? `Approval expires in ${dur(left)}.` : 'Approval expired. Ask Ada to propose the job again.';
  });
  document.querySelectorAll('[data-approve], [data-deny], [data-kill], [data-override]').forEach((el) => {
    const id = el.dataset.approve || el.dataset.deny || el.dataset.kill || el.dataset.override;
    const j = currentJob(id);
    const allowed = el.dataset.override ? j?.status === 'queued' && !!j.holdReason
      : el.dataset.kill ? j?.status === 'running' && jobMode(j) !== 'safe' : approvalOpen(j) && (!el.dataset.approve || data?.chat?.fullModePinSet);
    el.disabled = !wsLive || !allowed || pendingJobActions.has(id);
  });
  if (approvalTarget) syncApprovalDialog();
  if (batchTarget) syncBatchDialog();
}

// Keeps the PIN dialog in step with the job. State is keyed on job id + approvalNote.at, so a late
// message or snapshot from an older attempt cannot close the dialog or replace the newest result.
function syncApprovalDialog() {
  const target = approvalTarget, now = Date.now();
  const j = currentJob(target.id);
  if (j && j.approvalId === target.approval && !['awaiting-approval', 'expired', 'denied'].includes(j.status)) { setSheet('#approval-sheet', false); return; } // approved: it moved on
  const gone = !j || j.approvalId !== target.approval;
  const msg = approvalMessage(j, now);
  if (target.submitting && noteKey(j) !== target.baseKey) { // the laptop answered this attempt
    target.submitting = false;
    clearTimeout(target.sendTimer);
    target.refocus = true;
  }
  const ready = wsLive && data?.chat?.fullModePinSet && !gone && approvalOpen(j) && !msg.locked && !target.submitting;
  $('#approval-submit').disabled = !ready;
  const expiry = $('#approval-expiry');
  if (!gone && j.approvalExpiresAt) {
    expiry.dataset.approvalExpires = j.approvalExpiresAt; expiry.hidden = false;
    expiry.textContent = j.approvalExpiresAt > now ? `Approval expires in ${dur(j.approvalExpiresAt - now)}.` : 'Approval expired. Ask Ada to propose the job again.';
  } else expiry.hidden = true;
  const err = $('#approval-error');
  err.textContent = !wsLive ? 'Laptop not connected. Reconnect before approving.'
    : gone ? 'This approval is no longer available. Close and review the current job card.'
    : target.submitting ? 'Checking PIN…' : target.notice || msg.text;
  err.dataset.kind = target.submitting ? 'busy' : msg.kind;
  if (!ready) $('#approval-pin').value = '';
  if (target.refocus && ready) { target.refocus = false; $('#approval-pin').focus(); }
}

function openApproval(j) {
  if (!wsLive || !approvalOpen(j) || !data?.chat?.fullModePinSet) return;
  approvalTarget = { id: j.id, approval: j.approvalId, baseKey: noteKey(j), submitting: false, notice: '', sendTimer: null, refocus: false };
  $('#approval-pin').value = '';
  clearInterval(approvalTimer);
  approvalTimer = setInterval(() => { if (approvalTarget) syncJobActions(); }, 1000);
  $('#approval-title').textContent = `Approve ${jobMode(j).toUpperCase()} job`;
  $('#approval-review').textContent = `${j.title}\nFolder: ${j.folder}\nAgent: ${jobMode(j) === 'ops' ? 'Collector' : brainLabel(j)}\n\n${jobMode(j) === 'ops' ? operationText(j) : j.prompt || ''}`;
  setSheet('#approval-sheet', true);
  syncJobActions();
  $('#approval-pin').focus();
}

// ---- batch approve: one PIN dialog for every ticked job ----

// The batch's jobs that can still be approved with the approval id they were ticked with.
const batchLive = (target) => target.entries.map((e) => [currentJob(e.id), e.approval]).filter(([j, a]) => j && j.approvalId === a && selectable(j, Date.now())).map(([j]) => j);
const batchKey = (target) => target.entries.map((e) => { const j = currentJob(e.id); return j ? `${j.status}:${noteKey(j)}` : 'gone'; }).join('|');

function syncBatchDialog() {
  const target = batchTarget, now = Date.now();
  const live = batchLive(target);
  if (target.submitting && batchKey(target) !== target.baseKey) { // the laptop answered this attempt
    target.submitting = false;
    clearTimeout(target.sendTimer);
    target.refocus = true;
    const m = batchMessage(live, now);
    if (!live.length || (m.kind !== 'wrong-pin' && !m.locked)) { setSheet('#batch-sheet', false); return; } // PIN accepted: refusals show inline in the sheet
  }
  if (!live.length) { setSheet('#batch-sheet', false); return; }
  const msg = batchMessage(live, now);
  const ready = wsLive && data?.chat?.fullModePinSet && !msg.locked && !target.submitting;
  $('#batch-title').textContent = `Approve ${live.length} job${live.length === 1 ? '' : 's'}`;
  $('#batch-submit').textContent = `Approve ${live.length}`;
  $('#batch-list').innerHTML = live.map((j) => `<li data-mode="${jobMode(j)}">${modeBadge(j)}${esc(j.title)}${jobMode(j) === 'full' ? '<span class="tl-warn">full mode: runs commands</span>' : ''}</li>`).join('');
  $('#batch-submit').disabled = !ready;
  const err = $('#batch-error');
  err.textContent = !wsLive ? 'Laptop not connected. Reconnect before approving.' : target.submitting ? 'Checking PIN…' : target.notice || msg.text;
  err.dataset.kind = target.submitting ? 'busy' : msg.kind;
  if (!ready) $('#batch-pin').value = '';
  if (target.refocus && ready) { target.refocus = false; $('#batch-pin').focus(); }
}

function openBatch() {
  const sv = selectionView(apprSel, data?.chat?.jobs || [], Date.now());
  if (!wsLive || !sv.n || !data?.chat?.fullModePinSet) return;
  batchTarget = { entries: sv.jobs.map((j) => ({ id: j.id, approval: j.approvalId })), baseKey: '', submitting: false, notice: '', sendTimer: null, refocus: false };
  batchTarget.baseKey = batchKey(batchTarget);
  $('#batch-pin').value = '';
  clearInterval(batchTimer);
  batchTimer = setInterval(() => { if (batchTarget) syncBatchDialog(); }, 1000);
  setSheet('#batch-sheet', true);
  syncBatchDialog();
  $('#batch-pin').focus();
}

async function denyBatch() {
  const sv = selectionView(apprSel, data?.chat?.jobs || [], Date.now());
  if (!wsLive || !sv.n) return;
  const ids = sv.jobs.map((j) => j.id);
  ids.forEach((id) => pendingJobActions.add(id));
  syncJobActions();
  try { await sendCmd({ id: rid(), type: 'deny-batch', jobs: batchEntries(sv.jobs) }); }
  catch { ids.forEach((id) => pendingJobActions.delete(id)); syncJobActions(); }
  // Commands are not retried automatically. The next attempt always needs a new tap.
  setTimeout(() => { ids.forEach((id) => pendingJobActions.delete(id)); syncJobActions(); }, 10000);
}

function approvalsSheetClick(e) {
  if (jobActionClick(e)) return;
  const sel = e.target.closest('[data-sel]');
  if (sel) {
    const jobs = data?.chat?.jobs || [], now = Date.now();
    apprSel = sel.dataset.sel === 'all' ? selectAll(jobs, now) : sel.dataset.sel === 'ops' ? selectOps(jobs, now) : new Set();
    apprKey = ''; renderApprovals();
    return;
  }
  const b = e.target.closest('[data-batch]');
  if (b) { if (b.dataset.batch === 'approve') openBatch(); else denyBatch(); }
}

function approvalsSheetChange(e) {
  const pick = e.target.closest?.('[data-pick]');
  if (!pick) return;
  apprSel = toggleSelection(apprSel, pick.dataset.pick, data?.chat?.jobs || [], Date.now());
  apprKey = ''; renderApprovals();
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
  const override = e.target.closest('[data-override]');
  if (override) {
    const j = currentJob(override.dataset.override);
    if (j?.status === 'queued' && j.holdReason) sendJobAction(override, { type: 'override-hold', job: j.id });
    return true;
  }
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
    if (staged.some((f) => f.state === 'ready') && !groupBusy()) {
      if (!wsLive) return;
      input.value = '';
      startUploads(text);
      grow();
      return;
    }
    if (!text) {
      if (data?.chat?.thread?.busy) sendCmd({ type: 'stop', id: rid() }).catch(() => {});
      return;
    }
    if (!wsLive) return;
    input.value = '';
    sendChat(text);
    grow();
  });
  bindAttach();
  $('#chat-menu').addEventListener('click', () => setSheet('#chat-sheet', true));
  $('#chat-ctx').addEventListener('click', (e) => { if (e.target.closest('[data-fresh]')) setSheet('#chat-sheet', true); });
  $('#brain-btn').addEventListener('click', () => setSheet('#brain-sheet', true));
  document.querySelectorAll('.sheet').forEach((s) => s.addEventListener('click', (e) => { if (e.target === s || e.target.closest('[data-close]')) setSheet(`#${s.id}`, false); }));
  $('#approval-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const target = approvalTarget;
    const j = target && currentJob(target.id);
    if (!j || !approvalOpen(j) || j.approvalId !== target.approval || !wsLive) { syncJobActions(); return; }
    if (target.submitting || approvalMessage(j, Date.now()).locked) { syncJobActions(); return; }
    let pin = $('#approval-pin').value;
    $('#approval-pin').value = '';
    if (!pin) { $('#approval-error').textContent = 'Enter your approval PIN.'; return; }
    target.baseKey = noteKey(j); target.notice = ''; target.submitting = true;
    syncJobActions();
    try {
      await sendCmd({ type: 'approve', id: rid(), job: target.id, approval: target.approval, pin });
      // The dialog stays open: it closes when the job leaves awaiting-approval, or shows the refusal from approvalNote.
      target.sendTimer = setTimeout(() => {
        if (approvalTarget !== target || !target.submitting) return;
        target.submitting = false; target.refocus = true; target.notice = 'No answer from the laptop. Re-enter the PIN to try again.';
        syncJobActions();
      }, 15000);
    } catch {
      target.submitting = false; target.refocus = true; target.notice = 'Approval was not sent. Re-enter the PIN to try again.';
      syncJobActions();
    } finally { pin = ''; }
  });
  $('#batch-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const target = batchTarget;
    if (!target) return;
    const live = batchLive(target);
    if (!live.length || !wsLive || target.submitting || batchMessage(live, Date.now()).locked) { syncJobActions(); return; }
    let pin = $('#batch-pin').value;
    $('#batch-pin').value = '';
    if (!pin) { $('#batch-error').textContent = 'Enter your approval PIN.'; return; }
    target.baseKey = batchKey(target); target.notice = ''; target.submitting = true;
    syncJobActions();
    try {
      await sendCmd({ type: 'approve-batch', id: rid(), jobs: live.map((j) => ({ job: j.id, approval: j.approvalId })), pin });
      // Stays open until the laptop answers: refusals come back as approvalNote on the jobs.
      target.sendTimer = setTimeout(() => {
        if (batchTarget !== target || !target.submitting) return;
        target.submitting = false; target.refocus = true; target.notice = 'No answer from the laptop. Re-enter the PIN to try again.';
        syncJobActions();
      }, 15000);
    } catch {
      target.submitting = false; target.refocus = true; target.notice = 'Approval was not sent. Re-enter the PIN to try again.';
      syncJobActions();
    } finally { pin = ''; }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!$('#batch-sheet').hidden) setSheet('#batch-sheet', false);
    else if (!$('#approval-sheet').hidden) setSheet('#approval-sheet', false);
  });
  $('#chat-reset').addEventListener('click', () => {
    sendCmd({ type: 'reset', id: rid() }).catch(() => {});
    setSheet('#chat-sheet', false);
  });
  $('#brain-models').addEventListener('click', (e) => {
    const b = e.target.closest('[data-model]'); if (!b) return;
    brainPref.model = b.dataset.model;
    saveBrain(); chatKey = ''; renderChat(); setSheet('#brain-sheet', false);
  });
  $('#approvals-sheet').addEventListener('click', approvalsSheetClick);
  $('#approvals-sheet').addEventListener('change', approvalsSheetChange);
  $('#work-strip').addEventListener('click', stripClick);
  $('#work-strip').addEventListener('keydown', (e) => {
    if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('[data-sv-open]')) { e.preventDefault(); const [a, id] = e.target.dataset.svOpen.split('|'); selectSession(a, id); }
    else if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('[data-focus]')) { e.preventDefault(); focusJobCard(e.target.dataset.focus); }
  });
  $('#chat-log').addEventListener('click', (e) => {
    if (jobActionClick(e)) return;
    const op = e.target.closest('[data-open]');
    if (op) { openViewer(op.dataset.open); return; }
    const lz = e.target.closest('[data-lazy]');
    if (lz) { const [id, part] = lz.dataset.lazy.split(':'); retryMedia(id, part); }
    const sg = e.target.closest('[data-suggest]');
    if (sg) { input.value = sg.dataset.suggest; grow(); input.focus(); return; }
    const c = e.target.closest('[data-cancel]');
    if (c) { c.disabled = true; c.textContent = 'Cancelling…'; sendCmd({ type: 'cancel', id: rid(), job: c.dataset.cancel }).catch(() => {}); return; }
    const st = e.target.closest('[data-sv-tool]');
    if (st) { const id = Number(st.dataset.svTool); if (svOpenTools.has(id)) svOpenTools.delete(id); else svOpenTools.add(id); svKeyDone = ''; renderSv(); return; }
    if (e.target.closest('[data-sv-retry]')) { svRetry(); return; }
    const r = e.target.closest('[data-retry]');
    if (r) { const o = outbox.get(r.dataset.retry); if (o) { outbox.delete(r.dataset.retry); sendChat(o.text); } }
  });
  $('#sv-bar').addEventListener('click', (e) => {
    if (e.target.closest('[data-sv-map]')) { openMap(); return; }
    if (e.target.closest('[data-sv-ada]')) { backToAda(); return; }
    const c = e.target.closest('[data-sv]');
    if (c) { const [a, id] = c.dataset.sv.split('|'); selectSession(a, id); }
  });
  $('#map-close').addEventListener('click', closeMap);
  $('#map-sheet').addEventListener('click', (e) => { if (e.target === $('#map-sheet')) closeMap(); });
  $('#map-body').addEventListener('click', mapClick);
  $('#sv-banner').addEventListener('click', (e) => {
    if (e.target.closest('[data-sv-back]')) backToAda();
    else if (e.target.closest('[data-sv-retry]')) svRetry();
  });
  $('#sv-actions').addEventListener('click', (e) => {
    if (e.target.closest('[data-sv-ask]')) askAboutSession();
    else if (e.target.closest('[data-sv-back]')) backToAda();
  });
  // Remember which job cards are expanded across re-renders.
  $('#chat-log').addEventListener('toggle', (e) => {
    const d = e.target; if (!d.dataset?.job) return;
    if (d.open) openJobs.add(d.dataset.job); else openJobs.delete(d.dataset.job);
  }, true);
}

/* ---------------- session viewer: read-only look into a worker's or a terminal session's conversation ---------------- */
// The laptop answers each sealed 'session-view' request with sealed chunks on the media channel (see onMediaChunk).
// The page only ever names an agent and a session id from the list the snapshot carries; there is no way to send into a session.
const SV_POLL = 3000, SV_SLOW = 10000, SV_QUIET = 5 * 60e3, SV_STOP = 30 * 60e3, SV_KEEP = 400;
const SV_SRC = { job: 'Job', terminal: 'Terminal', task: 'Task' };
let svSel = null;                 // { agent, session } while a conversation is open; null = Ada
let svTok = 0;                    // bumps on every selection so late answers for a closed view are ignored
let sv = svFresh();
let svKeyDone = '';
let svChromeKey = '';
const svOpenTools = new Set();    // tool entries (by i) whose result is expanded
const svPending = new Map();      // request id -> { chunks, n, res, rej, timer }

function svFresh() {
  return { state: 'loading', entries: [], next: -1, err: '', warn: '', status: '', ctx: null, lastNew: Date.now(), busy: false, timer: null, stopped: false, shown: false, title: '', source: '' };
}
const svList = () => (Array.isArray(data?.chat?.sessions) ? data.chat.sessions : []);
const svId = (s) => `${s.agent}|${s.session}`;
const svLive = (st) => st === 'working' || st === 'blocked';
const svMeta = () => svList().find((s) => svSel && s.agent === svSel.agent && s.session === svSel.session) || null;
const svTitle = (s) => String(s?.title || s?.project || 'Session').replace(/\s+/g, ' ').trim();
function svOpenAttr(agent, session) {
  if ((agent !== 'claude' && agent !== 'codex' && agent !== 'task') || typeof session !== 'string' || !/^[\w-]{8,64}$/.test(session)) return '';
  return ` role="button" tabindex="0" data-sv-open="${esc(agent)}|${esc(session)}"`;
}

function svChip(s) {
  const v = ctxView(s.context);
  const label = svTitle(s);
  const on = svSel && svSel.agent === s.agent && svSel.session === s.session;
  const where = s.project ? ` · ${s.project}${s.subfolder ? ` › ${s.subfolder}` : ''}` : '';
  const pct = v && v.pct !== null ? `<span class="sv-pct${v.level ? ` ${v.level}` : ''}">${v.pct}%</span>` : '';
  return `<button type="button" class="sv-chip${on ? ' on' : ''}" data-sv="${esc(svId(s))}" data-s="${esc(s.status)}" data-agent="${esc(s.agent)}" title="${esc(label + where)}"><i class="sv-dot"></i><span class="sv-t">${esc(label.length > 24 ? `${label.slice(0, 23)}…` : label)}</span><span class="sv-tag">${esc(s.finished ? 'finished' : SV_SRC[s.source] || s.source || '')}</span>${pct}</button>`;
}

// The row of chips under the chat header: Ada, Map, then only the active chats (plus the viewed one, marked finished).
function renderSwitcher() {
  const el = $('#sv-bar');
  let list = svList();
  if (svSel && !list.some((s) => s.agent === svSel.agent && s.session === svSel.session)) {
    list = [...list, { agent: svSel.agent, session: svSel.session, title: sv.title || 'Session', source: sv.source || 'terminal', status: sv.status || 'idle' }];
  }
  const key = JSON.stringify([list, svSel]);
  if (key === el.dataset.k) return;
  el.dataset.k = key;
  el.hidden = !list.length;
  const act = ribbonSessions(list, svSel);
  el.innerHTML = `<button type="button" class="sv-chip sv-ada${svSel ? '' : ' on'}" data-sv-ada><span class="sv-t">Ada</span></button><button type="button" class="sv-chip sv-map" data-sv-map aria-label="Chats map"><span class="sv-t">Map</span></button>${act.map(svChip).join('')}`;
}

// Banner, switcher and the composer/actions swap. Cheap enough to run on every chat render.
function svChrome() {
  renderSwitcher();
  if (!$('#map-sheet').hidden) renderMap();
  const on = !!svSel;
  $('#composer').hidden = on;
  $('#sv-actions').hidden = !on;
  const b = $('#sv-banner');
  b.hidden = !on;
  if (!on) { svChromeKey = ''; return; }
  const m = svMeta();
  const status = sv.status || m?.status || '';
  const live = svLive(status);
  const title = m ? svTitle(m) : sv.title || 'Session';
  const html = `<div class="sv-b1"><span class="sv-dot${live ? ' live' : ''}"></span><span class="sv-bt">Viewing <b>${esc(title)}</b> · ${esc(SV_SRC[m?.source || sv.source] || 'Session')} · read-only</span><button type="button" class="link sv-back" data-sv-back>Back to Ada</button></div>`
    + `<div class="sv-b2"><span>${esc(agentLabel[svSel.agent] || svSel.agent)} · ${live ? 'live' : esc(status || 'quiet')}${sv.stopped ? ' · paused (quiet)' : ''}${sv.warn ? ` · ${esc(sv.warn)}` : ''}</span>${ctxBar(sv.ctx || m?.context)}${sv.stopped || sv.warn ? '<button type="button" class="link" data-sv-retry>Refresh</button>' : ''}</div>`;
  if (html !== svChromeKey) { svChromeKey = html; b.innerHTML = html; }
}

function svToolRow(e, r) {
  const id = (e || r).i;
  const open = svOpenTools.has(id);
  const body = open ? `<pre class="sv-res">${esc(r ? r.text || '(empty)' : 'no output yet')}</pre>` : '';
  return `<li class="sv-tool${open ? ' open' : ''}${r?.error ? ' err' : ''}"><button type="button" class="sv-tl" data-sv-tool="${id}" aria-expanded="${open}"><span class="sv-tn">${esc(e?.tool || 'result')}</span><span class="sv-tx">${esc(e?.text || '')}</span><span class="sv-ch">›</span></button>${body}</li>`;
}

function svRows() {
  const rows = [];
  const es = sv.entries;
  for (let k = 0; k < es.length; k++) {
    const e = es[k];
    if (e.kind === 'text' && e.role === 'user') rows.push(`<li class="msg me sv-u"><div class="bubble">${esc(e.text)}</div></li>`);
    else if (e.kind === 'text') {
      rows.push(`<li class="msg ada sv-a" data-agent="${esc(svSel.agent)}"><div class="sv-who"><b>${esc(agentLabel[svSel.agent] || svSel.agent)}</b>${e.t ? `<time data-ago="${e.t}">${ago(e.t)}</time>` : ''}</div><div class="md">${md(e.text)}</div></li>`);
    } else if (e.kind === 'tool') rows.push(svToolRow(e, es[k + 1]?.kind === 'result' ? es[++k] : null));
    else rows.push(svToolRow(null, e));
  }
  return rows;
}

function renderSv() {
  const log = $('#chat-log');
  const key = JSON.stringify([svSel, sv.state, sv.err, sv.entries.length, sv.entries.at(-1)?.i, [...svOpenTools]]);
  if (key === svKeyDone) return;
  svKeyDone = key;
  const nearBottom = log.scrollHeight - log.scrollTop - (log.clientHeight || 0) < 160;
  let html;
  if (sv.state === 'error') html = `<li class="msg sys sv-state err">Couldn’t load this conversation: ${esc(sv.err || 'unknown error')}<br><button type="button" class="link" data-sv-retry>Try again</button></li>`;
  else if (sv.state === 'loading') html = '<li class="msg sys sv-state">Loading conversation…</li>';
  else if (!sv.entries.length) html = '<li class="msg sys sv-state">Nothing in this conversation yet.</li>';
  else html = svRows().join('');
  log.innerHTML = html;
  const first = !sv.shown && sv.state === 'ready';
  if (first) sv.shown = true;
  if (nearBottom || first) requestAnimationFrame(() => { log.scrollTop = log.scrollHeight; });
}

function onSvChunk(o) {
  const p = svPending.get(o.sv);
  if (!p || !Number.isInteger(o.i) || !Number.isInteger(o.n) || o.n < 1 || o.n > 64) return;
  p.chunks.set(o.i, String(o.d));
  p.n = o.n;
  if (p.chunks.size < p.n) return;
  clearTimeout(p.timer);
  svPending.delete(o.sv);
  try { p.res(JSON.parse([...Array(p.n).keys()].map((i) => p.chunks.get(i)).join(''))); } catch { p.rej(new Error('unreadable reply')); }
}

function svRequest(agent, session, after) {
  return new Promise((res, rej) => {
    const id = rid();
    const timer = setTimeout(() => { svPending.delete(id); rej(new Error('no answer from the laptop')); }, 15000);
    svPending.set(id, { chunks: new Map(), n: 0, res, rej, timer });
    sendCmd({ type: 'session-view', id, agent, session, ...(Number.isInteger(after) && after >= 0 ? { after } : {}) })
      .catch((e) => { clearTimeout(timer); svPending.delete(id); rej(e); });
  });
}

// A delegated task has no transcript: show its title, status and preview from the snapshot's task list.
function svTaskView() {
  const k = (data?.tasks || []).find((x) => `task-${x.id}` === svSel.session);
  const lines = k ? [`**${k.title || 'Task'}**`, `Status: ${k.status}${k.agent ? ` · ${k.agent}` : ''}${k.cwd ? ` · ${short(k.cwd).split(' / ').pop()}` : ''}`, k.preview || ''].filter(Boolean) : ['This task is no longer in the log.'];
  sv.entries = [{ i: k?.updatedAt || 1, kind: 'text', role: 'assistant', text: lines.join('\n\n') }];
  sv.state = 'ready'; sv.err = ''; sv.status = k ? (k.status === 'running' ? 'working' : k.status) : '';
}

async function svPoll() {
  if (!svSel || sv.busy) return;
  if (svSel.agent === 'task') { svTaskView(); svRefresh(); svSchedule(); return; }
  const me = sv;
  me.busy = true;
  clearTimeout(me.timer);
  if (data?.chat?.media && !data.chat.media.relay) {
    me.state = 'error'; me.err = 'needs the relay update to carry sessions'; me.busy = false;
    svRefresh(); svSchedule();
    return;
  }
  try {
    const res = await svRequest(svSel.agent, svSel.session, me.next);
    if (me !== sv) return;
    if (!res.ok) {
      if (res.err !== 'slow down') { if (me.entries.length) me.warn = res.err; else { me.state = 'error'; me.err = res.err; } }
    } else {
      me.err = ''; me.warn = ''; me.state = 'ready';
      me.status = res.status || me.status;
      if ('context' in res) me.ctx = res.context;
      if (res.entries.length) {
        const have = new Set(me.entries.map((e) => e.i));
        me.entries = [...me.entries, ...res.entries.filter((e) => !have.has(e.i))].slice(-SV_KEEP);
        me.lastNew = Date.now();
      }
      me.next = Math.max(me.next, res.next);
    }
  } catch (e) {
    if (me === sv) { if (me.entries.length) me.warn = e.message; else { me.state = 'error'; me.err = e.message; } }
  } finally {
    me.busy = false;
    if (me === sv) { svRefresh(); svSchedule(); }
  }
}

function svRefresh() { chatKey = ''; if (data) renderChat(); }

// Every 3 s while the view is open and the page visible; 10 s once nothing new has come for 5 min;
// stops after 30 quiet minutes of an ended session (Refresh resumes).
function svSchedule() {
  clearTimeout(sv.timer);
  if (!svSel || document.hidden) return;
  const quiet = Date.now() - sv.lastNew;
  const live = svLive(sv.status || svMeta()?.status);
  if (!live && quiet > SV_STOP) { sv.stopped = true; svRefresh(); return; }
  sv.timer = setTimeout(svPoll, sv.state === 'error' || quiet > SV_QUIET ? SV_SLOW : SV_POLL);
}

function svRetry() {
  if (!svSel) return;
  sv.stopped = false; sv.warn = ''; sv.lastNew = Date.now();
  if (!sv.entries.length) { sv.state = 'loading'; sv.err = ''; }
  svRefresh();
  svPoll();
}

function svVisibility() {
  if (!svSel) return;
  if (document.hidden) clearTimeout(sv.timer); else if (!sv.stopped) svPoll();
}

function selectSession(agent, session) {
  if ((agent !== 'claude' && agent !== 'codex' && agent !== 'task') || typeof session !== 'string') return;
  if (svSel && svSel.agent === agent && svSel.session === session) return;
  clearTimeout(sv.timer);
  svSel = { agent, session };
  sv = svFresh();
  const m = svMeta();
  sv.title = m?.title || ''; sv.source = m?.source || ''; sv.status = m?.status || '';
  svOpenTools.clear();
  svKeyDone = '';
  svRefresh();
  svPoll();
}

function backToAda() {
  if (!svSel) return;
  clearTimeout(sv.timer);
  svSel = null;
  sv = svFresh();
  svKeyDone = '';
  svRefresh();
  requestAnimationFrame(() => { const log = $('#chat-log'); log.scrollTop = log.scrollHeight; });
}

// "Ask Ada about this": a draft in the main chat that names the session; nothing is sent to the session itself.
function askAboutSession() {
  if (!svSel) return;
  const m = svMeta();
  const title = svTitle(m || { title: sv.title }).replace(/[[\]]/g, '').slice(0, 60);
  const draft = `[re: ${title} session ${svSel.session.slice(0, 8)}] `;
  backToAda();
  const input = $('#chat-input');
  input.value = draft + input.value;
  input.style.height = 'auto';
  input.style.height = `${Math.min(input.scrollHeight, 168)}px`;
  input.focus();
}

/* ---------------- chats map: Ada > project > folders > sessions, drawn as a branching tree ---------------- */
const MP_KEY = 'ada-map-shut', MP_DEEP = 4;
function mapShutLoad() {
  try { const v = JSON.parse(localStorage.getItem(MP_KEY) || 'null'); if (Array.isArray(v)) return new Set(v.filter((x) => typeof x === 'string').slice(-200)); } catch {}
  return new Set([RECENT_ID]);   // Recent starts collapsed
}
const mapShut = mapShutLoad();
const mapShutSave = () => { try { localStorage.setItem(MP_KEY, JSON.stringify([...mapShut])); } catch {} };
const mapAgo = (ageMs) => (Number.isFinite(ageMs) ? ago(Date.now() - ageMs) : '');

function mapLeaf(n) {
  const m = n.meta;
  const attr = svOpenAttr(m.agent, m.session).replace(' role="button" tabindex="0"', '');
  return `<li class="mp-n mp-leaf${m.recent ? ' recent' : ''}"><button type="button" class="mp-card" data-s="${esc(m.status)}" data-agent="${esc(m.agent)}"${attr || ' disabled'} title="${esc(n.label)}"><span class="mp-r1"><i class="sv-dot"></i><span class="mp-t">${esc(n.label)}</span><time class="mp-age">${esc(mapAgo(m.ageMs))}</time></span><span class="mp-r2"><span class="sv-tag">${esc(SV_SRC[m.source] || m.source || 'Session')}</span><span class="mp-ag">${esc(agentLabel[m.agent] || m.agent)}</span>${ctxBar(m.ctx)}</span></button></li>`;
}

function mapNode(n, depth) {
  if (n.kind === 'session') return mapLeaf(n);
  const shut = mapShut.has(n.id), m = n.meta;
  const count = n.id === RECENT_ID ? m.count : m.live;
  const sub = n.id === RECENT_ID ? `${count} finished · 24h` : `${count} live`;
  const kids = shut ? '' : `<ul class="mp-kids">${n.children.map((c) => mapNode(c, depth + 1)).join('')}</ul>`;
  return `<li class="mp-n mp-group${depth > MP_DEEP ? ' deep' : ''}${m.recent ? ' recent' : ''}" data-kind="${n.kind}"><button type="button" class="mp-card mp-gc" data-mp-toggle="${esc(n.id)}" aria-expanded="${!shut}"><span class="mp-caret">›</span><span class="mp-t">${esc(n.label)}</span><span class="mp-count">${esc(sub)}</span></button>${kids}</li>`;
}

function mapHtml(tree) {
  const root = `<button type="button" class="mp-card mp-root" data-mp-root><span class="mp-r1"><i class="sv-dot${tree.meta.status === 'working' ? ' live' : ''}"></i><span class="mp-t">Ada</span>${svSel ? '<span class="mp-age">back to chat</span>' : '<span class="mp-age">main chat</span>'}</span>${ctxView(tree.meta.ctx) ? `<span class="mp-r2">${ctxBar(tree.meta.ctx)}</span>` : ''}</button>`;
  const note = tree.meta.note ? `<p class="mp-empty">${esc(tree.meta.note)}</p>` : '';
  return `${root}${note}<ul class="mp-kids mp-top">${tree.children.map((c) => mapNode(c, 1)).join('')}</ul>`;
}

function renderMap() {
  const tree = buildSessionMap(data, Date.now());
  $('#map-title').textContent = `Chats map · ${activeCount(tree)} active`;
  const html = mapHtml(tree);
  const body = $('#map-body');
  if (body.dataset.k !== html) { body.dataset.k = html; body.innerHTML = html; }
}

function openMap() { renderMap(); setSheet('#map-sheet', true); }
function closeMap() { setSheet('#map-sheet', false); }

function mapClick(e) {
  const tg = e.target.closest('[data-mp-toggle]');
  if (tg) {
    const id = tg.dataset.mpToggle;
    if (mapShut.has(id)) mapShut.delete(id); else mapShut.add(id);
    mapShutSave(); $('#map-body').dataset.k = ''; renderMap();
    return;
  }
  const op = e.target.closest('[data-sv-open]');
  if (op) { const [a, id] = op.dataset.svOpen.split('|'); closeMap(); selectSession(a, id); return; }
  if (e.target.closest('[data-mp-root]')) { closeMap(); backToAda(); }
}

/* ---------------- activity (tiles, attention, now, by project, full timeline) ---------------- */
let actFilter = 'all';
let actRange = '7d';
let projShown = PROJECT_LIMIT;
let fullOpen = false;
const openTasks = new Set();
const openProj = new Set();

function dayLabel(t) {
  const d = new Date(t), now = new Date();
  const days = Math.round((new Date(now.toDateString()) - new Date(d.toDateString())) / 86400e3);
  return days === 0 ? 'Today' : days === 1 ? 'Yesterday' : d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
}

function taskCard(k, ctx = '') {
  const live = k.status === 'running' || k.status === 'queued';
  const icon = k.status === 'running' ? ICON.spin : k.status === 'queued' ? ICON.wait : k.status === 'done' ? ICON.ok : ICON.bad;
  return `<details class="tool act-task" data-s="${esc(k.status)}" data-mode="${jobMode(k)}" data-agent="${esc(k.agent || 'task')}" data-task="${esc(k.id)}" ${openTasks.has(k.id) || live ? 'open' : ''}>
    <summary>
      <span class="tl-ico">${icon}</span>
      <span class="tl-main">
        <span class="tl-title">${modeBadge(k)}${esc(taskTitle(k))}</span>
        <span class="tl-sub">${esc(agentLabel[k.agent] || k.agent || 'Task')}${k.by === 'ada-chat' ? ' · from Ada chat' : ''}${k.cwd ? ` · ${esc(short(k.cwd).split(' / ').pop())}` : ''}</span>
        ${ctx}
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

// What changed in the projects (commits, branches, uncommitted files, finished terminal sessions), whoever did it.
function changeText(e) {
  switch (e.kind) {
    case 'commit': return `Commit ${e.hash}: ${e.subject}`;
    case 'branch': return `Branch ${e.from || '?'} → ${e.to}`;
    case 'dirty': return `${e.count} uncommitted file${e.count === 1 ? '' : 's'}${e.files?.length ? `: ${e.files.join(', ')}` : ''}`;
    case 'session': return `${e.agent} session ended${e.sub ? ` in ${e.sub}` : ''} after ${Math.max(1, Math.round(e.durMs / 60e3))} min${e.note ? `: ${e.note}` : ''}`;
    default: return e.kind;
  }
}

function eventRow(i) {
  return `<li class="act-row ${i.error ? 'err' : ''}" data-agent="${esc(i.agent)}" data-kind="${esc(i.kind)}">
    <span class="ar-dot"></span>
    <div class="ar-body">
      <div class="ar-meta"><b>${i.kind === 'prompt' ? 'You' : esc(agentLabel[i.agent] || i.agent)}</b>${i.cwd ? `<span>${esc(short(i.cwd).split(' / ').pop())}</span>` : ''}<time data-ago="${i.t}">${ago(i.t)}</time></div>
      <div class="ar-text">${esc(i.text)}</div>
    </div>
  </li>`;
}

const fmt = (n) => (n === null || n === undefined ? '—' : String(n));

const TILES = [
  ['active', 'Active now'], ['done', 'Tasks done'], ['failed', 'Failed'],
  ['commits', 'Commits'], ['unpushed', 'Unpushed'], ['sessions', 'Sessions'],
];

function renderTiles(stats) {
  $('#act-tiles').innerHTML = TILES.map(([k, label]) => `<button type="button" class="tile${stats[k] ? ' on' : ''}" data-tile="${k}"><b>${fmt(stats[k])}</b><span>${label}</span></button>`).join('');
}

const ATTN_LABEL = { failed: 'Failed', held: 'Held', unpushed: 'Unpushed', limit: 'Limit' };

// Failed items can be dismissed; the ids live on this device only.
let dismissed = [];
try { dismissed = parseDismissed(localStorage.getItem('ada-dismissed')); } catch {}
const saveDismissed = () => { try { localStorage.setItem('ada-dismissed', JSON.stringify(dismissed)); } catch {} };
let showDismissed = false, failedAll = false, unpushedAll = false, unpushedOpen = false;
let attnFailedIds = []; // what "Dismiss all" will dismiss right now

const attnInner = (a) => `<span class="attn-k">${ATTN_LABEL[a.kind]}</span><span class="attn-t">${esc(a.title)}</span><span class="attn-d">${esc(a.detail)}${a.t ? ` · <time data-ago="${a.t}">${ago(a.t)}</time>` : ''}</span>`;

function attnRow(a, extra = '') {
  if (a.kind === 'limit') return `<div class="attn-row" data-kind="limit">${attnInner(a)}</div>`;
  return `<button type="button" class="attn-row" data-kind="${esc(a.kind)}" data-attn="${esc(a.kind)}" data-id="${esc(a.id)}">${attnInner(a)}</button>${extra}`;
}

function renderAttention(list) {
  const v = attentionView(list, { dismissed, failedAll, unpushedAll });
  attnFailedIds = v.failedIds;
  const u = v.unpushed;
  const rows = [
    ...v.failed.map((a) => `<div class="attn-wrap">${attnRow(a, `<button type="button" class="attn-x" data-dismiss="${esc(a.id)}" aria-label="Dismiss ${esc(a.title)}">×</button>`)}</div>`),
    v.failedHidden ? `<button type="button" class="ws-more" data-attn-more>Show ${v.failedHidden} more</button>` : '',
    ...v.others.map((a) => attnRow(a)),
    u.projects ? `<button type="button" class="attn-row attn-fold" data-kind="unpushed" data-unpushed-toggle aria-expanded="${unpushedOpen}"><span class="attn-k">Unpushed</span><span class="attn-t">${u.projects} project${u.projects === 1 ? ' has' : 's have'} unpushed commits (total ${u.total})</span>${ICON.chev}</button>` : '',
    u.projects && unpushedOpen ? `<div class="attn-sub">${u.items.map((a) => attnRow(a)).join('')}${u.hidden ? `<button type="button" class="ws-more" data-unpushed-all>Show all ${u.projects}</button>` : ''}</div>` : '',
  ].join('');
  const dis = v.dismissed.length
    ? `<button type="button" class="link attn-dis" data-show-dismissed>${showDismissed ? 'Hide' : 'Show'} dismissed (${v.dismissed.length})</button>${showDismissed ? `<div class="attn dim">${v.dismissed.map((a) => `<div class="attn-wrap">${attnRow(a, `<button type="button" class="attn-x attn-restore" data-restore="${esc(a.id)}">Restore</button>`)}</div>`).join('')}</div>` : ''}`
    : '';
  $('#act-attn').innerHTML = rows || dis
    ? `<h2 class="sec sec-row"><span>Needs attention <small>${v.count}</small></span>${v.failedIds.length > 1 ? '<button type="button" class="link attn-all" data-dismiss-all>Dismiss all</button>' : ''}</h2>${rows ? `<div class="attn">${rows}</div>` : ''}${dis}` : '';
}

// A short-lived message with an Undo button.
let toastTimer = null, toastUndo = null;
function toast(msg, undo) {
  const el = $('#toast');
  toastUndo = undo || null;
  el.innerHTML = `<span>${esc(msg)}</span>${undo ? '<button type="button" data-undo>Undo</button>' : ''}`;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; toastUndo = null; }, 6000);
}

function dismissIds(ids) {
  if (!ids.length) return;
  dismissed = addDismissed(dismissed, ids);
  saveDismissed();
  renderActivity();
  toast(ids.length === 1 ? 'Dismissed' : `Dismissed ${ids.length}`, () => { dismissed = removeDismissed(dismissed, ids); saveDismissed(); renderActivity(); });
}

function renderNow(waiting) {
  const groups = nowGroups(data);
  const jobs = new Map((data.chat?.jobs || []).map((j) => [j.id, j]));
  const tasks = new Map((data.tasks || []).map((k) => [k.id, k]));
  if (!groups.length && !waiting) { $('#act-now').innerHTML = ''; return; }
  const body = groups.map((g) => `<div class="now-grp">${g.workers.map((w) => {
    const label = `<span class="now-src">${esc([g.project, g.subfolder].filter(Boolean).join(' › '))} · ${esc(SRC_LABEL[w.source] || w.source)}</span>`;
    if (w.source === 'ada-job' && jobs.has(w.id)) return `<div class="now-item">${label}${jobCard(jobs.get(w.id), ctxBar(w.context))}</div>`;
    if (w.source === 'task' && tasks.has(w.id)) return `<div class="now-item">${label}${taskCard(tasks.get(w.id), ctxBar(w.context))}</div>`;
    return `<div class="now-item">${label}${extRow({ w, sub: g.subfolder })}</div>`;
  }).join('')}</div>`).join('');
  $('#act-now').innerHTML = `<h2 class="sec">Now <small>${groups.reduce((n, g) => n + g.workers.length, 0)}</small></h2>
    ${waiting ? `<button type="button" class="act-appr" data-act-appr>${waiting} waiting for approval <span>Review ›</span></button>` : ''}
    ${body}`;
}

// One compact line for a project history item.
function itemLine(x) {
  if (x.type === 'task') return { k: 'Task', text: `${taskTitle(x.task)} — ${x.task.status}` };
  if (x.type === 'event') return { k: x.item.kind === 'prompt' ? 'You' : agentLabel[x.item.agent] || x.item.agent, text: x.item.text };
  return { k: x.change.by || 'Change', text: changeText(x.change) };
}

const lineHtml = (x) => {
  const l = itemLine(x);
  return `<div class="ap-line"><span class="ap-k">${esc(l.k)}</span><span class="ap-t">${esc(l.text)}</span><time data-ago="${x.t}">${ago(x.t)}</time></div>`;
};

function historyHtml(items) {
  let day = '';
  return items.slice(0, 60).map((x) => {
    const d = dayLabel(x.t);
    const sep = d !== day ? `<div class="act-day">${esc(d)}</div>` : '';
    day = d;
    if (x.type === 'task') return `${sep}<div class="act-card">${taskCard(x.task)}</div>`;
    if (x.type === 'event') return `${sep}<ul class="act-list">${eventRow(x.item)}</ul>`;
    return sep + lineHtml(x);
  }).join('');
}

function activityProjectCard(g) {
  const chips = [['tasks', 'task'], ['sessions', 'session'], ['commits', 'commit'], ['unpushed', 'unpushed']]
    .filter(([k]) => g.counts[k]).map(([k, w]) => `<span class="ap-chip" data-k="${k}">${k === 'unpushed' ? `${g.counts[k]} unpushed` : plural(g.counts[k], w)}</span>`).join('');
  const prev = g.items.slice(0, 3).map(lineHtml).join('');
  return `<details class="act-proj" data-proj="${esc(g.key)}" ${openProj.has(g.key) ? 'open' : ''}>
    <summary>
      <div class="ap-head"><span class="ap-name">${esc(g.name)}</span><time class="ago" data-ago="${g.last}">${ago(g.last)}</time>${ICON.chev}</div>
      ${chips ? `<div class="ap-chips">${chips}</div>` : ''}
      ${g.ctx ? `<div class="ap-ctx"><span>${esc(agentLabel[g.ctx.agent] || g.ctx.agent)} session</span>${ctxBar(g.ctx.context)}</div>` : ''}
      ${prev ? `<div class="ap-prev">${prev}</div>` : ''}
    </summary>
    <div class="ap-body">${g.items.length ? historyHtml(g.items) : '<div class="empty">No recorded activity.</div>'}</div>
  </details>`;
}

function renderProjects() {
  const groups = byProject(data);
  if (!groups.length) { $('#act-projects').innerHTML = ''; return; }
  const shown = groups.slice(0, projShown);
  $('#act-projects').innerHTML = `<h2 class="sec">By project <small>${groups.length}</small></h2>${shown.map(activityProjectCard).join('')}${groups.length > shown.length ? `<button type="button" class="ws-more ap-more" data-more>Show ${groups.length - shown.length} more</button>` : ''}`;
}

function renderTimeline() {
  const rows = [];
  let day = '';
  for (const x of timelineRows(data, { filter: actFilter, range: actRange }, Date.now())) {
    const d = dayLabel(x.t);
    if (d !== day) { day = d; rows.push(`<li class="act-day">${esc(d)}</li>`); }
    rows.push(x.task ? `<li class="act-card">${taskCard(x.task)}</li>` : eventRow(x.item));
  }
  $('#act-list').innerHTML = rows.length ? rows.join('') : '<li class="empty">Nothing here yet.</li>';
  $('#act-full').open = fullOpen;
}

function renderActivity() {
  const now = Date.now();
  renderTiles(todayStats(data, now, dismissed));
  renderAttention(needsAttention(data, now));
  renderNow(waitingApprovals(data, now));
  renderProjects();
  renderTimeline();
  syncJobActions();
}

const jump = (el) => el?.scrollIntoView({ block: 'start', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
const projKeyOf = (cwd) => projectOf(data.projects, cwd)?.path || '';

function openProjectCard(key, taskId) {
  projShown = Infinity;
  openProj.add(key);
  if (taskId) openTasks.add(taskId);
  renderProjects();
  jump([...document.querySelectorAll('#act-projects details[data-proj]')].find((d) => d.dataset.proj === key));
}

function setTimeline(filter, range) {
  actFilter = filter; actRange = range; fullOpen = true;
  document.querySelectorAll('#act-filter button').forEach((x) => x.classList.toggle('on', x.dataset.f === filter));
  document.querySelectorAll('#act-range button').forEach((x) => x.classList.toggle('on', x.dataset.r === range));
  renderTimeline();
  jump($('#act-full'));
}

function tileClick(k) {
  const attn = $('#act-attn');
  if (k === 'active') jump($('#act-now'));
  else if (k === 'done') setTimeline('tasks', 'today');
  else if (k === 'failed') (attn.querySelector('[data-attn="failed"]') ? jump(attn) : setTimeline('tasks', 'today'));
  else if (k === 'sessions') setTimeline('agents', 'today');
  else if (k === 'unpushed' && attn.querySelector('[data-unpushed-toggle]')) { unpushedOpen = true; renderActivity(); jump(attn.querySelector('[data-unpushed-toggle]')); }
  else jump($('#act-projects'));
}

function attnClick(kind, id) {
  if (kind === 'unpushed') { openProjectCard(projKeyOf(id)); return; }
  if ((data.chat?.jobs || []).some((j) => j.id === id)) { show('chat'); requestAnimationFrame(() => focusJobCard(id)); return; }
  const task = (data.tasks || []).find((k) => k.id === id);
  if (task) openProjectCard(projKeyOf(task.cwd), id);
}

function bindActivity() {
  const view = $('#view-activity');
  view.addEventListener('click', (e) => {
    if (jobActionClick(e)) return;
    const tile = e.target.closest('[data-tile]');
    if (tile) { tileClick(tile.dataset.tile); return; }
    const x = e.target.closest('[data-dismiss]');
    if (x) { dismissIds([x.dataset.dismiss]); return; }
    if (e.target.closest('[data-dismiss-all]')) { dismissIds(attnFailedIds); return; }
    const rs = e.target.closest('[data-restore]');
    if (rs) { dismissed = removeDismissed(dismissed, [rs.dataset.restore]); saveDismissed(); renderActivity(); return; }
    if (e.target.closest('[data-show-dismissed]')) { showDismissed = !showDismissed; renderActivity(); return; }
    if (e.target.closest('[data-attn-more]')) { failedAll = true; renderActivity(); return; }
    if (e.target.closest('[data-unpushed-toggle]')) { unpushedOpen = !unpushedOpen; renderActivity(); return; }
    if (e.target.closest('[data-unpushed-all]')) { unpushedAll = true; renderActivity(); return; }
    const a = e.target.closest('[data-attn]');
    if (a) { attnClick(a.dataset.attn, a.dataset.id); return; }
    if (e.target.closest('[data-act-appr]')) { show('chat'); openApprovalsPanel(); return; }
    if (e.target.closest('[data-more]')) { projShown = Infinity; renderProjects(); }
  });
  $('#toast').addEventListener('click', (e) => {
    if (!e.target.closest('[data-undo]')) return;
    const undo = toastUndo;
    toastUndo = null;
    $('#toast').hidden = true;
    undo?.();
  });
  $('#act-filter').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    actFilter = b.dataset.f;
    document.querySelectorAll('#act-filter button').forEach((x) => x.classList.toggle('on', x === b));
    renderTimeline();
  });
  $('#act-range').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    actRange = b.dataset.r;
    document.querySelectorAll('#act-range button').forEach((x) => x.classList.toggle('on', x === b));
    renderTimeline();
  });
  view.addEventListener('toggle', (e) => {
    const d = e.target;
    if (d.id === 'act-full') { fullOpen = d.open; return; }
    if ('proj' in (d.dataset || {})) { if (d.open) openProj.add(d.dataset.proj); else openProj.delete(d.dataset.proj); return; }
    if (!d.dataset?.task) return;
    if (d.open) openTasks.add(d.dataset.task); else openTasks.delete(d.dataset.task);
  }, true);
}

/* ---------------- ui ---------------- */
function show(view) {
  document.querySelectorAll('.view').forEach((v) => { v.hidden = v.dataset.view !== view; });
  document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === view));
  document.body.classList.toggle('in-chat', view === 'chat');
  window.scrollTo({ top: 0 });
  if (view === 'chat') { const log = $('#chat-log'); log.scrollTop = log.scrollHeight; }
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
  } catch (err) {
    password = null;
    keyCache = { salt: null, key: null };
    data = null;
    $('#login-error').textContent = err.name === 'OperationError' ? 'Wrong password.' : `Can't reach the feed (${err.message}).`;
    btn.disabled = false;
    btn.textContent = 'Unlock';
    return;
  }
  // Decrypted fine: from here the app is shown no matter what, and a failure is shown as an error line.
  try { enterApp(); } catch (err) {
    showError('Starting the app failed', err);
    try { $('#login').hidden = true; $('#app').hidden = false; } catch {}
  } finally {
    btn.disabled = false;
    btn.textContent = 'Unlock';
  }
}

function enterApp() {
  $('#login').hidden = true;
  $('#app').hidden = false;
  timer = setTimeout(poll, (config.pollSec || 10) * 1000);
  guarded('tabs', () => {
    let tab = 'now';
    try { tab = sessionStorage.getItem('ada-tab') || 'now'; } catch {}
    if (!document.querySelector(`.view[data-view="${tab}"]`)) tab = 'now';
    show(tab);
  });
  render();
  guarded('relay', connectRelay);
}

let configReady;
async function boot() {
  window.__adaBooted = true;
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
  $('#unpushed-chip').addEventListener('click', () => { unpushedFirst = !unpushedFirst; renderWork(); });
  guarded('chat controls', bindChat);
  guarded('activity controls', bindActivity);
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
    svVisibility();
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

// Nothing fails silently: stray errors and rejected promises land in the same red line.
window.addEventListener?.('error', (ev) => showError('Page error', ev.error || ev.message));
window.addEventListener?.('unhandledrejection', (ev) => showError('Page error', ev.reason));

boot();
