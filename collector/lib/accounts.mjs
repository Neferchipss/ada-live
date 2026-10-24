// Signed-in accounts, plan limits (5-hour session + weekly), and separate credit balances.
// Claude: Anthropic's usage endpoint, called with Claude Code's own login (same numbers as /usage).
// Codex:  the rate-limit snapshot Codex writes into its session logs (fresh as of its last run).
// Tokens are only read here and sent to Anthropic; they never enter the snapshot.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { safeReaddir, safeStat } from './util.mjs';
import { readHiggsfield } from './higgsfield.mjs';

const HOME = os.homedir();
const CLAUDE_EVERY = 2 * 60e3;
let claudeCache = null;
let claudeAt = 0;
let codexCache = { file: '', mtime: 0, limits: null };

const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };
// A window whose reset time has passed is back at zero, even if our snapshot is older.
const win = (pct, resetsAt, now = Date.now()) =>
  resetsAt && resetsAt < now ? { pct: 0, resetsAt: null, reset: true } : { pct: Math.round(pct ?? 0), resetsAt };

async function claudeAccount() {
  const prof = readJson(path.join(HOME, '.claude.json'))?.oauthAccount || {};
  const cred = readJson(path.join(HOME, '.claude', '.credentials.json'))?.claudeAiOauth || {};
  const acct = {
    service: 'claude',
    name: 'Claude',
    email: prof.emailAddress || '',
    plan: cred.subscriptionType || (prof.organizationType || '').replace(/^claude_/, ''),
    surfaces: ['Claude Code · terminal', 'claude.ai · browser & app'],
    shared: 'Terminal, browser and app draw from the same limits.',
  };
  if (Date.now() - claudeAt < CLAUDE_EVERY && claudeCache) return { ...acct, ...claudeCache };
  claudeAt = Date.now();
  if (!cred.accessToken) return { ...acct, error: 'not signed in' };
  try {
    const r = await fetch('https://api.anthropic.com/api/oauth/usage', {
      headers: { Authorization: `Bearer ${cred.accessToken}`, 'anthropic-beta': 'oauth-2025-04-20' },
      signal: AbortSignal.timeout(10e3),
    });
    // Claude Code refreshes its own login when it next runs; we never touch the refresh token.
    if (r.status === 401) { claudeCache = { error: 'login expired — opens again next time Claude Code runs', asOf: Date.now() }; return { ...acct, ...claudeCache }; }
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const u = await r.json();
    const t = (s) => (s ? Date.parse(s) : null);
    claudeCache = {
      session: u.five_hour ? win(u.five_hour.utilization, t(u.five_hour.resets_at)) : null,
      weekly: u.seven_day ? win(u.seven_day.utilization, t(u.seven_day.resets_at)) : null,
      extra: u.extra_usage?.is_enabled ? 'extra usage on' : null,
      asOf: Date.now(),
      live: true,
    };
  } catch (e) {
    claudeCache = { ...(claudeCache || {}), error: `usage check failed (${e.message})`, asOf: claudeCache?.asOf || 0 };
  }
  return { ...acct, ...claudeCache };
}

