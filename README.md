# TrackLab 3D

**Race · Bet · Earn.** 3D night-circuit racing on procedurally generated tracks. Two ways to race:

- **Race** (`#/live`): join the lobby with a nickname, pick a colour and drive live with the keyboard (or touch buttons) against up to 9 other people, from a 3D chase camera (or the top-down map if you prefer). Empty seats are filled with bots. A new round every 5 minutes. Not driving? You're a spectator: leaderboard, live win-probability estimate, pick any driver and ride along in 3D.
- **AI League** (`#/league`): AI models write their own `drive(state)` function, then race each other. Every race can be replayed and checked: seed + driver code always produce the same race.

- **Your Agent** (`#/agent`): write your own `drive(state)` agent, check it and practise against the house bots in your browser, then submit it. Valid agents take turns in a few seats of every AI League race and show up on the leaderboard as `agent:@you/name`.

**Accounts and points.** Sign in with X (or as a guest while X isn't set up) and get 1,000 points. Points are **play money**: no cash value, nothing to buy or withdraw.
- Live races cost an entry fee (50 pts) that goes into the race's prize pot, paid 60/30/10 to the top three human drivers. Leave before lights out and you get it back.
- A **priority pass** (+200 pts, 3 per race) gives a seat that can't be bumped. When the grid is full, people who raced last round give up their seat, and everyone else goes on a waitlist.
- Spectators **bet points** on the winner of any live race with a person in it (bets close at 40% distance), and on the next AI League race. It's pool betting: winners split the pool, minus a 5% rake.
- Daily bonus +100. Optional **token gate**: link a Solana wallet holding $20+ of the game's token to race without X.
- On-chain prize pots with real SOL exist on branch `phase4-anchor-pots`, **devnet only and unaudited** (see `onchain/README.md` there).

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

### Accounts, points and betting (game server)

```
Browser ──/api/*──► Cloudflare Worker ──► Durable Object "Hub" (SQLite): users, points ledger,
        ──/auth/x/*─┘ (X OAuth 2.0 + PKCE)     betting markets + pools, live prize pots, wallet links
GameRoom ──/internal/*──► Hub                  entry fees, refunds, payouts, opening/settling markets
Hub ──(service key)──► Supabase               AI League markets, agent submissions; GameRoom saves live races
```

- Sessions are HMAC-signed tokens (`src/game/auth.ts`). X logins must meet a minimum account age and follower count (`X_MIN_ACCOUNT_DAYS`, `X_MIN_FOLLOWERS`) to keep bots out.
- Every points change goes through the ledger in one SQLite transaction. Pots and markets whose race never finished are refunded automatically.
- **No spoilers, no sure bets:** AI League races are simulated in advance and are deterministic, so the database hides a race's seed and grid until its slot opens (RLS in `supabase/schema.sql`). Bets on that race close at the same moment.
- Settings live in `wrangler.toml` `[vars]` (fees, bonuses, limits). Secrets go in `.dev.vars` locally (see `.dev.vars.example`) or `wrangler secret put` in production.

### Live multiplayer

```
Browser ──WebSocket──► Cloudflare Worker ──► Durable Object "GameRoom" (one room, free plan)
  sends key changes        (src/game/worker.ts)   ├─ lobby (nickname + colour, max 10, bots fill to 6)
  predicts own car                                ├─ authoritative 60 Hz sim (same physics as the league)
  interpolates others                             ├─ 20 Hz snapshots to players and viewers
                                                  └─ logs every input change → the race can be replayed exactly
```

- The server is the referee: your browser only sends throttle/steer/brake. Your own car is predicted locally so it reacts instantly, then nudged toward the server's position; other cars are drawn ~100 ms in the past so they move smoothly.
- Rotation is fair: if a round is full, people who raced last round give their seat to people who didn't.
- Cameras: **3D** (chase cam, the default everywhere; in the lobby and Track Lab it flies a drone over the empty circuit), **Fan view** (first person from the crowd: a grandstand seat or a raised fan platform behind the fence, head turning to follow the car; `V` or clicking it again picks another stand), **Follow** and **Map** (2D). `C` cycles them; spectators pick a car in the driver list or on the map, and `[` `]` switch car. The AI League has the same 3D and fan cameras.
- AI League races from sim version 3 on also have the trees and crowd fences (scheduler + browser replay agree); older stored races replay without them so they still verify.
- Every race with a person in it is saved to Supabase (`live_races`: seed, grid and every input change). History lists them, and anyone can replay one and check the result.
- **You can crash into things.** Live tracks get trees in the run-off and catch fences in front of standing crowds (`src/sim/obstacles.ts`), generated from the seed and resolved inside the deterministic sim, so a crash is identical on the server, in replays and for every viewer. Hit a tree faster than ~58 km/h and it snaps and falls; slower and you bounce off. Hit the crowd fence and the fans right there jump back and cheer (nobody gets hurt).
- **3D view** (`src/client/chase3d.ts`): Ferrari 458 model painted per player, real asphalt/grass/bark textures, night-sky lighting, floodlights, armco and tyre walls, grandstands and terraces full of animated fans, tyre smoke, skid marks, sparks, flying leaves, camera shake. Sound is synthesized (`src/client/audio.ts`): engine, tyre squeal, crashes, crowd. Quality steps down automatically on slower machines. Assets (~11 MB) load only when the 3D view is used.

## Run locally

Needs Node 20+.

```bash
npm install
npm run dev          # http://localhost:5173
```

With no `.env`, the site runs in **local mode**. Every slot shows a race between 8 hand-written house bots. The race is computed from the slot number, so every viewer still sees the same race.

**Live multiplayer locally** (second terminal):

```bash
npm run game         # game server on ws://127.0.0.1:8787/ws  (Cloudflare's local runtime)
```

Then open http://localhost:5173/#/live. Open a second browser window to race yourself or watch as a viewer. For quicker test rounds: `npx wrangler dev --port 8787 --ip 127.0.0.1 --var SLOT_SECONDS:120 --var LOBBY_SECONDS:20`.

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
6. For points, betting on the AI League, agent submissions and saved live races, the game server needs Supabase too: `cp .dev.vars.example .dev.vars`, fill it in, and restart `npm run game`.

## Deploy for free

**Website → Cloudflare Pages** (or Vercel; both work the same way)
1. Push this repo to GitHub (public).
2. Cloudflare dashboard → *Workers & Pages* → *Create* → *Pages* → connect the repo.
3. Build command `npm run build`, output directory `dist`.
4. Environment variables: `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `VITE_GAME_URL` (see below), `NODE_VERSION=22`.

**Game server → Cloudflare Workers** (free plan; Durable Objects on SQLite storage are included)
1. `npx wrangler login` (free Cloudflare account).
2. `npx wrangler deploy`. It prints a URL like `https://ai-grand-prix-game.<you>.workers.dev`.
3. Set `VITE_GAME_URL=wss://ai-grand-prix-game.<you>.workers.dev/ws` in Cloudflare Pages and redeploy the site.
4. Secrets: `npx wrangler secret put SESSION_SECRET` (any long random string), and `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY`. Set `SITE_URL` in `wrangler.toml` to your site's address.
5. X login: create an app at developer.x.com (OAuth 2.0, type "Web App", scopes `users.read tweet.read`), add the callback `https://ai-grand-prix-game.<you>.workers.dev/auth/x/callback`, then `wrangler secret put X_CLIENT_ID` and `X_CLIENT_SECRET`. Guest play switches off automatically once X is set up.
6. Token gate (optional): set `TOKEN_MINT` (and `MIN_HOLD_USD`) in `wrangler.toml`.

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
| Cloudflare Pages | unlimited bandwidth | static site; league races are simulated in the browser |
| Cloudflare Workers + Durable Objects | 100k requests/day, 13k GB-s/day duration | one room. Incoming WebSocket messages count 20:1 as requests; clients send input only when a key changes, so a full 10-player grid uses roughly 6k requests/hour (~16 h of full racing a day). The room's loop stops when nobody is connected |

Known caveats:
- Live rounds are played from one Cloudflare location. Players far from it see more correction on their own car (the prediction hides most of it).
- GitHub turns off scheduled workflows in a repo with no commits for 60 days. Any push turns them back on.
- The list of free OpenRouter models changes often. The scheduler finds them automatically each run.
- Driver code is reused across tracks, so the prompt shows the model the next track as an example but asks for code that reads `TRACK` at runtime.
- Re-run `supabase/schema.sql` after updating: it adds the player-agent and live-race tables and the rule that hides a race's seed until its slot opens. It is safe to run again on an existing project.

## Credits

- Ferrari 458 Italia 3D model by **vicent091036** (Sketchfab), as distributed with the three.js examples. ⚠️ The original Sketchfab listing is no longer online, so its license can't be re-checked: replace it with a clearly licensed (CC0/CC-BY) car before any commercial launch.
- Textures and night sky from [Poly Haven](https://polyhaven.com) (CC0): `asphalt_02`, `aerial_grass_rock`, `pine_bark`, `rogland_clear_night`.
- Draco decoder from three.js (Apache-2.0 / MIT).

## Project layout

```
src/sim/        deterministic core, shared by browser + Node
  dmath.ts rng.ts track.ts physics.ts race.ts sandbox.ts driverApi.ts fallbackDriver.ts schedule.ts
  validate.ts (smoke test for driver code: scheduler + the agent page)
src/client/     Vite + three.js (3D) + PixiJS (map) front end
  main.ts (routes: live, league, leaderboard, agent, history, track lab, replay) broadcast.ts livegame.ts
  chase3d.ts crowd3d.ts renderer.ts account.ts bets.ts agent.ts data.ts style.css
src/game/       game server (Cloudflare Worker): worker.ts room.ts hub.ts auth.ts economy.ts solana.ts config.ts
src/server/     scheduler.ts openrouter.ts simCli.ts
supabase/schema.sql
tests/sim.test.ts tests/phase2.test.ts
```
