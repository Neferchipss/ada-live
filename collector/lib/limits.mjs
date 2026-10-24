// Usage-limit state per service, shown as a banner on the phone's home page.
// Sources: failed job/head results that read like a limit error, and accounts data at 100%.
//   service: 'claude' | 'chatgpt' (Codex runs under the ChatGPT login)

// ---- LIMIT ERROR PATTERNS (edit here) ----
export const LIMIT_PATTERNS = [
  /usage limit/i,
  /rate[ -]?limit/i,
  /try again (?:at|in|after)/i,
  /limit reached/i,
  /hit your (?:\w+ )?limit/i,
  /\b429\b/,
  /too many requests/i,
];
// ---- end patterns ----

const UNKNOWN_RESET_MS = 6 * 3600e3; // no parseable reset time: assume the flag is stale after this
const SERVICE_OF = { claude: 'claude', codex: 'chatgpt' };

export const serviceOf = (agent) => SERVICE_OF[agent] || null;
export const looksLimited = (text) => typeof text === 'string' && LIMIT_PATTERNS.some((re) => re.test(text));

const UNITS = { d: 86400e3, h: 3600e3, m: 60e3, s: 1e3 };

function clockText(at, now) {
  const d = new Date(at);
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (d.toDateString() === new Date(now).toDateString()) return time;
  return `${d.toLocaleDateString([], { weekday: 'short' })} ${time}`;
}

/** Reads a reset time out of an error message. Returns { resetsAt, resetText } or null. */
export function parseReset(text, now = Date.now()) {
  if (typeof text !== 'string') return null;
  // Older Claude CLI format: "usage limit reached|1760000000"
  const epoch = text.match(/limit reached\|(\d{10})\b/i);
  if (epoch) { const at = Number(epoch[1]) * 1000; return { resetsAt: at, resetText: clockText(at, now) }; }
  // Relative: "try again in 2 hours 5 minutes", "resets in 45m"
  const rel = text.match(/(?:try again|resets?|retry)\s+(?:in|after)\s+((?:\d+\s*(?:days?|d|hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)\b[\s,and]*)+)/i);
  if (rel) {
    let ms = 0;
    for (const [, n, u] of rel[1].matchAll(/(\d+)\s*(days?|d|hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)\b/gi)) ms += Number(n) * UNITS[u[0].toLowerCase()];
    if (ms > 0) return { resetsAt: now + ms, resetText: `in ${rel[1].trim().replace(/[\s,]+$/, '')}` };
  }
  // Clock time, optionally with a date: "try again at 8:12 AM", "resets 3pm", "resets Oct 25 at 8:12 AM", "at 14:30"
  const clock = text.match(/(?:try again|resets?|retry)\s*(?:at\s+|on\s+)?(?:([A-Za-z]{3,9}\s+\d{1,2}(?:st|nd|rd|th)?(?:,?\s+\d{4})?)\s*(?:,|at)?\s*)?(\d{1,2})(?::(\d{2}))?\s*([ap]m)?/i);
  if (clock && (clock[3] || clock[4])) {
    let h = Number(clock[2]);
    const min = Number(clock[3] || 0);
    const ap = clock[4]?.toLowerCase();
    if (ap === 'pm' && h < 12) h += 12;
    if (ap === 'am' && h === 12) h = 0;
    if (h < 24 && min < 60) {
      const base = new Date(now);
      if (clock[1]) {
        const dated = new Date(`${clock[1].replace(/(\d)(?:st|nd|rd|th)/, '$1')}${/\d{4}/.test(clock[1]) ? '' : `, ${base.getFullYear()}`}`);
        if (!Number.isNaN(dated.getTime())) { base.setTime(dated.getTime()); }
      }
      base.setHours(h, min, 0, 0);
      let at = base.getTime();
      if (at <= now && !clock[1]) { base.setDate(base.getDate() + 1); at = base.getTime(); } // a bare clock time that already passed means tomorrow
      if (at > now) return { resetsAt: at, resetText: clockText(at, now) };
    }
  }
  return null;
}

export class LimitTracker {
  constructor({ now = Date.now } = {}) {
    this.now = now;
    this.errors = new Map();   // service -> { resetText, resetsAt, at }
    this.derived = new Map();  // service -> same shape, rebuilt from accounts on every refresh
    this.lastOk = new Map();   // service -> time of the last successful run
  }

  /** A run of this agent finished. Failures that read like a limit set the flag; success clears it. */
  note(agent, result) {
    const service = serviceOf(agent);
    if (!service || !result) return;
    if (result.ok) { this.errors.delete(service); this.lastOk.set(service, this.now()); return; }
    this.record(service, [result.error, result.text].filter(Boolean).join('\n'));
  }

  record(service, text) {
    if (!looksLimited(text)) return null;
    const now = this.now();
    const reset = parseReset(text, now);
    const entry = { resetText: reset?.resetText || '', resetsAt: reset?.resetsAt || null, at: now };
    this.errors.set(service, entry);
    return entry;
  }

  /** Session or weekly at 100% marks the service limited until that window resets. */
  fromAccounts(accounts = []) {
    this.derived.clear();
    const now = this.now();
    for (const a of accounts) {
      if (a?.service !== 'claude' && a?.service !== 'chatgpt') continue;
      if ((this.lastOk.get(a.service) || 0) > (a.asOf || 0)) continue; // a newer successful run beats stale data
      const full = [a.session, a.weekly].filter((w) => w && w.pct >= 100 && !w.reset && (!w.resetsAt || w.resetsAt > now));
      if (!full.length) continue;
      const resetsAt = Math.max(...full.map((w) => w.resetsAt || 0)) || null;
      this.derived.set(a.service, { resetText: resetsAt ? clockText(resetsAt, now) : '', resetsAt, at: a.asOf || now });
    }
  }

  /** Current limited services, for the snapshot. */
  active() {
    const now = this.now();
    const out = [];
    for (const service of ['claude', 'chatgpt']) {
      const e = this.errors.get(service);
      if (e && (e.resetsAt ? e.resetsAt <= now : now - e.at > UNKNOWN_RESET_MS)) this.errors.delete(service);
      const live = this.errors.get(service);
      const d = this.derived.get(service);
      const pick = live || d;
      if (!pick) continue;
      out.push({ service, limited: true, resetText: pick.resetText || d?.resetText || '', resetsAt: pick.resetsAt || d?.resetsAt || null, at: pick.at });
    }
    return out;
  }
}

/** Shared by the chat hub (records results) and the snapshot builder (reads state). */
export const limits = new LimitTracker();
