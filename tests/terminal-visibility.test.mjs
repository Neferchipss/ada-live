// Regression: terminal sessions and delegated tasks must reach the switcher and the Map; Ada's own sessions must not.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ChatHub } from '../collector/lib/chat.mjs';
import { FullModePolicy } from '../collector/lib/fullmode.mjs';
import { LimitTracker } from '../collector/lib/limits.mjs';
import { activeMap, isAdaSession, sessionActive } from '../collector/lib/journal.mjs';
import { buildSessionMap, RECENT_ID } from '../docs/session-map.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ada-tv-'));
const MIN = 60e3;

function setup({ sessions = [], tasks = [], jobs = [] } = {}) {
  const state = tmp(), work = tmp();
  const proj = path.join(work, 'alpha');
  fs.mkdirSync(proj, { recursive: true });
  const projects = [{ name: 'alpha', path: proj }];
  const clock = { t: Date.now() };
  const now = () => clock.t;
  const services = {
    now, limits: new LimitTracker({ now }), appendTaskEvent: () => {}, runAgent: () => { throw new Error('no run'); },
    external: () => ({ sessions, tasks }),
    policy: new FullModePolicy({ stateDir: state, workRoot: work, hardRoot: work, projects: () => projects, now }),
  };
  const hub = new ChatHub({ workRoot: work, projects: () => projects, stateDir: state, services, mediaOut: async () => {}, relayMedia: () => true });
  hub.state.jobs.push(...jobs.map((j) => ({ folder: proj, ...j })));
  return { hub, clock, proj, projects, work };
}
const term = (id, over = {}) => ({ agent: 'claude', id, title: 'My terminal', status: 'working', lastActivity: Date.now(), startedAt: Date.now() - 1000, firstPrompt: 'fix the header', ...over });
const ids = (hub) => hub.view().sessions.map((e) => e.session);

test('a human terminal session in the folder of a running Ada job is listed and shown on the Map', () => {
  const t0 = Date.now();
  const s = setup({ jobs: [{ id: 'j1', agent: 'claude', mode: 'safe', status: 'running', title: 'Ada job', startedAt: t0, createdAt: t0, session: 'job-session-0001' }] });
  s.hub.external = () => ({ sessions: [term('human-session-0001', { cwd: s.proj, startedAt: t0 + 1000 })], tasks: [] });
  assert.ok(ids(s.hub).includes('human-session-0001'));
  const map = buildSessionMap({ chat: s.hub.view(), projects: s.projects });
  const alpha = map.children.find((c) => c.label === 'alpha');
  assert.ok(alpha, 'under its project, in the active branch');
  assert.ok(alpha.children.some((c) => c.meta.session === 'human-session-0001'));
});

test('the same-folder heuristic only applies while the first prompt is unknown', () => {
  const t0 = Date.now();
  const jobs = [{ id: 'j1', status: 'running', mode: 'safe', folder: 'C:\Work\alpha', startedAt: t0 }];
  const base = { id: 'x', cwd: 'C:\Work\alpha', startedAt: t0 + 1000 };
  assert.equal(isAdaSession({ ...base, firstPrompt: '' }, { jobs }), true);
  assert.equal(isAdaSession({ ...base, firstPrompt: 'help me with css' }, { jobs }), false);
});

test("Ada's own sessions stay excluded: by id and by the 'Job from Ada' prompt", () => {
  const s = setup({
    jobs: [{ id: 'j1', agent: 'claude', mode: 'safe', status: 'running', title: 'Job', startedAt: Date.now(), session: 'own-session-0001' }],
  });
  s.hub.external = () => ({
    sessions: [
      term('own-session-0001', { cwd: s.proj }),
      term('marker-session-01', { cwd: s.proj, firstPrompt: 'Job from Ada (Nefer\'s orchestrator): do x', title: 'Job from Ada' }),
      term('human-session-0002', { cwd: s.proj }),
    ],
    tasks: [],
  });
  const list = s.hub.view().sessions.filter((e) => e.source === 'terminal').map((e) => e.session);
  assert.deepEqual(list, ['human-session-0002']);
});

test('a delegated task appears as a task entry and on the Map under its project; Ada-chat tasks do not duplicate jobs', () => {
  const now = Date.now();
  const tasks = [
    { id: 'abcd1234', status: 'running', agent: 'codex', title: 'Grass albedo', cwd: null, updatedAt: now - 10e3, createdAt: now - 20e3 },
    { id: 'beef5678', status: 'done', agent: 'claude', title: 'From Ada chat', by: 'ada-chat', updatedAt: now - 10e3, createdAt: now - 20e3 },
  ];
  const s = setup({ tasks });
  tasks[0].cwd = path.join(s.proj, 'src');
  const list = s.hub.view().sessions;
  const e = list.find((x) => x.source === 'task');
  assert.ok(e && list.filter((x) => x.source === 'task').length === 1);
  assert.deepEqual([e.agent, e.session, e.project, e.subfolder, e.status], ['task', 'task-abcd1234', 'alpha', 'src', 'working']);
  const map = buildSessionMap({ chat: { sessions: list }, projects: s.projects });
  const alpha = map.children.find((c) => c.label === 'alpha');
  const src = alpha.children.find((c) => c.label === 'src');
  assert.equal(src.children[0].meta.source, 'task');
  assert.equal(src.children[0].meta.live, 1);
});

test('a fresh low-activity session counts as active in #sessionList, activeMap and the Map; an old idle one does not', () => {
  const now = Date.now();
  const fresh = term('fresh-session-01', { status: 'idle', lastActivity: now - MIN });
  const stale = term('stale-session-01', { status: 'idle', lastActivity: now - 20 * MIN });
  const s = setup({});
  fresh.cwd = stale.cwd = s.proj;
  s.hub.external = () => ({ sessions: [fresh, stale], tasks: [] });
  assert.equal(sessionActive(fresh, now), true);
  assert.equal(sessionActive(stale, now), false);
  const list = s.hub.view().sessions;
  assert.equal(list.find((e) => e.session === 'fresh-session-01').status, 'working');
  assert.equal(list.find((e) => e.session === 'stale-session-01').status, 'idle');
  const am = activeMap({ projects: s.projects, workRoot: s.work, sessions: [fresh, stale], now });
  assert.deepEqual(am.flatMap((g) => g.workers.map((w) => w.id)), ['fresh-session-01']);
  const map = buildSessionMap({ chat: { sessions: list }, projects: s.projects }, now);
  const alpha = map.children.find((c) => c.label === 'alpha');
  assert.deepEqual(alpha.children.map((c) => c.meta.session), ['fresh-session-01']);
  const recent = map.children.find((c) => c.id === RECENT_ID);
  assert.ok(recent.children[0].children.some((c) => c.meta.session === 'stale-session-01'));
});
