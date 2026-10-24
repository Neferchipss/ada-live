// Reads Claude Code session logs (~/.claude/projects/<dir>/<session>.jsonl)
// and turns each recent session into: title, folder, status, current step, last words.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { tailLines, parseJsonLines, clip, ms, safeReaddir } from './util.mjs';
import { claudeContext } from './context.mjs';

const ROOT = path.join(os.homedir(), '.claude', 'projects');

const RECENT_MS = 48 * 3600e3;     // sessions shown at all
const WORKING_MS = 3 * 60e3;       // a fresh tool result / prompt means the model is on it
const TOOL_STALL_MS = 2 * 60e3;    // tool call with no result for this long -> blocked?
const ASLEEP_MS = 30 * 60e3;

function describeTool(name, input = {}) {
  const base = (p) => (p ? path.basename(String(p)) : '');
  switch (name) {
    case 'Bash':
    case 'PowerShell':
      return input.description || clip(input.command, 90);
    case 'Read': return `Reading ${base(input.file_path)}`;
    case 'Edit': return `Editing ${base(input.file_path)}`;
    case 'Write': return `Writing ${base(input.file_path)}`;
    case 'Grep': return `Searching for "${clip(input.pattern, 50)}"`;
    case 'Glob': return `Finding ${clip(input.pattern, 50)}`;
    case 'Agent': return `Sub-agent: ${input.description || 'task'}`;
    case 'WebSearch': return `Searching the web: ${clip(input.query, 70)}`;
    case 'WebFetch': return `Fetching ${clip(input.url, 70)}`;
    case 'Skill': return `Using skill ${input.skill}`;
    case 'Artifact': return 'Publishing an artifact';
    case 'TodoWrite': return 'Updating the task list';
    default:
      if (name?.startsWith('mcp__')) {
        const parts = name.split('__');
        return `${parts[1].replace(/^claude_ai_|^claude-in-/, '')}: ${parts.slice(2).join(' ').replace(/_/g, ' ')}`;
      }
      return name || 'tool';
  }
}

function parseSession(file) {
  const st = fs.statSync(file);
  const entries = parseJsonLines(tailLines(file));
  const s = {
    agent: 'claude',
    id: path.basename(file, '.jsonl'),
    title: '',
    cwd: '',
    model: '',
    lastPrompt: '',
    steps: [],        // recent tool steps / replies, oldest -> newest
    status: 'idle',
    statusNote: '',
    step: '',
    thought: '',
    lastActivity: st.mtimeMs,
    startedAt: st.birthtimeMs || 0,
    remote: false,
  };
  const pending = new Map();  // tool_use id -> step
  let last = null;            // last conversational event

  for (const e of entries) {
    if (e.cwd) s.cwd = e.cwd;
    switch (e.type) {
      case 'ai-title': s.title = e.aiTitle || s.title; break;
      case 'last-prompt': s.lastPrompt = clip(e.lastPrompt, 160); break;
      case 'bridge-session': s.remote = true; break;
      case 'assistant': {
        if (e.isSidechain) break;
        const m = e.message || {};
        if (m.model) s.model = m.model;
        const t = ms(e.timestamp);
        for (const b of m.content || []) {
          if (b.type === 'text' && b.text?.trim()) {
            s.thought = clip(b.text, 260);
            s.steps.push({ t, kind: 'say', text: clip(b.text, 140) });
            last = { kind: 'say', t, stop: m.stop_reason };
          } else if (b.type === 'tool_use') {
            const step = { t, kind: 'tool', tool: b.name, text: describeTool(b.name, b.input) };
            s.steps.push(step);
            pending.set(b.id, step);
            last = { kind: 'tool', t, step, id: b.id };
          }
        }
        break;
      }
      case 'user': {
        if (e.isSidechain || e.isMeta) break;
        const c = e.message?.content;
        const t = ms(e.timestamp);
        if (Array.isArray(c) && c.some((b) => b.type === 'tool_result')) {
          for (const b of c) if (b.type === 'tool_result') {
            const step = pending.get(b.tool_use_id);
            if (step) { step.done = t; if (b.is_error) step.error = true; pending.delete(b.tool_use_id); }
          }
          last = { kind: 'result', t };
        } else {
          const text = typeof c === 'string' ? c : (c || []).map((b) => b.text || '').join(' ');
          if (text && !text.startsWith('<')) {
            s.steps.push({ t, kind: 'prompt', text: clip(text, 140) });
            if (!s.firstPrompt) s.firstPrompt = clip(text, 160);
            last = { kind: 'prompt', t };
          }
        }
        break;
      }
    }
  }

  const now = Date.now();
  const age = now - s.lastActivity;
  const openTool = last?.kind === 'tool' && pending.has(last.id);
  const lastTool = [...s.steps].reverse().find((x) => x.kind === 'tool');
  s.step = lastTool?.text || '';

  if (age > ASLEEP_MS) {
    s.status = 'idle'; s.statusNote = 'asleep';
  } else if (openTool) {
    if (age < TOOL_STALL_MS) { s.status = 'working'; s.statusNote = 'running a tool'; }
    else { s.status = 'blocked'; s.statusNote = 'waiting on a permission or a long tool'; }
  } else if ((last?.kind === 'result' || last?.kind === 'prompt') && age < WORKING_MS) {
    s.status = 'working'; s.statusNote = 'thinking';
  } else if (last?.kind === 'say' && last.stop === 'end_turn') {
    s.status = 'idle'; s.statusNote = 'replied, waiting for you';
  } else if (age < WORKING_MS) {
    s.status = 'working'; s.statusNote = 'active';
  } else {
    s.status = 'idle'; s.statusNote = 'quiet';
  }

  s.steps = s.steps.slice(-25);
  const context = claudeContext(entries, s.model);
  if (context) s.context = context;
  if (!s.title) s.title = s.lastPrompt || path.basename(s.cwd || '') || 'Claude session';
  return s;
}

/** Context usage of one session by id (Ada's own head turns), or null when its transcript is not found. */
export function claudeSessionContext(id) {
  if (!/^[\w-]{8,64}$/.test(String(id || ''))) return null;
  for (const d of safeReaddir(ROOT)) {
    if (!d.isDirectory()) continue;
    const file = path.join(ROOT, d.name, `${id}.jsonl`);
    if (fs.existsSync(file)) return claudeContext(parseJsonLines(tailLines(file)));
  }
  return null;
}

export function collectClaude() {
  const now = Date.now();
  const sessions = [];
  for (const d of safeReaddir(ROOT)) {
    if (!d.isDirectory()) continue;
    const dir = path.join(ROOT, d.name);
    for (const f of safeReaddir(dir)) {
      if (!f.isFile() || !f.name.endsWith('.jsonl')) continue;
      const file = path.join(dir, f.name);
      let st;
      try { st = fs.statSync(file); } catch { continue; }
      if (now - st.mtimeMs > RECENT_MS) continue;
      try { sessions.push(parseSession(file)); } catch { /* unreadable session */ }
    }
  }
  sessions.sort((a, b) => b.lastActivity - a.lastActivity);
  return sessions;
}
