// Pure logic for the Activity page (shared by the page and tests). No DOM, no globals.
// Everything is computed from the snapshot as given; a value that cannot be known is null (the page shows a dash).

export const DAY = 86400e3;
export const ATTENTION_WINDOW = DAY;
export const TIMELINE_CAP = 120;
export const PROJECT_LIMIT = 12;
export const OTHER_KEY = '';

const arr = (x) => (Array.isArray(x) ? x : null);
const num = (x) => (Number.isFinite(x) ? x : 0);
export const startOfDay = (now) => { const d = new Date(now); d.setHours(0, 0, 0, 0); return d.getTime(); };

// Windows-tolerant path key: slash direction, case, trailing separator.
export const normPath = (p) => String(p || '').replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
const within = (child, parent) => child === parent || child.startsWith(`${parent}\\`);

// Deepest project containing cwd, or null. Same rule as the collector's locate(): longest path wins.
export function projectOf(projects, cwd) {
  const n = normPath(cwd);
  if (!n) return null;
  let best = null;
  for (const p of arr(projects) || []) {
    const k = normPath(p?.path);
    if (k && within(n, k) && (!best || k.length > normPath(best.path).length)) best = p;
  }
  return best;
}

// Subfolder of cwd inside the project ('' at the root).
export function subOf(project, cwd) {
  if (!project || !cwd) return '';
  const k = normPath(project.path), n = normPath(cwd);
  if (n === k || !within(n, k)) return '';
  return String(cwd).replace(/\//g, '\\').replace(/\\+$/, '').slice(k.length + 1).replace(/\\/g, '/');
}

const taskEnd = (k) => k.endedAt || k.updatedAt || 0;
const hashKey = (h) => String(h || '').slice(0, 7).toLowerCase();
const gitCommits = (data) => (arr(data?.gitActivity) || []).flatMap((g) => (arr(g.commits) || []).map((c) => ({ path: g.path, name: g.name, ...c })));

// An approval that expired or was denied never ran: it is not a failure. The task log records both as 'failed',
// so the job's own status wins when the same id is in both.
const LAPSED = new Set(['expired', 'denied']);
export const isLapsed = (j) => LAPSED.has(j?.status);

// A task's display name: its title, else the folder it ran in, else "Task <id>".
export function taskTitle(k) {
  if (k?.title) return k.title;
  const folder = String(k?.cwd || k?.folder || '').replace(/[\\/]+$/, '').split(/[\\/]/).pop();
  return folder || (k?.id ? `Task ${k.id}` : 'Task');
}

// Tasks plus Ada jobs that are not already listed as a task (a job appears in both once it finishes).
function workItems(data) {
  const tasks = arr(data?.tasks), jobs = arr(data?.chat?.jobs);
  if (!tasks && !jobs) return null;
  const byId = new Map((jobs || []).filter(Boolean).map((j) => [j.id, j]));
  const ids = new Set((tasks || []).map((k) => k?.id));
  return [
    ...(tasks || []).filter(Boolean).map((k) => (isLapsed(byId.get(k.id)) ? { ...k, status: byId.get(k.id).status } : k)),
    ...(jobs || []).filter((j) => j && !ids.has(j.id)),
  ];
}

/* Dismissed attention items live on the device (localStorage 'ada-dismissed'), as a plain list of ids, oldest first. */
export const DISMISS_CAP = 300;
export function parseDismissed(raw) {
  try {
    const v = JSON.parse(raw || '[]');
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x).slice(-DISMISS_CAP) : [];
  } catch { return []; }
}
export const addDismissed = (list, ids) => [...new Set([...list, ...ids])].slice(-DISMISS_CAP);
export const removeDismissed = (list, ids) => list.filter((x) => !ids.includes(x));

// Commits since `since`, from git activity and the journal, de-duplicated by (project, hash).
function commitsSince(data, since) {
  const journal = arr(data?.journal), git = arr(data?.gitActivity);
  if (!journal && !git) return null;
  const projects = arr(data?.projects) || [];
  const seen = new Set();
  const fresh = (where, h) => { const k = `${normPath(where)}|${hashKey(h)}`; if (seen.has(k)) return false; seen.add(k); return true; };
  let n = 0;
  for (const c of gitCommits(data)) if (num(c.t) >= since && c.h && fresh(c.path, c.h)) n++;
  for (const e of journal || []) {
    if (e?.kind !== 'commit' || num(e.t) < since) continue;
    const where = e.path || projects.find((p) => p.name === e.project)?.path || e.project;
    if (!e.hash || fresh(where, e.hash)) n++;
  }
  return n;
}

