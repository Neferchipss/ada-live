// Context usage: how many tokens a Claude/Codex conversation currently holds, and how full its window is.
// Everything here is pure (transcript lines in, numbers out) so it is tested against fixtures.
//
// Context size is the LAST request's input, not a sum over the turn:
//   Claude: last assistant message usage = input_tokens + cache_read_input_tokens + cache_creation_input_tokens
//   Codex:  last token_count event, last_token_usage.input_tokens (already includes cached tokens);
//           total_token_usage is cumulative across requests and says nothing about the current context.
// Window size is never invented. Order of trust: the CLI's own report (Codex model_context_window,
// Claude JSON modelUsage[model].contextWindow, remembered per model below), then FAMILY_WINDOWS for older
// Claude families whose default is documented, else null (the page shows the token count only).
import { ctxPct } from '../../docs/context.mjs';

// Documented default windows, matched on the model id. Deliberately short: a model that is not listed here
// and never reported its window stays unknown. These are marked src:'family' so the page shows "~".
export const FAMILY_WINDOWS = [
  [/^claude-3(-\d)?-(opus|sonnet|haiku)\b/, 200000],             // claude-3-opus, claude-3-5-sonnet, claude-3-7-sonnet ...
  [/^claude-(opus|sonnet|haiku)-4(-\d)?(-\d{8})?$/, 200000],     // claude-opus-4, claude-sonnet-4-5, claude-opus-4-1-20250805 ...
];

const learned = new Map(); // model id -> window the CLI reported for it (survives for the life of the collector, persisted by chat.mjs)

export function learnWindow(model, window) {
  if (typeof model === 'string' && model && Number.isFinite(window) && window > 0) learned.set(model, Math.round(window));
}
export const learnedWindows = () => Object.fromEntries(learned);
export function loadWindows(obj) { for (const [m, w] of Object.entries(obj && typeof obj === 'object' ? obj : {})) learnWindow(m, w); }

/** { window, src } for a model id, or null when it is not known. */
export function windowFor(model) {
  if (!model || typeof model !== 'string') return null;
  if (learned.has(model)) return { window: learned.get(model), src: 'data' };
  const hit = FAMILY_WINDOWS.find(([re]) => re.test(model));
  return hit ? { window: hit[1], src: 'family' } : null;
}

/** Claude JSON result modelUsage -> { model, window } (the entry with the largest reported window), or null. */
export function windowFromModelUsage(mu) {
  let best = null;
  for (const [model, u] of Object.entries(mu && typeof mu === 'object' ? mu : {})) {
    const w = u?.contextWindow;
    if (Number.isFinite(w) && w > 0 && (!best || w > best.window)) best = { model, window: w };
  }
  return best;
}

/**
 * Builds the { used, window, pct, model, src } object the snapshot carries. null when nothing is in context yet.
 * An assumed (family) window the usage already exceeds is wrong, so it is dropped rather than shown as 130%.
 */
export function makeContext({ used, window = null, src = 'data', model = '' }) {
  if (!Number.isFinite(used) || used <= 0) return null;
  let w = Number.isFinite(window) && window > 0 ? Math.round(window) : null;
  if (w && src === 'family' && used > w) w = null;
  return { used: Math.round(used), window: w, pct: ctxPct(used, w), model: model || '', ...(w ? { src } : {}) };
}

const n = (x) => (Number.isFinite(x) ? x : 0);

/** Last real assistant message in a Claude transcript (parsed lines) -> { used, model } or null. Sub-agent and synthetic turns are skipped. */
export function claudeUsage(entries) {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e?.type !== 'assistant' || e.isSidechain) continue;
    const m = e.message || {};
    const u = m.usage;
    if (!u || m.model === '<synthetic>') continue;
    const used = n(u.input_tokens) + n(u.cache_read_input_tokens) + n(u.cache_creation_input_tokens);
    if (used > 0) return { used, model: m.model || '' };
  }
  return null;
}

/** Context for a Claude session from its transcript lines; `model` is the session's model when the message did not name one. */
export function claudeContext(entries, model = '') {
  const u = claudeUsage(entries);
  if (!u) return null;
  const m = u.model || model;
  const w = windowFor(m);
  return makeContext({ used: u.used, window: w?.window, src: w?.src, model: m });
}

/** Latest token_count event in a Codex rollout (parsed lines) -> { used, window } or null. */
export function codexUsage(entries) {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e?.type !== 'event_msg' || e.payload?.type !== 'token_count') continue;
    const info = e.payload.info;
    const used = n(info?.last_token_usage?.input_tokens);
    if (used > 0) return { used, window: Number.isFinite(info.model_context_window) ? info.model_context_window : null };
  }
  return null;
}

export function codexContext(entries, model = '') {
  const u = codexUsage(entries);
  if (!u) return null;
  return makeContext({ used: u.used, window: u.window, src: 'data', model });
}
