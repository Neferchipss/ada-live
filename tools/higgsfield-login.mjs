#!/usr/bin/env node
// One-time, manual sign-in in Ada Live's dedicated Higgsfield browser profile.
// Run from the project folder: node tools/higgsfield-login.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HIGGSFIELD_PROFILE, launchHiggsfieldLogin } from '../collector/lib/higgsfield.mjs';

console.log(`[higgsfield] Opening the dedicated profile: ${HIGGSFIELD_PROFILE}`);
let email = null;
try { email = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.ada-viewer', 'config.json'), 'utf8')).higgsfieldEmail || null; } catch {}
console.log(`[higgsfield] Sign in${email ? ` as ${email}` : ' with your Higgsfield account'} in the browser, then close that window.`);
console.log('[higgsfield] If the collector is running, stop it while signing in. Restart it after closing the window.');

try {
  await launchHiggsfieldLogin();
  console.log('[higgsfield] Browser closed. Restart the collector: node collector/collect.mjs');
} catch (e) {
  console.error(`[higgsfield] ${e.message}`);
  process.exitCode = 1;
}
