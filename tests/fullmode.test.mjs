import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ChatHub } from '../collector/lib/chat.mjs';
import { FullModePolicy, APPROVAL_MS, createPinHash, ensureOps, normalizeMode } from '../collector/lib/fullmode.mjs';
import { LimitTracker } from '../collector/lib/limits.mjs';
import { claudeArgs, codexArgs, FULL_DISALLOWED, NO_PUSH_RULE, pushWatcher, truncateOutput } from '../collector/lib/runner.mjs';

const PIN = '123456';
const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// A throwaway Work folder, state dir and clock. Nothing here touches ~/.ada-viewer or any CLI.
function setup({ withPin = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ada-fullmode-'));
  const work = path.join(root, 'work');
  const proj = path.join(work, 'proj');
  const state = path.join(root, 'state');
  fs.mkdirSync(proj, { recursive: true });
  fs.mkdirSync(state, { recursive: true });
  if (withPin) fs.writeFileSync(path.join(state, 'config.json'), JSON.stringify({ fullModePin: createPinHash(PIN) }));
  fs.writeFileSync(path.join(state, 'ops.json'), JSON.stringify({ operations: [
    { name: 'echo-ok', cwd: proj, command: process.execPath, args: ['-e', 'console.log(1)'] },
    { name: 'placeholder', cwd: proj, command: '', args: [] },
  ] }));

  const clock = { t: Date.now(), now: () => clock.t };
  const runs = [];       // non-head runAgent calls
  const ops = [];        // runOperation calls
  const killed = [];
  const finishers = [];  // resolve a started job
  let reply = 'noted';
  const child = () => ({ kill() {}, pid: 1 });
  const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); finishers.push(resolve); return promise; };
  const services = {
    now: clock.now,
    limits: new LimitTracker({ now: clock.now }),
    appendTaskEvent: () => {},
    killProcessTree: (c) => killed.push(c),
    runAgent(o) {
      if (o.role === 'head') { const text = reply; reply = 'noted'; return { child: child(), done: Promise.resolve({ ok: true, text, session: 'head1' }) }; }
      runs.push(o);
      return { child: child(), done: deferred() };
    },
    runOperation(op) { ops.push(op); return { child: child(), done: deferred() }; },
  };
  services.policy = new FullModePolicy({ stateDir: state, workRoot: work, hardRoot: work, projects: () => [], now: clock.now });
  const hub = new ChatHub({ workRoot: work, projects: () => [], stateDir: state, services });

  let n = 0;
  const flush = async () => { for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r)); };
  const cmd = (type, extra = {}) => ({ kind: 'cmd', id: `c${++n}`, ts: clock.now(), type, ...extra });
  const propose = async (specs) => {
    reply = `On it.\n<jobs>${JSON.stringify(specs)}</jobs>`;
    assert.equal(hub.handle(cmd('say', { text: 'do it' })), null);
    await flush();
    return hub.state.jobs;
  };
  const audit = () => {
    try { return fs.readFileSync(path.join(state, 'fullmode-audit.log'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); }
    catch { return []; }
  };
  const system = () => hub.state.thread.messages.filter((m) => m.role === 'system').map((m) => m.text).join('\n');
  return { root, work, proj, state, clock, runs, ops, killed, finishers, hub, propose, cmd, audit, system, flush, policy: services.policy };
}

test('mode defaults to safe when missing or unknown', async () => {
  assert.deepEqual([undefined, null, '', 'bogus', 'FULL', 'safe', 'ops', 'full'].map(normalizeMode),
    ['safe', 'safe', 'safe', 'safe', 'safe', 'safe', 'ops', 'full']);
  const s = setup();
  const jobs = await s.propose([{ folder: s.proj, prompt: 'a' }, { mode: 'bogus', folder: s.proj, prompt: 'b' }, { mode: 'safe', folder: s.proj, prompt: 'c' }]);
  assert.equal(jobs.length, 3);
  assert.deepEqual(jobs.map((j) => j.mode), ['safe', 'safe', 'safe']);
  assert.ok(jobs.every((j) => j.status !== 'awaiting-approval'));
  assert.ok(s.runs.length > 0 && s.runs.every((r) => r.role === 'worker'));
  assert.deepEqual(s.audit(), [], 'safe jobs are not written to the full-mode audit log');
});

