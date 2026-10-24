// Recent commits and pushes for repos with a GitHub remote, read from local git only
// (git log, the reflog of the remote-tracking refs, rev-list). No network, no GitHub API, no tokens.
// Names, subjects and hashes only: never file contents or diffs.
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { clip, safeStat } from './util.mjs';

const run = promisify(execFile);

export const MAX_COMMITS = 15;
export const MAX_PUSHES = 10;
export const MAX_FETCHES = 5;
export const MAX_REPOS = 25;
const TIMEOUT = 8000;
const ZERO = /^0+$/;

/** { repo: 'owner/name', url: 'https://github.com/owner/name' } for any GitHub remote form, else null. Credentials never survive. */
export function parseGithubRemote(remote) {
  const m = String(remote || '').trim().match(/^(?:(?:https?|ssh|git):\/\/(?:[^@/]+@)?|[^@/\s]+@)github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i);
  if (!m) return null;
  return { repo: `${m[1]}/${m[2]}`, url: `https://github.com/${m[1]}/${m[2]}` };
}

const git = (cwd, args) => run('git', args, { cwd, windowsHide: true, timeout: TIMEOUT, maxBuffer: 4 * 1024 * 1024 }).then((r) => r.stdout);
const gitOpt = (cwd, args) => git(cwd, args).catch(() => '');

/** The real git directory (a `.git` file points elsewhere in worktrees and submodules). */
function gitDir(dir) {
  const dot = path.join(dir, '.git');
  const st = safeStat(dot);
  if (!st) return null;
  if (st.isDirectory()) return dot;
  try {
    const m = fs.readFileSync(dot, 'utf8').match(/^gitdir:\s*(.+)$/m);
    return m ? path.resolve(dir, m[1].trim()) : null;
  } catch { return null; }
}

/** Cheap fingerprint of "did anything git-relevant change": mtimes of HEAD, packed-refs, the reflogs and the branch refs. */
export function signature(dir, branch, defBranch) {
  const g = gitDir(dir);
  if (!g) return '';
  const parts = ['HEAD', 'packed-refs', 'logs/HEAD', 'refs/remotes/origin', 'logs/refs/remotes/origin', 'refs/heads'];
  for (const b of new Set([branch, defBranch].filter(Boolean))) parts.push(`refs/heads/${b}`, `refs/remotes/origin/${b}`, `logs/refs/remotes/origin/${b}`);
  return parts.map((x) => safeStat(path.join(g, x))?.mtimeMs ?? 0).join('|');
}

const isoMs = (s) => { const t = Date.parse(s); return Number.isFinite(t) ? t : 0; };

/** Push and fetch events from the reflog of origin/<branch>, newest first. null = no reflog at all (fresh clone, expired). */
async function reflogEvents(dir, branch) {
  const out = await gitOpt(dir, ['reflog', 'show', '--date=iso-strict', '--format=%H%x1f%gd%x1f%gs', `refs/remotes/origin/${branch}`, '--']);
  const rows = out.split('\n').filter(Boolean).map((l) => {
    const [hash, sel, msg] = l.split('\x1f');
    return { hash, t: isoMs((sel || '').match(/@\{(.+)\}$/)?.[1]), msg: msg || '' };
  });
  if (!rows.length) return null;
  const events = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i], old = rows[i + 1]?.hash || '';
    const kind = /^update by push/i.test(r.msg) ? 'pushed' : 'fetched';
    events.push({ kind, branch, t: r.t, from: old && !ZERO.test(old) ? old : '', to: r.hash, msg: r.msg });
  }
  return events;
}

async function withCounts(dir, events) {
  const out = [];
  for (const e of events) {
    let n = null;
    if (e.from && e.to) {
      const c = parseInt(await gitOpt(dir, ['rev-list', '--count', `${e.from}..${e.to}`]), 10);
      if (Number.isFinite(c)) n = c;
    }
    out.push({ kind: e.kind, branch: e.branch, t: e.t, from: e.from.slice(0, 7), to: e.to.slice(0, 7), n });
  }
  return out;
}

/**
 * Everything the Work page shows for one repo. Never throws: returns null if the folder is not a usable repo.
 * dir: working folder; github: { repo, url } from parseGithubRemote; changed: dirty-file count from git status.
 */
