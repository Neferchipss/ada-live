import test from 'node:test';
import assert from 'node:assert/strict';
import { todayStats, needsAttention, nowGroups, waitingApprovals, byProject, projectOf, subOf, rangeStart, inRange, timelineRows, startOfDay } from '../docs/activity-model.mjs';

const NOW = new Date(2026, 5, 15, 15, 0, 0).getTime(); // 15 Jun 2026, 15:00 local
const MID = startOfDay(NOW);
const H = 3600e3;
const projects = [
  { name: 'babajee', path: 'C:\\Work\\babajee', lastActivity: NOW - H },
  { name: 'babajee-src', path: 'C:\\Work\\babajee\\packages\\ui', lastActivity: NOW - 5 * H },
  { name: 'other', path: 'C:\\Work\\other', lastActivity: NOW - 30 * H },
];

const sample = () => ({
  projects,
  tasks: [
    { id: 'k1', title: 'Render', status: 'done', cwd: 'C:\\Work\\babajee', updatedAt: NOW - H, endedAt: NOW - H },
    { id: 'k2', title: 'Old fail', status: 'failed', cwd: 'C:\\Work\\other', updatedAt: NOW - 30 * H, endedAt: NOW - 30 * H },
    { id: 'k3', title: 'Fresh fail', status: 'failed', cwd: 'C:\\Work\\other', updatedAt: NOW - 2 * H, endedAt: NOW - 2 * H },
    { id: 'k4', title: 'Yesterday done', status: 'done', cwd: 'C:\\Work\\other', updatedAt: MID - H, endedAt: MID - H },
    { id: 'k5', title: 'Loose', status: 'done', cwd: 'D:\\elsewhere', updatedAt: NOW - 3 * H, endedAt: NOW - 3 * H },
  ],
  timeline: [
    { t: NOW - 10e3, agent: 'claude', kind: 'say', text: 'hi', cwd: 'c:/work/babajee/src' },
    { t: NOW - 2 * H, agent: 'claude', kind: 'prompt', text: 'do it', cwd: 'C:\\Work\\babajee\\packages\\ui\\lib' },
    { t: NOW - 3 * H, agent: 'task', kind: 'task', text: 'x', cwd: '' },
    { t: NOW - 20 * H, agent: 'codex', kind: 'tool', text: 'no cwd' },
  ],
  journal: [
    { t: NOW - 2 * H, project: 'babajee', path: 'C:\\Work\\babajee', kind: 'commit', hash: 'abc1234', subject: 'Fix', by: 'Claude' },
    { t: MID - 5 * H, project: 'other', path: 'C:\\Work\\other', kind: 'commit', hash: 'old0001', subject: 'Old', by: 'unknown' },
  ],
  gitActivity: [
    { name: 'babajee', path: 'C:\\Work\\babajee', ahead: 2, commits: [{ h: 'abc1234', s: 'Fix', t: NOW - 2 * H, a: 'N', pushed: false }, { h: 'def5678', s: 'More', t: NOW - H, a: 'N', pushed: false }] },
    { name: 'other', path: 'C:\\Work\\other', ahead: 0, commits: [] },
  ],
  sessions: [
    { id: 's1', cwd: 'C:\\Work\\babajee', lastActivity: NOW - H },
    { id: 's2', cwd: 'C:\\Work\\babajee', lastActivity: NOW - H, parent: 's1' },
    { id: 's3', cwd: 'C:\\Work\\other', lastActivity: MID - H },
  ],
  activeMap: [
    { project: 'babajee', path: 'C:\\Work\\babajee', subfolder: 'src', workers: [{ source: 'terminal', status: 'working', id: 's1' }, { source: 'ada-job', status: 'awaiting-approval', id: 'j9' }] },
    { project: 'aaa', path: 'C:\\Work\\aaa', subfolder: '', workers: [{ source: 'task', status: 'running', id: 'k9' }] },
  ],
  chat: { jobs: [
    { id: 'j1', title: 'Held job', status: 'queued', holdReason: 'Claude session active in babajee', folder: 'C:\\Work\\babajee', createdAt: NOW - H },
    { id: 'j2', title: 'Expired', status: 'awaiting-approval', approvalExpiresAt: NOW - 10 * 60e3, createdAt: NOW - 20 * 60e3, folder: 'C:\\Work\\other' },
    { id: 'j3', title: 'Open', status: 'awaiting-approval', approvalExpiresAt: NOW + 60e3, createdAt: NOW - 60e3, folder: 'C:\\Work\\other' },
    { id: 'j4', title: 'Job failed', status: 'failed', endedAt: NOW - 3 * H, folder: 'C:\\Work\\other' },
    { id: 'j5', title: 'Job failed long ago', status: 'failed', endedAt: NOW - 48 * H, folder: 'C:\\Work\\other' },
    { id: 'k1', title: 'Render', status: 'done', endedAt: NOW - H, folder: 'C:\\Work\\babajee' }, // also a task: counted once
  ] },
  limits: [{ service: 'claude', limited: true, resetText: '5pm' }, { service: 'chatgpt', limited: true, resetsAt: NOW - 1 }],
});

