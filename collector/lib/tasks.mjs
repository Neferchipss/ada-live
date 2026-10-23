// Delegated-task log. tools/ada-task.mjs and tools/delegate.mjs append events here;
// the collector folds them into one record per task.
import fs from 'node:fs';
import path from 'node:path';
import { STATE_DIR } from './config.mjs';

export const TASKS_FILE = path.join(STATE_DIR, 'tasks.jsonl');

export function appendTaskEvent(ev) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.appendFileSync(TASKS_FILE, JSON.stringify({ t: Date.now(), ...ev }) + '\n');
}

export function collectTasks(limit = 40) {
  let text = '';
  try { text = fs.readFileSync(TASKS_FILE, 'utf8'); } catch { return []; }
  const tasks = new Map();
  for (const l of text.split('\n')) {
    if (!l) continue;
    let e;
    try { e = JSON.parse(l); } catch { continue; }
    const cur = tasks.get(e.id) || { id: e.id, createdAt: e.t, outputs: [] };
    if (e.outputs) cur.outputs = [...cur.outputs, ...e.outputs];
    const { outputs, ...rest } = e;
    Object.assign(cur, rest, { updatedAt: e.t });
    if (e.status === 'running' && !cur.startedAt) cur.startedAt = e.t;
    if (e.status === 'done' || e.status === 'failed') cur.endedAt = e.t;
    tasks.set(e.id, cur);
  }
  return [...tasks.values()].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, limit);
}