test('ops and full jobs never auto-start: they wait for approval', async () => {
  const s = setup();
  const jobs = await s.propose([{ mode: 'full', folder: s.proj, agent: 'codex', title: 'Install deps', prompt: 'npm install' }, { mode: 'ops', op: 'echo-ok', title: 'Echo' }]);
  assert.deepEqual(jobs.map((j) => [j.mode, j.status]), [['full', 'awaiting-approval'], ['ops', 'awaiting-approval']]);
  assert.equal(jobs[0].approvalExpiresAt, s.clock.t + APPROVAL_MS);
  assert.equal(s.runs.length, 0);
  assert.equal(s.ops.length, 0);
  const shown = s.hub.view().jobs;
  assert.equal(s.hub.view().fullModePinSet, true);
  assert.ok(shown.every((j) => !('approvalDigest' in j) && !('approvedPinVersion' in j)));
  assert.equal(shown[0].prompt, 'npm install');
});

test('ops/full jobs are refused with a clear message until a PIN is set', async () => {
  const s = setup({ withPin: false });
  const jobs = await s.propose([{ mode: 'full', folder: s.proj, prompt: 'x' }, { mode: 'ops', op: 'echo-ok', folder: s.proj }]);
  assert.equal(jobs.length, 0);
  assert.match(s.system(), /Approval PIN not set\. Run node tools\/set-fullmode-pin\.mjs/);
  assert.equal(s.hub.view().fullModePinSet, false);
});

test('unknown and placeholder operations are rejected', async () => {
  const s = setup();
  const jobs = await s.propose([{ mode: 'ops', op: 'rm-everything', folder: s.proj }, { mode: 'ops', op: 'placeholder', folder: s.proj }]);
  assert.equal(jobs.length, 0);
  assert.match(s.system(), /Unknown or duplicate operation: rm-everything/);
  assert.match(s.system(), /placeholder/);
  assert.equal(s.ops.length, 0);
  assert.throws(() => s.policy.resolveOperation('nope'), /Unknown or duplicate operation/);
});

test('a job folder outside the allowed root is rejected for full mode', async () => {
  const s = setup();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'ada-outside-'));
  const jobs = await s.propose([{ mode: 'full', folder: outside, prompt: 'x' }]);
  assert.equal(jobs.length, 0);
  assert.match(s.system(), /not a folder inside/);
  const job = { id: 'x', mode: 'full', folder: outside, prompt: 'x' };
  assert.match(s.policy.prepare(job), /inside/);
});

test('a wrong PIN is rejected and the job keeps waiting', async () => {
  const s = setup();
  const [job] = await s.propose([{ mode: 'full', folder: s.proj, agent: 'claude', prompt: 'x' }]);
  const why = s.hub.handle(s.cmd('approve', { job: job.id, approval: job.approvalId, pin: '000000' }));
  assert.equal(why, 'Incorrect approval PIN.');
  assert.equal(job.status, 'awaiting-approval');
  assert.equal(s.runs.length, 0);
  assert.equal(s.hub.handle(s.cmd('approve', { job: job.id, approval: job.approvalId })), 'Incorrect approval PIN.');
  assert.equal(s.hub.handle(s.cmd('approve', { job: job.id, approval: job.approvalId, pin: 123456 })), 'Incorrect approval PIN.');
});

test('too many wrong PINs lock approvals even for the right PIN', async () => {
  const s = setup();
  const [job] = await s.propose([{ mode: 'full', folder: s.proj, agent: 'claude', prompt: 'x' }]);
  for (let i = 0; i < 5; i++) s.hub.handle(s.cmd('approve', { job: job.id, approval: job.approvalId, pin: '000000' }));
  assert.match(s.hub.handle(s.cmd('approve', { job: job.id, approval: job.approvalId, pin: PIN })), /Too many incorrect PIN attempts/);
  assert.equal(job.status, 'awaiting-approval');
});

