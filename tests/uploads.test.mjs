import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { UploadManager, UPLOAD, sanitizeName, mimeMatches, signatureOk } from '../collector/lib/uploads.mjs';
import { ChatHub, attachmentLines } from '../collector/lib/chat.mjs';
import { MediaStore } from '../collector/lib/media.mjs';
import { LimitTracker } from '../collector/lib/limits.mjs';
import { FullModePolicy } from '../collector/lib/fullmode.mjs';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const CS = UPLOAD.minChunk; // 8 KB chunks keep the tests small
const noTools = async () => ({ code: -1, stdout: '', stderr: 'not installed' });
let seq = 0;
const hex = (n = 12) => (++seq).toString(16).padStart(n, 'a');

// A file's worth of chunk commands, in order. Override fields to make hostile variants.
function chunks(buf, { up = hex(), grp = hex(), gn = 1, name = 'pic.png', mime = 'image/png', cs = CS, note = '', ts = Date.now() } = {}) {
  const n = Math.ceil(buf.length / cs);
  return Array.from({ length: n }, (_, i) => ({
    kind: 'cmd', id: `k${++seq}`, ts, type: 'upload-chunk', up, grp, gn, i, n, cs, size: buf.length, name, mime,
    d: buf.subarray(i * cs, (i + 1) * cs).toString('base64'), ...(i === 0 ? { note, brain: { agent: 'claude', model: '' } } : {}),
  }));
}

const pngOf = (size) => Buffer.concat([PNG.subarray(0, 8), Buffer.alloc(size - 8, 1)]);

function manager(opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ada-up-'));
  const clock = { t: 1_000_000, now: () => clock.t };
  const groups = [];
  const m = new UploadManager({ dir, now: clock.now, onGroup: (g) => groups.push(g), ...opts });
  m.init();
  return { m, dir, clock, groups };
}

test('chunks may arrive out of order and with duplicates; the file is reassembled byte for byte', () => {
  const { m, dir, groups } = manager();
  const buf = pngOf(CS * 3 + 100);
  const cs = chunks(buf, { name: 'Holiday photo.png', note: 'look' });
  assert.equal(cs.length, 4);
  for (const c of [cs[2], cs[0], cs[2], cs[3]]) {
    const r = m.chunk(c);
    assert.ok(r === null || r === 'duplicate', String(r));
  }
  assert.equal(groups.length, 0, 'not finished: chunk 1 is missing');
  assert.equal(m.chunk(cs[0]), 'duplicate');
  assert.equal(m.chunk(cs[1]), null);
  assert.equal(groups.length, 1);
  const [f] = groups[0].done;
  assert.equal(groups[0].note, 'look');
  assert.deepEqual(fs.readFileSync(f.path), buf);
  assert.equal(path.dirname(f.path), dir);
  assert.equal(path.basename(f.path), `${cs[0].up}-Holiday photo.png`);
  assert.deepEqual(fs.readdirSync(path.join(dir, '.partial')), [], 'no partial left behind');
});

test('a finished upload cannot be replayed: its chunks are refused afterwards', () => {
  const { m, groups } = manager();
  const cs = chunks(pngOf(CS + 5));
  for (const c of cs) assert.equal(m.chunk(c), null);
  assert.equal(groups.length, 1);
  assert.equal(m.chunk(cs[0]), 'replayed');
  assert.equal(groups.length, 1, 'no second file appears');
  // The remembered ids survive a restart through dumpRecent().
  const again = new UploadManager({ dir: fs.mkdtempSync(path.join(os.tmpdir(), 'ada-up2-')), recent: m.dumpRecent(), onGroup: () => assert.fail('replayed upload completed') });
  again.init();
  assert.equal(again.chunk(cs[1]), 'replayed');
});

