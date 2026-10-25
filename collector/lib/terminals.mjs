// Which interactive Claude Code / Codex terminals are open right now, even when their transcript has gone quiet.
//
// Signal (Claude): Claude Code keeps ~/.claude/sessions/<pid>.json for every running CLI with { pid, sessionId, cwd,
// kind, entrypoint, startedAt, procStart }. A file counts only while a process with that pid is alive AND was created
// when the file says (guards against pid reuse after a crash). Reliability: high, the file names the session id.
// Signal (Codex): no per-process file exists; a live codex.exe is matched to the rollout that started after it and was
// written most recently. Reliability: low (the process has no cwd or id we can read without extra software).
// Only process name, pid and start time are read; command lines are never requested.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { safeReaddir } from './util.mjs';

const SESSIONS_DIR = path.join(os.homedir(), '.claude', 'sessions');
const CACHE_MS = 10e3;
const EXEC_TIMEOUT_MS = 8e3;
const START_SLOP_MS = 2 * 60e3;     // pid file start vs process creation time
const CODEX_LEAD_MS = 5e3;          // a rollout may begin a moment before the process-start timestamp we see
const FILETIME_EPOCH_MS = 11644473600000;

const isPid = (n) => Number.isInteger(n) && n > 0 && n < 2 ** 31;
const isId = (s) => typeof s === 'string' && /^[\w-]{8,64}$/.test(s);

/** Process start (ms since epoch) a pid file claims: Windows FILETIME `procStart`, else `startedAt`. */
export function claimedStart(f) {
  const ft = Number(f?.procStart);
  if (Number.isFinite(ft) && ft > 1e17) return ft / 1e4 - FILETIME_EPOCH_MS;
  return Number.isFinite(f?.startedAt) ? f.startedAt : 0;
}

/**
 * Pure: pid files + live processes -> open terminals.
 * pidFiles: parsed ~/.claude/sessions/*.json; procs: Map pid -> { name, startMs } or null when the list is unreadable
 * (then `isAlive(pid)` decides, without the pid-reuse check); codexProcs: [{ pid, startMs }];
 * codexSessions: collectCodex() sessions (used to find the rollout of each codex process).
 * Returns [{ agent, id, pid, cwd, startedAt, via }], one entry per terminal.
 */
export function mapOpenTerminals({ pidFiles = [], procs = null, isAlive = () => false, codexProcs = [], codexSessions = [] } = {}) {
  const out = [];
  const seen = new Set();
  for (const f of pidFiles) {
    if (!f || f.kind !== 'interactive' || !isPid(f.pid) || !isId(f.sessionId)) continue;
    if (typeof f.entrypoint === 'string' && f.entrypoint.startsWith('sdk')) continue; // programmatic runs (Ada's workers), not a terminal
    const start = claimedStart(f);
    if (procs) {
      const p = procs.get(f.pid);
      if (!p || (start && p.startMs && Math.abs(p.startMs - start) > START_SLOP_MS)) continue;
    } else if (!isAlive(f.pid)) continue;
    if (seen.has(f.sessionId)) continue;
    seen.add(f.sessionId);
    out.push({ agent: 'claude', id: f.sessionId, pid: f.pid, cwd: typeof f.cwd === 'string' ? f.cwd : '', startedAt: start || 0, via: 'pid-file' });
  }
  // Codex: newest process first, each takes the most recently written unclaimed rollout that began after it started.
  const taken = new Set();
  for (const p of [...codexProcs].sort((a, b) => b.startMs - a.startMs)) {
    if (!isPid(p.pid) || !p.startMs) continue;
    const cand = codexSessions
      .filter((s) => s.agent === 'codex' && !s.parent && !taken.has(s.id) && s.startedAt >= p.startMs - CODEX_LEAD_MS)
      .sort((a, b) => b.lastActivity - a.lastActivity || (a.id < b.id ? -1 : 1))[0];
    if (!cand) continue;
    taken.add(cand.id);
    out.push({ agent: 'codex', id: cand.id, pid: p.pid, cwd: cand.cwd || '', startedAt: p.startMs, via: 'process' });
  }
  return out;
}

