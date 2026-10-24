// Session viewer: transcript normalisers, redaction, cursor, path safety, and the sealed session-view command.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sessionTranscript, normClaudeLine, normCodexLine, LIMITS } from '../collector/lib/transcript.mjs';
import { redact } from '../collector/lib/redact.mjs';
import { ChatHub } from '../collector/lib/chat.mjs';
import { FullModePolicy } from '../collector/lib/fullmode.mjs';
import { LimitTracker } from '../collector/lib/limits.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ada-sv-'));
const jl = (rows) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
const T = (n) => new Date(Date.UTC(2026, 5, 15, 10, 0, n)).toISOString();
const SID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

const claudeRows = [
  { type: 'user', timestamp: T(0), message: { role: 'user', content: 'fix the bug' } },
  { type: 'user', timestamp: T(1), message: { role: 'user', content: '<system-reminder>hidden</system-reminder>' } },
  { type: 'assistant', timestamp: T(2), message: { model: 'm', content: [{ type: 'thinking', thinking: 'secret plan' }, { type: 'text', text: 'Looking.' }, { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls -la', description: 'list' } }] } },
  { type: 'user', timestamp: T(3), message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: 'file.txt' }] }] } },
  { type: 'assistant', isSidechain: true, timestamp: T(4), message: { content: [{ type: 'text', text: 'sidechain' }] } },
  { type: 'assistant', timestamp: T(5), message: { model: '<synthetic>', content: [{ type: 'text', text: 'No response requested.' }] } },
  { type: 'assistant', timestamp: T(6), message: { model: 'm', content: [{ type: 'text', text: 'Done.' }] } },
];
const codexRows = [
  { timestamp: T(0), type: 'session_meta', payload: { id: SID } },
  { timestamp: T(1), type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>x</environment_context>' }] } },
  { timestamp: T(2), type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'add a test' }] } },
  { timestamp: T(3), type: 'response_item', payload: { type: 'reasoning', summary: [{ text: 'thinking hard' }] } },
  { timestamp: T(4), type: 'response_item', payload: { type: 'function_call', name: 'shell', arguments: JSON.stringify({ command: ['npm', 'test'] }), call_id: 'c1' } },
  { timestamp: T(5), type: 'response_item', payload: { type: 'function_call_output', call_id: 'c1', output: JSON.stringify({ output: 'all green', metadata: {} }) } },
  { timestamp: T(6), type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Added it.' }] } },
  { timestamp: T(7), type: 'event_msg', payload: { type: 'user_message', message: 'dup' } },
];

function files() {
  const dir = tmp();
  const cf = path.join(dir, `${SID}.jsonl`);
  const xf = path.join(dir, 'rollout.jsonl');
  fs.writeFileSync(cf, jl(claudeRows));
  fs.writeFileSync(xf, jl(codexRows));
  return { dir, cf, xf, deps: { claudeFile: (id) => (id === SID ? cf : null), codexFile: (id) => (id === SID ? xf : null), literals: [] } };
}

test('claude lines normalise: text, tool, result; thinking, meta, sidechain and synthetic are dropped', () => {
  const f = files();
  const r = sessionTranscript('claude', SID, {}, f.deps);
  assert.equal(r.ok, true);
  assert.deepEqual(r.entries.map((e) => [e.role, e.kind, e.text]), [
    ['user', 'text', 'fix the bug'],
    ['assistant', 'text', 'Looking.'],
    ['assistant', 'tool', 'ls -la'],
    ['system', 'result', 'file.txt'],
    ['assistant', 'text', 'Done.'],
  ]);
  assert.equal(r.entries[2].tool, 'Bash');
  assert.ok(r.entries.every((e) => Number.isSafeInteger(e.i) && e.t > 0));
  assert.ok(!JSON.stringify(r).includes('secret plan'));
});

