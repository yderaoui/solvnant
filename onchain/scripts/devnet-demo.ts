// Full demo round of the TrackLab pots program on Solana DEVNET.
//
// TODO: security audit + legal review required before any real money / mainnet use.
//
// Usage (after `anchor build` and `anchor deploy --provider.cluster devnet`):
//   AUTHORITY_KEYPAIR=~/.config/solana/devnet-authority.json \
//   RPC_URL=https://api.devnet.solana.com \
//   npx ts-node scripts/devnet-demo.ts
//
// The authority pays for everything (players/bettors are funded from it), so ~0.5 devnet SOL
// is enough. If the airdrop is rate-limited, use https://faucet.solana.com.

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import * as fs from "fs";
import * as os from "os";
import idl from "../target/idl/tracklab_pots.json";
import type { TracklabPots } from "../target/types/tracklab_pots";
import * as pots from "../client/pots";

const RPC_URL = process.env.RPC_URL ?? "https://api.devnet.solana.com";
const KEYPAIR_PATH = (process.env.AUTHORITY_KEYPAIR ?? "~/.config/solana/id.json").replace(
  /^~/,
  os.homedir()
);

function log(label: string, sig: string) {
  console.log(`${label.padEnd(22)} ${pots.explorerTx(sig)}`);
}

async function main() {
  pots.assertNotMainnet(RPC_URL); // hard stop: devnet/localnet only
  if (!/devnet|localhost|127\.0\.0\.1/.test(RPC_URL)) {
    throw new Error(`RPC_URL must be devnet or localhost, got ${RPC_URL}`);
  }

  const authority = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(KEYPAIR_PATH, "utf8")))
  );
  const conn = new Connection(RPC_URL, "confirmed");
  const provider = new anchor.AnchorProvider(conn, new anchor.Wallet(authority), {
    commitment: "confirmed",
  });
  const program = new Program(idl as TracklabPots, provider);
  console.log(`program   ${pots.explorerAddress(program.programId)}`);
  console.log(`authority ${pots.explorerAddress(authority.publicKey)}`);

  // 1. Airdrop if low.
  if ((await conn.getBalance(authority.publicKey)) < 0.5 * LAMPORTS_PER_SOL) {
    try {
      const sig = await conn.requestAirdrop(authority.publicKey, 1 * LAMPORTS_PER_SOL);
      await conn.confirmTransaction(sig, "confirmed");
      log("airdrop", sig);
    } catch (e) {
      console.warn("airdrop failed (rate limited?) - fund the authority via https://faucet.solana.com");
      throw e;
    }
  }

  // 2. Config (once per deployment). For the demo the authority is also the treasury.
  const configPk = pots.configPda(program.programId);
  if (!(await conn.getAccountInfo(configPk))) {
    log(
      "initialize_config",
      await pots.initializeConfig(program, {
        feeBps: 500,
        treasury: authority.publicKey,
        settleTimeoutSecs: 3600,
        claimWindowSecs: 7 * 24 * 3600,
      })
    );
  }
  const cfg = await program.account.config.fetch(configPk);
  if (!cfg.authority.equals(authority.publicKey)) {
    throw new Error(`config authority is ${cfg.authority.toBase58()}, not this keypair`);
  }

  // 3. Fund 3 players + 1 bettor from the authority (avoids airdrop rate limits).
  const players = [Keypair.generate(), Keypair.generate(), Keypair.generate()];
  const bettor = Keypair.generate();
  const fundTx = new Transaction();
  for (const kp of [...players, bettor]) {
    fundTx.add(
      SystemProgram.transfer({
        fromPubkey: authority.publicKey,
        toPubkey: kp.publicKey,
        lamports: 0.05 * LAMPORTS_PER_SOL,
      })
    );
  }
  log("fund players", await sendAndConfirmTransaction(conn, fundTx, [authority]));

  // 4. Create race: commit to sha256(seed) now, keep the seed secret until settle.
  const raceId = BigInt(Date.now());
  const seed = pots.randomSeed();
  const now = Math.floor(Date.now() / 1000);
  const betsCloseTs = now + 40;
  const created = await pots.createRace(program, {
    raceId,
    seedHash: await pots.seedHash(seed),
    entryFeeLamports: 0.01 * LAMPORTS_PER_SOL,
    betsCloseTs,
    maxPlayers: 3,
  });
  log("create_race", created.sig);
  console.log(`race      ${pots.explorerAddress(created.race)}`);

  // 5. Enter x3, bet on slot 0.
  for (let i = 0; i < players.length; i++) {
    log(`enter_race #${i}`, await pots.enterRace(program, raceId, players[i]));
  }
  log("place_bet (slot 0)", await pots.placeBet(program, raceId, bettor, 0, 0.02 * LAMPORTS_PER_SOL));

  // 6. Wait for bets to close (by chain time), then settle with the revealed seed.
  //    In production the placings come from running the deterministic sim with this seed.
  process.stdout.write("waiting for bets to close");
  for (;;) {
    const t = await conn.getBlockTime(await conn.getSlot());
    if (t !== null && t >= betsCloseTs) break;
    process.stdout.write(".");
    await new Promise((r) => setTimeout(r, 3000));
  }
  console.log();
  const placings = [0, 2, 1];
  log("settle_race", await pots.settleRace(program, { raceId, seed, placings }));

  // 7. Claims: P1 (slot 0), P2 (slot 2), P3 (slot 1), winning bettor. Then sweep dust.
  log("claim_prize P1", await pots.claimPrize(program, raceId, players[0]));
  log("claim_prize P2", await pots.claimPrize(program, raceId, players[2]));
  log("claim_prize P3", await pots.claimPrize(program, raceId, players[1]));
  log("claim_bet", await pots.claimBet(program, raceId, bettor, 0));
  log("close_race", await pots.closeRace(program, raceId));

  const race = await pots.fetchRace(program, raceId);
  console.log(`\nstatus=${pots.statusOf(race)} revealed seed=${pots.revealedSeed(race)}`);
  console.log("Anyone can now re-run the sim with this seed and check the placings.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

