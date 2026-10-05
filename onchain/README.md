# TrackLab prize pots (Solana, devnet only)

> **TODO: security audit + legal review required before any real money / mainnet use.**
> This program is unaudited and is configured for **localnet and devnet only**. Prize pools and
> spectator betting with real value are regulated (gambling / sweepstakes / money-transmission
> rules) in many jurisdictions. Do not add a mainnet cluster, do not point the client at a
> mainnet RPC (the client and demo script refuse to), and do not take real money with it.

An Anchor program (`programs/tracklab_pots`) that holds native SOL for TrackLab races:

- **Entry pot**: players pay `entry_fee` to enter; after the race the pot (minus `fee_bps`) is
  split **60 / 30 / 10** between P1 / P2 / P3. With fewer than 3 entrants the weights are
  renormalised over those present (1 entrant: 100%; 2 entrants: 60/90 and 30/90).
- **Spectator bet pool** (parimutuel): spectators bet on which entry slot wins. Winners split
  the pool (minus `fee_bps`) pro rata to their stake. If **nobody backed the winner**, every bet
  is refunded in full and no bet fee is charged.
- **Commit-reveal seed**: the race seed is committed as `sha256(seed)` before anyone pays in and
  revealed (and checked) at settlement.

All funds sit in a per-race **vault PDA** (`[b"vault", race]`, a system-owned account) that only
the program can sign for.

## Accounts and instructions

| PDA | Seeds | Holds |
| --- | --- | --- |
| `Config` | `["config"]` | authority (game server / oracle key), treasury, fee_bps (<= 1000), settle timeout, claim window |
| `Race` | `["race", race_id u64 LE]` | seed_hash, revealed seed, entry fee, close time, entry count, placings, per-pick bet totals (max 10 entries), pools, status `Open / Settled / Cancelled / Closed` |
| vault | `["vault", race]` | the lamports (+ a rent-exempt reserve funded by the authority) |
| `Entry` | `["entry", race, player]` | slot index, claimed flag |
| `Bet` | `["bet", race, bettor, pick]` | pick, amount, claimed flag |

| Instruction | Who | What |
| --- | --- | --- |
| `initialize_config(fee_bps, treasury, settle_timeout_secs, claim_window_secs)` | signer becomes authority | once per deployment |
| `create_race(race_id, seed_hash, entry_fee, bets_close_ts, max_players)` | authority | opens a race, funds the vault's rent reserve |
| `enter_race()` | player | pays entry fee, gets the next slot. Rejected when full, after close, or duplicate |
| `place_bet(pick, amount)` | anyone | bets on an entered slot before `bets_close_ts` (one bet per bettor per pick) |
| `settle_race(seed, placings)` | authority, after close | checks `sha256(seed) == seed_hash`, checks placings is a permutation of the entry slots, stores both, sends fees to the treasury |
| `claim_prize()` | entrant | pays the entrant's placing share (top 3) |
| `claim_bet()` | bettor | pro-rata winnings, or a full refund if nobody backed the winner |
| `cancel_race()` | authority before settle; **anyone** once `bets_close_ts + settle_timeout_secs` has passed | opens refunds |
| `refund_entry()` / `refund_bet()` | entrant / bettor | full refund on a cancelled race |
| `close_race()` | anyone | once every claim/refund is done, or the claim window has expired: sweeps what's left (rounding dust, rent reserve, unclaimed funds) to the treasury. The `Race` account itself is kept so the seed and placings stay public |

The task spec described a single `claim()` and `refund()`. They are split into
`claim_prize`/`claim_bet` and `refund_entry`/`refund_bet` so each instruction has a fixed
account list. The behaviour is the same.

### Money safety

- All arithmetic uses `checked_*` / u128 `mul_div`. Every payout is rounded **down**, so the sum
  of payouts can never exceed a pool.
- Every transfer out of the vault goes through `pay_from_vault`, which refuses to take the vault
  below its rent reserve (`VaultInsufficient`). Rounding can't overdraw a vault.
- Each Entry/Bet has a `claimed` flag, so a second claim fails with `AlreadyClaimed`.
- `pending_claims` counts the claims still owed. `close_race` needs it to be 0, or the claim window
  to have expired.
- The authority and treasury are copied onto each race when it's created. Settle checks
  `config.authority`, `race.authority` and the treasury address.
- Time checks use the on-chain `Clock`.

## Commit-reveal with the game

The race sim is deterministic: the same seed, the same driver code and the same `SIM_VERSION`
give the same race, bit for bit (see `src/sim/race.ts`). The pots use that:

1. **Before the race**, the game server picks a secret, unguessable seed (`randomSeed()` gives
   32 random bytes as hex). It calls `create_race` with `seed_hash = sha256(utf8(seed))`. That
   hash is public from the moment entries and bets open.
2. Players enter and spectators bet. Nobody knows the seed, so nobody can run the race ahead of
   time. The server can't switch to a seed it likes better later, because the hash is already
   fixed on-chain.
3. After `bets_close_ts` the server runs the race and calls `settle_race(seed, placings)`. The
   program rejects any seed whose sha256 doesn't match the commitment, and stores the revealed
   seed on the `Race` account.
4. **Anyone can verify** the result. They read `seed` from the Race account (`revealedSeed()` in
   the client), take the published driver code (plus the input log, if there is one), re-run the
   sim and compare its finishing order with the stored `placings`.

Placings are entry **slot indices** (slot = order of `enter_race`), with `placings[0]` the
winner. The game server must map its grid/driver ids to these slots.

