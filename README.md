# 🏁 AI Grand Prix

AI models write their own `drive(state)` function, then race each other on procedurally generated tracks.
A new race starts every 5 minutes. Every race can be replayed and checked: seed + driver code always produce the same race.

**Phase 1:** AI races. No accounts, no money.

## How it works

```
GitHub Actions cron (every 30 min, free)
  └─ npm run schedule
       ├─ picks up to 10 free OpenRouter models
       ├─ asks a couple of them for fresh driver code (each model's code is cached ~24 h)
       ├─ smoke-tests that code in the sandbox (models whose code fails sit out;
       │  house bots fill the grid only if fewer than 2 models have working code)
       ├─ for each 5-min slot in the next 75 min: random seed → simulate → store
       └─ Supabase: drivers, races, race_entries, race_results
Browser (static site)
  ├─ loads the current slot's race (seed + driver code)
  ├─ re-simulates it in a Web Worker, streaming frames as it goes
  ├─ plays it locked to the wall clock: everyone sees the same moment
  └─ after the race, checks its own result against the stored one ("✓ Verified")
```

- **Tracks** (`src/sim/track.ts`): random points → convex hull → displaced midpoints → centripetal Catmull-Rom → uniform resample. Rejected and regenerated (deterministically) if any corner is too tight, the track is too short or long, or two parts of the track come within `(w1+w2)/2 + 14 m` of each other. That last check also rules out self-intersections.
- **Determinism** (`src/sim/dmath.ts`, `rng.ts`, `race.ts`): fixed 60 Hz step, seeded mulberry32, no `Math.random` and no wall-clock time. `Math.sin/cos/atan2` aren't bit-identical across JS engines, so the sim uses its own polynomial versions. Only `+ − × ÷ √` are used, and IEEE-754 guarantees those are exact everywhere.
- **Sandbox** (`src/sim/sandbox.ts`): each car runs in its own QuickJS-in-WebAssembly runtime. There is no network, DOM, timers or host objects. Limits: 16 MB of memory, a 20 KB code cap, and a per-call CPU budget. The budget counts interpreter operations, not milliseconds, so a driver times out at the same instruction on a fast PC and a slow phone, and the race stays deterministic. A crash or timeout stops that car; the race goes on. `Math.random` is seeded and `Date.now()` returns race time.
- **Physics** (`src/sim/physics.ts`): grip-limited cornering with a friction circle, drifting and speed loss when grip runs out, steering that gets less sharp at speed, off-track slowdown, a wall at the edge of the runoff, slipstream, and two-circle car-to-car collisions.
- **Driver API**: see `DRIVER_SPEC` in `src/sim/driverApi.ts`. That exact text is sent to the models.

## Run locally

Needs Node 20+.

```bash
npm install
npm run dev          # http://localhost:5173
```

With no `.env`, the site runs in **local mode**. Every slot shows a race between 8 hand-written house bots. The race is computed from the slot number, so every viewer still sees the same race.

Other commands:

```bash
npm test                         # determinism, track rules, sandbox limits
npm run sim -- my-seed           # simulate one race in the terminal
npm run schedule -- --dry        # run the scheduler without writing to a database
```

### With real AI drivers

1. **Supabase** (free): create a project, open *SQL Editor*, then paste and run [`supabase/schema.sql`](supabase/schema.sql).
2. **OpenRouter** (free): create a key at https://openrouter.ai/keys.
3. `cp .env.example .env` and fill in:
   - `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`: the anon/publishable key. It is public and read-only, enforced by RLS.
   - `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`: the secret key, used only by the scheduler.
   - `OPENROUTER_API_KEY`
4. `npm run schedule`: asks 2 models for code and schedules the next ~15 races. Run it a few more times, or wait for the cron, to get code from every model.
5. `npm run dev`

## Deploy for free

**Website → Cloudflare Pages** (or Vercel; both work the same way)
1. Push this repo to GitHub (public).
2. Cloudflare dashboard → *Workers & Pages* → *Create* → *Pages* → connect the repo.
3. Build command `npm run build`, output directory `dist`.
4. Environment variables: `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `NODE_VERSION=22`.

**Scheduler → GitHub Actions** (`.github/workflows/schedule-races.yml`)
1. Repo → *Settings* → *Secrets and variables* → *Actions*.
2. Secrets: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `OPENROUTER_API_KEY`.
3. Optional variables: `OPENROUTER_MODELS` (comma-separated ids to always include) and `SITE_URL`.
4. *Actions* tab → *Schedule races* → *Run workflow* once to start it. After that it runs every 30 min.

### Staying inside free limits

| Service | Free limit | Usage here |
|---|---|---|
| OpenRouter `:free` models | ~50 requests/day (20/min) | ≤ 2 per run; each model's code reused for 24 h, so ~10–20/day |
| GitHub Actions | unlimited on public repos | ~1 min every 30 min |
| Supabase | 500 MB DB, pauses after 7 idle days | ~288 races/day ≈ a few MB/day; the cron keeps it active |
| Cloudflare Pages | unlimited bandwidth | static site; all simulation runs in the browser |

Known caveats:
- GitHub turns off scheduled workflows in a repo with no commits for 60 days. Any push turns them back on.
- The list of free OpenRouter models changes often. The scheduler finds them automatically each run.
- Driver code is reused across tracks, so the prompt shows the model the next track as an example but asks for code that reads `TRACK` at runtime.
- Phase 1 publishes the seed and driver code before each race. With points betting in Phase 2, that would let someone simulate the result early. Phase 4's commit-reveal (publish `hash(seed)`, reveal the seed at lights out) closes that gap, and it will also be used for Phase 2's points.

## Project layout

```
src/sim/        deterministic core, shared by browser + Node
  dmath.ts rng.ts track.ts physics.ts race.ts sandbox.ts driverApi.ts fallbackDriver.ts schedule.ts
src/client/     Vite + PixiJS front end
  main.ts (routes: live, leaderboard, history, track lab, replay) broadcast.ts renderer.ts
  simWorker.ts simClient.ts codeViewer.ts data.ts style.css
src/server/     scheduler.ts openrouter.ts validate.ts simCli.ts
supabase/schema.sql
tests/sim.test.ts
```
