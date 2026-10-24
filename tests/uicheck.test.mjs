import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { buildSummary, parseArgs, redact, shotName, stamp, DEFAULT_URL, ALL_TABS } from '../tools/ui-check.mjs';

const PASS = 'correct-horse-battery';

test('stamp and shot names follow uicheck-<YYYYMMDD-HHMMSS>-<tab>.png', () => {
  const s = stamp(new Date(2026, 9, 24, 7, 5, 9));
  assert.equal(s, '20261024-070509');
  assert.equal(shotName(s, 'chat'), 'uicheck-20261024-070509-chat.png');
  assert.equal(shotName(s, 'work', true), 'uicheck-20261024-070509-work-full.png');
});

test('parseArgs defaults and overrides', () => {
  const d = parseArgs([]);
  assert.equal(d.url, DEFAULT_URL);
  assert.deepEqual(d.tabs, ALL_TABS);
  assert.ok(d.out.endsWith(path.join('.ada-viewer', 'inbox')));
  const o = parseArgs(['--url', 'http://x/', '--tabs', 'now, work', '--out', 'shots']);
  assert.equal(o.url, 'http://x/');
  assert.deepEqual(o.tabs, ['now', 'work']);
  assert.throws(() => parseArgs(['--tabs', 'bogus']), /Unknown tab/);
  assert.throws(() => parseArgs(['--nope']), /Unknown/);
});

test('redact removes raw, JSON-escaped and URL-encoded secrets', () => {
  const secret = 'pa"ss word/1';
  const text = `a ${secret} b ${JSON.stringify(secret).slice(1, -1)} c ${encodeURIComponent(secret)}`;
  const out = redact(text, [secret]);
  assert.ok(!out.includes('pa"ss word'));
  assert.ok(!out.includes('pa%22ss'));
  assert.ok(!out.includes('pa\\"ss'));
});

test('summary never contains the passphrase, in any field', () => {
  const leak = `boom ${PASS} at x.js:1`;
  const s = buildSummary({
    ok: true, url: `https://h/?k=${PASS}`, title: leak, shots: [`/tmp/${PASS}.png`],
    consoleErrors: [leak], pageErrors: [leak], failedRequests: [`https://h/${PASS} net::ERR`],
    bannerText: leak, overflow: { horizontal: [leak], wideElements: [leak] }, suspiciousText: [leak],
  }, [PASS]);
  assert.ok(!JSON.stringify(s).includes(PASS));
  assert.equal(s.consoleErrors.count, 1);
});

test('summary caps lists at 5 messages and truncates long ones', () => {
  const many = Array.from({ length: 9 }, (_, i) => `err ${i} ` + 'x'.repeat(1000));
  const s = buildSummary({ consoleErrors: many }, []);
  assert.equal(s.consoleErrors.count, 9);
  assert.equal(s.consoleErrors.first.length, 5);
  assert.ok(s.consoleErrors.first.every((m) => m.length <= 300));
  assert.ok(JSON.stringify(s).length < 8000);
});
