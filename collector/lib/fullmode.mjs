// Per-job approval policy. No PIN, config hash, or approval digest belongs in the feed.
// Importing this module has no filesystem side effects; setup happens at runtime.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { STATE_DIR } from './config.mjs';

export const APPROVAL_MS = 5 * 60e3;
export const MAX_PIN_TRIES = 5;
const PIN_MESSAGE = 'Approval PIN not set. Run node tools/set-fullmode-pin.mjs on the laptop.';
const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const normalizeMode = (mode) => mode === 'full' || mode === 'ops' ? mode : 'safe';

export function createPinHash(pin) {
  if (typeof pin !== 'string' || !/^\d{6,12}$/.test(pin)) throw new Error('Use a PIN of 6 to 12 digits.');
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(pin, Buffer.from(salt, 'hex'), 32).toString('hex');
  return { version: 1, algorithm: 'scrypt', salt, hash };
}

function validPinRecord(record) {
  return record?.version === 1 && record.algorithm === 'scrypt'
    && /^[a-f0-9]{32}$/.test(record.salt) && /^[a-f0-9]{64}$/.test(record.hash);
}

export function verifyPin(pin, record) {
  if (typeof pin !== 'string' || !/^\d{6,12}$/.test(pin) || !validPinRecord(record)) return false;
  const actual = crypto.scryptSync(pin, Buffer.from(record.salt, 'hex'), 32);
  return crypto.timingSafeEqual(actual, Buffer.from(record.hash, 'hex'));
}

function readPin(stateDir) {
  try {
    const record = JSON.parse(fs.readFileSync(path.join(stateDir, 'config.json'), 'utf8')).fullModePin;
    return validPinRecord(record) ? record : null;
  } catch { return null; }
}

const digest = (value) => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const within = (base, folder) => {
  const rel = path.relative(base, folder);
  return rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
};

// Resolve junctions/symlinks as well as '..'. Full/ops cannot escape C:\Work,
// even if a configured workRoot points elsewhere. This does not alter safe jobs.
export const HARD_ROOT = 'C:\\Work';
// hardRoot is overridable only so offline tests can use temp folders; the collector always uses C:\Work.
export function elevatedFolder(folder, workRoot, hardRoot = HARD_ROOT) {
  if (typeof folder !== 'string' || !folder) throw new Error('A job folder is required.');
  const root = fs.realpathSync(workRoot);
  const resolved = fs.realpathSync(path.resolve(root, folder));
  if (!fs.statSync(resolved).isDirectory() || !within(root, resolved)) throw new Error('Elevated job folder must be inside the Work folder.');
  if ((process.platform === 'win32' || hardRoot !== HARD_ROOT) && !within(fs.realpathSync(hardRoot), resolved)) throw new Error(`Full/ops job folder must be inside ${hardRoot}.`);
  return resolved;
}

export function defaultOperations({ workRoot, projects = [] } = {}) {
  const cwd = elevatedFolder(APP_ROOT, workRoot || 'C:\\Work');
  const operations = [
    { name: 'restart-collector', cwd, command: process.execPath, args: [path.join(APP_ROOT, 'tools', 'restart-collector.mjs')] },
    { name: 'git-status', cwd, command: process.platform === 'win32' ? 'git.exe' : 'git', args: ['status', '--short', '--branch'] },
    // Disabled placeholder. Set a real executable and fixed argument array locally.
    { name: 'dev-server', cwd, command: '', args: [] },
  ];
  const seen = new Set([cwd.toLowerCase()]);
  for (const project of projects) {
    let folder;
    try { folder = elevatedFolder(project.path, workRoot || 'C:\\Work'); } catch { continue; }
    if (seen.has(folder.toLowerCase())) continue;
    seen.add(folder.toLowerCase());
    const slug = String(project.name || path.basename(folder)).toLowerCase().replace(/[^a-z0-9_-]+/g, '-').slice(0, 50);
    operations.push({ name: `git-status:${slug}-${digest(folder).slice(0, 8)}`, cwd: folder, command: process.platform === 'win32' ? 'git.exe' : 'git', args: ['status', '--short', '--branch'] });
  }
  return operations;
}

