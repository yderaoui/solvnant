# PumpKart launch and real website test

Main website: **https://www.pumpkart.racing**
Coin buying page: **https://www.pumpkart.racing/#/buy**

We are keeping **X login and Privy Solana wallets**. The separate private wallet
verification page is retired: its URL redirects to the normal Buy coins page and
its API returns HTTP 410. There is no free ownership-signature step before buying.

## First: coin buying only

The owner authorized the temporary `$RACE` mint:
`BJLoxTq2dkU46hXzL2UNjDPEHWs5ugKirFERYffpump`.
It is a mainnet coin, **not the official PumpKart coin**. It has graduated to
PumpSwap. Buying it spends real SOL. The website explicitly labels this test.

The release supports a persisted coin-only setting: `coinLaunch.mode: test`,
`paidEnabled: false`. While enabled, coin buying works and the server rejects new
paid ticket, cosmetic and friend-lobby payments/entries. Public configuration exposes
no fee sponsor in this stage. Practice and play-point modes remain available.
**Live activation verified on 2026-10-11:** `/api/config` reports status live,
buyEnabled true, mode test, paidEnabled false, sponsor null and the exact test mint.
Revision: `coin_1sF8rStR3xEUU7iV`. Worker: `38198075-7b27-4191-b31d-67a21313afd6`.
Changing client copy alone does not open payments.

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
6. Wait for **Coins received** and open **View transaction**. Give Codex the public
   transaction link/signature to verify the mint, receiver and wallet debit on-chain.
7. If the page says pending or uncertain, check that transaction before buying again.
   The browser remembers its signature and prevents a repeat buy while pending.
8. Sign out/in and confirm your wallet address and received coin balance persist.
   Ask the client to test a fresh X login too; an existing login does not verify that.

The published page was checked on desktop/mobile with the actual Privy X login
window: PumpKart branding, Twitter option, no page errors and no CSP violations.
This verifies that the window opens; completing X OAuth and signing a purchase still
require the owner/client. No authenticated owner mainnet buy has been completed by Codex. Wallet signing must
be approved by the owner/client. Quote speed varies with connection and Solana RPC;
transaction confirmation cannot be guaranteed instant.

## Then: paid tickets, races and withdrawals

Paid races remain closed for this first test. The player had **0.188229983 SOL**
at the latest read; the payout treasury had **0.00089088 SOL**.
The owner chose coin buying first instead of funding the treasury now.

For the next stage, fund the treasury's network/account-setup budget and have Codex
verify the balance before explicitly opening paid tests. Public treasury address:
`WXzD5Ph7zbaAebNXGxtG2QjbENeUuypNqnqkNsNFVHc`.
Do not send wallet keys, recovery phrases or admin secrets in chat.

Use five real accounts in a low-entry friend lobby. All five must pay the same locked
coin amount chosen from the creator's USD entry. Verify each receipt, race submission,
80% winner payout, 15% burn, 5% team transfer, expiry refund and withdrawal on mainnet.
Public tickets stay $20; paid races have no bots. Claims, recovery, existing submissions
and withdrawals remain available through purchase pauses.

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
node scripts/coin-launch.mjs pause
# Allow at least two minutes for in-flight quotes/transactions to drain.
node scripts/coin-launch.mjs prepare <OFFICIAL_CA> <OFFICIAL_TICKER>
node scripts/coin-launch.mjs status
node scripts/coin-launch.mjs enable
```

For the current coin-only temporary test, preparation uses
`prepare <TEST_CA> <TEST_TICKER> --test`; this explicitly disables paid entries.
Preparing without `--test` selects official mode and paid readiness, so only do that
after the paid-flow release checks and treasury funding are satisfied.

Prepare verifies mint/freeze authorities, supported token extensions, pump.fun provenance,
SOL pairing, on-chain decimals and the canonical PumpSwap pool when graduated. It leaves
purchases paused. Enable verifies again and requires working USD pricing. Each operation
checks the launch revision again after asynchronous work and persists settings in SQLite.
A switch refuses open race pots, unresolved payouts or unused current-coin tickets.
Resolve those; never bypass the check to meet a launch deadline.

No frontend rebuild is needed to change the coin after this release. Open tabs refresh
configuration every 30 seconds and when returning to the tab. Coin quotes expire after
30 seconds; ticket quotes after two minutes. The server validates revision/mint before
approval and broadcasting. A transaction already broadcast cannot be undone by pausing.

Inspect a small approved official-coin transaction on-chain before announcing purchases.
The official client coin and the complete mainnet paid-flow checks are still pending.
The original noon launch target was a target, not an automatic scheduled deployment.

## Verification limits

141 regression tests in 22 files, TypeScript/build, Worker dry-run, mobile/desktop
browser fixtures and real unsigned PumpSwap simulation passed. The quote/fee review
took about 3 seconds in this local read-only browser check; it is not a promise of
transaction confirmation speed. The funded devnet round passed five $1.25 entries,
20-coin prize, 3.75-coin burn, 1.25-coin team share, full 2-coin refund and a sponsored
1-coin withdrawal. These are devnet test coins, not a mainnet payout result. Browser payment fixtures cannot authenticate as
the owner or prove that their actual Privy dialog opened. A funded devnet integration
round exercises ticket payments, racing, payout, burn, team split, refund and withdrawal;
it does not replace the approved mainnet checks above.
