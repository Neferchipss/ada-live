import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ctxPct, fmtTokens, ctxLevel, ctxView, ctxNeedsFresh } from '../docs/context.mjs';
import { claudeUsage, claudeContext, codexUsage, codexContext, makeContext, windowFor, windowFromModelUsage, learnWindow, learnedWindows, loadWindows } from '../collector/lib/context.mjs';
import { parseJsonLines } from '../collector/lib/util.mjs';
import { ChatHub } from '../collector/lib/chat.mjs';
import { LimitTracker } from '../collector/lib/limits.mjs';
import { activeMap } from '../collector/lib/journal.mjs';

const fixture = (name) => parseJsonLines(fs.readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8').split('\n'));

test('percent: whole numbers, unknown window or usage gives null, not capped', () => {
  assert.equal(ctxPct(84000, 200000), 42);
  assert.equal(ctxPct(0, 200000), 0);
  assert.equal(ctxPct(210000, 200000), 105);
  for (const w of [null, undefined, 0, -5, NaN]) assert.equal(ctxPct(1000, w), null);
  assert.equal(ctxPct(NaN, 1000), null);
  assert.equal(ctxPct(-1, 1000), null);
});

test('token labels', () => {
  assert.deepEqual([0, 842, 999, 1000, 84300, 999499, 1000000, 1250000, 12400000].map(fmtTokens), ['0', '842', '999', '1k', '84k', '999k', '1M', '1.2M', '12M']);
  assert.equal(fmtTokens(NaN), '');
  assert.equal(fmtTokens(-3), '');
});

test('thresholds: amber from 70, red from 90, fresh hint from 80', () => {
  assert.deepEqual([null, 0, 69, 70, 89, 90, 120].map(ctxLevel), ['', '', '', 'hot', 'hot', 'crit', 'crit']);
  const v = (pct) => ctxView({ used: pct * 1000, window: 100000 });
  assert.equal(ctxNeedsFresh(v(79)), false);
  assert.equal(ctxNeedsFresh(v(80)), true);
  assert.equal(ctxNeedsFresh(ctxView({ used: 900000 })), false, 'no window: never nags');
  assert.equal(ctxNeedsFresh(null), false);
});

test('view: label with percent, tokens only when the window is unknown, "~" for an assumed window', () => {
  assert.equal(ctxView({ used: 84300, window: 200000, src: 'data' }).label, '42% · 84k');
  assert.equal(ctxView({ used: 84300, window: 200000, src: 'family' }).label, '~42% · 84k');
  const unknown = ctxView({ used: 84300 });
  assert.equal(unknown.label, '84k');
  assert.equal(unknown.pct, null);
  assert.equal(unknown.level, '');
  assert.match(unknown.title, /window size unknown/);
  assert.equal(ctxView({ used: 100, window: 'x' }).label, '100');
  for (const bad of [null, undefined, {}, { used: 0 }, { used: -4 }, { used: NaN }]) assert.equal(ctxView(bad), null);
  assert.equal(ctxView({ used: 190000, window: 200000 }).level, 'crit');
});

test('claude transcript: the LAST real assistant message counts, not a sum; sidechain and synthetic are skipped; partial last line ignored', () => {
  const entries = fixture('claude-session.jsonl');
  assert.equal(entries.length, 5, 'the cut-off last line is dropped by the parser');
  assert.deepEqual(claudeUsage(entries), { used: 3 + 150000 + 4000, model: 'claude-sonnet-4-5' });
  assert.equal(claudeUsage([]), null);
  assert.equal(claudeUsage([{ type: 'user' }, { type: 'assistant', message: { model: 'm', usage: {} } }]), null);
});

test('claude context: window from what the CLI reported, else the documented family map, else unknown', () => {
  const entries = fixture('claude-session.jsonl');
  assert.deepEqual(claudeContext(entries), { used: 154003, window: 200000, pct: 77, model: 'claude-sonnet-4-5', src: 'family' });
  learnWindow('claude-sonnet-4-5', 1000000);
  assert.deepEqual(claudeContext(entries), { used: 154003, window: 1000000, pct: 15, model: 'claude-sonnet-4-5', src: 'data' });
  assert.equal(learnedWindows()['claude-sonnet-4-5'], 1000000);
  const other = [{ type: 'assistant', message: { model: 'claude-future-9', usage: { input_tokens: 5, cache_read_input_tokens: 84000 } } }];
  assert.deepEqual(claudeContext(other), { used: 84005, window: null, pct: null, model: 'claude-future-9' }, 'unknown model: tokens only, no invented window');
});

test('family windows: only documented families; a window the usage already exceeds is dropped', () => {
  assert.deepEqual(['claude-3-5-sonnet-20241022', 'claude-opus-4-1-20250805', 'claude-haiku-4-5'].map((m) => windowFor(m)?.window), [200000, 200000, 200000]);
  assert.equal(windowFor('claude-sonnet-5-5-unlisted'), null);
  assert.equal(windowFor('gpt-5-codex'), null);
  assert.equal(windowFor(''), null);
  assert.equal(makeContext({ used: 250000, window: 200000, src: 'family', model: 'm' }).window, null);
  assert.equal(makeContext({ used: 250000, window: 200000, src: 'data', model: 'm' }).pct, 125, 'a reported window is trusted even when over');
  assert.equal(makeContext({ used: 0, window: 200000 }), null);
  loadWindows({ 'x-model': 'bad', 'y-model': -1 });
  assert.equal(windowFor('x-model'), null);
});

test('modelUsage from a Claude JSON result: the CLI-reported context window', () => {
  assert.deepEqual(windowFromModelUsage({ 'claude-sonnet-4-5': { contextWindow: 200000 }, 'claude-haiku-4-5': { contextWindow: 100000 } }), { model: 'claude-sonnet-4-5', window: 200000 });
  assert.equal(windowFromModelUsage({ a: { inputTokens: 5 } }), null);
  for (const bad of [null, undefined, 'x', 3]) assert.equal(windowFromModelUsage(bad), null);
});

test('codex rollout: last token_count, last_token_usage (not the cumulative total), window from the data', () => {
  const entries = fixture('codex-rollout.jsonl');
  assert.deepEqual(codexUsage(entries), { used: 90230, window: 258400 });
  assert.deepEqual(codexContext(entries, 'gpt-5-codex'), { used: 90230, window: 258400, pct: 35, model: 'gpt-5-codex', src: 'data' });
  assert.equal(codexUsage([]), null);
  const noWindow = [{ type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 5000 } } } }];
  assert.deepEqual(codexContext(noWindow), { used: 5000, window: null, pct: null, model: '' });
});

