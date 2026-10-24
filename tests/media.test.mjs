import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { checkAttachPath, cacheKey, pruneCache, MediaStore, findTranscriber, formatSize, THUMB_MAX } from '../collector/lib/media.mjs';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const noTools = async () => ({ code: -1, stdout: '', stderr: 'not installed' });

function sandbox() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ada-media-'));
  const work = path.join(base, 'work');
  const inbox = path.join(base, 'inbox');
  const outside = path.join(base, 'outside');
  for (const d of [path.join(work, 'proj'), inbox, outside]) fs.mkdirSync(d, { recursive: true });
  return { base, work, inbox, outside, roots: [work, inbox] };
}

test('attach paths: files inside the roots are accepted with kind and mime', () => {
  const s = sandbox();
  const png = path.join(s.work, 'proj', 'shot.PNG');
  fs.writeFileSync(png, PNG);
  const r = checkAttachPath(png, s.roots);
  assert.equal(r.ok, true);
  assert.equal(r.kind, 'image');
  assert.equal(r.mime, 'image/png');
  const note = path.join(s.inbox, 'abc-notes.md');
  fs.writeFileSync(note, '# hi');
  assert.equal(checkAttachPath(note, s.roots).kind, 'file');
});

test('attach paths: relative, traversal, missing, directories and outside-root paths are refused', () => {
  const s = sandbox();
  fs.writeFileSync(path.join(s.work, 'a.png'), PNG);
  fs.writeFileSync(path.join(s.outside, 'secret.png'), PNG);
  const why = (p) => checkAttachPath(p, s.roots);
  assert.match(why('a.png').reason, /absolute/);
  assert.match(why(`${s.work}${path.sep}proj${path.sep}..${path.sep}a.png`).reason, /\.\./, 'even a ".." that stays inside is refused');
  assert.match(why(`${s.work}${path.sep}..${path.sep}outside${path.sep}secret.png`).reason, /\.\./);
  assert.match(why(path.join(s.outside, 'secret.png')).reason, /outside/);
  assert.match(why(path.join(s.work, 'missing.png')).reason, /not found/);
  assert.match(why(path.join(s.work, 'proj')).reason, /not a file/);
  assert.match(why('').reason, /usable/);
  assert.match(why(`${path.join(s.work, 'a.png')}\0.txt`).reason, /usable/);
  assert.match(why(undefined).reason, /usable/);
  // A sibling folder that merely shares the prefix of the root is not inside it.
  const sibling = `${s.work}-evil`;
  fs.mkdirSync(sibling);
  fs.writeFileSync(path.join(sibling, 'x.png'), PNG);
  assert.match(why(path.join(sibling, 'x.png')).reason, /outside/);
});

test('attach paths: only allow-listed extensions; secrets files and empty files are refused', () => {
  const s = sandbox();
  for (const n of ['run.exe', 'script.ps1', 'page.html', 'doc.docx', 'noext', 'data.svg']) {
    fs.writeFileSync(path.join(s.work, n), 'x');
    assert.match(checkAttachPath(path.join(s.work, n), s.roots).reason, /not allowed/, n);
  }
  for (const n of ['notes.txt', 'a.csv', 'b.json', 'c.md', 'd.pdf', 'v.mp4', 'v.mov', 'v.webm', 'i.gif', 'i.jpeg', 'i.webp']) {
    fs.writeFileSync(path.join(s.work, n), 'x');
    assert.equal(checkAttachPath(path.join(s.work, n), s.roots).ok, true, n);
  }
  fs.writeFileSync(path.join(s.work, 'api-token.txt'), 'x');
  fs.writeFileSync(path.join(s.work, 'zero.txt'), '');
  assert.match(checkAttachPath(path.join(s.work, 'api-token.txt'), s.roots).reason, /secrets/);
  assert.match(checkAttachPath(path.join(s.work, 'zero.txt'), s.roots).reason, /empty/);
  fs.mkdirSync(path.join(s.work, '.git'));
  fs.writeFileSync(path.join(s.work, '.git', 'x.png'), PNG);
  assert.match(checkAttachPath(path.join(s.work, '.git', 'x.png'), s.roots).reason, /protected/);
});

