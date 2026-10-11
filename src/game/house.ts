// The house wallet: the game server's own Solana wallet (key in the HOUSE_SECRET secret). It is the
// treasury that receives ticket and racer payments, it pays winners automatically (80% prize, 15%
// burned, 5% to the team wallet), and it pays the network fees of players' purchases ("sponsored gas":
// players never need SOL).
//
// Keep only what's needed in it (pots in flight + a little SOL): a server that holds a key can be
// attacked. Sponsored transactions are checked instruction by instruction before the house co-signs,
// so it can only ever pay the fee of an exact PumpKart payment into its own coin account.
import {
  AccountRole,
  address,
  appendTransactionMessageInstructions,
  createKeyPairSignerFromBytes,
  createTransactionMessage,
  getAddressEncoder,
  getBase58Decoder,
  getBase58Encoder,
  getBase64Decoder,
  getBase64EncodedWireTransaction,
  getBase64Encoder,
  getCompiledTransactionMessageDecoder,
  getProgramDerivedAddress,
  getSignatureFromTransaction,
  getTransactionDecoder,
  getTransactionEncoder,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signBytes,
  signTransactionMessageWithSigners,
  type Address,
  type Instruction,
  type KeyPairSigner,
} from '@solana/kit';
import type { TicketConfig } from './config';

export const PROGRAMS = {
  system: '11111111111111111111111111111111',
  ata: 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
  memo: 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr',
  computeBudget: 'ComputeBudget111111111111111111111111111111',
  token: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  token2022: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
} as const;

export interface House {
  signer: KeyPairSigner;
  address: string;
}

/** HOUSE_SECRET: the 64-byte secret key as a base58 string (Phantom export) or a JSON array (solana-keygen). */
export async function loadHouse(secret: string | undefined): Promise<House | null> {
  if (!secret) return null;
  const s = secret.trim();
  const bytes = s.startsWith('[') ? Uint8Array.from(JSON.parse(s) as number[]) : new Uint8Array(getBase58Encoder().encode(s));
  if (bytes.length !== 64) throw new Error('HOUSE_SECRET must be a 64-byte secret key');
  const signer = await createKeyPairSignerFromBytes(bytes);
  return { signer, address: signer.address };
}

// ---------------------------------------------------------------------------------- RPC
async function rpc<T>(cfg: TicketConfig, method: string, params: unknown[]): Promise<T> {
  const url = cfg.verifyUrl ? `${cfg.verifyUrl}${cfg.verifyUrl.includes('?') ? '&' : '?'}cluster=${cfg.cluster}` : cfg.rpcUrl;
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(cfg.verifyKey ? { 'x-rpc-key': cfg.verifyKey } : {}) },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!r.ok) throw new Error(`Solana RPC ${method}: HTTP ${r.status}`);
  const j = (await r.json()) as { result?: T; error?: { message: string } };
  if (j.error) throw new Error(`Solana RPC ${method}: ${j.error.message}`);
  return j.result as T;
}

export interface MintInfo {
  program: string; // token program that owns the mint (classic or Token-2022)
  decimals: number;
}
const mints = new Map<string, MintInfo>();
export async function mintInfo(cfg: TicketConfig): Promise<MintInfo> {
  const hit = mints.get(cfg.mint);
  if (hit) return hit;
  const acc = await rpc<{ value: { owner: string; data: [string, string] } | null }>(cfg, 'getAccountInfo', [cfg.mint, { encoding: 'base64' }]);
  if (!acc.value) throw new Error('coin not found');
  const data = getBase64Encoder().encode(acc.value.data[0]);
  const info = { program: acc.value.owner, decimals: data[44] }; // mint layout: decimals at byte 44 (both programs)
  mints.set(cfg.mint, info);
  return info;
}

export async function ataOf(owner: string, mint: string, program: string): Promise<string> {
  const enc = getAddressEncoder();
  const [pda] = await getProgramDerivedAddress({ programAddress: address(PROGRAMS.ata), seeds: [enc.encode(address(owner)), enc.encode(address(program)), enc.encode(address(mint))] });
  return pda;
}

/** Coins -> base units (rounded down, never more than asked). */
export const units = (coins: number, decimals: number) => BigInt(Math.floor(coins * 10 ** decimals + 1e-6));

// ---------------------------------------------------------------------------------- instructions
const u64 = (v: bigint) => {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, v, true);
  return b;
};
const ix = (programAddress: string, accounts: { address: string; role: AccountRole; signer?: KeyPairSigner }[], data: Uint8Array): Instruction =>
  ({ programAddress: address(programAddress), accounts: accounts.map((a) => ({ address: address(a.address), role: a.role, ...(a.signer ? { signer: a.signer } : {}) })), data }) as unknown as Instruction;

