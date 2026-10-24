// Higgsfield has no public account API. Read only the rendered account website.
// Setup (on Nefer's laptop, outside the offline editing sandbox):
// 1. Let any active browser check finish (up to ~30s), then stop the collector.
//    Run node tools/higgsfield-login.mjs,
//    sign in with the Higgsfield account (higgsfieldEmail in the local config), then
//    close that Chrome window. It uses ~/.ada-viewer/higgsfield-profile only.
// 2. Restart the collector with node collector/collect.mjs.
// If interrupted during browser work, close that dedicated Chrome window before
// restarting. If a headless process remains, use Task Manager > Details > Command
// line to identify Chrome with --user-data-dir ending in
// .ada-viewer/higgsfield-profile and end only that dedicated process tree;
// do not end your normal Chrome session. Then restart the collector.
// No dependencies are added: Node 22+ and installed Chrome/Chromium are used via
// the local DevTools protocol. HIGGSFIELD_CHROME may name its executable if it is
// outside the standard Windows paths. No cookies from other profiles are read.
// Live selectors are UNTESTED. Adjust the block below if the account balance,
// plan badge, or account menu markup differs. NODE_DEBUG=higgsfield enables
// bounded extraction diagnostics (numbers/plan only; never page HTML or secrets).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { debuglog } from 'node:util';

