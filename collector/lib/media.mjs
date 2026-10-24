// Media for the Ada chat: validates files Ada wants to show, shrinks them with ffmpeg,
// and keeps the results in a size-capped cache (~/.ada-viewer/media-cache) keyed by hash.
// Nothing here is sent anywhere; chat.mjs serves cached bytes to the page in sealed chunks.
// ffmpeg is optional: without it images pass through under a size cap and video is refused.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';

export const MB = 1024 * 1024;
export const MAX_ATTACH_PER_REPLY = 6;
export const IMAGE_MAX_SIDE = 1600;
export const VIDEO_CAP = 20 * MB;        // transcoded video sent to the phone
export const DOWNLOAD_MAX = 8 * MB;      // plain files (pdf/text) the phone may download
export const CACHE_CAP = 500 * MB;
export const CHUNK = 48 * 1024;          // raw bytes per sealed media chunk
export const THUMB_MAX = 4096;           // chars in the inline thumbnail data URI
const SOURCE_MAX = { image: 60 * MB, video: 2048 * MB, file: 200 * MB };
const NO_FFMPEG_IMAGE_CAP = 2.5 * MB;

// extension -> [kind, mime]. Anything else is refused, both for Ada's attachments and phone uploads.
export const EXT = {
  png: ['image', 'image/png'], jpg: ['image', 'image/jpeg'], jpeg: ['image', 'image/jpeg'], webp: ['image', 'image/webp'], gif: ['image', 'image/gif'],
  mp4: ['video', 'video/mp4'], webm: ['video', 'video/webm'], mov: ['video', 'video/quicktime'],
  pdf: ['file', 'application/pdf'], txt: ['file', 'text/plain'], md: ['file', 'text/markdown'], json: ['file', 'application/json'], csv: ['file', 'text/csv'],
};
export const extOf = (name) => path.extname(String(name || '')).slice(1).toLowerCase();
export const kindOfExt = (ext) => EXT[ext]?.[0] || null;
export const mimeOfExt = (ext) => EXT[ext]?.[1] || 'application/octet-stream';

// Text-like files with these names are never sent (secrets live in files like these).
const SENSITIVE_NAME = /^(\.env.*|.*(secret|credential|password|passwd|token|apikey|api[-_]key|private[-_]?key).*|id_(rsa|ed25519|ecdsa).*)$/i;
const SENSITIVE_DIR = new Set(['.git', '.ssh', '.aws', '.gnupg']);

export function formatSize(n) {
  if (!Number.isFinite(n)) return '?';
  if (n < 1024) return `${n} B`;
  if (n < MB) return `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`;
  return `${(n / MB).toFixed(n < 10 * MB ? 1 : 0)} MB`;
}

const within = (child, parent) => {
  const rel = path.relative(parent, child);
  return !!rel && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
};

/**
 * Decides whether a file may be shown on the phone. Checks the path lexically (absolute, no "..",
 * inside a root) and again after resolving symlinks/junctions, so a link cannot lead out of a root.
 * Returns { ok:true, real, name, ext, kind, mime, size, mtimeMs } or { ok:false, reason }.
 */
export function checkAttachPath(p, roots) {
  const bad = (reason) => ({ ok: false, reason });
  if (typeof p !== 'string' || !p || p.length > 1024 || p.includes('\0')) return bad('not a usable path');
  if (!path.isAbsolute(p)) return bad('path must be absolute');
  if (p.split(/[\\/]+/).includes('..')) return bad('path must not contain ..');
  const lexical = path.resolve(p);
  const rs = [];
  for (const r of roots) { try { rs.push({ raw: path.resolve(r), real: fs.realpathSync(r) }); } catch { /* missing root */ } }
  if (!rs.some((r) => within(lexical, r.raw) || within(lexical, r.real))) return bad('outside the allowed folders');
  let real;
  try { real = fs.realpathSync(lexical); } catch { return bad('file not found'); }
  if (!rs.some((r) => within(real, r.real))) return bad('resolves outside the allowed folders');
  let st;
  try { st = fs.statSync(real); } catch { return bad('file not found'); }
  if (!st.isFile()) return bad('not a file');
  const ext = extOf(real);
  const kind = kindOfExt(ext);
  if (!kind) return bad(`.${ext || '?'} files are not allowed`);
  if (kind === 'file' && SENSITIVE_NAME.test(path.basename(real))) return bad('looks like a secrets file');
  if (real.split(path.sep).some((s) => SENSITIVE_DIR.has(s.toLowerCase()))) return bad('inside a protected folder');
  if (st.size <= 0) return bad('file is empty');
  if (st.size > SOURCE_MAX[kind]) return bad(`file is too large (${formatSize(st.size)})`);
  const name = extOf(lexical) === ext ? path.basename(lexical) : path.basename(real);
  return { ok: true, real, name, ext, kind, mime: mimeOfExt(ext), size: st.size, mtimeMs: st.mtimeMs };
}

