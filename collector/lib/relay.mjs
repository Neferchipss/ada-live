// Laptop side of the realtime relay. Holds one WebSocket to the Cloudflare relay,
// learns how many viewers are watching, and streams snapshots only while someone is.
export class RelayClient {
  constructor(url, key, onViewers = () => {}) {
    this.url = `${url.replace(/\/$/, '')}/ws?role=pub&key=${encodeURIComponent(key)}`;
    this.onViewers = onViewers;
    this.viewers = 0;
    this.ws = null;
    this.backoff = 2000;
    this.#connect();
  }

  #connect() {
    let ws;
    try { ws = new WebSocket(this.url); } catch (e) { return this.#retry(e); }
    this.ws = ws;
    ws.addEventListener('open', () => { this.backoff = 2000; console.log('[relay] connected'); });
    ws.addEventListener('message', (ev) => {
      try {
        const m = JSON.parse(ev.data);
        if (m.type === 'viewers') {
          const was = this.viewers;
          this.viewers = m.n;
          if (m.n !== was) console.log(`[relay] viewers: ${m.n}`);
          this.onViewers(m.n, was);
        }
      } catch {}
    });
    ws.addEventListener('close', () => { this.viewers = 0; this.#retry(); });
    ws.addEventListener('error', () => {}); // close follows
  }

  #retry(err) {
    if (err) console.error('[relay]', err.message);
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.#connect(), this.backoff);
    this.backoff = Math.min(this.backoff * 2, 60000);
  }

  get watching() { return this.viewers > 0 && this.ws?.readyState === 1; }

  send(body) {
    if (this.ws?.readyState === 1) this.ws.send(body);
  }
}
