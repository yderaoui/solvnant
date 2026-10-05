// TrackLab prize pots: small client for the game server (and the tests / devnet demo).
//
// TODO: security audit + legal review required before any real money / mainnet use.
// DEVNET / LOCALNET ONLY. Every entry point that takes an RPC URL refuses "mainnet".
//
// Requires `anchor build` first: the program types come from target/types (generated, gitignored).

import * as anchor from "@coral-xyz/anchor";
import { BN, Program } from "@coral-xyz/anchor";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import type { TracklabPots } from "../target/types/tracklab_pots";

export type PotsProgram = Program<TracklabPots>;

export const CONFIG_SEED = Buffer.from("config");
export const RACE_SEED = Buffer.from("race");
export const VAULT_SEED = Buffer.from("vault");
export const ENTRY_SEED = Buffer.from("entry");
export const BET_SEED = Buffer.from("bet");
export const MAX_ENTRIES = 10;
export const MAX_SEED_LEN = 64;

/** Throws if the URL points at mainnet. This program is devnet/localnet only. */
export function assertNotMainnet(rpcUrl: string): void {
  if (/mainnet/i.test(rpcUrl)) {
    throw new Error(
      `Refusing to use ${rpcUrl}: TrackLab pots are devnet/localnet only ` +
        "(TODO: security audit + legal review required before any real money / mainnet use)."
    );
  }
}

/** Explorer link for a tx signature on devnet. */
export function explorerTx(sig: string, cluster = "devnet"): string {
  return `https://explorer.solana.com/tx/${sig}?cluster=${cluster}`;
}

export function explorerAddress(addr: PublicKey | string, cluster = "devnet"): string {
  return `https://explorer.solana.com/address/${addr.toString()}?cluster=${cluster}`;
}

// ---------------------------------------------------------------------------------------------
// PDAs
// ---------------------------------------------------------------------------------------------

function u64le(n: BN | number | bigint): Buffer {
  return new BN(n.toString()).toArrayLike(Buffer, "le", 8);
}

export function configPda(programId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([CONFIG_SEED], programId)[0];
}

export function racePda(programId: PublicKey, raceId: BN | number | bigint): PublicKey {
  return PublicKey.findProgramAddressSync([RACE_SEED, u64le(raceId)], programId)[0];
}

export function vaultPda(programId: PublicKey, race: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([VAULT_SEED, race.toBuffer()], programId)[0];
}

export function entryPda(programId: PublicKey, race: PublicKey, player: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [ENTRY_SEED, race.toBuffer(), player.toBuffer()],
    programId
  )[0];
}

export function betPda(
  programId: PublicKey,
  race: PublicKey,
  bettor: PublicKey,
  pick: number
): PublicKey {
  return PublicKey.findProgramAddressSync(
    [BET_SEED, race.toBuffer(), bettor.toBuffer(), Buffer.from([pick])],
    programId
  )[0];
}

// ---------------------------------------------------------------------------------------------
// Commit-reveal
// ---------------------------------------------------------------------------------------------

/** The game's race seed is a string; on-chain we commit to sha256 of its UTF-8 bytes. */
export function seedBytes(seed: string | Uint8Array): Buffer {
  const b = typeof seed === "string" ? Buffer.from(seed, "utf8") : Buffer.from(seed);
  if (b.length === 0 || b.length > MAX_SEED_LEN) {
    throw new Error(`seed must be 1..${MAX_SEED_LEN} bytes, got ${b.length}`);
  }
  return b;
}

/** sha256(seed) via WebCrypto (works in Node 18+ and Cloudflare Workers). */
export async function seedHash(seed: string | Uint8Array): Promise<number[]> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", seedBytes(seed));
  return Array.from(new Uint8Array(digest));
}

/** A fresh unguessable seed (32 random bytes as hex = 64 chars). Short seeds can be brute-forced
 *  from their hash, which would let bettors predict the race before bets close. */
