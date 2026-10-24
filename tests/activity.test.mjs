import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { ChatHub } from '../collector/lib/chat.mjs';
import { FullModePolicy, createPinHash } from '../collector/lib/fullmode.mjs';
import { LimitTracker } from '../collector/lib/limits.mjs';
import { WorkMap } from '../collector/lib/work.mjs';
import { Journal, activeMap, attribute, buildDigest, findConflict, isSecretName, liveLine, locate } from '../collector/lib/journal.mjs';

const PIN = '123456';
const NOW = 1_800_000_000_000;
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim();
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));

// A Work folder with two projects and a few subfolders.
function tree() {
  const root = tmp('ada-act-');
  const work = path.join(root, 'work');
  const dirs = { baba: path.join(work, 'babajee'), other: path.join(work, 'other') };
  fs.mkdirSync(path.join(dirs.baba, 'src', 'components'), { recursive: true });
  fs.mkdirSync(dirs.other, { recursive: true });
  const projects = [{ name: 'babajee', path: dirs.baba }, { name: 'other', path: dirs.other }];
  return { root, work, ...dirs, projects };
}
const sess = (o) => ({ agent: 'claude', id: 's1', title: 'T', status: 'working', lastActivity: NOW - 5e3, thought: '', ...o });

// ---------- active-work map ----------

test('activeMap groups workers per project folder with the subfolder', () => {
  const t = tree();
  const sub = path.join(t.baba, 'src', 'components');
  const map = activeMap({
    projects: t.projects, workRoot: t.work, now: NOW,
    sessions: [sess({ id: 'a', cwd: sub }), sess({ id: 'b', agent: 'codex', cwd: t.baba }), sess({ id: 'idle', cwd: t.other, status: 'idle' }), sess({ id: 'out', cwd: os.tmpdir() })],
    jobs: [{ id: 'j1', status: 'running', agent: 'claude', mode: 'safe', title: 'Fix', folder: sub, startedAt: NOW - 1000 }, { id: 'j2', status: 'done', folder: sub }],
    tasks: [{ id: 'k1', status: 'running', cwd: t.other, title: 'Render', updatedAt: NOW - 1000 }, { id: 'k2', status: 'running', by: 'ada-chat', cwd: t.other, updatedAt: NOW }],
  });
  assert.deepEqual(map.map((g) => [g.project, g.subfolder]), [['babajee', ''], ['babajee', 'src/components'], ['other', '']]);
  const deep = map[1];
  assert.equal(deep.path, t.baba);
  assert.deepEqual(deep.workers.map((w) => [w.source, w.agent]).sort(), [['ada-job', 'claude'], ['terminal', 'claude']]);
  assert.deepEqual(map[2].workers.map((w) => w.source), ['task'], 'idle session, finished job and chat-owned task are not active');
  assert.equal(map.flatMap((g) => g.workers).some((w) => w.id === 'out'), false, 'sessions outside the Work folder are ignored');
});

test("activeMap skips Ada's own sessions and counts a recently-touched blocked session", () => {
  const t = tree();
  const sessions = [sess({ id: 'mine', cwd: t.baba }), sess({ id: 'blk', cwd: t.other, status: 'blocked', lastActivity: NOW - 5 * 60e3 }), sess({ id: 'stale', cwd: t.other, status: 'blocked', lastActivity: NOW - 2 * 3600e3 })];
  const map = activeMap({ projects: t.projects, workRoot: t.work, now: NOW, sessions, own: new Set(['mine']) });
  assert.deepEqual(map.map((g) => g.workers.map((w) => w.id)), [['blk']]);
});

test('locate: nested projects pick the longest match, work root is a fallback', () => {
  const t = tree();
  const inner = { name: 'inner', path: path.join(t.baba, 'src') };
  const l = locate([...t.projects, inner], t.work, path.join(t.baba, 'src', 'components'));
  assert.deepEqual([l.project, l.sub], ['inner', 'components']);
  assert.equal(locate(t.projects, t.work, t.work).project, '(work root)');
  assert.equal(locate(t.projects, t.work, os.tmpdir()), null);
});

