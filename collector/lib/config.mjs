// Local, never-committed settings live in ~/.ada-viewer/config.json:
// { "password": "...", "salt": "<auto>", "workRoot": "C:\\Work", "intervalSec": 10 }
// ADA_VIEWER_PASSWORD overrides the password.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { newSalt } from './crypto.mjs';

export const STATE_DIR = path.join(os.homedir(), '.ada-viewer');
const FILE = path.join(STATE_DIR, 'config.json');

export function loadConfig() {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch {}
  let changed = false;
  if (!cfg.salt) { cfg.salt = newSalt(); changed = true; }
  if (!cfg.workRoot) { cfg.workRoot = 'C:\\Work'; changed = true; }
  if (!cfg.intervalSec) { cfg.intervalSec = 10; changed = true; }
  if (changed) fs.writeFileSync(FILE, JSON.stringify(cfg, null, 2));
  cfg.password = process.env.ADA_VIEWER_PASSWORD || cfg.password;
  if (!cfg.password) {
    throw new Error(`No password set. Put "password" in ${FILE} or set ADA_VIEWER_PASSWORD.`);
  }
  return cfg;
}
