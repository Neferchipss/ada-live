import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { scrollsX, isForbiddenControl, buildSummary, parseArgs, redact, shotName, stamp, DEFAULT_URL, ALL_TABS, freshUrl, assetVersion } from '../tools/ui-check.mjs';

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

test('map and session shots are named like the other tabs', () => {
  assert.equal(shotName('20261024-070509', 'map'), 'uicheck-20261024-070509-map.png');
  assert.equal(shotName('20261024-070509', 'session'), 'uicheck-20261024-070509-session.png');
});

test('only horizontally scrollable containers are exempt from the overflow check', () => {
  assert.equal(scrollsX('auto'), true);
  assert.equal(scrollsX('scroll'), true);
  assert.equal(scrollsX('visible'), false);
  assert.equal(scrollsX('hidden'), false);
});

test('state-changing controls are never clickable; navigation chips are', () => {
  for (const s of ['[data-approve]', '#appr-batch-approve', '.deny', '#composer-send', '#attach-paperclip', 'input[data-pick]', '#kill', '.run-anyway']) assert.equal(isForbiddenControl(s), true, s);
  for (const s of ['#tabs button[data-tab="chat"]', '#sv-bar [data-sv-map]', '#map-close', '#sv-bar .sv-chip[data-sv]', '#sv-bar [data-sv-ada]']) assert.equal(isForbiddenControl(s), false, s);
});

test('freshUrl adds a throwaway query and assetVersion reads app.js ?v=', () => {
  assert.equal(freshUrl('https://h/ada-live/', 123), 'https://h/ada-live/?uc=123');
  assert.equal(freshUrl('https://h/p?a=1#x', 5), 'https://h/p?a=1&uc=5#x');
  assert.equal(assetVersion('https://h/ada-live/app.js?v=sv-8'), 'sv-8');
  assert.equal(assetVersion('https://h/app.js'), '');
  assert.equal(buildSummary({ assetVersion: 'sv-8' }, []).assetVersion, 'sv-8');
});

test('summary keeps map and session facts compact and redacted', () => {
  const s = buildSummary({ map: { title: `Chats map ${PASS}`, nodes: 4 }, session: { banner: 'Viewing x', rows: 7 } }, [PASS]);
  assert.equal(s.map.nodes, 4);
  assert.equal(s.session.rows, 7);
  assert.ok(!JSON.stringify(s).includes(PASS));
});