test('liveLine and attribution', () => {
  const t = tree();
  const sessions = [sess({ id: 'a', cwd: path.join(t.baba, 'src') })];
  const map = activeMap({ projects: t.projects, workRoot: t.work, now: NOW, sessions });
  assert.match(liveLine(map), /^\[Live now\] BUSY — babajee › src: Claude terminal working/);
  assert.equal(attribute(t.baba, { sessions, now: NOW }), 'Claude terminal session');
  assert.equal(attribute(t.other, { sessions, now: NOW }), 'unknown');
  assert.equal(attribute(t.baba, { sessions: [sess({ agent: 'codex', cwd: t.baba, status: 'idle', lastActivity: NOW - 60e3 })], now: NOW }), 'Codex', 'just-finished session still gets credit');
  assert.equal(attribute(t.baba, { sessions: [sess({ agent: 'codex', cwd: t.baba, status: 'idle', lastActivity: NOW - 3600e3 })], now: NOW }), 'unknown');
  assert.equal(attribute(t.baba, { jobs: [{ status: 'running', folder: t.baba }], now: NOW }), 'Ada job');
});

// ---------- conflict guard ----------

function hubSetup() {
  const t = tree();
  const state = path.join(t.root, 'state');
  fs.mkdirSync(state, { recursive: true });
  fs.writeFileSync(path.join(state, 'config.json'), JSON.stringify({ fullModePin: createPinHash(PIN) }));
  const clock = { t: NOW, now: () => clock.t };
  const ext = { sessions: [], tasks: [] };
  const runs = [], finishers = [], heads = [];
  let reply = 'noted';
  const child = () => ({ kill() {}, pid: 1 });
  const journal = new Journal({ file: path.join(state, 'journal.json'), now: clock.now });
  const services = {
    now: clock.now, limits: new LimitTracker({ now: clock.now }), appendTaskEvent: () => {}, killProcessTree() {},
    external: () => ext, journal,
    runAgent(o) {
      if (o.role === 'head') { heads.push(o); const text = reply; reply = 'noted'; return { child: child(), done: Promise.resolve({ ok: true, text, session: 'head1' }) }; }
      runs.push(o);
      return { child: child(), done: new Promise((r) => finishers.push(r)) };
    },
  };
  services.policy = new FullModePolicy({ stateDir: state, workRoot: t.work, hardRoot: t.work, projects: () => t.projects, now: clock.now });
  const hub = new ChatHub({ workRoot: t.work, projects: () => t.projects, stateDir: state, services });
  let n = 0;
  const flush = async () => { for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r)); };
  const cmd = (type, extra = {}) => ({ kind: 'cmd', id: `c${++n}`, ts: clock.now(), type, ...extra });
  const say = async (text, jobs) => { reply = jobs ? `ok\n<jobs>${JSON.stringify(jobs)}</jobs>` : 'noted'; assert.equal(hub.handle(cmd('say', { text })), null); await flush(); };
  return { ...t, state, clock, ext, runs, finishers, heads, hub, journal, cmd, say, flush };
}

test('a job is held while a terminal session works in the same folder, and starts when it ends', async () => {
  const s = hubSetup();
  s.ext.sessions = [sess({ cwd: path.join(s.baba, 'src') })];
  await s.say('go', [{ folder: s.baba, prompt: 'x', title: 'Job A' }]);
  const j = s.hub.state.jobs[0];
  assert.equal(j.status, 'queued');
  assert.equal(j.holdReason, 'Claude session active in babajee › src');
  assert.equal(s.runs.length, 0);
  assert.equal(s.hub.view().jobs[0].holdReason, j.holdReason, 'the page sees the reason');
  s.hub.tick();
  assert.equal(s.runs.length, 0, 'still held on the next tick');
  s.ext.sessions = [];
  s.hub.tick();
  assert.equal(j.status, 'running');
  assert.equal(j.holdReason, undefined);
  assert.equal(s.runs.length, 1);
});