test('attach paths: a link inside the root that leads outside is refused', (t) => {
  const s = sandbox();
  fs.writeFileSync(path.join(s.outside, 'private.png'), PNG);
  const link = path.join(s.work, 'proj', 'escape');
  try { fs.symlinkSync(s.outside, link, 'junction'); } catch (e) { t.skip(`cannot create links here: ${e.code}`); return; }
  assert.match(checkAttachPath(path.join(link, 'private.png'), s.roots).reason, /resolves outside/);
  // A file symlink (needs privileges on Windows) pointing out is refused too.
  const fileLink = path.join(s.work, 'proj', 'pic.png');
  try { fs.symlinkSync(path.join(s.outside, 'private.png'), fileLink, 'file'); } catch (e) { if (e.code === 'EPERM') return; throw e; }
  assert.match(checkAttachPath(fileLink, s.roots).reason, /resolves outside/);
});

test('cache key is stable per file+size+mtime and changes when the file changes', () => {
  const s = sandbox();
  const p = path.join(s.work, 'a.png');
  fs.writeFileSync(p, PNG);
  const k1 = cacheKey(checkAttachPath(p, s.roots));
  assert.match(k1, /^[a-f0-9]{24}$/);
  assert.equal(cacheKey(checkAttachPath(p, s.roots)), k1);
  fs.writeFileSync(p, Buffer.concat([PNG, Buffer.from('more')]));
  assert.notEqual(cacheKey(checkAttachPath(p, s.roots)), k1);
});

test('cache pruning removes whole entries, oldest first, until under the cap, sparing kept keys', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ada-cache-'));
  const put = (key, age, sizes) => {
    sizes.forEach((n, i) => {
      const f = path.join(dir, i === 0 ? `${key}.json` : `${key}.part${i}.bin`);
      fs.writeFileSync(f, Buffer.alloc(n, 1));
      const when = new Date(Date.now() - age * 1000);
      fs.utimesSync(f, when, when);
    });
  };
  put('aaaa', 400, [10, 90]);   // oldest, 100 bytes
  put('bbbb', 300, [10, 90]);
  put('cccc', 200, [10, 90]);
  put('dddd', 100, [10, 90]);   // newest
  const keys = () => [...new Set(fs.readdirSync(dir).map((n) => n.split('.')[0]))].sort();
  const r = pruneCache(dir, 250);
  assert.equal(r.removed, 2);
  assert.deepEqual(keys(), ['cccc', 'dddd']);
  assert.ok(r.bytes <= 250);
  // Nothing to do when already under the cap; a kept key survives even if it is the oldest.
  assert.equal(pruneCache(dir, 1000).removed, 0);
  const r2 = pruneCache(dir, 100, ['cccc']);
  assert.deepEqual(keys(), ['cccc']);
  assert.equal(r2.removed, 1);
});

test('without ffmpeg: small images pass through, big ones and videos are refused with a clear message', async () => {
  const s = sandbox();
  const store = new MediaStore({ dir: path.join(s.base, 'cache'), exec: noTools });
  const png = path.join(s.work, 'a.png');
  fs.writeFileSync(png, PNG);
  const meta = await store.prepare(checkAttachPath(png, s.roots));
  assert.equal(meta.kind, 'image');
  assert.equal(meta.thumb, undefined, 'no thumbnail without ffmpeg');
  assert.ok(fs.existsSync(store.filePath(meta.id)));
  assert.equal((await store.prepare(checkAttachPath(png, s.roots))).id, meta.id, 'second call is a cache hit');

  const big = path.join(s.work, 'big.jpg');
  fs.writeFileSync(big, Buffer.alloc(3 * 1024 * 1024, 7));
  await assert.rejects(store.prepare(checkAttachPath(big, s.roots)), /ffmpeg is not installed/);
  assert.equal(store.entry(cacheKey(checkAttachPath(big, s.roots))), null, 'a failed prepare leaves nothing behind');

  const mp4 = path.join(s.work, 'clip.mp4');
  fs.writeFileSync(mp4, 'x'.repeat(100));
  await assert.rejects(store.prepare(checkAttachPath(mp4, s.roots)), /ffmpeg/);
});

