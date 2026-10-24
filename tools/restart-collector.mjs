#!/usr/bin/env node
// The 'restart-collector' ops operation. Run by the collector itself (its parent process):
// it hands off to a detached helper and exits right away, so the job can report back first.
// The helper then stops the collector and starts a fresh one.
//   node tools/restart-collector.mjs            (as the op: restarts its parent collector)
//   node tools/restart-collector.mjs --respawn <pid>   (internal helper)
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(HERE), '..');
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const args = process.argv.slice(2);

if (args[0] === '--respawn') {
  const pid = Number(args[1]);
  if (!Number.isInteger(pid) || pid <= 1) process.exit(1);
  await sleep(2500); // let the job result reach the phone
  try { process.kill(pid); } catch {}
  for (let i = 0; i < 40 && alive(pid); i++) await sleep(250);
  spawn(process.execPath, [path.join(ROOT, 'collector', 'collect.mjs')], { cwd: ROOT, detached: true, stdio: 'ignore', windowsHide: true }).unref();
} else {
  const parent = process.ppid;
  if (!parent || parent <= 1) { console.error('No parent collector to restart.'); process.exit(1); }
  spawn(process.execPath, [HERE, '--respawn', String(parent)], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  console.log('Restart scheduled: the collector stops in about 3 seconds and starts again.');
}