test('codex rollout normalises: messages, calls and outputs; reasoning and env context are dropped', () => {
  const f = files();
  const r = sessionTranscript('codex', SID, {}, f.deps);
  assert.deepEqual(r.entries.map((e) => [e.role, e.kind, e.text]), [
    ['user', 'text', 'add a test'],
    ['assistant', 'tool', 'npm test'],
    ['system', 'result', 'all green'],
    ['assistant', 'text', 'Added it.'],
  ]);
  assert.equal(r.entries[1].tool, 'shell');
});

test('clipping: text 4000, tool input 200, result 600, each ending in an ellipsis', () => {
  const big = 'x'.repeat(9000);
  const a = normClaudeLine({ type: 'assistant', timestamp: T(0), message: { content: [{ type: 'text', text: big }, { type: 'tool_use', name: 'Bash', input: { command: big } }] } }, []);
  assert.equal(a[0].text.length, LIMITS.text);
  assert.ok(a[0].text.endsWith('…'));
  assert.equal(a[1].text.length, LIMITS.tool);
  const r = normClaudeLine({ type: 'user', timestamp: T(0), message: { content: [{ type: 'tool_result', content: big }] } }, []);
  assert.equal(r[0].text.length, LIMITS.result);
  const c = normCodexLine({ type: 'response_item', timestamp: T(0), payload: { type: 'function_call_output', output: big } }, []);
  assert.equal(c[0].text.length, LIMITS.result);
});

test('cursor: first load returns the newest N, later polls only what is new', () => {
  const f = files();
  const first = sessionTranscript('claude', SID, { limit: 3 }, f.deps);
  assert.equal(first.entries.length, 3);
  assert.equal(first.more, true);
  const all = sessionTranscript('claude', SID, {}, f.deps);
  assert.deepEqual(first.entries.map((e) => e.i), all.entries.slice(-3).map((e) => e.i));
  const none = sessionTranscript('claude', SID, { after: all.next }, f.deps);
  assert.deepEqual(none.entries, []);
  assert.equal(none.next, all.next);
  fs.appendFileSync(f.cf, jl([{ type: 'assistant', timestamp: T(9), message: { model: 'm', content: [{ type: 'text', text: 'One more.' }] } }]));
  const more = sessionTranscript('claude', SID, { after: all.next }, f.deps);
  assert.deepEqual(more.entries.map((e) => e.text), ['One more.']);
  assert.ok(more.next > all.next);
  // a half-written last line is picked up once complete
  fs.appendFileSync(f.cf, '{"type":"assistant","timestamp":"x","message":{"content":[{"type":"te');
  assert.deepEqual(sessionTranscript('claude', SID, { after: more.next }, f.deps).entries, []);
});

test('a long transcript is read from the tail only, and a poll reads from the cursor', () => {
  const f = files();
  const rows = Array.from({ length: 4000 }, (_, k) => ({ type: 'assistant', timestamp: T(k % 50), message: { model: 'm', content: [{ type: 'text', text: `line ${k} ${'y'.repeat(300)}` }] } }));
  fs.writeFileSync(f.cf, jl(rows));
  const r = sessionTranscript('claude', SID, {}, f.deps);
  assert.equal(r.entries.length, LIMITS.defaultN);
  assert.match(r.entries.at(-1).text, /^line 3999 /);
  assert.ok(r.entries.every((e) => e.text.startsWith('line ')), 'no entry from a torn first line');
});

test('consecutive huge results collapse', () => {
  const f = files();
  const huge = { type: 'user', timestamp: T(0), message: { content: [{ type: 'tool_result', content: 'z'.repeat(5000) }] } };
  fs.writeFileSync(f.cf, jl([huge, huge, huge, claudeRows[6]]));
  const r = sessionTranscript('claude', SID, {}, f.deps);
  assert.equal(r.entries.length, 3);
  assert.equal(r.entries[1].text, '… 2 more large results');
});

