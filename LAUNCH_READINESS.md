# PumpKart readiness audit — October 12, 2026

**The deployed temporary-coin site passes the checks below and is ready for client testing. The official public coin launch is not yet verified.** The final official mint/ticker and wallet-operated release checks are still outstanding.

Site: https://www.pumpkart.racing

## Checks completed

| Area | Result and evidence |
| --- | --- |
| Automated regression suite | **214 tests passed in 28 files**. Covers bot driving, deterministic replay, authorization, launch revisions, equal stakes, payment validation, recovery, wallet deadlines, shader deadlines and resource ownership. |
| Release build | TypeScript and Vite production build passed; Worker deployment dry-run passed. |
| Production pages | Race, Garage, Buy, Agent, History, Leaderboard, Track Lab, AI League and Live checked at **320 / 375 / 768 / 1440 px**. No horizontal page overflow, uncaught page error, CSP violation or HTTP 5xx during the check. |
| Login | Actual production Privy window opens with PumpKart branding and Twitter. Fresh X OAuth completion and signed-in wallet persistence require the real account holder and remain unverified by this audit. |
| All racers | All **15** near/far models load with textures; animation, shader compilation and GPU-error checks pass. All 15 deployed garage portraits decode at 960×720. |
| Practice | Tokyo with three laps, procedural circuit with one lap, keyboard/map controls, leaving and restarting passed. Practice defaults to two laps and allows 1–3. |
| Graphics failure recovery | Lost WebGL context, failed 3D bundle and failed character downloads each recover to playable map/default racers without a crash. |
| Live connections | Production spectator WebSocket returns room/snapshots/pong and closes normally. Local real Worker Live entry with zero coin tickets charges **50 play points**, receives snapshots, supports keyboard driving and stops reconnecting after exit. The local Worker used shortened test scheduling only. |
| Friend lobby UI | Create custom USD entry, copy invite, identical locked quote, cancellation, paid-ready entry, actual local Hub join, host refresh and responsive layout passed. UI credits in this browser check are fixtures. |
| Funded devnet full round | Five sponsored $1.25 entries at five test coins each; timing-gated replay accepted; exactly **20 coins to winner / 3.75 burned / 1.25 team**. Test identities and pricing are fixtures; Solana transfers and burns are real devnet transactions. |
| Shared treasury/team wallet | Separate funded devnet check verifies exactly **5% retained** when the team destination equals the treasury. Production keeps the existing treasury as requested. |
| Friend refunds | Full two-test-coin refund to original payer passed. Separate abandoned-run test refunds through the alarm with no page polling and no burn/team deduction. |
| Public ticket and shop | Real funded devnet public ticket purchase at the $20 fixture rate, all **14 paid skin purchases** at the $100 fixture rate, ownership/select for all 15 skins, exactly-once recovery, foreign-account claim rejection and abandoned public-race ticket restoration passed. Ordinary insufficient-player races return the ticket; custom friend stakes refund coins. |
| Withdrawals | Funded devnet server path and actual client preparation/sign/broadcast/confirmation path deliver the exact amount. Receipt link, pending status, account refresh and menu close/reopen checks pass. |
| Coin buying | Fresh unsigned mainnet PumpSwap quote/simulation succeeds for the current temporary mint. Browser review took **2.38 s** in this test. Cancellation, stale review rejection and retaining approval during account refresh pass; no mainnet purchase was submitted by the fixture. A separate devnet transfer verifies the late wallet-Close signing lifecycle, not an actual PumpSwap swap. |
| Existing mainnet receipts | Original owner purchase, full custom-entry refund and **196-coin withdrawal** were rechecked and remain finalized with exact token deltas. This audit made read-only mainnet checks. |
| Protected endpoints | Nine payment/admin endpoints reject anonymous requests (401). Production guest signup is disabled (403); server config omits secrets. |
| Background maintenance | Paid-readiness check passes, alarm is scheduled, last maintenance completed; **zero open paid lobbies, unresolved payouts and unused tickets** at final inspection. |
| Domain and branding | Apex redirects to www (308); logo loads; production X window is branded; retired private-check API returns 410. |
| Promo files | Full roster, Big Three, Ansem, FaZe Banks and Rasmr posters are saved in `brand/promos/`, with PNG/JPEG copies, packs, references and exact generation prompts. |

No gameplay or payment defect was reproduced in the completed checks. Diagnostic failures were resolved in the test setup: the public devnet endpoint rate-limited a rapid catalog test, a local browser origin was outside the RPC CORS allowlist, and the original Live harness timeout was shorter than the next scheduled round. Devnet calls were paced and confirmed over HTTP, the documented localhost origin was used, and only the isolated local Live schedule was shortened. These are not production fixes or guarantees of instant blockchain confirmation.

## Measured performance

Isolated **production build**, native Chrome, Intel Iris Xe / Direct3D 11, 1280×800, automatic graphics quality, two-lap Tokyo, local account API fixture:

| Measurement | Result |
| --- | --- |
| Initial racing sample | 60.11 FPS; p95 frame interval 16.8 ms; no tasks over 50 ms |
| Following racing sample | 60.22 FPS; p95 16.8 ms; no tasks over 50 ms |
| Menu preparation | 0.77 s |
| Race preparation | 3.64 s |
| Race restarts | Six successful restarts; graphics resource counts remain bounded rather than accumulating each restart |
| After leaving Track Lab | Zero graphics draw calls while hidden |

The first profile ran alongside other browser tests and was affected by that load; the figures above come from the separate isolated run. They are measurements on this desktop, not results from a physical phone or a many-user load test.

## Current production settings

- Mode: **temporary test coin**, real Solana mainnet; buying and paid testing enabled.
- Mint: `BJLoxTq2dkU46hXzL2UNjDPEHWs5ugKirFERYffpump`; symbol `$RACE`.
- Revision: `coin_1IW81Dz-DGQipqGD`.
- Treasury **and 5% team destination**: `WXzD5Ph7zbaAebNXGxtG2QjbENeUuypNqnqkNsNFVHc`.
- No official coin was substituted or designated by this audit.

## Remaining official-release checks

1. Receive and verify the client's **official Solana CA and ticker**; complete the existing pause/drain/prepare/enable switch. Publish the requested official CA/Copy/explorer/pump.fun display using that real mint.
2. Complete a small owner/client-approved purchase of the official coin and inspect its exact receipt.
3. Complete a real multi-user mainnet race and verify the winner payout, burn and team share on-chain. Devnet settlement does not replace this check.
4. Complete fresh client X login and verify the same embedded wallet and ownership persist after sign-out/in.

These depend on details or wallet/account interactions unavailable to this unattended run. No question or approval request was sent to the sleeping owner. See `COIN_LAUNCH.md` for the current steps; old instructions are preserved separately as history.

## Local evidence

Gitignored audit output is in `scratch/overnight-*`: regression/build logs, readiness snapshots, production UI and authorization results, model report, isolated CPU/frame profiles, devnet catalog receipts, funded-round/refund/withdrawal logs, and the rechecked mainnet receipts. The audit contains no wallet private keys or operations credentials.