function transferChecked(program: string, from: string, mint: string, to: string, owner: KeyPairSigner, amount: bigint, decimals: number) {
  return ix(
    program,
    [
      { address: from, role: AccountRole.WRITABLE },
      { address: mint, role: AccountRole.READONLY },
      { address: to, role: AccountRole.WRITABLE },
      { address: owner.address, role: AccountRole.READONLY_SIGNER, signer: owner },
    ],
    new Uint8Array([12, ...u64(amount), decimals]),
  );
}

function burnChecked(program: string, account: string, mint: string, owner: KeyPairSigner, amount: bigint, decimals: number) {
  return ix(
    program,
    [
      { address: account, role: AccountRole.WRITABLE },
      { address: mint, role: AccountRole.WRITABLE },
      { address: owner.address, role: AccountRole.READONLY_SIGNER, signer: owner },
    ],
    new Uint8Array([15, ...u64(amount), decimals]),
  );
}

function createAtaIdempotent(payer: KeyPairSigner, ata: string, owner: string, mint: string, program: string) {
  return ix(
    PROGRAMS.ata,
    [
      { address: payer.address, role: AccountRole.WRITABLE_SIGNER, signer: payer },
      { address: ata, role: AccountRole.WRITABLE },
      { address: owner, role: AccountRole.READONLY },
      { address: mint, role: AccountRole.READONLY },
      { address: PROGRAMS.system, role: AccountRole.READONLY },
      { address: program, role: AccountRole.READONLY },
    ],
    new Uint8Array([1]),
  );
}

const memoIx = (text: string) => ix(PROGRAMS.memo, [], new TextEncoder().encode(text));

// ---------------------------------------------------------------------------------- payouts
export interface PayoutPlan {
  rawUnits?: { prize: string; burn: string; team: string };
  winner: string; // wallet
  prize: number; // coins
  burn: number;
  team: number;
  teamWallet: string | null; // null: the team share stays in the house wallet
  note: string; // memo
}

/** Build and sign one lobby's payout transaction. Not sent yet: the caller stores the signature first. */
export async function buildPayout(cfg: TicketConfig, house: House, plan: PayoutPlan) {
  const m = await mintInfo(cfg);
  const houseAta = await ataOf(house.address, cfg.mint, m.program);
  const winnerAta = await ataOf(plan.winner, cfg.mint, m.program);
  const ixs: Instruction[] = [
    createAtaIdempotent(house.signer, winnerAta, plan.winner, cfg.mint, m.program),
    transferChecked(m.program, houseAta, cfg.mint, winnerAta, house.signer, plan.rawUnits ? BigInt(plan.rawUnits.prize) : units(plan.prize, m.decimals), m.decimals),
  ];
  if (plan.burn > 0) ixs.push(burnChecked(m.program, houseAta, cfg.mint, house.signer, plan.rawUnits ? BigInt(plan.rawUnits.burn) : units(plan.burn, m.decimals), m.decimals));
  if (plan.team > 0 && plan.teamWallet) {
    const teamAta = await ataOf(plan.teamWallet, cfg.mint, m.program);
    ixs.push(createAtaIdempotent(house.signer, teamAta, plan.teamWallet, cfg.mint, m.program));
    ixs.push(transferChecked(m.program, houseAta, cfg.mint, teamAta, house.signer, plan.rawUnits ? BigInt(plan.rawUnits.team) : units(plan.team, m.decimals), m.decimals));
  }
  ixs.push(memoIx(plan.note));
  const { value: bh } = await rpc<{ value: { blockhash: string; lastValidBlockHeight: number } }>(cfg, 'getLatestBlockhash', [{ commitment: 'confirmed' }]);
  const msg = pipe(
    createTransactionMessage({ version: 0 }),
    (t) => setTransactionMessageFeePayerSigner(house.signer, t),
    (t) => setTransactionMessageLifetimeUsingBlockhash({ blockhash: bh.blockhash as never, lastValidBlockHeight: BigInt(bh.lastValidBlockHeight) }, t),
    (t) => appendTransactionMessageInstructions(ixs, t),
  );
  const tx = await signTransactionMessageWithSigners(msg);
  return { signature: getSignatureFromTransaction(tx) as string, wire: getBase64EncodedWireTransaction(tx) as string, lastValid: bh.lastValidBlockHeight };
}

export async function sendWire(cfg: TicketConfig, wire: string): Promise<string> {
  return rpc<string>(cfg, 'sendTransaction', [wire, { encoding: 'base64', preflightCommitment: 'confirmed', maxRetries: 5 }]);
}