test('ancestor, descendant and equal folders collide; siblings, idle sessions and the work root do not', () => {
  const s = tree();
  const ctx = (cwd, extra = {}) => ({ projects: s.projects, workRoot: s.work, now: NOW, sessions: [sess({ cwd, ...extra })] });
  const sub = path.join(s.baba, 'src');
  assert.match(findConflict(sub, ctx(s.baba)), /Claude session active in babajee$/);
  assert.match(findConflict(s.baba, ctx(sub)), /babajee › src$/);
  assert.match(findConflict(sub, ctx(sub, { agent: 'codex' })), /^Codex session/);
  assert.equal(findConflict(sub, ctx(path.join(s.baba, 'src2'))), null);
  assert.equal(findConflict(s.baba, ctx(s.other)), null);
  assert.equal(findConflict(sub, ctx(sub, { status: 'idle' })), null);
  assert.equal(findConflict(sub, ctx(s.work)), null, 'a session at the Work root does not block every project');
  assert.match(findConflict(sub, { projects: s.projects, workRoot: s.work, now: NOW, tasks: [{ status: 'running', cwd: sub, title: 'Render', updatedAt: NOW }] }), /^Task "Render" active in babajee › src/);
});

test('a held job does not starve other jobs, and Run anyway starts it', async () => {
  const s = hubSetup();
  s.ext.sessions = [sess({ cwd: s.baba })];
  await s.say('go', [{ folder: s.baba, prompt: 'a', title: 'A' }, { folder: s.other, prompt: 'b', title: 'B' }]);
  const [a, b] = s.hub.state.jobs;
  assert.equal(b.status, 'running', 'other project is free');
  assert.equal(a.status, 'queued');
  assert.equal(s.hub.handle(s.cmd('override-hold', { job: 'nope' })), 'not held');
  assert.equal(s.hub.handle(s.cmd('override-hold', { job: b.id })), 'not held', 'a running job is not held');
  assert.equal(s.hub.handle(s.cmd('override-hold', {})), 'not held');
  const c = s.cmd('override-hold', { job: a.id });
  assert.equal(s.hub.handle(c), null);
  assert.equal(a.status, 'running');
  assert.equal(s.runs.length, 2);
  assert.equal(s.hub.handle(c), 'replayed', 'the same sealed command cannot be replayed');
});

test('the hold notice is posted once after 10 minutes', async () => {
  const s = hubSetup();
  s.ext.sessions = [sess({ cwd: s.baba })];
  await s.say('go', [{ folder: s.baba, prompt: 'a', title: 'Slow one' }]);
  const notices = () => s.hub.state.thread.messages.filter((m) => m.role === 'system' && /waiting over 10 minutes/.test(m.text));
  s.clock.t += 9 * 60e3; s.ext.sessions = [sess({ cwd: s.baba, lastActivity: s.clock.t })]; s.hub.tick();
  assert.equal(notices().length, 0);
  s.clock.t += 2 * 60e3; s.ext.sessions = [sess({ cwd: s.baba, lastActivity: s.clock.t })]; s.hub.tick(); s.hub.tick();
  assert.equal(notices().length, 1);
  assert.match(notices()[0].text, /Slow one.*Claude session active in babajee/);
});

test("ops jobs are exempt, and Ada's own sessions never block her", async () => {
  const s = hubSetup();
  s.ext.sessions = [sess({ id: 'ext1', cwd: s.baba })];
  s.hub.state.projectSessions['claude|x'] = 'ext1';
  assert.equal(s.hub.ownSessions().has('ext1'), true);
  await s.say('go', [{ folder: s.baba, prompt: 'a' }]);
  assert.equal(s.hub.state.jobs[0].status, 'running', 'session id belongs to Ada, so not a collision');
  s.ext.sessions = [sess({ id: 'other-term', cwd: s.baba })];
  const op = { id: 'op1', mode: 'ops', status: 'queued', folder: s.baba, agent: 'collector', title: 'Op', createdAt: NOW };
  s.hub.state.jobs.push(op);
  s.hub.tick();
  assert.equal(op.holdReason, undefined, 'ops jobs skip the guard');
});

