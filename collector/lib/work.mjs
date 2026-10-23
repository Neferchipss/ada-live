// Maps the work folder (C:\Work) into groups and projects, tracks recent file changes
// with a recursive watcher, and reads git state for repos.
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { safeReaddir, safeStat, normPath } from './util.mjs';

const run = promisify(execFile);

// Folders that churn or are huge and say nothing about the work itself.
const SKIP = new Set([
  'node_modules', '.git', 'target', 'Library', 'Temp', 'Intermediate', 'Saved', 'DerivedDataCache',
  'Binaries', '.next', 'out', 'dist', 'build', '.cache', '__pycache__', '.venv', 'venv', 'obj',
  '.vs', '.idea', '.godot', '.import', 'Logs', '.turbo', '.vercel', 'coverage',
]);
const MARKERS = ['.git', 'package.json', 'Cargo.toml', 'CLAUDE.md', 'AGENTS.md', 'README.md',
  'pyproject.toml', 'project.godot', 'ProjectSettings', 'index.html', 'go.mod'];
const MAX_ENTRIES = 4000;
const MAX_DEPTH = 5;

// The project folder itself, or a repo one level down (e.g. "client/site-repo").
function findRepo(dir) {
  if (fs.existsSync(path.join(dir, '.git'))) return dir;
  for (const e of safeReaddir(dir)) {
    if (e.isDirectory() && !SKIP.has(e.name) && fs.existsSync(path.join(dir, e.name, '.git'))) return path.join(dir, e.name);
  }
  return null;
}

function looksLikeProject(dir, entries) {
  const names = new Set(entries.map((e) => e.name));
  if (MARKERS.some((m) => names.has(m))) return true;
  return entries.some((e) => /\.(uproject|sln)$/i.test(e.name));
}

export class WorkMap {
  constructor(root) {
    this.root = root;
    this.projects = new Map(); // normPath -> project
    this.watcher = null;
    this.dirtyGit = new Set();
  }

