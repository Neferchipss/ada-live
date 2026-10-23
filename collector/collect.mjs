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
import { deriveKey, seal } from './lib/crypto.mjs';
import { collectClaude } from './lib/claude.mjs';
import { collectCodex } from './lib/codex.mjs';
import { collectTasks } from './lib/tasks.mjs';
import { WorkMap } from './lib/work.mjs';
import { normPath } from './lib/util.mjs';
import { FeedPublisher } from './lib/feed.mjs';

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
const key = deriveKey(cfg.password, cfg.salt);
const work = new WorkMap(cfg.workRoot);
// feedRemote in config (e.g. https://github.com/<you>/ada-live.git) turns on publishing.
const feed = cfg.feedRemote && !once ? new FeedPublisher(cfg.feedRemote, (cfg.pushSec || 60) * 1000) : null;
let stats = null;
let relay = null;

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
  const sessions = [...claude, ...codex].sort((a, b) => b.lastActivity - a.lastActivity);

  const projects = work.list();
  // Attach which agents are working in each project.
  for (const p of projects) {
    const n = normPath(p.path);
    p.agents = sessions
      .filter((s) => s.cwd && (normPath(s.cwd) === n || normPath(s.cwd).startsWith(n + path.sep)))
      .filter((s) => !p.looseOnly || normPath(s.cwd) === n)
      .map((s) => ({ agent: s.agent, id: s.id, status: s.status, lastActivity: s.lastActivity }));
    p.lastActivity = Math.max(p.lastModified || 0, ...p.agents.map((a) => a.lastActivity));
  }

  return {
    v: 1,
    host: os.hostname(),
    workRoot: cfg.workRoot,
    ada: presence(claude),
    sessions: sessions.map(({ steps, ...s }) => ({ ...s, steps: steps.slice(-8) })),
    tasks,
    timeline: timeline(sessions, tasks),
    projects,
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

async function tick() {
  await work.refreshGit();
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

console.log(`[collector] scanning ${cfg.workRoot} …`);
const t0 = Date.now();
work.scanAll();
console.log(`[collector] ${work.projects.size} projects in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

if (once) {
  await work.refreshGit(500);
  await work.refreshGithub(GH_CACHE);
  write(snapshot());
  console.log(`[collector] wrote ${OUT}`);
  process.exit(0);
} else {
  stats = new Stats();
  if (cfg.relayUrl && cfg.relayKey) {
    relay = new RelayClient(cfg.relayUrl, cfg.relayKey, (n) => { if (n > 0 && !streaming) streamLoop(); });
  }
  work.watch();
  await work.refreshGit(500);
  await work.refreshGithub(GH_CACHE);
  await tick();
  setInterval(() => tick().catch((e) => console.error('[collector]', e)), cfg.intervalSec * 1000);
  setInterval(() => { try { work.scanAll(); } catch (e) { console.error('[rescan]', e); } }, RESCAN_MS);
  setInterval(() => work.refreshGithub(GH_CACHE).catch((e) => console.error('[github]', e)), 10 * 60e3);
}