test('Run anyway never skips approval: full jobs stay awaiting, and an expired approval still refuses', async () => {
  const s = hubSetup();
  s.ext.sessions = [sess({ cwd: s.baba })];
  await s.say('go', [{ mode: 'full', folder: s.baba, prompt: 'npm i', title: 'Install' }]);
  const j = s.hub.state.jobs[0];
  assert.equal(j.status, 'awaiting-approval');
  assert.equal(s.hub.handle(s.cmd('override-hold', { job: j.id })), 'not held', 'cannot pre-skip the guard before approval');
  assert.equal(j.holdOverride, undefined);
  assert.equal(s.runs.length, 0);
  assert.equal(s.hub.handle(s.cmd('approve', { job: j.id, approval: j.approvalId, pin: PIN })), null);
  assert.equal(j.status, 'queued');
  assert.match(j.holdReason, /Claude session/);
  assert.equal(s.runs.length, 0, 'approved, but still held');
  // let the approval lapse, then override: only the guard is skipped, authorizeStart still refuses
  s.clock.t += 6 * 60e3;
  assert.equal(s.hub.handle(s.cmd('override-hold', { job: j.id })), null);
  assert.equal(j.status, 'failed');
  assert.match(j.result, /Approval expired/);
  assert.equal(s.runs.length, 0);
});

test('Run anyway on an approved full job starts it through the normal approval path', async () => {
  const s = hubSetup();
  s.ext.sessions = [sess({ cwd: s.baba })];
  await s.say('go', [{ mode: 'full', folder: s.baba, prompt: 'build', title: 'Build' }]);
  const j = s.hub.state.jobs[0];
  assert.equal(s.hub.handle(s.cmd('approve', { job: j.id, approval: j.approvalId, pin: PIN })), null);
  assert.equal(j.status, 'queued');
  assert.equal(s.hub.handle(s.cmd('override-hold', { job: j.id })), null);
  assert.equal(j.status, 'running');
  assert.equal(s.runs[0].role, 'full');
});

// ---------- Ada's own workers are never "someone else's terminal" ----------

async function runningFull(s) {
  await s.say('go', [{ mode: 'full', folder: s.baba, prompt: 'build', title: 'Build' }]);
  const j = s.hub.state.jobs[0];
  assert.equal(s.hub.handle(s.cmd('approve', { job: j.id, approval: j.approvalId, pin: PIN })), null);
  assert.equal(j.status, 'running');
  return j;
}
const workersOf = (s) => activeMap({ projects: s.projects, workRoot: s.work, now: NOW, sessions: s.hub.external().sessions, jobs: s.hub.state.jobs, own: s.hub.ownSessions() }).flatMap((g) => g.workers);

test('a running full job records its session as soon as it is known, and is not also listed as a terminal', async () => {
  const s = hubSetup();
  const j = await runningFull(s);
  assert.equal(typeof s.runs[0].onSession, 'function', 'full jobs pass onSession like safe ones');
  s.runs[0].onSession('full-sess-1');
  assert.equal(j.session, 'full-sess-1');
  assert.equal(s.hub.ownSessions().has('full-sess-1'), true);
  s.ext.sessions = [sess({ id: 'full-sess-1', cwd: s.baba, title: 'Build thing' })];
  const w = workersOf({ ...s, hub: { ...s.hub, external: () => s.ext, state: s.hub.state, ownSessions: () => s.hub.ownSessions() } });
  assert.deepEqual(w.map((x) => x.source), ['ada-job'], 'one worker, not two');
});

