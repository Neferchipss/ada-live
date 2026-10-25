import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { APPROVAL_MS_FULL, PIN_LOCK_MS } from '../collector/lib/fullmode.mjs';
import { setup, PIN } from './helpers/fullmode-setup.mjs';

const entries = (...jobs) => jobs.map((j) => ({ job: j.id, approval: j.approvalId }));
const batch = (s, type, jobs, extra = {}) => s.hub.handle(s.cmd(type, { jobs, ...extra }));
const approveOne = (s, job, pin) => s.hub.handle(s.cmd('approve', { job: job.id, approval: job.approvalId, pin }));
const rawAudit = (s) => { try { return fs.readFileSync(path.join(s.state, 'fullmode-audit.log'), 'utf8'); } catch { return ''; } };
const threeFull = (s) => s.propose([1, 2, 3].map((n) => ({ mode: 'full', folder: s.proj, agent: 'claude', title: `Full ${n}`, prompt: `do ${n}` })));

test('approve-batch: all valid jobs approved, one audit line each sharing a batchId, never the PIN', async () => {
  const s = setup();
  const jobs = await threeFull(s);
  assert.equal(batch(s, 'approve-batch', entries(...jobs), { pin: PIN }), null);
  assert.ok(jobs.every((j) => j.approvedByPin === true));
  assert.equal(s.runs.length, 2, 'the max-2-running guard still applies');
  assert.deepEqual(jobs.map((j) => j.status).sort(), ['queued', 'running', 'running']);
  const lines = s.audit().filter((l) => l.outcome === 'approved-batch');
  assert.deepEqual(lines.map((l) => l.jobId).sort(), jobs.map((j) => j.id).sort());
  assert.equal(new Set(lines.map((l) => l.batchId)).size, 1);
  assert.match(lines[0].batchId, /^b-/);
  assert.ok(!rawAudit(s).includes(PIN));
});

test('approve-batch: one expired + two valid -> two approved, the expired one refused with its reason', async () => {
  const s = setup();
  const [full, opsA, opsB] = await s.propose([
    { mode: 'full', folder: s.proj, agent: 'claude', prompt: 'a' },
    { mode: 'ops', op: 'echo-ok', title: 'Echo A' }, { mode: 'ops', op: 'echo-ok', title: 'Echo B' }]);
  s.clock.t += APPROVAL_MS_FULL + 1; // the full job (5 min) lapses; ops (30 min) are still open
  const out = s.policy.approveBatch([full, opsA, opsB].map((j) => ({ job: j, approval: j.approvalId })), PIN, 'b-test');
  assert.deepEqual(out.map((o) => o.reason), ['expired', null, null]);
  assert.equal(full.approvalNote.reason, 'expired');
  assert.equal(full.approvedByPin, false);
  assert.ok(opsA.approvedByPin && opsB.approvedByPin);
  assert.equal(s.policy.pinFailures.length, 0, 'expiry is not a PIN attempt');
  const lines = s.audit();
  assert.deepEqual(lines.map((l) => l.outcome).sort(), ['approved-batch', 'approved-batch', 'refused:expired']);
  assert.ok(lines.every((l) => l.batchId === 'b-test'));
});

test('approve-batch through the hub: expired job gets a chat line, the others run', async () => {
  const s = setup();
  const [full, ops] = await s.propose([{ mode: 'full', folder: s.proj, agent: 'claude', title: 'Late', prompt: 'a' }, { mode: 'ops', op: 'echo-ok', title: 'Echo' }]);
  const list = entries(full, ops);
  s.clock.t += APPROVAL_MS_FULL + 1;
  assert.equal(batch(s, 'approve-batch', list, { pin: PIN }), null);
  assert.equal(full.status, 'expired', 'the hub sweep expires it before the batch runs');
  assert.equal(s.ops.length, 1);
});

test('approve-batch: a wrong PIN approves nothing, counts ONE attempt and notes every job', async () => {
  const s = setup();
  const jobs = await threeFull(s);
  assert.ok(batch(s, 'approve-batch', entries(...jobs), { pin: '000000' }));
  assert.ok(jobs.every((j) => j.status === 'awaiting-approval' && !j.approvedByPin));
  assert.equal(s.policy.pinFailures.length, 1);
  for (const j of jobs) assert.deepEqual([j.approvalNote.reason, j.approvalNote.attemptsLeft], ['wrong-pin', 4]);
  assert.deepEqual(s.audit().map((l) => l.outcome), ['refused:wrong-pin', 'refused:wrong-pin', 'refused:wrong-pin']);
  assert.equal(s.runs.length, 0);
  assert.ok(!rawAudit(s).includes('000000'));
});