test('path safety: unknown or malformed ids are rejected and no path is ever accepted', () => {
  const f = files();
  assert.equal(sessionTranscript('claude', 'ffffffff-0000-0000-0000-000000000000', {}, f.deps).err, 'unknown session');
  assert.equal(sessionTranscript('claude', f.cf, {}, f.deps).ok, false);
  assert.equal(sessionTranscript('claude', '../../etc/passwd', {}, { literals: [] }).ok, false);
  assert.equal(sessionTranscript('claude', 'C:\\Windows\\win.ini', {}, { literals: [] }).ok, false);
  assert.equal(sessionTranscript('codex', '..\\..\\x', {}, { literals: [] }).ok, false);
  assert.equal(sessionTranscript('bash', SID, {}, f.deps).err, 'unknown agent');
  assert.equal(sessionTranscript('claude', SID, {}, { ...f.deps, known: () => false }).err, 'unknown session');
});

test('redaction masks keys, tokens, assignments, blobs and the literal config secrets', () => {
  const lit = ['correct-horse-battery'];
  const cases = [
    'key sk-ant-api03-AbCdEfGhIjKlMnOpQrStUv here',
    'gh ghp_abcdefghijklmnopqrstuvwxyz0123456789',
    'aws AKIAIOSFODNN7EXAMPLE',
    'Authorization: Bearer abc123def456ghi789',
    'password=hunter2hunter2',
    '{"api_key": "abcd1234efgh"}',
    'export TOKEN=zzzz-9999-yyyy',
    'secret: topsecretvalue',
    'api_key_hash 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08',
    'jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r',
    'the passphrase is correct-horse-battery ok',
    '-----BEGIN RSA PRIVATE KEY-----\nMIIEabc\n-----END RSA PRIVATE KEY-----',
  ];
  for (const c of cases) {
    const out = redact(c, lit);
    assert.match(out, /\[redacted\]/, c);
    for (const leak of ['AbCdEfGhIjKlMnOpQrStUv', 'abcdefghijklmnopqrstuvwxyz0123456789', 'IOSFODNN7EXAMPLE', 'abc123def456ghi789', 'hunter2hunter2', 'abcd1234efgh', 'zzzz-9999-yyyy', 'topsecretvalue', '9f86d081884c7d65', 'dBjftJeZ4CVP', 'correct-horse', 'MIIEabc']) {
      assert.ok(!out.includes(leak), `${leak} leaked from: ${c}`);
    }
  }
  const plain = 'Ran the tests: 12 passed, shipping the mapping to the author. Read src/app.js';
  assert.equal(redact(plain, lit), plain);
});

test('redaction applies inside transcript entries, including a secret that straddles the clip', () => {
  const f = files();
  const sneaky = 'a'.repeat(LIMITS.text - 10) + ' sk-' + 'Q'.repeat(40);
  fs.writeFileSync(f.cf, jl([
    { type: 'user', timestamp: T(0), message: { content: 'my password=correct-horse-battery and token=abc12345' } },
    { type: 'assistant', timestamp: T(1), message: { model: 'm', content: [{ type: 'text', text: sneaky }, { type: 'tool_use', name: 'Bash', input: { command: 'curl -H "Authorization: Bearer abcdefghijklmnop"' } }] } },
  ]));
  const out = JSON.stringify(sessionTranscript('claude', SID, {}, { ...f.deps, literals: ['correct-horse-battery'] }));
  assert.ok(!out.includes('correct-horse'));
  assert.ok(!out.includes('abc12345'));
  assert.ok(!out.includes('QQQQQQQQ'));
  assert.ok(!out.includes('abcdefghijklmnop'));
});

// ---- the hub: sealed command, replay map, rate limit, snapshot list ----