function newestCodexLimits() {
  const now = Date.now();
  const files = [];
  for (let d = 0; d < 8; d++) {
    const day = new Date(now - d * 86400e3);
    const dir = path.join(HOME, '.codex', 'sessions', String(day.getFullYear()),
      String(day.getMonth() + 1).padStart(2, '0'), String(day.getDate()).padStart(2, '0'));
    for (const f of safeReaddir(dir)) {
      if (f.isFile() && /^rollout-.*\.jsonl(\.zst)?$/.test(f.name)) {
        const p = path.join(dir, f.name);
        files.push({ p, m: safeStat(p)?.mtimeMs || 0 });
      }
    }
  }
  files.sort((a, b) => b.m - a.m);
  if (files[0] && files[0].p === codexCache.file && files[0].m === codexCache.mtime) return codexCache.limits;
  // Walk newest first; some runs (e.g. failed ones) never report limits.
  for (const { p, m } of files.slice(0, 12)) {
    let text = '';
    try {
      const buf = fs.readFileSync(p);
      text = (p.endsWith('.zst') ? zlib.zstdDecompressSync(buf) : buf).toString('utf8');
    } catch { continue; }
    const line = text.split('\n').reverse().find((l) => l.includes('"rate_limits"'));
    if (!line) continue;
    try {
      const o = JSON.parse(line);
      const rl = o.payload?.rate_limits || o.payload?.info?.rate_limits;
      if (!rl) continue;
      const limits = { rl, at: Date.parse(o.timestamp) || m };
      codexCache = { file: files[0].p, mtime: files[0].m, limits };
      return limits;
    } catch {}
  }
  codexCache = { file: files[0]?.p || '', mtime: files[0]?.m || 0, limits: null };
  return null;
}

function codexAccount() {
  const auth = readJson(path.join(HOME, '.codex', 'auth.json'));
  let email = '', plan = '';
  try {
    const p = JSON.parse(Buffer.from(auth.tokens.id_token.split('.')[1], 'base64url'));
    email = p.email || '';
    plan = p['https://api.openai.com/auth']?.chatgpt_plan_type || '';
  } catch {}
  const acct = {
    service: 'chatgpt',
    name: 'ChatGPT',
    email,
    plan,
    surfaces: ['Codex CLI · terminal', 'chatgpt.com · browser & app'],
    shared: 'Limits shown are Codex’s (CLI, IDE and Codex on the web). Normal ChatGPT chat has separate limits that OpenAI doesn’t expose.',
  };
  if (!auth) return { ...acct, error: 'Codex not signed in' };
  const l = newestCodexLimits();
  if (!l) return { ...acct, error: 'no usage reported yet — appears after the next Codex run' };
  const rl = l.rl;
  const at = (w) => (w?.resets_at ? w.resets_at * 1000 : w?.resets_in_seconds ? l.at + w.resets_in_seconds * 1000 : null);
  return {
    ...acct,
    plan: rl.plan_type || plan,
    session: rl.primary ? win(rl.primary.used_percent, at(rl.primary)) : null,
    weekly: rl.secondary ? win(rl.secondary.used_percent, at(rl.secondary)) : null,
    extra: rl.credits?.has_credits ? `credits ${rl.credits.balance}` : null,
    asOf: l.at,
    live: false,
  };
}

// The Higgsfield sign-in email is personal, so it lives in the local config
// (~/.ada-viewer/config.json, "higgsfieldEmail"), not in this public repo.
function higgsfieldEmail() {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.ada-viewer', 'config.json'), 'utf8'));
    return typeof cfg.higgsfieldEmail === 'string' ? cfg.higgsfieldEmail : null;
  } catch { return null; }
}

async function higgsfieldAccount() {
  const acct = {
    service: 'higgsfield',
    name: 'Higgsfield',
    email: higgsfieldEmail(),
    surfaces: ['higgsfield.ai · browser'],
    shared: 'Credits are separate from ChatGPT and Claude.',
  };
  try {
    const result = await readHiggsfield();
    if (result.error) return { ...acct, error: result.error, asOf: result.asOf || 0 };
    return { ...acct, plan: result.plan, credits: result.credits, planCredits: result.planCredits, renewsAt: result.renewsAt, asOf: result.asOf, live: true };
  } catch (e) {
    return { ...acct, error: `Higgsfield check failed (${e.message})` };
  }
}

export async function collectAccounts() {
  const [claude, higgsfield] = await Promise.all([claudeAccount(), higgsfieldAccount()]);
  let codex;
  try { codex = codexAccount(); } catch (e) { codex = { service: 'chatgpt', name: 'ChatGPT', error: e.message }; }
  return [claude, codex, higgsfield];
}