export function randomSeed(): string {
  const b = new Uint8Array(32);
  globalThis.crypto.getRandomValues(b);
  return Buffer.from(b).toString("hex");
}

// ---------------------------------------------------------------------------------------------
// Instructions
// ---------------------------------------------------------------------------------------------

export interface InitConfigParams {
  feeBps: number;
  treasury: PublicKey;
  settleTimeoutSecs: number;
  claimWindowSecs: number;
}

/** One-time setup. The provider wallet becomes the authority (game server / oracle key). */
export async function initializeConfig(program: PotsProgram, p: InitConfigParams): Promise<string> {
  const authority = program.provider.publicKey!;
  return program.methods
    .initializeConfig(p.feeBps, p.treasury, new BN(p.settleTimeoutSecs), new BN(p.claimWindowSecs))
    .accountsStrict({
      config: configPda(program.programId),
      authority,
      systemProgram: SystemProgram.programId,
    })
    .rpc();
}

export interface CreateRaceParams {
  raceId: BN | number | bigint;
  /** sha256(seed), e.g. from `seedHash(seed)`. Publish this BEFORE the race. */
  seedHash: number[];
  entryFeeLamports: BN | number | bigint;
  betsCloseTs: number;
  maxPlayers: number;
}

/** Authority-only. The provider wallet must be the config authority. */
export async function createRace(
  program: PotsProgram,
  p: CreateRaceParams
): Promise<{ sig: string; race: PublicKey; vault: PublicKey }> {
  const authority = program.provider.publicKey!;
  const race = racePda(program.programId, p.raceId);
  const vault = vaultPda(program.programId, race);
  const sig = await program.methods
    .createRace(
      new BN(p.raceId.toString()),
      p.seedHash,
      new BN(p.entryFeeLamports.toString()),
      new BN(p.betsCloseTs),
      p.maxPlayers
    )
    .accountsStrict({
      config: configPda(program.programId),
      race,
      vault,
      authority,
      systemProgram: SystemProgram.programId,
    })
    .rpc();
  return { sig, race, vault };
}

export interface SettleRaceParams {
  raceId: BN | number | bigint;
  /** The secret seed committed at createRace. Revealed on-chain for public verification. */
  seed: string | Uint8Array;
  /** Finishing order as entry slot indices (placings[0] = winner's slot). */
  placings: number[];
}

/** Authority-only, after bets close. Fails on-chain unless sha256(seed) matches the commitment. */
export async function settleRace(program: PotsProgram, p: SettleRaceParams): Promise<string> {
  const authority = program.provider.publicKey!;
  const config = configPda(program.programId);
  const race = racePda(program.programId, p.raceId);
  const cfg = await program.account.config.fetch(config);
  return program.methods
    .settleRace(seedBytes(p.seed), Buffer.from(p.placings))
    .accountsStrict({
      config,
      race,
      vault: vaultPda(program.programId, race),
      treasury: cfg.treasury,
      authority,
      systemProgram: SystemProgram.programId,
    })
    .rpc();
}

/** Authority any time before settle; anyone after the settle deadline. */
export async function cancelRace(
  program: PotsProgram,
  raceId: BN | number | bigint,
  caller: anchor.web3.Keypair | null = null
): Promise<string> {
  const race = racePda(program.programId, raceId);
  const b = program.methods.cancelRace().accountsStrict({
    race,
    caller: caller ? caller.publicKey : program.provider.publicKey!,
  });
  return caller ? b.signers([caller]).rpc() : b.rpc();
}

/** Permissionless: sweeps vault leftovers to the treasury once claims are done / window expired. */
export async function closeRace(program: PotsProgram, raceId: BN | number | bigint): Promise<string> {
  const race = racePda(program.programId, raceId);
  const r = await program.account.race.fetch(race);
  return program.methods
    .closeRace()
    .accountsStrict({
      race,
      vault: vaultPda(program.programId, race),
      treasury: r.treasury,
      caller: program.provider.publicKey!,
      systemProgram: SystemProgram.programId,
    })
    .rpc();
}

