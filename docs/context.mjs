// Pure helpers for the context-usage bars (shared by the page, the collector and tests). No DOM, no globals.
// A context is { used, window, pct, model, src }: `used` tokens now in the conversation, `window` the model's
// context size when known (else null: the page then shows the token count only, never a guessed percentage).
// `src` is 'data' when the window was reported by the CLI itself, 'family' when it came from the small
// documented map in collector/lib/context.mjs; the page marks the latter with "~".

export const CTX_WARN = 70;   // amber from here
export const CTX_CRIT = 90;   // red from here
export const CTX_FRESH = 80;  // suggest a fresh context from here

const pos = (n) => Number.isFinite(n) && n > 0;

// Whole-number percent of the window in use, or null when either number is unknown. Not capped: 112 means over.
export function ctxPct(used, window) {
  if (!Number.isFinite(used) || used < 0 || !pos(window)) return null;
  return Math.round((used / window) * 100);
}

// 842 -> "842", 84300 -> "84k", 1250000 -> "1.2M"
export function fmtTokens(n) {
  if (!Number.isFinite(n) || n < 0) return '';
  if (n < 1000) return String(Math.round(n));
  if (n < 1e6) return `${Math.round(n / 1000)}k`;
  const m = n / 1e6;
  return `${m >= 10 ? Math.round(m) : (Math.floor(m * 10) / 10).toFixed(1).replace(/\.0$/, '')}M`;
}

// '' | 'hot' | 'crit' for a percent (null stays quiet).
export function ctxLevel(pct) {
  if (!Number.isFinite(pct)) return '';
  return pct >= CTX_CRIT ? 'crit' : pct >= CTX_WARN ? 'hot' : '';
}

// Cleans whatever the snapshot carried into { used, window, pct, level, label, title } or null when there is nothing to show.
export function ctxView(c) {
  if (!c || !pos(c.used)) return null;
  const window = pos(c.window) ? c.window : null;
  const pct = ctxPct(c.used, window);
  const approx = pct !== null && c.src === 'family';
  const tokens = fmtTokens(c.used);
  const label = pct === null ? tokens : `${approx ? '~' : ''}${pct}% · ${tokens}`;
  return {
    used: c.used, window, pct, level: ctxLevel(pct), label,
    // The pill text: "ctx 27% · 268k / 1M", or "ctx 258k" when the window is unknown (never a made-up percentage).
    chip: `ctx ${label}${window ? ` / ${fmtTokens(window)}` : ''}`,
    title: `${c.used.toLocaleString('en-US')} tokens in context${window ? ` of ${window.toLocaleString('en-US')}${approx ? ' (assumed window for this model family)' : ''}` : ' (window size unknown)'}`,
  };
}

export const ctxNeedsFresh = (v) => !!v && v.pct !== null && v.pct >= CTX_FRESH;
