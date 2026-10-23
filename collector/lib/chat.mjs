// Ada chat: one long-running conversation between Nefer and Ada, from the page.
// Ada is his assistant first; when work is needed she routes jobs to project folders.
// Commands arrive sealed with the page password (see collect.mjs). Ada herself can only read;
// workers run in safe mode (runner.mjs). Workers exit when their job ends, but each project
// keeps its own conversation, so the next job there resumes it.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { STATE_DIR } from './config.mjs';
import { runAgent } from './runner.mjs';
import { appendTaskEvent } from './tasks.mjs';
import { clip } from './util.mjs';

const FILE = path.join(STATE_DIR, 'chat.json');
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
  constructor({ workRoot, projects, onChange }) {
    this.workRoot = path.resolve(workRoot);
    this.projects = projects; // () => project list (Ada's map of the Work folder)
    this.onChange = onChange || (() => {});
    this.procs = new Map(); // job id or 'head' -> child
    this.state = { thread: null, jobs: [], projectSessions: {}, seen: [] };
    try { Object.assign(this.state, JSON.parse(fs.readFileSync(FILE, 'utf8'))); } catch {}
    this.state.thread ||= { id: THREAD, brain: { agent: 'claude', model: '' }, heads: {}, lastAgent: null, messages: [], pending: [], busy: false };
    const t = this.state.thread;
    // Anything mid-flight when the collector stopped is gone now.
    for (const j of this.state.jobs) if (j.status === 'running' || j.status === 'queued') {
      j.status = 'failed'; j.result = 'Stopped: the collector restarted.'; j.endedAt = Date.now();
      appendTaskEvent({ id: j.id, status: 'failed', preview: j.result });
    }
    t.busy = false;
    this.#save();
  }

  get t() { return this.state.thread; }

  #save() {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    const tmp = FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.state));
    fs.renameSync(tmp, FILE);
  }

  #changed() { this.#save(); this.onChange(); }

  #post(msg) {
    const t = this.t;
    t.messages.push({ id: newId(), t: Date.now(), ...msg });
    if (t.messages.length > 600) t.messages = t.messages.slice(-600);
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
    this.procs.get(j.id)?.kill();
    this.#finishJob(j, { ok: false, text: '', error: 'Cancelled by Nefer.' }, 'cancelled');
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
[{"folder":"<absolute project path>","agent":"claude or codex","model":"","title":"short title","prompt":"complete, self-contained instructions"}]
</jobs>
- folder must be inside ${this.workRoot}; prefer the project paths listed below. At most ${MAX_JOBS_PER_TURN} jobs per reply.
- Each worker sees only its folder and none of this chat, so its prompt must stand alone (goal, files, constraints, what "done" means).
- Safe mode: workers can edit files inside their own folder only. Claude workers cannot run shell commands. Codex workers run commands in a sandbox with no network. Nothing can push, install, or touch other folders; if a job needs that, tell Nefer to do it himself.
- Pick codex for image/asset generation and for jobs that must run code or tests; claude for frontend, code and writing. Leave model empty for the default.
- Workers keep a per-project memory between jobs, so follow-ups to the same folder can be brief.
- Don't start jobs for questions you can answer by reading.
Results arrive in later messages marked [Job results]. Tell Nefer what changed, where, and anything he must do himself.

## Projects under ${this.workRoot}, most recently active first
${list}`;
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
      parts.push('[Job results]\n' + results.map((r) => `- ${r.title} — ${r.folder} — ${r.status}\n${clip(r.result || '', 1500)}`).join('\n'));
    }
    if (unanswered.length) parts.push(unanswered.map((m) => `[Nefer] ${m.text}`).join('\n\n'));
    unanswered.forEach((m) => { m.answered = true; });
    if (!parts.length) { t.busy = false; return; }
    const lastUser = unanswered.at(-1);

    const run = runAgent({
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
        const folder = this.#checkFolder(s?.folder);
        if (!folder) { problems.push(`Skipped a job for "${clip(String(s?.folder || '?'), 80)}": not a folder inside ${this.workRoot}.`); continue; }
        if (!s.prompt) { problems.push(`Skipped "${s.title || 'untitled'}": no instructions.`); continue; }
        jobs.push(this.#queueJob({
          folder,
          agent: s.agent === 'codex' ? 'codex' : s.agent === 'claude' ? 'claude' : brain.agent,
          model: String(s.model || '').slice(0, 60),
          title: clip(String(s.title || s.prompt), 60),
          prompt: String(s.prompt).slice(0, 12000),
        }));
      }
    }
    this.#post({ role: 'ada', text: text || (jobs.length ? 'On it.' : '…'), jobs: jobs.map((j) => j.id), replyTo: lastUser?.id, ...brain });
    if (problems.length) this.#post({ role: 'system', text: problems.join('\n') });
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
    const j = { id: newId(), ...spec, status: 'queued', createdAt: Date.now() };
    this.state.jobs.push(j);
    if (this.state.jobs.length > 300) this.state.jobs = this.state.jobs.slice(-300);
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
      if (r.session && r.ok) this.state.projectSessions[key] = r.session;
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
    const t = this.t;
    if (status !== 'cancelled') {
      t.pending.push({ title: j.title, folder: j.folder, status, result: j.result + (j.denied ? `\n(blocked by safe mode: ${j.denied.join(', ')})` : '') });
    }
    // Ada reports back once no work is left in flight.
    const inFlight = this.state.jobs.some((x) => x.status === 'running' || x.status === 'queued');
    if (!inFlight && !t.busy && t.pending.length) this.#headTurn();
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
      .filter((j) => ids.has(j.id) || j.status === 'running' || j.status === 'queued')
      .map(({ prompt, ...j }) => ({ ...j, prompt: clip(prompt, 600), result: clip(j.result || '', 2000) }));
    return {
      thread: { id: t.id, brain: t.brain, busy: t.busy, updatedAt: t.updatedAt, messages, total: t.messages.length },
      jobs,
      brains: { claude: ['', 'opus', 'sonnet', 'haiku'], codex: ['', ...codexModels()] },
      memory: fs.existsSync(path.join(GHOST_PRIVATE, 'memory.md')),
      safeMode: true,
    };
  }
}
