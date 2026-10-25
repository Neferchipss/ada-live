// Runs the real docs/app.js against a fake DOM: unlock -> decrypt -> render, for realistic, empty and
// partial snapshots. Catches what hand-made unit fixtures can't: a module that fails to load, a
// missing element id, or a section that throws on real data and strands the user on the login form.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { installDom, sealFor, indexHtml } from './helpers/fake-dom.mjs';

const APP = fs.readFileSync(new URL('../docs/app.js', import.meta.url), 'utf8');
const tick = (ms = 50) => new Promise((r) => setTimeout(r, ms));
let n = 0;

async function unlockWith(snap, { typed = 'test-pass', sealedWith = 'test-pass', after } = {}) {
  const d = installDom({ feed: sealFor(snap, sealedWith) });
  try {
    await import(`../docs/app.js?smoke=${++n}`);
    await tick();
    d.els.get('password').value = typed;
    await d.els.get('login-form').fire('submit');
    // PBKDF2 is slow: wait for unlock() to finish (it always resets the button) rather than a fixed delay.
    for (let i = 0; i < 300 && d.els.get('unlock').textContent !== 'Unlock'; i++) await tick(50);
    await tick();
    const bar = d.els.get('err-bar');
    return {
      appShown: d.els.get('app').hidden === false,
      loginShown: d.els.get('login').hidden === false,
      loginError: d.els.get('login-error').textContent,
      btn: d.els.get('unlock').textContent,
      errors: bar.hidden ? [] : bar.children.map((c) => c.textContent),
      html: Object.fromEntries(['chat-ctx', 'work-strip', 'act-attn', 'act-hist-list', 'act-tiles', 'act-now', 'act-projects', 'work', 'chat-log'].map((id) => [id, d.els.get(id).innerHTML])),
      hidden: { ctx: d.els.get('chat-ctx').hidden, toast: d.els.get('toast').hidden, hist: d.els.get('act-hist').hidden, histSum: d.els.get('act-hist-sum').textContent },
      extra: after ? await after(d) : undefined,
    };
  } finally { d.restore(); }
}

