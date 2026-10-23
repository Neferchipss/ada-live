// Ada Live relay. Passes the laptop's encrypted snapshots to open viewers in real time.
// It only ever handles ciphertext: the password never leaves Nefer's devices.
//
//   wss://<worker>/ws?role=viewer              phone/browser: receives snapshots; may send encrypted chat
//                                              commands, passed to the laptop unread (it checks them)
//   wss://<worker>/ws?role=pub&key=<PUB_KEY>   the laptop collector: sends snapshots, hears viewer count
import { DurableObject } from 'cloudflare:workers';

const PERSIST_EVERY_MS = 20_000;
const MAX_MESSAGE = 512 * 1024;
const MAX_COMMAND = 32 * 1024;
const COMMANDS_PER_MIN = 30;

export class Relay extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.last = null;        // newest envelope (string); lost on hibernation, reloaded from storage
    this.lastPersist = 0;
  }

  async fetch(request) {
    const url = new URL(request.url);
    const role = url.searchParams.get('role');
    if (role === 'pub' && url.searchParams.get('key') !== this.env.PUB_KEY) {
      return new Response('forbidden', { status: 403 });
    }
    if (role !== 'pub' && role !== 'viewer') return new Response('bad role', { status: 400 });

    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server, [role]);

    if (role === 'viewer') {
      const last = this.last ?? (await this.ctx.storage.get('last'));
      if (last) server.send(last);
      this.#announce();
    } else {
      server.send(JSON.stringify({ type: 'viewers', n: this.#viewers() }));
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, message) {
    const [role] = this.ctx.getTags(ws);
    if (role === 'viewer') return this.#forward(ws, message);
    if (typeof message !== 'string' || message.length > MAX_MESSAGE) return;
    this.last = message;
    for (const v of this.ctx.getWebSockets('viewer')) {
      try { v.send(message); } catch { /* closing */ }
    }
    if (Date.now() - this.lastPersist > PERSIST_EVERY_MS) {
      this.lastPersist = Date.now();
      await this.ctx.storage.put('last', message);
    }
  }

  async webSocketClose(ws, code, reason) {
    const [role] = this.ctx.getTags(ws);
    try { ws.close(code, reason); } catch {}
    if (role === 'viewer') this.#announce(ws);
  }

  async webSocketError(ws) {
    const [role] = this.ctx.getTags(ws);
    if (role === 'viewer') this.#announce(ws);
  }

  // Viewer -> laptop. The relay can't read these; the laptop drops anything not sealed with the password.
  #forward(ws, message) {
    if (typeof message !== 'string' || message.length > MAX_COMMAND) return;
    const now = Date.now();
    const a = ws.deserializeAttachment() || { start: now, n: 0 };
    if (now - a.start > 60_000) { a.start = now; a.n = 0; }
    if (++a.n > COMMANDS_PER_MIN) return;
    ws.serializeAttachment(a);
    for (const p of this.ctx.getWebSockets('pub')) {
      try { p.send(message); } catch {}
    }
  }

  #viewers(except) {
    return this.ctx.getWebSockets('viewer').filter((w) => w !== except && w.readyState === 1).length;
  }

  // Tell the laptop how many viewers are watching, so it only streams when someone is.
  #announce(except) {
    const msg = JSON.stringify({ type: 'viewers', n: this.#viewers(except) });
    for (const p of this.ctx.getWebSockets('pub')) {
      try { p.send(msg); } catch {}
    }
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/') return new Response('ada-live relay', { headers: { 'content-type': 'text/plain' } });
    if (url.pathname !== '/ws') return new Response('not found', { status: 404 });
    // Reject non-upgrade requests before they reach (and bill) the Durable Object.
    if (request.headers.get('Upgrade') !== 'websocket') return new Response('expected websocket', { status: 426 });
    return env.RELAY.getByName('main').fetch(request);
  },
};
