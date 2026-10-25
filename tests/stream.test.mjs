// Offline: Ada's streamed head turns. No CLI is started; events are fixtures shaped like `claude -p --output-format stream-json`.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LineParser, StreamTracker, Throttle, stripBlocks, phaseText, appendTiming } from '../collector/lib/stream.mjs';
import { ChatHub, headBrain, HEAD_MODELS } from '../collector/lib/chat.mjs';
import { claudeArgs, claudeResult } from '../collector/lib/runner.mjs';
import { LimitTracker } from '../collector/lib/limits.mjs';

const se = (event) => ({ type: 'stream_event', event, session_id: 's' });
const delta = (text) => se({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } });
const toolStart = (name) => se({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 't1', name, input: {} } });
const start = se({ type: 'message_start', message: { role: 'assistant', content: [] } });
const lines = (...evs) => evs.map((e) => JSON.stringify(e)).join('\n') + '\n';

test('line parser: events split across chunks, a garbled line and a truncated last line', () => {
  const got = [];
  const p = new LineParser((o) => got.push(o));
  const text = lines(start, delta('Hel'), { type: 'rate_limit_event' });
  p.feed(text.slice(0, 30)); p.feed(text.slice(30, 90)); p.feed(text.slice(90));
  p.feed('not json at all\n{"type":"stream_ev'); // garbled line, then a line cut off mid-way
  p.end();
  assert.deepEqual(got.map((o) => o.type), ['stream_event', 'stream_event', 'rate_limit_event']);
  const q = new LineParser((o) => got.push(o));
  q.feed('{"type":"result","result":"ok"}'); // complete but no trailing newline
  q.end();
  assert.equal(got.at(-1).type, 'result');
});

test('tracker: text deltas build the reply, first token is stamped once, a new message restarts the text', () => {
  let t = 100;
  const tr = new StreamTracker(() => t);
  assert.equal(tr.feed(start), false);
  assert.equal(tr.firstTokenAt, null);
  t = 250; assert.equal(tr.feed(delta('Hello ')), true);
  t = 400; assert.equal(tr.feed(delta('Nefer')), true);
  assert.equal(tr.firstTokenAt, 250);
  assert.deepEqual(tr.snapshot(), { text: 'Hello Nefer', status: '' });
  assert.equal(tr.feed({ type: 'assistant', message: {} }), false, 'only stream events count');
  assert.equal(tr.feed({ ...delta('sub'), parent_tool_use_id: 'x' }), false, 'a sub-agent stream is not Ada talking');
  tr.feed(start);
  assert.equal(tr.snapshot().text, '');
});

test('tracker: tool phases come from tool_use events and clear when text resumes; nothing is invented', () => {
  const tr = new StreamTracker();
  tr.feed(start);
  tr.feed(toolStart('Read'));
  assert.equal(tr.snapshot().status, 'Ada is reading…');
  tr.feed(delta('Found it.'));
  assert.equal(tr.snapshot().status, '');
  tr.feed(toolStart('Grep'));
  assert.equal(tr.snapshot().status, 'Ada is searching…');
  assert.equal(phaseText('mcp__thing__go'), 'Ada is using thing__go…');
  tr.feed(se({ type: 'content_block_start', index: 2, content_block: { type: 'thinking' } }));
  assert.equal(tr.snapshot().status, 'Ada is searching…', 'a thinking block adds no made-up status');
});

test('stripBlocks: complete, open and half-typed jobs/attach blocks never reach the page', () => {
  assert.equal(stripBlocks('On it.\n<jobs>\n[{"a":1}]\n</jobs>'), 'On it.');
  assert.equal(stripBlocks('On it.\n<jobs>\n[{"a":1'), 'On it.');
  assert.equal(stripBlocks('Here.\n<attach>[{"path":"x"}]</attach>\nbye'), 'Here.\n\nbye');
  assert.equal(stripBlocks('One <jobs>[]</jobs> two <attach>[{'), 'One  two');
  assert.equal(stripBlocks('Sure.\n<'), 'Sure.');
  assert.equal(stripBlocks('Sure.\n<jo'), 'Sure.');
  assert.equal(stripBlocks('Sure.\n<attach'), 'Sure.');
  assert.equal(stripBlocks('a < b and <b>bold</b>'), 'a < b and <b>bold</b>', 'ordinary angle brackets stay');
  assert.equal(stripBlocks('<JOBS>[]</JOBS>done'), 'done');
  const tr = new StreamTracker();
  tr.feed(delta('Starting.\n<jo')); assert.equal(tr.snapshot().text, 'Starting.');
  tr.feed(delta('bs>[{"folder"')); assert.equal(tr.snapshot().text, 'Starting.');
});