const now = Date.now();
const min = 60e3;
const realistic = () => ({
  v: 1, host: 'LAPTOP', workRoot: 'C:\\Work', generatedAt: now,
  ada: { status: 'working', statusNote: 'on it', step: 'Edit', thought: 'thinking', session: { id: 's1', title: 'Fix', cwd: 'C:\\Work\\Personal\\proj', model: 'm', remote: false }, since: now - 5 * min, activeSessions: 1 },
  sessions: [
    { agent: 'claude', id: 's1', title: 'Fix', cwd: 'C:\\Work\\Personal\\proj', model: 'm', lastPrompt: 'do it', status: 'working', statusNote: '', step: 'Edit', thought: '', lastActivity: now - 1000, startedAt: now - 9 * min, remote: false, context: { used: 84300, window: 200000, pct: 42, model: 'm', src: 'data' }, steps: [{ t: now - 2000, kind: 'tool', tool: 'Edit', text: 'a.js', done: 1 }] },
    { agent: 'codex', id: 's2', title: 'Old', cwd: 'C:\\Elsewhere', model: 'm', lastPrompt: '', status: 'idle', statusNote: '', step: '', thought: '', lastActivity: now - 3 * 86400e3, startedAt: now - 4 * 86400e3, remote: false, steps: [] },
  ],
  tasks: [{ id: 'u1', status: 'failed', cwd: 'C:\\Work\\Personal\\proj', createdAt: now - 20 * min, endedAt: now - 10 * min, updatedAt: now - 10 * min }, { id: 'u2', status: 'failed', title: 'Broke', createdAt: now - 20 * min, endedAt: now - 11 * min, updatedAt: now - 11 * min }, { id: 'j5', status: 'failed', createdAt: now - 40 * min, endedAt: now - 35 * min, updatedAt: now - 35 * min }, { id: 't1', createdAt: now - 9 * min, outputs: [], t: now - min, mode: 'safe', agent: 'claude', title: 'Task', cwd: 'C:\\Work\\Personal\\proj', by: 'ada', status: 'done', preview: 'ok', updatedAt: now - min, startedAt: now - 8 * min, session: 's1' }],
  timeline: [
    { t: now - min, agent: 'claude', session: 's1', kind: 'tool', text: 'Edit a.js', cwd: 'C:\\Work\\Personal\\proj', error: false },
    { t: now - 2 * min, agent: 'codex', session: 's2', kind: 'error', text: 'boom', cwd: '', error: true },
  ],
  projects: [
    { name: 'proj', group: 'Personal', path: 'C:\\Work\\Personal\\proj', lastModified: now - min, recent: [{ file: 'a.js', t: now - min }], git: { branch: 'main', tracking: 'origin/main', changed: 2, last: { hash: 'abc1234', subject: 'x', t: now - min } }, isRepo: true, looseOnly: false, kind: 'github', repo: 'o/proj', private: true, site: null, url: 'https://github.com/o/proj', agents: [{ agent: 'claude', id: 's1', status: 'working', lastActivity: now, context: { used: 190000, window: 200000, pct: 95, model: 'm', src: 'family' } }], lastActivity: now },
    { name: 'plain', group: 'Misc', path: 'C:\\Work\\Misc\\plain', lastModified: now - 9e6, recent: [], git: null, isRepo: false, looseOnly: false, kind: 'local', agents: [], lastActivity: now - 9e6 },
  ],
  accounts: [{ service: 'claude', name: 'A', email: 'a@x.y', plan: 'max', surfaces: ['cli'], shared: '', session: { pct: 40, resetsAt: now + 60 * min }, weekly: { pct: 10, resetsAt: now + 86400e3 }, extra: null, asOf: now, live: true }],
  limits: [{ service: 'claude', limited: true, resetText: '5pm', resetsAt: now + 60 * min, at: now }],
  chat: {
    thread: { id: 'th', brain: { agent: 'claude', model: 'm' }, busy: false, updatedAt: now, total: 2, context: { agent: 'claude', model: 'm', used: 170000, window: 200000, at: now }, messages: [{ id: 'm1', t: now - min, role: 'user', text: 'hi', cid: 'c1' }, { id: 'm2', t: now, role: 'ada', text: 'hello **x**', cid: 'c2', brain: { agent: 'claude', model: 'm' } }] },
    jobs: [
      { id: 'j1', folder: 'C:\\Work\\Personal\\proj', agent: 'claude', model: 'm', title: 'Run ops', status: 'awaiting-approval', createdAt: now - min, mode: 'ops', prompt: 'p', expiresAt: now + 4 * min, approvalExpiresAt: now + 4 * min, approvalId: 'ap1' },
      { id: 'j2', folder: 'C:\\Work\\Personal\\proj', agent: 'claude', model: 'm', title: 'Done job', status: 'done', createdAt: now - 20 * min, startedAt: now - 19 * min, endedAt: now - 10 * min, session: 's1', result: 'ok', mode: 'safe', prompt: 'p' },
      { id: 'j3', folder: 'C:\\Work\\Personal\\proj', agent: 'claude', title: 'Denied', status: 'denied', createdAt: now - 30 * min, mode: 'full', prompt: 'p' },
      { id: 'j5', folder: 'C:\\Work\\Personal\\proj', agent: 'claude', title: 'Expired', status: 'expired', createdAt: now - 40 * min, mode: 'ops', prompt: 'p' },
      { id: 'j4', folder: 'C:\\Work\\Personal\\proj', agent: 'claude', title: 'Running full', status: 'running', startedAt: now - min, createdAt: now - 2 * min, session: 's9', mode: 'full', prompt: 'p' },
    ],
    brains: { claude: ['m'], codex: ['c'] }, memory: true, safeMode: true, fullModePinSet: true,
    media: { relay: false, ffmpeg: false, maxUpload: 1e6, maxFiles: 4, chunk: 1e5 }, uploads: [{ id: 'u1', state: 'done' }],
  },
  activeMap: [{ project: 'proj', path: 'C:\\Work\\Personal\\proj', folder: 'proj', subfolder: '', workers: [{ source: 'session', id: 's1', agent: 'claude', mode: 'safe', title: 'Fix', since: now - 5 * min, status: 'working', context: { used: 84300, window: null, pct: null, model: 'm' } }, { source: 'ada-job', id: 'j4', agent: 'claude', mode: 'full', title: 'Running full', since: now - min, status: 'running', context: { used: 20000, window: 200000, pct: 10, model: 'm', src: 'data' } }] }],
  journal: [{ t: now - min, project: 'proj', path: 'C:\\Work\\Personal\\proj', kind: 'edit', count: 2, files: ['a.js'], by: 'claude' }],
  gitActivity: [...Array.from({ length: 6 }, (_, i) => ({ name: `extra${i}`, path: `C:\\Work\\Misc\\extra${i}`, repo: `o/extra${i}`, url: 'https://github.com/o/x', branch: 'main', remoteBranch: true, ahead: 2, behind: 0, dirty: 0, lastPush: now - 9e5, reflog: true, commits: [{ h: `e${i}`, s: 'x', a: 'me', t: now - (i + 2) * min, pushed: false }], pushes: [] })), { name: 'proj', path: 'C:\\Work\\Personal\\proj', repo: 'o/proj', url: 'https://github.com/o/proj', branch: 'main', remoteBranch: true, ahead: 1, behind: 0, dirty: 2, lastPush: now - 9e5, reflog: true, commits: [{ h: 'abc1234', s: 'x', a: 'me', t: now - min, pushed: false }], pushes: [{ kind: 'push', branch: 'main', t: now - 9e5, from: 'a', to: 'b', n: 1 }] }],
  stats: { now: { cpu: 10, cpuName: 'cpu', cores: 8, ramUsedGB: 8, ramTotalGB: 16, gpuName: 'gpu', gpu: { util: 5, memUsed: 1, memTotal: 8, temp: 40, power: 20, clkGr: 1, clkMem: 1, fan: null, throttle: [] }, uptimeH: 3 }, history: { t0: now, step: 5, cpu: [1, 2], ram: [1, 2], gpu: [null], vram: [null], temp: [null] } },
});