/** Pure: stamps `open`/`pid` on the matching sessions and fills a missing cwd from the pid file. Returns the same array. */
export function markOpen(sessions, open) {
  const byKey = new Map((open || []).map((o) => [`${o.agent}:${o.id}`, o]));
  for (const s of sessions || []) {
    const o = byKey.get(`${s.agent}:${s.id}`);
    if (!o) continue;
    s.open = true;
    s.pid = o.pid;
    if (!s.cwd && o.cwd) s.cwd = o.cwd;
  }
  return sessions;
}

// ---- I/O (never throws) ----

function readPidFiles(dir = SESSIONS_DIR) {
  const out = [];
  for (const d of safeReaddir(dir)) {
    if (!d.isFile() || !/^\d+\.json$/.test(d.name)) continue;
    try {
      const j = JSON.parse(fs.readFileSync(path.join(dir, d.name), 'utf8'));
      if (j && typeof j === 'object') out.push(j);
    } catch { /* half-written or foreign file */ }
  }
  return out;
}

const PS = (pids) => `$ErrorActionPreference='SilentlyContinue';$f="Name='codex.exe'${pids.map((p) => ` or ProcessId=${p}`).join('')}";`
  + `@(Get-CimInstance Win32_Process -Filter $f | ForEach-Object { [pscustomobject]@{ pid=[int]$_.ProcessId; name=$_.Name; t=[int64]([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds() } }) | ConvertTo-Json -Compress`;

/** Live processes: pids from `pids` plus every codex.exe. Resolves null when the list can't be read. */
function listProcesses(pids) {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') return resolve(null);
    try {
      execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', PS(pids.filter(isPid))],
        { timeout: EXEC_TIMEOUT_MS, windowsHide: true, maxBuffer: 1 << 20 }, (err, stdout) => {
          if (err) return resolve(null);
          try {
            const j = JSON.parse(String(stdout).trim() || '[]');
            resolve((Array.isArray(j) ? j : [j]).filter((p) => p && isPid(p.pid)).map((p) => ({ pid: p.pid, name: String(p.name || ''), startMs: Number(p.t) || 0 })));
          } catch { resolve(null); }
        });
    } catch { resolve(null); }
  });
}

const aliveByKill = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

let cache = { t: 0, pidFiles: [], procs: null, codexProcs: [] };
let inflight = null;

/** Re-reads pid files and the process list (at most once per 10 s unless `force`). Never rejects. */
export function refreshOpenTerminals({ force = false, dir } = {}) {
  if (inflight) return inflight;
  if (!force && Date.now() - cache.t < CACHE_MS) return Promise.resolve();
  inflight = (async () => {
    try {
      const pidFiles = readPidFiles(dir);
      const list = await listProcesses(pidFiles.map((f) => f.pid).filter(isPid));
      const procs = list ? new Map(list.filter((p) => p.name.toLowerCase() !== 'codex.exe').map((p) => [p.pid, p])) : null;
      const codexProcs = list ? list.filter((p) => p.name.toLowerCase() === 'codex.exe') : [];
      cache = { t: Date.now(), pidFiles, procs, codexProcs };
    } catch { cache = { ...cache, t: Date.now() }; }
    finally { inflight = null; }
  })();
  return inflight;
}

/**
 * Terminals open right now: [{ agent, id, pid, cwd, startedAt, via }]. Synchronous: answers from the last refresh
 * (cached ~10 s) and starts a new one when stale. Empty before the first refresh or when nothing can be read,
 * which is exactly the old behaviour (a session is only active while its transcript is written).
 */
export function openTerminalSessions({ codexSessions = [] } = {}) {
  try {
    if (Date.now() - cache.t >= CACHE_MS) refreshOpenTerminals();
    return mapOpenTerminals({ pidFiles: cache.pidFiles, procs: cache.procs, isAlive: aliveByKill, codexProcs: cache.codexProcs, codexSessions });
  } catch { return []; }
}