test('throttle: first update at once, then at most one per gap carrying the newest value', () => {
  let now = 1000;
  const timers = [];
  const out = [];
  const th = new Throttle((v) => out.push(v), 333, { now: () => now, setTimer: (fn, ms) => { const h = { fn, ms, unref() {} }; timers.push(h); return h; }, clearTimer: (h) => { h.dead = true; } });
  th.push('a'); assert.deepEqual(out, ['a']);
  now = 1100; th.push('b'); now = 1200; th.push('c');
  assert.deepEqual(out, ['a'], 'held back');
  assert.equal(timers.length, 1, 'one trailing timer, not one per update');
  assert.ok(timers[0].ms <= 333);
  now = 1340; timers[0].fn();
  assert.deepEqual(out, ['a', 'c'], 'the newest value wins');
  now = 1400; th.push('d'); th.cancel();
  assert.ok(timers[1].dead);
  assert.deepEqual(out, ['a', 'c'], 'cancel drops what was pending');
});

test('result parsing: the result event stays the source of truth (text, session, usage, denials, errors)', () => {
  const ok = claudeResult({ type: 'result', is_error: false, result: 'Final.', session_id: 'sess-1', total_cost_usd: 0.01, permission_denials: [{ tool_name: 'Bash' }], modelUsage: { 'claude-x': { contextWindow: 200000 } } }, 0, 'old');
  assert.deepEqual([ok.ok, ok.text, ok.session, ok.cost, ok.denied, ok.contextWindow, ok.contextModel], [true, 'Final.', 'sess-1', 0.01, ['Bash'], 200000, 'claude-x']);
  const bad = claudeResult({ type: 'result', is_error: true, result: 'API Error: overloaded' }, 0, 'keep');
  assert.deepEqual([bad.ok, bad.text, bad.session], [false, 'API Error: overloaded', 'keep']);
  assert.equal(claudeResult({ result: 'x' }, 1, 's').ok, false, 'a non-zero exit is a failure');
});

test('head args: strict empty MCP config and streaming for the head only; worker and full are unchanged', () => {
  const head = claudeArgs({ role: 'head' });
  assert.ok(head.includes('--strict-mcp-config'));
  assert.equal(head[head.indexOf('--mcp-config') + 1], '{"mcpServers":{}}');
  assert.deepEqual(head.slice(1, 3), ['--output-format', 'stream-json']);
  assert.ok(head.includes('--verbose') && head.includes('--include-partial-messages'));
  for (const role of ['worker', 'full']) {
    const a = claudeArgs({ role });
    assert.deepEqual(a.slice(0, 3), ['-p', '--output-format', 'json'], role);
    for (const f of ['--strict-mcp-config', '--mcp-config', '--verbose', '--include-partial-messages']) assert.ok(!a.includes(f), `${role} has no ${f}`);
  }
});

// ---- the hub ----

function hubWith({ stateJson, runAgent }) {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'ada-stream-'));
  const work = path.join(state, 'work');
  fs.mkdirSync(work);
  if (stateJson) fs.writeFileSync(path.join(state, 'chat.json'), JSON.stringify(stateJson));
  let now = 1_800_000_000_000;
  const hub = new ChatHub({
    workRoot: work, projects: () => [], stateDir: state,
    services: { now: () => now, limits: new LimitTracker({ now: () => now }), appendTaskEvent: () => {}, killProcessTree() {}, sessionContext: () => null, runAgent },
  });
  const tick = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r)); };
  const say = async (text, extra = {}) => { assert.equal(hub.handle({ kind: 'cmd', id: `c${Math.random()}`, ts: now, type: 'say', text, ...extra }), null); await tick(); };
  return { hub, state, say, tick, advance: (ms) => { now += ms; } };
}

test('brain migration: a saved codex brain loads as claude; models are Anthropic only; the picker offers claude only', () => {
  const thread = { id: 'ada', brain: { agent: 'codex', model: 'gpt-5-codex' }, heads: {}, lastAgent: 'codex', messages: [], pending: [], busy: false };
  const h = hubWith({ stateJson: { thread, jobs: [], projectSessions: {}, seen: [] }, runAgent() { throw new Error('unused'); } });
  assert.deepEqual(h.hub.view().thread.brain, { agent: 'claude', model: '' });
  assert.deepEqual(h.hub.view().brains, { claude: HEAD_MODELS });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(h.state, 'chat.json'), 'utf8')).thread.brain, { agent: 'claude', model: '' }, 'the migration is saved');
  assert.deepEqual(headBrain({ agent: 'codex', model: 'sonnet' }), { agent: 'claude', model: 'sonnet' });
  assert.deepEqual(headBrain({ agent: 'claude', model: 'gpt-5' }), { agent: 'claude', model: '' });
  assert.deepEqual(headBrain({ model: 'claude-opus-4-1' }), { agent: 'claude', model: 'claude-opus-4-1' });
});