function assertUnlocked(r, what = '') {
  assert.deepEqual(r.errors, [], `${what} render errors: ${r.errors.join(' | ')}`);
  assert.equal(r.appShown, true, `${what} app is shown`);
  assert.equal(r.loginShown, false, `${what} login form is gone`);
  assert.equal(r.loginError, '', what);
  assert.equal(r.btn, 'Unlock', `${what} button leaves the Decrypting… state`);
}

test('realistic snapshot unlocks and every section renders', async () => {
  assertUnlocked(await unlockWith(realistic()));
});

test('empty and minimal snapshots unlock', async () => {
  assertUnlocked(await unlockWith({}), '{}');
  assertUnlocked(await unlockWith({ v: 1 }), '{v:1}');
  assertUnlocked(await unlockWith({ v: 1, generatedAt: now, sessions: [], tasks: [], projects: [], accounts: [], limits: [], chat: null, activeMap: [], journal: [], gitActivity: [], stats: null, ada: null }), 'empty arrays');
});

test('snapshots missing optional fields unlock', async () => {
  for (const drop of ['chat', 'stats', 'gitActivity', 'activeMap', 'journal', 'limits', 'accounts', 'ada', 'timeline', 'tasks']) {
    const s = realistic();
    delete s[drop];
    assertUnlocked(await unlockWith(s), `without ${drop}`);
  }
  const s = realistic();
  s.chat = { thread: { messages: [] }, jobs: [] };
  s.projects.forEach((p) => { delete p.git; delete p.agents; delete p.recent; });
  delete s.gitActivity[0].commits;
  delete s.gitActivity[0].pushes;
  assertUnlocked(await unlockWith(s), 'partial nested fields');
});

test('a section that throws is reported, the app still opens, errors are de-duplicated', async () => {
  const r = await unlockWith({ ...realistic(), chat: 'not-an-object', projects: 'nope' });
  assert.equal(r.appShown, true);
  assert.equal(r.loginShown, false);
  assert.equal(r.btn, 'Unlock');
  assert.ok(r.errors.some((e) => /^Section \w+ failed: /.test(e)), `expected a visible section error, got ${JSON.stringify(r.errors)}`);
  assert.equal(new Set(r.errors).size, r.errors.length);
});

test('wrong password says so and stays on the login form', async () => {
  const r = await unlockWith(realistic(), { typed: 'nope' });
  assert.equal(r.loginError, 'Wrong password.');
  assert.equal(r.loginShown, true);
  assert.equal(r.btn, 'Unlock');
});

