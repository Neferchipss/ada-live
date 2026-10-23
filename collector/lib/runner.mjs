// Runs one headless turn of Claude Code or Codex in a folder and returns its final reply.
//   role 'head'   — Ada herself: may read anything under the folder, can't change anything.
//   role 'worker' — safe mode: may edit files inside its own folder only. No shell for Claude;
//                   Codex runs its sandbox (writes limited to the folder, no network).
// Neither inherits Nefer's personal Claude settings, which allow edits anywhere plus git/node.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';

function claudeArgs({ role, model, resume, systemFile, addDirs }) {
  const a = ['-p', '--output-format', 'json', '--setting-sources', 'project', '--permission-prompts', 'none'];
  if (role === 'worker') a.push('--permission-mode', 'acceptEdits');
  else a.push('--permission-mode', 'default', '--disallowedTools', 'Edit', 'Write', 'NotebookEdit', 'Bash', 'PowerShell');
  if (model) a.push('--model', model);
  if (resume) a.push('--resume', resume);
  // Ada's prompt is far past Windows' 32K command-line limit, so it goes in a file.
  if (systemFile) a.push('--append-system-prompt-file', systemFile);
  if (addDirs?.length) a.push('--add-dir', ...addDirs);
  return a;
}

function codexArgs({ role, model, resume, cwd, lastMsg }) {
  const sandbox = role === 'worker' ? 'workspace-write' : 'read-only';
  const common = ['--skip-git-repo-check', '-o', lastMsg];
  if (model) common.push('-m', model);
  // `exec resume` has no -s/-C flags; the sandbox goes in as a config override and cwd via spawn.
  if (resume) return ['exec', 'resume', ...common, '-c', `sandbox_mode="${sandbox}"`, resume, '-'];
  return ['exec', ...common, '-C', cwd, '-s', sandbox, '-'];
}

/**
 * Starts a run. Returns { child, done } where done resolves to
 * { ok, text, session, code, error }.
 */
export function runAgent({ agent, role, model, cwd, prompt, resume, system, addDirs, onSession }) {
  const lastMsg = path.join(os.tmpdir(), `ada-run-${crypto.randomBytes(4).toString('hex')}.txt`);
  const isClaude = agent === 'claude';
  // Codex has no system-prompt flag: put the instructions at the top of a fresh conversation.
  const input = !isClaude && system && !resume ? `${system}\n\n---\n\n${prompt}` : prompt;
  let systemFile = null;
  if (isClaude && system) { systemFile = lastMsg.replace(/\.txt$/, '-system.md'); fs.writeFileSync(systemFile, system); }
  const args = isClaude ? claudeArgs({ role, model, resume, systemFile, addDirs: addDirs?.filter((d) => fs.existsSync(d)) }) : codexArgs({ role, model, resume, cwd, lastMsg });
  const env = { ...process.env };
  delete env.CLAUDECODE; // let a nested Claude start even if the collector was launched from one

  let out = '';
  let tail = '';
  let session = resume || null;
  const child = spawn(isClaude ? 'claude' : 'codex', args, { cwd, windowsHide: true, env, shell: false });
  child.stdin.on('error', () => {});
  child.stdin.end(input);
  const grab = (d) => {
    const text = d.toString();
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
          return resolve({ ok: !o.is_error && code === 0, text: o.result || '', session: o.session_id || session, code, denied, cost: o.total_cost_usd });
        } catch {
          return resolve({ ok: false, text: '', session, code, error: spawnErr?.message || tail.trim().split('\n').pop() || `exit ${code}` });
        }
      }
      let text = '';
      try { text = fs.readFileSync(lastMsg, 'utf8').trim(); fs.unlinkSync(lastMsg); } catch {}
      const apiErr = [...tail.matchAll(/"message":"([^"]+)"/g)].pop()?.[1];
      const errLine = tail.split('\n').reverse().find((l) => /^ERROR/.test(l));
      resolve({ ok: code === 0 && !!text, text, session, code, error: code === 0 ? null : (spawnErr?.message || apiErr || errLine || `exit ${code}`) });
    });
  });
  return { child, done };
}
