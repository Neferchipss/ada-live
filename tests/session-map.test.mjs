import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSessionMap, activeCount } from '../docs/session-map.mjs';

const now = Date.UTC(2026, 9, 24, 12, 0, 0);
const S = (id, over = {}) => ({ agent: 'claude', session: `${id}`.padEnd(8, '0'), title: `t-${id}`, project: 'proj', subfolder: '', source: 'job', status: 'working', startedAt: now - 9e5, lastAt: now - 1000, ...over });
const data = (sessions, extra = {}) => ({ projects: [], chat: { thread: { context: { used: 50000, window: 200000, src: 'data' }, busy: false }, sessions }, ...extra });
const find = (n, id) => (n.id === id ? n : n.children.map((c) => find(c, id)).find(Boolean));
const labels = (n) => n.children.map((c) => c.label);

test('root is Ada with her context; empty or missing data gives root only with a note', () => {
  for (const d of [undefined, null, {}, { chat: {} }, data([])]) {
    const t = buildSessionMap(d, now);
    assert.equal(t.kind, 'root'); assert.equal(t.label, 'Ada'); assert.deepEqual(t.children, []);
    assert.equal(t.meta.note, 'No active chats'); assert.equal(activeCount(t), 0);
  }
  assert.equal(buildSessionMap(data([]), now).meta.ctx.used, 50000);
});

test('two sessions in one project, different subfolders, become sibling folders', () => {
  const t = buildSessionMap(data([S('aaaaaaa1', { subfolder: 'docs' }), S('bbbbbbb2', { subfolder: 'tests' })]), now);
  assert.deepEqual(labels(t), ['proj']);
  assert.deepEqual(labels(t.children[0]).sort(), ['docs', 'tests']);
  assert.equal(t.children[0].meta.live, 2);
  assert.equal(t.meta.note, '');
});

test('nested subfolders nest by segment; single-child folder chains collapse into one label', () => {
  const t = buildSessionMap(data([S('aaaaaaa1', { subfolder: 'src/components' }), S('bbbbbbb2', { subfolder: 'src\\lib' }), S('ccccccc3', { project: 'solo', subfolder: 'a/b/c' })]), now);
  const proj = t.children.find((c) => c.label === 'proj');
  assert.deepEqual(labels(proj), ['src']);                         // src has two children: not collapsed
  assert.deepEqual(labels(proj.children[0]).sort(), ['components', 'lib']);
  const solo = t.children.find((c) => c.label === 'solo');
  assert.deepEqual(labels(solo), ['a/b/c']);                       // pure chain: one node
  assert.equal(solo.children[0].children[0].kind, 'session');
});

test('sessions at the project root and in folders share the project node', () => {
  const t = buildSessionMap(data([S('aaaaaaa1'), S('bbbbbbb2', { subfolder: 'x' })]), now);
  assert.deepEqual(t.children[0].children.map((c) => c.kind).sort(), ['folder', 'session']);
});

test('unmatched sessions go under Other, always last; cwd matching uses the project list', () => {
  const t = buildSessionMap(data([S('aaaaaaa1', { project: '' }), S('bbbbbbb2', { project: 'zeta' }), S('ccccccc3', { project: undefined, subfolder: undefined, cwd: 'C:/Work/app/src/ui' })], { projects: [{ name: 'app', path: 'C:/Work/app' }] }), now);
  assert.deepEqual(labels(t), ['app', 'zeta', 'Other']);
  assert.equal(find(t, 'p:app').children[0].label, 'src/ui');
});

test('recent vs active: only live sessions are active; finished ones within 24h sit under Recent, older ones vanish', () => {
  const t = buildSessionMap(data([
    S('aaaaaaa1'), S('bbbbbbb2', { status: 'blocked' }),
    S('ccccccc3', { status: 'idle', lastAt: now - 3600e3, subfolder: 'src' }),
    S('ddddddd4', { status: 'failed', lastAt: now - 23 * 3600e3 }),
    S('eeeeeee5', { status: 'idle', lastAt: now - 25 * 3600e3 }),
    S('fffffff6', { status: 'idle', lastAt: 0 }),
  ]), now);
  assert.equal(activeCount(t), 2);
  const recent = t.children.at(-1);
  assert.equal(recent.id, 'recent'); assert.equal(recent.meta.count, 2); assert.equal(recent.meta.live, 0);
  const ids = []; (function w(n) { if (n.kind === 'session') ids.push(n.meta.session); n.children.forEach(w); })(recent);
  assert.deepEqual(ids.sort(), ['ccccccc3', 'ddddddd4']);
  assert.ok(!find(t, 'recent').children.some((c) => c.id.startsWith('p:')), 'recent ids are prefixed');
  assert.ok(find(t, 'r/s:claude|ccccccc3').meta.recent);
  const live = t.children[0];
  assert.ok(live.children.every((c) => !c.meta.recent));
});

test('only finished sessions: no active note, Recent branch still present', () => {
  const t = buildSessionMap(data([S('aaaaaaa1', { status: 'idle' })]), now);
  assert.equal(t.meta.note, 'No active chats'); assert.deepEqual(labels(t), ['Recent']);
});

test('ordering: working first, then most recent; deterministic ids', () => {
  const list = [S('aaaaaaa1', { status: 'blocked', lastAt: now - 10 }), S('bbbbbbb2', { lastAt: now - 5000 }), S('ccccccc3', { lastAt: now - 100 })];
  const t = buildSessionMap(data(list), now);
  assert.deepEqual(t.children[0].children.map((c) => c.meta.session), ['ccccccc3', 'bbbbbbb2', 'aaaaaaa1']);
  assert.deepEqual(buildSessionMap(data([...list].reverse()), now), t);
  assert.equal(t.children[0].children[0].id, 's:claude|ccccccc3');
  const p = buildSessionMap(data([S('aaaaaaa1', { project: 'old', lastAt: now - 9e4 }), S('bbbbbbb2', { project: 'new', lastAt: now - 10 })]), now);
  assert.deepEqual(labels(p), ['new', 'old']);
});

test('leaf meta carries what the page draws; missing fields and bad rows are tolerated', () => {
  const ctx = { used: 1000, window: 2000 };
  const t = buildSessionMap(data([S('aaaaaaa1', { context: ctx, agent: 'codex' }), null, { agent: 'x', session: 'zzzzzzzz' }, { agent: 'claude' }, S('bbbbbbb2', { title: undefined, lastAt: undefined, status: undefined, source: undefined })]), now);
  const a = find(t, 's:codex|aaaaaaa1');
  assert.deepEqual([a.meta.status, a.meta.source, a.meta.agent, a.meta.ctx, a.meta.ageMs, a.meta.agentKey], ['working', 'job', 'codex', ctx, 1000, 'codex|aaaaaaa1']);
  assert.equal(find(t, 'p:proj').children.length, 1);   // b has no status: idle, no lastAt: not recent, dropped
});

test('duplicate agent|session rows appear once', () => {
  const t = buildSessionMap(data([S('aaaaaaa1'), S('aaaaaaa1')]), now);
  assert.equal(t.children[0].children.length, 1);
});
