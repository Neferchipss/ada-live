#!/usr/bin/env node
// Headless, logged-in look at the live Ada Live page: phone-size screenshots of every tab
// plus a compact JSON report (console errors, failed requests, layout facts).
// Usage: node tools/ui-check.mjs [--url <page url>] [--tabs now,chat,activity,work] [--out <dir>]
// Uses the dedicated profile ~/.ada-viewer/uicheck-profile (never a normal browser profile),
// the same DevTools-protocol launch as collector/lib/higgsfield.mjs, and only navigation clicks.
// The page passphrase is read from ~/.ada-viewer/config.json inside this process and typed
// into the password field; it is never printed, written or screenshotted (shots of the login
// screen are taken before typing, and every output string goes through redact()).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromePath } from '../collector/lib/higgsfield.mjs';

const HOME = path.join(os.homedir(), '.ada-viewer');
export const UICHECK_PROFILE = path.join(HOME, 'uicheck-profile');
export const DEFAULT_URL = 'https://neferchipss.github.io/ada-live/';
export const ALL_TABS = ['now', 'chat', 'activity', 'work'];
const FULL_PAGE_TABS = new Set(['activity', 'work']);
const MOBILE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
const LIST_MAX = 5, MSG_MAX = 300;

// ---------- pure helpers (unit-tested) ----------
export function parseArgs(argv) {
  const opts = { url: DEFAULT_URL, tabs: [...ALL_TABS], out: path.join(HOME, 'inbox') };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], v = argv[i + 1];
    if (a === '--url' && v) { opts.url = v; i++; }
    else if (a === '--out' && v) { opts.out = path.resolve(v); i++; }
    else if (a === '--tabs' && v) {
      opts.tabs = v.split(',').map((t) => t.trim()).filter(Boolean); i++;
      const bad = opts.tabs.find((t) => !ALL_TABS.includes(t));
      if (bad || !opts.tabs.length) throw new Error(`Unknown tab "${bad ?? ''}"; use ${ALL_TABS.join(',')}`);
    } else throw new Error(`Unknown or incomplete argument: ${a}`);
  }
  return opts;
}

const pad = (n) => String(n).padStart(2, '0');
export function stamp(d = new Date()) {
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}
export function shotName(stampText, tab, full = false) {
  return `uicheck-${stampText}-${tab}${full ? '-full' : ''}.png`;
}

// Replace every secret (raw, JSON-escaped, URL-encoded) in a string.
export function redact(text, secrets = []) {
  let s = String(text ?? '');
  for (const secret of secrets) {
    if (typeof secret !== 'string' || secret.length < 3) continue;
    const forms = new Set([secret, JSON.stringify(secret).slice(1, -1), encodeURIComponent(secret)]);
    for (const f of forms) if (f) s = s.split(f).join('[redacted]');
  }
  return s;
}

// True when a computed overflow-x value makes an element a deliberate horizontal scroller (chip rows etc.).
export const scrollsX = (overflowX) => overflowX === 'auto' || overflowX === 'scroll';

// Navigation-only guard: selectors of state-changing controls the checker must never click.
export const isForbiddenControl = (selector = '') => /approve|deny|kill|send|run-anyway|select|pick|attach|paperclip|upload|delete|remove|reset|stop|dismiss|submit|unlock|retry/i.test(String(selector));

const limitList = (list, secrets) => ({
  count: list.length,
  first: list.slice(0, LIST_MAX).map((m) => redact(String(m).replace(/\s+/g, ' ').trim().slice(0, MSG_MAX), secrets)),
});

export function buildSummary(r, secrets = []) {
  const summary = {
    ok: r.ok !== false,
    url: redact(r.url, secrets),
    title: redact(r.title || '', secrets),
    shots: (r.shots || []).map((p) => redact(p, secrets)),
    consoleErrors: limitList(r.consoleErrors || [], secrets),
    pageErrors: limitList(r.pageErrors || [], secrets),
    failedRequests: limitList(r.failedRequests || [], secrets),
    bannerText: redact(String(r.bannerText || '').slice(0, MSG_MAX), secrets),
    overflow: {
      horizontal: (r.overflow?.horizontal || []).slice(0, 8).map((m) => redact(m, secrets)),
      wideElements: limitList(r.overflow?.wideElements || [], secrets),
    },
    suspiciousText: limitList(r.suspiciousText || [], secrets),
    ...(r.map ? { map: { title: redact(r.map.title, secrets).slice(0, 80), nodes: r.map.nodes | 0 } } : {}),
    ...(r.session ? { session: { banner: redact(r.session.banner, secrets).slice(0, 160), rows: r.session.rows | 0 } } : {}),
    tabs: (r.tabs || []).slice(0, 8).map((t) => ({ tab: t.tab, visible: !!t.visible, textChars: t.textChars | 0 })),
  };
  // Last line of defence: if a secret somehow survived inside the JSON, withhold the report.
  const json = JSON.stringify(summary);
  if (redact(json, secrets) !== json) return { ok: false, error: 'summary withheld: it contained a secret' };
  return summary;
}

