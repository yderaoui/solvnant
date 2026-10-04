// Wire protocol between the game server (Cloudflare Durable Object) and browsers. JSON over WebSocket.
import type { CarResult, RaceEvent } from '../sim/race';

export const MAX_PLAYERS = 10;
export const MIN_GRID = 6; // empty slots are filled with bots up to this many cars
export const SNAP_HZ = 20;
export const CAR_SNAP_STRIDE = 9; // x, y, h, vx, vy, steer, slip, progress, flags

/** Neon car colours (TrackLab night theme). */
export const PLAYER_COLORS = ['#8cff2e', '#22d3ee', '#ff3dbb', '#ffd60a', '#ff8a1f', '#a259ff', '#ff3b3b', '#3b82ff', '#f1f5f9', '#ff7ab6'];

export type Phase = 'lobby' | 'race' | 'results';

export interface LobbyEntry {
  id: string; // player id, or "bot:<n>"
  name: string;
  color: string;
  kind: 'human' | 'bot';
  connected: boolean;
}

export interface RecentWinner {
  slot: number;
  name: string;
  color: string;
  kind: 'human' | 'bot';
  time: number | null; // race time of the winner, s
  field: number; // cars in that race
  humans: number; // people in that race
  at: number; // server epoch ms
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
  recent: RecentWinner[]; // last few live-race winners, newest first
}

export type ServerMsg =
  | { t: 'room'; room: RoomInfo; you: string; car: number | null }
  // catchup: sent once to someone joining mid-race (positions + trees already down, no effects)
  | { t: 'snap'; tick: number; rt: number; c: number[]; order: number[]; ev?: RaceEvent[]; catchup?: boolean }
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
