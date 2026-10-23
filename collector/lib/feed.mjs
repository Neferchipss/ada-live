// Publishes the encrypted snapshot to the repo's `feed` branch.
// Keeps a dedicated clone in ~/.ada-viewer/feed and force-pushes a single orphan
// commit each time, so the branch never grows.
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { STATE_DIR } from './config.mjs';

const run = promisify(execFile);
const DIR = path.join(STATE_DIR, 'feed');
const BRANCH = 'feed';
const FILE = 'live.enc.json';

const git = (...args) => run('git', args, { cwd: DIR, windowsHide: true, timeout: 60000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });

export class FeedPublisher {
  constructor(remote, minIntervalMs = 30000) {
    this.remote = remote;
    this.minInterval = minIntervalMs;
    this.lastPush = 0;
    this.pending = null;
    this.busy = false;
    this.ready = this.#init();
  }

  async #init() {
    fs.mkdirSync(DIR, { recursive: true });
    if (!fs.existsSync(path.join(DIR, '.git'))) {
      await git('init', '-q');
      await git('checkout', '-q', '--orphan', BRANCH);
    }
    await git('remote', 'remove', 'origin').catch(() => {});
    await git('remote', 'add', 'origin', this.remote);
    await git('config', 'user.name', 'ada-live');
    await git('config', 'user.email', 'ada-live@users.noreply.github.com');
  }

  // Queue the newest envelope; pushes at most once per minInterval.
  offer(envJson) {
    this.pending = envJson;
    this.#maybePush();
  }

  async #maybePush() {
    if (this.busy || !this.pending) return;
    const wait = this.lastPush + this.minInterval - Date.now();
    if (wait > 0) {
      clearTimeout(this.timer);
      this.timer = setTimeout(() => this.#maybePush(), wait);
      return;
    }
    this.busy = true;
    const body = this.pending;
    this.pending = null;
    try {
      await this.ready;
      fs.writeFileSync(path.join(DIR, FILE), body);
      await git('add', FILE);
      // Fresh orphan commit every time: one commit, no history.
      const { stdout: tree } = await git('write-tree');
      const { stdout: commit } = await git('commit-tree', tree.trim(), '-m', 'feed');
      await git('update-ref', `refs/heads/${BRANCH}`, commit.trim());
      await git('push', '-q', '-f', 'origin', `${BRANCH}:${BRANCH}`);
      this.lastPush = Date.now();
      console.log(`[feed] pushed ${new Date().toLocaleTimeString()}`);
    } catch (e) {
      console.error('[feed] push failed:', e.stderr || e.message);
      this.lastPush = Date.now(); // back off a full interval before retrying
      if (!this.pending) this.pending = body;
    } finally {
      this.busy = false;
      if (this.pending) this.#maybePush();
    }
  }
}