test('missing chunks: the upload times out after 10 minutes, the partial file is deleted and the group is told', () => {
  const { m, dir, clock, groups } = manager();
  const cs = chunks(pngOf(CS * 2 + 1));
  m.chunk(cs[0]); m.chunk(cs[2]);
  assert.deepEqual(fs.readdirSync(path.join(dir, '.partial')), [`${cs[0].up}.part`]);
  assert.deepEqual(m.status().find((s) => s.id === cs[0].up).miss, [1]);
  clock.t += UPLOAD.timeoutMs - 1000;
  m.sweep();
  assert.equal(groups.length, 0);
  clock.t += 2000;
  m.sweep();
  assert.deepEqual(fs.readdirSync(path.join(dir, '.partial')), []);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].done.length, 0);
  assert.match(groups[0].failed[0].reason, /timed out/);
  assert.equal(m.chunk(cs[1]), 'replayed', 'late chunks of an expired upload are refused');
  assert.equal(m.status().find((s) => s.id === cs[0].up).state, 'failed');
});

test('size and layout limits: over 25 MB, zero bytes, bad chunk sizes and wrong chunk counts are refused', () => {
  const { m, groups } = manager();
  const ok = chunks(pngOf(CS + 1));
  const bump = (fields) => ({ ...ok[0], up: hex(), ...fields });
  const big = UPLOAD.maxBytes + 1;
  assert.match(m.chunk(bump({ size: big, n: Math.ceil(big / CS) })), /1 byte to 25 MB/);
  assert.match(m.chunk(bump({ size: 0, n: 0 })), /1 byte to 25 MB/);
  assert.match(m.chunk(bump({ cs: 100 })), /chunk layout/);
  assert.match(m.chunk(bump({ cs: UPLOAD.maxChunk * 2 })), /chunk layout/);
  assert.match(m.chunk(bump({ n: 99 })), /chunk layout/);
  assert.equal(m.chunk(bump({ i: 'x' })), 'bad chunk header');
  assert.equal(m.chunk(bump({ up: '../../etc' })), 'bad upload id');
  assert.equal(m.chunk(bump({ d: 'A'.repeat(200000) })), 'bad chunk data');
  assert.equal(m.active.size, 0, 'nothing was stored for any of them');
  assert.equal(groups.length, 5, 'each refused file is reported to its group (the five with a valid header)');
  // Exactly 25 MB is fine (a layout of 8 KB chunks is 3200 chunks, the maximum).
  const edge = bump({ size: UPLOAD.maxBytes, n: Math.ceil(UPLOAD.maxBytes / CS) });
  assert.equal(m.chunk(edge), null);
});

test('a chunk with the wrong length, out of range, or contradicting the first chunk is refused', () => {
  const { m } = manager();
  const cs = chunks(pngOf(CS * 2 + 10));
  assert.equal(m.chunk(cs[0]), null);
  assert.equal(m.chunk({ ...cs[1], d: Buffer.alloc(CS - 1).toString('base64') }), 'wrong chunk length');
  assert.equal(m.chunk({ ...cs[2], d: Buffer.alloc(CS).toString('base64') }), 'wrong chunk length', 'last chunk must be the remainder');
  assert.equal(m.chunk({ ...cs[1], i: 7 }), 'chunk out of range');
  assert.equal(m.chunk({ ...cs[1], size: cs[1].size + 1 }), 'inconsistent chunk');
  assert.equal(m.chunk({ ...cs[1], grp: hex() }), 'inconsistent chunk');
});

test('file names are sanitised: no path parts, no reserved characters, bounded length', () => {
  assert.equal(sanitizeName('..\\..\\Windows\\system32\\evil.png'), 'evil.png');
  assert.equal(sanitizeName('../../etc/passwd.txt'), 'passwd.txt');
  assert.equal(sanitizeName('C:\\Users\\me\\a:b*c?.png'), 'a_b_c_.png');
  assert.equal(sanitizeName('  ..hidden.png  '), 'hidden.png');
  assert.equal(sanitizeName('trailing dots...'), 'trailing dots');
  assert.equal(sanitizeName('bad\u0000\u0007name.txt'), 'badname.txt');
  assert.equal(sanitizeName(''), 'file');
  assert.equal(sanitizeName(undefined), 'file');
  assert.equal(sanitizeName('<script>.png'), '_script_.png');
  const long = sanitizeName(`${'x'.repeat(500)}.png`);
  assert.ok(long.length <= 84 && long.endsWith('.png'), long.length);
  assert.equal(sanitizeName('صورة.png'), 'صورة.png', 'letters from any script are kept');
});