test('defensive: a "Job from Ada" prompt, or a session that began with a running job in its folder, is excluded even without a session id', async () => {
  const s = hubSetup();
  const j = await runningFull(s); // no onSession call: the id is unknown
  const sessions = [
    sess({ id: 'by-prompt', cwd: s.baba, firstPrompt: "Job from Ada (Nefer's orchestrator), sent from his phone." }),
    sess({ id: 'by-title', cwd: s.baba, title: "Job from Ada (Nefer's orchestrator), sent fr…" }),
    sess({ id: 'by-start', cwd: s.baba, startedAt: j.startedAt + 3000 }),
    sess({ id: 'mine', cwd: s.baba, startedAt: j.startedAt - 3600e3, title: 'Real terminal work' }),
    sess({ id: 'elsewhere', cwd: s.other, startedAt: j.startedAt + 1000, title: 'Other folder' }),
  ];
  const map = activeMap({ projects: s.projects, workRoot: s.work, now: NOW, sessions, jobs: s.hub.state.jobs, own: s.hub.ownSessions() });
  const ids = map.flatMap((g) => g.workers).map((w) => w.id);
  assert.deepEqual(ids.sort(), [j.id, 'elsewhere', 'mine'].sort());
  // header count and tab badge are derived from these workers plus real jobs: Ada's job appears exactly once
  assert.equal(map.flatMap((g) => g.workers).filter((w) => w.source === 'ada-job').length, 1);
  // and the conflict guard / attribution do not treat Ada's own worker as someone else
  assert.equal(findConflict(s.baba, { projects: s.projects, workRoot: s.work, now: NOW, sessions: sessions.slice(0, 3), jobs: s.hub.state.jobs }), null);
  assert.equal(attribute(s.baba, { sessions: sessions.slice(0, 3), jobs: s.hub.state.jobs, now: NOW }), 'Ada job');
});

// ---------- journal ----------

function repo() {
  const dir = tmp('ada-repo-');
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 't@example.com');
  git(dir, 'config', 'user.name', 'T');
  git(dir, 'config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(dir, 'a.txt'), '1');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'first');
  return dir;
}

function workMapFor(dir) {
  const wm = new WorkMap(path.dirname(dir));
  wm.projects.set('k', { name: path.basename(dir), group: null, path: dir, looseOnly: false, lastModified: 0, recent: [], git: null, isRepo: true, gitPath: dir });
  return wm;
}

// The same refresh the collector runs, with the journal hook.
async function look(wm, journal, by) {
  for (const p of wm.projects.values()) wm.dirtyGit.add(p);
  await wm.refreshGit(5, { prev: (q) => journal.seen(q.path), onUpdate: (q, info) => journal.observeGit(q, info, by) });
}

test('journal records new commits, branch changes and dirty file names from a real git repo', async () => {
  const dir = repo();
  const jf = path.join(tmp('ada-j-'), 'journal.json');
  const journal = new Journal({ file: jf });
  const wm = workMapFor(dir);
  await look(wm, journal);
  assert.equal(journal.recent().length, 0, 'first look is only a baseline');

  fs.writeFileSync(path.join(dir, 'b.txt'), '2');
  git(dir, 'add', '.'); git(dir, 'commit', '-q', '-m', 'add b');
  fs.writeFileSync(path.join(dir, 'c.txt'), '3');
  fs.writeFileSync(path.join(dir, '.env'), 'KEY=1');
  fs.mkdirSync(path.join(dir, 'docs', 'data'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'docs', 'data', 'live.enc.json'), '{}');
  await look(wm, journal, 'Claude terminal session');

  const e = journal.recent();
  const commit = e.find((x) => x.kind === 'commit');
  assert.equal(commit.subject, 'add b');
  assert.match(commit.hash, /^[0-9a-f]{7}$/);
  assert.equal(commit.by, 'Claude terminal session');
  const dirty = e.find((x) => x.kind === 'dirty');
  assert.deepEqual(dirty.files, ['c.txt'], "secret names and the viewer's own snapshot file are not listed");
  assert.equal(dirty.count, 2, '.env still counts as a changed file');
  assert.equal(JSON.stringify(e).includes('KEY=1'), false);

  git(dir, 'checkout', '-q', '-b', 'feature');
  await look(wm, journal, 'unknown');
  const br = journal.recent().find((x) => x.kind === 'branch');
  assert.equal(br.to, 'feature');
  assert.ok(br.from);

  const again = new Journal({ file: jf });
  assert.equal(again.recent().length, journal.recent().length, 'saved to disk and reloaded');
});

