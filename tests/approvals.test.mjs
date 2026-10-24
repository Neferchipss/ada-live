import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { pendingApprovals, openApprovals, soonestExpiry, recentResolved, outcomeLabel, countdown, newApprovals, GRACE_MS } from '../docs/approvals.mjs';

const NOW = 1_000_000;
const job = (id, o = {}) => ({ id, mode: 'ops', status: 'awaiting-approval', createdAt: NOW - 1000, approvalExpiresAt: NOW + 60e3, ...o });

test('pending: awaiting only, newest first, expired drop after grace', () => {
  const jobs = [
    job('a', { createdAt: 1 }), job('b', { createdAt: 5 }), job('c', { status: 'running' }),
    job('old', { approvalExpiresAt: NOW - 1000 }), job('gone', { approvalExpiresAt: NOW - GRACE_MS - 1 }),
  ];
  assert.deepEqual(pendingApprovals(jobs, NOW).map((j) => j.id), ['old', 'b', 'a']);
  assert.deepEqual(openApprovals(jobs, NOW).map((j) => j.id), ['b', 'a']);
});

test('soonest expiry ignores expired jobs', () => {
  const jobs = [job('a', { approvalExpiresAt: NOW + 90e3 }), job('b', { approvalExpiresAt: NOW + 30e3 }), job('c', { approvalExpiresAt: NOW - 5 })];
  assert.equal(soonestExpiry(jobs, NOW), NOW + 30e3);
  assert.equal(soonestExpiry([], NOW), null);
});

test('recent: resolved ops/full only, newest first, capped at 10', () => {
  const jobs = [
    job('safe', { mode: 'safe', status: 'done', endedAt: 9999 }),
    job('pending'),
    ...Array.from({ length: 12 }, (_, i) => job(`r${i}`, { status: 'done', endedAt: 1000 + i })),
  ];
  const r = recentResolved(jobs, NOW);
  assert.equal(r.length, 10);
  assert.equal(r[0].id, 'r11');
  assert.ok(!r.some((j) => j.id === 'safe' || j.id === 'pending'));
});

test('outcome labels', () => {
  assert.equal(outcomeLabel({ status: 'denied' }), 'Denied');
  assert.equal(outcomeLabel({ status: 'expired' }), 'Expired');
  assert.equal(outcomeLabel({ status: 'failed', result: 'Killed by Nefer from the phone.' }), 'Killed');
  assert.equal(outcomeLabel({ status: 'failed', result: 'boom' }), 'Failed');
  assert.equal(outcomeLabel({ status: 'running' }), 'Approved · running');
});

test('countdown formatting', () => {
  assert.equal(countdown(272_000), '4:32');
  assert.equal(countdown(-5), '0:00');
  assert.equal(countdown(59_100), '1:00');
  assert.equal(countdown(3_900_000), '1h 05m');
});

test('new approvals: first snapshot seeds, each job reported once', () => {
  const first = newApprovals([job('a')], null, NOW);
  assert.deepEqual(first.fresh, []);
  const again = newApprovals([job('a'), job('b')], first.seen, NOW);
  assert.deepEqual(again.fresh.map((j) => j.id), ['b']);
  assert.deepEqual(newApprovals([job('a'), job('b')], again.seen, NOW).fresh, []);
  assert.deepEqual(newApprovals([job('x', { approvalExpiresAt: NOW - 1 })], again.seen, NOW).fresh, []);
});

test('page wiring: panel, review button, no duplicate strip buttons, cache-bust', () => {
  const read = (f) => fs.readFileSync(fileURLToPath(new URL(`../docs/${f}`, import.meta.url)), 'utf8');
  const app = read('app.js'), html = read('index.html');
  assert.match(app, /from '\.\/approvals\.mjs'/);
  assert.match(html, /id="appr-bar"/);
  assert.match(html, /id="approvals-sheet"/);
  assert.match(html, /app\.js\?v=chat-simple-1/);
  const strip = app.slice(app.indexOf('function stripRow'), app.indexOf('function extRow'));
  assert.ok(!strip.includes('approvalControls'));
  assert.ok(strip.includes('data-review'));
  assert.ok(strip.includes('data-kill'));
});
