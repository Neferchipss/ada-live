// Active-work map, conflict guard helpers and the change journal.
// The pure functions here decide who is working where (from the session/job/task data the other
// modules already produce); the Journal class remembers what changed in the projects, whoever did it.
// It stores names and subjects only: never file contents, diffs or anything that looks like a secret.
import fs from 'node:fs';
import path from 'node:path';
import { STATE_DIR } from './config.mjs';
import { clip, normPath } from './util.mjs';

export const JOURNAL_FILE = path.join(STATE_DIR, 'journal.json');
const MAX_ENTRIES = 400;
const MAX_AGE = 30 * 86400e3;
const MAX_FILES = 8;
const ACTIVE_BLOCKED_MS = 30 * 60e3;   // a "blocked" session (tool waiting on a permission) still counts if touched this recently
const TASK_STALE_MS = 2 * 3600e3;      // a task log that says "running" but went quiet this long ago is a leftover
const GRACE_MS = 3 * 60e3;             // a session that just finished is still credited for changes it caused
const COALESCE_MS = 10 * 60e3;         // dirty-file entries for one project merge into one while edits keep coming
const MIN_SESSION_MS = 20e3;           // shorter working bursts are not worth a journal line
const NOISE = [/^docs\/data\//];       // this viewer's own snapshot file changes every few seconds

// Names that must never reach the journal, the phone or Ada's prompt.
const SECRET = /(^|[\\/])\.env|token|password|passwd|credential|secret|(^|[\\/])\.git([\\/]|$)|\.ssh|\.pem$|\.key$|id_rsa/i;
export const isSecretName = (p) => SECRET.test(String(p || ''));
const isNoise = (p) => NOISE.some((r) => r.test(String(p || '').replace(/\\/g, '/')));

const AGENT = { claude: 'Claude', codex: 'Codex' };
const within = (child, parent) => child === parent || child.startsWith(parent + path.sep);
const rel = (from, to) => path.relative(from, to).split(path.sep).join('/');

/** Is this external session actually busy right now? Uses the status claude.mjs/codex.mjs already compute. */
export function sessionActive(s, now = Date.now()) {
  if (!s) return false;
  if (s.status === 'working') return true;
  return s.status === 'blocked' && now - (s.lastActivity || 0) < ACTIVE_BLOCKED_MS;
}

const taskActive = (k, now) => k?.status === 'running' && k.by !== 'ada-chat' && now - (k.updatedAt || k.createdAt || 0) < TASK_STALE_MS;

/** Which project is cwd in, and where inside it? null when it's outside the Work folder. */
export function locate(projects, workRoot, cwd) {
  if (!cwd) return null;
  const n = normPath(cwd);
  let best = null;
  for (const p of projects || []) {
    const k = normPath(p.path);
    if (!within(n, k)) continue;
    if (p.looseOnly && n !== k && path.dirname(n) !== k) continue;
    if (!best || k.length > normPath(best.path).length) best = p;
  }
  if (best) return { project: best.name, path: best.path, sub: n === normPath(best.path) ? '' : rel(best.path, path.resolve(cwd)) };
  if (workRoot && within(n, normPath(workRoot))) return { project: '(work root)', path: workRoot, sub: n === normPath(workRoot) ? '' : rel(workRoot, path.resolve(cwd)) };
  return null;
}

export const placeLabel = (loc) => (loc ? `${loc.project}${loc.sub ? ` › ${loc.sub}` : ''}` : '');

/**
 * Everything that is active, grouped per project folder.
 * sessions: claude.mjs/codex.mjs sessions; jobs: ChatHub jobs; tasks: collectTasks(); own: ids Ada started herself.
 * Result: [{ project, path, folder, subfolder, workers: [{ source, agent, mode, title, since, status, id, ... }] }]
 */
export function activeMap({ projects = [], workRoot = '', sessions = [], jobs = [], tasks = [], own = new Set(), now = Date.now() } = {}) {
  const groups = new Map();
  const add = (cwd, w) => {
    const loc = locate(projects, workRoot, cwd);
    if (!loc) return;
    const folder = path.resolve(cwd);
    const key = normPath(folder);
    if (!groups.has(key)) groups.set(key, { project: loc.project, path: loc.path, folder, subfolder: loc.sub, workers: [] });
    groups.get(key).workers.push(w);
  };
  for (const j of jobs) {
    if (!['running', 'queued', 'awaiting-approval', 'killing'].includes(j.status) || !j.folder) continue;
    add(j.folder, {
      source: 'ada-job', id: j.id, agent: j.agent, mode: j.mode || 'safe', title: clip(j.title, 80),
      since: j.startedAt || j.createdAt || now, status: j.status, ...(j.holdReason ? { hold: j.holdReason } : {}),
    });
  }
  for (const s of sessions) {
    if (!s.cwd || own.has(s.id) || !sessionActive(s, now)) continue;
    add(s.cwd, { source: 'terminal', id: s.id, agent: s.agent, mode: '', title: clip(s.title, 80), since: s.lastActivity || now, status: s.status });
  }
  for (const k of tasks) {
    if (!k.cwd || !taskActive(k, now)) continue;
    add(k.cwd, { source: 'task', id: k.id, agent: k.agent || 'task', mode: k.mode || '', title: clip(k.title, 80), since: k.startedAt || k.createdAt || now, status: k.status });
  }
  return [...groups.values()].sort((a, b) => a.project.localeCompare(b.project) || a.subfolder.localeCompare(b.subfolder));
}

/**
 * Is a non-chat worker (terminal session or task) active at, above or below folder?
 * A session sitting at the Work root itself (or above) is not counted: it would block every job.
 * Returns the reason Ada shows ("Claude session active in babajee › src") or null.
 */
export function findConflict(folder, { projects = [], workRoot = '', sessions = [], tasks = [], own = new Set(), now = Date.now() } = {}) {
  const f = normPath(folder), root = normPath(workRoot);
  const hit = (cwd) => {
    const c = normPath(cwd);
    if (!c || (root && within(root, c))) return false;
    return within(c, f) || within(f, c);
  };
  const where = (cwd) => placeLabel(locate(projects, workRoot, cwd)) || path.basename(cwd);
  for (const s of sessions) {
    if (s.cwd && !own.has(s.id) && sessionActive(s, now) && hit(s.cwd)) return `${AGENT[s.agent] || 'Agent'} session active in ${where(s.cwd)}`;
  }
  for (const k of tasks) {
    if (k.cwd && taskActive(k, now) && hit(k.cwd)) return `Task "${clip(k.title, 40)}" active in ${where(k.cwd)}`;
  }
  return null;
}

/** Who gets credit for a change in a project right now: sessions, jobs or tasks working inside it (or just finished). */
export function attribute(projectPath, { sessions = [], jobs = [], tasks = [], own = new Set(), now = Date.now() } = {}) {
  const p = normPath(projectPath);
  const by = new Set();
  for (const s of sessions) {
    if (!s.cwd || own.has(s.id) || !within(normPath(s.cwd), p)) continue;
    if (sessionActive(s, now) || now - (s.lastActivity || 0) < GRACE_MS) by.add(s.agent === 'codex' ? 'Codex' : 'Claude terminal session');
  }
  for (const j of jobs) if (j.status === 'running' && j.folder && within(normPath(j.folder), p)) by.add('Ada job');
  for (const k of tasks) if (k.cwd && taskActive(k, now) && within(normPath(k.cwd), p)) by.add('Task');
  return by.size ? [...by].join(' + ') : 'unknown';
}

/** One line for Ada: who is where right now. */
export function liveLine(map) {
  if (!map.length) return '[Live now] Nothing is active in any project.';
  const label = { terminal: 'terminal', 'ada-job': 'Ada job', task: 'task' };
  const parts = map.map((g) => `${g.project}${g.subfolder ? ` › ${g.subfolder}` : ''}: ${g.workers.map((w) => `${AGENT[w.agent] || w.agent} ${label[w.source]} ${w.status}`).join(', ')}`);
  return `[Live now] BUSY — ${parts.join(' | ')}`;
}

const hhmm = (t) => new Date(t).toTimeString().slice(0, 5);

function entryText(e) {
  switch (e.kind) {
    case 'commit': return `commit ${e.hash} "${e.subject}"`;
    case 'branch': return `branch ${e.from || '?'} → ${e.to}`;
    case 'dirty': return `${e.count} uncommitted file${e.count === 1 ? '' : 's'}${e.files?.length ? `: ${e.files.join(', ')}` : ''}`;
    case 'session': return `${e.agent} session ended in ${e.sub || 'project root'} after ${Math.max(1, Math.round(e.durMs / 60e3))} min${e.note ? `: ${e.note}` : ''}`;
    default: return e.kind;
  }
}

/** Pure digest for Ada's head turn: entries after `since`, grouped by project (newest first), within ~25 lines / ~3 KB. */
export function buildDigest(entries, { since = 0, maxLines = 25, maxBytes = 3072 } = {}) {
  const fresh = entries.filter((e) => e.t > since).sort((a, b) => b.t - a.t);
  if (!fresh.length) return '';
  const groups = new Map();
  for (const e of fresh) { if (!groups.has(e.project)) groups.set(e.project, []); groups.get(e.project).push(e); }
  const render = (lineCap, byteCap) => {
    const out = [];
    let bytes = 0, shown = 0;
    const push = (line) => {
      if (out.length >= lineCap || bytes + line.length + 1 > byteCap) return false;
      out.push(line); bytes += line.length + 1; return true;
    };
    outer: for (const [project, list] of groups) {
      if (!push(`${project}:`)) break;
      for (const e of list) {
        if (!push(`- ${hhmm(e.t)} ${clip(entryText(e), 300)} [${e.by}]`)) break outer;
        shown++;
      }
    }
    return { out, shown };
  };
  let { out, shown } = render(maxLines, maxBytes);
  if (shown < fresh.length) {
    // Leave room for the marker line so the cap still holds.
    ({ out, shown } = render(maxLines - 1, maxBytes - 60));
    out.push(`(+${fresh.length - shown} older changes not shown)`);
  }
  return out.join('\n');
}

export class Journal {
  constructor({ file = JOURNAL_FILE, now = Date.now } = {}) {
    this.file = file;
    this.now = now;
    this.data = { entries: [], seen: {} };
    try {
      const d = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (Array.isArray(d.entries)) this.data.entries = d.entries;
      if (d.seen && typeof d.seen === 'object') this.data.seen = d.seen;
    } catch { /* first run or unreadable: start empty */ }
    this.live = new Map(); // session id -> { since, agent, cwd, title, note } while it is active
    this.#prune();
  }

  #prune() {
    const cutoff = this.now() - MAX_AGE;
    const e = this.data.entries.filter((x) => x.t >= cutoff);
    this.data.entries = e.length > MAX_ENTRIES ? e.slice(-MAX_ENTRIES) : e;
  }

  #save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = this.file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(this.data));
      fs.renameSync(tmp, this.file);
    } catch { /* the journal is a convenience: never take the collector down */ }
  }

  /** Appends an entry unless it repeats the project's latest one; dirty entries keep merging while edits continue. */
  add(entry) {
    const t = this.now();
    const e = { t, ...entry };
    const list = this.data.entries;
    const last = [...list].reverse().find((x) => x.project === e.project);
    const sig = (x) => JSON.stringify([x.kind, x.hash, x.from, x.to, x.count, x.files, x.agent, x.sub, x.note]);
    if (last && sig(last) === sig(e)) return false;
    if (last && e.kind === 'dirty' && last.kind === 'dirty' && t - last.t < COALESCE_MS && last.by === e.by) Object.assign(last, e);
    else list.push(e);
    this.#prune();
    this.#save();
    return true;
  }

  /** Newest first. */
  recent(n = 50) { return this.data.entries.slice(-n).reverse(); }
  since(t) { return this.data.entries.filter((e) => e.t > t); }
  digest(since, opts) { return buildDigest(this.data.entries, { since, ...opts }); }

  /** Head and branch the project had when last looked at (null the first time), so the git refresh can ask for what is new. */
  seen(projectPath) { return this.data.seen[normPath(projectPath)] || null; }

  /**
   * Called from the git refresh. info: { head, branch, changed, paths, commits: [{hash, subject, ct}] }.
   * First sight of a project only sets a baseline, so existing history is not dumped into the journal.
   */
  observeGit(project, info, by = 'unknown') {
    const key = normPath(project.path);
    const seen = this.data.seen[key];
    const paths = (info.paths || []).filter((p) => !isNoise(p));
    const names = paths.filter((p) => !isSecretName(p)).slice(0, MAX_FILES);
    const dirty = `${paths.length}|${names.join(',')}`;
    const base = { project: project.name, path: project.path };
    if (!seen) {
      this.data.seen[key] = { head: info.head || '', branch: info.branch || '', dirty };
      this.#save();
      return;
    }
    const branchMoved = info.branch && seen.branch && info.branch !== seen.branch;
    if (branchMoved) this.add({ ...base, kind: 'branch', from: seen.branch, to: info.branch, by });
    if (!branchMoved && info.head && seen.head && info.head !== seen.head) {
      for (const c of [...(info.commits || [])].reverse().slice(-10)) {
        this.add({ ...base, kind: 'commit', hash: String(c.hash).slice(0, 7), subject: clip(c.subject, 120), ct: c.ct, by });
      }
    }
    if (dirty !== seen.dirty && paths.length) this.add({ ...base, kind: 'dirty', count: paths.length, files: names, by });
    this.data.seen[key] = { head: info.head || seen.head, branch: info.branch || seen.branch, dirty };
    this.#save();
  }

  /** Called every collector tick with the external sessions: writes a line when one goes from working to idle. */
  observeSessions(sessions, ctx) {
    const now = this.now();
    const byId = new Map(sessions.map((s) => [s.id, s]));
    for (const s of sessions) {
      if (ctx.own?.has(s.id)) continue;
      if (sessionActive(s, now)) {
        const prev = this.live.get(s.id);
        this.live.set(s.id, { since: prev?.since || now, agent: s.agent, cwd: s.cwd, title: s.title, note: s.thought || s.title });
      }
    }
    for (const [id, l] of [...this.live]) {
      const s = byId.get(id);
      if (s && sessionActive(s, now)) continue;
      this.live.delete(id);
      const durMs = now - l.since;
      const loc = locate(ctx.projects, ctx.workRoot, l.cwd);
      if (!loc || durMs < MIN_SESSION_MS) continue;
      this.add({
        project: loc.project, path: loc.path, kind: 'session', agent: AGENT[l.agent] || l.agent, sub: loc.sub, durMs,
        note: clip((s?.thought || l.note), 240), by: l.agent === 'codex' ? 'Codex' : 'Claude terminal session',
      });
    }
  }
}