test('the saved name keeps the upload id prefix and stays inside the inbox even for hostile names', () => {
  const { m, dir, groups } = manager();
  for (const c of chunks(pngOf(CS + 1), { name: '..\\..\\..\\Startup\\pwn.png' })) m.chunk(c);
  const p = groups[0].done[0].path;
  assert.equal(path.dirname(p), dir);
  assert.match(path.basename(p), /^[a-f0-9]+-pwn\.png$/);
});

test('extensions and mime types outside the allow-list are rejected; nothing is written', () => {
  const { m, dir, groups } = manager();
  for (const name of ['setup.exe', 'run.bat', 'x.ps1', 'page.html', 'icon.svg', 'noext', 'a.png.exe', '.png']) {
    assert.match(m.chunk(chunks(pngOf(CS + 1), { name })[0]), /not allowed/, name);
  }
  assert.match(m.chunk(chunks(pngOf(CS + 1), { mime: 'application/x-msdownload' })[0]), /does not match/);
  assert.equal(m.chunk(chunks(pngOf(CS + 1), { mime: '' })[0]), null, 'phones often send an empty mime');
  assert.equal(m.active.size, 1);
  assert.equal(groups.length, 9, 'each refusal is reported to its group');
  assert.deepEqual(fs.readdirSync(dir).filter((n) => n !== '.partial'), []);
});

test('content must look like its extension: a program renamed .png is deleted', () => {
  const { m, dir, groups } = manager();
  for (const c of chunks(Buffer.concat([Buffer.from('MZ'), Buffer.alloc(CS)]), { name: 'photo.png' })) m.chunk(c);
  assert.equal(groups[0].done.length, 0);
  assert.match(groups[0].failed[0].reason, /do not look like a \.png/);
  assert.deepEqual(fs.readdirSync(dir).filter((n) => n !== '.partial'), []);
  assert.equal(signatureOk('pdf', Buffer.from('%PDF-1.7 ...')), true);
  assert.equal(signatureOk('txt', Buffer.from([65, 0, 66])), false);
  assert.equal(mimeMatches('mov', 'video/quicktime'), true);
  assert.equal(mimeMatches('pdf', 'image/png'), false);
});

test('rate limit: at most 10 files and 100 MB per 10 minutes, then it frees up again', () => {
  const { m, clock } = manager({ limits: { ...UPLOAD, maxActive: 50 } });
  const start = (size = CS + 1) => m.chunk(chunks(pngOf(size), { gn: 10 })[0]);
  for (let i = 0; i < 10; i++) assert.equal(start(), null, `file ${i + 1}`);
  assert.match(start(), /10 files per 10 minutes/);
  clock.t += UPLOAD.windowMs + 1;
  m.sweep();
  assert.equal(start(UPLOAD.maxBytes), null);
  assert.equal(start(UPLOAD.maxBytes), null);
  assert.equal(start(UPLOAD.maxBytes), null);
  assert.equal(start(UPLOAD.maxBytes), null);
  assert.match(start(UPLOAD.maxBytes), /100 MB per 10 minutes/);
});

test('at most four uploads at once', () => {
  const { m } = manager();
  for (let i = 0; i < 4; i++) assert.equal(m.chunk(chunks(pngOf(CS * 2), { gn: 6 })[0]), null);
  assert.match(m.chunk(chunks(pngOf(CS * 2), { gn: 6 })[0]), /too many uploads/);
});

test('a group of files completes together and carries the note and brain from the first chunk', () => {
  const { m, groups } = manager();
  const grp = hex();
  const a = chunks(pngOf(CS + 3), { grp, gn: 2, name: 'a.png', note: 'two pics' });
  const b = chunks(pngOf(CS + 4), { grp, gn: 2, name: 'b.png' });
  for (const c of a) m.chunk(c);
  assert.equal(groups.length, 0, 'waits for the second file');
  for (const c of [...b].reverse()) m.chunk(c);
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].done.map((f) => f.name).sort(), ['a.png', 'b.png']);
  assert.equal(groups[0].note, 'two pics');
});

