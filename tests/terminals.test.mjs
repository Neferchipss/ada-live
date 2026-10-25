// Open terminal sessions count as active ("waiting") while their CLI process lives, even if the transcript is quiet.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ChatHub } from '../collector/lib/chat.mjs';
import { FullModePolicy } from '../collector/lib/fullmode.mjs';
import { LimitTracker } from '../collector/lib/limits.mjs';
import { activeMap, sessionState, sessionOpen, sessionActive, Journal } from '../collector/lib/journal.mjs';
import { claimedStart, mapOpenTerminals, markOpen, openTerminalSessions } from '../collector/lib/terminals.mjs';
import { buildSessionMap, activeCount, ribbonSessions } from '../docs/session-map.mjs';

const MIN = 60e3;
const T0 = Date.UTC(2026, 9, 25, 10, 0, 0);
const filetime = (ms) => (ms + 11644473600000) * 1e4;
const pf = (pid, id, over = {}) => ({ pid, sessionId: id, cwd: `C:\\Work\\p${pid}`, kind: 'interactive', entrypoint: 'cli', startedAt: T0, procStart: filetime(T0), ...over });
const ID = (c) => c.repeat(8) + '-0000-4000-8000-000000000000';
const alive = (...pids) => new Map(pids.map((p) => [p, { name: 'claude.exe', startMs: T0 + 1500 }]));

test('claimedStart reads the FILETIME procStart, else startedAt', () => {
  assert.equal(Math.round(claimedStart({ procStart: filetime(T0) })), T0);
  assert.equal(claimedStart({ startedAt: 123 }), 123);
  assert.equal(claimedStart(null), 0);
});

test('mapOpenTerminals: several terminals, one entry each; dead, reused-pid, sdk and non-interactive files are dropped', () => {
  const files = [
    pf(10, ID('a')), pf(11, ID('b')), pf(12, ID('c')),                       // 12 is dead
    pf(13, ID('d'), { entrypoint: 'sdk-cli' }),                              // a programmatic run (Ada's workers)
    pf(14, ID('e'), { kind: 'daemon' }),
    pf(15, ID('f')),                                                          // pid reused by a newer process
    pf(10, ID('a')),                                                          // duplicate file for the same session
    pf(16, 'short'), { nonsense: true }, null,
  ];
  const procs = alive(10, 11, 13, 14);
  procs.set(15, { name: 'claude.exe', startMs: T0 + 3600e3 });
  const out = mapOpenTerminals({ pidFiles: files, procs });
  assert.deepEqual(out.map((o) => o.id), [ID('a'), ID('b')]);
  assert.deepEqual(out.map((o) => o.pid), [10, 11]);
  assert.equal(out[0].cwd, 'C:\\Work\\p10');
});

test('two terminals in the same folder stay two entries (the pid file names the session)', () => {
  const out = mapOpenTerminals({ pidFiles: [pf(10, ID('a'), { cwd: 'C:\\Work\\same' }), pf(11, ID('b'), { cwd: 'C:\\Work\\same' })], procs: alive(10, 11) });
  assert.deepEqual(out.map((o) => o.id), [ID('a'), ID('b')]);
});

test('unreadable process list falls back to a pid liveness probe, and to nothing when that also fails', () => {
  const files = [pf(10, ID('a')), pf(11, ID('b'))];
  assert.deepEqual(mapOpenTerminals({ pidFiles: files, procs: null, isAlive: (p) => p === 11 }).map((o) => o.id), [ID('b')]);
  assert.deepEqual(mapOpenTerminals({ pidFiles: files, procs: null }), []);
  assert.deepEqual(mapOpenTerminals({}), []);
  assert.deepEqual(openTerminalSessions(), [], 'before any refresh: the old behaviour, no open terminals');
});

test('codex: a live codex.exe takes the most recently written rollout that began after it; ambiguity picks the newest write', () => {
  const cx = (id, startedAt, lastActivity, over = {}) => ({ agent: 'codex', id, startedAt, lastActivity, cwd: 'C:\\Work\\cx', ...over });
  const sessions = [cx('old-rollout-0001', T0 - 3600e3, T0 + 9 * MIN), cx('r-early-00001', T0 + MIN, T0 + 2 * MIN), cx('r-late-000001', T0 + 2 * MIN, T0 + 8 * MIN), cx('r-sub-000001', T0 + 2 * MIN, T0 + 20 * MIN, { parent: 'x' })];
  const one = mapOpenTerminals({ codexProcs: [{ pid: 50, startMs: T0 }], codexSessions: sessions });
  assert.deepEqual(one.map((o) => o.id), ['r-late-000001']);
  const two = mapOpenTerminals({ codexProcs: [{ pid: 50, startMs: T0 }, { pid: 51, startMs: T0 + 90e3 }], codexSessions: sessions });
  assert.deepEqual(two.map((o) => [o.pid, o.id]).sort(), [[50, 'r-early-00001'], [51, 'r-late-000001']]);
  assert.deepEqual(mapOpenTerminals({ codexProcs: [{ pid: 50, startMs: T0 + 3600e3 }], codexSessions: sessions }), [], 'nothing started after this process');
});

test('markOpen stamps matching sessions and fills a cwd the transcript tail lacked', () => {
  const s = [{ agent: 'claude', id: ID('a'), cwd: '' }, { agent: 'claude', id: ID('z'), cwd: 'C:\\x' }];
  markOpen(s, [{ agent: 'claude', id: ID('a'), pid: 10, cwd: 'C:\\Work\\p10' }]);
  assert.equal(s[0].open, true);
  assert.equal(s[0].cwd, 'C:\\Work\\p10');
  assert.equal(s[1].open, undefined);
  assert.doesNotThrow(() => markOpen(undefined, undefined));
});

