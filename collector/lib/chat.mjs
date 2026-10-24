// Ada chat: one long-running conversation between Nefer and Ada, from the page.
// Ada is his assistant first; when work is needed she routes jobs to project folders.
// Commands arrive sealed with the page password (see collect.mjs). Ada herself can only read;
// workers default to safe mode (runner.mjs). Every ops/full job needs its own expiring
// phone approval and PIN; their conversations never share safe-mode sessions.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { STATE_DIR } from './config.mjs';
import { runAgent, runOperation, killProcessTree } from './runner.mjs';
import { FullModePolicy, normalizeMode } from './fullmode.mjs';
import { appendTaskEvent } from './tasks.mjs';
import { limits as sharedLimits } from './limits.mjs';
import { clip } from './util.mjs';

const THREAD = 'ada';
const MAX_WORKERS = 2;
const MAX_JOBS_PER_TURN = 5;
const MAX_TEXT = 8000;
const CLOCK_SKEW = 10 * 60e3;
const RECAP_MESSAGES = 30;
const newId = () => crypto.randomBytes(5).toString('hex');

// Ada's ghost: public soul + private memory (local clones).
const GHOST = path.join(os.homedir(), 'Desktop', 'Ada', 'Ada', 'ada-ghost');
const GHOST_PRIVATE = path.join(os.homedir(), 'Desktop', 'Ada', 'Ada', 'ada-ghost-private');
const read = (p, max = Infinity) => { try { const s = fs.readFileSync(p, 'utf8'); return s.length > max ? s.slice(0, max) + '\n…(truncated — read the file for the rest)' : s; } catch { return ''; } };

function codexModels() {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.codex', 'models_cache.json'), 'utf8'));
    return (m.models || m).map((x) => x.slug || x.id || x).filter((s) => typeof s === 'string' && !/review/.test(s));
  } catch { return []; }
}

export class ChatHub {
  constructor({ workRoot, projects, onChange, onRestart, stateDir = STATE_DIR, services = {} }) {
    this.workRoot = path.resolve(workRoot);
    this.projects = projects; // () => project list (Ada's map of the Work folder)
    this.onChange = onChange || (() => {});
    this.onRestart = onRestart;
    this.stateDir = stateDir;
    this.file = path.join(stateDir, 'chat.json');
    // Explicit dependencies keep offline lifecycle tests away from real profiles/CLIs.
    this.now = services.now || Date.now;
    this.runAgent = services.runAgent || runAgent;
    this.runOperation = services.runOperation || runOperation;
    this.killProcessTree = services.killProcessTree || killProcessTree;
    this.appendTaskEvent = services.appendTaskEvent || appendTaskEvent;
    this.limits = services.limits || sharedLimits;
    this.policy = services.policy || new FullModePolicy({ stateDir, workRoot: this.workRoot, projects, now: this.now });
    this.approvalTimer = null;
    this.pumping = false;
    try { this.policy.operations(); } catch { /* invalid ops config is reported when proposed */ }
    this.procs = new Map(); // job id or 'head' -> child
    this.state = { thread: null, jobs: [], projectSessions: {}, seen: [] };
    try { Object.assign(this.state, JSON.parse(fs.readFileSync(this.file, 'utf8'))); } catch {}
    this.state.thread ||= { id: THREAD, brain: { agent: 'claude', model: '' }, heads: {}, lastAgent: null, messages: [], pending: [], busy: false };
    const t = this.state.thread;
    // Anything mid-flight when the collector stopped is gone now.
    for (const j of this.state.jobs) if (['running', 'queued', 'killing', 'awaiting-approval'].includes(j.status)) {
      j.mode = normalizeMode(j.mode);
      j.status = 'failed'; j.result = 'Stopped: the collector restarted. Propose a new job for a new approval.'; j.endedAt = this.now();
      const auditError = this.#audit(j, 'collector-restarted');
      if (auditError) j.result += ` ${auditError}`;
      this.appendTaskEvent({ id: j.id, mode: j.mode, status: 'failed', preview: j.result });
      if (j.mode !== 'safe') {
        this.#post({ role: 'system', text: `${j.mode.toUpperCase()} job "${j.title}": ${j.result}` });
        t.pending.push({ title: j.title, folder: j.folder, mode: j.mode, status: 'failed', result: j.result });
      }
    }
    t.busy = false;
    this.#save();
  }

