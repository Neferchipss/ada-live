// Runs one headless turn of Claude Code or Codex in a folder and returns its final reply.
//   role 'head'   — Ada herself: may read anything under the folder, can't change anything.
//   role 'worker' — safe mode: may edit files inside its own folder only. No shell for Claude;
//                   Codex runs its sandbox (writes limited to the folder, no network).
//   role 'full'   — full mode, only after a per-job phone approval + PIN (see fullmode.mjs).
//                   Claude: shell and edits anywhere, minus the push/deploy deny list below.
//                   Codex: danger-full-access sandbox, with a no-push rule in the prompt.
// None inherits Nefer's personal Claude settings, which allow edits anywhere plus git/node.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { windowFromModelUsage } from './context.mjs';

// Claude full mode can never push or deploy. These deny rules apply even with permissions bypassed.
// Pattern matching is best-effort (it will not catch a push hidden inside a script).
export const FULL_DISALLOWED = ['Bash', 'PowerShell'].flatMap((tool) => [
  'git push', 'git * push', 'git.exe push',
  'gh pr merge', 'gh release', 'npm publish', 'pnpm publish', 'yarn publish',
  'vercel', 'netlify deploy', 'wrangler deploy', 'wrangler publish', 'firebase deploy',
  'fly deploy', 'flyctl deploy', 'gh workflow run',
].map((p) => `${tool}(${p}:*)`));

// Codex has no deny list. Its no-push rule below is prompt-level ONLY: the sandbox cannot stop
// a push, so pushWatcher() reads Codex's output and kills the job if one is seen. Best effort.
export const NO_PUSH_RULE = `NON-NEGOTIABLE RULE: you must never push to any git remote (no pushing, no force-pushing), never deploy, and never publish anything (packages, sites, releases). Local commits are allowed. If the task seems to need any of those, stop and tell Nefer what he must do himself.`;
const PUSH_RES = [
  /\bgit(?:\.exe)?\b(?:\s+(?:-c\s+\S+|-C\s+\S+|--\S+|-\S+))*\s+push\b/i,
  /\b(?:wrangler|firebase|netlify|fly|flyctl)\s+(?:deploy|publish)\b/i,
  /\b(?:npm|pnpm|yarn)\s+publish\b/i,
];

/** Feed it output text; calls onPush(line) for the first line that runs a push/deploy. Echoed prompt lines are ignored. */
export function pushWatcher(input, onPush) {
  const echoed = new Set(String(input).split('\n').map((l) => l.trim()).filter(Boolean));
  let buf = '';
  let fired = false;
  return (text) => {
    if (fired) return;
    buf += text;
    const lines = buf.split('\n');
    buf = lines.pop().slice(-2000);
    for (const raw of lines) {
      const line = raw.trim();
      if (!line || echoed.has(line)) continue;
      if (PUSH_RES.some((re) => re.test(line))) { fired = true; onPush(line.slice(0, 200)); return; }
    }
  };
}

