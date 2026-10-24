import test from 'node:test';
import assert from 'node:assert/strict';
import { todayStats, needsAttention, attentionView, taskTitle, parseDismissed, addDismissed, removeDismissed, DISMISS_CAP, byProject } from '../docs/activity-model.mjs';
import { resolvedGroups } from '../docs/approvals.mjs';

const NOW = new Date(2026, 5, 15, 15, 0, 0).getTime();
const H = 3600e3;

const failedMany = (n) => Array.from({ length: n }, (_, i) => ({ id: `f${i}`, title: `F${i}`, status: 'failed', endedAt: NOW - (i + 1) * 60e3, updatedAt: NOW - (i + 1) * 60e3 }));
const gitMany = (n) => Array.from({ length: n }, (_, i) => ({ name: `p${i}`, path: `C:\\Work\\p${i}`, ahead: i + 1, commits: [{ h: `h${i}`, t: NOW - (n - i) * H }] }));

// ---------- expired / denied are not failures ----------

// The task log records an expired or denied approval as 'failed'; the chat job says what really happened.
const lapsedData = () => ({
  tasks: [
    { id: 'e1', title: 'Expired ops', status: 'failed', endedAt: NOW - H, updatedAt: NOW - H },
    { id: 'd1', title: 'Denied full', status: 'failed', endedAt: NOW - H, updatedAt: NOW - H },
    { id: 'f1', title: 'Real failure', status: 'failed', endedAt: NOW - H, updatedAt: NOW - H },
  ],
  chat: { jobs: [
    { id: 'e1', title: 'Expired ops', status: 'expired', mode: 'ops', folder: 'C:\\Work\\other', endedAt: NOW - H },
    { id: 'd1', title: 'Denied full', status: 'denied', mode: 'full', folder: 'C:\\Work\\other', endedAt: NOW - H },
    { id: 'x1', title: 'Expired, no task row', status: 'expired', mode: 'ops', folder: 'C:\\Work\\other', endedAt: NOW - H },
  ] },
});

test('expired and denied approvals never count as failed and never appear in needs attention', () => {
  assert.equal(todayStats(lapsedData(), NOW).failed, 1);
  assert.deepEqual(needsAttention(lapsedData(), NOW).map((a) => `${a.kind}:${a.id}`), ['failed:f1']);
  const open = { chat: { jobs: [{ id: 'o1', status: 'awaiting-approval', approvalExpiresAt: NOW - 1, createdAt: NOW - 10 * 60e3 }] } };
  assert.deepEqual(needsAttention(open, NOW), [], 'a lapsed-but-unmarked approval is not an attention row either');
});

test('approval history: ran and expired/denied are separate groups, each capped', () => {
  const jobs = [
    { id: 'a', mode: 'ops', status: 'done', endedAt: NOW - 5 * H },
    { id: 'b', mode: 'full', status: 'expired', endedAt: NOW - 4 * H },
    { id: 'c', mode: 'full', status: 'denied', endedAt: NOW - 3 * H },
    { id: 'd', mode: 'ops', status: 'failed', endedAt: NOW - 2 * H },
    { id: 'e', mode: 'safe', status: 'done', endedAt: NOW - H },
    { id: 'f', mode: 'ops', status: 'awaiting-approval', createdAt: NOW },
  ];
  const g = resolvedGroups(jobs, NOW);
  assert.deepEqual(g.ran.map((j) => j.id), ['d', 'a']);
  assert.deepEqual(g.lapsed.map((j) => j.id), ['c', 'b']);
  assert.deepEqual(resolvedGroups(jobs, NOW, 1).lapsed.map((j) => j.id), ['c']);
  assert.deepEqual(resolvedGroups([], NOW), { ran: [], lapsed: [] });
  assert.deepEqual(resolvedGroups(null, NOW), { ran: [], lapsed: [] });
});

test('untitled tasks show their folder name, else "Task <id>"', () => {
  assert.equal(taskTitle({ title: 'Render' }), 'Render');
  assert.equal(taskTitle({ id: 'ab12', cwd: 'C:\\Work\\Personal\\proj\\' }), 'proj');
  assert.equal(taskTitle({ id: 'ab12', folder: 'C:/Work/x' }), 'x');
  assert.equal(taskTitle({ id: 'ab12' }), 'Task ab12');
  assert.equal(taskTitle({}), 'Task');
  const a = needsAttention({ tasks: [{ id: 'u1', status: 'failed', cwd: 'C:\\Work\\other', endedAt: NOW - H }, { id: 'u2', status: 'failed', endedAt: NOW - H }] }, NOW);
  assert.deepEqual(a.map((x) => x.title).sort(), ['Task u2', 'other']);
});

// ---------- dismiss ----------