  get t() { return this.state.thread; }

  #save() {
    fs.mkdirSync(this.stateDir, { recursive: true });
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.state));
    fs.renameSync(tmp, this.file);
  }

  #changed() { this.#save(); this.onChange(); }

  #post(msg) {
    const t = this.t;
    t.messages.push({ id: newId(), t: this.now(), ...msg });
    if (t.messages.length > 600) t.messages = t.messages.slice(-600);
    t.updatedAt = this.now();
  }

  /** Entry point for a decrypted command from the page. Returns a reason string when rejected. */
  handle(cmd) {
    if (!cmd || cmd.kind !== 'cmd' || typeof cmd.id !== 'string' || !cmd.id || cmd.id.length > 128) return 'not a command';
    if (!Number.isFinite(cmd.ts) || Math.abs(this.now() - cmd.ts) > CLOCK_SKEW) return 'stale';
    if (this.state.seen.includes(cmd.id)) return 'replayed';
    this.state.seen.push(cmd.id);
    this.state.seen = this.state.seen.slice(-500);

    // Save rejected command IDs too: a wrong-PIN envelope cannot be replayed later.
    this.#save();
    this.#expireApprovals();
    if (cmd.type === 'say') return this.#say(cmd);
    if (cmd.type === 'cancel') return this.#cancel(cmd.job);
    if (cmd.type === 'approve') return this.#approve(cmd);
    if (cmd.type === 'deny') return this.#deny(cmd);
    if (cmd.type === 'kill') return this.#kill(cmd.job);
    if (cmd.type === 'stop') return this.#stop();
    if (cmd.type === 'reset') return this.#reset();
    return 'unknown type';
  }

  #say(cmd) {
    const text = String(cmd.text || '').trim().slice(0, MAX_TEXT);
    if (!text) return 'empty';
    const t = this.t;
    if (cmd.brain) {
      t.brain = { agent: cmd.brain.agent === 'codex' ? 'codex' : 'claude', model: String(cmd.brain.model || '').slice(0, 60) };
    }
    this.#post({ role: 'user', text, cid: cmd.id, brain: { ...t.brain } });
    this.#changed();
    if (!t.busy) this.#headTurn();
    return null;
  }

  // Start Ada on a fresh session (both brains). History stays visible; memory files still load.
  #reset() {
    const t = this.t;
    if (t.busy) return 'busy';
    t.heads = {};
    t.lastAgent = null;
    this.#post({ role: 'system', text: 'Fresh context. Ada starts a new session from here; her memory files still load.', reset: true });
    this.#changed();
    return null;
  }

  #cancel(jobId) {
    const j = this.state.jobs.find((x) => x.id === jobId);
    if (!j || (j.status !== 'running' && j.status !== 'queued')) return 'not running';
    if (normalizeMode(j.mode) !== 'safe') return this.#kill(jobId);
    this.procs.get(j.id)?.kill();
    this.#finishJob(j, { ok: false, text: '', error: 'Cancelled by Nefer.' }, 'cancelled');
    return null;
  }

  // ---- ops/full jobs: approval, kill, audit ----

  #audit(j, outcome) {
    try { this.policy.audit(j, outcome); return null; }
    catch (e) { return `(audit log failed: ${e.message})`; }
  }

  // Tells Ada (and the chat) about a job that ended without running to completion.
  #report(j, status, result) {
    const t = this.t;
    j.status = status; j.endedAt = this.now(); j.result = result;
    const auditError = this.#audit(j, status);
    if (auditError) j.result += ` ${auditError}`;
    this.appendTaskEvent({ id: j.id, mode: j.mode, agent: j.agent, title: j.title, cwd: j.folder, by: 'ada-chat', status: 'failed', preview: clip(j.result, 240) });
    this.#post({ role: 'system', text: `${j.mode.toUpperCase()} job "${j.title}": ${j.result}` });
    t.pending.push({ title: j.title, folder: j.folder, mode: j.mode, status, result: j.result });
  }

  #maybeReport() {
    const t = this.t;
    const inFlight = this.state.jobs.some((x) => x.status === 'running' || x.status === 'queued');
    if (!inFlight && !t.busy && t.pending.length) this.#headTurn();
  }

  /** Marks approvals older than five minutes expired and tells chat. Returns true if anything changed. */
  #expireApprovals() {
    let changed = false;
    for (const j of this.state.jobs) {
      if (j.status !== 'awaiting-approval' || !this.policy.expired(j)) continue;
      this.#report(j, 'expired', 'Approval expired after 5 minutes; nothing ran. Ask Ada to propose it again.');
      changed = true;
    }
    if (changed) this.#maybeReport();
    return changed;
  }

  #scheduleExpiry() {
    clearTimeout(this.approvalTimer);
    const times = this.state.jobs.filter((j) => j.status === 'awaiting-approval' && Number.isFinite(j.approvalExpiresAt)).map((j) => j.approvalExpiresAt);
    if (!times.length) return;
    const wait = Math.min(3600e3, Math.max(1000, Math.min(...times) - this.now() + 100));
    this.approvalTimer = setTimeout(() => {
      if (this.#expireApprovals()) this.#changed();
      this.#scheduleExpiry();
    }, wait);
    this.approvalTimer.unref?.();
  }

  #approve(cmd) {
    const j = this.state.jobs.find((x) => x.id === cmd.job);
    const why = this.policy.approve(j, cmd);
    if (why) {
      if (j) { this.#post({ role: 'system', text: `Approval for "${j.title}" was refused: ${why}` }); this.#changed(); }
      return why;
    }
    j.status = 'queued';
    this.appendTaskEvent({ id: j.id, mode: j.mode, agent: j.agent, title: j.title, cwd: j.folder, by: 'ada-chat', status: 'queued', preview: 'Approved on the phone' });
    this.#scheduleExpiry();
    this.#changed();
    this.#pump();
    return null;
  }

  #deny(cmd) {
    const j = this.state.jobs.find((x) => x.id === cmd.job);
    if (!j || j.status !== 'awaiting-approval' || normalizeMode(j.mode) === 'safe') return 'not awaiting approval';
    if (typeof cmd.approval !== 'string' || cmd.approval !== j.approvalId) return 'approval does not match this job';
    this.#report(j, 'denied', 'Nefer denied this job; nothing ran.');
    this.#scheduleExpiry();
    this.#changed();
    this.#maybeReport();
    return null;
  }

  #kill(jobId) {
    const j = this.state.jobs.find((x) => x.id === jobId);
    if (!j || normalizeMode(j.mode) === 'safe' || (j.status !== 'running' && j.status !== 'queued')) return 'not a running ops/full job';
    const proc = this.procs.get(j.id);
    if (proc) this.killProcessTree(proc);
    this.#finishJob(j, { ok: false, text: '', error: 'Killed by Nefer from the phone.' }, 'failed', 'killed');
    return null;
  }

  #stop() {
    const p = this.procs.get('head');
    if (p) { p.stopped = true; p.kill(); }
    return null;
  }

  #system() {
    const list = this.projects()
      .filter((p) => !p.looseOnly)
      .sort((a, b) => (b.lastActivity || 0) - (a.lastActivity || 0))
      .slice(0, 80)
      .map((p) => `- ${p.name} — ${p.path} — ${p.kind || 'local'}${p.repo ? ` (${p.repo})` : ''}`)
      .join('\n');
    return `# Ada — loaded from your ghost
${read(path.join(GHOST, 'identity.md'))}

${read(path.join(GHOST, 'rules.md'))}

## user.md
${read(path.join(GHOST_PRIVATE, 'user.md'))}

## memory.md
${read(path.join(GHOST_PRIVATE, 'memory.md'), 60000)}

## state.md (newest part)
${read(path.join(GHOST_PRIVATE, 'state.md'), 12000)}

Your ghost lives in ${GHOST} (soul, skills.md, refs/) and ${GHOST_PRIVATE} (user, memory, state, observations). Read more from them when it helps.

# Where you are right now
You are running headless on Nefer's laptop as the brain behind the Ada chat on Ada Live (his phone page). This is one long-running conversation: he talks to you about anything, and assigns work across his projects. You are his actual assistant, not a dispatcher: answer, think, push back, remember context from earlier in this chat. Keep replies phone-sized.

In this body you can read files but cannot edit anything or run commands. Project work goes to workers.

## Routing work to projects
To start workers, end your reply with exactly one jobs block:
<jobs>
[{"mode":"safe","folder":"<absolute project path>","agent":"claude or codex","model":"","title":"short title","prompt":"complete, self-contained instructions"}]
</jobs>
- folder must be inside ${this.workRoot}; prefer the project paths listed below. At most ${MAX_JOBS_PER_TURN} jobs per reply.
- Each worker sees only its folder and none of this chat, so its prompt must stand alone (goal, files, constraints, what "done" means).
- "mode" is "safe" (the default; leave it out for safe), "ops" or "full". Anything unrecognised counts as safe.
- Safe mode: workers can edit files inside their own folder only. Claude workers cannot run shell commands. Codex workers run commands in a sandbox with no network. Nothing can push, install, or touch other folders.
- Prefer safe mode. Propose "ops" or "full" only when safe mode genuinely cannot do the job: running or restarting servers, installing dependencies, tests that need the network. Say why in your reply.
- "ops": no model runs. Give "op" (the name of a pre-approved operation) instead of "prompt"; folder is optional because each operation has its own. Unknown names are rejected. Operations available now: ${this.#opsList()}
- "full": a Claude or Codex worker with a shell and wide access (any folder inside C:\\Work, installs, network). It can commit but must never git push, deploy or publish; that is blocked, so don't ask for it. Give a complete "prompt" as usual.
- Approval: ops and full jobs never start on their own. They appear on Nefer's phone with the exact prompt or operation, and he must tap Approve and enter his approval PIN within 5 minutes, separately for each job. If he denies or lets it expire, you get a result saying so. Tell him in your reply that a job is waiting for his approval and what it will do.
- Full mode is never left on: propose it again for every job that needs it.
- Pick codex for image/asset generation and for jobs that must run code or tests; claude for frontend, code and writing. Leave model empty for the default.
- Workers keep a per-project memory between jobs, so follow-ups to the same folder can be brief.
- Don't start jobs for questions you can answer by reading.
Results arrive in later messages marked [Job results]. Tell Nefer what changed, where, and anything he must do himself.

## Projects under ${this.workRoot}, most recently active first
${list}`;
  }

  #opsList() {
    try {
      const names = this.policy.operations().filter((o) => o?.name && typeof o.command === 'string' && o.command.trim()).map((o) => `${o.name} (in ${o.cwd})`);
      return names.length ? names.join('; ') : 'none configured yet';
    } catch { return 'none (ops.json is unreadable)'; }
  }

  // Messages since the given agent last spoke, so a brain switch doesn't lose the thread.
  #recap(agent) {
    const t = this.t;
    const lastIdx = t.messages.map((m) => m.role === 'ada' && m.agent === agent).lastIndexOf(true);
    const resetIdx = t.messages.map((m) => !!m.reset).lastIndexOf(true);
    const from = Math.max(lastIdx + 1, resetIdx + 1, t.messages.length - RECAP_MESSAGES);
    const lines = t.messages.slice(from)
      .filter((m) => (m.role === 'user' && m.answered) || m.role === 'ada')
      .map((m) => `${m.role === 'user' ? 'Nefer' : `Ada (${m.agent || 'other brain'})`}: ${clip(m.text, 1200)}`);
    return lines.length ? `[Earlier in this chat, while another brain was answering]\n${lines.join('\n\n')}` : '';
  }

  #headTurn() {
    const t = this.t;
    t.busy = true;
    const { agent, model } = t.brain;
    const results = t.pending.splice(0);
    const unanswered = t.messages.filter((m) => m.role === 'user' && !m.answered);
    const parts = [];
    const resume = t.heads[agent] || null;
    if (t.lastAgent && t.lastAgent !== agent) { const r = this.#recap(agent); if (r) parts.push(r); }
    if (results.length) {
      parts.push('[Job results]\n' + results.map((r) => `- ${r.title} — ${r.folder} — ${r.mode && r.mode !== 'safe' ? `${r.mode.toUpperCase()} · ` : ''}${r.status}\n${clip(r.result || '', 1500)}`).join('\n'));
    }
    if (unanswered.length) parts.push(unanswered.map((m) => `[Nefer] ${m.text}`).join('\n\n'));
    unanswered.forEach((m) => { m.answered = true; });
    if (!parts.length) { t.busy = false; return; }
    const lastUser = unanswered.at(-1);

    const run = this.runAgent({
      agent, role: 'head', model, cwd: this.workRoot,
      prompt: parts.join('\n\n'),
      resume,
      // Claude takes the system prompt every turn (stays fresh); Codex only when its session starts.
      system: agent === 'claude' || !resume ? this.#system() : null,
      addDirs: [GHOST, GHOST_PRIVATE],
      onSession: (s) => { t.heads[agent] = s; this.#remember(s); },
    });
    this.procs.set('head', run.child);
    this.#changed();

    run.done.then((r) => {
      const stopped = run.child.stopped;
      this.procs.delete('head');
      if (r.session) { t.heads[agent] = r.session; this.#remember(r.session); }
      else if (resume && !r.ok) delete t.heads[agent]; // stale session: start fresh next time
      if (!stopped) this.limits.note(agent, r);
      if (stopped) this.#post({ role: 'system', text: 'Stopped.' });
      else if (!r.ok) this.#post({ role: 'system', text: `Ada couldn't answer: ${clip(r.error || r.text || 'unknown error', 300)}` });
      else { t.lastAgent = agent; this.#reply(r.text, lastUser, { agent, model }); }
      t.busy = false;
      this.#changed();
      // More arrived while she was thinking.
      if (t.messages.some((m) => m.role === 'user' && !m.answered) || t.pending.length) this.#headTurn();
    });
  }

  #reply(raw, lastUser, brain) {
    const t = this.t;
    const m = raw.match(/<jobs>\s*([\s\S]*?)\s*<\/jobs>/i);
    const text = raw.replace(/<jobs>[\s\S]*?<\/jobs>/gi, '').trim();
    const jobs = [];
    const problems = [];
    if (m) {
      let specs = [];
      try { specs = JSON.parse(m[1]); } catch { problems.push('Her jobs block was not valid JSON, so nothing started.'); }
      for (const s of (Array.isArray(specs) ? specs : [specs]).slice(0, MAX_JOBS_PER_TURN)) {
        const mode = normalizeMode(s?.mode); // missing or unknown means safe
        const op = mode === 'ops' ? String(s?.op || '').slice(0, 120) : '';
        let folderArg = s?.folder;
        if (mode === 'ops' && !folderArg) { try { folderArg = this.policy.operations().find((o) => o?.name === op)?.cwd; } catch {} }
        const folder = this.#checkFolder(folderArg);
        if (!folder) { problems.push(`Skipped a job for "${clip(String(s?.folder || '?'), 80)}": not a folder inside ${this.workRoot}.`); continue; }
        if (mode === 'ops' ? !op : !s?.prompt) { problems.push(`Skipped "${s?.title || 'untitled'}": no ${mode === 'ops' ? 'operation name' : 'instructions'}.`); continue; }
        const job = this.#queueJob({
          mode,
          folder,
          agent: mode === 'ops' ? 'collector' : s.agent === 'codex' ? 'codex' : s.agent === 'claude' ? 'claude' : brain.agent,
          model: mode === 'ops' ? '' : String(s.model || '').slice(0, 60),
          title: clip(String(s.title || (mode === 'ops' ? `Run ${op}` : s.prompt)), 60),
          prompt: mode === 'ops' ? '' : String(s.prompt).slice(0, 12000),
          ...(mode === 'ops' ? { op } : {}),
        });
        if (job.rejected) problems.push(job.rejected); else jobs.push(job);
      }
    }
    const waiting = jobs.length > 0 && jobs.every((j) => j.status === 'awaiting-approval');
    this.#post({ role: 'ada', text: text || (waiting ? 'Waiting for your approval.' : jobs.length ? 'On it.' : '…'), jobs: jobs.map((j) => j.id), replyTo: lastUser?.id, ...brain });
    if (problems.length) this.#post({ role: 'system', text: problems.join('\n') });
    this.#scheduleExpiry();
    this.#pump();
  }

  #checkFolder(f) {
    if (typeof f !== 'string' || !f) return null;
    const p = path.resolve(this.workRoot, f);
    const rel = path.relative(this.workRoot, p);
    if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
    try { if (!fs.statSync(p).isDirectory()) return null; } catch { return null; }
    return p;
  }

  #queueJob(spec) {
    const j = { id: newId(), ...spec, mode: normalizeMode(spec.mode), status: 'queued', createdAt: this.now() };
    if (j.mode !== 'safe') {
      // ops/full never auto-start: they wait for a PIN approval bound to this job id.
      const why = this.policy.prepare(j);
      if (why) return { rejected: `Skipped ${j.mode.toUpperCase()} job "${j.title}": ${why}` };
      j.status = 'awaiting-approval';
    }
    this.state.jobs.push(j);
    if (this.state.jobs.length > 300) this.state.jobs = this.state.jobs.slice(-300);
    if (j.mode === 'safe') this.appendTaskEvent({ id: j.id, status: 'queued', agent: j.agent, title: j.title, cwd: j.folder, preview: 'Queued by Ada', by: 'ada-chat' });
    return j;
  }

  #pump() {
    if (this.pumping) return;
    this.pumping = true;
    try {
      // Every pass moves one job out of 'queued', so this ends.
      for (;;) {
        const running = this.state.jobs.filter((j) => j.status === 'running').length;
        const next = this.state.jobs.find((j) => j.status === 'queued');
        if (!next || running >= MAX_WORKERS) break;
        this.#startJob(next);
      }
    } finally { this.pumping = false; }
  }

  #startJob(j) {
    j.mode = normalizeMode(j.mode);
    if (j.mode !== 'safe') return this.#startElevated(j);
    j.status = 'running';
    j.startedAt = Date.now();
    const key = `${j.agent}|${j.folder.toLowerCase()}`;
    const resume = this.state.projectSessions[key] || null;
    const prompt = `Job from Ada (Nefer's orchestrator), sent from his phone.
Safe mode: edit files inside this folder only.${j.agent === 'claude' ? ' Shell commands are not available.' : ' Commands run sandboxed with no network.'} If something needs more access, stop and say exactly what Nefer must do.
When finished, reply with a short summary: what you changed (file paths), what you checked, and anything left for Nefer.

${j.prompt}`;
    this.appendTaskEvent({ id: j.id, status: 'running', preview: resume ? 'Started (continuing this project’s session)' : 'Started' });
    const run = this.runAgent({
      agent: j.agent, role: 'worker', model: j.model, cwd: j.folder, prompt, resume,
      onSession: (s) => { j.session = s; this.appendTaskEvent({ id: j.id, session: s }); },
    });
    this.procs.set(j.id, run.child);
    this.#changed();
    run.done.then((r) => {
      this.procs.delete(j.id);
      if (j.status !== 'running') return; // cancelled meanwhile
      if (r.session && r.ok) this.state.projectSessions[key] = r.session;
      else if (resume && !r.ok) delete this.state.projectSessions[key]; // stale session: start fresh next time
      this.#finishJob(j, r, r.ok ? 'done' : 'failed');
    });
  }

  // Runs an approved ops/full job. Re-checks the approval first; never resumes a safe-mode session.
  #startElevated(j) {
    const refused = this.policy.authorizeStart(j);
    if (refused) { this.#finishJob(j, { ok: false, text: '', error: refused }, 'failed', 'refused'); return; }
    // Fail closed: no audit line, no run.
    const auditError = this.#audit(j, 'started');
    if (auditError) { this.#finishJob(j, { ok: false, text: '', error: `Not started ${auditError}` }, 'failed', 'refused'); return; }
    j.status = 'running';
    j.startedAt = this.now();
    this.appendTaskEvent({ id: j.id, mode: j.mode, agent: j.agent, title: j.title, cwd: j.folder, by: 'ada-chat', status: 'running', preview: 'Started (approved on the phone)' });
    let run;
    try {
      if (j.mode === 'ops') run = this.runOperation(j.operation);
      else {
        const prompt = `Job from Ada (Nefer's orchestrator), sent from his phone, approved by Nefer with his PIN for this job only.
FULL mode: you may run shell commands and edit files as the task needs. Never git push, force-push, deploy or publish; committing locally is fine. Keep changes to what the task asks.
When finished, reply with a short summary: what you changed (file paths), what you ran, and anything left for Nefer.

${j.prompt}`;
        run = this.runAgent({ agent: j.agent, role: 'full', model: j.model, cwd: j.folder, prompt, resume: null });
      }
    } catch (e) { this.#finishJob(j, { ok: false, text: '', error: `Could not start: ${e.message}` }, 'failed', 'start-failed'); return; }
    this.procs.set(j.id, run.child);
    this.#changed();
    run.done.then((r) => {
      this.procs.delete(j.id);
      if (j.status !== 'running') return; // killed meanwhile
      this.#finishJob(j, r, r.ok ? 'done' : 'failed');
    });
  }

  #finishJob(j, r, status, outcome = status) {
    j.status = status;
    j.endedAt = this.now();
    j.mode = normalizeMode(j.mode);
    if (r.session) j.session = r.session;
    j.denied = r.denied?.length ? [...new Set(r.denied)] : undefined;
    j.result = r.ok ? r.text : (r.error || r.text || 'failed');
    if (j.mode !== 'safe') {
      const auditError = this.#audit(j, outcome);
      if (auditError) j.result += ` ${auditError}`;
    }
    if (status !== 'cancelled' && outcome !== 'killed') this.limits.note(j.agent, r);
    this.appendTaskEvent({ id: j.id, ...(j.mode !== 'safe' ? { mode: j.mode, agent: j.agent, title: j.title, cwd: j.folder, by: 'ada-chat' } : {}), status: status === 'cancelled' ? 'failed' : status, preview: clip(j.result, 240), ...(j.session ? { session: j.session } : {}) });
    const t = this.t;
    if (status !== 'cancelled') {
      t.pending.push({ title: j.title, folder: j.folder, mode: j.mode, status, result: j.result + (j.denied ? `\n(blocked by ${j.mode === 'safe' ? 'safe mode' : 'tool permissions'}: ${j.denied.join(', ')})` : '') });
    }
    // Ada reports back once no work is left in flight.
    this.#maybeReport();
    this.#changed();
    this.#pump();
  }

  #remember(id) {
    const h = (this.state.headSessions ||= []);
    if (!h.includes(id)) { h.push(id); this.state.headSessions = h.slice(-200); }
  }

  /** Ada's own sessions: the chat already shows them, so the activity views skip them. */
  headSessions() { return new Set(this.state.headSessions || []); }

  /** What the page sees. */
  view() {
    const t = this.t;
    const messages = t.messages.slice(-120).map(({ answered, ...m }) => m);
    const ids = new Set(messages.flatMap((m) => m.jobs || []));
    const jobs = this.state.jobs
      .filter((j) => ids.has(j.id) || ['running', 'queued', 'awaiting-approval'].includes(j.status))
      // Approval digests and PIN-record fingerprints stay on the laptop. ops/full prompts are shown in full for review.
      .map(({ prompt, approvalDigest, approvedPinVersion, ...j }) => {
        const mode = normalizeMode(j.mode);
        return { ...j, mode, prompt: mode === 'safe' ? clip(prompt, 600) : String(prompt || '').slice(0, 12000), result: clip(j.result || '', 2000) };
      });
    return {
      thread: { id: t.id, brain: t.brain, busy: t.busy, updatedAt: t.updatedAt, messages, total: t.messages.length },
      jobs,
      brains: { claude: ['', 'opus', 'sonnet', 'haiku'], codex: ['', ...codexModels()] },
      memory: fs.existsSync(path.join(GHOST_PRIVATE, 'memory.md')),
      safeMode: true, // the default every job starts in; ops/full are per-job and need approval
      fullModePinSet: this.policy.ready(),
    };
  }
}
