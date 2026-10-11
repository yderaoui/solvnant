# PumpKart predeployment check

Checked locally on 2026-10-11. No production deployment, push or mainnet transfer was performed.

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