// ----- Higgsfield page-scrape fallback: selectors and regexes (used only if the account API is not seen) -----
const NUMBER = '(?:\\d{1,3}(?:[, \\u00a0]\\d{3})+|\\d+)(?:\\.\\d+)?';
export const HIGGSFIELD_MATCH = {
  accountMenus: ['[data-testid="account-menu-trigger"]', '[aria-label="Account menu"]', '[aria-label="Profile menu"]'],
  omit: 'script, style, noscript, template',
  creditLabel: /(?:^|[\s_-])credits?(?:[\s_-]*(?:balance|remaining|available|count))?(?:$|[\s_-])/i,
  planLabel: /(?:^|[\s_-])(?:current[\s_-]*)?(?:plan|subscription)(?:[\s_-]*(?:name|badge|tier|type))?(?:$|[\s_-])/i,
  coinIcon: /(?:^|[\s_-])(?:coins?|credits?)(?:$|[\s_-])/i,
  creditsFirst: new RegExp(`^(?:your\\s+)?(?:(?:available|remaining)\\s+)?credits?(?:\\s+(?:balance|remaining|available))?\\s*[:=–—-]?\\s*(${NUMBER})(?:\\s+credits?)?\\s*$`, 'i'),
  numberFirst: new RegExp(`^(?:you have\\s+)?(${NUMBER})\\s+credits?(?:\\s+(?:remaining|available|left))?\\s*$`, 'i'),
  numeric: new RegExp(`^(${NUMBER})$`),
  planText: /^(?:(?:your|current|active)\s+)?(?:plan|subscription)(?:\s+(?:name|tier|type))?\s*[:=–—-]\s*(.{1,48})$/i,
  planLine: /^(?:your|current|active)\s+(?:plan|subscription)\s+(.{1,48})$/i,
  notPlan: /\b(?:upgrade|choose|buy|select|compare|manage|cancel|billing|credits?|monthly|annually|per month|per year|plans)\b|[$€£\d]/i,
  promotional: /(?:^|[\s_-])(?:pricing|marketing|offers?|packages?|checkout|plan-card|pricing-card)(?:$|[\s_-])/i,
  signIn: /\b(?:sign\s*in|log\s*in|login|continue with (?:google|apple|email))\b/i,
  signInUrl: /\/(?:login|sign-in|signin|auth)(?:[/?#]|$)/i,
};
// ----- End extraction tuning -----

export const HIGGSFIELD_PROFILE = path.join(os.homedir(), '.ada-viewer', 'higgsfield-profile');
const URL = 'https://higgsfield.ai';
const NOT_SIGNED_IN = 'not signed in: run node tools/higgsfield-login.mjs';
const EVERY = 10 * 60e3;
const TIMEOUT = 30e3;
const debug = debuglog('higgsfield');
let cached = null, cachedAt = 0, pending = null;

const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
const decode = (s) => s.replace(/&(#x[\da-f]+|#\d+|nbsp|amp|lt|gt|quot|apos);/gi, (whole, entity) => {
  const named = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
  if (entity[0] !== '#') return named[entity.toLowerCase()] || whole;
  const n = entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
  return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : '';
});

// A small HTML tokenizer is enough for these bounded, local text/attribute
// heuristics. It does not execute scripts, load resources, or inspect cookies.
function htmlNodes(html) {
  const root = { tag: 'root', attrs: {}, children: [], parent: null };
  let current = root;
  const all = [];
  const tokens = html.match(/<!--[\s\S]*?-->|<[^>]*>|[^<]+/g) || [];
  const voids = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
  for (const token of tokens) {
    if (/^<!|^<\?/.test(token)) continue;
    if (token.startsWith('</')) {
      const tag = token.slice(2).match(/^[\w:-]+/)?.[0]?.toLowerCase();
      let n = current;
      while (n.parent && n.tag !== tag) n = n.parent;
      if (n.parent) current = n.parent;
    } else if (token.startsWith('<')) {
      const tag = token.slice(1).match(/^[\w:-]+/)?.[0]?.toLowerCase();
      if (!tag) continue;
      const attrs = {};
      const attrText = token.slice(tag.length + 1, -1);
      for (const m of attrText.matchAll(/([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) attrs[m[1].toLowerCase()] = decode(m[2] ?? m[3] ?? m[4] ?? '');
      const n = { tag, attrs, children: [], parent: current };
      current.children.push(n); all.push(n);
      if (!voids.has(tag) && !token.endsWith('/>')) current = n;
    } else current.children.push(decode(token));
  }
  const hidden = (n) => n && (['script', 'style', 'noscript', 'template'].includes(n.tag) || 'hidden' in n.attrs || n.attrs['aria-hidden'] === 'true' || /display\s*:\s*none|visibility\s*:\s*hidden/i.test(n.attrs.style || '') || hidden(n.parent));
  const text = (n) => clean(n.children.map((c) => typeof c === 'string' ? c : hidden(c) ? '' : text(c)).join(' '));
  const marker = (n) => [n.attrs.id, n.attrs.class, n.attrs['data-testid'], n.attrs['data-lucide'], n.attrs['data-icon'], n.attrs['aria-label'], n.attrs.title].filter(Boolean).join(' ');
  return { all, hidden, text, marker };
}

export function extractHiggsfield(html, { debug: log = debug } = {}) {
  if (typeof html !== 'string' || html.length > 4e6) return { error: 'Higgsfield page is empty or too large to inspect' };
  try {
    const { all, hidden, text, marker } = htmlNodes(html);
    const balances = new Set(), plans = new Set(), strategies = new Set();
    let signedOut = false;
    const promotional = (n) => n && (HIGGSFIELD_MATCH.promotional.test(marker(n)) || promotional(n.parent));
    const addNumber = (raw, strategy) => {
      const n = Number(raw.replace(/[,\s]/g, ''));
      if (Number.isFinite(n) && n >= 0 && n <= Number.MAX_SAFE_INTEGER) { balances.add(n); strategies.add(strategy); }
    };
    const addPlan = (raw) => {
      const value = clean(raw).replace(/\s+plan$/i, '');
      if (value && value.length <= 48 && !HIGGSFIELD_MATCH.notPlan.test(value)) plans.add(value);
    };
    for (const n of all) {
      if (hidden(n)) continue;
      const value = text(n);
      const label = clean(n.attrs['aria-label'] || n.attrs.title);
      if ((['a', 'button', 'h1', 'h2'].includes(n.tag) && value.length < 100 && HIGGSFIELD_MATCH.signIn.test(value)) || n.attrs.type === 'password') signedOut = true;
      if (promotional(n)) continue;
      for (const [s, strategy] of [[value, 'text'], [label, 'aria/title']]) {
        if (!s || s.length > 160) continue;
        const credits = s.match(HIGGSFIELD_MATCH.creditsFirst) || s.match(HIGGSFIELD_MATCH.numberFirst);
        if (credits) addNumber(credits[1], strategy);
        const plan = s.match(HIGGSFIELD_MATCH.planText) || s.match(HIGGSFIELD_MATCH.planLine);
        if (plan) addPlan(plan[1]);
      }
      if (HIGGSFIELD_MATCH.creditLabel.test(marker(n)) && HIGGSFIELD_MATCH.numeric.test(value)) addNumber(value, 'credit attribute');
      if (HIGGSFIELD_MATCH.planLabel.test(marker(n)) && !HIGGSFIELD_MATCH.planText.test(value) && !HIGGSFIELD_MATCH.planLine.test(value)) addPlan(value);
      // Credit icons are often aria-hidden; inspect their marker, but read only
      // the visible numeric text of their immediate containing control.
      if (HIGGSFIELD_MATCH.numeric.test(value) && n.children.some((c) => typeof c !== 'string' && ['svg', 'img', 'i', 'span'].includes(c.tag) && HIGGSFIELD_MATCH.coinIcon.test(marker(c)))) addNumber(value, 'coin sibling');
    }
    log('extraction strategies=%s credits=%s plans=%s signedOut=%s', [...strategies].join(','), [...balances].slice(0, 4).join(','), [...plans].slice(0, 4).join(','), signedOut);
    if (signedOut) return { error: NOT_SIGNED_IN };
    if (balances.size > 1 || plans.size > 1) return { error: 'Higgsfield account values are ambiguous; adjust the extraction tuning block' };
    if (!balances.size || !plans.size) return { error: `Higgsfield ${!balances.size ? 'credit balance' : 'plan'} not found; adjust the extraction tuning block` };
    return { credits: [...balances][0], plan: [...plans][0] };
  } catch { return { error: 'Higgsfield page extraction failed; adjust the extraction tuning block' }; }
}

// The site's own account API (seen live 2026-10-24): GET fnf-api-gw.higgsfield.ai/fnf/user returns
// plan_type, the credit buckets and total_plan_credits. Reading it beats scraping, which has no balance
// on the homepage. Only these fields are kept; the rest of the response is ignored.
export const HIGGSFIELD_USER_API = /^https:\/\/fnf-api-gw\.higgsfield\.ai\/fnf\/user(?:\?|$)/;
export function fromUserApi(body) {
  let u; try { u = JSON.parse(body); } catch { return null; }
  if (!u || typeof u !== 'object' || typeof u.plan_type !== 'string') return null;
  const buckets = ['subscription_credits', 'package_credits', 'bonus_credits', 'daily_credits'].map((k) => Number(u[k]) || 0);
  const credits = Math.round(buckets.reduce((a, b) => a + b, 0) * 100) / 100;
  if (!Number.isFinite(credits) || credits < 0) return null;
  const plan = u.plan_type.replace(/[_-]+/g, ' ').replace(/(^|\s)\w/g, (c) => c.toUpperCase());
  const total = Number(u.total_plan_credits);
  const renews = Date.parse(u.plan_ends_at || '');
  return { credits, plan, ...(Number.isFinite(total) && total > 0 ? { planCredits: total } : {}), ...(Number.isFinite(renews) ? { renewsAt: renews } : {}) };
}

export function chromePath() {
  const candidates = [process.env.HIGGSFIELD_CHROME,
    path.join(process.env.PROGRAMFILES || 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Chromium', 'Application', 'chrome.exe'),
    // Any Chromium browser works with a separate profile; Nefer's laptop has Brave, not Chrome.
    path.join(process.env.PROGRAMFILES || 'C:\\Program Files', 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
    path.join(process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'Microsoft', 'Edge', 'Application', 'msedge.exe')];
  const executable = candidates.find((p) => p && fs.existsSync(p));
  if (!executable) throw new Error('Chrome/Chromium not found; install Chrome or set HIGGSFIELD_CHROME to its executable');
  return executable;
}

function profileLock() {
  fs.mkdirSync(HIGGSFIELD_PROFILE, { recursive: true });
  const file = path.join(HIGGSFIELD_PROFILE, '.ada-viewer.lock');
  try {
    const pid = Number(fs.readFileSync(file, 'utf8'));
    if (Number.isInteger(pid) && pid > 0) {
      try { process.kill(pid, 0); } catch (e) { if (e.code === 'ESRCH') fs.unlinkSync(file); }
    }
  } catch (e) { if (e.code !== 'ENOENT') throw e; }
  let fd;
  try { fd = fs.openSync(file, 'wx'); }
  catch (e) { if (e.code === 'EEXIST') throw new Error('Higgsfield profile is busy; close its login window and retry after the 10-minute cache expires'); throw e; }
  fs.writeFileSync(fd, String(process.pid)); fs.closeSync(fd);
  return () => { try { fs.unlinkSync(file); } catch {} };
}

function chrome(headless) {
  const args = [`--user-data-dir=${HIGGSFIELD_PROFILE}`, '--no-first-run', '--no-default-browser-check', '--disable-background-mode'];
  if (headless) args.push('--headless=new', '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1', 'about:blank');
  else args.push('--new-window', URL);
  const child = spawn(chromePath(), args, { windowsHide: headless, stdio: ['ignore', 'ignore', 'pipe'] });
  let readyResolve, readyReject, exitResolve;
  const ready = headless ? new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; }) : null;
  const exited = new Promise((resolve) => { exitResolve = resolve; });
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    // Never log browser stderr, which can contain URLs or account data.
    stderr = (stderr + chunk.toString()).slice(-8192);
    const endpoint = stderr.match(/DevTools listening on (ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\/[\w-]+)/)?.[1];
    if (endpoint) readyResolve?.(endpoint);
  });
  child.on('error', (e) => { readyReject?.(new Error(`Chrome launch failed (${e.code || 'unknown error'})`)); exitResolve({ error: e }); });
  child.on('exit', (code) => { readyReject?.(new Error('Chrome exited before loading Higgsfield; close any other Higgsfield profile window')); exitResolve({ code }); });
  return { child, ready, exited };
}

function abortable(promise, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason || new Error('Higgsfield browser check timed out after 30 seconds'));
    if (signal.aborted) { promise.catch(() => {}); abort(); return; }
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

async function devtools(endpoint, signal) {
  const socket = new WebSocket(endpoint);
  const replies = new Map(); let id = 0;
  const fail = () => { for (const { reject } of replies.values()) reject(new Error('Higgsfield browser connection closed')); replies.clear(); };
  const listeners = [];
  socket.addEventListener('message', ({ data }) => {
    let message; try { message = JSON.parse(data); } catch { return; }
    if (message.method && !message.id) { for (const fn of listeners) fn(message); return; }
    const response = replies.get(message.id); if (!response) return;
    replies.delete(message.id);
    if (message.error) response.reject(new Error('Higgsfield browser command failed'));
    else response.resolve(message.result);
  });
  socket.addEventListener('close', fail);
  socket.addEventListener('error', fail);
  const close = () => { fail(); socket.close(); };
  signal.addEventListener('abort', close, { once: true });
  try {
    await abortable(new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true });
      socket.addEventListener('error', () => reject(new Error('Cannot connect to Higgsfield Chrome DevTools')), { once: true });
    }), signal);
  } catch (e) { close(); throw e; }
  return {
    on: (fn) => listeners.push(fn),
    close: () => { signal.removeEventListener('abort', close); close(); },
    send: (method, params = {}, sessionId) => abortable(new Promise((resolve, reject) => {
      const next = ++id; replies.set(next, { resolve, reject });
      try { socket.send(JSON.stringify({ id: next, method, params, ...(sessionId ? { sessionId } : {}) })); }
      catch { replies.delete(next); reject(new Error('Cannot send Higgsfield browser command')); }
    }), signal),
  };
}

