// Read-only view of one conversation (an Ada worker job or a terminal Claude/Codex session) for the phone.
// The transcript file is found ONLY through claudeSessionFile / codexSessionFile (the session indexes claude.mjs
// and codex.mjs already maintain); the page sends an agent and a session id, never a path. Both formats are
// normalised to { i, t, role, kind, tool?, text }, clipped, redacted, and returned with a cursor.
//
// `i` is stable between polls: byte offset of the source line * 32 + the block's position in that line. A poll
// with `after` re-reads only from that line on, so a long transcript costs the same as a short one.
import fs from 'node:fs';
import zlib from 'node:zlib';
import { ms } from './util.mjs';
import { redact } from './redact.mjs';
import { claudeSessionFile } from './claude.mjs';
import { codexSessionFile } from './codex.mjs';

export const LIMITS = { text: 4000, tool: 200, result: 600, defaultN: 80, maxN: 200 };
const SLOT = 32;                    // blocks per source line
const TAIL_BYTES = 768 * 1024;      // first load reads this much of the end
const MAX_READ = 2 * 1024 * 1024;   // a poll never reads more than this
const HUGE = 2000;                  // results longer than this collapse when they come back to back
const GUARD = 200;                  // extra characters redacted beyond a clip, so a secret on the cut is still seen whole

const str = (v) => (typeof v === 'string' ? v : '');
const keepClip = (s, n) => { s = String(s || '').trim(); return s.length > n ? `${s.slice(0, n - 1)}…` : s; };

// Redact first (on a slightly longer slice), then clip, so a cut can never expose half a secret.
function safeText(s, n, literals, { oneLine = false } = {}) {
  let r = redact(String(s || '').slice(0, n + GUARD), literals);
  if (oneLine) r = r.replace(/\s+/g, ' ');
  return keepClip(r, n);
}

function toolSummary(input, literals) {
  if (typeof input === 'string') return safeText(input, LIMITS.tool, literals, { oneLine: true });
  if (!input || typeof input !== 'object') return '';
  const pick = input.command ?? input.cmd ?? input.description ?? input.file_path ?? input.path ?? input.pattern ?? input.query ?? input.url ?? input.prompt ?? input.skill;
  const v = Array.isArray(pick) ? pick.join(' ') : pick;
  return safeText(typeof v === 'string' ? v : JSON.stringify(input), LIMITS.tool, literals, { oneLine: true });
}

function resultText(c) {
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map((b) => (typeof b === 'string' ? b : b?.type === 'text' ? str(b.text) : b?.type === 'image' ? '[image]' : '')).filter(Boolean).join('\n');
  return c == null ? '' : JSON.stringify(c);
}

const hiddenUserText = (t) => !t.trim() || t.trimStart().startsWith('<') || t.trimStart().startsWith('# AGENTS.md');

/** Claude Code .jsonl line -> entries (without i). */
export function normClaudeLine(e, literals) {
  const out = [];
  if (!e || e.isSidechain || e.isMeta) return out;
  const t = ms(e.timestamp);
  const c = e.message?.content;
  if (e.type === 'assistant') {
    if (e.message?.model === '<synthetic>') return out;
    for (const b of Array.isArray(c) ? c : []) {
      if (b.type === 'text' && str(b.text).trim()) out.push({ t, role: 'assistant', kind: 'text', text: safeText(b.text, LIMITS.text, literals) });
      else if (b.type === 'tool_use') out.push({ t, role: 'assistant', kind: 'tool', tool: str(b.name).slice(0, 60), text: toolSummary(b.input, literals) });
      // thinking / redacted_thinking blocks are deliberately dropped
    }
  } else if (e.type === 'user') {
    if (typeof c === 'string') {
      if (!hiddenUserText(c)) out.push({ t, role: 'user', kind: 'text', text: safeText(c, LIMITS.text, literals) });
      return out;
    }
    for (const b of Array.isArray(c) ? c : []) {
      if (b.type === 'text' && !hiddenUserText(str(b.text))) out.push({ t, role: 'user', kind: 'text', text: safeText(b.text, LIMITS.text, literals) });
      else if (b.type === 'tool_result') {
        const raw = resultText(b.content);
        out.push({ t, role: 'system', kind: 'result', ...(b.is_error ? { error: true } : {}), text: safeText(raw, LIMITS.result, literals), n: raw.length });
      }
    }
  }
  return out;
}

function codexArgs(a, literals) {
  let args = a;
  if (typeof args === 'string') { try { args = JSON.parse(args); } catch { /* free-form input */ } }
  if (args && typeof args === 'object') {
    const cmd = args.cmd ?? args.command;
    return toolSummary(cmd ? { command: Array.isArray(cmd) ? cmd.join(' ') : cmd } : args, literals);
  }
  return toolSummary(String(args || ''), literals);
}

