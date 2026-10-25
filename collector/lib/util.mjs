import fs from 'node:fs';
import path from 'node:path';

// Read the last `bytes` of a file and return complete lines (drops the first partial one).
export function tailLines(file, bytes = 512 * 1024) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - bytes);
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    const lines = buf.toString('utf8').split('\n');
    if (start > 0) lines.shift();
    return lines.filter(Boolean);
  } catch {
    return [];
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

export function parseJsonLines(lines) {
  const out = [];
  for (const l of lines) {
    try { out.push(JSON.parse(l)); } catch { /* partial or junk line */ }
  }
  return out;
}

export function clip(s, n = 220) {
  if (!s) return '';
  s = String(s).replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

export function ms(t) {
  const v = typeof t === 'number' ? t : Date.parse(t);
  return Number.isFinite(v) ? v : 0;
}

export function normPath(p) {
  return p ? path.resolve(p).toLowerCase() : '';
}

export function safeStat(p) {
  try { return fs.statSync(p); } catch { return null; }
}

export function safeReaddir(p) {
  try { return fs.readdirSync(p, { withFileTypes: true }); } catch { return []; }
}

// ---- Build/cache paths that are not "work" (edit these lists to tune what the journal, digest, Work cards and Activity ignore) ----
// A path is noise when any whole segment equals one of these names, or starts with one of the prefixes.
export const NOISE_SEGMENTS = ['target', 'node_modules', 'dist', 'build', 'out', '.next', '.cache', '__pycache__', '.venv', 'venv', '.gradle', '.idea', '.vs'];
export const NOISE_SEGMENT_PREFIXES = ['target-'];
// File names (last segment) that are noise wherever they live.
export const NOISE_FILES = [/^\.rustc_info\.json$/i, /\.(pyc|tmp|log|obj|o|pdb)$/i];

/** True for build output / cache paths (relative, either slash). Only whole path segments match: src/target.rs and docs/build-notes.md are real. */
export function isNoisePath(relPath) {
  const segs = String(relPath || '').replace(/\\/g, '/').split('/').filter(Boolean);
  if (!segs.length) return false;
  if (segs.some((s) => NOISE_SEGMENTS.includes(s) || NOISE_SEGMENT_PREFIXES.some((x) => s.startsWith(x)))) return true;
  return NOISE_FILES.some((r) => r.test(segs[segs.length - 1]));
}
