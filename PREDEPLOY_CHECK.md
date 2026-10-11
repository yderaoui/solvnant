# PumpKart predeployment check

Originally checked locally on 2026-10-11, without a production deployment, push or
mainnet transfer during that audit. Subsequent publication is recorded in the release
follow-up below.

## Fixes

- Stop hidden Track Lab / broadcast rendering after leaving the stage. Stop unnecessary Pixi rendering on menus and during the separate practice renderer.
- Cancel scheduled WebSocket reconnects when leaving; stale retries cannot replace a newer connection.
- Release racer-owned materials and instanced graphics buffers when replacing racers or tracks, keeping cached model geometry and textures intact.
- Bound shader preparation and handle lost graphics connections. Practice, paid runs and spectators can fall back to map view if 3D fails.
- Guard race loading, result timers and submission responses against navigation or a newer run. Leaving cancels old input and animation work.
- Prepare selected character models and shaders behind the loading screen. Character preparation has a six-second ceiling; failed downloads use default racers. Fix an endless replacement loop when a character download fails.
- Live events use play points only, including when coin tickets are configured. They do not buy or consume coin tickets. Existing legacy ticket reservations retain their return path. Paid human/ghost races and their prize split are unchanged.

## Performance measured

Production build in native Chrome, Intel Iris Xe / Direct3D 11, 1280 × 800, automatic graphics quality, two-lap Tokyo practice. This used the real 3D renderer, keyboard driving and a local API fixture. Frame and CPU profiling add some overhead.

| Measurement | Result |
| --- | --- |
| First ten seconds of racing, including countdown | 60.2 FPS; 95th-percentile frame interval 16.8 ms |
| Following ten seconds of racing | 60.2 FPS; 95th-percentile frame interval 16.8 ms |
| Main-thread tasks exceeding 50 ms in those samples | None |
| Initial menu load on localhost | 0.62 seconds |
| First race preparation on localhost | 2.32 seconds |
| Hidden rendering after leaving Track Lab | 17 draw calls/frame before; zero after |
| Background main-thread CPU after leaving Track Lab | 68.6 → 35.9 ms/second, approximately 48% less |

Six additional race restarts and a Track Lab visit completed without page errors or missing assets. Graphics handle counts varied with track contents rather than increasing on every restart. These are local measurements, not guarantees for every device or internet connection. Responsive phone layouts were emulated; physical phone performance remains unmeasured.

## Checks passed

- **113 tests in 15 files**, including bot racing, payment validation, equal custom stakes, duplicate/late/excess payments, refund isolation, connection cleanup, material ownership and shader deadlines.
- **Production build**, including TypeScript checking; **Cloudflare Worker deployment dry-run**; `git diff --check`.
- Seven pages at **320, 375, 768 and 1440 pixels**, without horizontal overflow.
- Tokyo with three laps, procedural Grand Prix with one lap, map controls, leaving and restarting practice.
- Actual graphics-context loss, a blocked 3D bundle and blocked character downloads: playable fallback, responsive navigation and no unhandled page errors.
- Actual local Worker WebSocket Live entry with zero tickets while coin launch was paused: 50 play points charged, keyboard driving, 211 snapshots received, no reconnect after exit. Production authentication was not exercised; the test used a local guest and disabled Privy in the test config.
- Friend lobby creation, invite clipboard, locked $12.50 / 1,250-coin fixture quote, checkout review/cancellation, paid-ready state, actual Hub join, 3D preparation/countdown/keyboard driving and host refresh. Browser credits and pricing were fixtures; real payments were checked separately below.
- **Funded Solana devnet:** five sponsored $1.25 entries at five test coins each, server-replayed runs after the actual timing gate, confirmed **20-coin prize / 3.75-coin burn / 1.25-coin team transfer**.
- **Funded Solana devnet refund:** the full two test coins returned to the original payer, without burn/team fees.
- **Funded Solana devnet withdrawal:** exactly one test coin delivered to a new destination; destination token-account creation and network fees sponsored by the house.

The devnet tests used fixture pricing and advanced the unused-entry expiry locally; token transfers, signature claims, replay validation, prize settlement, burn, refund and withdrawal were real. Live entry/refund also left coin balances and ticket counts unchanged.

## Before public release

Deploy the site and Worker together. The official coin is still paused pending its contract address; confirm the official mint, token-program support and buy quote before enabling it. Verify real X/Privy login and wallet access on the production domain, then perform the existing small owner-approved mainnet payment/payout/withdrawal check. These checks cannot be replaced by devnet or local guest tests.

Local diagnostic scripts, profiles and logs are in the gitignored `scratch/predeploy-*` files. The funded test runner is `scratch/check-custom-stakes-devnet.ts`. No secret values are included in this report.

## Release follow-up (2026-10-11)

The frontend is published on `https://www.pumpkart.racing`. Wallet loading was subsequently
bounded, the address/copy button now appears before balance requests, retry keeps the
menu open, and failed RPC reads no longer display a false zero. The complete suite now
has **121 passing tests in 17 files**, and the production build passes. A browser check
verified slow-RPC address display, balance timeout, wallet retry and paused/legacy menu
purchase locking. Owner screenshots confirm real X sign-in and wallet display; the
full address after signing out/in still needs owner confirmation.

The game Worker is published as version `5188d8fb-9799-4fde-bbdb-b5097d402d32`.
The operations credential is configured securely outside git and an authenticated
pause is persisted. Live `/health` and `/api/config` return HTTP 200; configuration
reports coin purchases paused and coin buying disabled, preserves the existing Privy
app, omits secret fields, permits browser CORS and uses `Cache-Control: no-store`.
Anonymous coin-preflight, ticket-intent, friend-lobby-create, sponsor and coin-admin
requests return HTTP 401. A spectator WebSocket returned room data and pong; the room
reports two laps and a 50-point entry fee. Production verification also found an
incomplete WebSocket close handshake under the older compatibility date. Enabling
`web_socket_auto_reply_to_close` fixed it without changing the compatibility date;
see [Cloudflare's flag documentation](https://developers.cloudflare.com/workers/configuration/compatibility-flags/#websocket-auto-reply-to-close).
The final live check received five snapshots and closed normally (code 1000, 296 ms).
No race was joined and no wallet transaction
was submitted during these deployment checks.

Production authenticated paid actions have not been tested by these checks. Their
paused/stale-revision behavior was covered by the existing automated and local/devnet
tests. Isolated temporary pump.fun coin testing, a funded approved mainnet check and
official-coin verification remain outstanding. The production mint remains the old
coin while purchases are paused; it has not been designated as the official coin.

Deployment logs and live-check results are gitignored in `scratch/backend-release-*`.