test('approve-batch: five wrong batches lock out; the right PIN is refused for batch and single until the window passes', async () => {
  const s = setup();
  const jobs = await threeFull(s);
  for (let i = 0; i < 5; i++) batch(s, 'approve-batch', entries(...jobs), { pin: '000000' });
  assert.equal(s.policy.pinFailures.length, 5);
  assert.ok(jobs.every((j) => j.approvalNote.reason === 'locked' && j.approvalNote.attemptsLeft === 0 && Number.isFinite(j.approvalNote.lockedUntil)));
  assert.match(batch(s, 'approve-batch', entries(...jobs), { pin: PIN }), /Too many/);
  assert.match(approveOne(s, jobs[0], PIN), /Too many/);
  assert.ok(jobs.every((j) => j.status === 'awaiting-approval'));
  s.clock.t += PIN_LOCK_MS + 1;
  const fresh = jobs.filter((j) => !s.policy.expired(j));
  assert.equal(fresh.length, 0, 'full jobs lapsed during the lockout, as with single approvals');
});

test('approve-batch: duplicate ids, more than 20, empty or malformed lists are rejected before any PIN check', async () => {
  const s = setup();
  const [a] = await s.propose([{ mode: 'full', folder: s.proj, agent: 'claude', prompt: 'a' }]);
  const e = entries(a)[0];
  assert.equal(batch(s, 'approve-batch', [e, e], { pin: PIN }), 'duplicate job in batch');
  assert.equal(batch(s, 'approve-batch', Array.from({ length: 21 }, (_, i) => ({ job: `j${i}`, approval: 'x' })), { pin: PIN }), 'at most 20 jobs per batch');
  assert.equal(batch(s, 'approve-batch', [], { pin: PIN }), 'no jobs selected');
  assert.equal(batch(s, 'approve-batch', 'nope', { pin: PIN }), 'no jobs selected');
  assert.equal(batch(s, 'approve-batch', [{ job: a.id }], { pin: PIN }), 'bad batch entry');
  assert.equal(batch(s, 'approve-batch', [e]), 'bad batch entry', 'no PIN');
  assert.equal(batch(s, 'deny-batch', [e, e]), 'duplicate job in batch');
  assert.equal(s.policy.pinFailures.length, 0);
  assert.equal(a.status, 'awaiting-approval');
  const twenty = Array.from({ length: 20 }, (_, i) => ({ job: `j${i}`, approval: 'x' }));
  assert.notEqual(batch(s, 'approve-batch', twenty, { pin: PIN }), 'at most 20 jobs per batch', 'exactly 20 is allowed');
});

test('approve-batch: a mismatched approval id refuses that job only', async () => {
  const s = setup();
  const jobs = await threeFull(s);
  const list = entries(...jobs);
  list[1].approval = 'not-the-id';
  assert.equal(batch(s, 'approve-batch', list, { pin: PIN }), null);
  assert.equal(jobs[1].status, 'awaiting-approval');
  assert.equal(jobs[1].approvalNote.reason, 'mismatch');
  assert.ok(jobs[0].approvedByPin && jobs[2].approvedByPin);
  assert.match(s.system(), /Approval for "Full 2" was refused: Approval does not match this job\./);
  assert.ok(s.audit().some((l) => l.jobId === jobs[1].id && l.outcome === 'refused:mismatch'));
});