test('approval is bound to one job id and its own approval challenge', async () => {
  const s = setup();
  const [a, b] = await s.propose([
    { mode: 'full', folder: s.proj, agent: 'claude', title: 'A', prompt: 'a' },
    { mode: 'full', folder: s.proj, agent: 'codex', title: 'B', prompt: 'b' },
  ]);
  assert.notEqual(a.approvalId, b.approvalId);
  // The right PIN with B's challenge on A's id, or an unknown id, approves nothing.
  assert.equal(s.hub.handle(s.cmd('approve', { job: a.id, approval: b.approvalId, pin: PIN })), 'Approval does not match this job.');
  assert.equal(s.hub.handle(s.cmd('approve', { job: 'unknown', approval: a.approvalId, pin: PIN })), 'Job is not awaiting approval.');
  assert.equal(s.runs.length, 0);
  assert.equal(a.status, 'awaiting-approval');
  assert.equal(b.status, 'awaiting-approval');
  // Approving A starts only A.
  assert.equal(s.hub.handle(s.cmd('approve', { job: a.id, approval: a.approvalId, pin: PIN })), null);
  assert.equal(a.status, 'running');
  assert.equal(b.status, 'awaiting-approval');
  assert.equal(s.runs.length, 1);
  assert.equal(s.runs[0].role, 'full');
  assert.equal(s.runs[0].agent, 'claude');
  assert.equal(s.runs[0].resume, null);
  assert.equal(s.runs[0].cwd.toLowerCase(), fs.realpathSync(s.proj).toLowerCase());
});

test('an approved job cannot have its prompt edited afterwards', async () => {
  const s = setup();
  const [job] = await s.propose([{ mode: 'full', folder: s.proj, agent: 'claude', prompt: 'harmless' }]);
  job.prompt = 'something else';
  assert.match(s.hub.handle(s.cmd('approve', { job: job.id, approval: job.approvalId, pin: PIN })), /changed/);
  assert.equal(s.runs.length, 0);
});

test('approval expires after five minutes, and is reported to chat and the audit log', async () => {
  const s = setup();
  const [job] = await s.propose([{ mode: 'full', folder: s.proj, agent: 'claude', title: 'Late', prompt: 'x' }]);
  s.clock.t += APPROVAL_MS - 1000;
  assert.equal(s.policy.expired(job), false);
  s.clock.t += 1001;
  assert.equal(s.policy.expired(job), true);
  // Even the right PIN, sent after the window, starts nothing.
  assert.equal(s.hub.handle(s.cmd('approve', { job: job.id, approval: job.approvalId, pin: PIN })), 'Job is not awaiting approval.');
  assert.equal(job.status, 'expired');
  assert.equal(s.runs.length, 0);
  assert.match(s.system(), /FULL job "Late": Approval expired/);
  const [line, ...rest] = s.audit();
  assert.equal(rest.length, 0);
  assert.equal(line.outcome, 'expired');
  assert.equal(line.approvedByPin, 'no');
});

test('deny needs the matching approval challenge and is reported', async () => {
  const s = setup();
  const [job] = await s.propose([{ mode: 'ops', op: 'echo-ok', title: 'Echo' }]);
  assert.equal(s.hub.handle(s.cmd('deny', { job: job.id, approval: 'wrong' })), 'approval does not match this job');
  assert.equal(job.status, 'awaiting-approval');
  assert.equal(s.hub.handle(s.cmd('deny', { job: job.id, approval: job.approvalId })), null);
  assert.equal(job.status, 'denied');
  assert.equal(s.ops.length, 0);
  assert.match(s.system(), /Nefer denied this job/);
  assert.equal(s.audit().at(-1).outcome, 'denied');
});

test('an approved ops job runs the allowlisted command and writes audit lines', async () => {
  const s = setup();
  const [job] = await s.propose([{ mode: 'ops', op: 'echo-ok', title: 'Echo' }]);
  assert.equal(job.folder.toLowerCase(), fs.realpathSync(s.proj).toLowerCase(), 'folder defaults to the operation cwd');
  assert.equal(s.hub.handle(s.cmd('approve', { job: job.id, approval: job.approvalId, pin: PIN })), null);
  assert.equal(s.ops.length, 1);
  assert.equal(s.ops[0].command, process.execPath);
  assert.deepEqual(s.ops[0].args, ['-e', 'console.log(1)']);
  s.finishers.shift()({ ok: true, text: '1', code: 0 });
  await s.flush();
  assert.equal(job.status, 'done');
  const lines = s.audit();
  assert.deepEqual(lines.map((l) => l.outcome), ['started', 'done']);
  const last = lines.at(-1);
  assert.equal(last.jobId, job.id);
  assert.equal(last.mode, 'ops');
  assert.equal(last.agent, 'collector');
  assert.equal(last.title, 'Echo');
  assert.equal(last.approvedByPin, 'yes');
  assert.equal(last.folder.toLowerCase(), fs.realpathSync(s.proj).toLowerCase());
  assert.ok(!Number.isNaN(Date.parse(last.time)));
});

