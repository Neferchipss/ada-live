import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ChatHub } from '../../collector/lib/chat.mjs';
import { FullModePolicy, createPinHash } from '../../collector/lib/fullmode.mjs';
import { LimitTracker } from '../../collector/lib/limits.mjs';

export const PIN = '123456';

// A throwaway Work folder, state dir and clock. Nothing here touches ~/.ada-viewer or any CLI.
export function setup({ withPin = true } = {}) {
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