test('approve-batch: a tampered job or a changed operation is refused, the rest proceed', async () => {
  const s = setup();
  const [a, b, c] = await s.propose([
    { mode: 'full', folder: s.proj, agent: 'claude', prompt: 'a' }, { mode: 'full', folder: s.proj, agent: 'claude', prompt: 'b' },
    { mode: 'ops', op: 'echo-ok', title: 'Echo' }]);
  b.prompt = 'tampered';
  fs.writeFileSync(path.join(s.state, 'ops.json'), JSON.stringify({ operations: [{ name: 'echo-ok', cwd: s.proj, command: process.execPath, args: ['-e', 'console.log(2)'] }] }));
  assert.equal(batch(s, 'approve-batch', entries(a, b, c), { pin: PIN }), null);
  assert.ok(a.approvedByPin);
  assert.equal(b.approvalNote.reason, 'mismatch');
  assert.equal(c.status, 'awaiting-approval');
  assert.equal(c.approvalNote.reason, 'mismatch');
  assert.deepEqual(s.audit().map((l) => l.outcome).filter((o) => o !== 'started').sort(), ['approved-batch', 'refused:changed', 'refused:mismatch']);
});

test('approve-batch: replaying the same command id is rejected before it reaches the PIN', async () => {
  const s = setup();
  const jobs = await threeFull(s);
  const c = s.cmd('approve-batch', { jobs: entries(...jobs), pin: '000000' });
  assert.ok(s.hub.handle(c));
  assert.equal(s.hub.handle(c), 'replayed');
  assert.equal(s.policy.pinFailures.length, 1);
});

test('approve-batch: mixed ops and full keep per-job binding and run as their own mode', async () => {
  const s = setup();
  const [f, o] = await s.propose([{ mode: 'full', folder: s.proj, agent: 'claude', prompt: 'x' }, { mode: 'ops', op: 'echo-ok', title: 'Echo' }]);
  assert.notEqual(f.approvalId, o.approvalId);
  assert.equal(batch(s, 'approve-batch', [{ job: f.id, approval: o.approvalId }, { job: o.id, approval: o.approvalId }], { pin: PIN }), null);
  assert.equal(f.status, 'awaiting-approval', "another job's approval id does not authorize this one");
  assert.equal(o.approvedByPin, true);
  assert.equal(batch(s, 'approve-batch', entries(f), { pin: PIN }), null);
  await s.flush();
  assert.equal(s.runs.length, 1);
  assert.equal(s.runs[0].role, 'full');
  assert.equal(s.ops.length, 1);
});

test('approve-batch: unknown or already-approved jobs are refused without a PIN attempt', async () => {
  const s = setup();
  const [a] = await s.propose([{ mode: 'full', folder: s.proj, agent: 'claude', prompt: 'x' }]);
  assert.equal(batch(s, 'approve-batch', [{ job: 'ghost', approval: 'x' }], { pin: '000000' }), 'Job is not awaiting approval.');
  assert.equal(s.policy.pinFailures.length, 0);
  assert.equal(batch(s, 'approve-batch', [{ job: 'ghost', approval: 'x' }, ...entries(a)], { pin: PIN }), null);
  assert.ok(a.approvedByPin);
  assert.equal(batch(s, 'approve-batch', entries(a), { pin: '000000' }), 'Job is not awaiting approval.');
  assert.equal(s.policy.pinFailures.length, 0);
});

test('deny-batch only affects matching jobs and audits each with a shared batchId', async () => {
  const s = setup();
  const jobs = await threeFull(s);
  const list = entries(...jobs);
  list[2].approval = 'wrong';
  assert.equal(batch(s, 'deny-batch', [...list, { job: 'ghost', approval: 'x' }]), null);
  assert.deepEqual(jobs.map((j) => j.status), ['denied', 'denied', 'awaiting-approval']);
  const lines = s.audit().filter((l) => l.outcome === 'denied');
  assert.equal(lines.length, 2);
  assert.equal(new Set(lines.map((l) => l.batchId)).size, 1);
  assert.equal(batch(s, 'deny-batch', [list[2]]), 'nothing denied');
  assert.equal(s.policy.pinFailures.length, 0);
});

test('single approve and deny are unchanged and carry no batchId', async () => {
  const s = setup();
  const [a, b] = await s.propose([{ mode: 'full', folder: s.proj, agent: 'claude', prompt: 'a' }, { mode: 'full', folder: s.proj, agent: 'claude', prompt: 'b' }]);
  assert.equal(approveOne(s, a, PIN), null);
  assert.equal(s.hub.handle(s.cmd('deny', { job: b.id, approval: b.approvalId })), null);
  assert.equal(b.status, 'denied');
  assert.ok(s.audit().every((l) => !('batchId' in l)));
});