test('kill stops a running full job, reports it and audits it', async () => {
  const s = setup();
  const [job] = await s.propose([{ mode: 'full', folder: s.proj, agent: 'codex', title: 'Long', prompt: 'x' }]);
  assert.equal(s.hub.handle(s.cmd('kill', { job: job.id })), 'not a running ops/full job');
  s.hub.handle(s.cmd('approve', { job: job.id, approval: job.approvalId, pin: PIN }));
  assert.equal(job.status, 'running');
  assert.equal(s.hub.handle(s.cmd('kill', { job: job.id })), null);
  assert.equal(s.killed.length, 1);
  assert.equal(job.status, 'failed');
  assert.match(job.result, /Killed by Nefer/);
  assert.equal(s.audit().at(-1).outcome, 'killed');
});

test('kill refuses safe jobs, and the same command id cannot be replayed', async () => {
  const s = setup();
  const [job] = await s.propose([{ folder: s.proj, prompt: 'x' }]);
  assert.equal(s.hub.handle(s.cmd('kill', { job: job.id })), 'not a running ops/full job');
  const c = s.cmd('approve', { job: 'nope', approval: 'x', pin: '000000' });
  s.hub.handle(c);
  assert.equal(s.hub.handle(c), 'replayed');
  assert.equal(s.hub.handle({ ...s.cmd('approve'), ts: s.clock.t - 60 * 60e3 }), 'stale');
});

test('a collector restart fails jobs that were waiting or running instead of resuming them', async () => {
  const s = setup();
  const [job] = await s.propose([{ mode: 'full', folder: s.proj, agent: 'claude', prompt: 'x' }]);
  const again = new ChatHub({ workRoot: s.work, projects: () => [], stateDir: s.state, services: { now: s.clock.now, policy: s.policy, limits: new LimitTracker(), appendTaskEvent: () => {}, runAgent: () => { throw new Error('no run expected'); } } });
  const restored = again.state.jobs.find((j) => j.id === job.id);
  assert.equal(restored.status, 'failed');
  assert.match(restored.result, /collector restarted/);
  assert.equal(s.audit().at(-1).outcome, 'collector-restarted');
});

test('the default ops file is created when absent and never overwritten', () => {
  if (process.platform === 'win32' && !APP_ROOT.toLowerCase().startsWith('c:\\work')) return; // default ops need this checkout inside C:\Work
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ada-ops-'));
  const names = ensureOps({ stateDir: dir, workRoot: APP_ROOT }).map((o) => o.name);
  assert.ok(names.includes('restart-collector') && names.includes('git-status') && names.includes('dev-server'));
  const file = path.join(dir, 'ops.json');
  const custom = JSON.stringify({ operations: [{ name: 'mine', cwd: APP_ROOT, command: 'x', args: [] }] });
  fs.writeFileSync(file, custom);
  assert.deepEqual(ensureOps({ stateDir: dir, workRoot: APP_ROOT }).map((o) => o.name), ['mine']);
  assert.equal(fs.readFileSync(file, 'utf8'), custom);
});

// ---- runner arguments ----

test('safe-mode Claude arguments are unchanged for roles worker and head', () => {
  const base = ['-p', '--output-format', 'json', '--setting-sources', 'project', '--permission-prompts', 'none'];
  assert.deepEqual(claudeArgs({ role: 'worker' }), [...base, '--permission-mode', 'acceptEdits']);
  assert.deepEqual(claudeArgs({ role: 'head' }), [...base, '--permission-mode', 'default', '--disallowedTools', 'Edit', 'Write', 'NotebookEdit', 'Bash', 'PowerShell']);
  assert.deepEqual(
    claudeArgs({ role: 'worker', model: 'opus', resume: 'r1', systemFile: 'sys.md', addDirs: ['d1', 'd2'] }),
    [...base, '--permission-mode', 'acceptEdits', '--model', 'opus', '--resume', 'r1', '--append-system-prompt-file', 'sys.md', '--add-dir', 'd1', 'd2'],
  );
  assert.deepEqual(
    claudeArgs({ role: 'head', model: 'sonnet', addDirs: ['g'] }),
    [...base, '--permission-mode', 'default', '--disallowedTools', 'Edit', 'Write', 'NotebookEdit', 'Bash', 'PowerShell', '--model', 'sonnet', '--add-dir', 'g'],
  );
});

