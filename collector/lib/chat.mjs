// Ada chat: Nefer talks to Ada from the page; Ada routes jobs to project folders.
// Commands arrive encrypted with the page password (see collect.mjs). Ada (head) can only read;
// workers run in safe mode (runner.mjs). Workers exit when their job ends, but each project
// keeps its conversation, so the next job there resumes it.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { STATE_DIR } from './config.mjs';
import { runAgent } from './runner.mjs';
import { appendTaskEvent } from './tasks.mjs';
import { clip } from './util.mjs';

const FILE = path.join(STATE_DIR, 'chat.json');
const MAX_WORKERS = 2;
const MAX_JOBS_PER_TURN = 5;
const MAX_TEXT = 8000;
const CLOCK_SKEW = 10 * 60e3;
const newId = () => crypto.randomBytes(5).toString('hex');

function codexModels() {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.codex', 'models_cache.json'), 'utf8'));
    return (m.models || m).map((x) => x.slug || x.id || x).filter((s) => typeof s === 'string' && !/review/.test(s));
  } catch { return []; }
}

export class ChatHub {
  constructor({ workRoot, projects, onChange }) {
    this.workRoot = path.resolve(workRoot);
    this.projects = projects; // () => project list (for Ada's map of the Work folder)
    this.onChange = onChange || (() => {});
    this.procs = new Map(); // job id or `head:<thread>` -> child
    this.state = { threads: [], jobs: [], projectSessions: {}, seen: [] };
    try { Object.assign(this.state, JSON.parse(fs.readFileSync(FILE, 'utf8'))); } catch {}
    // Anything mid-flight when the collector stopped is gone now.
    for (const j of this.state.jobs) if (j.status === 'running' || j.status === 'queued') {
      j.status = 'failed'; j.result = 'Stopped: the collector restarted.'; j.endedAt = Date.now();
      appendTaskEvent({ id: j.id, status: 'failed', preview: j.result });
    }
    for (const t of this.state.threads) t.busy = false;
    this.#save();
  }

