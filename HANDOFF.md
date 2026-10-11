# PumpKart (formerly RaceTrench / TrackLab 3D): full project handoff

You are taking over a working, deployed product. Read this whole file before changing anything. Money moves on
Solana mainnet through this code: be careful, test on devnet first, and never handle private keys.

---

## 1. What the product is

PumpKart is a browser 3D kart-racing game on Solana with a memecoin theme. Players sign in with X (Twitter) only,
get an embedded Solana wallet (Privy), and race for real prize pots paid in the game's token.

Core loop (from the client's "Build Summary" spec):
- **Race (ticketed, the money mode):** 5 players per lobby, one track, winner takes all. A ticket costs **$20**,
  paid in the game coin at the live price. Asynchronous PvP: you drive alone against the **ghosts** (recorded runs)
  of the real players already in your lobby. **No bots in paid races, ever.**
- **Settlement:** a lobby settles when 5 players have finished, or with 4 after 30 minutes. With 3 or fewer after
  30 minutes, every ticket is refunded (as a ticket).
- **Pot split:** 80% to the winner, 15% burned (direct burn of the coin received), 5% to the team.
  Full lobby: $100 pot -> $80 / $15 / $5. Four players: $80 -> $64 / $12 / $4.
- **KOL Cars (garage):** 12 cosmetic racers (meme characters of crypto KOLs). Orangie is free; the others cost
  **$100** (5 tickets) in the coin. Off-chain ownership, not NFTs, no stat advantage.
- **Free modes:** Test drive (vs bots, any racer), Live event (real-time multiplayer with bots filling seats, play
  points only), AI League (LLM-written drivers race each other every 5 minutes, spectators bet play points),
  Your Agent (submit your own JS driver), Track Lab, History/replays, Leaderboard.
- **Lore intro** on first visit: 2049, the charts went to zero, the KOLs are broke and race for the "Magic Ledger".

Client spec items still open (theirs to decide): skill-rating matchmaking, challenge/invite links (private, unranked
lobbies), freeroll first race (0.1 SOL, randomized lobbies), sybil defences (account age/quality, device binding,
wallet clustering, payout caps), onchain escrow program (needs an audit), ticket tiers above $20, AI League / Agent /
Track Lab / betting scope. The client confirmed: USD ticket pricing, legal risk accepted, written consent from every
KOL shown as a racer.

---

## 2. Current state (read this first)

- **Normal website coin-only test (2026-10-11):** owner authorized temporary `$RACE`
  mint `BJLoxTq2dkU46hXzL2UNjDPEHWs5ugKirFERYffpump` in the normal player screens,
  visibly labeled temporary and using real SOL. Owner chose coin buying first because
  the treasury is underfunded. Paid tickets, cosmetics and paid lobby entries stay closed
  via the server's persisted `paidEnabled: false` flag; `mode: test` supplies the label.
  `/private-coin-check.html` redirects to `/#/buy`; its API returns 410. The old ownership
  message/proof flow and modules were removed. Privy transaction approval uses
  Solana `useSignTransaction`, visible UI and cancellation; no agent signs the owner wallet.
  Default first buy: 0.001 SOL, 0.005 SOL conservative budget and 0.01 SOL retained buffer.
  Unsigned simulations show fees/account setup at review and recheck before signing.
  Real mainnet read-only PumpSwap review reached the browser in about 3 seconds here.
  Browser fixtures passed at 320/375/768/1440 px, cancellation, stale prices and keeping
  approval intact across account refresh. No wallet transaction was submitted by them.
  Owner's player wallet: `4tWo1pQfrtFbw94HW9NScGmmWNH2Y8u7D9DGxPC6AGpH`, latest
  balance 0.188229983 SOL. Treasury: `WXzD5Ph7zbaAebNXGxtG2QjbENeUuypNqnqkNsNFVHc`,
  0.00089088 SOL. The owner now requested full testing; funding and wallet approval
  still require their wallet clicks. They selected the same public treasury address
  for the team share; `TEAM_WALLET` is now configured. The read-only operational
  `check` reports no outstanding pots/payouts/tickets and an underfunded SOL reserve.
  Owner mainnet purchase/confirmation and fresh X login remain to verify. The official
  client CA is pending. See COIN_LAUNCH.md for the exact player steps and switch procedure.

- **Backend published (2026-10-11):** Worker version
  `80661041-ebc0-4023-b4e2-951ad830ae30` at the existing Worker URL.
  Server Pump SDK reads now explicitly select the configured cluster on the verification
  proxy; previously a missing cluster query incorrectly read devnet during mainnet activation.
  Real server-proxy mainnet verification and runtime prepare/enable both passed.
  Public configuration confirms revision `coin_1sF8rStR3xEUU7iV`, status live,
  buyEnabled true, mode test, paidEnabled false, sponsor null and the authorized test mint.
  The operations credential remains in gitignored `.devnet/coin-launch-admin.key`;
  never display it or read house/player private keys. Existing purchase recovery,
  submissions and withdrawals remain available. The WebSocket close fix remains deployed.
  This opens coin buying only, not an official coin launch or a completed mainnet payment test.

- **Frontend release (2026-10-11):** normal `/#/buy` flow shows amount presets, selected
  mint/route, receiving wallet, balance and an unsigned total including fees/account setup.
  The temporary-coin disclosure appears across the site. Account menu links directly to
  buying; ticket/paid friend-lobby controls are closed. Login/wallet SDK preloads for
  existing sessions. Active approval survives account refresh and page navigation;
  uncertain submissions retain their signed transaction ID and block repeat buys.
  Validation: 172 tests in 25 files, production build, Worker dry-run, mobile/desktop
  browser fixtures and a funded devnet integration round passed. Devnet verified five
  $1.25 entries, 20-test-coin prize, 3.75 burn, 1.25 team share, full 2-coin refund and
  sponsored 1-coin withdrawal to a new destination. No mainnet transaction was signed
  or submitted by Codex. The owner/client must approve a real small buy and fresh X login.
  The actual production Privy X login window opens with PumpKart branding and the
  Twitter option; published-page checks at 375/768/1440 px found no page errors or CSP
  violations. Completing OAuth and signing a purchase still require the owner/client.
  Deployment verification and exact player steps are recorded in COIN_LAUNCH.md.
  Latest production frontend: `solvnant-hij93z7rt-yousser-ayman.vercel.app`.
  Account-scoped payment receipts survive RPC/login errors and block duplicate
  checkout while pending. Withdrawals keep known signatures before broadcast, show
  pending honestly and check the same signature on retry; finalized expiry/history
  is required to unlock a retry. Sponsored RPC uncertainty returns the known signed
  receipt. A shared team/treasury devnet payout verified exactly 5% retained.
  `prepare ... --test-paid` opens a labeled full test only after `enable` checks
  the payout signer, team address, live USD price and 0.02 SOL starting reserve.
  Privy?s signing hook resolves only when its receipt window closes. The success
  receipt now says "Approval signed" and tells the player to click Close promptly;
  signing alone does not broadcast. Thirty-second quote expiry and final revision
  guards remain enforced. The owner supplied a signed-receipt screenshot and reports
  Coins received, but mainnet RPC checks still show no test-coin ATA or new purchase
  in the supplied wallet; a completed mainnet purchase is not verified yet.
  Historical implementation notes below are not proof of mainnet completion.

- **New domain connected: `pumpkart.racing` through Cloudflare.** The owner attached
  both hostnames to Vercel and configured DNS; both now show Valid Configuration. Apex
  redirects (308) to `www`, which serves Production. Local `SITE_URL` matches
  `https://www.pumpkart.racing`; the Solana RPC browser-origin allowlist accepts both.
  The frontend changes and Worker site settings are published.
  The owner has added both HTTPS origins to the existing Privy app and applied the pink
  color and PumpKart logo. Final name casing should be `PumpKart`.
  `https://www.pumpkart.racing/pumpkart-logo.png` returns HTTP 200.
  The remaining wallet check is full copied-address persistence after signing out/in.

- **Local predeployment stability audit (2026-10-11):** see `PREDEPLOY_CHECK.md` for
  measurements, coverage and remaining release checks. Hidden Track Lab rendering and
  stale WebSocket retries are fixed; racer-owned materials and instance buffers are
  released on replacement. Shader waits are bounded, and graphics failures fall back
  to playable map view. Practice/run loading, timers and submission responses are
  guarded against navigation and newer runs. Selected characters/shaders prepare under
  the loading screen; failed character downloads use defaults without an infinite
  replacement loop. Live entry now always uses play points, never coin tickets, even
  with coin payments configured; legacy reserved tickets can still be returned.
  All 113 tests, production build and Worker dry-run pass. Native Intel Iris Xe Chrome
  measured about 60 FPS over two ten-second Tokyo samples, with no tasks over 50 ms;
  leaving Track Lab reduced background CPU by approximately 48% and hidden draws to
  zero. Browser resilience, responsive layouts, local WebSocket Live and friend-lobby
  checks pass. Funded devnet prize/burn/team settlement, full refund and a new sponsored
  withdrawal passed. Local only: do not treat this as deployment or mainnet validation.
  Official coin activation, real production X/Privy access and the existing small
  owner-approved mainnet check remain release checks.

- **Local update: custom friend-lobby entries** lets the host choose a positive USD entry
  in cents (quick choices $5/$10/$20/$50 or a custom amount). The server converts it once
  using the coin market price and persists `entry_usd` and exact `entry_units`. All five
  players, including the host, pay that same locked coin amount; its USD value may change.
  The shared payment review is bound to the invite code. Payment reserves a place, then
  Start my run starts the existing asynchronous human/ghost race. Ordinary $20 tickets
  cannot pay a custom entry, and custom entries cannot be spent in public/live races or
  another invite. Creating a lobby is free; the price cannot be edited after creation.
  Public race prices, five-seat capacity, 30-minute / minimum-four settlement and the
  80% winner / 15% burn / 5% team split remain in place. Legacy friend lobbies retain
  their ticket flow; newly created lobbies with `entryUsd` use the custom payment flow.
  Exact raw units are checked on-chain and used for custom pot splits, sponsored transfers,
  payouts and refunds. Late, duplicate, mismatched and excess-seat payments, unused entries
  at expiry, and entries in refunded rooms get full coin refunds to their original payer
  through the existing signature-first payout queue; no burn/team fee applies to refunds.
  Refund states say pending/paid/needs attention, and paid entries remain in race history
  even before a run starts. Migrations add nullable entry/scoping/unit fields and refund
  metadata without altering existing ticket records. The coin-launch lock still applies;
  the entry form is previewable while paused but creation/payment remain disabled.
  The site checks that the server returns the chosen custom entry and an invite-bound
  exact-unit payment quote; an outdated Worker cannot silently charge a regular ticket.
  Deploy both site and Worker together to enable the feature.
  Validation: all 102 tests pass, production build and Worker deployment dry-run pass. Funded devnet testing used
  five sponsored $1.25 entries (5 test coins each), real-time-gated server-replayed runs,
  a confirmed 20-coin prize / 3.75-coin burn / 1.25-coin team transfer, and a separate
  confirmed full 2-coin refund after advancing expiry. Pricing alone was a devnet fixture;
  transfers, claims, burn, payout and refund ran on-chain. Browser checks passed at
  320/375/768/1440px: create/invite, locked payment review and cancellation, paid-ready
  state, real Hub join and host refresh, and disabled creation while the coin is paused.
  These browser checks used fixture credits and isolated 3D rendering; actual token
  transfers were verified separately in the funded devnet round above.
  Local only, no deployment or
  mainnet transfers. Keep a small owner-approved mainnet check before releasing it.

- **Local update: generated racer portraits** replaces all 12 catalog pictures with polished
  character-and-vehicle cutouts, matching magenta/cyan studio lighting and transparent backgrounds.
  Optimized 960x720 WebPs live in `public/assets/characters/portraits/` (about 1.4 MB for the full set).
  `src/client/portraits.ts` shares the new paths across the garage, practice racer picker, intro
  and ticketed race artwork; the HTML race hero uses the same directory. Versioned paths avoid
  showing previously cached thumbnails after a site deployment. Full-resolution PNG originals
  and the exact built-in imagegen prompts are retained in `brand/character-art/`. Older model
  thumbnails remain as reference sources, but the site no longer requests them. Garage images
  fit their card frames on mobile without cropping taller racers. No GLB, ownership, price,
  payment, payout or simulation changes. Local only; production build and browser checks pass
  for all 12 shop/picker images, desktop/mobile layouts, hero and intro, with no missing portraits
  or browser page errors.

- **Local update: FaZe Banks racer** adds catalog id/file `banks`, display name FaZe Banks,
  as racer #12. The supplied Downloads `lego+race+car+3d+model.zip` contains an FBX and
  color/normal/metallic/roughness textures. It was converted to a GLB with those materials,
  then optimized to near/far Meshopt + WebP assets (approximately 725 KB / 225 KB).
  The original converted `characters/banks-source.glb` and extracted scratch FBX/textures
  are gitignored. A transparent 960x720 garage thumbnail, driving orientation, scale,
  head/body/wheel rig and rear exhaust are configured in the existing skin catalog.
  It uses the existing cosmetic five-ticket unlock and free garage Test drive. Local only;
  Worker and site must both be deployed to enable server ownership/selection for this skin.
  No payment flow or race simulation changes. All 87 tests and production build pass;
  browser checks cover 375/1440px garage layouts, thumbnail loading, the actual Test drive
  selection, near/far models, scale/animation rig and keyboard acceleration.

- **Local update: CookerFlips racer** adds the supplied `cute go-kart 3d model.glb`
  from Downloads as catalog id/file `cooker`, display name CookerFlips. It is a pink
  heart-themed kart with a driver, using the existing cosmetic-only five-ticket unlock
  price and free garage Test drive. The original is `characters/cooker-source.glb`
  (gitignored); shipped near/far Meshopt + WebP models are approximately 450 KB / 101 KB,
  plus a transparent 960x720 garage thumbnail. Catalog yaw, scale, wheel/head/body rig
  and exhaust are configured for the existing racer loader and animation. The garage
  count/picker use the shared catalog automatically. Local only; deployment requires
  both Worker and site so server ownership validation recognizes the new skin.
  No payment flow or race physics changes. Production build and all 87 tests pass.

- **Local update: checkered finish line** makes the road strip high-contrast black/white,
  labels the gantry START / FINISH with checker panels, and adds two fabric flags outside
  the road. Flags wave for three seconds on the existing finish event/state and then settle;
  no extra lights, shadow passes, physics or simulation changes. Shared `finishFeedback.ts`
  shows a brief checkered FINISHED banner for the followed racer in 3D/map views, triggered
  by the existing finished flag (final lap only). Joining an already finished race and changing
  the followed racer do not replay it. Track changes and its 1.1-second timeout clear it.
  Reduced motion keeps the flags/banner static, and the banner never captures input or claims
  a win/prize. Files: `finishLine.ts`, `finishFeedback.ts`, `finishLine.css`, `chase3d.ts`,
  `renderer.ts`. Local only; no deployment or payment changes. Full 87 tests and build pass;
  browser checks cover actual two-lap simulation, flag settling, repeated/joined finishes,
  cleanup, reduced motion, and banner fit at 320/375/1440px.

- **Local update: UI and celebration polish** adds `src/client/controls.css` and delegated
  `controlFeedback.ts` for consistent hover/press/focus states and a bounded neon click sweep
  on existing and dynamically rendered buttons. Feedback has no action handlers or payment changes.
  Practice setup uses accessible native radio groups styled as course-preview cards and 1/2/3-lap
  buttons, with arrow-key navigation and a start label reflecting the choice. Small screens scroll
  within the setup card; the stage cannot shift horizontally when radio focus changes.
  Winner presentation now includes trophy/laurel/podium entrances, two bounded confetti cannons,
  stage lights, a prize shine and real race-time/lap stats for free practice/live wins. Paid prize
  wording and final-server-verdict gating remain in place. The short synthesized fanfare uses the
  existing master volume/mute and never starts audio without an already running audio context.
  Dismissal cancels the fanfare; confetti is removed after 4.6 s. Reduced motion removes animated
  decoration. Modal Tab/Shift+Tab handling now advances once on keydown, restores focus and keeps
  background inert. Browser checks cover radio keyboard selection, 320-1440px screens, actual
  three-lap start, dynamic/disabled controls, effects cleanup, mute, reduced motion, result gating,
  deduplication, payout wording and dismissal on short screens. Local only; no deployment.


- **Local update: driving and Tokyo circuit** adds Tokyo Afterdark (`tokyo:` seeds), an authored
  20 m street circuit with instanced buildings, emissive windows, signs and neon rails. Free
  practice now has a setup screen for city/procedural tracks and 1-3 laps (default 2); its time
  budget scales with laps. Live rooms and newly scheduled/local AI League races use 2 laps,
  rotating Tokyo every third slot. Paid ghost races retain their existing shared course/lap rules.
  Native bots use bicycle-model pursuit, early braking, clear-lane passing and spin/stuck recovery.
  New AI League model drivers get predictive road-boundary/braking/recovery assistance; user
  agents remain unassisted. SIM_VERSION is now 4; stored version-3 native controllers and old
  AI League behavior remain available for deterministic replay. Stored driver code is retained.
  Relevant files: `src/sim/nativeBot.ts`, `fallbackDriver.ts`, `track.ts`, `race.ts`,
  `src/client/tokyoCity.ts`, `practice.ts`, `chase3d.ts`, `src/game/room.ts`, scheduler/data.
  No deployment or money changes. Browser preview and full-race simulation checks cover city
  rendering, settings, 2/3 laps, recovery, old replay versions and real QuickJS driver generation.


- **Local update: coin buying and launch lock** replaces the fake token-demo page with a SOL
  quote/review/approve flow using the official Pump SDKs (bonding curve + canonical PumpSwap).
  Launch defaults to paused. Server revision checks block legacy/stale intents, sponsorship and
  paid entries; ticket memos also carry a revision and two-minute expiry. Coin buys are checked
  again after game-wallet signing, before broadcast. Pending coin transactions block repeat buys.
  The secret-authenticated `/api/admin/coin` supports pause → prepare → enable, with a two-minute
  drain, on-chain verification, outstanding-money checks and atomic persistent coin settings.
  No site rebuild is needed for the CA switch after advance deployment. Public settings refresh
  in current tabs. Fresh-coin pricing has a Pump reserve/SOL-USD fallback, with no test-coin fallback.
  Read `COIN_LAUNCH.md` before activating. New operations secret: `COIN_ADMIN_KEY` (not a wallet key).
  No deployment or real transfers were performed. Funded devnet E2E and the owner-approved small
  mainnet launch check remain required; automated fixtures are not funded network tests.
  Validation: 81 tests pass, production build passes, Worker dry-run build passes, and browser
  checks cover launch lock, buy review, responsive layout and actual official SDK loading.

- **Local update: winner celebration** adds a shared black/neon trophy entrance, a bounded
  CSS confetti burst, and a prize reveal. Paid celebrations require the server's settled
  `youWon` verdict; pending payouts are never labelled paid. It also appears for completed
  first-place practice/live races, without a token prize claim. Paid wins are deduplicated
  per account/lobby in session storage. Continue/Escape dismiss, focus is restored, and
  reduced-motion users get a static celebration. Browser checks cover verdict gating,
  pending/paid wording, repeated refresh, focus, dismissal and 320–1440px widths.
  Production build and all 62 tests pass. Local only; no deployment or money-code changes.

- **Local update: paid friend lobbies** are implemented, not deployed. Race page has Create lobby
  and Open lobby (accepts an 8-character code or pasted link). Invite URL: `#/race/friends/<CODE>`.
  Creating/opening an invite spends nothing; Start my run uses one existing current-coin ticket.
  The host shares with up to four friends. These use the existing asynchronous ghost race format,
  not the real-time Live event. Private lobbies are excluded from public matchmaking. The existing
  five-seat / minimum-four / 30-minute / 80-15-5 rules apply; the 30-minute clock starts at creation.
  New authenticated POST routes: `/api/lobby/private/create`, `/api/lobby/private/view`;
  `/api/lobby/join` accepts optional `code`. Migration adds `invite_code`, `host_uid` and indexes
  to lobbies, retaining existing rows. Codes require sign-in, are random, and never expose track
  seeds or payment wallets in previews. One account gets one run; host creation is limited to
  3 open lobbies and 20 per rolling day. Private results/payouts use existing settlement.
  Tests: 62 pass including real SQLite Hub integration. Browser checks used a local devnet-configured
  Hub with fixture tickets (no on-chain transfers); real funded devnet E2E and a small mainnet check
  remain required before releasing. No secrets were read and no production deployments occurred.

- **Live site:** https://www.racetrench.com (also https://racetrench.com -> www, and the old https://solvnant.vercel.app).
  It currently shows the **RaceTrench** brand (purple theme) and sells tickets in **$RACE**.
- **Uncommitted local work:** the owner rebranded the app to **PumpKart** (neon pink #ff006e + cyan, Orbitron font,
  new landing hero on the Race page, "P" logo). These changes are in the working tree, NOT committed or deployed.
  Tests pass (51/51) and `tsc` is clean with them. Payment memos are now `PumpKart ticket <token>` /
  `PumpKart skin <id> <token>`; `src/game/purchaseMemo.ts` accepts both the PumpKart and RaceTrench prefixes so
  older payments can still be recovered.
- **Next planned step:** the owner is launching a **new coin named PumpKart** on pump.fun. When they send the new
  contract address (CA): verify it on-chain (see section 9), switch the ticket settings to it, and deploy the PumpKart
  site **together with** the coin switch (so the site never shows PumpKart while selling $RACE). Nobody has bought
  anything with $RACE yet (the game wallet never received any), so no refunds are needed when switching.
- Other open owner items: a PumpKart domain (racetrench.com no longer matches), turn the "Token demo" button into a
  real "Buy $<ticker>" link to the coin's pump.fun page, Privy sign-in logo/name and X developer-app name still say
  RaceTrench, and a separate team wallet (multisig recommended) for the 5% share and creator fees.

---

## 3. Stack and hosting

| Piece | Tech | Where |
|---|---|---|
| Site (static SPA) | Vite + TypeScript, three.js (3D), PixiJS 8 (2D map), React only for the Privy island | **Vercel** project `solvnant`, auto-deploys on push to `main` (github.com/yderaoui/solvnant) |
| Serverless helpers | `api/solana-rpc.js` (Solana RPC proxy), `api/faucet.js` (devnet test coins) | Vercel functions, Node **22.x** |
| Game server | Cloudflare Worker `ai-grand-prix-game` (`src/game/worker.ts`) with Durable Objects `GameRoom` (live races, WebSocket, 60 Hz) and `Hub` (SQLite: accounts, points, bets, tickets, lobbies, payouts) | https://ai-grand-prix-game.ai-grand-prix.workers.dev, deployed by hand with `npx wrangler deploy` |
| Race data | Supabase (Postgres): `drivers`, `races`, `race_entries`, `race_results`, `agent_submissions`, `live_races` (RLS: a race's seed is hidden until its slot opens; results until it ends) | schema in `supabase/schema.sql` |
| AI League scheduler | `src/server/scheduler.ts` (OpenRouter free models write `drive()` code, races are simulated ahead) | GitHub Actions `.github/workflows/schedule-races.yml` (cron every 30 min, best effort; fills 12 h ahead). Can be run locally: `npm run schedule` |
| Sign-in + wallets | Privy (X login only, embedded Solana wallet per user), app id `cmuxzi8fk01ja0bjtygjpghge`, **production mode** | dashboard.privy.io |
| Solana RPC | Helius (free tier) behind the Vercel proxy (`SOLANA_UPSTREAM_MAINNET`) | the public mainnet RPC returns 403 to Cloudflare Workers and many sites |
| Domain | racetrench.com bought at Cloudflare Registrar; DNS: `@` and `www` are CNAME -> Vercel, **DNS only (grey cloud)** | Vercel serves www; apex redirects to www |

Important versions/quirks: `npm overrides` pins `uuid ^11.1.1` under `rpc-websockets` (Vercel can't `require()`
ESM-only uuid 14). Worker needs `compatibility_flags = ["nodejs_compat"]` (`@solana/kit`). PixiJS is imported with
`import 'pixi.js/unsafe-eval'` so it doesn't use `new Function` (blocked by our CSP).

---

## 4. Repository map

```
index.html                 SPA shell: header/nav, stage (3D/2D canvases + HUD), page sections
vercel.json                Security headers: Content-Security-Policy (enforced), X-Frame-Options DENY, nosniff, referrer policy
wrangler.toml              Worker config + non-secret vars (ticket coin, price, treasury, Privy app id, ...)
api/solana-rpc.js          RPC proxy: server calls with x-rpc-key may use getTransaction (+ the browser list);
                           browsers (allowed origins) get a whitelist of read/send methods only. Logs method + errors.
api/faucet.js              Devnet-only test coin faucet
src/client/                Browser code
  main.ts                  Router (#/race default, #/run, #/live, #/drive, #/garage, #/league, #/replay, #/lab,
                           #/leaderboard, #/agent, #/history, #/buy), startup, payment recovery after sign-in, intro on first visit
  ticketrace.ts            Race page (ticketed lobbies): pot, how it works, tickets, Race now, your races, payout status
  practice.ts              Local driving: test drive (vs bots, racer picker, P key) and ticketed runs (#/run: you vs ghosts,
                           submits inputs to the server)
  livegame.ts              Live event (real-time multiplayer over WebSocket)
  broadcast.ts             AI League playback (simulated in a Web Worker), replays
  chase3d.ts               three.js world: track, crowd, trees, cars, cameras, quality levels, warm-up/shader precompile
  racer3d.ts               Loads skin GLBs (near + far LOD), shader "rig": head turns, body sways, wheels spin, bobbleheads,
                           exhaust flames, player-colour ring; ghosts are see-through
  kart.ts                  Code-built fallback kart (used only if a GLB fails to load)
  garage.ts                KOL Cars page (buy / select / test drive racers)
  tickets.ts               Coin payments (ticket, skin), sponsored-fee flow, withdrawals, coin balance, recovery
  account.ts               Account state, sign-in (Privy X-only), account menu (points, tickets, wallet, withdraw)
  privy/island.tsx, privy/client.ts  Privy React island (lazy, preloaded for signed-out visitors) and glue
  intro.ts                 Lore intro (5 cards)
  audio.ts, soundPanel.ts  Synthesized race audio (engine styles Deep/Classic/Screamer) + Sound settings panel (M mutes)
  buy.ts                   "Token demo" page (fake; should become a real Buy link)
  style.css                All styles (theme tokens at the top; the PumpKart rebrand changed these)
src/game/                  Game server (Cloudflare Worker + Durable Objects)
  worker.ts                Routes /ws -> GameRoom, /api/* -> Hub (adds x-config-stamp), X OAuth (/auth/x/*)
  hub.ts                   Accounts, points, bets/markets, tickets, KOL Cars, ghost lobbies, payouts, sponsored fees,
                           withdrawals, payment recovery, AI League market sync (alarm every minute)
  room.ts                  Live event room (lobby, seats, bots fill to 6, priority passes, play-point pots)
  lobbies.ts               Ghost-lobby rules: SEATS=5, settle/refund verdict, ranking, pot split, run replay + validation
  house.ts                 House wallet (server-held key): build/sign payouts, co-sign sponsored purchases/withdrawals
  solana.ts                Payment reading/verification, coin USD price (Jupiter + DexScreener, lower wins), wallet checks
  purchaseMemo.ts          Recognizes purchase memos (PumpKart and legacy RaceTrench prefixes)
  config.ts                Reads env -> GameConfig; publicConfig (no secrets); configStamp (settings fingerprint)
  skins.ts                 KOL Cars catalog (10 racers) + per-model rig measurements; skinPrice (5 tickets)
  privy.ts, auth.ts, economy.ts, protocol.ts, liveEntries.ts
src/sim/                   Deterministic race simulation (shared by browser, Worker and scheduler)
  race.ts (RaceSim, SIM_VERSION, input logs/replays), physics.ts, track.ts (procedural tracks from a seed),
  obstacles.ts (trees, crowd fences), sandbox.ts + quickjs.ts (QuickJS sandbox for LLM/agent driver code), ...
src/server/                Node scripts: scheduler.ts (AI League), openrouter.ts, simCli.ts
public/assets/characters/  <skin>.glb (~0.4-1.2 MB), <skin>-far.glb (LOD), <skin>.webp (garage picture)
characters/                Original 60+ MB Tripo exports (*-source.glb, gitignored) + README on how to add a racer
brand/                     Logos/banners/scripts (make*.html), engine sound samples (wav). Not deployed.
tests/                     vitest: sim, lobbies (ghost rules), tickets (payment checks + memo prefixes), usd (pricing),
                           privy, phase2
supabase/schema.sql        Database schema + RLS policies
onchain/ (branch phase4-anchor-pots)  Early devnet-only Anchor escrow prototype; not used in production
```

---

## 5. Money: how every flow works (do not break these rules)

### Wallets (public addresses only)
| Role | Address | Who holds the key |
|---|---|---|
| **House / treasury (mainnet)** | `WXzD5Ph7zbaAebNXGxtG2QjbENeUuypNqnqkNsNFVHc` | The Worker (secret `HOUSE_SECRET`) **and** the owner's Phantom. Receives all ticket/racer payments, pays winners, pays players' network fees. Keep its balance small (pots in flight + ~0.05 SOL). |
| Team wallet | `WXzD5Ph7zbaAebNXGxtG2QjbENeUuypNqnqkNsNFVHc` (owner selected the treasury too; the 5% remains there) | owner/client |
| Owner's game wallet (Privy) | `4tWo1pQfrtFbw94HW9NScGmmWNH2Y8u7D9DGxPC6AGpH` | owner via Privy |
| Current coin $RACE | mint `BJLoxTq2dkU46hXzL2UNjDPEHWs5ugKirFERYffpump` (Token-2022, 6 decimals, no transfer fee, no mint/freeze authority) | being replaced by the PumpKart coin |
| Test coin $PTEST (mainnet) | mint `2EtATUYcuiCYkQRugSQvhGaE1AVXxqb8drpueeGvk4C8` | used only for testing |
| Devnet test coin $TRACK | mint `BQ2rBfDdVNXVkBqmg94PdgSrsMAaoDydedwoRYZZmyXM` | local dev (`.devnet/coin-authority.json` is its mint authority) |
| Devnet house (local tests) | `Ef4yN94MZcnh7YnyApit3EpRcfmsn8DRygJuFMJKsgt1` (key in `.devnet/house.json` and local `.dev.vars`) | local only |

### Buying a ticket or racer (src/client/tickets.ts -> hub.ts)
1. Browser `POST /api/ticket/intent` (or `/api/skin/intent`). The Hub computes the price in coins
   (`TICKET_PRICE_USD` / live price, cached 1 min, rounded up; racers = 5 tickets), creates a one-time memo
   (`PumpKart ticket <random>`), and stores it in `pay_memos (memo, uid, ts, price, mint)`.
2. Browser builds the transaction: `transferChecked` of exactly the quoted amount into the house's coin account
   (Token-2022 or classic, program read from the mint) + the memo. **Fee payer = the house** (sponsored gas).
3. Privy **only signs** (`signTransaction`); the browser sends it to `POST /api/pay/sponsor`. The Hub
   (`house.cosignPurchase`) checks the transaction instruction by instruction: fee payer = house, exactly one transfer
   of this mint into the house's coin account for exactly the quoted amount, one memo that was handed to this player
   in this coin, the house appears in no other instruction (except creating its own coin account once), no lookup
   tables. Then it co-signs and sends. Daily cap: 30 sponsored transactions per player.
4. Browser polls `POST /api/ticket/claim` (or `/api/skin/claim`) -> `Hub.claimPayment` reads the transaction
   on-chain (`readPayment`) and credits it once. Rules: memo must be in `pay_memos`, belong to this player, match the
   current mint, have a price > 0; the treasury must have received >= the quoted amount and > 0; each signature counts
   once (tickets/skins tables). A second payment for an already-owned racer becomes tickets.
5. Recovery: after sign-in the site lists the wallet's recent purchase memos (`getSignaturesForAddress`) and calls
   `/api/pay/recover`; the server credits any not yet counted, with the same rules.
- Tickets are tied to their mint (`tickets.mint`); only tickets of the current coin count.

### Ghost lobby (lobbies.ts + hub.ts)
- `POST /api/lobby/join` uses one ticket, puts the player in the oldest open lobby of the same coin and USD price
  with a free seat (or opens one), returns the seed, the ghosts (other players' input logs) and the current pot.
- The player drives locally (deterministic sim); `POST /api/lobby/submit` sends the input log. The server
  **re-simulates** it (`replayRun`) and only that result counts. Rejected if the log is malformed, or if it arrives too
  late (time to retry the track) or too early (computed, not driven): `submittedInTime`. No submission by the deadline =
  DNF. Leaving mid-race submits what was driven.
- Verdict (`lobbyVerdict`): settle at 5 done; at 30 min settle with >= 4, refund (tickets back) with <= 3; never while
  someone is still driving. Ranking: first across the line, then furthest progress.
- Pot = coins actually paid for the lobby's seats (`lobbyPot`); split with `splitPot` (80/15/5, team gets the exact
  remainder).

### Automatic payout (hub.processPayouts + house.buildPayout)
- On settle, a `lobby_payouts` row is queued (winner wallet = the wallet that paid the winner's ticket). Only lobbies of
  the current mint are paid automatically; others become `manual`.
- One transaction per lobby: create the winner's coin account if needed, transfer 80% to the winner, **burn** 15%,
  transfer 5% to `TEAM_WALLET` (if set), memo `PumpKart payout <lobby>`. Signed by the house.
- Never pays twice: the signature is stored **before** sending (`status: sent`); a new transaction is built only after
  the previous blockhash has expired without the transaction landing. Runs every minute from the Hub alarm (and right
  after a settle). Status shown to players as "Paid · view" (solscan link).

### Withdrawals
- Account menu -> Withdraw. The player's coins go to any address; the house pays the fee (`/api/pay/withdraw`,
  `cosignWithdrawal`: one transfer of the game coin out of the player's own coin account only). Creating a coin account
  for a new destination is sponsored once per day per player.

### Pricing
- `TICKET_PRICE_USD = 20`. Price = min(Jupiter `lite-api.jup.ag/price/v3`, DexScreener best-liquidity pair). If no price
  is available, purchases are refused (`TICKET_PRICE = "0"` disables a fixed fallback).

---

## 6. Security measures already in place
- X-only sign-in through Privy (production mode, allowed origins: https://www.racetrench.com, https://racetrench.com,
  https://solvnant.vercel.app). Server verifies Privy JWTs (ES256, JWKS) at `/api/privy` and issues its own session.
- CSP (enforced) and X-Frame-Options DENY in `vercel.json`. If you add a new external origin (API, image host, etc.),
  update the CSP **first in report-only**, walk every page, then enforce. Tested pages: all routes + sign-in modal.
- Server re-simulates every race; timing checks against retries/computed runs.
- Sponsored transactions are validated instruction by instruction (attack tests: redirected payment, extra SOL transfer
  from the house, someone else's memo, underpaying, moving the house's coins: all refused).
- Payment memos, tickets and lobbies are bound to the coin mint, so switching coins can't be abused with old data.
- Hub self-restart: the Worker sends `x-config-stamp` (fingerprint of all settings); a Hub Durable Object still running
  with older settings aborts and restarts. (Found because a deploy did not restart the Hub.)
- RPC proxy only exposes whitelisted methods to browsers; `getTransaction` needs the server key.
- The game wallet's private key is only in the Worker secret `HOUSE_SECRET` (and the owner's Phantom). **Never print,
  log, commit or ask for it.**

---

## 7. Configuration (names only, never commit values)

**Worker vars (wrangler.toml):** SITE_URL, MIN_HOLD_USD, X_MIN_ACCOUNT_DAYS, X_MIN_FOLLOWERS, POINTS_SIGNUP, POINTS_DAILY,
POINTS_ENTRY_FEE, POINTS_PRIORITY_FEE, MAX_PRIORITY_PER_RACE, BET_RAKE_PCT, TICKET_CLUSTER, TICKET_MINT, TICKET_DECIMALS,
TICKET_TREASURY, TICKET_PRICE, TICKET_PRICE_USD, TICKET_SYMBOL, TICKET_RPC_URL, TICKET_VERIFY_URL, PRIVY_APP_ID,
TEAM_WALLET (required by paid-launch readiness, may equal the treasury if the owner chooses).

**Worker secrets (`wrangler secret put`):** SESSION_SECRET, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, X_CLIENT_ID,
X_CLIENT_SECRET, TICKET_VERIFY_KEY (= Vercel's RPC_PROXY_KEY), HOUSE_SECRET (house wallet secret key, base58 or JSON
array), ALLOW_GUESTS=false.

**Vercel env:** VITE_GAME_URL (wss://ai-grand-prix-game.ai-grand-prix.workers.dev/ws), VITE_SUPABASE_URL,
VITE_SUPABASE_ANON_KEY, RPC_PROXY_KEY, FAUCET_SECRET, FAUCET_MINT, SOLANA_UPSTREAM_MAINNET (Helius URL, secret).

**GitHub Actions secrets/vars:** SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, OPENROUTER_API_KEY, vars OPENROUTER_MODELS,
SITE_URL, RACES_AHEAD_MINUTES (720).

**Local:** `.env` (scheduler: Supabase + OpenRouter keys), `.dev.vars` (Worker locally; currently **devnet**: devnet
$TRACK, devnet house as treasury, TEAM_WALLET = old devnet treasury, ALLOW_GUESTS=true, TICKET_PRICE_USD=20),
`.devnet/` (devnet/test keypairs; gitignored). All gitignored; keep it that way.

---

## 8. Running, testing, deploying

```
npm install
npm run dev                 # site on http://localhost:5173
npm run game                # local Worker on http://127.0.0.1:8787 (uses .dev.vars)
npm test                    # vitest (51 tests)
npm run build               # tsc + vite build
npx wrangler deploy         # deploy the game server (Worker + Durable Objects)
git push origin main        # Vercel deploys the site automatically
```
- Windows: run vitest from PowerShell with `Set-Location 'C:\Users\dell\Desktop\slovnant'` (from Git Bash the cwd case
  can make vitest report "no tests"). Stopping `wrangler dev` may leave `workerd.exe` running on port 8787: kill it.
- Deploy the Worker **and** push the site when a change touches both (prices/ownership are checked server-side).
- After a Worker deploy, check `GET /api/config` returns the new settings (the config-stamp restart handles stale Hubs).
- Browser checks were done with Playwright scripts (playwright-core + local Chrome): page sweep, sign-in timing, test
  drive, garage, CSP violations, multi-width header layout. Use **solvnant.vercel.app** for automated tests: Vercel's
  firewall challenges the owner's IP on racetrench.com after bursts of automated traffic.
- Money changes: test on **devnet** with the local Worker first (devnet house + coin authority in `.devnet/`), then a
  small mainnet test. A full end-to-end round (5 sponsored tickets from a 0-SOL wallet, 5 runs, automatic payout, burn,
  team share) has passed on devnet and on mainnet with $PTEST.

---

## 9. Switching to a new coin (the next task)

1. Read the mint on mainnet (`getAccountInfo`, jsonParsed): owner program (Token or Token-2022), decimals,
   **mintAuthority null, freezeAuthority null**, and **no `transferFeeConfig` extension** (a transfer tax breaks payment
   checks and the tax authority could raise it: refuse such coins). Check name/symbol in `tokenMetadata`.
2. Confirm a live price on Jupiter and DexScreener.
3. Check the house wallet holds no unsettled coins of the old mint / no open lobbies (on-chain: house's coin account for
   the old mint and its memos). For $RACE the balance is 0, nothing to refund.
4. Follow the runtime pause → two-minute drain → prepare → enable procedure in `COIN_LAUNCH.md`
   using `scripts/coin-launch.mjs`. Persisted `coin_launch` settings override the initial Wrangler
   mint/ticker: editing `wrangler.toml` alone will not switch the live coin. Prepare validates
   mint/decimals/route, refuses outstanding pots/payouts/unused tickets, and stays paused.
   Enable requires live USD pricing and, for paid races, the matching payout wallet, valid team
   destination and at least 0.02 SOL treasury reserve. Public tickets remain $20.
5. Ask the owner for one real purchase and confirm it on-chain (fee paid by the house, amount = quote).

---

## 10. KOL Cars (racer skins)

| id | Name | Ride | Price |
|---|---|---|---|
| orangie | Orangie | Turbo wheelchair, powered by tacos | free |
| tjr | TJR | Blown red hypercar, cash on the seat | $100 |
| rasmr (file cart) | Rasmr | Motorized shopping cart | $100 |
| kimchi | Kimchi | Giant head car (Trump head) | $100 |
| ansem | Ansem | Bull on monster truck wheels | $100 |
| elon | Elon Musk | Chrome cyber buggy | $100 |
| brez | Brezscales | Red sports car (Ferrari badges), steers with chains | $100 |
| jack | Jack Duval | Land yacht with outboard motors | $100 |
| vitalik | Vitalik | Pink unicorn toy car, rainbow exhaust | $100 |
| rowdy | Rowdy | Black supercar (Lambo badge), RETIRED plates (retopologized Tripo model) | $100 |
| cooker | CookerFlips | Pink heart kart, cute driver | $100 |
| banks | FaZe Banks | Colorful brick-built race car, cash on the hood | $100 |

Models are Tripo AI single-mesh statues (no skeleton). `racer3d.ts` animates them in the vertex shader using
hand-measured rigs in `skins.ts` (head/neck, body, wheels, optional bobbling part, `face` offset for Orangie's turned
head). To add a racer: see `characters/README.md` (gltf-transform optimize near + far, add to SKINS with yaw/length/
exhaust/rig, render a 960x720 transparent .webp). The "Garage" page is labelled **KOL Cars**. Bots and AI League cars
use all skins. Consent from every KOL: confirmed by the client. Car brand logos (Ferrari, Lamborghini) are visible on
two models: remaking them without badges was recommended. Tripo paid plan needed for commercial use.

---

## 11. Other features worth knowing
- **Live event** (`room.ts`, `livegame.ts`): real-time 60 Hz server-authoritative races every few minutes, play points
  (signup 1000, daily +100, entry 50, priority pass 200, max 3 per race), bots fill to 6 cars, waitlist/next-up list,
  spectator betting on live races, replays saved to Supabase `live_races`. Originally used tickets too; ticketed play
  moved to the Race page.
- **AI League:** OpenRouter free models write `drive(state)` functions, run in a QuickJS sandbox; races precomputed per
  5-minute slot; spectators bet points (pari-mutuel, 5% rake); code viewer; replays re-simulated and checked.
- **Your Agent:** players submit their own driver code (5/day), tested in the same sandbox.
- **3D performance work:** shader precompile (`warmUp`), quality levels 0..3 with auto adaptation, software-GPU detection,
  LOD for racers, half-rate rendering behind lobby overlays, fade cover on page switches, NaN guards for the camera.
- **Sound:** synthesized (no files); per-frame automation uses `cancelAndHoldAtTime` (piling automation caused crackle).
- **Header/nav** has responsive rules down to 390 px; the link row scrolls on phones.

---

## 12. Rules for whoever continues
- Never commit or print secrets (.env, .dev.vars, .devnet, HOUSE_SECRET, API keys). Never ask the owner to paste a
  private key in chat; have them run `npx wrangler secret put <NAME>` themselves.
- Treat payment, payout, sponsor and withdrawal code as critical: add tests, run the devnet end-to-end round, then a
  small mainnet test before announcing.
- Don't add bots to paid races. Don't change the 80/15/5 split, the $20 price, the 5-seat / 30-minute rules, or the
  coin without the owner's OK.
- The owner communicates casually and non-technically; explain outcomes plainly and give click-by-click steps for
  dashboards (Vercel, Cloudflare, Privy, Helius, X developer portal, Phantom).
- Real people are depicted as racers: the client confirmed consent; keep a record. Paid winner-takes-all races may be
  regulated as gambling in some countries: the client accepted that risk.