async function stopChrome(browser, connection) {
  if (!browser) return;
  if (connection) await Promise.race([connection.send('Browser.close').catch(() => {}), new Promise((r) => setTimeout(r, 250))]);
  connection?.close();
  const exited = await Promise.race([browser.exited.then(() => true), new Promise((r) => setTimeout(() => r(false), 250))]);
  if (exited || !browser.child.pid) return;
  if (process.platform === 'win32') {
    // Kill only the tree we started; never any normal Chrome profile/process.
    const killer = spawn('taskkill.exe', ['/PID', String(browser.child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    await new Promise((resolve) => { killer.on('error', resolve); killer.on('exit', resolve); setTimeout(resolve, 500); });
  }
  try { browser.child.kill(); } catch {}
}

const delay = (ms, signal) => abortable(new Promise((resolve) => setTimeout(resolve, ms)), signal);

async function collect() {
  // Missing profile means no one-time login has happened. Do not create it here.
  if (!fs.existsSync(HIGGSFIELD_PROFILE)) return { error: NOT_SIGNED_IN };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error('Higgsfield browser check timed out after 30 seconds')), TIMEOUT - 1000);
  let unlock, browser, connection;
  try {
    unlock = profileLock();
    browser = chrome(true);
    connection = await devtools(await abortable(browser.ready, controller.signal), controller.signal);
    const { targetId } = await connection.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await connection.send('Target.attachToTarget', { targetId, flatten: true });
    let fromApi = null;
    const userRequests = new Map();
    connection.on((m) => {
      if (m.sessionId !== sessionId || m.method !== 'Network.loadingFinished') return;
      const url = userRequests.get(m.params.requestId); if (!url) return;
      connection.send('Network.getResponseBody', { requestId: m.params.requestId }, sessionId)
        .then((r) => { const v = fromUserApi(r.base64Encoded ? Buffer.from(r.body, 'base64').toString('utf8') : r.body); if (v) fromApi = v; })
        .catch(() => {});
    });
    connection.on((m) => {
      if (m.sessionId === sessionId && m.method === 'Network.responseReceived' && m.params.response.status === 200 && HIGGSFIELD_USER_API.test(m.params.response.url)) userRequests.set(m.params.requestId, m.params.response.url);
    });
    await connection.send('Network.enable', {}, sessionId);
    const navigation = await connection.send('Page.navigate', { url: URL }, sessionId);
    if (navigation.errorText) throw new Error('Higgsfield website could not be loaded; check the connection');
    let result = { error: 'Higgsfield account page has not loaded' }, menuOpened = false;
    for (let attempt = 0; attempt < 24; attempt++) {
      await delay(1000, controller.signal);
      if (fromApi) return { ...fromApi, asOf: Date.now() };
      const expression = `(() => {
        const copy = document.documentElement.cloneNode(true);
        const live = document.documentElement.querySelectorAll('*');
        const cloned = copy.querySelectorAll('*');
        for (let i = live.length - 1; i >= 0; i--) {
          const style = getComputedStyle(live[i]);
          if (live[i].matches(${JSON.stringify(HIGGSFIELD_MATCH.omit)}) || style.display === 'none' || style.visibility === 'hidden') cloned[i].remove();
          if (live[i].matches('input, textarea, select, option')) { cloned[i].removeAttribute('value'); cloned[i].removeAttribute('placeholder'); cloned[i].textContent = ''; }
        }
        return { html: copy.outerHTML, url: location.href };
      })()`;
      const response = await connection.send('Runtime.evaluate', { expression, returnByValue: true }, sessionId);
      const page = response.result?.value;
      if (!page?.html) continue;
      if (HIGGSFIELD_MATCH.signInUrl.test(page.url)) return { error: NOT_SIGNED_IN };
      result = extractHiggsfield(page.html);
      if (!result.error) return { ...result, asOf: Date.now() };
      // Allow hydration/redirects to settle before accepting a signed-out page.
      if (attempt >= 3 && result.error === NOT_SIGNED_IN) return result;
      if (attempt >= 3 && !menuOpened) {
        menuOpened = true;
        await connection.send('Runtime.evaluate', { expression: `(() => { for (const selector of ${JSON.stringify(HIGGSFIELD_MATCH.accountMenus)}) { const el = document.querySelector(selector); if (el && el.getClientRects().length && el.getAttribute('aria-expanded') !== 'true') { el.click(); return; } } })()` }, sessionId);
      }
    }
    return result;
  } catch (e) { return { error: e.message || 'Higgsfield browser check failed' }; }
  finally { await stopChrome(browser, connection); clearTimeout(timeout); unlock?.(); }
}

export async function readHiggsfield() {
  if (pending) return pending;
  if (cached && Date.now() - cachedAt < EVERY) return { ...cached };
  pending = collect().catch((e) => ({ error: `Higgsfield check failed (${e.message})` })).then((result) => {
    cached = result; cachedAt = Date.now(); return { ...result };
  }).finally(() => { pending = null; });
  return pending;
}

export async function launchHiggsfieldLogin() {
  // Interactive setup only. The collector never invokes this function.
  chromePath();
  const unlock = profileLock();
  let browser;
  try {
    browser = chrome(false);
    const result = await browser.exited;
    if (result.error || result.code) throw new Error('Chrome login window could not open; check Chrome and close any other Higgsfield profile window');
  } finally { unlock(); }
}
