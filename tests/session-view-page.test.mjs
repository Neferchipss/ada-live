// Runs the real docs/app.js against the fake DOM with a fake relay socket that answers sealed 'session-view'
// commands like the collector does: switcher chips, then the viewer's loading / empty / entries / error states.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { installDom, sealFor } from './helpers/fake-dom.mjs';
import { deriveKey, open, seal } from '../collector/lib/crypto.mjs';

const APP = fs.readFileSync(new URL('../docs/app.js', import.meta.url), 'utf8');
const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));
const until = async (fn) => { for (let i = 0; i < 80 && !fn(); i++) await tick(50); };
const now = Date.now();
const SID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const OTHER = 'bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee';
let n = 0;

const sessions = [
  { agent: 'claude', session: SID, title: 'Fix the login <b>bug</b>', project: 'proj', subfolder: 'src', source: 'job', mode: 'safe', status: 'working', startedAt: now - 9e4, lastAt: now - 1000, context: { used: 84300, window: 200000, pct: 42, src: 'data' } },
  { agent: 'codex', session: OTHER, title: 'Refactor', project: 'proj', subfolder: '', source: 'terminal', status: 'idle', startedAt: now - 3e6, lastAt: now - 2e6 },
];
const snap = (over = {}) => ({
  v: 1, generatedAt: now, host: 'LAPTOP', workRoot: 'C:\\Work', sessions: [], tasks: [], projects: [], activeMap: [], journal: [], gitActivity: [],
  chat: { thread: { id: 'th', brain: { agent: 'claude', model: '' }, busy: false, updatedAt: now, total: 0, messages: [] }, jobs: [], brains: { claude: [''], codex: [''] }, memory: true, safeMode: true, fullModePinSet: true, media: { relay: true, ffmpeg: false, maxUpload: 1e6, maxFiles: 4, chunk: 1e5 }, uploads: [], sessions, ...over },
});

const target = (map) => ({ closest: (sel) => map[sel] || null, matches: () => false });

// reply(cmd) -> response object (or null to stay silent)
async function boot({ reply = () => null, chat = {} } = {}) {
  const feed = sealFor(snap(chat));
  const d = installDom({ feed, config: { source: 'local', path: 'data/live.enc.json', pollSec: 3600, relayUrl: 'https://relay.test' } });
  const cmds = [];
  globalThis.WebSocket = class {
    constructor() {
      this.readyState = 1; this.bufferedAmount = 0;
      globalThis.__ws = this;
      setTimeout(() => this.onopen?.(), 0);
    }
    send(str) {
      const env = JSON.parse(str);
      const key = deriveKey('test-pass', feed.salt);
      const cmd = open(env, key);
      cmds.push(cmd);
      Promise.resolve(reply(cmd)).then((obj) => {
        if (obj === null || obj === undefined) return;
        const body = JSON.stringify(obj);
        const parts = Math.max(1, Math.ceil(body.length / 50));
        const size = Math.ceil(body.length / parts);
        for (let i = parts - 1; i >= 0; i--) { // out of order on purpose
          setTimeout(() => this.onmessage?.({ data: JSON.stringify({ m: 1, ...seal({ sv: cmd.id, i, n: parts, d: body.slice(i * size, (i + 1) * size) }, key, feed.salt) }) }), 0);
        }
      });
    }
    close() {}
  };
  await import(`../docs/app.js?svpage=${++n}`);
  await tick();
  d.els.get('password').value = 'test-pass';
  await d.els.get('login-form').fire('submit');
  for (let i = 0; i < 300 && d.els.get('unlock').textContent !== 'Unlock'; i++) await tick(50);
  await tick(100);
  const el = (id) => d.els.get(id);
  const pick = async (sv) => { await el('sv-bar').fire('click', { target: target({ '[data-sv]': { dataset: { sv } } }) }); };
  const back = async () => { await el('sv-banner').fire('click', { target: target({ '[data-sv-back]': {} }) }); };
  return { d, el, cmds, pick, back };
}

