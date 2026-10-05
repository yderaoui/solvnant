// Data access. Uses Supabase when configured; otherwise "local mode": every viewer computes the
// same house-bot race from the slot number, so the site is always alive (and still in sync).
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Entry, InputLogEntry } from '../sim/race';
import { liveSimEntries, type LiveGridEntry } from '../game/liveEntries';
import { CAR_COLORS, HOUSE_BOTS, fallbackDriverCode } from '../sim/fallbackDriver';
import { raceStartAt } from '../sim/schedule';

export interface StoredResult {
  car: number;
  position: number;
  finished: boolean;
  finish_time: number | null;
  best_lap: number | null;
  crashed: boolean;
}

export interface EntryInfo extends Entry {
  createdAt?: string | null;
}

export interface RaceInfo {
  id: number | null;
  slot: number | null;
  seed: string;
  laps: number | null;
  startAt: number; // epoch ms
  simVersion: string | null;
  entries: EntryInfo[];
  results: StoredResult[] | null;
  local: boolean;
  /** Live (human) races: every input change, replayed by the simulation. */
  live?: { inputLog: InputLogEntry[]; maxTime: number };
}

export interface LeaderRow {
  model: string;
  races: number;
  wins: number;
  podiums: number;
  avg_position: number;
  crashes: number;
  best_lap: number | null;
}

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const key = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;
export const db: SupabaseClient | null = url && key ? createClient(url, key, { auth: { persistSession: false } }) : null;
export const isLocalMode = !db;

const RACE_SELECT =
  'id, slot, seed, laps, start_at, sim_version, race_entries(car, model, name, color, source, drivers(code, created_at), race_results(car, position, finished, finish_time, best_lap, crashed))';

// race_results hangs off race_entries (1:1), so PostgREST returns it as an object or a one-item array.
const resultOf = (e: any): StoredResult | null => (Array.isArray(e.race_results) ? e.race_results[0] : e.race_results) ?? null;

function toRaceInfo(row: any): RaceInfo {
  const entries: EntryInfo[] = (row.race_entries ?? [])
    .sort((a: any, b: any) => a.car - b.car)
    .map((e: any) => ({
      name: e.name,
      model: e.model,
      color: e.color,
      source: e.source,
      code: e.drivers?.code ?? '',
      createdAt: e.drivers?.created_at ?? null,
    }));
  const stored = (row.race_entries ?? []).map(resultOf).filter(Boolean) as StoredResult[];
  const results = stored.length ? stored : null;
  return {
    id: row.id,
    slot: row.slot,
    seed: row.seed,
    laps: row.laps,
    startAt: Date.parse(row.start_at),
    simVersion: row.sim_version,
    entries,
    results,
    local: false,
  };
}

export async function fetchRaceBySlot(slot: number): Promise<RaceInfo | null> {
  if (!db) return null;
  const { data, error } = await db.from('races').select(RACE_SELECT).eq('slot', slot).maybeSingle();
  if (error) console.warn('fetchRaceBySlot', error.message);
  return data ? toRaceInfo(data) : null;
}

export async function fetchRaceById(id: number): Promise<RaceInfo | null> {
  if (!db) return null;
  const { data, error } = await db.from('races').select(RACE_SELECT).eq('id', id).maybeSingle();
  if (error) console.warn('fetchRaceById', error.message);
  return data ? toRaceInfo(data) : null;
}

export async function fetchResults(raceId: number): Promise<StoredResult[] | null> {
  if (!db) return null;
  const { data } = await db.from('race_results').select('car, position, finished, finish_time, best_lap, crashed').eq('race_id', raceId);
  return data?.length ? (data as StoredResult[]) : null;
}

export async function fetchLeaderboard(): Promise<LeaderRow[]> {
  if (!db) return [];
  const { data, error } = await db.from('model_leaderboard').select('*').limit(100);
  if (error) throw new Error(error.message);
  return (data ?? []) as LeaderRow[];
}

export interface HistoryRow {
  id: number;
  seed: string;
  start_at: string;
  laps: number;
  winner: string | null;
}

export async function fetchHistory(): Promise<HistoryRow[]> {
  if (!db) return [];
  const { data, error } = await db
    .from('races')
    .select('id, seed, start_at, laps, race_entries(car, name, race_results(car, position))')
    .lte('ends_at', new Date().toISOString())
    .order('start_at', { ascending: false })
    .limit(40);
  if (error) throw new Error(error.message);
  return (data ?? []).map((r: any) => {
    const e = r.race_entries?.find((x: any) => resultOf(x)?.position === 1);
    return { id: r.id, seed: r.seed, start_at: r.start_at, laps: r.laps, winner: e?.name ?? null };
  });
}

export function houseEntries(count = HOUSE_BOTS.length): EntryInfo[] {
  return HOUSE_BOTS.slice(0, count).map((b, i) => ({
    name: b.name.replace('House Bot ', 'Bot '),
    model: b.name,
    color: CAR_COLORS[i],
    code: fallbackDriverCode(b.params),
    source: 'house' as const,
  }));
}

export function localRace(slot: number): RaceInfo {
  return {
    id: null,
    slot,
    seed: `local-${slot}`,
    laps: null,
    startAt: raceStartAt(slot),
    simVersion: null,
    entries: houseEntries(),
    results: null,
    local: true,
  };
}

// ---------------------------------------------------------------- live (human) races
export interface LiveHistoryRow {
  id: number;
  started_at: string;
  seed: string;
  entries: (LiveGridEntry & { car: number })[];
  results: StoredResult[];
}

export async function fetchLiveRace(id: number): Promise<RaceInfo | null> {
  if (!db) return null;
  const { data, error } = await db.from('live_races').select('*').eq('id', id).maybeSingle();
  if (error) console.warn('fetchLiveRace', error.message);
  if (!data) return null;
  const grid = (data.entries as (LiveGridEntry & { car: number })[]).sort((a, b) => a.car - b.car);
  return {
    id: data.id,
    slot: data.slot,
    seed: data.seed,
    laps: data.laps,
    startAt: Date.parse(data.started_at),
    simVersion: data.sim_version,
    entries: liveSimEntries(grid),
    results: data.results as StoredResult[],
    local: false,
    live: { inputLog: data.input_log as InputLogEntry[], maxTime: data.max_time },
  };
}

export async function fetchLiveHistory(): Promise<LiveHistoryRow[]> {
  if (!db) return [];
  const { data, error } = await db.from('live_races').select('id, started_at, seed, entries, results').order('started_at', { ascending: false }).limit(30);
  if (error) throw new Error(error.message);
  return (data ?? []) as LiveHistoryRow[];
}