export function todayStats(data, now, dismissed = []) {
  const since = startOfDay(now);
  const work = workItems(data);
  const hidden = new Set(dismissed);
  const finished = (status) => (work ? work.filter((k) => k.status === status && taskEnd(k) >= since && !(status === 'failed' && hidden.has(k.id))).length : null);
  const map = arr(data?.activeMap), sessions = arr(data?.sessions), git = arr(data?.gitActivity);
  return {
    active: map ? map.reduce((n, g) => n + (arr(g.workers) || []).filter((w) => w.status !== 'awaiting-approval').length, 0) : null,
    done: finished('done'),
    failed: finished('failed'),
    commits: commitsSince(data, since),
    unpushed: git ? git.reduce((n, g) => n + num(g.ahead), 0) : null,
    sessions: sessions ? sessions.filter((s) => !s.parent && num(s.lastActivity) >= since).length : null,
  };
}

// What to look at: failed (last 24h), held, unpushed projects, usage limits. Empty list = hide the section.
// Expired or denied approvals are not here: they live in the Approval history, muted.
export function needsAttention(data, now) {
  const out = [];
  const cutoff = now - ATTENTION_WINDOW;
  for (const k of workItems(data) || []) {
    const title = taskTitle(k), job = !!k.folder;
    if (k.status === 'failed' && taskEnd(k) >= cutoff) {
      out.push({ kind: 'failed', id: k.id, title, detail: 'failed', t: taskEnd(k), job });
    } else if (k.status === 'queued' && k.holdReason) {
      out.push({ kind: 'held', id: k.id, title, detail: `held: ${k.holdReason}`, t: num(k.createdAt), job: true });
    }
  }
  for (const g of arr(data?.gitActivity) || []) {
    if (num(g.ahead) > 0) out.push({ kind: 'unpushed', id: g.path, path: g.path, title: g.name || g.path, detail: `${g.ahead} not pushed`, ahead: g.ahead, t: Math.max(0, ...(arr(g.commits) || []).map((c) => num(c.t))) });
  }
  for (const l of arr(data?.limits) || []) {
    if (l?.limited && (!l.resetsAt || l.resetsAt > now)) out.push({ kind: 'limit', id: l.service, title: `${l.service} usage limit`, detail: l.resetText ? `resets ${l.resetText}` : 'reset time unknown', t: 0 });
  }
  const rank = { failed: 0, held: 1, limit: 2, unpushed: 3 };
  return out.sort((a, b) => rank[a.kind] - rank[b.kind] || b.t - a.t);
}

export const FAILED_LIMIT = 5;
export const UNPUSHED_LIMIT = 5;

// Shapes the attention list for the page: failed items individually (first FAILED_LIMIT, then "Show more"), held and
// limit rows as they are, and ALL unpushed projects folded into one row (the UNPUSHED_LIMIT most recent, then "Show all").
// `dismissed` ids hide failed items; those come back as `dismissed` so the page can offer to show them.
export function attentionView(list, { dismissed = [], failedAll = false, unpushedAll = false } = {}) {
  const hide = new Set(dismissed);
  const failedAllItems = list.filter((a) => a.kind === 'failed');
  const failed = failedAllItems.filter((a) => !hide.has(a.id));
  const unpushed = list.filter((a) => a.kind === 'unpushed').sort((a, b) => b.t - a.t);
  return {
    failed: failedAll ? failed : failed.slice(0, FAILED_LIMIT),
    failedHidden: failedAll ? 0 : Math.max(0, failed.length - FAILED_LIMIT),
    failedIds: failed.map((a) => a.id),
    dismissed: failedAllItems.filter((a) => hide.has(a.id)),
    others: list.filter((a) => a.kind === 'held' || a.kind === 'limit'),
    unpushed: { projects: unpushed.length, total: unpushed.reduce((n, a) => n + num(a.ahead), 0), items: unpushedAll ? unpushed : unpushed.slice(0, UNPUSHED_LIMIT), hidden: unpushedAll ? 0 : Math.max(0, unpushed.length - UNPUSHED_LIMIT) },
    count: failed.length + list.filter((a) => a.kind === 'held' || a.kind === 'limit').length + (unpushed.length ? 1 : 0),
  };
}

// Approvals still open, for the single "N waiting for approval" line.
export const waitingApprovals = (data, now) => (arr(data?.chat?.jobs) || [])
  .filter((j) => j.status === 'awaiting-approval' && !(Number.isFinite(j.approvalExpiresAt) && j.approvalExpiresAt <= now)).length;