test('the page carries the new cache-bust and the viewer elements', () => {
  assert.match(APP, /\?v=sv-7/);
  const html = fs.readFileSync(new URL('../docs/index.html', import.meta.url), 'utf8');
  for (const id of ['sv-bar', 'sv-banner', 'sv-actions']) assert.match(html, new RegExp(`id="${id}"`));
  assert.match(html, /app\.js\?v=sv-7/);
  assert.match(html, /style\.css\?v=sv-7/);
});

test('switcher: Ada, Map, then only active chats; no Recent label and no finished chips', async () => {
  const b = await boot();
  try {
    const bar = b.el('sv-bar');
    assert.equal(bar.hidden, false);
    const html = bar.innerHTML;
    assert.ok(html.indexOf('data-sv-ada') < html.indexOf('data-sv-map'));
    assert.ok(html.indexOf('data-sv-map') < html.indexOf(`data-sv="claude|${SID}"`));
    assert.ok(!html.includes('Recent') && !html.includes('sv-sep'));
    assert.ok(!html.includes(`claude|${OTHER}`) && !html.includes(`codex|${OTHER}`), 'idle session is not on the ribbon');
    assert.match(html, /data-s="working"/);
    assert.match(html, /Job<\/span>/);
    assert.match(html, /42%/);
    assert.ok(!html.includes('<b>bug</b>'), 'title must be escaped');
    assert.match(html, /&lt;b&gt;bug/);
  } finally { b.d.restore(); }
});

test('switcher with nothing active is just Ada + Map', async () => {
  const b = await boot({ chat: { sessions: [{ ...sessions[1] }] } });
  try {
    const html = b.el('sv-bar').innerHTML;
    assert.equal((html.match(/<button/g) || []).length, 2);
    assert.ok(html.includes('data-sv-ada') && html.includes('data-sv-map') && !html.includes('data-sv='));
  } finally { b.d.restore(); }
});

test('switcher is hidden when there is nothing to open', async () => {
  const b = await boot({ chat: { sessions: [] } });
  try { assert.equal(b.el('sv-bar').hidden, true); } finally { b.d.restore(); }
});

test('viewer: loading, then entries; read-only banner, composer swapped, tools expand, text escaped', async () => {
  const entries = [
    { i: 32, t: now - 5000, role: 'user', kind: 'text', text: 'please <img src=x onerror=alert(1)> fix it' },
    { i: 64, t: now - 4000, role: 'assistant', kind: 'text', text: 'On it. **bold** and <script>x</script>' },
    { i: 96, t: now - 3000, role: 'assistant', kind: 'tool', tool: 'Bash', text: 'npm test' },
    { i: 128, t: now - 2000, role: 'system', kind: 'result', text: '12 passed' },
  ];
  let answer;
  const gate = new Promise((r) => { answer = r; });
  const b = await boot({ reply: async (c) => { if (c.type !== 'session-view') return null; await gate; return { ok: true, entries, next: 128, more: false, status: 'working', context: sessions[0].context }; } });
  try {
    await b.pick(`claude|${SID}`);
    await tick();
    assert.match(b.el('chat-log').innerHTML, /Loading conversation/);
    assert.equal(b.el('composer').hidden, true, 'composer is replaced');
    assert.equal(b.el('sv-actions').hidden, false);
    assert.equal(b.cmds.at(-1).type, 'session-view');
    assert.deepEqual([b.cmds.at(-1).agent, b.cmds.at(-1).session], ['claude', SID]);
    assert.ok(!('path' in b.cmds.at(-1)) && !('file' in b.cmds.at(-1)));
    answer();
    await until(() => !/Loading/.test(b.el('chat-log').innerHTML));
    const log = b.el('chat-log').innerHTML;
    assert.match(log, /sv-u/);
    assert.match(log, /sv-a/);
    assert.match(log, /<b>bold<\/b>/, 'assistant text goes through md()');
    assert.ok(!log.includes('<img src=x') && !log.includes('<script>'), 'raw markup never reaches the DOM');
    assert.match(log, /data-sv-tool="96"/);
    assert.ok(!log.includes('12 passed'), 'result is collapsed until tapped');
    const banner = b.el('sv-banner');
    assert.equal(banner.hidden, false);
    assert.match(banner.innerHTML, /Viewing/);
    assert.match(banner.innerHTML, /read-only/);
    assert.match(banner.innerHTML, /Job/);
    assert.match(banner.innerHTML, /Back to Ada/);
    assert.match(banner.innerHTML, /42%/);
    assert.match(b.el('sv-bar').innerHTML, /sv-chip on/);
    await b.el('chat-log').fire('click', { target: target({ '[data-sv-tool]': { dataset: { svTool: '96' } } }) });
    assert.match(b.el('chat-log').innerHTML, /12 passed/);
    // the next poll asks only for what is new
    assert.equal(b.cmds.filter((c) => c.type === 'session-view').length, 1);
  } finally { b.d.restore(); }
});

