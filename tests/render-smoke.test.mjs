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

async function unlockWith(snap, { typed = 'test-pass', sealedWith = 'test-pass' } = {}) {
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
    };
  } finally { d.restore(); }
}

const now = Date.now();
const min = 60e3;
const realistic = () => ({
  v: 1, host: 'LAPTOP', workRoot: 'C:\\Work', generatedAt: now,
  ada: { status: 'working', statusNote: 'on it', step: 'Edit', thought: 'thinking', session: { id: 's1', title: 'Fix', cwd: 'C:\\Work\\Personal\\proj', model: 'm', remote: false }, since: now - 5 * min, activeSessions: 1 },
  sessions: [
    { agent: 'claude', id: 's1', title: 'Fix', cwd: 'C:\\Work\\Personal\\proj', model: 'm', lastPrompt: 'do it', status: 'working', statusNote: '', step: 'Edit', thought: '', lastActivity: now - 1000, startedAt: now - 9 * min, remote: false, steps: [{ t: now - 2000, kind: 'tool', tool: 'Edit', text: 'a.js', done: 1 }] },
    { agent: 'codex', id: 's2', title: 'Old', cwd: 'C:\\Elsewhere', model: 'm', lastPrompt: '', status: 'idle', statusNote: '', step: '', thought: '', lastActivity: now - 3 * 86400e3, startedAt: now - 4 * 86400e3, remote: false, steps: [] },
  ],
  tasks: [{ id: 't1', createdAt: now - 9 * min, outputs: [], t: now - min, mode: 'safe', agent: 'claude', title: 'Task', cwd: 'C:\\Work\\Personal\\proj', by: 'ada', status: 'done', preview: 'ok', updatedAt: now - min, startedAt: now - 8 * min, session: 's1' }],
  timeline: [
    { t: now - min, agent: 'claude', session: 's1', kind: 'tool', text: 'Edit a.js', cwd: 'C:\\Work\\Personal\\proj', error: false },
    { t: now - 2 * min, agent: 'codex', session: 's2', kind: 'error', text: 'boom', cwd: '', error: true },
  ],
  projects: [
    { name: 'proj', group: 'Personal', path: 'C:\\Work\\Personal\\proj', lastModified: now - min, recent: [{ file: 'a.js', t: now - min }], git: { branch: 'main', tracking: 'origin/main', changed: 2, last: { hash: 'abc1234', subject: 'x', t: now - min } }, isRepo: true, looseOnly: false, kind: 'github', repo: 'o/proj', private: true, site: null, url: 'https://github.com/o/proj', agents: [{ agent: 'claude', id: 's1', status: 'working', lastActivity: now }], lastActivity: now },
    { name: 'plain', group: 'Misc', path: 'C:\\Work\\Misc\\plain', lastModified: now - 9e6, recent: [], git: null, isRepo: false, looseOnly: false, kind: 'local', agents: [], lastActivity: now - 9e6 },
  ],
  accounts: [{ service: 'claude', name: 'A', email: 'a@x.y', plan: 'max', surfaces: ['cli'], shared: '', session: { pct: 40, resetsAt: now + 60 * min }, weekly: { pct: 10, resetsAt: now + 86400e3 }, extra: null, asOf: now, live: true }],
  limits: [{ service: 'claude', limited: true, resetText: '5pm', resetsAt: now + 60 * min, at: now }],
  chat: {
    thread: { id: 'th', brain: { agent: 'claude', model: 'm' }, busy: false, updatedAt: now, total: 2, messages: [{ id: 'm1', t: now - min, role: 'user', text: 'hi', cid: 'c1' }, { id: 'm2', t: now, role: 'ada', text: 'hello **x**', cid: 'c2', brain: { agent: 'claude', model: 'm' } }] },
    jobs: [
      { id: 'j1', folder: 'C:\\Work\\Personal\\proj', agent: 'claude', model: 'm', title: 'Run ops', status: 'awaiting-approval', createdAt: now - min, mode: 'ops', prompt: 'p', expiresAt: now + 4 * min },
      { id: 'j2', folder: 'C:\\Work\\Personal\\proj', agent: 'claude', model: 'm', title: 'Done job', status: 'done', createdAt: now - 20 * min, startedAt: now - 19 * min, endedAt: now - 10 * min, session: 's1', result: 'ok', mode: 'safe', prompt: 'p' },
      { id: 'j3', folder: 'C:\\Work\\Personal\\proj', agent: 'claude', title: 'Denied', status: 'denied', createdAt: now - 30 * min, mode: 'full', prompt: 'p' },
    ],
    brains: { claude: ['m'], codex: ['c'] }, memory: true, safeMode: true, fullModePinSet: true,
    media: { relay: false, ffmpeg: false, maxUpload: 1e6, maxFiles: 4, chunk: 1e5 }, uploads: [{ id: 'u1', state: 'done' }],
  },
  activeMap: [{ project: 'proj', path: 'C:\\Work\\Personal\\proj', folder: 'proj', subfolder: '', workers: [{ source: 'session', id: 's1', agent: 'claude', mode: 'safe', title: 'Fix', since: now - 5 * min, status: 'working' }] }],
  journal: [{ t: now - min, project: 'proj', path: 'C:\\Work\\Personal\\proj', kind: 'edit', count: 2, files: ['a.js'], by: 'claude' }],
  gitActivity: [{ name: 'proj', path: 'C:\\Work\\Personal\\proj', repo: 'o/proj', url: 'https://github.com/o/proj', branch: 'main', remoteBranch: true, ahead: 1, behind: 0, dirty: 2, lastPush: now - 9e5, reflog: true, commits: [{ h: 'abc1234', s: 'x', a: 'me', t: now - min, pushed: false }], pushes: [{ kind: 'push', branch: 'main', t: now - 9e5, from: 'a', to: 'b', n: 1 }] }],
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