test('today stats come from the sample data', () => {
  const s = todayStats(sample(), NOW);
  assert.equal(s.active, 2); // the approval waiting in the map is not "active"
  assert.equal(s.done, 2); // k1 (also a job, once) + k5; k4 finished yesterday
  assert.equal(s.failed, 2); // k3 + j4
  assert.equal(s.commits, 2); // abc1234 (journal + git, once) + def5678; old0001 is yesterday
  assert.equal(s.unpushed, 2);
  assert.equal(s.sessions, 1); // sub-agent and yesterday's session excluded
});

test('empty and missing data: everything unknown, nothing throws', () => {
  for (const d of [undefined, null, {}, { tasks: null, chat: {}, journal: 'x' }]) {
    assert.deepEqual(todayStats(d, NOW), { active: null, done: null, failed: null, commits: null, unpushed: null, sessions: null });
    assert.deepEqual(needsAttention(d, NOW), []);
    assert.deepEqual(nowGroups(d), []);
    assert.equal(waitingApprovals(d, NOW), 0);
    assert.deepEqual(byProject(d), []);
    assert.deepEqual(timelineRows(d, {}, NOW), []);
  }
  const z = todayStats({ tasks: [], chat: { jobs: [] }, activeMap: [], sessions: [], journal: [], gitActivity: [] }, NOW);
  assert.deepEqual(z, { active: 0, done: 0, failed: 0, commits: 0, unpushed: 0, sessions: 0 });
});

test('needs attention: failed older than 24h is excluded, other kinds picked', () => {
  const a = needsAttention(sample(), NOW);
  const ids = a.map((x) => `${x.kind}:${x.id}`);
  assert.ok(ids.includes('failed:k3') && ids.includes('failed:j4'));
  assert.ok(!ids.includes('failed:k2') && !ids.includes('failed:j5'));
  assert.ok(ids.includes('held:j1'));
  assert.ok(ids.includes('expired:j2'));
  assert.ok(!ids.some((i) => i.endsWith(':j3')), 'an approval still open is not an attention row');
  assert.ok(ids.includes('unpushed:C:\\Work\\babajee') && !ids.includes('unpushed:C:\\Work\\other'));
  assert.deepEqual(ids.filter((i) => i.startsWith('limit:')), ['limit:claude']); // chatgpt's reset has passed
  assert.equal(a[0].kind, 'failed');
});

test('failed exactly at the 24h boundary is still shown, one ms later is not', () => {
  const mk = (end) => ({ tasks: [{ id: 'x', status: 'failed', endedAt: end }] });
  assert.equal(needsAttention(mk(NOW - 24 * H), NOW).length, 1);
  assert.equal(needsAttention(mk(NOW - 24 * H - 1), NOW).length, 0);
});

test('now groups drop approvals; waiting count only counts open ones', () => {
  const g = nowGroups(sample());
  assert.deepEqual(g.map((x) => [x.project, x.subfolder, x.workers.length]), [['aaa', '', 1], ['babajee', 'src', 1]]);
  assert.equal(waitingApprovals(sample(), NOW), 1);
});