/** null = absent from history; ok:null = processed but not yet confirmed. */
export async function txStatus(cfg: TicketConfig, sig: string): Promise<{ ok: boolean | null; err: unknown } | null> {
  const r = await rpc<{ value: ({ confirmationStatus: string | null; err: unknown } | null)[] }>(cfg, 'getSignatureStatuses', [[sig], { searchTransactionHistory: true }]);
  const s = r.value[0];
  if (!s) return null;
  if (s.confirmationStatus !== 'confirmed' && s.confirmationStatus !== 'finalized') return { ok: null, err: s.err };
  return { ok: !s.err, err: s.err };
}

export async function blockHeight(cfg: TicketConfig): Promise<number> {
  return rpc<number>(cfg, 'getBlockHeight', [{ commitment: 'finalized' }]);
}

// ---------------------------------------------------------------------------------- sponsored payments
export interface SponsorCheck {
  /** The memo's price in coins if it was handed to this player (else null: refuse). */
  priceOf: (memo: string) => number | null;
  unitsOf?: (memo: string) => string | null;
}

function checkSponsoredBudget(data: Uint8Array, accounts: string[]) {
  // Never let a supplied priority fee drain the treasury. Our normal coin transfers
  // do not need one; accept only bounded modern compute-limit/price instructions.
  if (accounts.length) throw new Error('Sponsored compute instructions cannot use accounts.');
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (data[0] === 2 && data.length === 5 && view.getUint32(1, true) > 0 && view.getUint32(1, true) <= 400_000) return;
  if (data[0] === 3 && data.length === 9 && view.getBigUint64(1, true) <= 10_000n) return;
  throw new Error('Sponsored priority fees exceed the allowed budget.');
}

async function signedByPlayer(player: string, signature: Uint8Array | null | undefined, message: ArrayLike<number>): Promise<boolean> {
  if (!signature || signature.length !== 64) return false;
  const key = await crypto.subtle.importKey('raw', getAddressEncoder().encode(address(player)) as BufferSource, { name: 'Ed25519' }, false, ['verify']);
  return crypto.subtle.verify('Ed25519', key, signature as BufferSource, new Uint8Array(message));
}

/**
 * A player's purchase, signed by the player with the house as fee payer. Check that it is exactly a
 * PumpKart payment into the house's coin account, then co-sign it. Returns the wire transaction and
 * its id. Throws (readable) if anything is off.
 */
export async function cosignPurchase(cfg: TicketConfig, house: House, wireBase64: string, check: SponsorCheck) {
  const m = await mintInfo(cfg);
  const houseAta = await ataOf(house.address, cfg.mint, m.program);
  const tx = getTransactionDecoder().decode(getBase64Encoder().encode(wireBase64));
  const msg = getCompiledTransactionMessageDecoder().decode(tx.messageBytes) as unknown as {
    header: { numSignerAccounts: number; numReadonlySignerAccounts: number; numReadonlyNonSignerAccounts: number };
    staticAccounts: string[];
    instructions: { programAddressIndex: number; accountIndices?: number[]; data?: Uint8Array }[];
    addressTableLookups?: unknown[];
  };
  const keys = msg.staticAccounts;
  const bad = (why: string) => new Error(`This payment can't be sponsored (${why}).`);
  if (msg.addressTableLookups?.length) throw bad('lookup tables');
  if (keys[0] !== house.address) throw bad('fee payer');
  if (msg.header.numSignerAccounts !== 2) throw bad('signers');
  const player = keys[1];
  let transfers = 0,
    memos = 0,
    memo = '',
    amount = -1n;
  for (const ins of msg.instructions) {
    const prog = keys[ins.programAddressIndex];
    const acc = (ins.accountIndices ?? []).map((i) => keys[i]);
    const data = ins.data ?? new Uint8Array();
    if (prog === PROGRAMS.computeBudget) { checkSponsoredBudget(data, acc); continue; }
    if (prog === PROGRAMS.ata) {
      // only: create the house's own coin account (once), paid by the house
      if (!(data.length === 0 || (data.length === 1 && data[0] === 1))) throw bad('account creation');
      if (acc[0] !== house.address || acc[1] !== houseAta || acc[2] !== house.address || acc[3] !== cfg.mint || acc[5] !== m.program) throw bad('account creation');
      continue;
    }
    if (acc.includes(house.address)) throw bad('house account used');
    if (prog === m.program) {
      if (data[0] !== 12 || data.length !== 10) throw bad('not a transfer');
      if (acc[1] !== cfg.mint || acc[2] !== houseAta || acc[3] !== player) throw bad('transfer accounts');
      if (data[9] !== m.decimals) throw bad('decimals');
      amount = new DataView(data.buffer, data.byteOffset + 1, 8).getBigUint64(0, true);
      transfers++;
      continue;
    }
    if (prog === PROGRAMS.memo) {
      memo = new TextDecoder().decode(data);
      memos++;
      continue;
    }
    throw bad('unexpected instruction');
  }
  if (transfers !== 1 || memos !== 1) throw bad('one transfer and one memo');
  const price = check.priceOf(memo);
  if (price === null) throw bad('memo');
  const exact = check.unitsOf?.(memo);
  if (amount !== (exact ? BigInt(exact) : units(price, m.decimals))) throw bad('amount');
  if (!(await signedByPlayer(player, tx.signatures[player as Address] as Uint8Array | null, tx.messageBytes))) throw bad('not signed by you');
  const sig = await signBytes(house.signer.keyPair.privateKey, tx.messageBytes);
  const signed = { ...tx, signatures: { ...tx.signatures, [house.address]: sig } };
  const wire = getBase64Decoder().decode(getTransactionEncoder().encode(signed as never));
  return { wire, signature: getBase58Decoder().decode(sig), player, memo };
}