test('startup removes partial files left by a crash', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ada-up3-'));
  fs.mkdirSync(path.join(dir, '.partial'));
  fs.writeFileSync(path.join(dir, '.partial', 'dead.part'), 'x');
  fs.writeFileSync(path.join(dir, 'keep-me.png'), 'x');
  new UploadManager({ dir }).init();
  assert.deepEqual(fs.readdirSync(path.join(dir, '.partial')), []);
  assert.ok(fs.existsSync(path.join(dir, 'keep-me.png')), 'finished uploads are not touched');
});

// ---- through the chat hub: replay window, completion message, prompt ----

function hubSetup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ada-hub-'));
  const work = path.join(root, 'work');
  const state = path.join(root, 'state');
  fs.mkdirSync(path.join(work, 'proj'), { recursive: true });
  fs.mkdirSync(state, { recursive: true });
  const clock = { t: Date.now(), now: () => clock.t };
  const heads = [];
  const sent = [];
  const services = {
    now: clock.now,
    limits: new LimitTracker({ now: clock.now }),
    appendTaskEvent: () => {},
    media: new MediaStore({ dir: path.join(state, 'media-cache'), exec: noTools }),
    transcribe: async () => null,
    runAgent(o) {
      heads.push(o);
      return { child: { kill() {}, pid: 1 }, done: Promise.resolve({ ok: true, text: services.reply || 'noted', session: 's1' }) };
    },
  };
  services.policy = new FullModePolicy({ stateDir: state, workRoot: work, hardRoot: work, projects: () => [], now: clock.now });
  const hub = new ChatHub({ workRoot: work, projects: () => [], stateDir: state, services, mediaOut: async (o) => { sent.push(o); }, relayMedia: () => true });
  let n = 0;
  const cmd = (type, extra = {}) => ({ kind: 'cmd', id: `c${++n}`, ts: clock.now(), type, ...extra });
  const flush = async () => { for (let i = 0; i < 12; i++) await new Promise((r) => setImmediate(r)); };
  return { root, work, state, clock, hub, services, heads, sent, cmd, flush };
}

test('a large upload does not evict the 500-entry replay window; ordinary commands are still deduplicated', async () => {
  const s = hubSetup();
  const first = s.cmd('stop');
  assert.equal(s.hub.handle(first), null);
  assert.equal(s.hub.handle(first), 'replayed');
  // 600 chunks (more than the whole window) of one 25 MB-class upload, each with its own command id.
  const buf = pngOf(CS * 600);
  const cs = chunks(buf, { ts: s.clock.now() });
  for (const c of cs) assert.equal(s.hub.handle(c), null);
  await s.flush();
  assert.equal(s.hub.state.seen.length, 1, 'chunks never enter the shared window');
  assert.equal(s.hub.handle(first), 'replayed', 'the earlier command is still remembered');
  assert.equal(s.hub.handle(cs[0]), 'replayed', 'and the finished upload cannot be replayed');
  assert.deepEqual(s.hub.state.uploadsDone, [cs[0].up], 'persisted so it survives a restart');
});

test('stale chunks (outside the clock window) are refused like any other command', () => {
  const s = hubSetup();
  const old = chunks(pngOf(CS + 1), { ts: s.clock.now() - 11 * 60e3 });
  assert.equal(s.hub.handle(old[0]), 'stale');
  assert.equal(s.hub.uploads.active.size, 0);
});