test('safe-mode Codex arguments are unchanged for roles worker and head', () => {
  assert.deepEqual(codexArgs({ role: 'worker', cwd: 'C:\\w', lastMsg: 'l.txt' }), ['exec', '--skip-git-repo-check', '-o', 'l.txt', '-C', 'C:\\w', '-s', 'workspace-write', '-']);
  assert.deepEqual(codexArgs({ role: 'head', cwd: 'C:\\w', lastMsg: 'l.txt', model: 'm' }), ['exec', '--skip-git-repo-check', '-o', 'l.txt', '-m', 'm', '-C', 'C:\\w', '-s', 'read-only', '-']);
  assert.deepEqual(codexArgs({ role: 'worker', cwd: 'C:\\w', lastMsg: 'l.txt', resume: 'sid' }), ['exec', 'resume', '--skip-git-repo-check', '-o', 'l.txt', '-c', 'sandbox_mode="workspace-write"', 'sid', '-']);
  assert.deepEqual(codexArgs({ role: 'head', cwd: 'C:\\w', lastMsg: 'l.txt', resume: 'sid' }), ['exec', 'resume', '--skip-git-repo-check', '-o', 'l.txt', '-c', 'sandbox_mode="read-only"', 'sid', '-']);
});

test('full-mode Claude keeps project-only settings and always denies push and deploy patterns', () => {
  const a = claudeArgs({ role: 'full', model: 'opus' });
  assert.deepEqual(a.slice(0, 7), ['-p', '--output-format', 'json', '--setting-sources', 'project', '--permission-prompts', 'none']);
  assert.ok(a.includes('bypassPermissions'));
  const i = a.indexOf('--disallowedTools');
  assert.ok(i > 0);
  const denied = a.slice(i + 1, i + 1 + FULL_DISALLOWED.length);
  assert.deepEqual(denied, FULL_DISALLOWED);
  for (const rule of ['Bash(git push:*)', 'PowerShell(git push:*)', 'Bash(npm publish:*)', 'Bash(wrangler deploy:*)', 'Bash(vercel:*)']) {
    assert.ok(a.includes(rule), rule);
  }
  assert.deepEqual(a.slice(i + 1 + FULL_DISALLOWED.length), ['--model', 'opus']);
  // No safe-mode argument list contains the full-mode permission bypass.
  assert.ok(!claudeArgs({ role: 'worker' }).includes('bypassPermissions'));
  assert.ok(!claudeArgs({ role: 'head' }).includes('bypassPermissions'));
});

test('full-mode Codex uses danger-full-access and the prompt carries the no-push rule', () => {
  assert.deepEqual(codexArgs({ role: 'full', cwd: 'C:\\w', lastMsg: 'l.txt' }), ['exec', '--skip-git-repo-check', '-o', 'l.txt', '-C', 'C:\\w', '-s', 'danger-full-access', '-']);
  assert.match(NO_PUSH_RULE, /never push/);
  assert.match(NO_PUSH_RULE, /deploy/);
});

test('the push watcher fires on a push or deploy command, not on the echoed prompt', () => {
  const prompt = `${NO_PUSH_RULE}\n\nPlease do not run git push, ever.`;
  const hits = [];
  const feed = pushWatcher(prompt, (line) => hits.push(line));
  feed(`${NO_PUSH_RULE}\n\nPlease do not run git push, ever.\n`);
  feed('exec\npowershell -Command "git sta');
  feed('tus" in C:\\Work\\proj\n');
  assert.deepEqual(hits, []);
  feed('exec\nbash -lc "git -C repo push origin main" in C:\\Work\\proj\n');
  assert.equal(hits.length, 1);
  feed('npm publish\n');
  assert.equal(hits.length, 1, 'fires once');
  const second = [];
  pushWatcher('', (l) => second.push(l))('wrangler deploy\n');
  assert.equal(second.length, 1);
});

test('operation output is truncated to about 8 KB', () => {
  assert.equal(truncateOutput('short'), 'short');
  const big = truncateOutput('x'.repeat(20000));
  assert.ok(big.length < 8300);
  assert.match(big, /truncated at 8 KB/);
});