function hubSetup({ sessions = [], jobs = [], transcript } = {}) {
  const state = tmp(), work = tmp();
  const clock = { t: Date.now(), now() { return this.t; } };
  const clockNow = () => clock.t;
  const sent = [];
  const services = {
    now: clockNow, limits: new LimitTracker({ now: clockNow }), appendTaskEvent: () => {}, runAgent: () => { throw new Error('no run'); },
    external: () => ({ sessions, tasks: [] }),
    transcript: transcript || ((agent, id, o, d) => ({ ...sessionTranscript(agent, id, o, { ...d, claudeFile: () => null, codexFile: () => null }) })),
    policy: new FullModePolicy({ stateDir: state, workRoot: work, hardRoot: work, projects: () => [], now: clockNow }),
  };
  const hub = new ChatHub({ workRoot: work, projects: () => [], stateDir: state, services, mediaOut: async (o) => { sent.push(o); }, relayMedia: () => true });
  hub.state.jobs.push(...jobs);
  let n = 0;
  const cmd = (extra = {}) => ({ kind: 'cmd', id: `sv${++n}`, ts: clock.t, type: 'session-view', agent: 'claude', session: SID, ...extra });
  const flush = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r)); };
  const reply = (id) => JSON.parse(sent.filter((o) => o.sv === id).sort((a, b) => a.i - b.i).map((o) => o.d).join(''));
  return { hub, clock, sent, cmd, flush, reply, work };
}
const term = (id, over = {}) => ({ agent: 'claude', id, title: 'My session', cwd: 'C:\\Elsewhere', status: 'working', lastActivity: Date.now(), startedAt: Date.now() - 1000, ...over });

test('session-view: known session is served as sealed chunks; unknown ids and bad input are rejected', async () => {
  const s = hubSetup({ sessions: [term(SID)] });
  const f = files();
  s.hub.transcript = (agent, id, o, d) => sessionTranscript(agent, id, o, { ...d, claudeFile: () => f.cf, literals: [] });
  const c = s.cmd();
  assert.equal(s.hub.handle(c), null);
  await s.flush();
  const r = s.reply(c.id);
  assert.equal(r.ok, true);
  assert.equal(r.entries.length, 5);
  assert.equal(r.status, 'working');
  s.clock.t += 2000;
  assert.equal(s.hub.handle(s.cmd({ session: 'bbbbbbbb-0000-0000-0000-000000000000' })), 'unknown session');
  assert.equal(s.hub.handle(s.cmd({ session: '../../etc/passwd' })), 'bad session');
  assert.equal(s.hub.handle(s.cmd({ agent: 'bash' })), 'bad agent');
  assert.equal(s.hub.handle(s.cmd({ after: 'x' })), 'bad cursor');
  assert.equal(s.hub.handle(s.cmd({ after: -5 })), 'bad cursor');
  assert.equal(s.hub.handle(s.cmd({ path: 'C:\\secrets.txt' })), null); // an extra path field is ignored, never used
});

test('session-view: replay is refused, polls do not touch the 500-entry replay window, rate limit is 1/s per session', async () => {
  const s = hubSetup({ sessions: [term(SID)], transcript: () => ({ ok: true, entries: [], next: -1 }) });
  const seenBefore = s.hub.state.seen.length;
  const c = s.cmd();
  assert.equal(s.hub.handle(c), null);
  assert.equal(s.hub.handle(c), 'replayed');
  assert.equal(s.hub.handle(s.cmd()), 'rate limited'); // same instant, same session
  s.clock.t += 1100;
  assert.equal(s.hub.handle(s.cmd()), null);
  for (let k = 0; k < 600; k++) { s.clock.t += 1100; s.hub.handle(s.cmd()); }
  assert.equal(s.hub.state.seen.length, seenBefore, 'session-view never enters state.seen');
  assert.ok(s.hub.svSeen.size <= 1000);
  assert.equal(s.hub.handle({ ...s.cmd(), ts: s.clock.t - 3600e3 }), 'stale');
});

test('session-view: a relay without media support is not sent anything', () => {
  const s = hubSetup({ sessions: [term(SID)] });
  s.hub.relayMedia = () => false;
  assert.equal(s.hub.handle(s.cmd()), 'relay cannot carry sessions');
  assert.equal(s.sent.length, 0);
});

