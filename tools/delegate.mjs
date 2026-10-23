#!/usr/bin/env node
// Hand a job to Codex and log it on the viewer from start to finish.
//   node tools/delegate.mjs --title "Grass albedo 2k" --cd "C:\Work\..." [--image ref.png] -- "prompt"
// Prints Codex's final message. New files in ~/.codex/generated_images are attached as outputs.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { appendTaskEvent } from '../collector/lib/tasks.mjs';

const argv = process.argv.slice(2);
const sep = argv.indexOf('--');
const flags = sep >= 0 ? argv.slice(0, sep) : argv.slice(0, -1);
const prompt = sep >= 0 ? argv.slice(sep + 1).join(' ') : argv.at(-1);
const opt = { images: [] };
for (let i = 0; i < flags.length; i += 2) {
  const k = flags[i].replace(/^--/, '');
  if (k === 'image') opt.images.push(flags[i + 1]); else opt[k] = flags[i + 1];
}
if (!prompt) { console.error('usage: delegate.mjs --title T --cd DIR -- "prompt"'); process.exit(1); }

const cwd = opt.cd || process.cwd();
const id = crypto.randomBytes(4).toString('hex');
const imgRoot = path.join(os.homedir(), '.codex', 'generated_images');
const started = Date.now();
const lastMsg = path.join(os.tmpdir(), `ada-delegate-${id}.txt`);

appendTaskEvent({ id, status: 'running', agent: 'codex', title: opt.title || prompt.slice(0, 60), cwd, preview: 'Started' });

const args = ['exec', '--skip-git-repo-check', '-C', cwd, '-o', lastMsg, '-s', opt.sandbox || 'workspace-write'];
for (const im of opt.images) args.push('-i', im);
args.push('-');

// codex is a real .exe, so no shell: paths with spaces stay intact.
const child = spawn('codex', args, { cwd, windowsHide: true });
child.on('error', (err) => { tail += `\nERROR: ${err.message}`; });
child.stdin.end(prompt);
let tail = '';
const keep = (d) => { tail = (tail + d.toString()).slice(-4000); };
child.stdout.on('data', keep);
child.stderr.on('data', keep);

function newImages() {
  const out = [];
  try {
    for (const d of fs.readdirSync(imgRoot)) {
      const dir = path.join(imgRoot, d);
      for (const f of fs.readdirSync(dir)) {
        const p = path.join(dir, f);
        if (fs.statSync(p).mtimeMs >= started) out.push({ path: p, type: 'image' });
      }
    }
  } catch {}
  return out;
}

child.on('close', (code) => {
  let msg = '';
  try { msg = fs.readFileSync(lastMsg, 'utf8').trim(); fs.unlinkSync(lastMsg); } catch {}
  const outputs = newImages();
  const session = tail.match(/session id:\s*([0-9a-f-]{36})/i)?.[1];
  // On failure, surface the API's error message rather than the banner.
  const apiErr = [...tail.matchAll(/"message":"([^"]+)"/g)].pop()?.[1];
  const errLine = tail.split('\n').reverse().find((l) => /^ERROR/.test(l));
  const preview = (msg || (code !== 0 && (apiErr || errLine)) || tail).replace(/\s+/g, ' ').slice(0, 240);
  appendTaskEvent({ id, status: code === 0 ? 'done' : 'failed', preview, ...(session ? { session } : {}), ...(outputs.length ? { outputs } : {}) });
  console.log(msg || tail);
  if (outputs.length) console.log('\nImages:\n' + outputs.map((o) => o.path).join('\n'));
  process.exit(code ?? 1);
});