test('activeMap carries the context of a terminal session and of a running job (by session id)', () => {
  const ctx = { used: 84000, window: 200000, pct: 42, model: 'm' };
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ada-ctx-'));
  const folder = path.join(root, 'p');
  fs.mkdirSync(folder);
  const now = 1_800_000_000_000;
  const map = activeMap({
    projects: [{ name: 'p', path: folder }], workRoot: root, now,
    sessions: [{ agent: 'claude', id: 'term', cwd: folder, status: 'working', lastActivity: now, title: 't', context: ctx }, { agent: 'claude', id: 'jobsess', cwd: folder, status: 'working', lastActivity: now, title: 'Job from Ada', context: { ...ctx, used: 5000 } }],
    jobs: [{ id: 'j1', status: 'running', agent: 'claude', mode: 'full', title: 'Fix', folder, startedAt: now - 1000, session: 'jobsess' }, { id: 'j2', status: 'queued', agent: 'claude', mode: 'safe', title: 'Wait', folder, createdAt: now, session: 'jobsess' }],
  });
  const workers = map.flatMap((g) => g.workers);
  assert.deepEqual(workers.find((w) => w.id === 'term').context, ctx);
  assert.equal(workers.find((w) => w.id === 'j1').context.used, 5000);
  assert.equal(workers.find((w) => w.id === 'j2').context, undefined, 'only a running job reads its transcript');
});

function hubWith({ session = 's-head', sessionContext, result = {} } = {}) {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'ada-ctxhub-'));
  const work = path.join(state, 'work');
  fs.mkdirSync(work);
  let now = 1_800_000_000_000;
  const hub = new ChatHub({
    workRoot: work, projects: () => [], stateDir: state,
    services: {
      now: () => now, limits: new LimitTracker({ now: () => now }), appendTaskEvent: () => {}, killProcessTree() {},
      sessionContext,
      runAgent() { return { child: { kill() {}, pid: 1 }, done: Promise.resolve({ ok: true, text: 'hi', session, ...result }) }; },
    },
  });
  let n = 0;
  const say = async (text, extra = {}) => {
    assert.equal(hub.handle({ kind: 'cmd', id: `c${++n}`, ts: now, type: 'say', text, ...extra }), null);
    for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r));
    now += 1000;
  };
  return { hub, say, state, now: () => now };
}

test('head turn: context stored per brain, exposed in view(), cleared by a fresh context', async () => {
  const calls = [];
  const h = hubWith({
    sessionContext: (agent, id) => { calls.push([agent, id]); return agent === 'codex' ? { used: 90230, window: 258400, pct: 35, model: 'gpt-5-codex', src: 'data' } : { used: 84000, window: null, pct: null, model: 'claude-test-ctx-model' }; },
    result: { contextWindow: 1000000, contextModel: 'claude-test-ctx-model' },
  });
  assert.equal(h.hub.view().thread.context, null, 'nothing before the first turn');
  await h.say('hello', { brain: { agent: 'claude', model: '' } });
  assert.deepEqual(calls, [['claude', 's-head']]);
  const c = h.hub.view().thread.context;
  assert.deepEqual({ agent: c.agent, model: c.model, used: c.used, window: c.window, src: c.src }, { agent: 'claude', model: 'claude-test-ctx-model', used: 84000, window: 1000000, src: 'data' }, "the run's own contextWindow wins");
  assert.ok(c.at > 0);
  assert.equal(learnedWindows()['claude-test-ctx-model'], 1000000, 'remembered so terminal sessions of that model get a percentage');
  assert.equal(JSON.parse(fs.readFileSync(path.join(h.state, 'chat.json'), 'utf8')).windows['claude-test-ctx-model'], 1000000, 'persisted');

  await h.say('and codex', { brain: { agent: 'codex', model: '' } });
  const x = h.hub.view().thread.context;
  assert.deepEqual([x.agent, x.used, x.window], ['codex', 90230, 258400]);
  await h.say('back', { brain: { agent: 'claude', model: '' } });
  assert.equal(h.hub.view().thread.context.agent, 'claude', 'each brain keeps its own');

  assert.equal(h.hub.handle({ kind: 'cmd', id: 'reset1', ts: h.now(), type: 'reset' }), null);
  assert.equal(h.hub.view().thread.context, null, 'fresh context clears the bar');
});

test('head turn: a missing transcript or a throwing reader never breaks the turn', async () => {
  for (const sessionContext of [() => null, () => { throw new Error('disk'); }]) {
    const h = hubWith({ sessionContext });
    await h.say('hello');
    assert.equal(h.hub.view().thread.context, null);
    assert.equal(h.hub.view().thread.messages.at(-1).text, 'hi');
  }
});