  #save() {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    const tmp = FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.state));
    fs.renameSync(tmp, FILE);
  }

  #changed() { this.#save(); this.onChange(); }

  #thread(id) { return this.state.threads.find((t) => t.id === id); }

  #post(t, msg) {
    t.messages.push({ id: newId(), t: Date.now(), ...msg });
    if (t.messages.length > 300) t.messages = t.messages.slice(-300);
    t.updatedAt = Date.now();
  }

  /** Entry point for a decrypted command from the page. Returns a reason string when rejected. */
  handle(cmd) {
    if (!cmd || cmd.kind !== 'cmd' || typeof cmd.id !== 'string') return 'not a command';
    if (Math.abs(Date.now() - (cmd.ts || 0)) > CLOCK_SKEW) return 'stale';
    if (this.state.seen.includes(cmd.id)) return 'replayed';
    this.state.seen.push(cmd.id);
    this.state.seen = this.state.seen.slice(-500);

    if (cmd.type === 'say') return this.#say(cmd);
    if (cmd.type === 'cancel') return this.#cancel(cmd.job);
    if (cmd.type === 'stop') return this.#stop(cmd.thread);
    if (cmd.type === 'archive') {
      const t = this.#thread(cmd.thread);
      if (t && !t.busy) { t.archived = true; this.#changed(); }
      return null;
    }
    return 'unknown type';
  }

  #say(cmd) {
    const text = String(cmd.text || '').trim().slice(0, MAX_TEXT);
    if (!text) return 'empty';
    let t = this.#thread(cmd.thread);
    if (!t) {
      const agent = cmd.brain?.agent === 'codex' ? 'codex' : 'claude';
      t = {
        id: typeof cmd.thread === 'string' ? cmd.thread.slice(0, 24) : newId(),
        title: clip(text, 48),
        brain: { agent, model: String(cmd.brain?.model || '').slice(0, 60) },
        head: null,
        messages: [],
        pending: [],
        busy: false,
        createdAt: Date.now(),
      };
      this.state.threads.push(t);
    }
    this.#post(t, { role: 'user', text, cid: cmd.id });
    this.#changed();
    if (!t.busy) this.#headTurn(t);
    return null;
  }

  #cancel(jobId) {
    const j = this.state.jobs.find((x) => x.id === jobId);
    if (!j || (j.status !== 'running' && j.status !== 'queued')) return 'not running';
    this.procs.get(j.id)?.kill();
    this.#finishJob(j, { ok: false, text: '', error: 'Cancelled by Nefer.' }, 'cancelled');
    return null;
  }

  #stop(threadId) {
    const p = this.procs.get(`head:${threadId}`);
    if (p) { p.stopped = true; p.kill(); }
    return null;
  }

  #system(t) {
    const list = this.projects()
      .filter((p) => !p.looseOnly)
      .sort((a, b) => (b.lastActivity || 0) - (a.lastActivity || 0))
      .slice(0, 80)
      .map((p) => `- ${p.name} — ${p.path} — ${p.kind || 'local'}${p.repo ? ` (${p.repo})` : ''}`)
      .join('\n');
    return `You are Ada, Nefer's orchestrator. You run headless on his laptop and talk to him through the chat page of Ada Live on his phone.
Voice: direct, dry, warm without sentiment, opinionated, no preamble. Call him Nefer. Keep replies short; he reads them on a phone.

You are the head of every folder under ${this.workRoot}. You do not do project work yourself and you cannot change files or run commands. You may read files to understand a project before routing.
Your job: understand what Nefer wants, ask only when it is genuinely ambiguous, then hand the work to workers. Answer simple questions yourself.

To start workers, end your reply with exactly one jobs block:
<jobs>
[{"folder":"<absolute project path from the list>","agent":"claude or codex","model":"","title":"short title","prompt":"complete, self-contained instructions"}]
</jobs>
Rules for jobs:
- folder must be inside ${this.workRoot}; prefer the project paths listed below. At most ${MAX_JOBS_PER_TURN} jobs per reply.
- Each worker sees only its folder and none of this chat, so its prompt must stand alone (goal, files, constraints, what "done" means).
- Workers run in safe mode: they can edit files inside their own folder only. Claude workers cannot run shell commands. Codex workers can run commands in a sandbox with no network. Nothing can push, install, or touch other folders; if a job needs that, tell Nefer to do it himself.
- Pick codex for image/asset generation and for jobs that must run code or tests; claude for frontend, code and writing. Leave model empty for the default.
- Workers keep a per-project memory between jobs, so follow-ups to the same folder can be brief.
Results come back in later messages marked [Job results]. Summarise them for Nefer: what changed, where, and anything he must do himself.

Projects under ${this.workRoot}, most recently active first:
${list}`;
  }

  #headTurn(t) {
    t.busy = true;
    const results = t.pending.splice(0);
    const lastUser = [...t.messages].reverse().find((m) => m.role === 'user' && !m.answered);
    const parts = [];
    if (results.length) {
      parts.push('[Job results]\n' + results.map((r) => `- ${r.title} — ${r.folder} — ${r.status}\n${clip(r.result || '', 1500)}`).join('\n'));
    }
    // Every unanswered message from Nefer since the last turn.
    const unanswered = t.messages.filter((m) => m.role === 'user' && !m.answered);
    if (unanswered.length) parts.push(unanswered.map((m) => `[Nefer] ${m.text}`).join('\n\n'));
    unanswered.forEach((m) => { m.answered = true; });
    if (!parts.length) { t.busy = false; return; }

    const { agent, model } = t.brain;
    const run = runAgent({
      agent, role: 'head', model, cwd: this.workRoot,
      prompt: parts.join('\n\n'),
      resume: t.head,
      system: agent === 'claude' || !t.head ? this.#system(t) : null,
      onSession: (s) => { t.head = s; },
    });
    this.procs.set(`head:${t.id}`, run.child);
    this.#changed();

    run.done.then((r) => {
      const stopped = run.child.stopped;
      this.procs.delete(`head:${t.id}`);
      if (r.session) t.head = r.session;
      if (stopped) this.#post(t, { role: 'system', text: 'Stopped.' });
      else if (!r.ok) this.#post(t, { role: 'system', text: `Ada couldn't answer: ${clip(r.error || r.text || 'unknown error', 300)}` });
      else this.#reply(t, r.text, lastUser);
      t.busy = false;
      this.#changed();
      // More arrived while she was thinking.
      if (t.messages.some((m) => m.role === 'user' && !m.answered) || t.pending.length) this.#headTurn(t);
    });
  }

  #reply(t, raw, lastUser) {
    const m = raw.match(/<jobs>\s*([\s\S]*?)\s*<\/jobs>/i);
    const text = raw.replace(/<jobs>[\s\S]*?<\/jobs>/gi, '').trim();
    const jobs = [];
    const problems = [];
    if (m) {
      let specs = [];
      try { specs = JSON.parse(m[1]); } catch { problems.push('Her jobs block was not valid JSON, so nothing started.'); }
      for (const s of (Array.isArray(specs) ? specs : [specs]).slice(0, MAX_JOBS_PER_TURN)) {
        const folder = this.#checkFolder(s?.folder);
        if (!folder) { problems.push(`Skipped a job for "${clip(String(s?.folder || '?'), 80)}": not a folder inside ${this.workRoot}.`); continue; }
        if (!s.prompt) { problems.push(`Skipped "${s.title || 'untitled'}": no instructions.`); continue; }
        jobs.push(this.#queueJob(t, {
          folder,
          agent: s.agent === 'codex' ? 'codex' : s.agent === 'claude' ? 'claude' : t.brain.agent,
          model: String(s.model || '').slice(0, 60),
          title: clip(String(s.title || s.prompt), 60),
          prompt: String(s.prompt).slice(0, 12000),
        }));
      }
    }
    this.#post(t, { role: 'ada', text: text || (jobs.length ? 'On it.' : '…'), jobs: jobs.map((j) => j.id), replyTo: lastUser?.id });
    if (problems.length) this.#post(t, { role: 'system', text: problems.join('\n') });
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

  #queueJob(t, spec) {
    const j = { id: newId(), thread: t.id, ...spec, status: 'queued', createdAt: Date.now() };
    this.state.jobs.push(j);
    if (this.state.jobs.length > 200) this.state.jobs = this.state.jobs.slice(-200);
    appendTaskEvent({ id: j.id, status: 'queued', agent: j.agent, title: j.title, cwd: j.folder, preview: 'Queued by Ada', by: 'ada-chat' });
    return j;
  }

  #pump() {
    const running = this.state.jobs.filter((j) => j.status === 'running').length;
    const next = this.state.jobs.filter((j) => j.status === 'queued').slice(0, Math.max(0, MAX_WORKERS - running));
    for (const j of next) this.#startJob(j);
  }

  #startJob(j) {
    j.status = 'running';
    j.startedAt = Date.now();
    const key = `${j.agent}|${j.folder.toLowerCase()}`;
    const resume = this.state.projectSessions[key] || null;
    const prompt = `Job from Ada (Nefer's orchestrator), sent from his phone.
Safe mode: edit files inside this folder only.${j.agent === 'claude' ? ' Shell commands are not available.' : ' Commands run sandboxed with no network.'} If something needs more access, stop and say exactly what Nefer must do.
When finished, reply with a short summary: what you changed (file paths), what you checked, and anything left for Nefer.

${j.prompt}`;
    appendTaskEvent({ id: j.id, status: 'running', preview: resume ? 'Started (continuing this project’s session)' : 'Started' });
    const run = runAgent({
      agent: j.agent, role: 'worker', model: j.model, cwd: j.folder, prompt, resume,
      onSession: (s) => { j.session = s; appendTaskEvent({ id: j.id, session: s }); },
    });
    this.procs.set(j.id, run.child);
    this.#changed();
    run.done.then((r) => {
      this.procs.delete(j.id);
      if (j.status !== 'running') return; // cancelled meanwhile
      if (r.session) this.state.projectSessions[key] = r.session;
      else if (resume && !r.ok) delete this.state.projectSessions[key]; // stale session: start fresh next time
      this.#finishJob(j, r, r.ok ? 'done' : 'failed');
    });
  }

  #finishJob(j, r, status) {
    j.status = status;
    j.endedAt = Date.now();
    if (r.session) j.session = r.session;
    j.denied = r.denied?.length ? [...new Set(r.denied)] : undefined;
    j.result = r.ok ? r.text : (r.error || r.text || 'failed');
    appendTaskEvent({ id: j.id, status: status === 'cancelled' ? 'failed' : status, preview: clip(j.result, 240), ...(j.session ? { session: j.session } : {}) });
    const t = this.#thread(j.thread);
    if (t) {
      this.#post(t, { role: 'job', job: j.id, text: `${j.title} — ${status}` });
      if (status !== 'cancelled') {
        t.pending.push({ title: j.title, folder: j.folder, status, result: j.result + (j.denied ? `\n(blocked by safe mode: ${j.denied.join(', ')})` : '') });
      }
      // Ada reports back once this thread has no work left in flight.
      const inFlight = this.state.jobs.some((x) => x.thread === t.id && (x.status === 'running' || x.status === 'queued'));
      if (!inFlight && !t.busy && t.pending.length) this.#headTurn(t);
    }
    this.#changed();
    this.#pump();
  }

  /** What the page sees. */
  view() {
    const threads = this.state.threads
      .filter((t) => !t.archived)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, 12)
      .map(({ pending, head, messages, ...t }) => ({ ...t, messages: messages.slice(-80).map(({ answered, ...m }) => m) }));
    const ids = new Set(threads.map((t) => t.id));
    const jobs = this.state.jobs
      .filter((j) => ids.has(j.thread))
      .slice(-60)
      .map(({ prompt, ...j }) => ({ ...j, prompt: clip(prompt, 600), result: clip(j.result || '', 2000) }));
    return {
      threads,
      jobs,
      brains: { claude: ['', 'opus', 'sonnet', 'haiku'], codex: ['', ...codexModels()] },
      safeMode: true,
    };
  }
}
