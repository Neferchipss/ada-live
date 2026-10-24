#!/usr/bin/env node
// Ada live viewer — laptop-side collector.
// Gathers Claude + Codex sessions, delegated tasks and the work-folder map,
// encrypts the snapshot and writes it where the page reads it.
//
//   node collector/collect.mjs            run forever (every intervalSec)
//   node collector/collect.mjs --once     one snapshot, then exit
//   node collector/collect.mjs --dump F   also write the plaintext snapshot to F (debugging)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { loadConfig, STATE_DIR } from './lib/config.mjs';
import { Stats } from './lib/stats.mjs';
import { RelayClient } from './lib/relay.mjs';
import { deriveKey, seal, open } from './lib/crypto.mjs';
import { ChatHub } from './lib/chat.mjs';
import { useWindowStore } from './lib/context.mjs';
import { collectClaude } from './lib/claude.mjs';
import { collectCodex } from './lib/codex.mjs';
import { collectTasks } from './lib/tasks.mjs';
import { WorkMap } from './lib/work.mjs';
import { collectAccounts } from './lib/accounts.mjs';
import { limits } from './lib/limits.mjs';
import { normPath } from './lib/util.mjs';
import { FeedPublisher } from './lib/feed.mjs';
import { buildGitActivity, unpushedList } from './lib/gitactivity.mjs';
import { Journal, activeMap, attribute, sessionActive } from './lib/journal.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, '..', 'docs', 'data', 'live.enc.json');
const HEARTBEAT_MS = 60e3;
const RESCAN_MS = 15 * 60e3;
const STREAM_MS = 3000;
const GH_CACHE = path.join(STATE_DIR, 'github-cache.json');

const args = process.argv.slice(2);
const once = args.includes('--once');
const dumpAt = args.indexOf('--dump');
const dumpFile = dumpAt >= 0 ? args[dumpAt + 1] : null;

const cfg = loadConfig();
useWindowStore(path.join(STATE_DIR, 'context-windows.json')); // model -> context window, learned from what the CLIs report
const key = deriveKey(cfg.password, cfg.salt);
const work = new WorkMap(cfg.workRoot);
// feedRemote in config (e.g. https://github.com/<you>/ada-live.git) turns on publishing.
const feed = cfg.feedRemote && !once ? new FeedPublisher(cfg.feedRemote, (cfg.pushSec || 60) * 1000) : null;
let stats = null;
let relay = null;
let accounts = [];
let hub = null;
// Nefer's own terminals and delegated tasks, as last read. The chat's conflict guard and the git journal read this;
// it is refreshed by every snapshot and re-read here when older than a few seconds.
const journal = once ? null : new Journal();
if (journal) journal.unpushed = () => unpushedList([...work.projects.values()]);
let ext = { t: 0, sessions: [], tasks: [] };
function externals() {
  if (Date.now() - ext.t > 8000) ext = { t: Date.now(), sessions: [...collectClaude(), ...collectCodex()], tasks: collectTasks() };
  return ext;
}
const refreshAccounts = () => collectAccounts().then((a) => { accounts = a; limits.fromAccounts(a); }).catch((e) => console.error('[accounts]', e));

function presence(claude) {
  const live = claude.filter((s) => s.status !== 'idle');
  const pick = live[0] || claude[0];
  if (!pick) return { status: 'idle', statusNote: 'no sessions in the last two days', step: '', thought: '' };
  return {
    status: live.length ? (live.some((s) => s.status === 'working') ? 'working' : 'blocked') : 'idle',
    statusNote: pick.statusNote,
    step: pick.step,
    thought: pick.thought,
    session: { id: pick.id, title: pick.title, cwd: pick.cwd, model: pick.model, remote: pick.remote },
    since: pick.lastActivity,
    activeSessions: live.length,
  };
}

