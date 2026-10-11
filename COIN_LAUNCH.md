# PumpKart coin launch

The frontend is pushed to GitHub and live on `https://www.pumpkart.racing`.
The updated Cloudflare game server has not been deployed, and no real coin buys have been tested.
Do the advance setup before announcing the coin. Never put wallet keys or operations secrets in chat or git.

**Launch target: Sunday, 11 October 2026 at 12:00 noon, Africa/Casablanca.**
This is a target, not an automatic scheduled deployment. Real X/Privy login,
temporary-coin testing and official-coin verification remain outstanding. Paid buying can
open only after the release checks pass; the site can be released with buying paused.

**Domain connected: `pumpkart.racing` (Cloudflare).** Main address: `https://www.pumpkart.racing`.
Worker site settings are prepared for it; the Solana RPC browser-origin allowlist is published.
The Worker update still needs deployment. The owner attached both hostnames to Vercel
and configured Cloudflare DNS; Vercel now shows Valid Configuration for both. Apex redirects
to `www` (308), which serves Production. The owner has added both PumpKart HTTPS origins
in Privy's Allowed Origins list. Confirm saving if prompted; real login/wallet checks
remain outstanding. The owner has applied the pink color and new PNG logo in Privy's
UI components → Branding. Final name casing should be `PumpKart`.
`https://www.pumpkart.racing/pumpkart-logo.png` is published and returns HTTP 200.
The frontend also uses the PumpKart logo and `Sign in to PumpKart` header.
The owner reached the signed-in account menu with X, but wallet-address visibility and
the same address after signing out/in are not yet confirmed. The old `$RACE` symbol
still comes from server settings; do not treat it as the official PumpKart coin.

## Simple checklist for the owner

We are keeping **X login and Privy Solana wallets**. The code already includes them;
their dashboard settings and real login still need checking on the new domain.

1. **Domain connected (completed).** In Vercel, open the existing `solvnant`
   project, then Settings → Domains. Add `pumpkart.racing` and `www.pumpkart.racing`. Copy the DNS
   records Vercel shows into your domain provider, and wait for verification. Codex updates
   the game's site address. [Vercel domain instructions](https://vercel.com/docs/domains/working-with-domains/add-a-domain).