// ---------- browser (DevTools protocol over WebSocket) ----------
function launch() {
  fs.mkdirSync(UICHECK_PROFILE, { recursive: true });
  const args = [`--user-data-dir=${UICHECK_PROFILE}`, '--no-first-run', '--no-default-browser-check', '--disable-background-mode',
    '--headless=new', '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1', 'about:blank'];
  const child = spawn(process.env.UICHECK_CHROME || chromePath(), args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
  const ready = new Promise((resolve, reject) => {
    let stderr = '';
    child.stderr.on('data', (c) => {
      stderr = (stderr + c.toString()).slice(-8192);
      const ep = stderr.match(/DevTools listening on (ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\/[\w-]+)/)?.[1];
      if (ep) resolve(ep);
    });
    child.on('error', (e) => reject(new Error(`Browser launch failed (${e.code || 'unknown'})`)));
    child.on('exit', () => reject(new Error('Browser exited early; is another ui-check running on the same profile?')));
    setTimeout(() => reject(new Error('Browser did not start within 30s')), 30000);
  });
  return { child, ready };
}

async function connect(endpoint) {
  const socket = new WebSocket(endpoint);
  const replies = new Map(); const listeners = []; let id = 0;
  socket.addEventListener('message', ({ data }) => {
    let m; try { m = JSON.parse(data); } catch { return; }
    if (m.id) {
      const r = replies.get(m.id);
      if (r) { replies.delete(m.id); m.error ? r.reject(new Error(m.error.message || 'command failed')) : r.resolve(m.result); }
    } else for (const fn of listeners) fn(m);
  });
  socket.addEventListener('close', () => { for (const r of replies.values()) r.reject(new Error('browser connection closed')); replies.clear(); });
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', () => reject(new Error('Cannot connect to browser DevTools')), { once: true });
  });
  return {
    on: (fn) => listeners.push(fn),
    close: () => socket.close(),
    send: (method, params = {}, sessionId) => new Promise((resolve, reject) => {
      const n = ++id;
      const t = setTimeout(() => { replies.delete(n); reject(new Error(`${method} timed out`)); }, 30000);
      replies.set(n, { resolve: (v) => { clearTimeout(t); resolve(v); }, reject: (e) => { clearTimeout(t); reject(e); } });
      socket.send(JSON.stringify({ id: n, method, params, ...(sessionId ? { sessionId } : {}) }));
    }),
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Page-side probe: layout facts and suspicious text for what is currently visible.
const PROBE = `(() => {
  const scrollsX = ${scrollsX.toString()};
  const inScroller = (el) => { for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) if (scrollsX(getComputedStyle(p).overflowX)) return true; return false; };
  const vw = document.documentElement.clientWidth;
  const sel = (el) => el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (typeof el.className === 'string' && el.className.trim() ? '.' + el.className.trim().split(/\\s+/).slice(0, 2).join('.') : '');
  const visible = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
  const wide = [];
  for (const el of document.querySelectorAll('body *')) {
    if (el.closest('[hidden]') || !visible(el) || inScroller(el)) continue;
    const r = el.getBoundingClientRect();
    if (r.right > innerWidth + 1 || r.width > innerWidth + 1) wide.push(sel(el) + ' w=' + Math.round(r.width) + ' right=' + Math.round(r.right));
    if (wide.length >= 20) break;
  }
  const text = document.body.innerText || '';
  const sus = [];
  const re = /.{0,40}(undefined|NaN|\\[object).{0,40}/g; let m;
  while ((m = re.exec(text)) && sus.length < 20) sus.push(m[0].replace(/\\s+/g, ' '));
  const bar = document.querySelector('#err-bar');
  const q = (s) => document.querySelector(s);
  return {
    title: document.title, scrollWidth: document.documentElement.scrollWidth, clientWidth: vw,
    wide, sus, banner: bar && !bar.hidden ? bar.innerText : '',
    loginVisible: !!q('#login') && !q('#login').hidden,
    appVisible: !!q('#app') && !q('#app').hidden,
    loginError: (q('#login-error') || {}).innerText || '',
    unlockText: (q('#unlock') || {}).textContent || '',
  };
})()`;

export async function run(opts, io = { log: (m) => process.stderr.write(m + '\n') }) {
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(path.join(HOME, 'config.json'), 'utf8')); } catch {}
  const passphrase = typeof cfg.password === 'string' ? cfg.password : '';
  const secrets = [passphrase, cfg.salt, cfg.relayKey, typeof cfg.fullModePin === 'string' ? cfg.fullModePin : ''];
  const fail = (message) => new Error(redact(message, secrets));

  const stampText = stamp();
  fs.mkdirSync(opts.out, { recursive: true });
  const result = { url: opts.url, shots: [], consoleErrors: [], pageErrors: [], failedRequests: [], bannerText: '', title: '',
    overflow: { horizontal: [], wideElements: [] }, suspiciousText: [], tabs: [] };

  const browser = launch();
  browser.ready.catch(() => {});
  let cdp;
  try {
    cdp = await connect(await browser.ready);
    const { targetInfos } = await cdp.send('Target.getTargets');
    const target = targetInfos.find((t) => t.type === 'page') ||
      { targetId: (await cdp.send('Target.createTarget', { url: 'about:blank' })).targetId };
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
    const send = (m, p) => cdp.send(m, p, sessionId);
    const requests = new Map();
    const where = (s) => (s?.url ? ` (${s.url}:${(s.lineNumber ?? 0) + 1})` : '');
    cdp.on((m) => {
      if (m.sessionId !== sessionId) return;
      const p = m.params || {};
      if (m.method === 'Runtime.consoleAPICalled' && p.type === 'error') {
        result.consoleErrors.push(p.args.map((a) => a.value ?? a.description ?? '').join(' ') + where(p.stackTrace?.callFrames?.[0]));
      } else if (m.method === 'Runtime.exceptionThrown') {
        const d = p.exceptionDetails || {};
        result.pageErrors.push((d.exception?.description || d.text || 'exception').split('\n')[0] + where({ url: d.url, lineNumber: d.lineNumber }));
      } else if (m.method === 'Log.entryAdded' && p.entry.level === 'error' && p.entry.source !== 'network') {
        result.consoleErrors.push(`${p.entry.text}${where(p.entry)}`);
      } else if (m.method === 'Network.requestWillBeSent') requests.set(p.requestId, p.request.url);
      else if (m.method === 'Network.loadingFailed' && !p.canceled) result.failedRequests.push(`${requests.get(p.requestId) || '?'} ${p.errorText}`);
      else if (m.method === 'Network.responseReceived' && p.response.status >= 400) result.failedRequests.push(`${p.response.url} HTTP ${p.response.status}`);
    });
    for (const d of ['Page', 'Runtime', 'Log', 'Network']) await send(`${d}.enable`);
    await send('Emulation.setDeviceMetricsOverride', { width: 430, height: 932, deviceScaleFactor: 2, mobile: true });
    await send('Emulation.setUserAgentOverride', { userAgent: MOBILE_UA, platform: 'iPhone' });
    await send('Emulation.setTouchEmulationEnabled', { enabled: true });

    const evalJs = async (expression) => {
      const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails) throw fail('page script failed');
      return r.result.value;
    };
    const shot = async (tab, full = false) => {
      const file = path.join(opts.out, shotName(stampText, tab, full));
      const params = { format: 'png' };
      if (full) {
        const { cssContentSize: c } = await send('Page.getLayoutMetrics');
        Object.assign(params, { captureBeyondViewport: true, clip: { x: 0, y: 0, width: 430, height: Math.min(Math.ceil(c.height), 12000), scale: 1 } });
      }
      fs.writeFileSync(file, Buffer.from((await send('Page.captureScreenshot', params)).data, 'base64'));
      result.shots.push(file);
    };
    const waitFor = async (pred, ms) => {
      const end = Date.now() + ms;
      while (Date.now() < end) { const v = await evalJs(PROBE); if (pred(v)) return v; await sleep(250); }
      return null;
    };

    await send('Page.navigate', { url: opts.url });
    // Give a stored session a few seconds to restore itself before treating this as a login screen.
    let state = await waitFor((s) => s.appVisible, 6000);
    if (!state) {
      state = await waitFor((s) => s.loginVisible, 10000);
      if (!state) throw fail('Neither the app nor the login screen appeared');
      await shot('login'); // before typing anything
      if (!passphrase) throw fail('Login needed but no password in ~/.ada-viewer/config.json');
      await evalJs(`(() => { document.querySelector('#password').focus(); const r = document.querySelector('#remember'); if (r && !r.checked) r.click(); })()`);
      await send('Input.insertText', { text: passphrase });
      await evalJs(`document.querySelector('#unlock').click()`);
      state = await waitFor((s) => s.appVisible || (s.loginError && !/Decrypting/.test(s.unlockText)), 30000);
      if (!state?.appVisible) throw fail(`Login failed: ${state?.loginError || 'timed out waiting for the app'}`);
    }
    // Wait for data to render rather than the Decrypting state, then let polling settle.
    await waitFor((s) => s.appVisible && !/Decrypting/.test(s.unlockText), 15000);
    await sleep(2500);

    for (const tab of opts.tabs) {
      const clicked = await evalJs(`(() => { const b = document.querySelector('#tabs button[data-tab="${tab}"]'); if (!b) return false; b.click(); return true; })()`);
      if (!clicked) { io.log(`no tab button for ${tab}`); continue; }
      await sleep(1200);
      const info = await evalJs(`(() => { const v = document.querySelector('.view[data-view="${tab}"]'); return { visible: !!v && !v.hidden, textChars: v ? v.innerText.length : 0 }; })()`);
      result.tabs.push({ tab, ...info });
      await shot(tab);
      if (FULL_PAGE_TABS.has(tab)) await shot(tab, true);
      const probe = await evalJs(PROBE);
      result.title = probe.title;
      if (probe.banner && !result.bannerText.includes(probe.banner)) result.bannerText += (result.bannerText ? ' | ' : '') + probe.banner;
      if (probe.scrollWidth > probe.clientWidth) result.overflow.horizontal.push(`${tab}: scrollWidth ${probe.scrollWidth} > clientWidth ${probe.clientWidth}`);
      result.overflow.wideElements.push(...probe.wide.map((w) => `${tab}: ${w}`));
      result.suspiciousText.push(...probe.sus.map((s) => `${tab}: ${s}`));
    }
    // Chat extras (navigation only): the Map sheet, then one session viewer if a non-Ada chip exists, then back to Ada.
    if (opts.tabs.includes('chat')) {
      const click = async (sel) => {
        if (isForbiddenControl(sel)) return false;
        return evalJs(`(() => { const b = document.querySelector(${JSON.stringify(sel)}); if (!b) return false; b.click(); return true; })()`);
      };
      if (await click('#tabs button[data-tab="chat"]')) {
        await sleep(600);
        if (await click('#sv-bar [data-sv-map]')) {
          await sleep(900);
          await shot('map');
          result.map = await evalJs(`(() => { const t = document.querySelector('#map-title'); return { title: t ? t.textContent : '', nodes: document.querySelectorAll('#map-body .mp-n').length }; })()`);
          await click('#map-close');
          await sleep(500);
        } else io.log('no Map chip');
        if (await click('#sv-bar .sv-chip[data-sv]')) {
          await sleep(2500);
          await shot('session');
          result.session = await evalJs(`(() => { const b = document.querySelector('#sv-banner'); return { banner: b && !b.hidden ? b.innerText.replace(/\s+/g, ' ').slice(0, 160) : '', rows: document.querySelectorAll('#chat-log > li').length }; })()`);
          await click('#sv-bar [data-sv-ada]');
          await sleep(500);
        }
      }
    }
    result.ok = true;
  } finally {
    try { await cdp?.send('Browser.close'); } catch {}
    cdp?.close();
    await Promise.race([new Promise((r) => browser.child.once('exit', r)), sleep(1500)]);
    if (browser.child.exitCode === null && process.platform === 'win32' && browser.child.pid) {
      // Kill only the tree we started.
      spawn('taskkill.exe', ['/PID', String(browser.child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    }
  }
  return buildSummary(result, secrets);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const summary = await run(parseArgs(process.argv.slice(2)));
    console.log(JSON.stringify(summary));
    process.exit(summary.error ? 1 : 0);
  } catch (e) {
    console.error(`ui-check: ${e.message}`);
    process.exit(1);
  }
}