export async function readGitActivity(dir, github, changed = 0) {
  try {
    const branch = (await gitOpt(dir, ['symbolic-ref', '--short', '-q', 'HEAD'])).trim() || null; // null: detached or empty
    const headRef = (await gitOpt(dir, ['symbolic-ref', '--short', '-q', 'refs/remotes/origin/HEAD'])).trim().replace(/^origin\//, '');
    const hasHead = !!(await gitOpt(dir, ['rev-parse', '--verify', '-q', 'HEAD'])).trim();
    const remoteBranch = branch ? !!(await gitOpt(dir, ['rev-parse', '--verify', '-q', `refs/remotes/origin/${branch}`])).trim() : false;

    // Commits that no origin ref contains are the unpushed ones.
    const unpushed = new Set();
    let ahead = 0, behind = 0;
    if (hasHead) {
      const lines = (await gitOpt(dir, ['rev-list', 'HEAD', '--not', '--remotes=origin', '-n', '500'])).split('\n').filter(Boolean);
      lines.forEach((h) => unpushed.add(h));
      ahead = lines.length;
      if (remoteBranch) {
        const [a, b] = (await gitOpt(dir, ['rev-list', '--left-right', '--count', `HEAD...refs/remotes/origin/${branch}`])).trim().split(/\s+/).map(Number);
        if (Number.isFinite(a) && Number.isFinite(b)) { ahead = a; behind = b; }
      }
    }

    const commits = hasHead
      ? (await gitOpt(dir, ['log', `-n${MAX_COMMITS}`, '--format=%H%x1f%h%x1f%s%x1f%an%x1f%cI'])).split('\n').filter(Boolean).map((l) => {
        const [full, h, s, a, c] = l.split('\x1f');
        return { h, s: clip(s, 120), a: clip(a, 40), t: isoMs(c), pushed: !unpushed.has(full) };
      })
      : [];

    const branches = [...new Set([branch, headRef].filter(Boolean))];
    let events = [], anyLog = false;
    for (const b of branches) {
      const ev = await reflogEvents(dir, b);
      if (ev) { anyLog = true; events.push(...ev); }
    }
    events.sort((x, y) => y.t - x.t);
    const pushes = await withCounts(dir, [
      ...events.filter((e) => e.kind === 'pushed').slice(0, MAX_PUSHES),
      ...events.filter((e) => e.kind === 'fetched').slice(0, MAX_FETCHES),
    ]);
    const lastPush = pushes.find((p) => p.kind === 'pushed')?.t || null;

    return {
      repo: github.repo, url: github.url, branch, remoteBranch, ahead, behind, dirty: changed || 0,
      lastPush, reflog: anyLog, commits, pushes,
      headRef, sig: signature(dir, branch, headRef),
    };
  } catch {
    return null;
  }
}

/** Per-repo cache: the deeper git calls only re-run when the fingerprint moved (dirty count is always fresh). */
export class GitActivityCache {
  constructor() { this.byDir = new Map(); }

  async get(dir, github, changed = 0) {
    const prev = this.byDir.get(dir);
    if (prev) {
      const now = signature(dir, prev.branch, prev.headRef);
      if (now && now === prev.sig && prev.repo === github.repo) {
        prev.dirty = changed || 0;
        return prev;
      }
    }
    const fresh = await readGitActivity(dir, github, changed);
    if (fresh) this.byDir.set(dir, fresh);
    return fresh || prev || null;
  }
}

/** Compact snapshot entry for one project (bounded; no internal fields). */
export function compactActivity(project, a) {
  return {
    name: project.name, path: project.path, repo: a.repo, url: a.url, branch: a.branch, remoteBranch: a.remoteBranch,
    ahead: a.ahead, behind: a.behind, dirty: a.dirty, lastPush: a.lastPush, reflog: a.reflog,
    commits: a.commits.slice(0, MAX_COMMITS), pushes: a.pushes.slice(0, MAX_PUSHES + MAX_FETCHES),
  };
}

/** The snapshot's gitActivity array: freshest MAX_REPOS projects that have activity. */
export function buildGitActivity(projects) {
  return projects
    .filter((p) => p.activity)
    .sort((a, b) => (b.lastModified || 0) - (a.lastModified || 0))
    .slice(0, MAX_REPOS)
    .map((p) => compactActivity(p, p.activity));
}

/** [{ project, ahead }] for Ada's digest. */
export function unpushedList(projects) {
  return projects.filter((p) => p.activity?.ahead > 0).map((p) => ({ project: p.name, ahead: p.activity.ahead }));
}
