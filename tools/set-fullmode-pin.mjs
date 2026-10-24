#!/usr/bin/env node
// Run locally in an interactive terminal. The PIN is never accepted in argv,
// echoed, logged, or stored in plaintext. Existing config fields are preserved.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { STATE_DIR } from '../collector/lib/config.mjs';
import { createPinHash, ensureOps } from '../collector/lib/fullmode.mjs';

function secret(question) {
  return new Promise((resolve, reject) => {
    let value = '';
    process.stdout.write(question);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    const finish = (error) => {
      process.stdin.removeListener('keypress', keypress);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write('\n');
      if (error) reject(error); else resolve(value);
      value = '';
    };
    const keypress = (text, key = {}) => {
      if (key.ctrl && key.name === 'c') { finish(new Error('Cancelled; PIN unchanged.')); return; }
      if (key.name === 'return' || key.name === 'enter') { finish(); return; }
      if (key.name === 'backspace') { value = value.slice(0, -1); return; }
      if (typeof text === 'string' && /^\d+$/.test(text) && value.length + text.length <= 12) value += text;
    };
    process.stdin.on('keypress', keypress);
  });
}

try {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('Run this script in an interactive terminal on the laptop.');
  readline.emitKeypressEvents(process.stdin);
  let pin = await secret('New approval PIN (6–12 digits, hidden): ');
  let confirmation = await secret('Repeat approval PIN (hidden): ');
  if (pin !== confirmation) throw new Error('PINs did not match; nothing changed.');
  const fullModePin = createPinHash(pin);
  pin = ''; confirmation = '';
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const file = path.join(STATE_DIR, 'config.json');
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { if (e.code !== 'ENOENT') throw new Error('Cannot read config.json; repair it before setting the PIN.'); }
  if (!cfg || Array.isArray(cfg) || typeof cfg !== 'object') throw new Error('config.json must contain an object; nothing changed.');
  // Initialize the allowlist only when absent, never replacing local operations.
  const workRoot = cfg.workRoot || 'C:\\Work';
  const projects = fs.readdirSync(workRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({ name: entry.name, path: path.join(workRoot, entry.name) }));
  ensureOps({ workRoot, projects });
  const tmp = path.join(STATE_DIR, `config.pin-${process.pid}.tmp`);
  try {
    fs.writeFileSync(tmp, JSON.stringify({ ...cfg, fullModePin }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    fs.renameSync(tmp, file);
  } finally { try { fs.unlinkSync(tmp); } catch {} }
  console.log('Approval PIN saved as a salted scrypt hash. Existing settings and operations were preserved.');
  console.log('Restart the collector, then approve each FULL/OPS job separately on the phone.');
} catch (e) {
  console.error(e.message);
  process.exitCode = 1;
}