test('dismissed failed items do not count in the Failed tile, and count again when restored', () => {
  const d = { tasks: failedMany(3), chat: { jobs: [{ id: 'j4', title: 'Job', status: 'failed', endedAt: NOW - 3 * H, folder: 'C:\\Work\\other' }, { id: 'ok', title: 'Fine', status: 'done', endedAt: NOW - H, folder: 'C:\\Work\\other' }] } };
  assert.equal(todayStats(d, NOW).failed, 4);
  assert.equal(todayStats(d, NOW, ['f1']).failed, 3);
  assert.equal(todayStats(d, NOW, ['f0', 'f1', 'f2', 'j4', 'nope']).failed, 0);
  assert.equal(todayStats(d, NOW, ['ok']).done, 1, 'only failed items are affected');
  assert.equal(todayStats(d, NOW, removeDismissed(['f0', 'f1'], ['f0'])).failed, 3);
});

test('dismissed list: parse tolerates junk, add de-duplicates and caps, remove drops ids', () => {
  assert.deepEqual(parseDismissed('["a","b",3,null,""]'), ['a', 'b']);
  for (const bad of [null, undefined, '', '{', '{"a":1}', '5']) assert.deepEqual(parseDismissed(bad), []);
  assert.deepEqual(addDismissed(['a', 'b'], ['b', 'c']), ['a', 'b', 'c']);
  const many = addDismissed([], Array.from({ length: DISMISS_CAP + 20 }, (_, i) => `id${i}`));
  assert.equal(many.length, DISMISS_CAP);
  assert.equal(many.at(-1), `id${DISMISS_CAP + 19}`, 'the oldest ids fall off');
  assert.deepEqual(removeDismissed(['a', 'b', 'c'], ['b', 'zz']), ['a', 'c']);
});

test('dismissed failed items leave the list and are offered separately', () => {
  const list = needsAttention({ tasks: failedMany(3) }, NOW);
  const v = attentionView(list, { dismissed: ['f1', 'gone'] });
  assert.deepEqual(v.failed.map((a) => a.id), ['f0', 'f2']);
  assert.deepEqual(v.dismissed.map((a) => a.id), ['f1']);
  assert.equal(v.count, 2);
  assert.equal(attentionView(list, { dismissed: ['f0', 'f1', 'f2'] }).count, 0);
});

// ---------- attention view: folded unpushed, capped failed ----------

test('unpushed projects fold into one row: most recent five, total commits, show all', () => {
  const list = needsAttention({ gitActivity: [...gitMany(7), { name: 'clean', path: 'C:\\Work\\clean', ahead: 0, commits: [] }] }, NOW);
  const v = attentionView(list);
  assert.equal(v.unpushed.projects, 7);
  assert.equal(v.unpushed.total, 28);
  assert.deepEqual(v.unpushed.items.map((a) => a.title), ['p6', 'p5', 'p4', 'p3', 'p2'], 'most recent activity first');
  assert.equal(v.unpushed.hidden, 2);
  assert.equal(v.count, 1, 'one row, however many projects');
  const all = attentionView(list, { unpushedAll: true });
  assert.equal(all.unpushed.items.length, 7);
  assert.equal(all.unpushed.hidden, 0);
  assert.deepEqual(attentionView([]).unpushed, { projects: 0, total: 0, items: [], hidden: 0 });
});

test('failed items stay individual, capped at five with show more; held and limits pass through', () => {
  const list = needsAttention({ tasks: failedMany(8), chat: { jobs: [{ id: 'h1', title: 'Held', status: 'queued', holdReason: 'busy', createdAt: NOW - H, folder: 'C:\\x' }] }, limits: [{ service: 'claude', limited: true }] }, NOW);
  const v = attentionView(list);
  assert.deepEqual(v.failed.map((a) => a.id), ['f0', 'f1', 'f2', 'f3', 'f4']);
  assert.equal(v.failedHidden, 3);
  assert.equal(v.failedIds.length, 8, 'dismiss all covers the hidden ones too');
  assert.deepEqual(v.others.map((a) => a.kind).sort(), ['held', 'limit']);
  assert.equal(attentionView(list, { failedAll: true }).failed.length, 8);
});

// ---------- context on the project card ----------

test('by project: the freshest session with a context size is carried to the project card', () => {
  const projects = [{ name: 'babajee', path: 'C:\\Work\\babajee' }, { name: 'other', path: 'C:\\Work\\other' }];
  const ctx = (used) => ({ used, window: 200000, pct: Math.round(used / 2000), model: 'm' });
  const d = { projects, sessions: [
    { id: 'a', agent: 'claude', cwd: 'C:\\Work\\babajee', lastActivity: NOW - 3 * H, context: ctx(40000) },
    { id: 'b', agent: 'codex', cwd: 'C:\\Work\\babajee', lastActivity: NOW - H, context: ctx(80000) },
    { id: 'c', agent: 'claude', cwd: 'C:\\Work\\babajee', lastActivity: NOW, parent: 'a', context: ctx(190000) },
    { id: 'd', agent: 'claude', cwd: 'C:\\Work\\other', lastActivity: NOW },
  ] };
  const g = byProject(d);
  assert.deepEqual(g.find((x) => x.name === 'babajee').ctx, { context: ctx(80000), agent: 'codex', t: NOW - H });
  assert.equal(g.find((x) => x.name === 'other').ctx, undefined);
});
