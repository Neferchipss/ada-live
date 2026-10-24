// Masks anything that looks like a secret before a transcript line leaves the laptop.
// Two layers: literal values from ~/.ada-viewer/config.json (page password, PIN record, relay key...) and
// pattern rules for common token shapes. Over-masking is fine here; a leak is not.
import fs from 'node:fs';
import path from 'node:path';
import { STATE_DIR } from './config.mjs';

const MASK = '[redacted]';
const KEYISH_KEY = /pass|pin|key|secret|token|hash|salt|auth|cred/i;
const NAMED = '(?:pass(?:word|wd|phrase|code)|pwd|(?<![a-z])pin(?![a-z])|token|secret|api[_-]?key|apikey|access[_-]?key|authorization|auth[_-]?token|credential|private[_-]?key)';

const RULES = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, MASK],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, `Bearer ${MASK}`],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/g, MASK],             // JWT
  [/\bsk-[A-Za-z0-9_-]{16,}/g, MASK],                                                    // OpenAI / Anthropic
  [/\b(?:ghp|gho|ghs|ghu|ghr)_[A-Za-z0-9]{20,}/g, MASK],                                 // GitHub tokens
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, MASK],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, MASK],                                              // AWS key id
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, MASK],                                             // Slack
  [/\bAIza[0-9A-Za-z_-]{30,}/g, MASK],                                                   // Google API key
  [/\bnpm_[A-Za-z0-9]{30,}/g, MASK],
  [/\b(cf|hf)_[A-Za-z0-9]{24,}/g, MASK],
  // name = value / name: value / "name": "value" / --name value  (value up to whitespace, quote or comma)
  [new RegExp(String.raw`(\b[\w.-]*${NAMED}[\w.-]*["']?\s*[:=]\s*["']?)([^\s"',;&]{3,})`, 'gi'), `$1${MASK}`],
  [new RegExp(String.raw`(--[\w-]*${NAMED}[\w-]*[ =])([^\s"']{3,})`, 'gi'), `$1${MASK}`],
  // key-like name followed shortly by a long hex / base64 blob
  [new RegExp(String.raw`(\b[\w.-]*(?:key|token|secret|pass\w*|pin|hash|salt|cred\w*)[\w.-]*\W{1,4})([A-Fa-f0-9]{32,}|[A-Za-z0-9+/_-]{40,}={0,2})`, 'gi'), `$1${MASK}`],
];

let literalCache = { t: 0, values: [] };

/** Secret strings stored in the local config (never printed or sent): password, PIN record, relay key... */
export function configSecrets(file = path.join(STATE_DIR, 'config.json'), now = Date.now()) {
  if (now - literalCache.t < 30e3 && literalCache.file === file) return literalCache.values;
  const out = new Set();
  const walk = (v, keyed) => {
    if (typeof v === 'string') { if (keyed && v.length >= 6) out.add(v); return; }
    if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, keyed || KEYISH_KEY.test(k));
  };
  try { walk(JSON.parse(fs.readFileSync(file, 'utf8')), false); } catch { /* no config: pattern rules still apply */ }
  const envPw = process.env.ADA_VIEWER_PASSWORD;
  if (envPw && envPw.length >= 4) out.add(envPw);
  literalCache = { t: now, file, values: [...out].sort((a, b) => b.length - a.length) };
  return literalCache.values;
}

export function resetRedactCache() { literalCache = { t: 0, values: [] }; }

/** Returns text with literal secrets and token-shaped strings masked. `literals` overrides the config lookup (tests). */
export function redact(text, literals = configSecrets()) {
  let s = String(text ?? '');
  for (const lit of literals) if (lit && s.includes(lit)) s = s.split(lit).join(MASK);
  for (const [re, to] of RULES) s = s.replace(re, to);
  return s;
}
