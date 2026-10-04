// The race scheduler. Runs on a cron (GitHub Actions) or by hand: `npm run schedule`.
//  1. Works out which 5-minute slots in the next ~75 minutes don't have a race yet.
//  2. Refreshes a few models' driver code via OpenRouter (cached ~24 h to stay inside free limits).
//  3. Simulates each race (same deterministic engine the browser uses) and stores
//     seed + driver code + results in Supabase. Browsers re-simulate and verify.
// Flags: --dry  (no database writes; just print what would happen)
import 'dotenv/config';
import { createHash, randomBytes } from 'node:crypto';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { loadQuickJS } from '../sim/quickjs';
import { runRace, SIM_VERSION, type Entry } from '../sim/race';
import { generateTrack, lapsFor } from '../sim/track';
import { CAR_COLORS, HOUSE_BOTS, fallbackDriverCode } from '../sim/fallbackDriver';
import { MAX_RACE_SECONDS, raceStartAt, slotAt } from '../sim/schedule';
import { generateDriverCode, listFreeModels, pickModels, RateLimitError, type ModelInfo } from './openrouter';
import { validateDriver } from './validate';

const env = (k: string, d = '') => process.env[k]?.trim() || d;
const DRY = process.argv.includes('--dry');
const CFG = {
  maxCars: Math.min(10, Number(env('MAX_CARS', '10'))),
  minCars: Number(env('MIN_CARS', '2')),
  racesAheadMinutes: Number(env('RACES_AHEAD_MINUTES', '75')),
  driverTtlHours: Number(env('DRIVER_TTL_HOURS', '24')),
  retryFailedHours: Number(env('RETRY_FAILED_HOURS', '6')),
  refreshPerRun: Number(env('DRIVER_REFRESH_PER_RUN', '2')),
  preferredModels: env('OPENROUTER_MODELS')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
};

interface DriverRow {
  id: string;
  model: string;
  code: string;
  source: string;
  valid: boolean;
  error: string | null;
  created_at: string;
}

const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