test('a finished upload posts Nefer\'s message with cards, then Ada gets the paths and the inbox is added to her folders', async () => {
  const s = hubSetup();
  const grp = hex();
  const png = chunks(pngOf(CS + 20), { grp, gn: 2, name: 'screen.png', note: 'what is wrong here?', ts: s.clock.now() });
  const txt = chunks(Buffer.from('some notes\nline two'), { grp, gn: 2, name: 'notes.txt', mime: 'text/plain', ts: s.clock.now() });
  for (const c of [...png, ...txt]) assert.equal(s.hub.handle(c), null);
  await s.flush();
  const msg = s.hub.state.thread.messages.find((m) => m.role === 'user');
  assert.equal(msg.text, 'what is wrong here?');
  assert.equal(msg.grp, grp);
  assert.deepEqual(msg.atts.map((a) => [a.kind, a.name, a.state]), [['image', 'screen.png', 'ready'], ['file', 'notes.txt', 'ready']]);
  // Ada was asked, with the attachment lines in the prompt and the inbox readable.
  assert.equal(s.heads.length, 1);
  const head = s.heads[0];
  assert.equal(head.role, 'head');
  assert.ok(head.addDirs.includes(s.hub.inbox));
  assert.match(head.prompt, /\[Nefer\] what is wrong here\?/);
  const inboxPath = (name) => path.join(s.hub.inbox, `${png[0].up}-${name}`);
  assert.ok(head.prompt.includes(`[Nefer attached: ${inboxPath('screen.png')} (image, `), head.prompt);
  assert.ok(head.prompt.includes(`[Nefer attached: ${path.join(s.hub.inbox, `${txt[0].up}-notes.txt`)} (file, 19 B)]`), head.prompt);
  // The page sees metadata only: no laptop paths, no frames list.
  const view = s.hub.view();
  const shown = view.thread.messages.find((m) => m.atts);
  assert.ok(shown.atts.every((a) => !('src' in a) && !('frames' in a)));
  assert.equal(view.media.relay, true);
  assert.ok(view.uploads.some((u) => u.id === png[0].up && u.state === 'done'));
  // Ada's system prompt documents both directions.
  const sys = head.system;
  assert.match(sys, /<attach>/);
  assert.match(sys, /25 MB/);
  assert.match(sys, /cannot play video/);
  assert.match(sys, /Safe-mode workers cannot read/);
});

