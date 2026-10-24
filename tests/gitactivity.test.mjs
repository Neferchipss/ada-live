import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  GitActivityCache, MAX_REPOS, buildGitActivity, parseGithubRemote, readGitActivity, unpushedList,
} from '../collector/lib/gitactivity.mjs';
import { WorkMap } from '../collector/lib/work.mjs';
import { buildDigest } from '../collector/lib/journal.mjs';

// Every repo lives under os.tmpdir() with a local bare "origin"; nothing here touches the network.
const EMPTY_CFG = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gitact-cfg-')), 'gitconfig');
fs.writeFileSync(EMPTY_CFG, '');
const ENV = { ...process.env, GIT_AUTHOR_NAME: 'Tester', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 'Tester', GIT_COMMITTER_EMAIL: 't@example.com', GIT_CONFIG_GLOBAL: EMPTY_CFG, GIT_CONFIG_NOSYSTEM: '1' };
const git = (cwd, ...args) => execFileSync('git', args, { cwd, env: ENV, encoding: 'utf8', windowsHide: true }).trim();
const GH = { repo: 'o/r', url: 'https://github.com/o/r' };

function commit(dir, name, msg = `add ${name}`) {
  fs.writeFileSync(path.join(dir, name), name);
  git(dir, 'add', name);
  git(dir, 'commit', '-q', '-m', msg);
}

