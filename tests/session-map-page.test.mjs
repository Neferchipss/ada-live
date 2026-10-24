// Runs the real docs/app.js against the fake DOM: the Map chip, the sheet, collapse state, leaf and root taps, empty state.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { installDom, sealFor } from './helpers/fake-dom.mjs';

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));
const now = Date.now();
const A = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', B = 'bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee', C = 'cccccccc-bbbb-cccc-dddd-eeeeeeeeeeee', D = 'dddddddd-bbbb-cccc-dddd-eeeeeeeeeeee';
const sessions = [
  { agent: 'claude', session: A, title: 'Fix <b>login</b>', project: 'proj', subfolder: 'src/components', source: 'job', status: 'working', startedAt: now - 9e4, lastAt: now - 1000, context: { used: 84300, window: 200000, src: 'data' } },
  { agent: 'codex', session: B, title: 'Needs approval', project: 'proj', subfolder: 'tests', source: 'terminal', status: 'blocked', startedAt: now - 9e4, lastAt: now - 2000 },
  { agent: 'claude', session: C, title: 'Scratch', project: '', subfolder: '', source: 'terminal', status: 'working', startedAt: now - 9e4, lastAt: now - 3000 },
  { agent: 'claude', session: D, title: 'Finished earlier', project: 'proj', subfolder: 'src/components', source: 'job', status: 'idle', startedAt: now - 3e6, lastAt: now - 3600e3 },
];
const snap = (list) => ({
  v: 1, generatedAt: now, host: 'LAPTOP', workRoot: 'C:\Work', sessions: [], tasks: [], projects: [], activeMap: [], journal: [], gitActivity: [],
  chat: { thread: { id: 'th', brain: { agent: 'claude', model: '' }, busy: false, updatedAt: now, total: 0, messages: [], context: { agent: 'claude', used: 120000, window: 1000000, src: 'data' } }, jobs: [], brains: { claude: [''], codex: [''] }, memory: true, safeMode: true, fullModePinSet: true, media: { relay: false, ffmpeg: false, maxUpload: 1e6, maxFiles: 4, chunk: 1e5 }, uploads: [], sessions: list },
});
const target = (map) => ({ closest: (sel) => map[sel] || null, matches: () => false });
let n = 0;

async function boot(list) {
  const feed = sealFor(snap(list));
  const d = installDom({ feed, config: { source: 'local', path: 'data/live.enc.json', pollSec: 3600 } });
  await import(`../docs/app.js?mappage=${++n}`);
  await tick();
  d.els.get('password').value = 'test-pass';
  await d.els.get('login-form').fire('submit');
  for (let i = 0; i < 300 && d.els.get('unlock').textContent !== 'Unlock'; i++) await tick(50);
  await tick(100);
  const el = (id) => d.els.get(id);
  const openMap = () => el('sv-bar').fire('click', { target: target({ '[data-sv-map]': {} }) });
  return { d, el, openMap };
}

test('the page carries the map sheet elements and the Map chip', async () => {
  const html = fs.readFileSync(new URL('../docs/index.html', import.meta.url), 'utf8');
  for (const id of ['map-sheet', 'map-title', 'map-close', 'map-body']) assert.match(html, new RegExp(`id="${id}"`));
  const b = await boot(sessions);
  try { assert.match(b.el('sv-bar').innerHTML, /data-sv-map/); } finally { b.d.restore(); }
});

test('map sheet: title counts active, tree order, escaping, Recent collapsed, collapse state toggles', async () => {
  const b = await boot(sessions);
  try {
    await b.openMap();
    assert.equal(b.el('map-sheet').hidden, false);
    assert.equal(b.el('map-title').textContent, 'Chats map · 3 active');
    const html = b.el('map-body').innerHTML;
    assert.match(html, /data-mp-root/);
    assert.match(html, /ctx 12% · 120k \/ 1M/);                     // Ada's context chip
    assert.ok(html.indexOf('>proj<') < html.indexOf('>Other<'));
    assert.match(html, /data-mp-toggle="p:proj"/);
    assert.match(html, /data-mp-toggle="p:proj\/f:src\/f:components"|data-mp-toggle="p:proj\/f:src"/);
    assert.match(html, /data-sv-open="claude\|aaaaaaaa-/);
    assert.match(html, /data-s="blocked"/);
    assert.match(html, /Job<\/span>/); assert.match(html, /Terminal<\/span>/);
    assert.ok(!html.includes('<b>login</b>'), 'titles are escaped');
    assert.match(html, /data-mp-toggle="recent" aria-expanded="false"/);
    assert.ok(!html.includes('Finished earlier'), 'Recent is collapsed by default');
    await b.el('map-body').fire('click', { target: target({ '[data-mp-toggle]': { dataset: { mpToggle: 'recent' } } }) });
    assert.match(b.el('map-body').innerHTML, /Finished earlier/);
    await b.el('map-body').fire('click', { target: target({ '[data-mp-toggle]': { dataset: { mpToggle: 'p:proj' } } }) });
    assert.ok(!b.el('map-body').innerHTML.includes('Needs approval'), 'collapsing a project hides its leaves');
    assert.equal(JSON.parse(localStorage.getItem('ada-map-shut')).includes('p:proj'), true);
    await b.el('map-close').fire('click');
    assert.equal(b.el('map-sheet').hidden, true);
  } finally { b.d.restore(); }
});

test('tapping a leaf closes the map and opens that session; tapping Ada returns to the main chat', async () => {
  const b = await boot(sessions);
  try {
    await b.openMap();
    await b.el('map-body').fire('click', { target: target({ '[data-sv-open]': { dataset: { svOpen: `codex|${B}` } } }) });
    assert.equal(b.el('map-sheet').hidden, true);
    assert.equal(b.el('composer').hidden, true);                      // viewer open: composer swapped out
    assert.match(b.el('sv-banner').innerHTML, /Needs approval/);
    await b.openMap();
    await b.el('map-body').fire('click', { target: target({ '[data-mp-root]': {} }) });
    assert.equal(b.el('map-sheet').hidden, true);
    assert.equal(b.el('composer').hidden, false);
  } finally { b.d.restore(); }
});

test('empty snapshot: map opens with just Ada and "No active chats"', async () => {
  const b = await boot([]);
  try {
    await b.openMap();
    assert.equal(b.el('map-title').textContent, 'Chats map · 0 active');
    const html = b.el('map-body').innerHTML;
    assert.match(html, /data-mp-root/); assert.match(html, /No active chats/);
    assert.ok(!html.includes('data-sv-open'));
  } finally { b.d.restore(); }
});
