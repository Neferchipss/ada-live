// Minimal fake DOM so docs/app.js can run under Node. Elements come from the ids in docs/index.html:
// looking up an id that index.html doesn't have returns null (exactly what a browser does), so a
// missing element surfaces as the same TypeError the phone would hit. Other selectors are lenient.
import fs from 'node:fs';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { deriveKey, seal } from '../../collector/lib/crypto.mjs';

const DOCS = fileURLToPath(new URL('../../docs/', import.meta.url));
export const indexHtml = fs.readFileSync(DOCS + 'index.html', 'utf8');

class FakeElement {
  constructor(id = '', attrs = {}) {
    this.id = id;
    this.attrs = attrs;
    this.handlers = {};
    this.innerHTML = '';
    this.textContent = '';
    this.value = '';
    this.checked = false;
    this.hidden = 'hidden' in attrs;
    this.disabled = false;
    this.className = attrs.class || '';
    this.style = {};
    this.children = [];
    this.scrollHeight = 0; this.scrollTop = 0;
    this.dataset = Object.fromEntries(Object.entries(attrs).filter(([k]) => k.startsWith('data-')).map(([k, v]) => [k.slice(5).replace(/-(\w)/g, (_, c) => c.toUpperCase()), v]));
    const cls = new Set(this.className.split(/\s+/).filter(Boolean));
    this.classList = {
      add: (...c) => c.forEach((x) => cls.add(x)), remove: (...c) => c.forEach((x) => cls.delete(x)),
      toggle: (c, f) => { const on = f ?? !cls.has(c); on ? cls.add(c) : cls.delete(c); return on; },
      contains: (c) => cls.has(c),
    };
  }
  addEventListener(t, fn) { (this.handlers[t] ||= []).push(fn); }
  removeEventListener() {}
  async fire(t, ev = {}) { for (const fn of this.handlers[t] || []) await fn({ preventDefault() {}, stopPropagation() {}, target: this, ...ev }); }
  querySelector() { return new FakeElement(); }
  querySelectorAll() { return []; }
  closest() { return null; }
  setAttribute(k, v) { this.attrs[k] = v; }
  getAttribute(k) { return this.attrs[k] ?? null; }
  removeAttribute(k) { delete this.attrs[k]; }
  appendChild(c) { this.children.push(c); return c; }
  append(...c) { this.children.push(...c); }
  prepend(...c) { this.children.unshift(...c); }
  insertAdjacentHTML(_, h) { this.innerHTML += h; }
  remove() {}
  focus() {} blur() {} click() {} scrollIntoView() {} scrollTo() {} select() {}
}

// Parse every tag with an id out of index.html (attributes included).
function registry() {
  const els = new Map();
  for (const m of indexHtml.matchAll(/<([a-z0-9]+)\b([^>]*\bid="([^"]+)"[^>]*)>/gi)) {
    const attrs = {};
    for (const a of m[2].matchAll(/([\w:-]+)(?:="([^"]*)")?/g)) attrs[a[1]] = a[2] ?? '';
    els.set(m[3], new FakeElement(m[3], attrs));
  }
  return els;
}

export function installDom({ feed, config = { source: 'local', path: 'data/live.enc.json', pollSec: 3600 } }) {
  const els = registry();
  const errors = [];
  const logged = [];
  const doc = {
    title: '', hidden: false, activeElement: null,
    body: new FakeElement('body'),
    querySelector(sel) {
      if (sel.startsWith('#')) return els.get(sel.slice(1)) || null;
      return new FakeElement();
    },
    querySelectorAll: () => [],
    getElementById: (id) => els.get(id) || null,
    createElement: () => new FakeElement(),
    addEventListener() {},
  };
  const store = new Map();
  Object.assign(globalThis, {
    document: doc,
    window: { scrollTo() {}, scrollY: 0, innerHeight: 800, addEventListener() {}, matchMedia: () => ({ matches: false, addEventListener() {} }) },
    matchMedia: () => ({ matches: false, addEventListener() {} }),
    requestAnimationFrame: (f) => setTimeout(f, 0),
    localStorage: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) },
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    WebSocket: class { constructor() { throw new Error('no sockets in tests'); } },
    fetch: async (url) => {
      const u = String(url);
      if (u.startsWith('config.json')) return { ok: true, json: async () => config };
      if (u.startsWith(config.path || 'data/')) return { ok: true, status: 200, json: async () => feed };
      return { ok: false, status: 404, json: async () => ({}) };
    },
  });
  Object.defineProperty(globalThis, 'location', { value: { hostname: 'example.test', search: '', hash: '' }, configurable: true, writable: true });
  try { Object.defineProperty(globalThis, 'navigator', { value: { vibrate() {} }, configurable: true, writable: true }); } catch {}
  // Timers must not keep the test process alive.
  for (const n of ['setTimeout', 'setInterval']) { const f = globalThis[n]; globalThis[n] = (...a) => { const t = f(...a); t?.unref?.(); return t; }; }
  const origErr = console.error;
  console.error = (...a) => { logged.push(a.map(String).join(' ')); };
  return { els, doc, logged, errors, restore() { console.error = origErr; } };
}

// Seals a snapshot like the collector does, so the page decrypts it with the real WebCrypto path.
export function sealFor(snap, password = 'test-pass') {
  const salt = crypto.randomBytes(16).toString('base64');
  return seal(snap, deriveKey(password, salt), salt);
}