  // Decide what counts as a project: a top-level folder that looks like one,
  // otherwise every sub-folder of a top-level (client) folder.
  discover() {
    const found = new Map();
    for (const top of safeReaddir(this.root)) {
      if (!top.isDirectory() || top.name.startsWith('.')) continue;
      const topPath = path.join(this.root, top.name);
      const entries = safeReaddir(topPath);
      if (looksLikeProject(topPath, entries)) {
        found.set(normPath(topPath), this.#make(topPath, top.name, null));
        continue;
      }
      const subs = entries.filter((e) => e.isDirectory() && !e.name.startsWith('.') && !SKIP.has(e.name));
      for (const sub of subs) {
        const p = path.join(topPath, sub.name);
        found.set(normPath(p), this.#make(p, sub.name, top.name));
      }
      const loose = entries.filter((e) => e.isFile());
      if (loose.length) {
        const p = topPath;
        found.set(normPath(p), this.#make(p, `${top.name} (loose files)`, top.name, true));
      }
    }
    // keep scan results for projects that still exist
    for (const [k, v] of found) {
      const old = this.projects.get(k);
      if (old) Object.assign(v, { lastModified: old.lastModified, recent: old.recent, git: old.git, remote: old.remote, github: old.github });
    }
    this.projects = found;
  }

  #make(p, name, group, looseOnly = false) {
    const gitPath = looseOnly ? null : findRepo(p);
    return { name, group, path: p, looseOnly, lastModified: 0, recent: [], git: null, isRepo: !!gitPath, gitPath };
  }

  // Bounded walk to find the newest files in one project.
  scanProject(proj) {
    let count = 0;
    const recent = [];
    const walk = (dir, depth) => {
      for (const e of safeReaddir(dir)) {
        if (count++ > MAX_ENTRIES) return;
        if (e.name.startsWith('.') && e.name !== '.github') continue;
        const p = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (proj.looseOnly || SKIP.has(e.name) || depth >= MAX_DEPTH) continue;
          walk(p, depth + 1);
        } else if (e.isFile()) {
          const st = safeStat(p);
          if (st) recent.push({ file: path.relative(proj.path, p).replace(/\\/g, '/'), t: st.mtimeMs });
        }
      }
    };
    walk(proj.path, 0);
    recent.sort((a, b) => b.t - a.t);
    proj.recent = recent.slice(0, 6);
    proj.lastModified = Math.max(recent[0]?.t || 0, safeStat(proj.path)?.mtimeMs || 0);
  }

  scanAll() {
    this.discover();
    for (const p of this.projects.values()) this.scanProject(p);
    for (const p of this.projects.values()) if (p.isRepo) this.dirtyGit.add(p);
  }

  // Find which project a path belongs to (longest matching project path).
  projectFor(file) {
    const n = normPath(file);
    let best = null;
    for (const [k, v] of this.projects) {
      if ((n === k || n.startsWith(k + path.sep)) && (!best || k.length > normPath(best.path).length)) {
        if (v.looseOnly && n !== k && path.dirname(n) !== k) continue;
        best = v;
      }
    }
    return best;
  }

  watch() {
    try {
      this.watcher = fs.watch(this.root, { recursive: true }, (_ev, rel) => {
        if (!rel) return;
        const parts = rel.split(/[\\/]/);
        if (parts.some((x) => SKIP.has(x))) return;
        const full = path.join(this.root, rel);
        const proj = this.projectFor(full);
        if (!proj) return;
        const now = Date.now();
        proj.lastModified = now;
        const relFile = path.relative(proj.path, full).replace(/\\/g, '/');
        proj.recent = [{ file: relFile, t: now }, ...proj.recent.filter((r) => r.file !== relFile)].slice(0, 6);
        if (proj.isRepo) this.dirtyGit.add(proj);
      });
    } catch (err) {
      console.warn('[work] recursive watch unavailable, relying on rescans:', err.message);
    }
  }

  async refreshGit(limit = 12) {
    const batch = [...this.dirtyGit].slice(0, limit);
    await Promise.all(batch.map(async (p) => {
      this.dirtyGit.delete(p);
      try {
        const opts = { cwd: p.gitPath || p.path, windowsHide: true, timeout: 8000 };
        const [{ stdout: st }, { stdout: lg }, remote] = await Promise.all([
          run('git', ['status', '--porcelain=v1', '-b'], opts),
          run('git', ['log', '-1', '--format=%h%x1f%s%x1f%cI'], opts).catch(() => ({ stdout: '' })),
          run('git', ['remote', 'get-url', 'origin'], opts).then((r) => r.stdout.trim()).catch(() => ''),
        ]);
        const gh = remote.match(/github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?\/?$/i);
        p.remote = remote ? remote.replace(/\/\/[^@/]+@/, '//') : '';
        p.github = gh ? `${gh[1]}/${gh[2]}` : null;
        const lines = st.split('\n').filter(Boolean);
        const head = lines.shift() || '';
        const m = head.match(/^## ([^.\s]+)(?:\.\.\.\S+)?(?: \[(.+)\])?/);
        const [hash, subject, when] = lg.trim().split('\x1f');
        p.git = {
          branch: m?.[1] || '?',
          tracking: m?.[2] || '',
          changed: lines.length,
          last: hash ? { hash, subject, t: Date.parse(when) } : null,
        };
      } catch {
        p.git = p.git || null;
      }
    }));
  }

  // Ask GitHub (via the logged-in gh CLI) whether each repo is public/private and
  // has a Pages site. Cached on disk; refreshed at most hourly per repo.
  async refreshGithub(cacheFile) {
    if (!this.ghCache) {
      try { this.ghCache = JSON.parse(fs.readFileSync(cacheFile, 'utf8')); } catch { this.ghCache = {}; }
    }
    const repos = new Set([...this.projects.values()].map((p) => p.github).filter(Boolean));
    let changed = false;
    for (const repo of repos) {
      const hit = this.ghCache[repo];
      if (hit && Date.now() - hit.checked < 3600e3) continue;
      const info = { checked: Date.now() };
      try {
        const { stdout } = await run('gh', ['api', `repos/${repo}`, '--jq', '{private: .private, pages: .has_pages, url: .html_url}'], { windowsHide: true, timeout: 15000 });
        Object.assign(info, JSON.parse(stdout));
        if (info.pages) {
          const { stdout: pg } = await run('gh', ['api', `repos/${repo}/pages`, '--jq', '.html_url'], { windowsHide: true, timeout: 15000 }).catch(() => ({ stdout: '' }));
          info.site = pg.trim() || null;
        }
      } catch {
        info.unknown = true; // no access (someone else's private repo) or gh offline
      }
      this.ghCache[repo] = info;
      changed = true;
    }
    if (changed) { try { fs.writeFileSync(cacheFile, JSON.stringify(this.ghCache, null, 1)); } catch {} }
  }

  // local | git (no GitHub remote) | github | pages
  #kind(p) {
    if (!p.isRepo) return { kind: 'local' };
    if (!p.github) return { kind: 'git', remote: p.remote || null };
    const info = this.ghCache?.[p.github] || {};
    return {
      kind: info.site ? 'pages' : 'github',
      repo: p.github, private: info.private ?? null, site: info.site || null, url: info.url || `https://github.com/${p.github}`,
    };
  }

  list() {
    return [...this.projects.values()].map((p) => ({
      name: p.name, group: p.group, path: p.path, lastModified: p.lastModified,
      recent: p.recent, git: p.git, isRepo: p.isRepo, looseOnly: p.looseOnly, ...this.#kind(p),
    }));
  }
}