function timeline(sessions, tasks) {
  const items = [];
  for (const s of sessions) {
    for (const st of s.steps) {
      items.push({ t: st.t, agent: s.agent, session: s.id, kind: st.kind, text: st.text, cwd: s.cwd, error: !!st.error });
    }
  }
  for (const k of tasks) {
    items.push({ t: k.updatedAt, agent: k.agent || 'task', kind: 'task', text: `${k.title} — ${k.status}`, cwd: k.cwd || '' });
  }
  return items.filter((x) => x.t).sort((a, b) => b.t - a.t).slice(0, 60);
}

function snapshot() {
  const claude = collectClaude();
  const codex = collectCodex();
  const tasks = collectTasks();
  ext = { t: Date.now(), sessions: [...claude, ...codex], tasks };
  const hidden = hub?.headSessions() || new Set();
  const sessions = [...claude, ...codex].filter((x) => !hidden.has(x.id)).sort((a, b) => b.lastActivity - a.lastActivity);

  const projects = work.list();
  // Attach which agents are working in each project.
  for (const p of projects) {
    const n = normPath(p.path);
    p.agents = sessions
      .filter((s) => s.cwd && (normPath(s.cwd) === n || normPath(s.cwd).startsWith(n + path.sep)))
      .filter((s) => !p.looseOnly || normPath(s.cwd) === n)
      .map((s) => ({ agent: s.agent, id: s.id, status: s.status, lastActivity: s.lastActivity, ...(s.context ? { context: s.context } : {}) }));
    p.lastActivity = Math.max(p.lastModified || 0, ...p.agents.map((a) => a.lastActivity));
  }

  return {
    v: 1,
    host: os.hostname(),
    workRoot: cfg.workRoot,
    ada: presence(claude.filter((x) => !hidden.has(x.id))),
    sessions: sessions.map(({ steps, ...s }) => ({ ...s, steps: steps.slice(-8) })),
    tasks,
    timeline: timeline(sessions, tasks),
    projects,
    accounts,
    limits: limits.active(), // services at their usage limit: [{ service, limited, resetText, resetsAt, at }]
    chat: hub?.view() || null,
    // Who is working where, per project folder (terminal sessions, Ada jobs, tasks), and what recently changed in the projects.
    activeMap: activeMap({ projects, workRoot: cfg.workRoot, sessions: ext.sessions, jobs: hub?.state.jobs || [], tasks, own: hub?.ownSessions() || new Set() }),
    journal: journal?.recent(50) || [],
    // Recent commits and pushes per GitHub project (bounded), from local git only.
    gitActivity: buildGitActivity([...work.projects.values()]),
  };
}

let lastDigest = '';
let lastWrite = 0;

function seal_(snap) {
  snap.generatedAt = Date.now();
  snap.stats = stats?.snapshot() || null;
  return JSON.stringify(seal(snap, key, cfg.salt));
}

// Slow path: local file + GitHub feed. Writes on real change (stats ignored) or every heartbeat.
function write(snap) {
  const digest = crypto.createHash('sha1').update(JSON.stringify(snap)).digest('hex');
  const now = Date.now();
  if (digest === lastDigest && now - lastWrite < HEARTBEAT_MS) return false;
  const body = seal_(snap);
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  const tmp = OUT + '.tmp';
  fs.writeFileSync(tmp, body);
  fs.renameSync(tmp, OUT);
  feed?.offer(body);
  if (dumpFile) fs.writeFileSync(dumpFile, JSON.stringify(snap, null, 2));
  lastDigest = digest;
  lastWrite = now;
  return true;
}

// Commits don't touch watched files, so projects with live or just-finished work are re-read every tick.
function watchActiveRepos() {
  const e = externals();
  const now = Date.now();
  const cwds = [
    ...e.sessions.filter((x) => x.cwd && (sessionActive(x, now) || now - x.lastActivity < 3 * 60e3)).map((x) => x.cwd),
    ...(hub?.state.jobs || []).filter((j) => j.status === 'running').map((j) => j.folder),
  ];
  for (const c of cwds) { const p = work.projectFor(c); if (p?.isRepo) work.dirtyGit.add(p); }
}

