+# PumpKart — current launch steps

Website: **https://www.pumpkart.racing**

Buy coins: **https://www.pumpkart.racing/#/buy**

**Ready for client testing with the temporary coin. The official public coin launch still needs the final coin details and wallet-operated release checks.**

The unattended October 12 audit passed 214 regression tests, the production build, all 15 character checks, nine production pages, browser failure recovery, funded devnet payments/settlement/refunds/withdrawals and mainnet receipt rechecks. See [LAUNCH_READINESS.md](LAUNCH_READINESS.md) for evidence and limits.

## Already completed — do not repeat old payments

- The owner's mainnet purchase delivered **46,196.549711 test $RACE**.
- Their sponsored one-cent friend entry and real 67.15-second run were accepted.
- The expired solo friend lobby automatically returned **4,222.972973 coins**.
- Their successful withdrawal delivered **196 coins** to the treasury destination.
- Buy/refund/withdrawal receipts remain finalized. Earlier two-coin withdrawal attempts did not land and are history.
- Final operations inspection: healthy maintenance, funded sponsorship, **zero open paid lobbies, unresolved payouts and unused tickets**.

Public receipts: [purchase](https://solscan.io/tx/3jvxAE6KE8ZiythF7qhDnmjHc4B9D79zoFWMa9G8nvctN8FrLNofvcgjkW6wr7coCLeNM2155DDvSsr7S7o99zC7), [full refund](https://solscan.io/tx/kvTJuC76yyd3mwsX4cFCB6haCGhjW7R6YhwvpE2zTWAmj3NQueNpXByN1hXVVUGMDHJ25ofEtyFAUYeAG8enTsD), [196-coin withdrawal](https://solscan.io/tx/4LzbpKHVSRHXVxTWYPqVscL9bidpise9HC1fbk4br84EtowkTww2s1xvAW5ah19HzTftNVP5mPtr1J7gxvmt6gZD).

## What stays configured

- **X login and the existing Privy app/wallets** remain in place.
- `pumpkart.racing` redirects to `www.pumpkart.racing`.
- Privy branding: PumpKart, `#FF006E`, logo `https://www.pumpkart.racing/pumpkart-logo.png`.
- Treasury **and recipient of the 5% team share** remain:
  `WXzD5Ph7zbaAebNXGxtG2QjbENeUuypNqnqkNsNFVHc`.
- Public tickets cost **$20 USD**, paid in the coin. Paid characters cost five tickets / $100; Orangie is free.
- Paid races use real players and ghost runs; **80% winner / 15% burn / 5% team**.
- Insufficient-player ordinary races return the ticket; custom friend lobbies refund the original entry coins.
- Practice and play-point modes are separate from paid coin entry.

The current **temporary mainnet test coin** is:

`BJLoxTq2dkU46hXzL2UNjDPEHWs5ugKirFERYffpump` — `$RACE`

Mode is `test`; buying and paid testing are enabled and spend real SOL. This is **not the official PumpKart coin**. The retired private-check URL redirects to Buy coins; its API returns 410.

## Final official-launch sequence

1. Obtain the client's **official Solana CA and ticker**, plus the public coin name and pump.fun link for website branding. No new team wallet is needed.
2. Inspect outstanding obligations again. Temporary-coin pots must settle/refund and unused tickets must be resolved before changing mints.
3. Pause new purchases, allow **at least two minutes** for in-flight quotes/transactions to drain, then prepare the official mint. Preparation verifies the mint, token program/extensions, decimals, authorities, pump.fun provenance and swap route. Purchases stay paused.
4. Publish the requested official CA on the homepage with Copy, Solscan and pump.fun links, using the verified real mint.
5. Enable after the official mint, live price, payout signer, team destination and treasury reserve checks pass. Runtime coin switching needs no frontend rebuild; open tabs refresh config every 30 seconds/on focus.
6. Complete fresh client X login. Sign out/in and confirm the same embedded wallet, balances and owned characters persist.
7. Approve one small official-coin purchase in the normal Buy coins screen and verify its exact public receipt.
8. Complete a low-entry real multi-user mainnet race and verify winner payout, burn and team share on-chain. Five finished players settle immediately; four can settle after the normal deadline. Funded devnet settlement does not replace this mainnet check.
9. Announce the official launch after those checks pass.

The operator uses the existing separate admin credential inside a trusted local process. It is not a wallet key; do not print it or put it in command arguments. With `PUMPKART_API_URL` and `COIN_ADMIN_KEY` configured:

```text
node scripts/coin-launch.mjs status
node scripts/coin-launch.mjs check
node scripts/coin-launch.mjs pause
# Wait at least 120 seconds.
node scripts/coin-launch.mjs prepare <OFFICIAL_CA> <OFFICIAL_TICKER>
node scripts/coin-launch.mjs check
node scripts/coin-launch.mjs enable
```

Preparation refuses unresolved obligations. Do not bypass this check. A purchase pause cannot undo a transaction already broadcast.

## Wallet confirmations

Review the coin, recipient and spending amount before approval. **Click Close in Privy after signing** so its SDK returns the transaction to PumpKart. Signing alone is not the final website confirmation.

For a pending purchase or withdrawal, use its saved receipt/check action. Do not clear storage or approve a replacement while the original transaction is uncertain. The site retains its signature; retry unlocks only after confirmed failure or proven expiry.

Confirmation time varies with the network. Unsigned purchase review took 2.38 seconds in this audit; this is not a guarantee of instant settlement.

[COIN_LAUNCH_HISTORY.md](COIN_LAUNCH_HISTORY.md) preserves historical setup and intermediate investigations. It does not describe additional payments to make now.