export function killProcessTree(child) {
  if (!child) return;
  if (process.platform === 'win32' && child.pid) {
    try { spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', shell: false }).on('error', () => child.kill()); return; } catch {}
  }
  try { child.kill(process.platform === 'win32' ? undefined : 'SIGKILL'); } catch {}
}

export function claudeArgs({ role, model, resume, sessionId, systemFile, addDirs }) {
  const a = ['-p', '--output-format', 'json', '--setting-sources', 'project', '--permission-prompts', 'none'];
  if (role === 'worker') a.push('--permission-mode', 'acceptEdits');
  else if (role === 'full') a.push('--permission-mode', 'bypassPermissions', '--disallowedTools', ...FULL_DISALLOWED);
  else a.push('--permission-mode', 'default', '--disallowedTools', 'Edit', 'Write', 'NotebookEdit', 'Bash', 'PowerShell');
  if (model) a.push('--model', model);
  if (resume) a.push('--resume', resume);
  else if (sessionId) a.push('--session-id', sessionId); // known up front, so the session can be claimed as Ada's before it shows up as a terminal
  // Ada's prompt is far past Windows' 32K command-line limit, so it goes in a file.
  if (systemFile) a.push('--append-system-prompt-file', systemFile);
  if (addDirs?.length) a.push('--add-dir', ...addDirs);
  return a;
}

export function codexArgs({ role, model, resume, cwd, lastMsg }) {
  const sandbox = role === 'worker' ? 'workspace-write' : role === 'full' ? 'danger-full-access' : 'read-only';
  const common = ['--skip-git-repo-check', '-o', lastMsg];
  if (model) common.push('-m', model);
  // `exec resume` has no -s/-C flags; the sandbox goes in as a config override and cwd via spawn.
  if (resume) return ['exec', 'resume', ...common, '-c', `sandbox_mode="${sandbox}"`, resume, '-'];
  return ['exec', ...common, '-C', cwd, '-s', sandbox, '-'];
}

/**
 * Starts a run. Returns { child, done } where done resolves to
 * { ok, text, session, code, error } (Claude also: contextWindow/contextModel when the CLI reports them).
 */
export function runAgent({ agent, role, model, cwd, prompt, resume: resumeId, system, addDirs, onSession }) {
  const lastMsg = path.join(os.tmpdir(), `ada-run-${crypto.randomBytes(4).toString('hex')}.txt`);
  const isClaude = agent === 'claude';
  const full = role === 'full';
  const resume = full ? null : resumeId; // full-mode jobs never share a session with safe ones
  // Codex has no system-prompt flag: put the instructions at the top of a fresh conversation.
  let input = !isClaude && system && !resume ? `${system}\n\n---\n\n${prompt}` : prompt;
  if (full && !isClaude) input = `${NO_PUSH_RULE}\n\n${input}`;
  let systemFile = null;
  if (isClaude && system) { systemFile = lastMsg.replace(/\.txt$/, '-system.md'); fs.writeFileSync(systemFile, system); }
  const sessionId = isClaude && !resume ? crypto.randomUUID() : null;
  const args = isClaude ? claudeArgs({ role, model, resume, sessionId, systemFile, addDirs: addDirs?.filter((d) => fs.existsSync(d)) }) : codexArgs({ role, model, resume, cwd, lastMsg });
  const env = { ...process.env };
  delete env.CLAUDECODE; // let a nested Claude start even if the collector was launched from one

  let out = '';
  let tail = '';
  let session = resume || sessionId;
  if (sessionId) onSession?.(sessionId);
  const child = spawn(isClaude ? 'claude' : 'codex', args, { cwd, windowsHide: true, env, shell: false });
  child.stdin.on('error', () => {});
  child.stdin.end(input);
  let pushSeen = null;
  const watch = full && !isClaude ? pushWatcher(input, (line) => { pushSeen = line; killProcessTree(child); }) : null;
  const grab = (d) => {
    const text = d.toString();
    watch?.(text);
    if (isClaude) out += text;
    else if (!session) {
      session = text.match(/session id:\s*([0-9a-f-]{36})/i)?.[1] || null;
      if (session) onSession?.(session);
    }
    tail = (tail + text).slice(-4000);
  };
  child.stdout.on('data', grab);
  child.stderr.on('data', (d) => { tail = (tail + d.toString()).slice(-4000); if (!isClaude) grab(d); });

  const done = new Promise((resolve) => {
    let spawnErr = null;
    child.on('error', (e) => { spawnErr = e; });
    child.on('close', (code) => {
      if (systemFile) try { fs.unlinkSync(systemFile); } catch {}
      if (isClaude) {
        try {
          const o = JSON.parse(out.trim().split('\n').pop());
          const denied = (o.permission_denials || []).map((d) => d.tool_name);
          // modelUsage[model].contextWindow is the CLI's own window size; the transcript gives the current context (o.usage sums the whole turn).
          const win = windowFromModelUsage(o.modelUsage);
          return resolve({ ok: !o.is_error && code === 0, text: o.result || '', session: o.session_id || session, code, denied, cost: o.total_cost_usd, ...(win ? { contextWindow: win.window, contextModel: win.model } : {}) });
        } catch {
          return resolve({ ok: false, text: '', session, code, error: spawnErr?.message || tail.trim().split('\n').pop() || `exit ${code}` });
        }
      }
      let text = '';
      try { text = fs.readFileSync(lastMsg, 'utf8').trim(); fs.unlinkSync(lastMsg); } catch {}
      if (pushSeen) return resolve({ ok: false, text, session, code, error: `Killed: a git push or deploy command was detected (${pushSeen}). Full mode never pushes or deploys.` });
      const apiErr = [...tail.matchAll(/"message":"([^"]+)"/g)].pop()?.[1];
      const errLine = tail.split('\n').reverse().find((l) => /^ERROR/.test(l));
      resolve({ ok: code === 0 && !!text, text, session, code, error: code === 0 ? null : (spawnErr?.message || apiErr || errLine || `exit ${code}`) });
    });
  });
  return { child, done };
}

export const OP_OUTPUT_MAX = 8 * 1024;

/** Cuts command output to about 8 KB, keeping the start and saying so. */
export function truncateOutput(text, max = OP_OUTPUT_MAX) {
  return text.length > max ? `${text.slice(0, max)}\n…(output truncated at ${Math.round(max / 1024)} KB)` : text;
}

/**
 * Runs one allowlisted operation directly (no shell, no LLM). `op` is { name, cwd, command, args }
 * as resolved by fullmode.mjs. Returns { child, done } where done resolves to { ok, text, code, error }.
 */
export function runOperation(op) {
  let out = '';
  let dropped = false;
  const take = (d) => {
    if (out.length >= OP_OUTPUT_MAX) { dropped = true; return; }
    out += d.toString();
    if (out.length > OP_OUTPUT_MAX) { out = out.slice(0, OP_OUTPUT_MAX); dropped = true; }
  };
  const child = spawn(op.command, op.args, { cwd: op.cwd, windowsHide: true, env: { ...process.env }, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', take);
  child.stderr.on('data', take);
  const done = new Promise((resolve) => {
    let spawnErr = null;
    child.on('error', (e) => { spawnErr = e; });
    child.on('close', (code) => {
      const text = `${out.trim()}${dropped ? `\n…(output truncated at ${OP_OUTPUT_MAX / 1024} KB)` : ''}`.trim();
      if (spawnErr) return resolve({ ok: false, text, code, error: `Could not start ${op.command}: ${spawnErr.message}` });
      resolve({ ok: code === 0, text: text || '(no output)', code, error: code === 0 ? null : `${text}\n\n[exit ${code}]`.trim() });
    });
  });
  return { child, done };
}