function scene() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gitact-'));
  const origin = path.join(root, 'origin.git');
  const work = path.join(root, 'work');
  fs.mkdirSync(work);
  git(root, 'init', '-q', '--bare', '-b', 'main', origin);
  git(work, 'init', '-q', '-b', 'main');
  git(work, 'remote', 'add', 'origin', origin);
  return { root, origin, work, done: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test('github remotes normalise to https://github.com/owner/repo and never keep credentials', () => {
  for (const u of [
    'https://github.com/o/r.git', 'https://tok:x-oauth@github.com/o/r', 'https://ghp_secret123@github.com/o/r.git/',
    'git@github.com:o/r.git', 'ssh://git@github.com/o/r',
  ]) assert.deepEqual(parseGithubRemote(u), GH, u);
  for (const u of ['', null, 'https://gitlab.com/o/r', 'https://evilgithub.com/o/r', 'C:\\repos\\origin.git']) assert.equal(parseGithubRemote(u), null, String(u));
  assert.ok(!JSON.stringify(parseGithubRemote('https://user:hunter2@github.com/o/r.git')).includes('hunter2'));
});

test('commits, unpushed marker, ahead/behind, push events and fetch events from real git', async () => {
  const s = scene();
  try {
    for (const f of ['a', 'b', 'c']) commit(s.work, f);
    git(s.work, 'push', '-q', '-u', 'origin', 'main');
    commit(s.work, 'd');
    commit(s.work, 'e', 'subject with <b>html</b> & "quotes"');
    git(s.work, 'push', '-q', 'origin', 'main');
    commit(s.work, 'f');
    fs.writeFileSync(path.join(s.work, 'dirty.txt'), 'x');

    const a = await readGitActivity(s.work, GH, 1);
    assert.equal(a.branch, 'main');
    assert.equal(a.remoteBranch, true);
    assert.equal(a.ahead, 1);
    assert.equal(a.behind, 0);
    assert.equal(a.dirty, 1);
    assert.equal(a.repo, 'o/r');
    assert.equal(a.url, 'https://github.com/o/r');
    assert.deepEqual(a.commits.map((c) => c.s), ['add f', 'subject with <b>html</b> & "quotes"', 'add d', 'add c', 'add b', 'add a']);
    assert.deepEqual(a.commits.map((c) => c.pushed), [false, true, true, true, true, true]);
    assert.ok(a.commits.every((c) => c.a === 'Tester' && c.h.length >= 7 && c.t > 0));

    const pushed = a.pushes.filter((p) => p.kind === 'pushed');
    assert.equal(pushed.length, 2, 'two pushes');
    assert.equal(pushed[0].n, 2, 'the second push carried d and e');
    assert.equal(pushed[0].branch, 'main');
    assert.equal(pushed[0].from.length, 7);
    assert.equal(pushed[0].to.length, 7);
    assert.equal(pushed[1].from, '', 'first push created the branch');
    assert.ok(a.lastPush > 0 && a.reflog === true);
    assert.equal(a.pushes.filter((p) => p.kind === 'fetched').length, 0);

    // Someone else pushes; this laptop fetches: labelled 'fetched', and we are behind.
    const other = path.join(s.root, 'other');
    git(s.root, 'clone', '-q', s.origin, other);
    commit(other, 'g');
    git(other, 'push', '-q', 'origin', 'main');
    git(s.work, 'fetch', '-q', 'origin');
    const b = await readGitActivity(s.work, GH, 0);
    assert.equal(b.behind, 1);
    assert.equal(b.ahead, 1);
    const fetched = b.pushes.filter((p) => p.kind === 'fetched');
    assert.equal(fetched.length, 1);
    assert.equal(fetched[0].n, 1);
    assert.equal(b.pushes.filter((p) => p.kind === 'pushed').length, 2, 'a fetch is not a push');
    assert.equal(b.lastPush, a.lastPush);
  } finally { s.done(); }
});

test('a branch that was never pushed has every commit unpushed and says so', async () => {
  const s = scene();
  try {
    commit(s.work, 'a');
    commit(s.work, 'b');
    const a = await readGitActivity(s.work, GH, 0);
    assert.equal(a.remoteBranch, false);
    assert.equal(a.ahead, 2);
    assert.ok(a.commits.every((c) => c.pushed === false));
    assert.equal(a.reflog, false, 'no reflog: reported as such instead of guessed');
    assert.deepEqual(a.pushes, []);
    assert.equal(a.lastPush, null);
  } finally { s.done(); }
});

test('empty repos, detached HEAD, and non-repos never throw', async () => {
  const s = scene();
  try {
    const empty = await readGitActivity(s.work, GH, 0);
    assert.deepEqual(empty.commits, []);
    assert.equal(empty.ahead, 0);
    commit(s.work, 'a');
    git(s.work, 'push', '-q', '-u', 'origin', 'main');
    commit(s.work, 'b');
    git(s.work, 'checkout', '-q', '--detach', 'HEAD');
    const det = await readGitActivity(s.work, GH, 0);
    assert.equal(det.branch, null);
    assert.equal(det.commits.length, 2);
    assert.equal(det.ahead, 1);
    const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'gitact-plain-'));
    try {
      const none = await readGitActivity(plain, GH, 0);
      assert.ok(none === null || (none.commits.length === 0 && none.pushes.length === 0));
      assert.equal(await readGitActivity(path.join(plain, 'missing'), GH, 0).then((r) => (r ? r.commits.length : 0)), 0);
    } finally { fs.rmSync(plain, { recursive: true, force: true }); }
  } finally { s.done(); }
});

test('the cache re-reads only when HEAD or the refs moved', async () => {
  const s = scene();
  try {
    commit(s.work, 'a');
    git(s.work, 'push', '-q', '-u', 'origin', 'main');
    const cache = new GitActivityCache();
    const one = await cache.get(s.work, GH, 0);
    const two = await cache.get(s.work, GH, 3);
    assert.equal(two, one, 'same object: no git history calls ran');
    assert.equal(two.dirty, 3, 'dirty count is still fresh');
    await new Promise((r) => setTimeout(r, 30));
    commit(s.work, 'b');
    const three = await cache.get(s.work, GH, 0);
    assert.notEqual(three, one);
    assert.equal(three.ahead, 1);
    await new Promise((r) => setTimeout(r, 30));
    git(s.work, 'push', '-q', 'origin', 'main');
    const four = await cache.get(s.work, GH, 0);
    assert.equal(four.ahead, 0);
    assert.equal(four.pushes.filter((p) => p.kind === 'pushed').length, 2);
  } finally { s.done(); }
});