test('Ada waits for a video\'s frames before the turn starts, and the prompt lists frames and transcript status', async () => {
  const s = hubSetup();
  let release;
  const gate = new Promise((r) => { release = r; });
  // Pretend ffmpeg produced frames; it blocks until released so we can see the hold.
  s.hub.media.frames = async (file, prefix) => { await gate; return [`${prefix}-frame01.jpg`, `${prefix}-frame02.jpg`]; };
  const mp4 = Buffer.concat([Buffer.alloc(4), Buffer.from('ftypisom'), Buffer.alloc(CS)]);
  for (const c of chunks(mp4, { name: 'clip.mp4', mime: 'video/mp4', ts: s.clock.now() })) s.hub.handle(c);
  await s.flush();
  assert.equal(s.heads.length, 0, 'held while frames are extracted');
  assert.equal(s.hub.view().thread.messages.length, 1);
  release();
  await s.flush();
  assert.equal(s.heads.length, 1);
  assert.match(s.heads[0].prompt, /\[Nefer\] \(no message, just the attachments\)/);
  assert.match(s.heads[0].prompt, /clip\.mp4 \(video, /);
  assert.match(s.heads[0].prompt, /Video frames from clip\.mp4.*frame01\.jpg ; .*frame02\.jpg/);
  assert.match(s.heads[0].prompt, /No transcript: no local speech-to-text tool is installed, so frames only/);
});

test('attachmentLines: only Nefer\'s own uploads are described; video without frames says so', () => {
  assert.deepEqual(attachmentLines(), []);
  assert.deepEqual(attachmentLines([{ id: 'x', kind: 'image', name: 'ada.png', size: 10, src: 'C:\\Work\\ada.png' }]), [], 'files Ada sent are not echoed back');
  const lines = attachmentLines([
    { up: true, kind: 'image', name: 'a.png', size: 2048, src: 'C:\\in\\1-a.png' },
    { up: true, kind: 'video', name: 'v.mp4', size: 3 * 1048576, src: 'C:\\in\\2-v.mp4', frames: [], transcript: 'C:\\in\\2-v.transcript.txt' },
  ]);
  assert.equal(lines[0], '[Nefer attached: C:\\in\\1-a.png (image, 2.0 KB)]');
  assert.equal(lines[1], '[Nefer attached: C:\\in\\2-v.mp4 (video, 3.0 MB)]');
  assert.match(lines[2], /no frames could be extracted/);
  assert.equal(lines[3], '[Transcript of v.mp4: C:\\in\\2-v.transcript.txt]');
});

test('incomplete upload: the group reports the failure in chat and Ada is not asked', async () => {
  const s = hubSetup();
  const cs = chunks(pngOf(CS * 2 + 1), { ts: s.clock.now() });
  s.hub.handle(cs[0]);
  s.clock.t += UPLOAD.timeoutMs + 1000;
  s.hub.uploads.sweep();
  await s.flush();
  assert.equal(s.heads.length, 0);
  const sys = s.hub.state.thread.messages.filter((m) => m.role === 'system').map((m) => m.text).join('\n');
  assert.match(sys, /Upload of "pic\.png" failed: timed out/);
  assert.equal(s.hub.state.thread.messages.find((m) => m.role === 'system').grp, cs[0].grp, 'the page can tell which batch failed');
});

// ---- Ada's <attach> blocks and the media-get transfer ----

async function adaSends(s, files, extra = '') {
  s.services.reply = `Here you go.\n<attach>${JSON.stringify(files)}</attach>${extra}`;
  assert.equal(s.hub.handle(s.cmd('say', { text: 'show me' })), null);
  await s.flush();
  return s.hub.state.thread.messages.find((m) => m.role === 'ada');
}

test('<attach>: valid files become cards (max 6), the block is stripped from her text, bad paths are reported', async () => {
  const s = hubSetup();
  const proj = path.join(s.work, 'proj');
  const paths = [];
  for (let i = 0; i < 8; i++) { const p = path.join(proj, `shot${i}.png`); fs.writeFileSync(p, Buffer.concat([PNG, Buffer.from([i])])); paths.push(p); }
  const outside = path.join(s.root, 'outside.png');
  fs.writeFileSync(outside, PNG);
  const reply = await adaSends(s, [{ path: outside }, { path: `${proj}${path.sep}..${path.sep}x.png` }, { path: path.join(proj, 'run.exe') }, ...paths.map((p, i) => ({ path: p, caption: `cap ${i}` }))]);
  assert.equal(reply.text, 'Here you go.');
  const sys = s.hub.state.thread.messages.filter((m) => m.role === 'system').map((m) => m.text).join('\n');
  assert.match(sys, /outside\.png": outside the allowed folders/);
  assert.match(sys, /must not contain \.\./);
  // the first three specs were refused but still count toward the cap of six looked at
  assert.equal(reply.atts.length, 3);
  assert.ok(reply.atts.every((a) => a.kind === 'image' && a.state === 'ready'));
  assert.equal(reply.atts[0].caption, 'cap 0');

  const s2 = hubSetup();
  const many = [];
  for (let i = 0; i < 8; i++) { const p = path.join(s2.work, 'proj', `m${i}.png`); fs.writeFileSync(p, Buffer.concat([PNG, Buffer.from([i])])); many.push({ path: p }); }
  assert.equal((await adaSends(s2, many)).atts.length, 6);
});

test('<attach>: invalid JSON is reported and nothing is attached; jobs blocks still work next to it', async () => {
  const s = hubSetup();
  s.services.reply = 'oops <attach>[{"path": </attach>';
  s.hub.handle(s.cmd('say', { text: 'x' }));
  await s.flush();
  const msgs = s.hub.state.thread.messages;
  assert.equal(msgs.find((m) => m.role === 'ada').atts, undefined);
  assert.match(msgs.find((m) => m.role === 'system').text, /attach block was not valid JSON/);
});

test('media-get streams sealed-ready chunks that reassemble to the cached bytes; "need" resends only those', async () => {
  const s = hubSetup();
  const txt = path.join(s.work, 'proj', 'big.txt');
  const body = Buffer.alloc(48 * 1024 * 2 + 500, 0x61);
  fs.writeFileSync(txt, body);
  const reply = await adaSends(s, [{ path: txt }]);
  const id = reply.atts[0].id;
  assert.equal(reply.atts[0].dl, true);
  assert.equal(s.hub.handle(s.cmd('media-get', { media: id })), null);
  await s.flush();
  assert.equal(s.sent.length, 3);
  assert.ok(s.sent.every((o) => o.id === id && o.n === 3 && o.size === body.length && o.mime === 'text/plain'));
  assert.deepEqual(Buffer.concat(s.sent.map((o) => Buffer.from(o.d, 'base64'))), body);
  s.sent.length = 0;
  s.hub.handle(s.cmd('media-get', { media: id, need: [1, 99, -4, 'x'] }));
  await s.flush();
  assert.deepEqual(s.sent.map((o) => o.i), [1]);
});

test('media-get refuses ids that are not attachments in the chat, and malformed ids', async () => {
  const s = hubSetup();
  const txt = path.join(s.work, 'proj', 'n.txt');
  fs.writeFileSync(txt, 'hi');
  await adaSends(s, [{ path: txt }]);
  assert.equal(s.hub.handle(s.cmd('media-get', { media: 'a'.repeat(24) })), 'unknown media');
  assert.equal(s.hub.handle(s.cmd('media-get', { media: '../../config' })), 'bad media id');
  assert.equal(s.hub.handle(s.cmd('media-get', {})), 'bad media id');
  await s.flush();
  assert.equal(s.sent.length, 0);
});

test('files over 8 MB show as cards that cannot be downloaded', async () => {
  const s = hubSetup();
  const csv = path.join(s.work, 'proj', 'huge.csv');
  fs.writeFileSync(csv, Buffer.alloc(9 * 1024 * 1024, 0x2c));
  const reply = await adaSends(s, [{ path: csv }]);
  assert.equal(reply.atts[0].dl, false);
  s.hub.handle(s.cmd('media-get', { media: reply.atts[0].id }));
  await s.flush();
  assert.match(s.sent[0].err, /too large to download/);
});

test('history keeps the cards: a pruned cache is rebuilt from the original; a deleted original shows "expired"', async () => {
  const s = hubSetup();
  const txt = path.join(s.work, 'proj', 'keep.txt');
  fs.writeFileSync(txt, 'remember me');
  const reply = await adaSends(s, [{ path: txt }]);
  const id = reply.atts[0].id;
  // survives a restart: the metadata is in chat.json
  const reopened = new ChatHub({ workRoot: s.work, projects: () => [], stateDir: s.state, services: { ...s.services, runAgent: () => { throw new Error('no run expected'); } }, mediaOut: async (o) => s.sent.push(o) });
  assert.equal(reopened.view().thread.messages.find((m) => m.atts).atts[0].name, 'keep.txt');
  // cache wiped (pruned): still served, rebuilt from the file on disk
  fs.rmSync(path.join(s.state, 'media-cache'), { recursive: true, force: true });
  assert.equal(reopened.view().thread.messages.find((m) => m.atts).atts[0].state, 'ready');
  reopened.handle({ kind: 'cmd', id: 'r1', ts: Date.now(), type: 'media-get', media: id });
  await s.flush();
  assert.equal(Buffer.from(s.sent.at(-1).d, 'base64').toString(), 'remember me');
  // original gone and cache gone: expired
  fs.rmSync(path.join(s.state, 'media-cache'), { recursive: true, force: true });
  fs.unlinkSync(txt);
  assert.equal(reopened.view().thread.messages.find((m) => m.atts).atts[0].state, 'expired');
  reopened.handle({ kind: 'cmd', id: 'r2', ts: Date.now(), type: 'media-get', media: id });
  await s.flush();
  assert.equal(s.sent.at(-1).err, 'expired');
});

test('only the newest sixteen thumbnails travel in the snapshot', async () => {
  const s = hubSetup();
  s.hub.state.thread.messages.push(...Array.from({ length: 20 }, (_, i) => ({ id: `m${i}`, t: i, role: 'ada', text: 'x', atts: [{ id: `${i}`.padStart(24, '0'), kind: 'image', name: `${i}.png`, size: 1, state: 'failed', thumb: 'data:image/jpeg;base64,AAAA' }] })));
  const shown = s.hub.view().thread.messages.filter((m) => m.atts);
  assert.equal(shown.filter((m) => m.atts[0].thumb).length, 16);
  assert.ok(shown.slice(-16).every((m) => m.atts[0].thumb), 'the newest keep theirs');
});
