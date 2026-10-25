// Helpers for Ada's streamed head turns: reading Claude's stream-json output line by line, turning
// events into "text so far" plus an honest tool phase, throttling updates, and keeping reply timings.
import fs from 'node:fs';
import path from 'node:path';

const BLOCKS = ['jobs', 'attach'];

/** Splits a byte stream into JSON lines. Bad or truncated lines are dropped; a trailing partial line is kept until it completes. */
export class LineParser {
  constructor(onEvent) { this.onEvent = onEvent; this.buf = ''; }
  feed(chunk) {
    this.buf += chunk;
    const lines = this.buf.split('\n');
    this.buf = lines.pop();
    for (const l of lines) this.#line(l);
  }
  /** Flushes the last line (a stream that ended without a newline). */
  end() { const l = this.buf; this.buf = ''; this.#line(l); }
  #line(l) {
    const s = l.trim();
    if (!s || s[0] !== '{') return;
    let o;
    try { o = JSON.parse(s); } catch { return; } // truncated or garbled: skip, the result event is the source of truth
    this.onEvent(o);
  }
}

/** Removes <jobs>/<attach> blocks from partial text: complete ones, one still open (to the end), and a half-typed opening tag. */
export function stripBlocks(text) {
  let s = String(text || '');
  for (const b of BLOCKS) {
    s = s.replace(new RegExp(`<${b}>[\\s\\S]*?</${b}>`, 'gi'), '');
    const open = s.search(new RegExp(`<${b}>`, 'i'));
    if (open >= 0) s = s.slice(0, open);
  }
  // "<", "<ju", "<attac" at the very end may be the start of a block that has not finished arriving.
  const lt = s.lastIndexOf('<');
  if (lt >= 0 && s.length - lt <= 8) {
    const tail = s.slice(lt + 1).toLowerCase();
    if (BLOCKS.some((b) => b.startsWith(tail) || (`${b}>`).startsWith(tail))) s = s.slice(0, lt);
  }
  return s.replace(/\s+$/, '');
}

const PHASE = [
  [/^(Read|NotebookRead)$/, 'reading'],
  [/^(Grep|Glob|LS|ToolSearch)$/, 'searching'],
  [/^(WebSearch|WebFetch)$/, 'looking something up'],
  [/^(Task|Agent)$/, 'asking a helper'],
];

/** "Ada is reading…" style status for a tool Claude actually started. Unknown tools are named, never guessed. */
export function phaseText(tool) {
  const hit = PHASE.find(([re]) => re.test(tool));
  return `Ada is ${hit ? hit[1] : `using ${String(tool).replace(/^mcp__/, '').slice(0, 40)}`}…`;
}

/**
 * Folds stream-json events into { text, status, firstTokenAt }. feed(ev) returns true when what the page
 * would show changed. Text restarts with each assistant message (the final result is the last one's text).
 */
export class StreamTracker {
  constructor(now = Date.now) { this.now = now; this.text = ''; this.status = ''; this.firstTokenAt = null; this.tools = new Map(); }
  feed(o) {
    if (o?.type !== 'stream_event' || !o.event || o.parent_tool_use_id) return false;
    const e = o.event;
    if (e.type === 'message_start') { const had = this.text || this.status; this.text = ''; this.status = ''; this.tools.clear(); return !!had; }
    if (e.type === 'content_block_start') {
      if (e.content_block?.type === 'tool_use') { this.status = phaseText(e.content_block.name || 'a tool'); return true; }
      return false;
    }
    if (e.type === 'content_block_delta' && e.delta?.type === 'text_delta' && typeof e.delta.text === 'string') {
      if (this.firstTokenAt === null) this.firstTokenAt = this.now();
      this.text += e.delta.text;
      this.status = '';
      return true;
    }
    return false;
  }
  /** What goes to the page. */
  snapshot() { return { text: stripBlocks(this.text), status: this.status }; }
}

/** Leading + trailing throttle: the first call goes out at once, later ones at most every `gap` ms with the newest value. */
export class Throttle {
  constructor(emit, gap = 333, { now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
    Object.assign(this, { emit, gap, now, setTimer, clearTimer, last: -Infinity, timer: null, pending: undefined });
  }
  push(v) {
    const wait = this.last + this.gap - this.now();
    if (wait <= 0 && !this.timer) { this.last = this.now(); this.emit(v); return; }
    this.pending = v;
    if (!this.timer) {
      this.timer = this.setTimer(() => { this.timer = null; const p = this.pending; this.pending = undefined; this.last = this.now(); if (p !== undefined) this.emit(p); }, Math.max(1, wait));
      this.timer.unref?.();
    }
  }
  cancel() { if (this.timer) this.clearTimer(this.timer); this.timer = null; this.pending = undefined; }
}

export const TIMING_MAX = 2 * 1024 * 1024;

/** Appends one JSON line; when the file passes `max` bytes the older half is dropped. Never throws. */
export function appendTiming(file, rec, max = TIMING_MAX) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify(rec) + '\n');
    if (fs.statSync(file).size > max) {
      const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
      fs.writeFileSync(file, lines.slice(Math.floor(lines.length / 2)).join('\n') + '\n');
    }
  } catch { /* timing is a convenience */ }
}