export function ensureOps({ stateDir = STATE_DIR, workRoot = 'C:\\Work', projects = [] } = {}) {
  fs.mkdirSync(stateDir, { recursive: true });
  const file = path.join(stateDir, 'ops.json');
  if (!fs.existsSync(file)) {
    try { fs.writeFileSync(file, JSON.stringify({ operations: defaultOperations({ workRoot, projects }) }, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); }
    catch (e) { if (e.code !== 'EEXIST') throw e; }
  }
  const document = JSON.parse(fs.readFileSync(file, 'utf8'));
  const operations = Array.isArray(document) ? document : document.operations;
  if (!Array.isArray(operations)) throw new Error('ops.json must contain an operations array.');
  return operations;
}

function binding(job) {
  return digest({ id: job.id, mode: job.mode, folder: job.folder, agent: job.agent, model: job.model,
    title: job.title, prompt: job.prompt, op: job.op, operation: job.operation,
    approvalId: job.approvalId, approvalExpiresAt: job.approvalExpiresAt });
}

export class FullModePolicy {
  constructor({ stateDir = STATE_DIR, workRoot = 'C:\\Work', projects = () => [], now = Date.now, hardRoot = HARD_ROOT } = {}) {
    this.hardRoot = hardRoot;
    this.stateDir = stateDir;
    this.workRoot = workRoot;
    this.projects = projects;
    this.now = now;
    this.pinFailures = [];
  }

  ready() { return !!readPin(this.stateDir); }

  operations() {
    return ensureOps({ stateDir: this.stateDir, workRoot: this.workRoot, projects: this.projects() });
  }

  resolveOperation(name, folder) {
    if (typeof name !== 'string' || !name || name.length > 120) throw new Error('A named operation is required.');
    const matches = this.operations().filter((op) => op?.name === name);
    if (matches.length !== 1) throw new Error(`Unknown or duplicate operation: ${name}`);
    const op = matches[0];
    if (typeof op.command !== 'string' || !op.command.trim()) throw new Error(`Operation ${name} is a placeholder; edit its command and args in ~/.ada-viewer/ops.json.`);
    if (op.command.length > 2048 || op.command.includes('\0') || !Array.isArray(op.args)
      || op.args.length > 100 || op.args.some((a) => typeof a !== 'string' || a.length > 8000 || a.includes('\0')))
      throw new Error(`Invalid command or args for operation: ${name}`);
    const cwd = elevatedFolder(op.cwd, this.workRoot, this.hardRoot);
    if (folder && cwd.toLowerCase() !== folder.toLowerCase()) throw new Error(`Operation ${name} is allowed only in ${cwd}.`);
    return { name, cwd, command: op.command, args: [...op.args] };
  }

  prepare(job) {
    job.mode = normalizeMode(job.mode);
    if (job.mode === 'safe') return null;
    if (!this.ready()) return PIN_MESSAGE;
    try {
      job.folder = elevatedFolder(job.folder, this.workRoot, this.hardRoot);
      if (job.mode === 'ops') job.operation = this.resolveOperation(job.op, job.folder);
      job.approvedByPin = false;
      job.approvalId = crypto.randomBytes(24).toString('hex');
      job.approvalExpiresAt = this.now() + APPROVAL_MS;
      job.approvalDigest = binding(job);
      return null;
    } catch (e) { return e.message; }
  }

  expired(job) { return !Number.isFinite(job.approvalExpiresAt) || this.now() >= job.approvalExpiresAt; }

  // Public, PIN-free hint for the page: why the last attempt was refused and how many PIN tries remain.
  #refuse(job, reason, message) {
    this.pinFailures = this.pinFailures.filter((t) => this.now() - t < APPROVAL_MS);
    const used = Math.min(this.pinFailures.length, MAX_PIN_TRIES);
    const locked = used >= MAX_PIN_TRIES;
    job.approvalNote = { reason: locked && reason === 'wrong-pin' ? 'locked' : reason, at: this.now(), attemptsLeft: MAX_PIN_TRIES - used,
      lockedUntil: locked ? Math.min(...this.pinFailures) + APPROVAL_MS : null };
    return message;
  }

  #auditPin(job, outcome) {
    try { this.audit(job, outcome); } catch { /* an unwritable log must not turn a refusal into an approval */ }
  }

  approve(job, cmd) {
    if (!job || normalizeMode(job.mode) === 'safe' || job.status !== 'awaiting-approval') return 'Job is not awaiting approval.';
    delete job.approvalNote; // a new attempt starts; every refusal below records its own note
    if (cmd.job !== job.id || typeof cmd.approval !== 'string' || cmd.approval !== job.approvalId) return this.#refuse(job, 'mismatch', 'Approval does not match this job.');
    if (this.expired(job)) return this.#refuse(job, 'expired', 'Approval expired; ask Ada to propose a new job.');
    if (job.approvalDigest !== binding(job)) return this.#refuse(job, 'mismatch', 'Job changed after approval was requested; propose it again.');
    const record = readPin(this.stateDir);
    if (!record) return PIN_MESSAGE;
    this.pinFailures = this.pinFailures.filter((t) => this.now() - t < APPROVAL_MS);
    if (this.pinFailures.length >= MAX_PIN_TRIES) {
      const message = this.#refuse(job, 'locked', 'Too many incorrect PIN attempts; wait five minutes.');
      this.#auditPin(job, 'pin-locked attemptsLeft=0');
      return message;
    }
    if (!verifyPin(cmd.pin, record)) {
      this.pinFailures.push(this.now());
      const message = this.#refuse(job, 'wrong-pin', 'Incorrect approval PIN.');
      this.#auditPin(job, `pin-failed attemptsLeft=${job.approvalNote.attemptsLeft}`);
      return message;
    }
    // Re-read the allowlist and resolve the path before accepting the tap.
    const why = this.#unchanged(job);
    if (why) return why;
    job.approvedByPin = true;
    job.approvedAt = this.now();
    job.approvedPinVersion = digest(record);
    return null;
  }

  #unchanged(job) {
    try {
      if (elevatedFolder(job.folder, this.workRoot, this.hardRoot).toLowerCase() !== job.folder.toLowerCase()) return 'Job folder changed; propose it again.';
      if (job.mode === 'ops' && digest(this.resolveOperation(job.op, job.folder)) !== digest(job.operation)) return 'Operation changed after approval was requested; propose it again.';
      return null;
    } catch (e) { return e.message; }
  }

  authorizeStart(job) {
    if (normalizeMode(job.mode) === 'safe') return null;
    if (job.approvedByPin !== true || !Number.isFinite(job.approvedAt)) return 'This job needs its own PIN approval.';
    if (this.expired(job)) return 'Approval expired before the job could start.';
    if (binding(job) !== job.approvalDigest) return 'Approved job changed; propose it again.';
    const record = readPin(this.stateDir);
    if (!record || digest(record) !== job.approvedPinVersion) return 'Approval PIN changed; propose this job again.';
    return this.#unchanged(job);
  }

  audit(job, outcome) {
    if (normalizeMode(job.mode) === 'safe') return;
    fs.mkdirSync(this.stateDir, { recursive: true });
    fs.appendFileSync(path.join(this.stateDir, 'fullmode-audit.log'), JSON.stringify({
      time: new Date(this.now()).toISOString(), jobId: job.id, mode: job.mode,
      folder: job.folder, agent: job.agent, title: job.title,
      approvedByPin: job.approvedByPin === true ? 'yes' : 'no', outcome: String(outcome),
    }) + '\n', { mode: 0o600 });
  }
}
