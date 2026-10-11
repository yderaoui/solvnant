# PumpKart launch and real website test

Main website: **https://www.pumpkart.racing**
Coin buying page: **https://www.pumpkart.racing/#/buy**

We are keeping **X login and Privy Solana wallets**. The separate private wallet
verification page is retired: its URL redirects to the normal Buy coins page and
its API returns HTTP 410. There is no free ownership-signature step before buying.

## First: coin buying only (completed)

The owner authorized the temporary `$RACE` mint:
`BJLoxTq2dkU46hXzL2UNjDPEHWs5ugKirFERYffpump`.
It is a mainnet coin, **not the official PumpKart coin**. It has graduated to
PumpSwap. Buying it spends real SOL. The website explicitly labels this test.

The initial coin-only test used `coinLaunch.mode: test`,
`paidEnabled: false`. In that stage, coin buying worked and the server rejected new
paid ticket, cosmetic and friend-lobby payments/entries. Public configuration exposes
no fee sponsor in this stage. Practice and play-point modes remain available.
**Current paid test activation verified on 2026-10-11:** `/api/config` reports status live,
buyEnabled true, mode test, paidEnabled true, sponsor equal to the funded treasury,
and the exact same authorized temporary mint.
Revision: `coin_1IW81Dz-DGQipqGD`. Worker: `86a5e450-712c-48c8-a085-2130709608ef`.
Frontend production deployment: `solvnant-7gpellukd-yousser-ayman.vercel.app`.
Changing client copy alone does not open payments.

