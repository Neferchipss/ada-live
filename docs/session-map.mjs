// Pure model for the "Chats map": every chat as a branching tree. No DOM, no globals.
//   Ada (root) > project > folder (subfolder path segments) > session leaf, then a "Recent" branch of the same shape
//   holding sessions that finished within the last 24h. Built only from the snapshot's chat.sessions list.
import { projectOf, subOf, DAY } from './activity-model.mjs?v=sv-8';

export const OTHER_LABEL = 'Other';
export const RECENT_ID = 'recent';
const LIVE = new Set(['working', 'blocked']);
const arr = (x) => (Array.isArray(x) ? x : []);
const num = (x) => (Number.isFinite(x) ? x : 0);
const text = (x) => String(x ?? '').trim();
export const isLive = (status) => LIVE.has(status);

function placeOf(s, projects) {
  const proj = projectOf(projects, s.cwd);
  const project = text(s.project) || proj?.name || OTHER_LABEL;
  const sub = s.subfolder != null ? text(s.subfolder) : subOf(proj, s.cwd);
  return { project, segs: sub.split(/[\\/]+/).filter(Boolean) };
}

// working first, then most recent, then id (so the order never flickers)
const byRank = (a, b) => (b.meta.working > 0) - (a.meta.working > 0) || num(b.meta.lastAt) - num(a.meta.lastAt) || (a.id < b.id ? -1 : 1);

function leaf(s, prefix, now, recent) {
  const lastAt = num(s.lastAt);
  return {
    id: `${prefix}s:${s.agent}|${s.session}`, label: text(s.title) || text(s.project) || 'Session', kind: 'session', children: [],
    meta: { status: s.status || 'idle', source: s.source || '', agent: s.agent || '', agentKey: `${s.agent}|${s.session}`, session: s.session, ctx: s.context || null,
      ageMs: lastAt ? Math.max(0, now - lastAt) : null, lastAt, working: s.status === 'working' ? 1 : 0, live: isLive(s.status) ? 1 : 0, recent },
  };
}

// Sums for a group node from its children, then orders them.
function settle(node) {
  node.children.sort(byRank);
  const m = node.meta;
  m.live = node.children.reduce((n, c) => n + num(c.meta.live), 0);
  m.working = node.children.reduce((n, c) => n + num(c.meta.working), 0);
  m.count = node.children.reduce((n, c) => n + (c.kind === 'session' ? 1 : num(c.meta.count)), 0);
  m.lastAt = node.children.reduce((t, c) => Math.max(t, num(c.meta.lastAt)), 0);
  return node;
}
const group = (id, label, kind, recent) => ({ id, label, kind, children: [], meta: { status: '', source: '', agent: '', agentKey: '', session: '', ctx: null, ageMs: null, recent } });

// A folder with exactly one child that is itself a folder is merged into it: src > components becomes "src/components".
function collapse(node) {
  for (const c of node.children) collapse(c);
  node.children = node.children.map((c) => {
    let cur = c;
    while (cur.kind === 'folder' && cur.children.length === 1 && cur.children[0].kind === 'folder') {
      const only = cur.children[0];
      cur = { ...only, label: `${cur.label}/${only.label}` };
    }
    return cur;
  });
}

function branch(list, projectList, prefix, now, recent) {
  const projects = new Map();
  for (const s of list) {
    const { project, segs } = placeOf(s, projectList);
    let node = projects.get(project);
    if (!node) projects.set(project, node = group(`${prefix}p:${project}`, project, 'project', recent));
    for (let i = 0; i < segs.length; i++) {
      const id = `${node.id}/f:${segs[i]}`;
      let next = node.children.find((c) => c.id === id);
      if (!next) node.children.push(next = group(id, segs[i], 'folder', recent));
      node = next;
    }
    node.children.push(leaf(s, prefix, now, recent));
  }
  const out = [...projects.values()];
  for (const p of out) collapse(p);
  const walk = (n) => { n.children.forEach((c) => c.kind !== 'session' && walk(c)); return settle(n); };
  out.forEach(walk);
  // 'Other' always sits last among its siblings, whatever its rank.
  return out.sort((a, b) => (a.label === OTHER_LABEL) - (b.label === OTHER_LABEL) || byRank(a, b));
}

export function buildSessionMap(data, now = Date.now()) {
  const sessions = arr(data?.chat?.sessions).filter((s) => s && typeof s.session === 'string' && s.session && (s.agent === 'claude' || s.agent === 'codex' || (s.agent === 'task' && s.source === 'task')));
  const projects = arr(data?.projects);
  const seen = new Set();
  const uniq = sessions.filter((s) => { const k = `${s.agent}|${s.session}`; if (seen.has(k)) return false; seen.add(k); return true; });
  const active = uniq.filter((s) => isLive(s.status));
  const recent = uniq.filter((s) => !isLive(s.status) && num(s.lastAt) > 0 && now - s.lastAt <= DAY);

  const root = {
    id: 'root', label: 'Ada', kind: 'root', children: branch(active, projects, '', now, false),
    meta: { status: data?.chat?.thread?.busy ? 'working' : 'idle', source: 'ada', agent: data?.chat?.thread?.brain?.agent || '', agentKey: '', session: '', ctx: data?.chat?.thread?.context || null, ageMs: null, live: active.length, count: active.length, recent: false },
  };
  if (recent.length) {
    const r = group(RECENT_ID, 'Recent', 'folder', true);
    r.children = branch(recent, projects, 'r/', now, true);
    settle(r);
    r.meta.live = 0;
    root.children.push(r);
  }
  root.meta.empty = !uniq.length || (!active.length && !recent.length);
  root.meta.note = active.length ? '' : 'No active chats';
  return root;
}

// Flat count of leaves that are live, for the sheet title.
export const activeCount = (tree) => num(tree?.meta?.live);

// Chats on the switcher ribbon: only the active ones (same isLive the Map uses), plus the one being viewed even if it has
// just finished (so it stays put with a "finished" note until the user leaves it). Everything else lives in the Map.
// `list` is the snapshot's session list; `sel` is { agent, session } or null. Returns [{ ...session, finished }].
export function ribbonSessions(list, sel) {
  const seen = new Set();
  const out = [];
  for (const s of arr(list)) {
    if (!s || typeof s.session !== 'string' || !s.session) continue;
    const k = `${s.agent}|${s.session}`;
    if (seen.has(k)) continue;
    seen.add(k);
    const live = isLive(s.status);
    const viewed = !!sel && sel.agent === s.agent && sel.session === s.session;
    if (live || viewed) out.push({ ...s, finished: !live });
  }
  return out;
}