test('project matching: deepest path wins, slash and case tolerant, subfolder derived', () => {
  assert.equal(projectOf(projects, 'c:/work/babajee/packages/ui/lib').name, 'babajee-src');
  assert.equal(projectOf(projects, 'C:\\Work\\babajee\\src').name, 'babajee');
  assert.equal(projectOf(projects, 'C:\\Work\\babajee-other'), null); // prefix of a name is not a parent folder
  assert.equal(projectOf(projects, ''), null);
  assert.equal(subOf(projects[0], 'c:/work/babajee/src/a'), 'src/a');
  assert.equal(subOf(projects[0], 'C:\\Work\\babajee'), '');
  assert.equal(subOf(null, 'x'), '');
});

test('grouping by project and subfolder, with an Other bucket last', () => {
  const g = byProject(sample());
  assert.deepEqual(g.map((x) => x.name).sort(), ['Other', 'babajee', 'babajee-src', 'other']);
  assert.equal(g.at(-1).name, 'Other');
  assert.equal(g[0].name, 'babajee');
  const baba = g[0];
  assert.equal(baba.counts.tasks, 1);
  assert.equal(baba.counts.sessions, 1);
  assert.equal(baba.counts.commits, 2);
  assert.equal(baba.counts.unpushed, 2);
  const ev = baba.items.find((i) => i.type === 'event');
  assert.equal(ev.sub, 'src');
  assert.ok(baba.items.every((x, i, a) => !i || a[i - 1].t >= x.t), 'newest first');
  assert.equal(baba.items.filter((i) => i.type === 'change').length, 2); // abc1234 de-duplicated
  const ui = g.find((x) => x.name === 'babajee-src');
  assert.equal(ui.items[0].sub, 'lib');
  const other = g.find((x) => x.name === 'Other');
  assert.deepEqual(other.items.map((i) => i.type).sort(), ['event', 'task']); // no-cwd event + D:\elsewhere task
  assert.equal(other.key, '');
});

test('projects sort by last activity, Other stays last even when fresher', () => {
  const d = { projects, tasks: [
    { id: 'a', status: 'done', cwd: 'D:\\x', updatedAt: NOW },
    { id: 'b', status: 'done', cwd: 'C:\\Work\\other', updatedAt: NOW - 10 * H },
    { id: 'c', status: 'done', cwd: 'C:\\Work\\babajee', updatedAt: NOW - 5 * H },
  ] };
  assert.deepEqual(byProject(d).map((x) => x.name), ['babajee', 'other', 'Other']);
});

test('range filter boundaries are inclusive', () => {
  assert.equal(rangeStart('all', NOW), null);
  assert.equal(rangeStart('today', NOW), MID);
  assert.equal(rangeStart('7d', NOW), NOW - 7 * 86400e3);
  assert.ok(inRange(MID, 'today', NOW) && !inRange(MID - 1, 'today', NOW));
  assert.ok(inRange(NOW - 7 * 86400e3, '7d', NOW) && !inRange(NOW - 7 * 86400e3 - 1, '7d', NOW));
  assert.ok(inRange(0, 'all', NOW));
});

test('timeline rows: filters, range and cap', () => {
  const d = sample();
  const all = timelineRows(d, { filter: 'all', range: 'all' }, NOW);
  assert.ok(all.every((x, i, a) => !i || a[i - 1].t >= x.t));
  assert.ok(!all.some((x) => x.item?.kind === 'task'), 'task events are drawn as task cards');
  assert.equal(timelineRows(d, { filter: 'you', range: 'all' }, NOW).length, 1);
  assert.ok(timelineRows(d, { filter: 'agents', range: 'all' }, NOW).every((x) => x.item));
  assert.ok(timelineRows(d, { filter: 'tasks', range: 'all' }, NOW).every((x) => x.task));
  const today = timelineRows(d, { filter: 'all', range: 'today' }, NOW);
  assert.ok(today.every((x) => x.t >= MID));
  const many = { timeline: Array.from({ length: 300 }, (_, i) => ({ t: NOW - i, agent: 'claude', kind: 'say', text: 'x' })) };
  assert.equal(timelineRows(many, { range: 'all' }, NOW).length, 120);
});