test('WorkMap.refreshGit fills activity for GitHub remotes only, with credentials stripped', async () => {
  const s = scene();
  const plain = path.join(s.root, 'plain');
  fs.mkdirSync(plain);
  try {
    commit(s.work, 'a');
    git(s.work, 'push', '-q', '-u', 'origin', 'main');
    commit(s.work, 'b');
    // Swap the remote URL after pushing: the reflog stays, get-url now returns a credentialed GitHub URL (nothing is fetched).
    git(s.work, 'remote', 'set-url', 'origin', 'https://user:ghp_topsecret@github.com/o/r.git');
    git(plain, 'init', '-q', '-b', 'main');
    commit(plain, 'x');

    const wm = new WorkMap(s.root);
    const mk = (name, dir) => ({ name, group: null, path: dir, looseOnly: false, lastModified: Date.now(), recent: [], git: null, isRepo: true, gitPath: dir });
    const gh = mk('ghproj', s.work), local = mk('localproj', plain);
    for (const p of [gh, local]) { wm.projects.set(p.path, p); wm.dirtyGit.add(p); }
    await wm.refreshGit(10);

    assert.equal(gh.github, 'o/r');
    assert.ok(!gh.remote.includes('ghp_topsecret'));
    assert.equal(gh.activity.url, 'https://github.com/o/r');
    assert.equal(gh.activity.ahead, 1);
    assert.equal(local.activity, null, 'no GitHub remote: no deeper git calls');

    const arr = buildGitActivity([gh, local]);
    assert.equal(arr.length, 1);
    assert.equal(arr[0].name, 'ghproj');
    const text = JSON.stringify(arr);
    assert.ok(!text.includes('ghp_topsecret') && !text.includes('user:'));
    assert.deepEqual(unpushedList([gh, local]), [{ project: 'ghproj', ahead: 1 }]);
  } finally { s.done(); }
});

test('the snapshot array is bounded in repos, commits, pushes and bytes', () => {
  const commits = Array.from({ length: 40 }, (_, i) => ({ h: 'abcdef' + i, s: 'x'.repeat(120), a: 'Tester', t: i, pushed: true }));
  const pushes = Array.from({ length: 40 }, (_, i) => ({ kind: i % 2 ? 'pushed' : 'fetched', branch: 'main', t: i, from: 'a'.repeat(7), to: 'b'.repeat(7), n: 2 }));
  const projects = Array.from({ length: 60 }, (_, i) => ({
    name: `p${i}`, path: `C:\\Work\\p${i}`, lastModified: i,
    activity: { repo: 'o/r', url: 'https://github.com/o/r', branch: 'main', remoteBranch: true, ahead: 0, behind: 0, dirty: 0, lastPush: 1, reflog: true, commits, pushes, sig: 'zzz' },
  }));
  const arr = buildGitActivity(projects);
  assert.equal(arr.length, MAX_REPOS);
  assert.equal(arr[0].name, 'p59', 'freshest first');
  for (const g of arr) {
    assert.ok(g.commits.length <= 15 && g.pushes.length <= 15);
    assert.ok(!('sig' in g));
  }
  assert.ok(JSON.stringify(arr).length < 200 * 1024);
});

test('the digest gets one line per project with unpushed commits', () => {
  const entries = [{ t: 10, project: 'babajee', kind: 'commit', hash: 'abc1234', subject: 'x', by: 'Codex' }];
  const d = buildDigest(entries, { since: 0, unpushed: [{ project: 'babajee', ahead: 3 }, { project: 'solo', ahead: 1 }] });
  assert.match(d, /^babajee:\n- /m);
  assert.match(d, /^babajee: 3 commits not pushed$/m);
  assert.match(d, /^solo: 1 commit not pushed$/m);
  assert.equal(buildDigest([], { since: 0 }), '');
  assert.equal(buildDigest(entries, { since: 99, unpushed: [{ project: 'solo', ahead: 2 }] }), 'solo: 2 commits not pushed');
});