// What the git refresh reports goes into the journal, credited to whoever was working in that project.
function gitHook() {
  if (!journal) return null;
  const e = externals();
  const own = hub?.ownSessions() || new Set();
  return {
    prev: (p) => journal.seen(p.path),
    onUpdate: (p, info) => journal.observeGit(p, info, attribute(p.path, { sessions: e.sessions, jobs: hub?.state.jobs || [], tasks: e.tasks, own })),
  };
}

async function tick() {
  watchActiveRepos();
  await Promise.all([work.refreshGit(12, gitHook()), refreshAccounts()]);
  const e = externals();
  journal?.observeSessions(e.sessions, { projects: work.list(), workRoot: cfg.workRoot, own: hub?.ownSessions(), jobs: hub?.state.jobs || [] });
  hub?.tick(); // re-check held jobs now that sessions may have ended
  const snap = snapshot();
  const wrote = write(snap);
  const a = snap.ada;
  console.log(`[${new Date().toLocaleTimeString()}] ada=${a.status} sessions=${snap.sessions.length} projects=${snap.projects.length}${wrote ? ' (written)' : ''}${relay?.watching ? ` · streaming to ${relay.viewers}` : ''}`);
}

// Fast path: while a viewer is connected, stream a fresh snapshot every few seconds.
let streaming = false;
function streamLoop() {
  if (!relay?.watching) { streaming = false; return; }
  streaming = true;
  try { relay.send(seal_(snapshot())); } catch (e) { console.error('[stream]', e); }
  setTimeout(streamLoop, STREAM_MS);
}

// Chat commands from the page arrive sealed with the page password. Anything else is dropped.
function onCommand(env) {
  let cmd;
  try { cmd = open(env, key); } catch { console.log('[chat] dropped a message that was not sealed with the password'); return; }
  const why = hub.handle(cmd);
  if (cmd.type === 'upload-chunk' && !why) return; // hundreds per file: only log refusals
  console.log(`[chat] ${cmd.type || '?'}${why ? ` rejected: ${why}` : ''}`);
}

// Push chat changes right away instead of waiting for the next tick.
let pushTimer = null;
function pushSoon() {
  clearTimeout(pushTimer);
  pushTimer = setTimeout(() => {
    try {
      const snap = snapshot();
      write(snap);
      if (relay?.watching) relay.send(seal_(snap));
    } catch (e) { console.error('[push]', e); }
  }, 250);
}

console.log(`[collector] scanning ${cfg.workRoot} …`);
const t0 = Date.now();
work.scanAll();
console.log(`[collector] ${work.projects.size} projects in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

if (once) {
  await work.refreshGit(500);
  await work.refreshGithub(GH_CACHE);
  await refreshAccounts();
  write(snapshot());
  console.log(`[collector] wrote ${OUT}`);
  process.exit(0);
} else {
  stats = new Stats();
  hub = new ChatHub({
    workRoot: cfg.workRoot, projects: () => work.list(), onChange: pushSoon,
    // Media chunks are sealed like everything else; the leading "m":1 lets the relay pass them on without storing them as a snapshot.
    mediaOut: (obj) => relay?.sendMedia(JSON.stringify({ m: 1, ...seal(obj, key, cfg.salt) })),
    relayMedia: () => relay?.mediaOk,
  });
  if (cfg.relayUrl && cfg.relayKey) {
    relay = new RelayClient(cfg.relayUrl, cfg.relayKey, (n) => { if (n > 0 && !streaming) streamLoop(); }, onCommand);
  }
  work.watch();
  await work.refreshGit(500, gitHook());
  await work.refreshGithub(GH_CACHE);
  await tick();
  setInterval(() => tick().catch((e) => console.error('[collector]', e)), cfg.intervalSec * 1000);
  setInterval(() => { try { work.scanAll(); } catch (e) { console.error('[rescan]', e); } }, RESCAN_MS);
  setInterval(() => work.refreshGithub(GH_CACHE).catch((e) => console.error('[github]', e)), 10 * 60e3);
}
