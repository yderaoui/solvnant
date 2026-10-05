// Integration tests for tracklab_pots on the local test validator (`anchor test`).
// TODO: security audit + legal review required before any real money / mainnet use.

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Keypair, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { expect } from "chai";
import idl from "../target/idl/tracklab_pots.json";
import type { TracklabPots } from "../target/types/tracklab_pots";
import * as pots from "../client/pots";

const FEE_BPS = 500; // 5%
const BPS = 10_000n;

describe("tracklab_pots", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = new Program(idl as TracklabPots, provider);
  const conn = provider.connection;
  const authority = provider.wallet.publicKey;
  const treasury = Keypair.generate();
  let nextRaceId = 1;

  // ---------- helpers ----------

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  async function chainTime(): Promise<number> {
    for (;;) {
      const slot = await conn.getSlot("confirmed");
      const t = await conn.getBlockTime(slot).catch(() => null);
      if (t !== null) return t;
      await sleep(200);
    }
  }

  async function waitUntilChainTime(ts: number) {
    while ((await chainTime()) < ts) await sleep(400);
  }

  async function airdrop(to: PublicKey, sol: number) {
    const sig = await conn.requestAirdrop(to, sol * LAMPORTS_PER_SOL);
    const bh = await conn.getLatestBlockhash();
    await conn.confirmTransaction({ signature: sig, ...bh }, "confirmed");
  }

  async function funded(sol = 20): Promise<Keypair> {
    const kp = Keypair.generate();
    await airdrop(kp.publicKey, sol);
    return kp;
  }

  const bal = async (pk: PublicKey) => BigInt(await conn.getBalance(pk, "confirmed"));

  async function expectFail(p: Promise<unknown>, code?: string) {
    let err: any = null;
    try {
      await p;
    } catch (e) {
      err = e;
    }
    expect(err, `expected failure${code ? " " + code : ""}`).to.not.equal(null);
    if (code) {
      const got = err?.error?.errorCode?.code ?? "";
      const text = `${got} ${err?.message ?? ""} ${(err?.logs ?? []).join("\n")}`;
      expect(text, `expected ${code}, got: ${text.slice(0, 400)}`).to.include(code);
    }
  }

  /** Creates a race whose betting closes `closeIn` seconds from chain time. */
  async function newRace(opts: { entryFee: bigint; closeIn?: number; maxPlayers?: number; seed?: string }) {
    const raceId = nextRaceId++;
    const seed = opts.seed ?? pots.randomSeed();
    const closeTs = (await chainTime()) + (opts.closeIn ?? 8);
    const { race, vault } = await pots.createRace(program, {
      raceId,
      seedHash: await pots.seedHash(seed),
      entryFeeLamports: opts.entryFee,
      betsCloseTs: closeTs,
      maxPlayers: opts.maxPlayers ?? 10,
    });
    return { raceId, seed, closeTs, race, vault };
  }

  async function slotOf(race: PublicKey, player: PublicKey): Promise<number> {
    const e = await program.account.entry.fetch(pots.entryPda(program.programId, race, player));
    return e.slot;
  }

  /** Lamports moved to `who` by `fn` (provider pays tx fees, so this is the exact payout). */
  async function delta(who: PublicKey, fn: () => Promise<unknown>): Promise<bigint> {
    const before = await bal(who);
    await fn();
    return (await bal(who)) - before;
  }

  const rentReserve = async () => BigInt(await conn.getMinimumBalanceForRentExemption(0));

  // ---------- setup ----------

  before(async () => {
    await airdrop(treasury.publicKey, 1); // treasury must be rent-exempt to receive small fees
    await pots.initializeConfig(program, {
      feeBps: FEE_BPS,
      treasury: treasury.publicKey,
      settleTimeoutSecs: 600,
      claimWindowSecs: 600,
    });
    const cfg = await program.account.config.fetch(pots.configPda(program.programId));
    expect(cfg.authority.toBase58()).to.equal(authority.toBase58());
    expect(cfg.feeBps).to.equal(FEE_BPS);
  });

  it("rejects a fee above 10% / a second config", async () => {
    await expectFail(
      pots.initializeConfig(program, {
        feeBps: 1001,
        treasury: treasury.publicKey,
        settleTimeoutSecs: 1,
        claimWindowSecs: 1,
      })
    );
  });

  it("happy path: 3 players + bettors, correct payouts, seed revealed, dust swept", async () => {
    const fee = BigInt(LAMPORTS_PER_SOL);
    const { raceId, seed, closeTs, race, vault } = await newRace({ entryFee: fee });
    const [p1, p2, p3, bA, bB, bC] = await Promise.all([...Array(6)].map(() => funded()));
    for (const p of [p1, p2, p3]) await pots.enterRace(program, raceId, p);
    const [s1, s2, s3] = [await slotOf(race, p1.publicKey), await slotOf(race, p2.publicKey), await slotOf(race, p3.publicKey)];
    expect([s1, s2, s3]).to.deep.equal([0, 1, 2]);

    // Finish order: p2 wins, p1 second, p3 third.
    const placings = [s2, s1, s3];
    const aAmt = 2n * BigInt(LAMPORTS_PER_SOL);
    const bAmt = 1n * BigInt(LAMPORTS_PER_SOL);
    const cAmt = 1n * BigInt(LAMPORTS_PER_SOL);
    await pots.placeBet(program, raceId, bA, s2, aAmt);
    await pots.placeBet(program, raceId, bB, s2, bAmt);
    await pots.placeBet(program, raceId, bC, s1, cAmt);

    let r = await pots.fetchRace(program, raceId);
    expect(r.numEntries).to.equal(3);
    expect(r.pickTotals[s2].toString()).to.equal((aAmt + bAmt).toString());
    expect(r.betTotal.toString()).to.equal((aAmt + bAmt + cAmt).toString());

    // Settling before close is rejected.
    await expectFail(pots.settleRace(program, { raceId, seed, placings }), "BettingStillOpen");
    await waitUntilChainTime(closeTs);

    const entryPot = 3n * fee;
    const betTotal = aAmt + bAmt + cAmt;
    const entryCut = (entryPot * BigInt(FEE_BPS)) / BPS;
    const betCut = (betTotal * BigInt(FEE_BPS)) / BPS;
    const treasuryGain = await delta(treasury.publicKey, () => pots.settleRace(program, { raceId, seed, placings }));
    expect(treasuryGain).to.equal(entryCut + betCut);

    r = await pots.fetchRace(program, raceId);
    expect(pots.statusOf(r)).to.equal("settled");
    expect(pots.revealedSeed(r)).to.equal(seed);
    expect(r.placings.slice(0, 3)).to.deep.equal(placings);

    const prizePool = entryPot - entryCut;
    const betPool = betTotal - betCut;
    expect(await delta(p2.publicKey, () => pots.claimPrize(program, raceId, p2))).to.equal((prizePool * 60n) / 100n);
    expect(await delta(p1.publicKey, () => pots.claimPrize(program, raceId, p1))).to.equal((prizePool * 30n) / 100n);
    expect(await delta(p3.publicKey, () => pots.claimPrize(program, raceId, p3))).to.equal((prizePool * 10n) / 100n);
    const winTotal = aAmt + bAmt;
    expect(await delta(bA.publicKey, () => pots.claimBet(program, raceId, bA, s2))).to.equal((betPool * aAmt) / winTotal);
    expect(await delta(bB.publicKey, () => pots.claimBet(program, raceId, bB, s2))).to.equal((betPool * bAmt) / winTotal);
    await expectFail(pots.claimBet(program, raceId, bC, s1), "NothingToClaim");

    r = await pots.fetchRace(program, raceId);
    expect(r.pendingClaims).to.equal(0);
    const reserve = await rentReserve();
    const vaultLeft = await bal(vault);
    expect(vaultLeft >= reserve).to.equal(true);

    expect(await delta(treasury.publicKey, () => pots.closeRace(program, raceId))).to.equal(vaultLeft);
    expect(await bal(vault)).to.equal(0n);
    r = await pots.fetchRace(program, raceId);
    expect(pots.statusOf(r)).to.equal("closed");
    // Seed stays readable after close for public verification.
    expect(pots.revealedSeed(r)).to.equal(seed);
  });

  it("rejects duplicate entries, full races and entering after close", async () => {
    const { raceId, closeTs } = await newRace({ entryFee: 1_000_000n, maxPlayers: 2, closeIn: 6 });
    const [a, b, c, d] = await Promise.all([...Array(4)].map(() => funded()));
    await pots.enterRace(program, raceId, a);
    await expectFail(pots.enterRace(program, raceId, a)); // Entry PDA already exists
    await pots.enterRace(program, raceId, b);
    await expectFail(pots.enterRace(program, raceId, c), "RaceFull");
    await waitUntilChainTime(closeTs);
    await expectFail(pots.enterRace(program, raceId, d), "EntriesClosed");
  });

  it("rejects a wrong seed at settle", async () => {
    const { raceId, seed, closeTs } = await newRace({ entryFee: 1_000_000n, closeIn: 5 });
    const p = await funded();
    await pots.enterRace(program, raceId, p);
    await waitUntilChainTime(closeTs);
    await expectFail(pots.settleRace(program, { raceId, seed: seed + "x", placings: [0] }), "SeedMismatch");
    await expectFail(pots.settleRace(program, { raceId, seed, placings: [0, 0] }), "InvalidPlacings");
    await pots.settleRace(program, { raceId, seed, placings: [0] });
    // Settling twice is rejected.
    await expectFail(pots.settleRace(program, { raceId, seed, placings: [0] }), "RaceNotOpen");
  });

  it("rejects settle from a non-authority signer", async () => {
    const { raceId, seed, closeTs, race, vault } = await newRace({ entryFee: 1_000_000n, closeIn: 5 });
    const p = await funded();
    await pots.enterRace(program, raceId, p);
    await waitUntilChainTime(closeTs);
    const attacker = await funded();
    await expectFail(
      program.methods
        .settleRace(pots.seedBytes(seed), Buffer.from([0]))
        .accountsStrict({
          config: pots.configPda(program.programId),
          race,
          vault,
          treasury: treasury.publicKey,
          authority: attacker.publicKey,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .signers([attacker])
        .rpc(),
      "Unauthorized"
    );
    // ...and a non-authority cannot create races either.
    const attackerProgram = new Program(
      idl as TracklabPots,
      new anchor.AnchorProvider(conn, new anchor.Wallet(attacker), {})
    );
    await expectFail(
      pots.createRace(attackerProgram, {
        raceId: 999_999,
        seedHash: await pots.seedHash("x"),
        entryFeeLamports: 1,
        betsCloseTs: (await chainTime()) + 60,
        maxPlayers: 3,
      }),
      "Unauthorized"
    );
    // Nor cancel before the settle deadline.
    await expectFail(pots.cancelRace(program, raceId, attacker), "Unauthorized");
  });

  it("rejects betting after close (and bets on empty slots / zero amounts)", async () => {
    const { raceId, closeTs } = await newRace({ entryFee: 1_000_000n, closeIn: 5 });
    const [p, bettor] = await Promise.all([funded(), funded()]);
    await pots.enterRace(program, raceId, p);
    await expectFail(pots.placeBet(program, raceId, bettor, 3, 1_000n), "InvalidPick");
    await expectFail(pots.placeBet(program, raceId, bettor, 0, 0n), "ZeroAmount");
    await waitUntilChainTime(closeTs);
    await expectFail(pots.placeBet(program, raceId, bettor, 0, 1_000n), "BettingClosed");
  });

  it("rejects double claims", async () => {
    const { raceId, seed, closeTs } = await newRace({ entryFee: 10_000_000n, closeIn: 6 });
    const [p, b] = await Promise.all([funded(), funded()]);
    await pots.enterRace(program, raceId, p);
    await pots.placeBet(program, raceId, b, 0, 5_000_000n);
    await waitUntilChainTime(closeTs);
    await pots.settleRace(program, { raceId, seed, placings: [0] });
    // Single entrant: renormalised to 100% of the prize pool.
    const prize = await delta(p.publicKey, () => pots.claimPrize(program, raceId, p));
    expect(prize).to.equal(10_000_000n - (10_000_000n * BigInt(FEE_BPS)) / BPS);
    await expectFail(pots.claimPrize(program, raceId, p), "AlreadyClaimed");
    await pots.claimBet(program, raceId, b, 0);
    await expectFail(pots.claimBet(program, raceId, b, 0), "AlreadyClaimed");
    // Refund instructions don't work on a settled race.
    await expectFail(pots.refundEntry(program, raceId, p), "RaceNotCancelled");
  });

  it("cancel + full refunds of entries and bets", async () => {
    const fee = 50_000_000n;
    const { raceId, vault } = await newRace({ entryFee: fee, closeIn: 30 });
    const [p1, p2, b] = await Promise.all([funded(), funded(), funded()]);
    await pots.enterRace(program, raceId, p1);
    await pots.enterRace(program, raceId, p2);
    await pots.placeBet(program, raceId, b, 1, 123_456_789n);
    // Claims aren't possible before settle.
    await expectFail(pots.claimPrize(program, raceId, p1), "RaceNotSettled");
    await pots.cancelRace(program, raceId); // authority, before close
    expect(pots.statusOf(await pots.fetchRace(program, raceId))).to.equal("cancelled");
    await expectFail(pots.closeRace(program, raceId), "ClaimsPending");

    expect(await delta(p1.publicKey, () => pots.refundEntry(program, raceId, p1))).to.equal(fee);
    expect(await delta(p2.publicKey, () => pots.refundEntry(program, raceId, p2))).to.equal(fee);
    expect(await delta(b.publicKey, () => pots.refundBet(program, raceId, b, 1))).to.equal(123_456_789n);
    await expectFail(pots.refundEntry(program, raceId, p1), "AlreadyClaimed");
    await expectFail(pots.claimPrize(program, raceId, p1), "RaceNotSettled");
    await expectFail(
      pots.settleRace(program, { raceId, seed: "whatever", placings: [0, 1] }),
      "RaceNotOpen"
    );

    expect(await bal(vault)).to.equal(await rentReserve());
    await pots.closeRace(program, raceId);
    expect(await bal(vault)).to.equal(0n);
  });

  it("refunds every bettor in full when nobody backed the winner", async () => {
    const { raceId, seed, closeTs } = await newRace({ entryFee: 1_000_000n, closeIn: 6 });
    const [p1, p2, b1, b2] = await Promise.all([...Array(4)].map(() => funded()));
    await pots.enterRace(program, raceId, p1);
    await pots.enterRace(program, raceId, p2);
    await pots.placeBet(program, raceId, b1, 0, 3_000_000n);
    await pots.placeBet(program, raceId, b2, 0, 4_000_001n);
    await waitUntilChainTime(closeTs);
    // Slot 1 wins, nobody bet on it. Only the entry pot pays a fee.
    const gain = await delta(treasury.publicKey, () =>
      pots.settleRace(program, { raceId, seed, placings: [1, 0] })
    );
    expect(gain).to.equal((2_000_000n * BigInt(FEE_BPS)) / BPS);
    const r = await pots.fetchRace(program, raceId);
    expect(r.betsRefunded).to.equal(true);
    expect(await delta(b1.publicKey, () => pots.claimBet(program, raceId, b1, 0))).to.equal(3_000_000n);
    expect(await delta(b2.publicKey, () => pots.claimBet(program, raceId, b2, 0))).to.equal(4_000_001n);
    // Two entrants: 60/30 renormalised to 2/3 and 1/3.
    const pool = 2_000_000n - gain;
    expect(await delta(p2.publicKey, () => pots.claimPrize(program, raceId, p2))).to.equal((pool * 60n) / 90n);
    expect(await delta(p1.publicKey, () => pots.claimPrize(program, raceId, p1))).to.equal((pool * 30n) / 90n);
  });

  it("rounding never overdraws the vault; every lamport is accounted for", async () => {
    const fee = 1_000_003n; // odd amounts everywhere to force rounding
    const { raceId, seed, closeTs, vault } = await newRace({ entryFee: fee, closeIn: 10 });
    const players = await Promise.all([...Array(4)].map(() => funded()));
    const bettors = await Promise.all([...Array(4)].map(() => funded()));
    for (const p of players) await pots.enterRace(program, raceId, p);
    const amounts = [7n, 11n, 13n, 1_000_000_007n];
    const picks = [2, 2, 2, 0];
    for (let i = 0; i < bettors.length; i++) {
      await pots.placeBet(program, raceId, bettors[i], picks[i], amounts[i]);
    }
    const reserve = await rentReserve();
    const vaultStart = await bal(vault);
    const totalIn = 4n * fee + amounts.reduce((a, b) => a + b, 0n);
    expect(vaultStart).to.equal(reserve + totalIn);

    await waitUntilChainTime(closeTs);
    const treasuryBefore = await bal(treasury.publicKey);
    await pots.settleRace(program, { raceId, seed, placings: [2, 3, 0, 1] });
    expect((await bal(vault)) >= reserve).to.equal(true);

    let paid = 0n;
    for (const p of [players[2], players[3], players[0]]) {
      paid += await delta(p.publicKey, () => pots.claimPrize(program, raceId, p));
      expect((await bal(vault)) >= reserve).to.equal(true);
    }
    await expectFail(pots.claimPrize(program, raceId, players[1]), "NothingToClaim"); // 4th place
    for (let i = 0; i < 3; i++) {
      paid += await delta(bettors[i].publicKey, () => pots.claimBet(program, raceId, bettors[i], 2));
      expect((await bal(vault)) >= reserve).to.equal(true);
    }
    await expectFail(pots.claimBet(program, raceId, bettors[3], 0), "NothingToClaim");

    await pots.closeRace(program, raceId);
    expect(await bal(vault)).to.equal(0n);
    const toTreasury = (await bal(treasury.publicKey)) - treasuryBefore;
    // Conservation: everything that came in went out to winners or the treasury (+ the reserve).
    expect(paid + toTreasury).to.equal(totalIn + reserve);
    // Payouts never exceed the pools.
    const entryPot = 4n * fee;
    const betTotal = amounts.reduce((a, b) => a + b, 0n);
    const prizePool = entryPot - (entryPot * BigInt(FEE_BPS)) / BPS;
    const betPool = betTotal - (betTotal * BigInt(FEE_BPS)) / BPS;
    expect(paid <= prizePool + betPool).to.equal(true);
  });

  it("lets anyone close a race only after claims are done", async () => {
    const { raceId, seed, closeTs } = await newRace({ entryFee: 2_000_000n, closeIn: 5 });
    const p = await funded();
    await pots.enterRace(program, raceId, p);
    await waitUntilChainTime(closeTs);
    await pots.settleRace(program, { raceId, seed, placings: [0] });
    await expectFail(pots.closeRace(program, raceId), "ClaimsPending");
    await pots.claimPrize(program, raceId, p);
    const stranger = await funded();
    const strangerProgram = new Program(
      idl as TracklabPots,
      new anchor.AnchorProvider(conn, new anchor.Wallet(stranger), {})
    );
    await pots.closeRace(strangerProgram, raceId);
    await expectFail(pots.claimPrize(program, raceId, p), "RaceNotSettled");
  });

  it("client refuses mainnet RPC URLs", () => {
    expect(() => pots.assertNotMainnet("https://api.mainnet-beta.solana.com")).to.throw(/devnet/);
    expect(() => pots.assertNotMainnet("https://api.devnet.solana.com")).to.not.throw();
  });
});