test('a large reply is split into chunks that reassemble', async () => {
  const entries = Array.from({ length: 80 }, (_, i) => ({ i, t: 1, role: 'assistant', kind: 'text', text: 'w'.repeat(4000) }));
  const s = hubSetup({ sessions: [term(SID)], transcript: () => ({ ok: true, entries, next: 79 }) });
  const c = s.cmd();
  s.hub.handle(c);
  await s.flush();
  assert.ok(s.sent.length > 1);
  assert.ok(s.sent.every((o) => o.d.length <= 90000 && o.n === s.sent.length));
  assert.equal(s.reply(c.id).entries.length, 80);
});

test('view().sessions: jobs and terminal sessions, active first, Ada head and own sessions excluded, bounded to 30', () => {
  const now = Date.now();
  const sessions = [
    term('11111111-1', { title: 'Terminal live', lastActivity: now - 1000 }),
    term('22222222-2', { title: 'Terminal old', status: 'idle', lastActivity: now - 3 * 3600e3 }),
    term('33333333-3', { title: 'Too old', status: 'idle', lastActivity: now - 30 * 3600e3 }),
    term('44444444-4', { title: 'Job from Ada: do x', lastActivity: now }),
    term('55555555-5', { title: 'Job one', lastActivity: now, context: { used: 100, window: 1000, pct: 10 } }),
    ...Array.from({ length: 40 }, (_, k) => term(`9999999${k}-x`.padEnd(12, 'x'), { title: `Bulk ${k}`, status: 'idle', lastActivity: now - 4 * 3600e3 - k * 1000 })),
  ];
  const jobs = [
    { id: 'j1', agent: 'claude', mode: 'safe', title: 'Job one', folder: 'C:\\Other', session: '55555555-5', status: 'running', startedAt: now - 5000, createdAt: now - 6000 },
    { id: 'j2', agent: 'codex', mode: 'full', title: 'Old job', folder: 'C:\\Elsewhere', session: 'cccccccc-2', status: 'done', startedAt: now - 3 * 3600e3, endedAt: now - 3 * 3600e3 + 60e3, createdAt: now - 3 * 3600e3 },
    { id: 'j3', agent: 'claude', mode: 'safe', title: 'Ancient', folder: 'C:\\Elsewhere', session: 'dddddddd-3', status: 'done', startedAt: now - 40 * 3600e3, endedAt: now - 40 * 3600e3, createdAt: now - 40 * 3600e3 },
    { id: 'j4', agent: 'claude', mode: 'ops', title: 'Ops', folder: 'C:\\Elsewhere', status: 'done', createdAt: now },
  ];
  const s = hubSetup({ sessions, jobs });
  const list = s.hub.view().sessions;
  assert.ok(list.length <= 30);
  const titles = list.map((e) => e.title);
  assert.ok(!titles.includes('Too old') && !titles.includes('Ancient') && !titles.includes('Ops'));
  assert.ok(!titles.includes('Job from Ada: do x'), 'a worker is listed once, as a job, not as a terminal session');
  assert.equal(titles.filter((t) => t === 'Job one').length, 1);
  const job1 = list.find((e) => e.title === 'Job one');
  assert.deepEqual([job1.source, job1.agent, job1.status, job1.context?.pct], ['job', 'claude', 'working', 10]);
  assert.equal(list.find((e) => e.title === 'Old job').source, 'job');
  assert.equal(list.find((e) => e.title === 'Terminal live').source, 'terminal');
  const firstIdle = list.findIndex((e) => e.status !== 'working' && e.status !== 'blocked');
  assert.ok(list.slice(0, firstIdle).every((e) => e.status === 'working' || e.status === 'blocked'), 'active sessions come first');
  for (const e of list) assert.deepEqual(Object.keys(e).filter((k) => !['agent', 'session', 'title', 'project', 'subfolder', 'source', 'mode', 'status', 'startedAt', 'lastAt', 'context'].includes(k)), []);
});
