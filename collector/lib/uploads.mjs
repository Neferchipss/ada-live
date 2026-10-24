// Phone -> laptop uploads. The page cuts a file into sealed chunks (see the 'upload-chunk' command in
// chat.mjs); this reassembles them under ~/.ada-viewer/inbox. Chunks are deduplicated per upload
// (not through the shared 500-entry replay window, which a large upload would flush), finished
// upload ids are remembered so a replayed upload cannot reappear, and incomplete uploads are
// deleted after ten minutes. Files are only ever written, never executed.
import fs from 'node:fs';
import path from 'node:path';
import { MB, EXT, kindOfExt, mimeOfExt, extOf } from './media.mjs';

export const UPLOAD = {
  maxBytes: 25 * MB,
  minChunk: 8 * 1024,
  maxChunk: 64 * 1024,
  maxChunks: 3200,
  maxGroup: 10,
  maxActive: 4,
  timeoutMs: 10 * 60e3,
  windowMs: 10 * 60e3,
  windowFiles: 10,
  windowBytes: 100 * MB,
  recentKeep: 300,
};
const ID = /^[a-f0-9]{8,32}$/;
const MAX_NAME = 80;

/** A safe single file name: no path parts, no control or reserved characters, bounded length. */
export function sanitizeName(name) {
  let n = String(name ?? '').normalize('NFC').split(/[\\/]/).pop();
  n = n.replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, '').replace(/[^\p{L}\p{N}._\-() ]/gu, '_');
  n = n.replace(/\s+/g, ' ').trim().replace(/^\.+/, '').replace(/[. ]+$/, '');
  const ext = path.extname(n).slice(0, 9);
  let base = n.slice(0, n.length - ext.length).trim();
  if (base.length > MAX_NAME) base = base.slice(0, MAX_NAME).trim();
  return `${base || 'file'}${ext}`;
}

/** Does the declared mime agree with the extension's kind? Phones often send '' or generic types. */
export function mimeMatches(ext, mime) {
  const m = String(mime || '').toLowerCase().split(';')[0].trim();
  if (!m || m === 'application/octet-stream') return true;
  const kind = kindOfExt(ext);
  if (kind === 'image') return m.startsWith('image/');
  if (kind === 'video') return m.startsWith('video/');
  if (ext === 'pdf') return m === 'application/pdf';
  return m.startsWith('text/') || m === 'application/json' || m === 'application/csv' || m === 'application/vnd.ms-excel';
}

/** Cheap content check so a renamed program cannot sit in the inbox as "photo.png". */
export function signatureOk(ext, head) {
  const s = (n, from = 0) => head.subarray(from, from + n).toString('latin1');
  switch (ext) {
    case 'png': return s(8) === '\x89PNG\r\n\x1a\n';
    case 'jpg': case 'jpeg': return head[0] === 0xff && head[1] === 0xd8;
    case 'gif': return s(3) === 'GIF';
    case 'webp': return s(4) === 'RIFF' && s(4, 8) === 'WEBP';
    case 'pdf': return head.subarray(0, 1024).toString('latin1').includes('%PDF-');
    case 'mp4': case 'mov': return s(4, 4) === 'ftyp' || ['moov', 'mdat', 'free', 'wide', 'skip'].includes(s(4, 4));
    case 'webm': return head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3;
    default: return !head.includes(0); // text: no NUL bytes
  }
}

export class UploadManager {
  constructor({ dir, now = Date.now, limits = UPLOAD, recent = [], onGroup = () => {} } = {}) {
    this.dir = dir;
    this.partial = path.join(dir, '.partial');
    this.now = now;
    this.lim = limits;
    this.recent = [...recent].slice(-limits.recentKeep); // finished or abandoned upload ids
    this.onGroup = onGroup;
    this.active = new Map();
    this.groups = new Map();
    this.rejected = new Map(); // upload id -> { reason, at }
    this.starts = [];          // { t, size } for the rate limit
  }

  /** Creates the inbox and removes partial files left by a crash. */
  init() {
    fs.mkdirSync(this.dir, { recursive: true });
    fs.mkdirSync(this.partial, { recursive: true });
    for (const n of fs.readdirSync(this.partial)) { try { fs.unlinkSync(path.join(this.partial, n)); } catch {} }
  }

  dumpRecent() { return this.recent.slice(-this.lim.recentKeep); }

  #remember(id) { this.recent.push(id); if (this.recent.length > this.lim.recentKeep) this.recent = this.recent.slice(-this.lim.recentKeep); }