test('secret-looking names are filtered', () => {
  for (const n of ['.env', 'config/.env.local', 'api_token.txt', 'Password.md', 'src/credentials.json', '.git/config', '.ssh/id_rsa', 'x/secret.key', 'cert.pem', 'my-secrets.txt']) assert.equal(isSecretName(n), true, n);
  for (const n of ['src/app.js', 'README.md', 'docs/index.html', 'environment.md']) assert.equal(isSecretName(n), false, n);
  const j = new Journal({ file: path.join(tmp('ada-j-'), 'j.json') });
  const p = { name: 'p', path: tmp('ada-p-') };
  j.observeGit(p, { head: 'h1', branch: 'main', paths: [] });
  j.observeGit(p, { head: 'h1', branch: 'main', paths: ['.env', 'a/token.txt', 'ok.js', 'password.md'] });
  const d = j.recent()[0];
  assert.deepEqual(d.files, ['ok.js']);
  assert.equal(d.count, 4);
});

test('journal de-dupes identical entries, merges dirty bursts, and is bounded', () => {
  const clock = { t: NOW };
  const j = new Journal({ file: path.join(tmp('ada-j-'), 'j.json'), now: () => clock.t });
  const p = { name: 'p', path: tmp('ada-p-') };
  j.observeGit(p, { head: 'h1', branch: 'main', paths: [] });
  j.observeGit(p, { head: 'h1', branch: 'main', paths: ['a.js'] });
  j.observeGit(p, { head: 'h1', branch: 'main', paths: ['a.js'] });
  assert.equal(j.recent().length, 1);
  clock.t += 60e3;
  j.observeGit(p, { head: 'h1', branch: 'main', paths: ['a.js', 'b.js'] });
  assert.equal(j.recent().length, 1, 'edits in one burst merge into one entry');
  assert.deepEqual(j.recent()[0].files, ['a.js', 'b.js']);
  assert.equal(j.add({ project: 'p', kind: 'commit', hash: 'abc1234', subject: 's', by: 'x' }), true);
  assert.equal(j.add({ project: 'p', kind: 'commit', hash: 'abc1234', subject: 's', by: 'x' }), false);

  const big = new Journal({ file: path.join(tmp('ada-j-'), 'j.json'), now: () => clock.t });
  for (let i = 0; i < 450; i++) { clock.t += 1000; big.add({ project: 'p', kind: 'commit', hash: String(i).padStart(7, '0'), subject: `c${i}`, by: 'x' }); }
  assert.equal(big.data.entries.length, 400);
  assert.equal(big.recent(1)[0].subject, 'c449');
  clock.t += 31 * 86400e3;
  assert.equal(new Journal({ file: big.file, now: () => clock.t }).data.entries.length, 0, 'entries older than 30 days are dropped');
});

test('a session going from working to idle is journaled with its last words', () => {
  const t = tree();
  const clock = { t: NOW };
  const j = new Journal({ file: path.join(tmp('ada-j-'), 'j.json'), now: () => clock.t });
  const ctx = { projects: t.projects, workRoot: t.work };
  const s = sess({ cwd: path.join(t.baba, 'src'), thought: 'Refactored the header.', lastActivity: clock.t });
  j.observeSessions([s], ctx);
  assert.equal(j.recent().length, 0);
  clock.t += 5 * 60e3;
  j.observeSessions([{ ...s, status: 'idle', lastActivity: clock.t }], ctx);
  const e = j.recent()[0];
  assert.deepEqual([e.kind, e.project, e.sub, e.agent, e.by], ['session', 'babajee', 'src', 'Claude', 'Claude terminal session']);
  assert.equal(e.durMs, 5 * 60e3);
  assert.equal(e.note, 'Refactored the header.');
  // a tiny blip is not worth a line, and Ada's own sessions are skipped
  j.observeSessions([sess({ id: 'blip', cwd: t.baba, lastActivity: clock.t })], ctx);
  clock.t += 5e3;
  j.observeSessions([], ctx);
  j.observeSessions([sess({ id: 'mine', cwd: t.baba })], { ...ctx, own: new Set(['mine']) });
  j.observeSessions([], ctx);
  assert.equal(j.recent().length, 1);
});

