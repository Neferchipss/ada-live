// Reads Codex session rollouts (~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl[.zst])
// plus the images Codex generated (~/.codex/generated_images/<thread>/).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { parseJsonLines, clip, ms, safeReaddir, safeStat } from './util.mjs';

const HOME = path.join(os.homedir(), '.codex');
const RECENT_MS = 48 * 3600e3;
const WORKING_MS = 10 * 60e3;
const cache = new Map(); // rollout path -> { mtime, s }

function readRollout(file) {
  const buf = fs.readFileSync(file);
  if (file.endsWith('.zst')) {
    try { return zlib.zstdDecompressSync(buf).toString('utf8'); } catch { return ''; }
  }
  return buf.toString('utf8');
}

function threadNames() {
  const names = new Map();
  try {
    for (const l of fs.readFileSync(path.join(HOME, 'session_index.jsonl'), 'utf8').split('\n')) {
      if (!l) continue;
      try { const o = JSON.parse(l); names.set(o.id, o.thread_name); } catch {}
    }
  } catch {}
  return names;
}

function describeCall(p) {
  const name = p.name || 'tool';
  let args = p.arguments ?? p.input ?? '';
  if (typeof args === 'string') {
    try { args = JSON.parse(args); } catch { /* free-form input */ }
  }
  if (typeof args === 'object' && args) {
    const cmd = args.cmd || args.command;
    if (cmd) return clip(Array.isArray(cmd) ? cmd.join(' ') : cmd, 90);
    if (args.task_name) return `Sub-agent: ${args.task_name}`;
    if (args.prompt) return `${name}: ${clip(args.prompt, 70)}`;
    return name.replace(/_/g, ' ');
  }
  const first = String(args).split('\n')[0];
  return `${name}: ${clip(first, 80)}`;
}

function images(threadId) {
  const dir = path.join(HOME, 'generated_images', threadId);
  return safeReaddir(dir)
    .filter((f) => f.isFile() && /\.(png|jpe?g|webp)$/i.test(f.name))
    .map((f) => {
      const p = path.join(dir, f.name);
      return { name: f.name, path: p, t: safeStat(p)?.mtimeMs || 0 };
    })
    .sort((a, b) => b.t - a.t);
}

function parse(file, names) {
  const entries = parseJsonLines(readRollout(file).split('\n'));
  if (!entries.length) return null;
  const meta = entries.find((e) => e.type === 'session_meta')?.payload || {};
  const s = {
    agent: 'codex',
    id: meta.id || path.basename(file),
    parent: meta.parent_thread_id || null,
    title: names.get(meta.id) || '',
    cwd: meta.cwd || '',
    model: '',
    origin: meta.originator || '',
    steps: [],
    status: 'idle',
    statusNote: '',
    step: '',
    thought: '',
    lastActivity: safeStat(file)?.mtimeMs || 0,
    images: [],
  };
  let open = false;
  for (const e of entries) {
    const p = e.payload || {};
    const t = ms(e.timestamp);
    if (t > s.lastActivity) s.lastActivity = t;
    if (e.type === 'turn_context' && p.model) s.model = p.model;
    if (e.type === 'event_msg') {
      if (p.type === 'task_started') open = true;
      if (p.type === 'task_complete') { open = false; if (p.last_agent_message) s.thought = clip(p.last_agent_message, 260); }
    }
    if (e.type === 'response_item') {
      if (p.type === 'function_call' || p.type === 'custom_tool_call') {
        s.steps.push({ t, kind: 'tool', tool: p.name, text: describeCall(p) });
      } else if (p.type === 'message' && p.role === 'assistant') {
        const text = (p.content || []).map((c) => c.text || '').join(' ');
        if (text.trim()) { s.thought = clip(text, 260); s.steps.push({ t, kind: 'say', text: clip(text, 140) }); }
      } else if (p.type === 'message' && p.role === 'user') {
        const text = (p.content || []).map((c) => c.text || '').join(' ');
        if (text.trim() && !text.trim().startsWith('<')) {
          s.steps.push({ t, kind: 'prompt', text: clip(text, 140) });
          if (!s.title) s.title = clip(text, 60);
        }
      } else if (p.type === 'image_generation_call') {
        s.steps.push({ t, kind: 'tool', tool: 'image', text: 'Generating an image' });
      }
    }
  }
  const age = Date.now() - s.lastActivity;
  if (open && age < WORKING_MS) { s.status = 'working'; s.statusNote = 'on a task'; }
  else if (open) { s.status = 'blocked'; s.statusNote = 'task open but silent'; }
  else { s.status = 'idle'; s.statusNote = 'done'; }
  s.step = [...s.steps].reverse().find((x) => x.kind === 'tool')?.text || '';
  s.steps = s.steps.slice(-25);
  s.images = images(s.id).slice(0, 6);
  if (!s.title) s.title = path.basename(s.cwd || '') || 'Codex session';
  return s;
}

export function collectCodex() {
  const names = threadNames();
  const now = Date.now();
  const files = [];
  // Only walk the day folders that can hold recent sessions.
  for (let d = 0; d < 3; d++) {
    const day = new Date(now - d * 86400e3);
    const dir = path.join(HOME, 'sessions', String(day.getFullYear()),
      String(day.getMonth() + 1).padStart(2, '0'), String(day.getDate()).padStart(2, '0'));
    for (const f of safeReaddir(dir)) {
      if (!f.isFile() || !/^rollout-.*\.jsonl(\.zst)?$/.test(f.name)) continue;
      const p = path.join(dir, f.name);
      const st = safeStat(p);
      if (st && now - st.mtimeMs < RECENT_MS) files.push(p);
    }
  }
  const sessions = [];
  for (const f of files) {
    // Rollouts untouched for 15+ minutes won't change state; reuse the parse (zstd is costly).
    const mtime = safeStat(f)?.mtimeMs || 0;
    const hit = cache.get(f);
    if (hit && hit.mtime === mtime && now - mtime > 15 * 60e3) { if (hit.s) sessions.push(hit.s); continue; }
    try { const s = parse(f, names); cache.set(f, { mtime, s }); if (s) sessions.push(s); } catch {}
  }
  sessions.sort((a, b) => b.lastActivity - a.lastActivity);
  return sessions;
}
