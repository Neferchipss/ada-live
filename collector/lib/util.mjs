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