test('every $(#id) in app.js exists in index.html', () => {
  const ids = new Set([...indexHtml.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
  const used = [...new Set([...APP.matchAll(/\$\('#([\w-]+)'\)/g)].map((m) => m[1]))];
  assert.deepEqual(used.filter((i) => !ids.has(i)), []);
});

test("app.js module imports share index.html's cache-bust version", () => {
  const ver = indexHtml.match(/app\.js\?v=([\w-]+)/)?.[1];
  assert.ok(ver, 'index.html versions app.js');
  const imports = [...APP.matchAll(/from '(\.\/[^']+)'/g)].map((m) => m[1]);
  assert.ok(imports.length >= 2);
  for (const i of imports) assert.ok(i.endsWith(`?v=${ver}`), `${i} must end with ?v=${ver}`);
});

test('context bars, merged approvals line, folded attention and the expired/denied group render', async () => {
  const r = await unlockWith(realistic());
  assertUnlocked(r);
  // chat header: 85% of 200k, amber/red threshold classes, fresh-context hint over 80%
  assert.equal(r.hidden.ctx, false);
  assert.match(r.html['chat-ctx'], /class="ctx hot"/);
  assert.match(r.html['chat-ctx'], /ctx 85% · 170k \/ 200k/);
  assert.match(r.html['chat-ctx'], /class="ctx-bar"/, 'the bar sits inside the pill');
  assert.match(r.html['chat-ctx'], /ch-model">m</, 'model name beside the chip');
  assert.match(r.html['chat-ctx'], /data-fresh/);
  // one amber line: working + to approve, opening the approvals sheet; collapsed by default (no rows)
  const strip = r.html['work-strip'];
  assert.match(strip, /data-ws-appr/);
  assert.match(strip, /to approve/);
  assert.doesNotMatch(strip, /ws-rows|ws-row/);
  // activity: Now rows carry the bar (unknown window = tokens only), the project card shows its session
  assert.match(r.html['act-now'], /ctx 84k</, 'unknown window: neutral token-only pill');
  assert.doesNotMatch(r.html['act-now'], /ctx 84k[^<]*%/);
  assert.match(r.html['act-now'], /ctx 10% · 20k \/ 200k/);
  assert.match(r.html['act-now'], /now-src">proj · Ada job</, 'one muted line instead of stacked uppercase labels');
  assert.doesNotMatch(r.html['act-now'], /ws-proj/);
  assert.match(r.html['act-projects'], /ap-ctx/);
  // work page: the live agent's context badge (assumed window gets "~", over 90% is red)
  assert.match(r.html['work'], /class="ctx crit"[^>]*>.*~95% · 190k/s);
  // needs attention: failed items individually with dismiss buttons, unpushed folded into one row, no expired row
  const attn = r.html['act-attn'];
  assert.match(attn, /data-dismiss="/);
  assert.match(attn, /7 projects have unpushed commits \(total 13\)/);
  assert.doesNotMatch(attn, /attn-k">Expired/);
  assert.doesNotMatch(attn, /Untitled/);
  assert.match(attn, /Task u1|proj/);
  assert.doesNotMatch(r.html['act-attn'], /data-unpushed-all/, 'the folded list starts closed');
  // Failed tile: u1 + u2 only; the expired job's task row is not a failure
  assert.match(r.html['act-tiles'], /<b>2<\/b><span>Failed/);
  // history: denied + expired under the muted group
  assert.match(r.html['act-hist-list'], /hist-h">Expired \/ denied/);
  assert.match(r.html['act-hist-list'], /class="lapsed"/);
  assert.equal(r.hidden.hist, false);
  assert.match(r.hidden.histSum, /^Past approvals · \d+$/, 'collapsed summary carries its count');
});

test('empty Activity sections render nothing at all: no heading, no rows', async () => {
  const s = realistic();
  s.chat.jobs = []; s.tasks = []; s.sessions = []; s.projects = []; s.activeMap = []; s.journal = []; s.gitActivity = []; s.limits = []; s.timeline = []; s.accounts = [];
  const r = await unlockWith(s);
  assertUnlocked(r, 'empty');
  for (const id of ['act-attn', 'act-now', 'act-projects']) assert.equal(r.html[id], '', `${id} is empty`);
  assert.equal(r.hidden.hist, true, 'Past approvals is hidden when there is nothing');
});

test('collapsed strip names the most recent job with its timer and summarises the rest; approvals keep the amber countdown', async () => {
  const s = realistic();
  s.chat.jobs = s.chat.jobs.filter((j) => j.status !== 'awaiting-approval');
  const r = await unlockWith(s);
  assertUnlocked(r, 'strip');
  assert.match(r.html['work-strip'], /ws-lead">Running full<\/span> · <span data-since="\d+">[^<]+<\/span> · \+1 in terminal/);
  assert.doesNotMatch(r.html['work-strip'], /ws-rows/);
  const a = await unlockWith(realistic());
  assert.match(a.html['work-strip'], /1 to approve.*<span data-appr-left>/);
});

test('a job carrying a wrong-pin note renders the retry tag and the page still unlocks', async () => {
  const s = realistic();
  s.chat.jobs[0].approvalNote = { reason: 'wrong-pin', at: now - 1000, attemptsLeft: 3, lockedUntil: null };
  const r = await unlockWith(s);
  assertUnlocked(r, 'wrong-pin note');
  assert.match(r.html['chat-log'] + r.html['work-strip'], /appr-retry[^>]*>PIN incorrect · tap to retry/);
  s.chat.jobs[0].approvalNote = { reason: 'locked', at: now - 1000, attemptsLeft: 0, lockedUntil: now + 200e3 };
  assertUnlocked(await unlockWith(s), 'locked note');
});

test('approvals sheet: three pending items render checkboxes, a selection shows the action bar and counts', async () => {
  const s = realistic();
  const mk = (id, mode, title) => ({ id, folder: 'C:\Work\Personal\proj', agent: 'claude', model: 'm', title, status: 'awaiting-approval', createdAt: now - min, mode, prompt: 'p', approvalExpiresAt: now + 4 * min, approvalId: `ap-${id}` });
  s.chat.jobs = [mk('p1', 'ops', 'Echo one'), mk('p2', 'full', 'Full two'), mk('p3', 'ops', 'Echo three'), { ...mk('p4', 'full', 'Late'), approvalExpiresAt: now - 5000 }];
  const pick = (id) => ({ target: { closest: (sel) => (sel === '[data-pick]' ? { dataset: { pick: id } } : null) } });
  const r = await unlockWith(s, {
    after: async (d) => {
      const sheet = d.els.get('approvals-sheet');
      const snap = () => ({ list: d.els.get('appr-list').innerHTML, bar: d.els.get('appr-actions').hidden, approve: d.els.get('appr-batch-approve').textContent, deny: d.els.get('appr-batch-deny').textContent, header: d.els.get('appr-select').hidden });
      const before = snap();
      await sheet.fire('change', pick('p1'));
      await sheet.fire('change', pick('p2'));
      await sheet.fire('change', pick('p4')); // expired: not selectable
      const two = snap();
      await sheet.fire('click', { target: { closest: (sel) => (sel === '[data-sel]' ? { dataset: { sel: 'ops' } } : null) } });
      const ops = snap();
      await sheet.fire('click', { target: { closest: (sel) => (sel === '[data-sel]' ? { dataset: { sel: 'clear' } } : null) } });
      return { before, two, ops, cleared: snap() };
    },
  });
  assertUnlocked(r, 'approvals sheet');
  const { before, two, ops, cleared } = r.extra;
  const boxes = (h) => (h.match(/data-pick="/g) || []).length;
  assert.equal(boxes(before.list), 3, 'three open items get a checkbox; the expired one does not');
  assert.equal(before.bar, true);
  assert.equal(before.header, false);
  assert.equal(two.bar, false);
  assert.equal(two.approve, 'Approve 2');
  assert.equal(two.deny, 'Deny 2');
  assert.equal((two.list.match(/ checked>/g) || []).length, 2);
  assert.equal(ops.approve, 'Approve 2', 'Select ops picks the two ops items');
  assert.doesNotMatch(ops.list.match(/data-appr="p2"[\s\S]*?<\/article>/)[0], / checked>/);
  assert.equal(cleared.bar, true);
});
