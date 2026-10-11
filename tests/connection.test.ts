import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { GameConnection } from '../src/client/net';

class Socket {
  static OPEN = 1;
  static all: Socket[] = [];
  readyState = 1;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  send = vi.fn();
  close = vi.fn();
  constructor(_url: string) { Socket.all.push(this); }
}

beforeEach(() => {
  vi.useFakeTimers();
  Socket.all = [];
  vi.stubGlobal('WebSocket', Socket);
  vi.stubGlobal('localStorage', { getItem: () => 'connection-test', setItem: vi.fn() });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

it('does not reconnect after leaving while a retry is scheduled', () => {
  const conn = new GameConnection(); conn.connect();
  Socket.all[0].onclose!(); conn.close();
  vi.advanceTimersByTime(10_000);
  expect(Socket.all).toHaveLength(1);
  expect(conn.connected).toBe(false);
});

it('does not let an old retry replace a newly opened socket', () => {
  const conn = new GameConnection(); conn.connect(); Socket.all[0].onclose!();
  conn.connect(); Socket.all[1].onopen!();
  vi.advanceTimersByTime(1600);
  expect(Socket.all).toHaveLength(2);
  expect(Socket.all[1].close).not.toHaveBeenCalled();
  expect(conn.connected).toBe(true);
  conn.close();
});

it('reconnects after a genuine disconnect and cancels heartbeat on exit', () => {
  const conn = new GameConnection(); conn.connect(); Socket.all[0].onopen!();
  Socket.all[0].onclose!(); vi.advanceTimersByTime(1600);
  expect(Socket.all).toHaveLength(2);
  Socket.all[1].onopen!(); expect(conn.connected).toBe(true);
  conn.close(); vi.advanceTimersByTime(10_000);
  expect(Socket.all).toHaveLength(2);
  expect(vi.getTimerCount()).toBe(0);
});