/** Stable cache key for a validated source file. Same file + size + mtime -> same key. */
export function cacheKey(info) {
  return crypto.createHash('sha256').update(`v1|${info.real.toLowerCase()}|${info.size}|${Math.floor(info.mtimeMs)}`).digest('hex').slice(0, 24);
}
export const validKey = (k) => typeof k === 'string' && /^[a-f0-9]{24}$/.test(k);

/** Deletes whole cache entries (all files sharing a key), oldest first, until the cache fits `cap`. */
export function pruneCache(dir, cap = CACHE_CAP, keep = []) {
  let names;
  try { names = fs.readdirSync(dir); } catch { return { removed: 0, bytes: 0 }; }
  const entries = new Map(); // key -> { size, mtime, files }
  for (const n of names) {
    const key = n.split('.')[0];
    let st;
    try { st = fs.statSync(path.join(dir, n)); } catch { continue; }
    if (!st.isFile()) continue;
    const e = entries.get(key) || { key, size: 0, mtime: 0, files: [] };
    e.size += st.size; e.mtime = Math.max(e.mtime, st.mtimeMs); e.files.push(n);
    entries.set(key, e);
  }
  let total = [...entries.values()].reduce((s, e) => s + e.size, 0);
  let removed = 0;
  for (const e of [...entries.values()].sort((a, b) => a.mtime - b.mtime)) {
    if (total <= cap) break;
    if (keep.includes(e.key)) continue;
    for (const f of e.files) { try { fs.unlinkSync(path.join(dir, f)); } catch { /* in use */ } }
    total -= e.size; removed++;
  }
  return { removed, bytes: total };
}

