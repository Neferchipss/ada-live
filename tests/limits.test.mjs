import test from 'node:test';
import assert from 'node:assert/strict';
import { LimitTracker, looksLimited, parseReset, serviceOf } from '../collector/lib/limits.mjs';

const at = (h, m = 0, day = 24) => new Date(2026, 9, day, h, m, 0, 0).getTime();
const CODEX_LIMIT = "ERROR: You've hit your usage limit. Upgrade to Pro or try again at 8:12 AM.";

function clock(start) {
  const c = { t: start, now: () => c.t };
  return c;
}

test('limit patterns match usage/rate limit wording and ignore ordinary failures', () => {
  for (const s of [CODEX_LIMIT, 'rate limit exceeded', 'Please try again at 3pm', '5-hour limit reached ∙ resets 3pm', 'HTTP 429 Too Many Requests', 'too many requests']) {
    assert.equal(looksLimited(s), true, s);
  }
  for (const s of ['exit 1', 'TypeError: x is not a function', '', null, undefined]) assert.equal(looksLimited(s), false, String(s));
});

test('agents map to services', () => {
  assert.equal(serviceOf('claude'), 'claude');
  assert.equal(serviceOf('codex'), 'chatgpt');
  assert.equal(serviceOf('collector'), null);
});

test('parses a clock reset time, rolling to tomorrow when it already passed', () => {
  const early = parseReset(CODEX_LIMIT, at(3));
  assert.equal(early.resetsAt, at(8, 12));
  assert.match(early.resetText, /8:12/);
  const late = parseReset(CODEX_LIMIT, at(10));
  assert.equal(late.resetsAt, at(8, 12, 25));
  assert.equal(parseReset('resets 3pm', at(9)).resetsAt, at(15));
});

test('parses a relative reset time and returns null when there is none', () => {
  const r = parseReset('You are rate limited, try again in 2 hours 5 minutes.', at(9));
  assert.equal(r.resetsAt, at(9) + (2 * 60 + 5) * 60e3);
  assert.equal(r.resetText, 'in 2 hours 5 minutes');
  assert.equal(parseReset('usage limit reached', at(9)), null);
});

test('a failed run that reads like a limit error marks that service limited', () => {
  const c = clock(at(3));
  const tracker = new LimitTracker({ now: c.now });
  tracker.note('codex', { ok: false, error: CODEX_LIMIT, text: '' });
  const [entry, ...rest] = tracker.active();
  assert.equal(rest.length, 0);
  assert.equal(entry.service, 'chatgpt');
  assert.equal(entry.limited, true);
  assert.match(entry.resetText, /8:12/);
  assert.equal(entry.resetsAt, at(8, 12));
  assert.equal(entry.at, at(3));
});

test('ordinary failures and successful runs never set the flag', () => {
  const tracker = new LimitTracker({ now: clock(at(3)).now });
  tracker.note('claude', { ok: false, error: 'exit 1', text: '' });
  tracker.note('claude', { ok: true, text: 'I added rate limit handling to the API.' });
  assert.deepEqual(tracker.active(), []);
});

test('the flag clears when the stored reset time passes', () => {
  const c = clock(at(3));
  const tracker = new LimitTracker({ now: c.now });
  tracker.note('codex', { ok: false, error: CODEX_LIMIT });
  assert.equal(tracker.active().length, 1);
  c.t = at(8, 11);
  assert.equal(tracker.active().length, 1);
  c.t = at(8, 12);
  assert.deepEqual(tracker.active(), []);
});

test('the flag clears when a later run of that service succeeds, and only that service', () => {
  const tracker = new LimitTracker({ now: clock(at(3)).now });
  tracker.note('codex', { ok: false, error: CODEX_LIMIT });
  tracker.note('claude', { ok: false, error: 'rate limit exceeded' });
  assert.deepEqual(tracker.active().map((l) => l.service), ['claude', 'chatgpt']);
  tracker.note('codex', { ok: true, text: 'done' });
  assert.deepEqual(tracker.active().map((l) => l.service), ['claude']);
});

test('a limit with no parseable reset time expires after six hours', () => {
  const c = clock(at(1));
  const tracker = new LimitTracker({ now: c.now });
  tracker.note('claude', { ok: false, error: 'usage limit reached' });
  assert.equal(tracker.active()[0].resetText, '');
  c.t = at(1) + 5 * 3600e3;
  assert.equal(tracker.active().length, 1);
  c.t = at(1) + 6 * 3600e3 + 1;
  assert.deepEqual(tracker.active(), []);
});

test('accounts at 100% session or weekly mark the service limited until the window resets', () => {
  const c = clock(at(3));
  const tracker = new LimitTracker({ now: c.now });
  tracker.fromAccounts([
    { service: 'claude', asOf: at(3), session: { pct: 100, resetsAt: at(5) }, weekly: { pct: 40, resetsAt: at(5, 0, 28) } },
    { service: 'chatgpt', asOf: at(3), session: { pct: 20, resetsAt: at(5) }, weekly: { pct: 100, resetsAt: at(5, 0, 28) } },
    { service: 'higgsfield', credits: 0 },
  ]);
  assert.deepEqual(tracker.active().map((l) => l.service), ['claude', 'chatgpt']);
  assert.equal(tracker.active()[0].resetsAt, at(5));
  tracker.fromAccounts([{ service: 'claude', asOf: at(3), session: { pct: 99, resetsAt: at(5) }, weekly: null }]);
  assert.deepEqual(tracker.active(), []);
  // A window already past its reset is not limited.
  tracker.fromAccounts([{ service: 'claude', asOf: at(3), session: { pct: 100, resetsAt: at(2) } }]);
  assert.deepEqual(tracker.active(), []);
});

test('a run that succeeded after the accounts snapshot overrides stale 100% data', () => {
  const c = clock(at(3));
  const tracker = new LimitTracker({ now: c.now });
  c.t = at(4);
  tracker.note('codex', { ok: true, text: 'ok' });
  tracker.fromAccounts([{ service: 'chatgpt', asOf: at(3), session: { pct: 100, resetsAt: at(5) } }]);
  assert.deepEqual(tracker.active(), []);
});