// Running/queued work from the active-work map, by project + subfolder. Approvals are excluded.
export function nowGroups(data) {
  const out = [];
  for (const g of arr(data?.activeMap) || []) {
    const workers = (arr(g.workers) || []).filter((w) => w.status !== 'awaiting-approval');
    if (workers.length) out.push({ project: g.project, path: g.path, subfolder: g.subfolder || '', workers });
  }
  return out.sort((a, b) => String(a.project).localeCompare(b.project) || a.subfolder.localeCompare(b.subfolder));
}

// Per-project history. Each item: { type: task | event | change, t, sub, ... }, newest first.
// Projects sort by last activity, 'Other' (items outside every project) always last.
export function byProject(data) {
  const projects = arr(data?.projects) || [];
  const groups = new Map();
  const group = (p) => {
    const key = p ? p.path : OTHER_KEY;
    if (!groups.has(key)) groups.set(key, { key, name: p ? p.name : 'Other', path: p?.path || '', last: p ? num(p.lastActivity) : 0, counts: { tasks: 0, sessions: 0, commits: 0, unpushed: 0 }, items: [] });
    return groups.get(key);
  };
  const put = (cwd, item) => {
    const p = projectOf(projects, cwd);
    const g = group(p);
    g.items.push({ ...item, sub: subOf(p, cwd) });
    return g;
  };
  for (const k of arr(data?.tasks) || []) put(k.cwd, { type: 'task', t: num(k.updatedAt), task: k }).counts.tasks++;
  for (const i of arr(data?.timeline) || []) {
    if (i.kind !== 'task') put(i.cwd, { type: 'event', t: num(i.t), item: i });
  }
  const logged = new Set();
  for (const e of arr(data?.journal) || []) {
    const p = (e.path && projectOf(projects, e.path)) || projects.find((x) => x.name === e.project) || null;
    const g = group(p);
    g.items.push({ type: 'change', t: num(e.t), change: e, sub: e.sub || '' });
    if (e.kind === 'commit') { g.counts.commits++; logged.add(`${g.key}|${hashKey(e.hash)}`); }
  }
  for (const c of gitCommits(data)) {
    const g = group(projectOf(projects, c.path));
    if (logged.has(`${g.key}|${hashKey(c.h)}`)) continue;
    g.items.push({ type: 'change', t: num(c.t), change: { kind: 'commit', hash: c.h, subject: c.s, by: c.a, t: c.t }, sub: '' });
    g.counts.commits++;
  }
  const seen = new Set();
  for (const s of arr(data?.sessions) || []) {
    if (s.parent || seen.has(s.id)) continue;
    seen.add(s.id);
    const g = group(projectOf(projects, s.cwd));
    g.counts.sessions++;
    // The freshest session that knows its context size, shown quietly on the project card.
    if (s.context && (!g.ctx || num(s.lastActivity) > g.ctx.t)) g.ctx = { context: s.context, agent: s.agent, t: num(s.lastActivity) };
  }
  for (const g of arr(data?.gitActivity) || []) {
    if (num(g.ahead) > 0) group(projectOf(projects, g.path)).counts.unpushed = g.ahead;
  }
  const list = [...groups.values()].filter((g) => g.items.length || g.counts.sessions || g.counts.unpushed);
  for (const g of list) {
    g.items.sort((a, b) => b.t - a.t);
    g.last = Math.max(g.last, g.items[0]?.t || 0);
  }
  return list.sort((a, b) => (a.key === OTHER_KEY) - (b.key === OTHER_KEY) || b.last - a.last);
}

// Inclusive lower bound for a range chip ('today' | '7d' | 'all'); null = unbounded.
export const rangeStart = (range, now) => (range === 'today' ? startOfDay(now) : range === '7d' ? now - 7 * DAY : null);
export const inRange = (t, range, now) => { const s = rangeStart(range, now); return s === null || num(t) >= s; };

// The flat feed: filter chip + range chip, newest first, capped.
export function timelineRows(data, { filter = 'all', range = '7d', cap = TIMELINE_CAP } = {}, now) {
  const items = [];
  if (filter !== 'agents' && filter !== 'you') {
    for (const k of arr(data?.tasks) || []) items.push({ t: num(k.updatedAt), task: k });
  }
  if (filter !== 'tasks') {
    for (const i of arr(data?.timeline) || []) {
      if (i.kind === 'task') continue;
      if (filter === 'you' && i.kind !== 'prompt') continue;
      items.push({ t: num(i.t), item: i });
    }
  }
  return items.filter((x) => inRange(x.t, range, now)).sort((a, b) => b.t - a.t).slice(0, cap);
}
