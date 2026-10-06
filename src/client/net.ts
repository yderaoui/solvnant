// WebSocket connection to the live game server, with clock sync and auto-reconnect.
import type { ClientMsg, ServerMsg } from '../game/protocol';

export const GAME_URL = (import.meta.env.VITE_GAME_URL as string | undefined) || 'ws://127.0.0.1:8787/ws';

/** Stable anonymous id for this browser (identifies a signed-out viewer across reconnects). */
export function clientId(): string {
  try {
    let id = localStorage.getItem('agp-id');
    if (!id) {
      id = 'p-' + crypto.getRandomValues(new Uint32Array(2)).join('');
      localStorage.setItem('agp-id', id);
    }
    return id;
  } catch {
    return 'p-' + Math.floor(Math.random() * 1e12);
  }
}

export class GameConnection {
  private ws: WebSocket | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private closedByUs = false;
  readonly id = clientId();
  /** Session token (signed in), sent with every hello. */
  token: string | null = null;
  rtt = 100; // ms, smoothed
  offset = 0; // serverEpoch ≈ Date.now() + offset
  connected = false;
  onMessage: (m: ServerMsg) => void = () => {};
  onStatus: (connected: boolean) => void = () => {};

  connect() {
    this.drop(); // never two sockets: a stale one would keep feeding us an old room
    this.closedByUs = false;
    const ws = new WebSocket(GAME_URL);
    this.ws = ws;
    ws.onopen = () => {
      this.connected = true;
      this.onStatus(true);
      this.hello();
      this.ping();
      this.pingTimer = setInterval(() => this.ping(), 2000);
    };
    ws.onmessage = (e) => {
      let m: ServerMsg;
      try {
        m = JSON.parse(e.data);
      } catch {
        return;
      }
      if (m.t === 'pong') {
        const now = Date.now();
        const rtt = now - m.ts;
        this.rtt = this.rtt * 0.7 + rtt * 0.3;
        this.offset = m.st + rtt / 2 - now;
      }
      this.onMessage(m);
    };
    ws.onclose = () => {
      if (this.ws !== ws) return; // an old socket finishing its close
      this.connected = false;
      this.onStatus(false);
      if (this.pingTimer) clearInterval(this.pingTimer);
      if (!this.closedByUs) setTimeout(() => this.connect(), 1500);
    };
  }

  /** (Re)introduce ourselves, e.g. after signing in or out. */
  hello() {
    this.send({ t: 'hello', id: this.id, token: this.token });
  }

  /** Leave for good (another page): cut the socket loose right away, don't wait for the close handshake. */
  close() {
    this.closedByUs = true;
    this.drop();
  }

  private drop() {
    const ws = this.ws;
    this.ws = null;
    this.connected = false;
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
    if (!ws) return;
    ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
    try {
      ws.close();
    } catch {
      /* already closed */
    }
  }

  send(m: ClientMsg) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(m));
  }

  serverNow(): number {
    return Date.now() + this.offset;
  }

  private ping() {
    this.send({ t: 'ping', ts: Date.now() });
  }
}