/**
 * A player's withdrawal (their coins out of their game wallet), signed by the player with the house as
 * fee payer. Allowed: one transfer of the game coin from the player's own coin account, optionally the
 * creation of the destination's coin account (paid by the house: `allowCreate`), an optional memo.
 * The house may appear only as the fee payer and as payer of that account creation.
 */
export async function cosignWithdrawal(cfg: TicketConfig, house: House, wireBase64: string, allowCreate: boolean) {
  const m = await mintInfo(cfg);
  const tx = getTransactionDecoder().decode(getBase64Encoder().encode(wireBase64));
  const msg = getCompiledTransactionMessageDecoder().decode(tx.messageBytes) as unknown as {
    header: { numSignerAccounts: number };
    staticAccounts: string[];
    instructions: { programAddressIndex: number; accountIndices?: number[]; data?: Uint8Array }[];
    addressTableLookups?: unknown[];
  };
  const keys = msg.staticAccounts;
  const bad = (why: string) => new Error(`This withdrawal can't be sponsored (${why}).`);
  if (msg.addressTableLookups?.length) throw bad('lookup tables');
  if (keys[0] !== house.address || msg.header.numSignerAccounts !== 2) throw bad('signers');
  const player = keys[1];
  const playerAta = await ataOf(player, cfg.mint, m.program);
  let transfers = 0,
    creates = 0;
  for (const ins of msg.instructions) {
    const prog = keys[ins.programAddressIndex];
    const acc = (ins.accountIndices ?? []).map((i) => keys[i]);
    const data = ins.data ?? new Uint8Array();
    if (prog === PROGRAMS.computeBudget) { checkSponsoredBudget(data, acc); continue; }
    if (prog === PROGRAMS.memo) continue;
    if (prog === PROGRAMS.ata) {
      if (!allowCreate) throw bad('the destination has no coin account yet; daily limit reached');
      if (!(data.length === 0 || (data.length === 1 && data[0] === 1))) throw bad('account creation');
      if (acc[0] !== house.address || acc[3] !== cfg.mint || acc[5] !== m.program || acc[2] === house.address) throw bad('account creation');
      if (acc[1] !== (await ataOf(acc[2], cfg.mint, m.program))) throw bad('account creation');
      creates++;
      continue;
    }
    if (acc.includes(house.address)) throw bad('house account used');
    if (prog !== m.program) throw bad('unexpected instruction');
    if (data[0] !== 12 || data.length !== 10 || data[9] !== m.decimals) throw bad('not a transfer');
    if (acc[0] !== playerAta || acc[1] !== cfg.mint || acc[3] !== player) throw bad('transfer accounts');
    if (new DataView(data.buffer, data.byteOffset + 1, 8).getBigUint64(0, true) === 0n) throw bad('zero amount');
    transfers++;
  }
  if (transfers !== 1 || creates > 1) throw bad('one transfer');
  if (!(await signedByPlayer(player, tx.signatures[player as Address] as Uint8Array | null, tx.messageBytes))) throw bad('not signed by you');
  const sig = await signBytes(house.signer.keyPair.privateKey, tx.messageBytes);
  const wire = getBase64Decoder().decode(getTransactionEncoder().encode({ ...tx, signatures: { ...tx.signatures, [house.address]: sig } } as never));
  return { wire, signature: getBase58Decoder().decode(sig), created: creates > 0 };
}