test('viewer: empty and error states', async () => {
  let mode = 'empty';
  const b = await boot({ reply: (c) => (c.type === 'session-view' ? (mode === 'empty' ? { ok: true, entries: [], next: -1, more: false, status: 'idle' } : { ok: false, err: 'unknown session' }) : null) });
  try {
    await b.pick(`codex|${OTHER}`);
    await until(() => !/Loading/.test(b.el('chat-log').innerHTML));
    assert.match(b.el('chat-log').innerHTML, /Nothing in this conversation yet/);
    assert.match(b.el('sv-banner').innerHTML, /Terminal/);
    await b.back();
    assert.equal(b.el('composer').hidden, false);
    mode = 'error';
    await tick(1100); // the laptop allows one request per second per session
    await b.pick(`codex|${OTHER}`);
    await until(() => !/Loading/.test(b.el('chat-log').innerHTML));
    const log = b.el('chat-log').innerHTML;
    assert.match(log, /Couldn’t load this conversation: unknown session/);
    assert.match(log, /data-sv-retry/);
  } finally { b.d.restore(); }
});

test('viewer: no answer from the laptop is an error with retry, not a hang', async () => {
  const b = await boot({ reply: () => null });
  try {
    // a closed socket makes the request fail immediately
    globalThis.__ws.readyState = 3;
    await b.pick(`claude|${SID}`);
    await until(() => !/Loading/.test(b.el('chat-log').innerHTML));
    assert.match(b.el('chat-log').innerHTML, /Couldn’t load this conversation: not connected/);
  } finally { b.d.restore(); }
});

test('Back to Ada restores the composer; Ask Ada drafts a message naming the session and never sends into it', async () => {
  const b = await boot({ reply: (c) => (c.type === 'session-view' ? { ok: true, entries: [], next: -1, status: 'working' } : null) });
  try {
    await b.pick(`claude|${SID}`);
    await until(() => b.cmds.length > 0);
    await tick(200);
    await b.el('sv-actions').fire('click', { target: target({ '[data-sv-ask]': {} }) });
    await tick();
    assert.equal(b.el('composer').hidden, false);
    assert.equal(b.el('sv-actions').hidden, true);
    assert.equal(b.el('sv-banner').hidden, true);
    assert.match(b.el('chat-input').value, /^\[re: Fix the login <b>bug<\/b> session aaaaaaaa\] /);
    assert.ok(!b.cmds.some((c) => c.type === 'say'), 'nothing was sent');
    assert.match(b.el('sv-bar').innerHTML, /sv-chip sv-ada on/);
  } finally { b.d.restore(); }
});

test('the strip opens the session viewer', () => {
  assert.match(APP, /data-sv-open/);
  assert.match(APP, /closest\('\[data-sv-open\]'\)/);
});