test('say with a codex brain runs the head as claude', async () => {
  const seen = [];
  const h = hubWith({ runAgent(o) { seen.push(o.agent); return { child: { kill() {} }, done: Promise.resolve({ ok: true, text: 'hi', session: 's1' }) }; } });
  await h.say('hello', { brain: { agent: 'codex', model: 'gpt-5-codex' } });
  assert.deepEqual(seen, ['claude']);
  assert.deepEqual(h.hub.view().thread.brain, { agent: 'claude', model: '' });
});

test('streaming: shown in view() while the turn runs, never in chat.json, gone when it ends; final text comes from the result', async () => {
  let release, onStream, timingBefore;
  const h = hubWith({
    runAgent(o) {
      onStream = o.onStream;
      return { child: { kill() {} }, done: new Promise((res) => { release = res; }) };
    },
  });
  const changes = [];
  h.hub.onChange = () => changes.push(JSON.stringify(h.hub.view().thread.streaming));
  await h.say('hello');
  assert.equal(h.hub.view().thread.busy, true);
  assert.equal(h.hub.view().thread.streaming, null, 'nothing streamed yet');
  for (const ev of [start, toolStart('Read'), start, delta('Partial answer\n<jobs>[{"fol')]) onStream(ev);
  assert.equal(h.hub.view().thread.streaming.status, 'Ada is reading…', 'the first update goes out at once');
  h.advance(400);
  await new Promise((r) => setTimeout(r, 450)); // the held-back update lands on the throttle's trailing timer
  const v = h.hub.view().thread.streaming;
  assert.equal(v.text, 'Partial answer');
  assert.ok(Number.isFinite(v.at));
  const onDisk = fs.readFileSync(path.join(h.state, 'chat.json'), 'utf8');
  assert.ok(!onDisk.includes('Partial answer'), 'streamed text is not persisted');
  assert.ok(!fs.existsSync(path.join(h.state, 'timing.jsonl')));
  h.advance(8000);
  release({ ok: true, text: 'Final answer.', session: 's1' });
  await h.tick();
  const view = h.hub.view();
  assert.equal(view.thread.streaming, null);
  assert.equal(view.thread.busy, false);
  const last = view.thread.messages.at(-1);
  assert.equal(last.text, 'Final answer.');
  assert.equal(last.took, 8400);
  assert.ok(!fs.readFileSync(path.join(h.state, 'chat.json'), 'utf8').includes('Partial answer'));
  const rec = JSON.parse(fs.readFileSync(path.join(h.state, 'timing.jsonl'), 'utf8').trim());
  assert.deepEqual(Object.keys(rec).sort(), ['endedAt', 'firstTokenAt', 'ok', 'startedAt']);
  assert.equal(rec.endedAt - rec.startedAt, 8400);
  assert.equal(rec.firstTokenAt, rec.startedAt);
});

test('a stream that never produces text still ends with the final result; a throwing stream hook cannot break it', async () => {
  const h = hubWith({ runAgent(o) { o.onStream({ type: 'stream_event', event: null }); return { child: { kill() {} }, done: Promise.resolve({ ok: true, text: 'Landed.', session: 's' }) }; } });
  await h.say('hello');
  assert.equal(h.hub.view().thread.messages.at(-1).text, 'Landed.');
  assert.equal(h.hub.view().thread.streaming, null);
});

test('timing log: appended as JSON lines and cut back to about half once it passes the cap', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ada-timing-')), 'sub', 'timing.jsonl');
  for (let i = 0; i < 40; i++) appendTiming(file, { startedAt: i, firstTokenAt: i + 1, endedAt: i + 2 }, 1000);
  const size = fs.statSync(file).size;
  assert.ok(size <= 1000 + 100, `bounded (${size})`);
  const rows = fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(rows.at(-1).startedAt, 39, 'newest kept');
  assert.ok(rows[0].startedAt > 0, 'oldest dropped');
  assert.doesNotThrow(() => appendTiming(path.join(file, 'nope', 'x'), {}));
});