  /**
   * One decrypted 'upload-chunk' command. Returns null when stored, 'duplicate' for a chunk already
   * held (harmless), or a reason string when refused.
   */
  chunk(cmd) {
    const L = this.lim;
    const { up, grp, gn, i, n, cs, size } = cmd;
    if (!ID.test(up || '') || !ID.test(grp || '')) return 'bad upload id';
    if (![gn, i, n, cs, size].every(Number.isSafeInteger) || gn < 1 || gn > L.maxGroup) return 'bad chunk header';
    if (typeof cmd.d !== 'string' || cmd.d.length > 4 * Math.ceil(L.maxChunk / 3) + 8) return 'bad chunk data';
    this.sweep();
    if (this.recent.includes(up)) return 'replayed';
    const bad = this.rejected.get(up);
    if (bad) return bad.reason;

    let u = this.active.get(up);
    if (!u) {
      const group = this.#group(grp, gn, cmd);
      const refuse = (reason, name) => {
        this.rejected.set(up, { reason, at: this.now() });
        if (this.rejected.size > 50) this.rejected.delete(this.rejected.keys().next().value);
        this.#remember(up);
        this.#fail(group, name || String(cmd.name || 'file').slice(0, 80), reason);
        return reason;
      };
      if (group.n !== gn) return refuse('inconsistent group');
      const name = sanitizeName(cmd.name);
      const ext = extOf(name);
      if (!EXT[ext]) return refuse(`.${ext || '?'} files are not allowed`, name);
      if (!mimeMatches(ext, cmd.mime)) return refuse('file type does not match its extension', name);
      if (size < 1 || size > L.maxBytes) return refuse(`files must be 1 byte to ${L.maxBytes / MB} MB`, name);
      if (cs < L.minChunk || cs > L.maxChunk || n !== Math.ceil(size / cs) || n > L.maxChunks) return refuse('bad chunk layout', name);
      if (this.active.size >= L.maxActive) return refuse('too many uploads at once', name);
      const t = this.now();
      this.starts = this.starts.filter((s) => t - s.t < L.windowMs);
      if (this.starts.length >= L.windowFiles) return refuse(`upload limit: ${L.windowFiles} files per ${L.windowMs / 60e3} minutes`, name);
      if (this.starts.reduce((a, s) => a + s.size, 0) + size > L.windowBytes) return refuse(`upload limit: ${L.windowBytes / MB} MB per ${L.windowMs / 60e3} minutes`, name);
      let fd;
      const part = path.join(this.partial, `${up}.part`);
      try { fs.mkdirSync(this.partial, { recursive: true }); fd = fs.openSync(part, 'w+'); } catch (e) { return refuse(`could not store the upload (${e.code || e.message})`, name); }
      this.starts.push({ t, size });
      u = { id: up, grp, name, ext, mime: String(cmd.mime || '').slice(0, 100), size, cs, n, got: new Uint8Array(n), count: 0, fd, part, startedAt: t };
      this.active.set(up, u);
    } else if (u.size !== size || u.cs !== cs || u.n !== n || u.grp !== grp) return 'inconsistent chunk';

    if (i < 0 || i >= n) return 'chunk out of range';
    if (u.got[i]) return 'duplicate';
    const buf = Buffer.from(cmd.d, 'base64');
    const want = i === n - 1 ? size - (n - 1) * cs : cs;
    if (buf.length !== want) return 'wrong chunk length';
    fs.writeSync(u.fd, buf, 0, buf.length, i * cs);
    u.got[i] = 1;
    u.count++;
    // The first chunk carries the note and brain choice, whichever order chunks arrive in.
    if (i === 0) { const g = this.groups.get(u.grp); if (g && !g.note) { g.note = String(cmd.note || '').slice(0, 2000); g.brain = cmd.brain || null; } }
    if (u.count === n) this.#finish(u);
    return null;
  }

  #group(id, gn, cmd) {
    let g = this.groups.get(id);
    if (!g) { g = { id, n: gn, note: '', brain: null, done: [], failed: [], startedAt: this.now() }; this.groups.set(id, g); }
    return g;
  }

  #fail(group, name, reason) {
    group.failed.push({ name, reason });
    this.#flush(group);
  }

  #flush(group) {
    if (group.done.length + group.failed.length < group.n || group.flushed) return;
    group.flushed = true;
    this.groups.delete(group.id);
    this.onGroup(group);
  }

  #finish(u) {
    this.active.delete(u.id);
    const group = this.groups.get(u.grp);
    this.#remember(u.id);
    try {
      const head = Buffer.alloc(Math.min(u.size, 2048));
      fs.readSync(u.fd, head, 0, head.length, 0);
      fs.closeSync(u.fd);
      u.fd = null;
      if (!signatureOk(u.ext, head)) { fs.unlinkSync(u.part); return this.#fail(group, u.name, `contents do not look like a .${u.ext} file`); }
      const final = path.join(this.dir, `${u.id}-${u.name}`);
      fs.renameSync(u.part, final);
      group.done.push({ id: u.id, name: u.name, path: final, size: u.size, ext: u.ext, kind: kindOfExt(u.ext), mime: mimeOfExt(u.ext) });
      this.#flush(group);
    } catch (e) {
      try { if (u.fd != null) fs.closeSync(u.fd); } catch {}
      try { fs.unlinkSync(u.part); } catch {}
      this.#fail(group, u.name, `could not save (${e.code || e.message})`);
    }
  }

  #abort(u, reason) {
    this.active.delete(u.id);
    this.#remember(u.id);
    try { fs.closeSync(u.fd); } catch {}
    try { fs.unlinkSync(u.part); } catch {}
    this.rejected.set(u.id, { reason, at: this.now() });
    this.#fail(this.groups.get(u.grp) || this.#group(u.grp, 1), u.name, reason);
  }

  /** Drops uploads and groups that never finished. */
  sweep() {
    const t = this.now();
    for (const u of [...this.active.values()]) if (t - u.startedAt > this.lim.timeoutMs) this.#abort(u, 'timed out: not every chunk arrived within 10 minutes');
    for (const g of [...this.groups.values()]) {
      if (t - g.startedAt <= this.lim.timeoutMs) continue;
      const missing = g.n - g.done.length - g.failed.length;
      for (let k = 0; k < missing; k++) g.failed.push({ name: 'file', reason: 'never started' });
      this.#flush(g);
    }
  }

  /** What the page needs to show progress and to resend missing chunks. */
  status() {
    const out = [];
    for (const u of this.active.values()) {
      const miss = [];
      for (let k = 0; k < u.n && miss.length < 60; k++) if (!u.got[k]) miss.push(k);
      out.push({ id: u.id, state: 'receiving', got: u.count, n: u.n, miss });
    }
    for (const [id, r] of this.rejected) out.push({ id, state: 'failed', reason: r.reason });
    for (const id of this.recent.slice(-20)) if (!this.rejected.has(id) && !this.active.has(id)) out.push({ id, state: 'done' });
    return out;
  }
}