/** Codex rollout line -> entries (without i). Only response_item events carry the conversation. */
export function normCodexLine(e, literals) {
  const out = [];
  if (!e || e.type !== 'response_item') return out;
  const p = e.payload || {};
  const t = ms(e.timestamp);
  if (p.type === 'message' && (p.role === 'user' || p.role === 'assistant')) {
    const text = (p.content || []).map((x) => str(x.text)).join('\n');
    if (p.role === 'user' && hiddenUserText(text)) return out;
    if (text.trim()) out.push({ t, role: p.role, kind: 'text', text: safeText(text, LIMITS.text, literals) });
  } else if (p.type === 'function_call' || p.type === 'custom_tool_call') {
    out.push({ t, role: 'assistant', kind: 'tool', tool: str(p.name).slice(0, 60), text: codexArgs(p.arguments ?? p.input, literals) });
  } else if (p.type === 'function_call_output' || p.type === 'custom_tool_call_output') {
    let raw = p.output;
    if (typeof raw === 'string') { try { const o = JSON.parse(raw); if (o && typeof o === 'object' && 'output' in o) raw = o.output; } catch { /* plain text */ } }
    raw = resultText(raw);
    out.push({ t, role: 'system', kind: 'result', text: safeText(raw, LIMITS.result, literals), n: raw.length });
  }
  // reasoning items are deliberately dropped
  return out;
}

// [{ off, text }] for every line in buf, `base` being the byte offset of buf[0] in the file.
function splitLines(buf, base) {
  const lines = [];
  for (let pos = 0; pos < buf.length;) {
    const nl = buf.indexOf(10, pos);
    const end = nl === -1 ? buf.length : nl;
    lines.push({ off: base + pos, text: buf.toString('utf8', pos, end).replace(/\r$/, '') });
    pos = end + 1;
  }
  return lines;
}

function readWindow(file, agent, after) {
  if (agent === 'codex' && file.endsWith('.zst')) {
    let buf;
    try { buf = zlib.zstdDecompressSync(fs.readFileSync(file)); } catch { return { lines: [], size: 0 }; }
    return { lines: splitLines(buf, 0), size: buf.length };
  }
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const wanted = after >= 0 ? Math.floor(after / SLOT) : Math.max(0, size - TAIL_BYTES);
    let base = Math.max(wanted, size - MAX_READ, 0);
    let buf = Buffer.alloc(size - base);
    fs.readSync(fd, buf, 0, buf.length, base);
    // `wanted` is a line start when it came from a cursor; otherwise (tail read, or the cap moved us) drop the partial first line.
    if (base > 0 && !(after >= 0 && base === wanted)) {
      const nl = buf.indexOf(10);
      if (nl === -1) return { lines: [], size };
      base += nl + 1;
      buf = buf.subarray(nl + 1);
    }
    return { lines: splitLines(buf, base), size };
  } finally { fs.closeSync(fd); }
}

// Back-to-back huge results become one "… N more large results" line, so a burst of dumps cannot bury the conversation.
function collapseHuge(entries) {
  const out = [];
  let prevHuge = false;
  for (const e of entries) {
    const huge = e.kind === 'result' && e.n > HUGE;
    if (huge && prevHuge) {
      const last = out[out.length - 1];
      if (last.merged) { last.merged++; last.i = e.i; } else out.push({ i: e.i, t: e.t, role: 'system', kind: 'result', merged: 1 });
      const m = out[out.length - 1];
      m.text = `… ${m.merged} more large result${m.merged === 1 ? '' : 's'}`;
      continue;
    }
    prevHuge = huge;
    out.push(e);
  }
  return out;
}

/**
 * Normalised, clipped, redacted entries of one session.
 *   agent: 'claude' | 'codex'; sessionId: the id the session lists carry; after: last `i` the page has (omit on first load);
 *   limit: newest N to return. deps (tests / ChatHub): known(agent, id) -> bool, claudeFile, codexFile, literals.
 * Returns { ok, entries, next, more, size, mtime } or { ok:false, err }.
 */
export function sessionTranscript(agent, sessionId, { after, limit } = {}, deps = {}) {
  if (agent !== 'claude' && agent !== 'codex') return { ok: false, err: 'unknown agent' };
  const id = String(sessionId || '');
  if (deps.known && !deps.known(agent, id)) return { ok: false, err: 'unknown session' };
  const file = (agent === 'codex' ? deps.codexFile || codexSessionFile : deps.claudeFile || claudeSessionFile)(id);
  if (!file) return { ok: false, err: 'unknown session' };
  const n = Math.min(LIMITS.maxN, Math.max(1, Number.isInteger(limit) ? limit : LIMITS.defaultN));
  const cursor = Number.isSafeInteger(after) && after >= 0 ? after : -1;
  const norm = agent === 'codex' ? normCodexLine : normClaudeLine;
  let win, st;
  try { st = fs.statSync(file); win = readWindow(file, agent, cursor); } catch { return { ok: false, err: 'transcript unreadable' }; }
  let all = [];
  for (const l of win.lines) {
    if (!l.text) continue;
    let o;
    try { o = JSON.parse(l.text); } catch { continue; } // a line still being written, or junk: picked up by a later poll
    norm(o, deps.literals).slice(0, SLOT).forEach((e, k) => { all.push({ i: l.off * SLOT + k, ...e }); });
  }
  if (cursor >= 0) all = all.filter((e) => e.i > cursor);
  all = collapseHuge(all);
  const more = all.length > n;
  const entries = all.slice(-n).map(({ n: _n, merged, ...e }) => e);
  return { ok: true, entries, next: entries.length ? entries[entries.length - 1].i : cursor, more, size: win.size, mtime: st.mtimeMs };
}