test('pdf and text become file cards; only files up to 8 MB are downloadable', async () => {
  const s = sandbox();
  const store = new MediaStore({ dir: path.join(s.base, 'cache'), exec: noTools });
  const small = path.join(s.work, 'n.txt');
  const large = path.join(s.work, 'l.csv');
  fs.writeFileSync(small, 'hello');
  fs.writeFileSync(large, Buffer.alloc(9 * 1024 * 1024, 0x61));
  const a = await store.prepare(checkAttachPath(small, s.roots));
  const b = await store.prepare(checkAttachPath(large, s.roots));
  assert.equal(a.dl, true);
  assert.ok(store.filePath(a.id));
  assert.equal(b.dl, false);
  assert.equal(store.filePath(b.id), null);
  assert.equal(store.entry(b.id).kind, 'file');
});

test('transcriber discovery only uses tools and models that are already installed', () => {
  const none = findTranscriber({ pathDirs: ['/bin'], home: '/h', exists: () => false, list: () => [] });
  assert.equal(none, null);
  const toolNoModel = findTranscriber({ pathDirs: ['/bin'], home: '/h', exists: (p) => /whisper$/.test(p), list: () => [] });
  assert.equal(toolNoModel, null, 'a tool with no cached model would have to download one, so it is not used');
  const ok = findTranscriber({ pathDirs: ['/bin'], home: '/h', exists: (p) => /whisper$/.test(p), list: () => ['base.pt'] });
  assert.equal(ok.tool, 'whisper');
  assert.equal(ok.model, 'base');
  assert.equal(formatSize(1536), '1.5 KB');
  assert.equal(formatSize(5 * 1048576), '5.0 MB');
});

// Real conversion, only where ffmpeg happens to be installed (other machines may not have it).
const ff = spawnSync('ffmpeg', ['-version'], { windowsHide: true });
const hasFfmpeg = ff.status === 0 && spawnSync('ffprobe', ['-version'], { windowsHide: true }).status === 0;

test('with ffmpeg: big images are shrunk to 1600px with a small thumbnail; video becomes mp4 with a poster', { skip: !hasFfmpeg && 'ffmpeg not installed' }, async () => {
  const s = sandbox();
  const store = new MediaStore({ dir: path.join(s.base, 'cache') });
  const img = path.join(s.work, 'wide.png');
  assert.equal(spawnSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=3200x1800', '-frames:v', '1', img], { windowsHide: true }).status, 0);
  const im = await store.prepare(checkAttachPath(img, s.roots));
  assert.ok(im.w <= 1600 && im.h <= 1600, `${im.w}x${im.h}`);
  assert.ok(im.bytes < fs.statSync(img).size);
  assert.ok(im.thumb.startsWith('data:image/jpeg;base64,') && im.thumb.length <= THUMB_MAX);

  const vid = path.join(s.work, 'clip.mp4');
  assert.equal(spawnSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=24', '-t', '3', '-pix_fmt', 'yuv420p', vid], { windowsHide: true }).status, 0);
  const v = await store.prepare(checkAttachPath(vid, s.roots));
  assert.equal(v.mime, 'video/mp4');
  assert.ok(v.h <= 720, `height ${v.h}`);
  assert.ok(v.bytes <= 20 * 1048576);
  assert.ok(store.filePath(v.id, 'poster'), 'poster frame exists');
  assert.ok(v.thumb && v.thumb.length <= THUMB_MAX);
  const frames = await store.frames(vid, path.join(s.inbox, 'x-clip'), 8);
  assert.equal(frames.length, 3, 'a 3 second clip yields one frame per second, up to 8');
  assert.ok(frames.every((f) => fs.existsSync(f)));
});