2. **Open the existing Privy app.** Go to Configuration → App settings → Domains.
   Add `https://pumpkart.racing`, `https://www.pumpkart.racing`, and the exact private test URL
   supplied by Codex under Allowed Origins. Keep the existing app so existing users retain
   their wallets. [Privy domain instructions](https://docs.privy.io/recipes/react/allowed-domains).
3. **Check X login.** In Privy, open Login Methods → Socials and enable X/Twitter.
   If using custom X credentials, configure the X developer app as an OAuth 2.0 confidential
   web app and use `https://auth.privy.io/api/v1/oauth/callback` as its callback URL.
   Enter its Client ID and Client Secret directly into Privy's X settings, never chat.
   Existing working credentials can stay. [Privy X instructions](https://docs.privy.io/basics/get-started/dashboard/configure-login-methods).
4. **Publish the private test version with Codex.** Keep GitHub, Vercel and Cloudflare
   available on this computer. Codex prepares a separate test site/server and deploys the
   current changes. Public coin buying stays paused; the temporary coin is used only in testing.
   This setup and deployment have not yet been done.
5. **Supply a temporary pump.fun coin's CA.** Codex verifies compatibility first.
   Agree a small real-SOL test budget, then fund disposable test wallets. The game wallet
   and house fee wallet both need funding for their respective operations; Codex checks this.
6. **Test as players.** Sign in with X, confirm the Solana wallet appears, sign out/in and
   confirm the same address. Fund it with SOL, buy the temporary coin, create a low-entry
   friend lobby, invite four other accounts, and have all five pay the same entry and drive.
   Codex verifies prize/burn/team transfers, refunds, withdrawals and wrong/stale-coin locks.
   Also check free practice, Live points, garage, both tracks, laps, finish flags, celebration,
   mobile layouts and refresh/reconnection. Only a completed test earns a pass.
7. **Then ask the client to create the official coin.** Get the official CA and ticker;
   wait to announce public buying until the official-coin checks pass.
8. **Launch with Codex.** Deploy the updated site and Worker together while purchases
   are paused. Resolve any old paid races, payouts and unused tickets. Prepare and verify
   the official CA using the procedure below, then complete a small approved official-coin
   purchase/race/payout/withdrawal check before opening buying to players. The temporary
   coin's test database is not copied into production.

**Next: confirm the wallet address, then deploy the updated Worker with buying paused.** No passwords, wallet keys
or account secrets are needed in chat.

## Advance setup

1. Test the launch lock, stale quotes, sponsored ticket purchases, recovery and paid races on devnet.
   The automated tests use fixture tickets and mocked RPC; they do not substitute for funded devnet testing.
2. Set a separate, randomly generated operations secret using `npx wrangler secret put COIN_ADMIN_KEY`.
   This is NOT a wallet private key. Keep the same operations secret only in a trusted local process environment.
3. Deploy the updated Worker and frontend ahead of launch. New purchases default to paused.
   Existing race submissions, payment claims/recovery and withdrawals are not disabled by the lock.
4. Check `/api/config` reports `coinLaunch.status: paused`. Use `solvnant.vercel.app` for automated site checks.
5. Confirm the prelaunch screen and lock on both a fresh browser and an old tab. Old frontend purchase requests
   without a coin revision must get HTTP 409; the server must not issue an old-coin intent or sponsor it.

No new browser API origin is added: the official Pump SDKs use the existing Solana RPC proxy.
The proxy now permits the read-only `getMultipleAccounts` method used by the SDK.

## When the owner supplies the CA

Set `PUMPKART_API_URL` to the Worker URL and `COIN_ADMIN_KEY` in the trusted process environment.
The CLI reads the secret from that environment; never pass it as a command argument.

```text
node scripts/coin-launch.mjs status
node scripts/coin-launch.mjs pause
# Wait at least two minutes for quotes / in-flight transactions to drain.
node scripts/coin-launch.mjs prepare <OFFICIAL_CA> <OFFICIAL_TICKER>
node scripts/coin-launch.mjs status
node scripts/coin-launch.mjs enable
```

Preparation verifies the mint on the configured network, mint/freeze authorities, supported token extensions,
the pump.fun bonding curve, SOL pairing, supported mode and (if graduated) the canonical PumpSwap pool.
It derives decimals on-chain. It changes only the coin identity; the treasury, USD ticket price and prize rules
stay in server settings. Mint, symbol, decimals and launch revision are saved together in the Hub's SQLite store.
Preparation keeps buying paused. Enabling verifies the coin again and requires a working USD price.
Both operations check the revision again after asynchronous verification, so they cannot overwrite a concurrent pause.

No site rebuild/deploy is needed for subsequent coin activation. Public configuration is uncached; current frontend
tabs refresh it every 30 seconds and on returning to the tab. Buy quotes expire after 30 seconds. Ticket quotes
expire after two minutes and are bound to the launch revision; pause, prepare and enable each invalidate old quotes.
Checks occur before wallet approval and before broadcast for game-wallet coin buys; sponsored ticket payments
are checked again at the server. A purchase already broadcast on Solana cannot be cancelled by this lock.

The server refuses a switch with open race pots, unresolved payouts or unused current-coin tickets. Resolve those
first; do not bypass this check to meet an announcement deadline. An old noncurrent-coin ledger is not converted.
Stored launch settings are network-bound and survive Worker restarts and later code deployments.

Fresh bonding-curve coins can use on-chain reserve pricing multiplied by a verified SOL/USD price before token
indexers catch up. Indexed pricing still uses the existing market sources. Graduated coins need indexed pricing;
if no trustworthy price is available, leave buying paused. There is no test-coin fallback in the launch flow.

## Final release check

After devnet payment checks pass and the CA is verified, do one explicitly approved small mainnet coin purchase,
ticket purchase and test race/payout check before telling players to buy. Inspect the mint and receiving wallet
on-chain. If any check fails, run `pause` and investigate. The first mainnet activation is conditional on this check;
do not promise the estimated 10–20 minute switch time as a guarantee.

The new SOL purchase page uses the official `@pump-fun/pump-sdk` and `@pump-fun/pump-swap-sdk`, asks for explicit
approval, and sends coins to the signed-in game wallet. It handles confirmation uncertainty by retaining the
transaction signature and blocking another buy while that transaction is pending. It does not sponsor coin
swap fees, purchase tickets automatically, offer card funding or support USDC-paired launches.

Sources: https://github.com/pump-fun/pump-public-docs and the installed official SDK source/type declarations.