// ---------- digest and Ada's awareness ----------

test('digest groups by project, newest first, and respects the size caps', () => {
  const entries = [];
  for (let i = 0; i < 60; i++) entries.push({ t: NOW + i * 1000, project: i % 2 ? 'alpha' : 'beta', kind: 'commit', hash: 'abcdef0', subject: `subject number ${i} ` + 'x'.repeat(100), by: 'unknown' });
  const d = buildDigest(entries, { since: 0 });
  const lines = d.split('\n');
  assert.ok(lines.length <= 25, `${lines.length} lines`);
  assert.ok(Buffer.byteLength(d) <= 3072);
  assert.match(lines.at(-1), /^\(\+\d+ older changes not shown\)$/);
  assert.equal(lines[0], 'alpha:', 'the project with the newest change comes first');
  assert.match(lines[1], /subject number 59/);
  assert.match(lines[2], /subject number 57/);

  const small = buildDigest([{ t: 5, project: 'p', kind: 'dirty', count: 2, files: ['a', 'b'], by: 'Codex' }, { t: 1, project: 'p', kind: 'branch', from: 'main', to: 'x', by: 'unknown' }], { since: 0 });
  assert.equal(small.split('\n').length, 3);
  assert.match(small, /2 uncommitted files: a, b \[Codex\]/);
  assert.equal(buildDigest(entries, { since: NOW + 1e6 }), '');
  const bytes = buildDigest(entries, { since: 0, maxLines: 100, maxBytes: 600 });
  assert.ok(Buffer.byteLength(bytes) <= 600);
});

test("Ada's head turn starts with the activity block, and the since cursor moves forward", async () => {
  const s = hubSetup();
  s.journal.add({ project: 'babajee', kind: 'commit', hash: 'abc1234', subject: 'Fix header', by: 'Claude terminal session' });
  s.clock.t += 1000;
  s.ext.sessions = [sess({ cwd: path.join(s.baba, 'src') })];
  await s.say('hello');
  const first = s.heads.at(-1).prompt;
  assert.match(first, /^\[Activity since your last turn\]\nbabajee:\n- \d\d:\d\d commit abc1234 "Fix header" \[Claude terminal session\]\n\[Live now\] BUSY — babajee › src/);
  assert.match(first, /\[Nefer\] hello/);
  const cursor = s.hub.state.thread.activitySince;
  assert.equal(cursor, s.clock.t);

  s.ext.sessions = [];
  s.clock.t += 1000;
  await s.say('again');
  assert.doesNotMatch(s.heads.at(-1).prompt, /Activity since/, 'nothing new and nobody busy: no block');
  s.clock.t += 1000;
  s.journal.add({ project: 'other', kind: 'branch', from: 'main', to: 'dev', by: 'unknown' });
  await s.say('third');
  const third = s.heads.at(-1).prompt;
  assert.match(third, /other:\n- \d\d:\d\d branch main → dev/);
  assert.doesNotMatch(third, /Fix header/, 'already reported entries are not repeated');
  assert.ok(s.hub.state.thread.activitySince > cursor);
});

test('the system prompt explains the digest, the notes file and busy folders', async () => {
  const s = hubSetup();
  await s.say('hi');
  const sys = s.heads.at(-1).system;
  assert.match(sys, /\[Activity since your last turn\]/);
  assert.match(sys, /terminal/i);
  assert.match(sys, /projects[\\/]<name>\.md/);
  assert.match(sys, /busy/);
});