async function main() {
  const url = env('SUPABASE_URL', env('VITE_SUPABASE_URL'));
  const key = env('SUPABASE_SERVICE_ROLE_KEY');
  const orKey = env('OPENROUTER_API_KEY');
  if (!DRY && (!url || !key)) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required (or use --dry)');
  const db = url && key ? createClient(url, key, { auth: { persistSession: false } }) : null;
  const qjs = await loadQuickJS();

  // 1. Which slots need a race?
  const now = Date.now();
  const first = slotAt(now);
  const last = slotAt(now + CFG.racesAheadMinutes * 60_000);
  let slots: number[] = [];
  for (let s = first; s <= last; s++) if (raceStartAt(s) > now + 20_000) slots.push(s);
  if (db) {
    const { data, error } = await db.from('races').select('slot').in('slot', slots);
    if (error) throw new Error('reading races: ' + error.message);
    const have = new Set((data ?? []).map((r) => Number(r.slot)));
    slots = slots.filter((s) => !have.has(s));
  }
  log(`${slots.length} slot(s) to schedule`);
  if (!slots.length) return;
  const seeds = slots.map((s) => `gp${s}-${randomBytes(3).toString('hex')}`);

  // 2. Roster of models + their cached driver code
  let roster: ModelInfo[] = [];
  if (orKey) {
    try {
      roster = pickModels(await listFreeModels(), CFG.preferredModels, CFG.maxCars, db ? await restrictedModels(db) : new Set());
      log(`roster: ${roster.map((m) => m.id).join(', ')}`);
    } catch (e) {
      log('could not list OpenRouter models, house bots only:', (e as Error).message);
    }
  } else log('OPENROUTER_API_KEY not set: house bots only');

  const drivers = db ? await loadDrivers(db, roster.map((m) => m.id)) : new Map<string, DriverRow[]>();

  // Refresh stale drivers (missing first, then oldest), a few per run.
  if (orKey && roster.length) {
    const firstTrack = generateTrack(seeds[0]);
    const firstLaps = lapsFor(firstTrack);
    const stale = roster
      .map((m) => {
        const rows = drivers.get(m.id) ?? [];
        const valid = rows.find((r) => r.valid);
        const lastAttempt = rows[0];
        const age = valid ? (now - Date.parse(valid.created_at)) / 3.6e6 : Infinity;
        const sinceAttempt = lastAttempt ? (now - Date.parse(lastAttempt.created_at)) / 3.6e6 : Infinity;
        return { m, age, sinceAttempt };
      })
      .filter((x) => x.age > CFG.driverTtlHours && x.sinceAttempt > Math.min(CFG.retryFailedHours, CFG.driverTtlHours))
      .sort((a, b) => b.age - a.age)
      .slice(0, CFG.refreshPerRun);

    for (const { m } of stale) {
      log(`asking ${m.id} to write a driver…`);
      let row: Omit<DriverRow, 'id' | 'created_at'>;
      try {
        const { code, raw, finishReason } = await generateDriverCode(orKey, m.id, firstTrack, firstLaps);
        if (!code) {
          const why = finishReason === 'length' ? ' (ran out of tokens)' : finishReason ? ` (finish: ${finishReason})` : '';
          row = { model: m.id, code: raw.slice(0, 20000), source: 'llm', valid: false, error: `no drive() code block in reply${why}` };
        } else {
          const v = validateDriver(qjs, code);
          row = { model: m.id, code, source: 'llm', valid: v.ok, error: v.ok ? null : v.error };
        }
      } catch (e) {
        if (e instanceof RateLimitError) {
          log(`  ${(e as Error).message}, stopping refresh for this run`);
          break;
        }
        row = { model: m.id, code: '', source: 'llm', valid: false, error: String((e as Error).message).slice(0, 300) };
      }
      log(`  ${m.id}: ${row.valid ? 'OK ✓' : 'rejected: ' + row.error}`);
      const saved = await saveDriver(db, row);
      drivers.set(m.id, [saved, ...(drivers.get(m.id) ?? [])]);
      await sleep(3500); // free tier: ~20 requests/minute
    }
  }

  // 3. Build the grid, simulate and store each race.
  const houseIds = new Map<string, string>();
  for (const b of HOUSE_BOTS) {
    const code = fallbackDriverCode(b.params);
    houseIds.set(b.name, (await saveDriver(db, { model: b.name, code, source: 'house', valid: true, error: null })).id);
  }

  for (let k = 0; k < slots.length; k++) {
    const slot = slots[k];
    const seed = seeds[k];
    // Only models whose own code passed validation get a car. A model never races under
    // someone else's code, so a win on the board is always the model's own work.
    const entries: Entry[] = [];
    for (const m of roster) {
      const valid = drivers.get(m.id)?.find((r) => r.valid);
      if (valid) entries.push({ name: m.name, model: m.id, color: CAR_COLORS[entries.length], code: valid.code, source: 'llm', driverId: valid.id });
    }
    // Top up with (clearly labelled) house bots so a race always has cars.
    for (let h = 0; entries.length < CFG.minCars && h < HOUSE_BOTS.length; h++) {
      const b = HOUSE_BOTS[h];
      entries.push({
        name: b.name.replace('House Bot ', 'Bot '),
        model: b.name,
        color: CAR_COLORS[entries.length],
        code: fallbackDriverCode(b.params),
        source: 'house',
        driverId: houseIds.get(b.name),
      });
    }

    const track = generateTrack(seed);
    const laps = lapsFor(track);
    const t0 = performance.now();
    const rec = runRace(qjs, { seed, entries, laps, maxTime: MAX_RACE_SECONDS, obstacles: true });
    const startAt = raceStartAt(slot);
    const winner = entries[rec.results[0].car];
    log(
      `slot ${slot} ${new Date(startAt).toISOString().slice(11, 16)} seed=${seed} ${entries.length} cars, ${laps} laps → ` +
        `${winner.name} wins (${rec.duration.toFixed(0)}s race, simulated in ${(performance.now() - t0).toFixed(0)} ms)`,
    );
    if (!db) continue;

    const { data: race, error } = await db
      .from('races')
      .insert({
        slot,
        seed,
        laps,
        start_at: new Date(startAt).toISOString(),
        ends_at: new Date(startAt + rec.duration * 1000).toISOString(),
        sim_version: SIM_VERSION,
      })
      .select('id')
      .single();
    if (error) {
      if (error.code === '23505') continue; // another run already scheduled this slot
      throw new Error('insert race: ' + error.message);
    }
    const e1 = await db.from('race_entries').insert(
      entries.map((e, car) => ({ race_id: race.id, car, model: e.model, name: e.name, color: e.color, source: e.source, driver_id: e.driverId })),
    );
    if (e1.error) throw new Error('insert entries: ' + e1.error.message);
    const e2 = await db.from('race_results').insert(
      rec.results.map((r) => ({
        race_id: race.id,
        car: r.car,
        position: r.position,
        finished: r.finished,
        finish_time: r.finishTime,
        best_lap: r.bestLap,
        laps_done: r.lapsDone,
        crashed: r.crashed,
        crash_reason: r.crashReason,
        contacts: r.contacts,
      })),
    );
    if (e2.error) throw new Error('insert results: ' + e2.error.message);
  }
}

/** Models that OpenRouter won't serve to plain API calls (e.g. "only available on agentic harnesses"). */
async function restrictedModels(db: SupabaseClient): Promise<Set<string>> {
  const { data } = await db.from('drivers').select('model').eq('source', 'llm').ilike('error', '%only available on%');
  return new Set((data ?? []).map((r) => r.model as string));
}

async function loadDrivers(db: SupabaseClient, models: string[]): Promise<Map<string, DriverRow[]>> {
  const map = new Map<string, DriverRow[]>();
  if (!models.length) return map;
  const { data, error } = await db
    .from('drivers')
    .select('id, model, code, source, valid, error, created_at')
    .in('model', models)
    .order('created_at', { ascending: false })
    .limit(500);
  if (error) throw new Error('reading drivers: ' + error.message);
  for (const r of data as DriverRow[]) map.set(r.model, [...(map.get(r.model) ?? []), r]);
  return map;
}

/** Insert a driver (deduplicated by model + code). */
async function saveDriver(db: SupabaseClient | null, d: Omit<DriverRow, 'id' | 'created_at'>): Promise<DriverRow> {
  const created_at = new Date().toISOString();
  const code_hash = sha(`${d.model}\n${d.code}\n${d.valid ? '' : created_at}`);
  if (!db) return { ...d, id: code_hash.slice(0, 12), created_at };
  const found = await db.from('drivers').select('id, model, code, source, valid, error, created_at').eq('code_hash', code_hash).maybeSingle();
  if (found.data) return found.data as DriverRow;
  const { data, error } = await db
    .from('drivers')
    .insert({ ...d, code_hash })
    .select('id, model, code, source, valid, error, created_at')
    .single();
  if (error) throw new Error('insert driver: ' + error.message);
  return data as DriverRow;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