// Player / bettor side. `user` signs; the provider wallet pays the tx fee.

export async function enterRace(
  program: PotsProgram,
  raceId: BN | number | bigint,
  player: anchor.web3.Keypair
): Promise<string> {
  const race = racePda(program.programId, raceId);
  return program.methods
    .enterRace()
    .accountsStrict({
      race,
      vault: vaultPda(program.programId, race),
      entry: entryPda(program.programId, race, player.publicKey),
      player: player.publicKey,
      systemProgram: SystemProgram.programId,
    })
    .signers([player])
    .rpc();
}

export async function placeBet(
  program: PotsProgram,
  raceId: BN | number | bigint,
  bettor: anchor.web3.Keypair,
  pick: number,
  amountLamports: BN | number | bigint
): Promise<string> {
  const race = racePda(program.programId, raceId);
  return program.methods
    .placeBet(pick, new BN(amountLamports.toString()))
    .accountsStrict({
      race,
      vault: vaultPda(program.programId, race),
      bet: betPda(program.programId, race, bettor.publicKey, pick),
      bettor: bettor.publicKey,
      systemProgram: SystemProgram.programId,
    })
    .signers([bettor])
    .rpc();
}

function entryAccounts(program: PotsProgram, raceId: BN | number | bigint, player: PublicKey) {
  const race = racePda(program.programId, raceId);
  return {
    race,
    vault: vaultPda(program.programId, race),
    entry: entryPda(program.programId, race, player),
    player,
    systemProgram: SystemProgram.programId,
  };
}

function betAccounts(
  program: PotsProgram,
  raceId: BN | number | bigint,
  bettor: PublicKey,
  pick: number
) {
  const race = racePda(program.programId, raceId);
  return {
    race,
    vault: vaultPda(program.programId, race),
    bet: betPda(program.programId, race, bettor, pick),
    bettor,
    systemProgram: SystemProgram.programId,
  };
}

export async function claimPrize(
  program: PotsProgram,
  raceId: BN | number | bigint,
  player: anchor.web3.Keypair
): Promise<string> {
  return program.methods
    .claimPrize()
    .accountsStrict(entryAccounts(program, raceId, player.publicKey))
    .signers([player])
    .rpc();
}

export async function refundEntry(
  program: PotsProgram,
  raceId: BN | number | bigint,
  player: anchor.web3.Keypair
): Promise<string> {
  return program.methods
    .refundEntry()
    .accountsStrict(entryAccounts(program, raceId, player.publicKey))
    .signers([player])
    .rpc();
}

export async function claimBet(
  program: PotsProgram,
  raceId: BN | number | bigint,
  bettor: anchor.web3.Keypair,
  pick: number
): Promise<string> {
  return program.methods
    .claimBet()
    .accountsStrict(betAccounts(program, raceId, bettor.publicKey, pick))
    .signers([bettor])
    .rpc();
}

export async function refundBet(
  program: PotsProgram,
  raceId: BN | number | bigint,
  bettor: anchor.web3.Keypair,
  pick: number
): Promise<string> {
  return program.methods
    .refundBet()
    .accountsStrict(betAccounts(program, raceId, bettor.publicKey, pick))
    .signers([bettor])
    .rpc();
}

// ---------------------------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------------------------

export async function fetchRace(program: PotsProgram, raceId: BN | number | bigint) {
  return program.account.race.fetch(racePda(program.programId, raceId));
}

/** "open" | "settled" | "cancelled" | "closed" */
export function statusOf(race: { status: object }): string {
  return Object.keys(race.status)[0];
}

/** The revealed seed (empty string before settlement) - feed this to the sim to verify placings. */
export function revealedSeed(race: { seed: number[]; seedLen: number }): string {
  return Buffer.from(race.seed.slice(0, race.seedLen)).toString("utf8");
}
