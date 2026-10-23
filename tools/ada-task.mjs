#!/usr/bin/env node
// Log a delegated task so it shows on the viewer.
//   node tools/ada-task.mjs start --agent codex --title "Hero texture" [--cwd DIR]   -> prints task id
//   node tools/ada-task.mjs update <id> --preview "halfway"
//   node tools/ada-task.mjs done <id> [--preview "..."] [--output path ...]
//   node tools/ada-task.mjs fail <id> --preview "why"
import crypto from 'node:crypto';
import { appendTaskEvent } from '../collector/lib/tasks.mjs';

const [cmd, ...rest] = process.argv.slice(2);
const opts = { outputs: [] };
let id = null;
for (let i = 0; i < rest.length; i++) {
  const a = rest[i];
  if (a.startsWith('--')) {
    const k = a.slice(2), v = rest[++i];
    if (k === 'output') opts.outputs.push({ path: v });
    else opts[k] = v;
  } else id = a;
}

const statusFor = { start: 'running', queue: 'queued', update: undefined, done: 'done', fail: 'failed' };
if (!(cmd in statusFor)) {
  console.error('usage: ada-task.mjs start|queue|update|done|fail [id] [--agent --title --cwd --preview --output]');
  process.exit(1);
}
if (cmd === 'start' || cmd === 'queue') id = crypto.randomBytes(4).toString('hex');
if (!id) { console.error('task id required'); process.exit(1); }

const ev = { id };
if (statusFor[cmd]) ev.status = statusFor[cmd];
for (const k of ['agent', 'title', 'cwd', 'preview']) if (opts[k]) ev[k] = opts[k];
if (opts.outputs.length) ev.outputs = opts.outputs;
appendTaskEvent(ev);
console.log(id);