test('sessionState: working (recent write) / waiting (open, quiet) / idle (gone); sessionActive is unchanged', () => {
  const now = T0;
  const quiet = { status: 'idle', lastActivity: now - 20 * MIN };
  assert.equal(sessionState({ ...quiet, status: 'working' }, now), 'working');
  assert.equal(sessionState({ ...quiet, lastActivity: now - MIN }, now), 'working');
  assert.equal(sessionState({ ...quiet, open: true }, now), 'waiting');
  assert.equal(sessionState({ ...quiet, open: true, lastActivity: now - 3 * 24 * 3600e3 }, now), 'waiting', 'an open terminal never ages out');
  assert.equal(sessionState(quiet, now), 'idle');
  assert.equal(sessionState(null, now), 'idle');
  assert.equal(sessionActive({ ...quiet, open: true }, now), false, 'the conflict guard still only blocks on real work');
  assert.equal(sessionOpen({ ...quiet, open: true }, now), true);
});

// ---- the shared definition across #sessionList, activeMap, the Map and the ribbon ----
function setup(sessions) {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'ada-tm-')), work = fs.mkdtempSync(path.join(os.tmpdir(), 'ada-tw-'));
  const proj = path.join(work, 'alpha');
  fs.mkdirSync(proj, { recursive: true });
  const projects = [{ name: 'alpha', path: proj }];
  const now = () => T0;
  const services = {
    now, limits: new LimitTracker({ now }), appendTaskEvent: () => {}, runAgent: () => { throw new Error('no run'); },
    external: () => ({ sessions: sessions.map((s) => ({ ...s, cwd: proj })), tasks: [] }),
    policy: new FullModePolicy({ stateDir: state, workRoot: work, hardRoot: work, projects: () => projects, now }),
  };
  const hub = new ChatHub({ workRoot: work, projects: () => projects, stateDir: state, services, mediaOut: async () => {}, relayMedia: () => true });
  return { hub, proj, projects, work };
}
const term = (id, over = {}) => ({ agent: 'claude', id, title: id, status: 'idle', lastActivity: T0 - 2 * 3600e3, startedAt: T0 - 3 * 3600e3, firstPrompt: 'fix css', ...over });

test('an open quiet terminal is waiting in the switcher, Activity, Map and ribbon; a closed one is not; Ada-owned ones never are', () => {
  const sess = [
    term('working-session', { status: 'working', lastActivity: T0 - 5e3, open: true }),
    term('waiting-session', { open: true }),
    term('closed-session', { lastActivity: T0 - 10 * MIN }),
    term('ada-owned-session', { open: true }),
    term('ada-job-session', { open: true, firstPrompt: 'Job from Ada (orchestrator)' }),
  ];
  const s = setup(sess);
  s.hub.ownSessions = () => new Set(['ada-owned-session']);
  const list = s.hub.view().sessions;
  const st = (id) => list.find((e) => e.session === id)?.status;
  assert.equal(st('working-session'), 'working');
  assert.equal(st('waiting-session'), 'waiting');
  assert.equal(st('closed-session'), 'idle');
  assert.equal(st('ada-owned-session'), undefined);
  assert.equal(st('ada-job-session'), undefined);
  assert.equal(list[0].session, 'working-session', 'working sorts before waiting');
  const am = activeMap({ projects: s.projects, workRoot: s.work, sessions: sess.map((x) => ({ ...x, cwd: s.proj })), own: new Set(['ada-owned-session']), now: T0 });
  assert.deepEqual(am.flatMap((g) => g.workers.map((w) => [w.id, w.status])), [['working-session', 'working'], ['waiting-session', 'waiting']]);
  const map = buildSessionMap({ chat: { sessions: list }, projects: s.projects }, T0);
  assert.equal(activeCount(map), 2, 'N active = working + waiting');
  const alpha = map.children.find((c) => c.label === 'alpha');
  assert.equal(alpha.meta.working, 1);
  assert.deepEqual(ribbonSessions(list, null).map((e) => e.session).sort(), ['waiting-session', 'working-session']);
  // the three views agree on who is active
  const ids = (xs) => xs.sort().join();
  assert.equal(ids(list.filter((e) => e.status !== 'idle').map((e) => e.session)), ids(am.flatMap((g) => g.workers.map((w) => w.id))));
});

test('an open terminal is listed however old its transcript is; without the process it ages out', () => {
  const old = T0 - 30 * 3600e3;
  const s = setup([term('open-old-session', { open: true, lastActivity: old }), term('gone-old-session', { lastActivity: old })]);
  const ids = s.hub.view().sessions.map((e) => e.session);
  assert.ok(ids.includes('open-old-session'));
  assert.ok(!ids.includes('gone-old-session'));
});

test('journal: an open waiting session does not end; it ends when the process goes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ada-tj-'));
  let t = T0;
  const j = new Journal({ file: path.join(dir, 'journal.json'), now: () => t });
  const ctx = { projects: [{ name: 'alpha', path: 'C:\\Work\\alpha' }], workRoot: 'C:\\Work', own: new Set(), jobs: [] };
  const s = (over) => ({ agent: 'claude', id: ID('q'), cwd: 'C:\\Work\\alpha', title: 't', status: 'working', lastActivity: t, firstPrompt: 'x', ...over });
  j.observeSessions([s({})], ctx);
  t += 10 * MIN;
  j.observeSessions([s({ status: 'idle', lastActivity: T0, open: true })], ctx);
  assert.equal(j.recent(10).length, 0, 'still open: no end event');
  t += MIN;
  j.observeSessions([s({ status: 'idle', lastActivity: T0 })], ctx);
  const e = j.recent(10);
  assert.equal(e.length, 1);
  assert.equal(e[0].kind, 'session');
});