/** Runs a tool without a shell. Resolves { code, stdout, stderr }; never rejects. */
export function runTool(bin, args, { timeout = 120000, env } = {}) {
  return new Promise((resolve) => {
    let out = '';
    let err = '';
    let done = false;
    let child;
    const finish = (r) => { if (done) return; done = true; clearTimeout(timer); resolve(r); };
    try { child = spawn(bin, args, { windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'], env: env || process.env }); }
    catch (e) { return resolve({ code: -1, stdout: '', stderr: e.message }); }
    const timer = setTimeout(() => { try { child.kill(); } catch {} finish({ code: -2, stdout: out, stderr: `${err}\ntimed out` }); }, timeout);
    child.stdout.on('data', (d) => { out = (out + d).slice(-1_000_000); });
    child.stderr.on('data', (d) => { err = (err + d).slice(-4000); });
    child.on('error', (e) => finish({ code: -1, stdout: out, stderr: e.message }));
    child.on('close', (code) => finish({ code, stdout: out, stderr: err }));
  });
}

class Semaphore {
  constructor(n) { this.n = n; this.q = []; }
  async run(fn) {
    if (this.n <= 0) await new Promise((r) => this.q.push(r));
    else this.n--;
    try { return await fn(); } finally { const next = this.q.shift(); if (next) next(); else this.n++; }
  }
}

export class MediaStore {
  constructor({ dir, ffmpeg = 'ffmpeg', ffprobe = 'ffprobe', capBytes = CACHE_CAP, exec = runTool } = {}) {
    this.dir = dir;
    this.ffmpeg = ffmpeg;
    this.ffprobe = ffprobe;
    this.capBytes = capBytes;
    this.exec = exec;
    this.gate = new Semaphore(2);
    this.inflight = new Map();
    this._tools = null;
  }

  /** { ffmpeg, ffprobe } booleans, detected once. */
  tools() {
    this._tools ||= (async () => {
      const [a, b] = await Promise.all([this.exec(this.ffmpeg, ['-version'], { timeout: 8000 }), this.exec(this.ffprobe, ['-version'], { timeout: 8000 })]);
      return { ffmpeg: a.code === 0, ffprobe: b.code === 0 };
    })();
    return this._tools;
  }

  #p(key, suffix) { return path.join(this.dir, `${key}${suffix}`); }

  /** Cached metadata for a key, or null when it is missing or its file is gone. */
  entry(key) {
    if (!validKey(key)) return null;
    try {
      const meta = JSON.parse(fs.readFileSync(this.#p(key, '.json'), 'utf8'));
      if (meta.file && !fs.existsSync(path.join(this.dir, meta.file))) return null;
      return meta;
    } catch { return null; }
  }

  /** Absolute path of a cached part ('main' or 'poster'), or null. */
  filePath(key, part = 'main') {
    const meta = this.entry(key);
    const f = part === 'poster' ? meta?.poster : meta?.file;
    if (!f) return null;
    const p = path.join(this.dir, f);
    return fs.existsSync(p) ? p : null;
  }

  touch(key) {
    const t = new Date();
    for (const n of (() => { try { return fs.readdirSync(this.dir); } catch { return []; } })()) {
      if (n.split('.')[0] === key) { try { fs.utimesSync(path.join(this.dir, n), t, t); } catch {} }
    }
  }

  prune(keep = []) { return pruneCache(this.dir, this.capBytes, keep); }

  /** Prepares a validated source (from checkAttachPath) for the phone. Resolves cache metadata; throws a readable Error. */
  prepare(info) {
    const key = cacheKey(info);
    const cached = this.entry(key);
    if (cached) { this.touch(key); return Promise.resolve(cached); }
    if (!this.inflight.has(key)) {
      const job = this.gate.run(() => this.#build(info, key)).finally(() => this.inflight.delete(key));
      this.inflight.set(key, job);
    }
    return this.inflight.get(key);
  }

  async #build(info, key) {
    fs.mkdirSync(this.dir, { recursive: true });
    const t = await this.tools();
    const meta = { id: key, kind: info.kind, name: info.name, size: info.size, mime: info.mime };
    try {
      if (info.kind === 'image') await this.#image(info, key, meta, t);
      else if (info.kind === 'video') await this.#video(info, key, meta, t);
      else this.#plain(info, key, meta);
      fs.writeFileSync(this.#p(key, '.json'), JSON.stringify(meta));
    } catch (e) {
      for (const n of fs.readdirSync(this.dir)) if (n.split('.')[0] === key) { try { fs.unlinkSync(path.join(this.dir, n)); } catch {} }
      throw e;
    }
    this.prune([key]);
    return meta;
  }

  #plain(info, key, meta) {
    meta.dl = info.size <= DOWNLOAD_MAX;
    if (!meta.dl) return;
    meta.file = `${key}.${info.ext}`;
    fs.copyFileSync(info.real, path.join(this.dir, meta.file));
    meta.bytes = info.size;
  }

  async #probe(file) {
    const r = await this.exec(this.ffprobe, ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name,width,height:format=duration', '-of', 'json', file], { timeout: 30000 });
    if (r.code !== 0) return null;
    try {
      const j = JSON.parse(r.stdout);
      const v = (j.streams || []).find((s) => s.codec_type === 'video');
      return { w: v?.width || null, h: v?.height || null, vcodec: v?.codec_name || '', acodec: (j.streams || []).find((s) => s.codec_type === 'audio')?.codec_name || '', dur: Number(j.format?.duration) || 0 };
    } catch { return null; }
  }

  async #image(info, key, meta, t) {
    const probe = t.ffprobe ? await this.#probe(info.real) : null;
    meta.w = probe?.w || null; meta.h = probe?.h || null;
    const fits = !!meta.w && meta.w <= IMAGE_MAX_SIDE && meta.h <= IMAGE_MAX_SIDE;
    const limit = { png: 300 * 1024, gif: 3 * MB, jpg: 500 * 1024, jpeg: 500 * 1024, webp: 500 * 1024 }[info.ext];
    const copyOriginal = () => { meta.file = `${key}.${info.ext}`; meta.mime = info.mime; fs.copyFileSync(info.real, path.join(this.dir, meta.file)); meta.bytes = info.size; };
    if (!t.ffmpeg) {
      if (info.size > NO_FFMPEG_IMAGE_CAP) throw new Error(`Image is ${formatSize(info.size)} and ffmpeg is not installed, so it cannot be shrunk for the phone`);
      return copyOriginal();
    }
    if (fits && info.size <= limit) copyOriginal();
    else {
      const wantWebp = info.ext === 'png' || info.ext === 'webp';
      const scale = `scale='min(${IMAGE_MAX_SIDE},iw)':'min(${IMAGE_MAX_SIDE},ih)':force_original_aspect_ratio=decrease`;
      let ext = wantWebp ? 'webp' : 'jpg';
      let out = this.#p(key, `.${ext}`);
      let r = await this.exec(this.ffmpeg, ['-y', '-v', 'error', '-i', info.real, '-frames:v', '1', '-vf', scale, ...(ext === 'webp' ? ['-c:v', 'libwebp', '-quality', '80'] : ['-q:v', '5']), out], { timeout: 120000 });
      if (r.code !== 0 && ext === 'webp') { // no libwebp: jpeg loses transparency but still works
        ext = 'jpg'; out = this.#p(key, '.jpg');
        r = await this.exec(this.ffmpeg, ['-y', '-v', 'error', '-i', info.real, '-frames:v', '1', '-vf', scale, '-q:v', '5', out], { timeout: 120000 });
      }
      if (r.code !== 0 || !fs.existsSync(out)) throw new Error(`Could not convert the image (${(r.stderr || '').trim().split('\n').pop() || 'ffmpeg failed'})`);
      const size = fs.statSync(out).size;
      if (fits && size >= info.size) { fs.unlinkSync(out); copyOriginal(); } // re-encoding made it bigger
      else { meta.file = path.basename(out); meta.mime = mimeOfExt(ext); meta.bytes = size; const p2 = await this.#probe(out); if (p2?.w) { meta.w = p2.w; meta.h = p2.h; } }
    }
    meta.thumb = await this.#thumb(path.join(this.dir, meta.file), key);
  }

  /** A tiny jpeg data URI (<= THUMB_MAX chars) for blurred placeholders. */
  async #thumb(src, key) {
    const t = await this.tools();
    if (!t.ffmpeg) return null;
    const out = this.#p(key, '.thumb.tmp.jpg');
    try {
      for (const w of [80, 64, 48, 32]) {
        for (const q of [10, 20]) {
          const r = await this.exec(this.ffmpeg, ['-y', '-v', 'error', '-i', src, '-frames:v', '1', '-vf', `scale=${w}:-2`, '-q:v', String(q), out], { timeout: 30000 });
          if (r.code !== 0 || !fs.existsSync(out)) return null;
          const uri = `data:image/jpeg;base64,${fs.readFileSync(out).toString('base64')}`;
          if (uri.length <= THUMB_MAX) return uri;
        }
      }
      return null;
    } finally { try { fs.unlinkSync(out); } catch {} }
  }

  async #video(info, key, meta, t) {
    if (!t.ffmpeg || !t.ffprobe) throw new Error('Video needs ffmpeg and ffprobe on the laptop, and they were not found. Install ffmpeg (for example: winget install Gyan.FFmpeg) and restart the collector');
    const probe = await this.#probe(info.real);
    if (!probe?.w) throw new Error('Could not read this video (ffprobe found no video stream)');
    const dur = probe.dur || 0;
    meta.dur = Math.round(dur * 10) / 10;
    // Poster first: it is useful even if the transcode is refused.
    const poster = this.#p(key, '.poster.jpg');
    const ss = String(Math.min(1, dur / 2) || 0);
    const pr = await this.exec(this.ffmpeg, ['-y', '-v', 'error', '-ss', ss, '-i', info.real, '-frames:v', '1', '-vf', "scale='min(480,iw)':-2", '-q:v', '5', poster], { timeout: 60000 });
    if (pr.code === 0 && fs.existsSync(poster)) { meta.poster = path.basename(poster); meta.thumb = await this.#thumb(poster, key); }

    const out = this.#p(key, '.mp4');
    const alreadyOk = info.ext === 'mp4' && probe.vcodec === 'h264' && (!probe.acodec || probe.acodec === 'aac') && Math.min(probe.w, probe.h) <= 720 && info.size <= VIDEO_CAP;
    if (alreadyOk) { fs.copyFileSync(info.real, out); }
    else {
      if (!dur) throw new Error('Could not read the video length, so it cannot be fitted under the size cap');
      const budget = Math.floor((VIDEO_CAP * 8 * 0.9) / dur) - 96_000; // video bits/s that fit the cap with headroom
      if (budget < 100_000) throw new Error(`This video is ${Math.round(dur)}s long: too long to fit in ${formatSize(VIDEO_CAP)} at a watchable quality`);
      let done = false;
      let last = '';
      for (const [side, ceil] of [[720, 2_500_000], [480, 1_100_000], [360, 550_000]]) {
        const rate = Math.min(ceil, Math.floor(budget * (side === 720 ? 1 : side === 480 ? 0.85 : 0.7)));
        if (rate < 80_000) break;
        const r = await this.exec(this.ffmpeg, ['-y', '-v', 'error', '-i', info.real, '-map', '0:v:0', '-map', '0:a:0?', '-vf', `scale=-2:'min(${side},ih)'`,
          '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '28', '-maxrate', String(rate), '-bufsize', String(rate * 2), '-pix_fmt', 'yuv420p',
          '-c:a', 'aac', '-b:a', '96k', '-ac', '2', '-movflags', '+faststart', out], { timeout: 20 * 60e3 });
        last = (r.stderr || '').trim().split('\n').pop();
        if (r.code !== 0 || !fs.existsSync(out)) throw new Error(`Video conversion failed (${last || 'ffmpeg error'})`);
        if (fs.statSync(out).size <= VIDEO_CAP) { done = true; break; }
      }
      if (!done) throw new Error(`Could not get this video under ${formatSize(VIDEO_CAP)} even at 360p`);
    }
    meta.file = path.basename(out);
    meta.mime = 'video/mp4';
    meta.bytes = fs.statSync(out).size;
    const p2 = await this.#probe(out);
    meta.w = p2?.w || probe.w; meta.h = p2?.h || probe.h;
  }

  /** Up to `count` evenly spaced jpeg frames (<= 960 px wide) written next to `outPrefix`. Returns their paths. */
  async frames(file, outPrefix, count = 8) {
    const t = await this.tools();
    if (!t.ffmpeg || !t.ffprobe) return [];
    const probe = await this.#probe(file);
    const dur = probe?.dur || 0;
    const n = dur > 0 ? Math.min(count, Math.max(1, Math.floor(dur))) : 1;
    const out = [];
    for (let k = 0; k < n; k++) {
      const at = dur > 0 ? (dur * (k + 0.5)) / n : 0;
      const f = `${outPrefix}-frame${String(k + 1).padStart(2, '0')}.jpg`;
      const r = await this.exec(this.ffmpeg, ['-y', '-v', 'error', '-ss', at.toFixed(2), '-i', file, '-frames:v', '1', '-vf', "scale='min(960,iw)':-2", '-q:v', '4', f], { timeout: 60000 });
      if (r.code === 0 && fs.existsSync(f)) out.push(f);
    }
    return out;
  }
}

/** Finds an already-installed speech-to-text CLI with a model that is already on disk. Never downloads anything. */
export function findTranscriber({ pathDirs = (process.env.PATH || '').split(path.delimiter), home = os.homedir(), exists = fs.existsSync, list = (d) => { try { return fs.readdirSync(d); } catch { return []; } } } = {}) {
  const has = (name) => pathDirs.some((d) => d && ['', '.exe', '.cmd', '.bat'].some((e) => exists(path.join(d, name + e))));
  if (has('whisper-ctranslate2')) {
    const hub = path.join(home, '.cache', 'huggingface', 'hub');
    if (list(hub).some((n) => /faster-whisper/i.test(n))) return { tool: 'whisper-ctranslate2', model: 'base', env: { HF_HUB_OFFLINE: '1' } };
  }
  if (has('whisper')) {
    const dir = path.join(home, '.cache', 'whisper');
    const pt = list(dir).find((n) => /^(base|small|tiny|medium)(\.en)?\.pt$/.test(n));
    if (pt) return { tool: 'whisper', model: pt.replace(/\.pt$/, ''), env: {} };
  }
  return null;
}

/** Transcribes a video with a local tool if one is installed. Returns the transcript path or null. */
export async function transcribe(file, outTxt, { find = findTranscriber, exec = runTool } = {}) {
  const found = find();
  if (!found) return null;
  const dir = path.dirname(outTxt);
  const args = found.tool === 'whisper'
    ? [file, '--model', found.model, '--output_format', 'txt', '--output_dir', dir, '--fp16', 'False']
    : [file, '--model', found.model, '--output_format', 'txt', '--output_dir', dir];
  const r = await exec(found.tool, args, { timeout: 5 * 60e3, env: { ...process.env, ...found.env } });
  const made = path.join(dir, `${path.basename(file, path.extname(file))}.txt`);
  if (r.code !== 0 || !fs.existsSync(made)) return null;
  fs.renameSync(made, outTxt);
  return outTxt;
}