**First real owner purchase is verified on mainnet.** The owner approved it through
the normal site/Privy flow; Codex checked the transaction through Solana RPC.
It finalized successfully and delivered **46,196.549711 test $RACE** to the player
wallet above. Total wallet debit: **0.003865039 SOL**, including **0.000005 SOL**
network fee and account setup. Remaining player balance: **0.184364944 SOL**.
[Verified purchase](https://solscan.io/tx/3jvxAE6KE8ZiythF7qhDnmjHc4B9D79zoFWMa9G8nvctN8FrLNofvcgjkW6wr7coCLeNM2155DDvSsr7S7o99zC7).
This verifies coin buying; paid tickets, prizes, refunds and withdrawals still need
their mainnet tests. Treasury funding is now verified. Fresh client X login and wallet persistence
after sign-out/in also remain to check.

1. Open **https://www.pumpkart.racing/#/buy** and sign in with your existing X account.
2. Check your wallet matches the expected account. The owner's funded player wallet is
   `4tWo1pQfrtFbw94HW9NScGmmWNH2Y8u7D9DGxPC6AGpH`.
3. Keep the default **0.001 SOL** for the first test and click **Review purchase**.
4. Check the coin address, receiving wallet and estimated total including fees/account
   setup. The previous unsigned simulation estimated **0.003865039 SOL** total.
   That is an estimate, not a current quote. The first 0.001 SOL test conservatively
   checks a 0.005 SOL budget before wallet approval and retains a 0.01 SOL buffer.
5. Click **Approve purchase**, then review and approve the transaction in Privy.
   Approval is a transaction signature; the site broadcasts only after its final
   launch/quote checks. Cancel if the amount or wallet differs from your expectation.
   **Click Close in Privy after signing.** Privy's SDK only returns the
   signed transaction to PumpKart when that receipt window closes. Signing alone
   does not send a purchase. The review price must be fresh when approval starts;
   after signing, checkout uses the actual Solana blockhash lifetime and re-simulates
   the exact signed transaction against the reviewed spending limit before broadcasting.
   A changed message, invalid signature, expired blockhash, failed simulation, exceeded
   budget, changed account or launch pause stops submission. Wallet approval is not
   cancelled just because the 30-second review timer ran out while Privy was open.
   The wallet receipt now explains this instead of saying "You're all set."
6. Wait for **Coins received** and open **View transaction**. Give Codex the public
   transaction link/signature to verify the mint, receiver and wallet debit on-chain.
7. If the page says pending or uncertain, check that transaction before buying again.
   The browser remembers its signature and prevents a repeat buy while pending.
8. Sign out/in and confirm your wallet address and received coin balance persist.
   Ask the client to test a fresh X login too; an existing login does not verify that.

The published page was checked on desktop/mobile with the actual Privy X login
window: PumpKart branding, Twitter option, no page errors and no CSP violations.
The owner has now approved one real mainnet buy, verified above. New wallet signing
still requires the owner/client. Fresh client X login remains to test separately.
Quote speed varies with connection and Solana RPC;
transaction confirmation cannot be guaranteed instant.

## Then: paid tickets, races and withdrawals

Paid testing is now open after the successful coin buy and owner treasury top-up.
The player had **0.184364944 SOL** at the latest read; the payout treasury had
**0.085103838 SOL**. The paid-readiness check passed and reports no outstanding
pots, payouts or unused tickets at activation. Sponsored network fees are available.

Public treasury address:
`WXzD5Ph7zbaAebNXGxtG2QjbENeUuypNqnqkNsNFVHc`.
The owner selected this same address for `TEAM_WALLET`; it is now configured in
production, so the team's 5% remains in the treasury. A separate funded devnet
payout confirmed 80% to the winner, 15% burned, and exactly 5% retained with this
shared-wallet arrangement. The latest read-only `check` reports no open lobbies,
unresolved payouts or unused tickets. Its paid-readiness status is true.
Do not send wallet keys, recovery phrases or admin secrets in chat.

1. Treasury funding is complete and exceeds the 0.02 SOL starting reserve. Do not
   send another top-up just to repeat this step.
2. The small normal coin buy above is already completed and verified; do not repeat it
   just to recover its transaction link. Next verify wallet persistence after sign-out/in.
3. Full temporary-coin testing is already enabled. The activation used `pause`, a
   two-minute drain, then
   `prepare <TEST_CA> <TEST_TICKER> --test-paid` and `enable`. This keeps the test label.
   The server refuses enable if the payout wallet does not match the treasury, the
   team wallet is missing/invalid, funding is below 0.02 SOL, or the balance cannot be
   read. A reserve is a starting budget, not unlimited sponsored gas.
4. Open **https://www.pumpkart.racing/#/race** and refresh. Under **Race with friends**,
   the temporary-test form now defaults to **$0.01**, with small test presets. Check
   that amount, then click **Create $0.01 lobby**. Official-mode defaults and the
   $20 public ticket price are unchanged.
   Creating an invite is free. Share its link/code with four friends, approve the
   entry payment in Privy, close the wallet receipt and start your run. All five
   accounts pay the same locked coin amount. Use five real X accounts, then verify the
   public transaction links for the split, refund and withdrawal. Finish or refund
   all test pots and use/resolve leftover tickets before switching the official mint.

The owner supplied `RK5J6F78`. The authenticated operations check verified its
locked entry is **$5**, not the intended $0.01, with **zero payments and zero runs**.
The existing lobby price remains locked; use a new one-cent lobby for the test.
Its invite expires on the normal 30-minute schedule. The support command
`node scripts/coin-launch.mjs check <LOBBY_CODE>` reads the locked amount, seats,
payment signatures and payout/refund status without signing, submitting or settling.
It requires the existing operations secret; it does not bypass player authentication.

**First paid friend entry verified:** replacement lobby `6ANT7755` locks **$0.01**
to **4,222.972973 test $RACE** per player (`4222972973` raw units). The owner's
payment was credited and the lobby has one **Paid · ready** seat, with no run yet
at this check. Mainnet transaction
`3BQbYqKeH7q89HYDQuz7Hrgs2LxuDAJfGoEMseo8B25wfXN63DCtfmDzt3sUpZcJJ1t5pLo2HwDC3ce6b6AYtRyv`
succeeded: exactly those coins reached the treasury, the treasury paid **0.00001 SOL**
network fee, and player SOL debit was **zero**. Player test-coin balance afterwards:
**41,973.576738**. This verifies the sponsored entry/claim flow.

**First real paid run verified:** a later read-only server check recorded the owner's
**67.15-second** finish in `6ANT7755`, with `finished: true`, `racing: false` and no
replay rejection note. The lobby still has one participant and is open. Its normal
deadline is **2026-10-11 23:18:01 UTC / October 12, 00:18:01 Casablanca**. With fewer
than four participants, the expected outcome is a full **4,222.972973 test $RACE**
refund to the original payer, with no burn or team cut. The displayed first place and
potential prize are provisional, not a paid win. No refund transaction exists at
the 23:02 UTC check; automatic refund, withdrawal and multi-player mainnet settlement
still need on-chain confirmation. No settlement was forced or fake player added.

Use five real accounts in a low-entry friend lobby. All five must pay the same locked
coin amount chosen from the creator's USD entry. Verify each receipt, race submission,
80% winner payout, 15% burn, 5% team transfer, expiry refund and withdrawal on mainnet.
Public tickets stay $20; paid races have no bots. Claims, recovery, existing submissions
and withdrawals remain available through purchase pauses.

New purchase receipts belong to the signed-in account. A disconnected RPC or expired
login keeps the receipt for recovery; checkout checks it before charging again and
blocks overlapping payments in the tab. Older unscoped receipts remain recoverable.
Known sponsored signatures are returned even after an uncertain RPC broadcast.
Withdrawals show **Pending — do not send again** until confirmed; the next click checks
that same transaction. Retries unlock after historical status and finalized block height
prove a transaction expired without landing. An unavailable RPC does not clear it.

## Domain and login setup

The main domain is connected: `pumpkart.racing` redirects to `www.pumpkart.racing`.
Keep both HTTPS origins in Privy's Allowed Origins; an origin has no page path.
Keep the same Privy app to preserve wallets. X/Twitter is the login method.
Branding: name `PumpKart`, pink `#FF006E`, logo
`https://www.pumpkart.racing/pumpkart-logo.png`.
If using custom X credentials, its OAuth callback is
`https://auth.privy.io/api/v1/oauth/callback`. Enter credentials directly in Privy.
Automated site tests should use `https://solvnant.vercel.app` to avoid old-domain WAF limits.

## Official coin switch after the payment tests pass

Ask the client for the **official CA and ticker**. There is no automatic test-coin fallback.
The separate operations secret `COIN_ADMIN_KEY` belongs only in a trusted local process
environment. It is not a wallet key. Never print it, commit it or pass it as a command argument.
Set `PUMPKART_API_URL` to the existing Worker URL, then use:

```text
node scripts/coin-launch.mjs status
node scripts/coin-launch.mjs check
node scripts/coin-launch.mjs pause
# Allow at least two minutes for in-flight quotes/transactions to drain.
node scripts/coin-launch.mjs prepare <OFFICIAL_CA> <OFFICIAL_TICKER>
node scripts/coin-launch.mjs status
node scripts/coin-launch.mjs enable
```

For the current coin-only temporary test, preparation uses
`prepare <TEST_CA> <TEST_TICKER> --test`; this explicitly disables paid entries.
`--test-paid` selects test mode with paid races, subject to the treasury checks.
Preparing without a test flag selects official mode and paid readiness, so only do that
after the paid-flow release checks and treasury funding are satisfied.

Prepare verifies mint/freeze authorities, supported token extensions, pump.fun provenance,
SOL pairing, on-chain decimals and the canonical PumpSwap pool when graduated. It leaves
purchases paused. Enable verifies again and requires working USD pricing. Each operation
checks the launch revision again after asynchronous work and persists settings in SQLite.
A switch refuses open race pots, unresolved payouts or unused current-coin tickets.
Resolve those; never bypass the check to meet a launch deadline.

No frontend rebuild is needed to change the coin after this release. Open tabs refresh
configuration every 30 seconds and when returning to the tab. Coin quotes expire after
30 seconds before opening wallet approval; ticket quotes after two minutes. A signed
coin purchase uses actual transaction expiry and fresh cost/swap simulation. The server validates revision/mint before
approval and broadcasting. A transaction already broadcast cannot be undone by pausing.

Inspect a small approved official-coin transaction on-chain before announcing purchases.
The official client coin and the complete mainnet paid-flow checks are still pending.
The original noon launch target was a target, not an automatic scheduled deployment.

## Verification limits

183 regression tests in 26 files, TypeScript/build, Worker dry-run, mobile/desktop
browser fixtures and real unsigned PumpSwap simulation passed. The quote/fee review
took about 3 seconds in this local read-only browser check; it is not a promise of
transaction confirmation speed. The funded devnet round passed five $1.25 entries,
20-coin prize, 3.75-coin burn, 1.25-coin team share, full 2-coin refund and a sponsored
1-coin withdrawal. These are devnet test coins, not a mainnet payout result. Browser payment fixtures cannot authenticate as
the owner or prove that their actual Privy dialog opened. A funded devnet integration
round exercises ticket payments, racing, payout, burn, team split, refund and withdrawal;
it does not replace the approved mainnet checks above.
An additional opt-in funded devnet client test passed a late wallet Close after the
review quote expiry: valid signed simulation, one signature and one broadcast, exactly
10,000 lamports delivered. This tests the approval/broadcast lifecycle with a disposable
devnet SOL transfer; it is not a mainnet PumpSwap trade or owner-wallet signature.
