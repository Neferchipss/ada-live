import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { pendingApprovals, openApprovals, soonestExpiry, recentResolved, outcomeLabel, countdown, newApprovals, GRACE_MS, approvalMessage, needsPinRetry, noteKey, RETRY_TAG, EXPIRED_TEXT } from '../docs/approvals.mjs';

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
  assert.match(app, /from '\.\/approvals\.mjs\?v=sv-1'/);
  assert.doesNotMatch(html, /id="appr-bar"/, 'the approvals bar is merged into the workers strip line');
  assert.match(app, /data-ws-appr/);
  assert.match(html, /id="approvals-sheet"/);
  assert.match(html, /app\.js\?v=sv-1/);
  const strip = app.slice(app.indexOf('function stripRow'), app.indexOf('function extRow'));
  assert.ok(!strip.includes('approvalControls'));
  assert.ok(strip.includes('data-review'));
  assert.ok(strip.includes('data-kill'));
});

const withNote = (n, o = {}) => job('n', { approvalNote: { at: NOW - 500, attemptsLeft: 3, lockedUntil: null, ...n }, ...o });

test('approvalMessage: wrong PIN wording, plural/singular, nothing without a note', () => {
  assert.equal(approvalMessage(job('a'), NOW).text, '');
  assert.deepEqual(approvalMessage(withNote({ reason: 'wrong-pin', attemptsLeft: 3 }), NOW), { kind: 'wrong-pin', text: 'Incorrect PIN · 3 tries left', locked: false, remainingMs: 0 });
  assert.equal(approvalMessage(withNote({ reason: 'wrong-pin', attemptsLeft: 1 }), NOW).text, 'Incorrect PIN · 1 try left');
  assert.equal(approvalMessage(withNote({ reason: 'mismatch' }), NOW).kind, 'mismatch');
});

test('approvalMessage: lockout countdown disables submit and lifts itself when it ends', () => {
  const j = withNote({ reason: 'locked', attemptsLeft: 0, lockedUntil: NOW + 272e3 }, { approvalExpiresAt: NOW + 600e3 });
  const m = approvalMessage(j, NOW);
  assert.equal(m.text, 'Too many attempts · try again in 4:32');
  assert.equal(m.locked, true);
  assert.equal(approvalMessage(j, NOW + 270e3).text, 'Too many attempts · try again in 0:02');
  const after = approvalMessage(withNote({ reason: 'locked', attemptsLeft: 0, lockedUntil: NOW + 1 }, { approvalExpiresAt: NOW + 600e3 }), NOW + 2);
  assert.deepEqual([after.locked, after.text], [false, '']);
});

test('approvalMessage: expiry while retrying shows the expired text', () => {
  const j = withNote({ reason: 'wrong-pin' }, { approvalExpiresAt: NOW + 10 });
  assert.equal(approvalMessage(j, NOW).kind, 'wrong-pin');
  assert.equal(approvalMessage(j, NOW + 10).text, EXPIRED_TEXT);
  assert.equal(approvalMessage({ ...j, status: 'expired' }, NOW).text, EXPIRED_TEXT);
  assert.equal(approvalMessage(withNote({ reason: 'expired' }), NOW).text, EXPIRED_TEXT);
});

test('retry tag only for an open job whose last refusal was a wrong PIN; noteKey ties state to job + attempt', () => {
  assert.equal(RETRY_TAG, 'PIN incorrect · tap to retry');
  assert.equal(needsPinRetry(withNote({ reason: 'wrong-pin' }), NOW), true);
  assert.equal(needsPinRetry(withNote({ reason: 'locked' }), NOW), false);
  assert.equal(needsPinRetry(withNote({ reason: 'wrong-pin' }, { approvalExpiresAt: NOW - 1 }), NOW), false);
  assert.equal(needsPinRetry(withNote({ reason: 'wrong-pin' }, { status: 'queued' }), NOW), false);
  assert.equal(needsPinRetry(job('a'), NOW), false);
  assert.notEqual(noteKey(withNote({ reason: 'wrong-pin', at: 1 })), noteKey(withNote({ reason: 'wrong-pin', at: 2 })));
  assert.equal(noteKey(job('a')), '');
});
