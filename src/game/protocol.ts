// Wire protocol between the game server (Cloudflare Durable Object) and browsers. JSON over WebSocket.
import type { CarResult, RaceEvent } from '../sim/race';

export const MAX_PLAYERS = 10;
export const MIN_GRID = 6; // empty slots are filled with bots up to this many cars
export const SNAP_HZ = 20;
export const CAR_SNAP_STRIDE = 9; // x, y, h, vx, vy, steer, slip, progress, flags

/** Pixel-palette car colours (PICO-8 inspired). */
export const PLAYER_COLORS = ['#ff004d', '#29adff', '#ffec27', '#00e436', '#ff77a8', '#ffa300', '#83769c', '#fff1e8', '#ab5236', '#7e2553'];

export type Phase = 'lobby' | 'race' | 'results';

export interface LobbyEntry {
  id: string; // player id, or "bot:<n>"
  name: string;
  color: string;
  kind: 'human' | 'bot';
  connected: boolean;
}

export interface RoomInfo {
  slot: number;
  phase: Phase;
  seed: string;
  laps: number;
  startAt: number; // server epoch ms of lights out
  slotEnd: number; // server epoch ms when the next lobby opens
  entries: LobbyEntry[]; // in the race phase, index = car index
  maxPlayers: number;
  viewers: number;
}

export type ServerMsg =
  | { t: 'room'; room: RoomInfo; you: string; car: number | null }
  | { t: 'snap'; tick: number; rt: number; c: number[]; order: number[]; ev?: RaceEvent[] }
  | { t: 'results'; results: CarResult[]; duration: number }
  | { t: 'pong'; ts: number; st: number }
  | { t: 'error'; msg: string };

export type ClientMsg =
  | { t: 'hello'; id: string }
  | { t: 'join'; name: string; color: string }
  | { t: 'leave' }
  | { t: 'in'; th: number; st: number; br: number }
  | { t: 'ping'; ts: number };

export function cleanName(raw: unknown): string {
  return String(raw ?? '')
    .replace(/[^\p{L}\p{N} _.\-]/gu, '')
    .trim()
    .slice(0, 16);
}