The chain does not check placings against the sim. It only proves that the seed wasn't changed
and makes cheating publicly detectable. See *Known limitations*.

## Layout

```
onchain/
  Anchor.toml                      # localnet + devnet only
  programs/tracklab_pots/src/lib.rs
  tests/tracklab_pots.ts           # mocha/chai integration tests (anchor test)
  client/pots.ts                   # helpers for the game server (createRace, settleRace, ...)
  scripts/devnet-demo.ts           # full demo round on devnet with explorer links
```

`@coral-xyz/anchor` and `@solana/web3.js` are devDependencies of `onchain/package.json` only.
The root app does not depend on them.

## Toolchain (all free)

The versions CI uses are pinned in `.github/workflows/onchain.yml`:

| Tool | Version |
| --- | --- |
| Rust | 1.89.0 |
| Solana CLI (Anza / Agave) | v2.3.13 |
| Anchor CLI / anchor-lang / @coral-xyz/anchor | 0.32.1 |
| Node | 22 |

On Windows, use WSL2 (Ubuntu). Native Windows isn't supported by the Solana test validator.

```bash
# Rust
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
# Solana CLI
sh -c "$(curl -sSfL https://release.anza.xyz/v2.3.13/install)"
# Anchor (avm), then pick the pinned version
cargo install --git https://github.com/solana-foundation/anchor avm --force
avm install 0.32.1 && avm use 0.32.1
```

## Build and test (local validator)

```bash
cd onchain
npm install
solana-keygen new -o ~/.config/solana/id.json   # local throwaway wallet, if you have none
anchor build
anchor keys sync     # first time only: points declare_id!/Anchor.toml at YOUR program keypair
anchor build
anchor test          # starts solana-test-validator, deploys, runs tests/tracklab_pots.ts
```

### Program keypair / program ID

The committed program ID is `H452aBP2P7wuibVHcAZC36XV8obN85UAwwKTNvomygWe`. Its keypair is
**not** committed: `*-keypair.json` and `target/` are gitignored. `anchor build` generates
`target/deploy/tracklab_pots-keypair.json` on a fresh checkout, and `anchor keys sync` rewrites
`declare_id!` and `Anchor.toml` to match it. Don't commit the result unless you mean to change
the canonical devnet ID. CI does the same with a throwaway keypair on every run.

## Deploy to devnet (free)

```bash
solana config set --url https://api.devnet.solana.com
solana-keygen new -o ~/.config/solana/devnet-authority.json
solana airdrop 2 ~/.config/solana/devnet-authority.json   # or https://faucet.solana.com
# Deploying needs roughly 2-3 devnet SOL for program rent; airdrop a few times if needed.
anchor deploy --provider.cluster devnet --provider.wallet ~/.config/solana/devnet-authority.json

# Full demo round: airdrop, init config, create, 3 entries, 1 bet, settle, claims, close.
AUTHORITY_KEYPAIR=~/.config/solana/devnet-authority.json \
RPC_URL=https://api.devnet.solana.com \
npm run demo:devnet
```

The demo prints `https://explorer.solana.com/...?cluster=devnet` links for every transaction.
It refuses to run if `RPC_URL` contains `mainnet`, or if the URL is anything other than devnet or
localhost.

## Using it from the game server

```ts
import * as pots from "../onchain/client/pots";
const seed = pots.randomSeed();                       // keep secret until settle
await pots.createRace(program, { raceId, seedHash: await pots.seedHash(seed),
  entryFeeLamports, betsCloseTs, maxPlayers });
// ... race runs with `seed` after bets close ...
await pots.settleRace(program, { raceId, seed, placings }); // placings = slot indices, winner first
```

`seedHash` uses WebCrypto, so it works in Node 18+ and in Cloudflare Workers. The Anchor client
itself is meant for a Node process (scheduler/server). Running it inside the Worker hasn't been
evaluated.

## Known limitations / risks

- **Unaudited.** No formal review, no fuzzing, no third-party audit. See the TODO at the top.
- **Trusted oracle for placings.** The authority reports the placings. Commit-reveal stops it
  from changing the seed, and anyone can detect wrong placings by re-running the sim, but there is
  no on-chain dispute or slashing mechanism. A malicious authority can still settle with false
  placings (detectable, not preventable), or refuse to settle (then anyone can `cancel_race`
  after the settle timeout and everyone is refunded).
- **The seed must be unguessable.** A short or predictable seed can be brute-forced from its
  hash before bets close. Always use `randomSeed()` (256 bits).
- **Driver code must be fixed before bets close.** Otherwise the outcome can be steered after the
  seed is known. The game server is responsible for this (publish a hash of each driver's code /
  input log too, ideally).
- **`initialize_config` is first-come.** Whoever calls it first after deploy becomes the
  authority. Call it right after deploying, or extend it to check the program's upgrade
  authority.
- No `update_config`: rotating the authority, treasury or fee needs a program upgrade (or a new
  instruction).
- One bet per (bettor, pick). Adding to a bet means another wallet or a future `init_if_needed`
  change.
- Entry/Bet accounts are not closed after claiming, so players don't get their account rent back
  (~0.001 SOL each).
- The treasury must already be a rent-exempt account, or small fee transfers to it will fail.
- Entrants placed 4th or lower have nothing to claim (`NothingToClaim`), and neither do losing
  bettors.
- Unclaimed winnings go to the treasury once the claim window expires and someone calls
  `close_race`.
- Max 10 entries per race. Seeds are at most 64 bytes.
