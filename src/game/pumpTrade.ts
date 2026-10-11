// Official Pump SDKs; no transaction-builder service and no third-party custody.
import BN from 'bn.js';
import { Buffer } from 'buffer';
import { Connection, PublicKey, type TransactionInstruction } from '@solana/web3.js';
import { getMint, getExtensionTypes, ExtensionType, NATIVE_MINT, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';
import { OnlinePumpSdk, PUMP_SDK, bondingCurvePda, canonicalPumpPoolPda, PUMP_PROGRAM_ID } from '@pump-fun/pump-sdk';
import { OnlinePumpAmmSdk, PUMP_AMM_SDK, buyQuoteInput } from '@pump-fun/pump-swap-sdk';
import type { TicketConfig } from './config';

export function pumpConnection(t: TicketConfig) {
  return new Connection(t.verifyUrl ?? t.rpcUrl, {
    commitment: 'confirmed',
    ...(t.verifyKey ? { httpHeaders: { 'x-rpc-key': t.verifyKey } } : {}),
  });
}

async function curveState(conn: Connection, mint: PublicKey) {
  const info = await conn.getAccountInfo(bondingCurvePda(mint));
  if (!info || !info.owner.equals(PUMP_PROGRAM_ID)) throw new Error('This mint is not a supported pump.fun coin.');
  return PUMP_SDK.decodeBondingCurve(info);
}

export async function verifyPumpCoin(t: TicketConfig) {
  const conn = pumpConnection(t), mint = new PublicKey(t.mint);
  const info = await conn.getAccountInfo(mint);
  if (!info || !(info.owner.equals(TOKEN_PROGRAM_ID) || info.owner.equals(TOKEN_2022_PROGRAM_ID))) throw new Error('Coin mint not found on the configured network.');
  const token = await getMint(conn, mint, 'confirmed', info.owner);
  if (token.mintAuthority || token.freezeAuthority) throw new Error('The launch coin still has mint or freeze authority.');
  const allowed = new Set([ExtensionType.MetadataPointer, ExtensionType.TokenMetadata]);
  if (getExtensionTypes(token.tlvData).some(type => !allowed.has(type))) throw new Error('Coin has unsupported token extensions. Review it before launch.');
  const curve = await curveState(conn, mint);
  if (curve.isCashbackCoin) throw new Error('This buying flow requires a coin without cashback mode.');
  if (!curve.quoteMint.equals(NATIVE_MINT) && !curve.quoteMint.equals(PublicKey.default)) throw new Error('Launch a SOL-paired coin for this buying flow.');
  if (curve.complete) {
    const pool = await new OnlinePumpAmmSdk(conn).fetchPool(canonicalPumpPoolPda(mint));
    if (!pool.baseMint.equals(mint) || !pool.quoteMint.equals(NATIVE_MINT)) throw new Error('The PumpSwap pool is not ready.');
  }
  return { decimals: token.decimals, route: curve.complete ? 'PumpSwap' : 'pump.fun' };
}

/** Fresh-coin pricing before indexers catch up. Uses on-chain reserves and a separately fetched SOL/USD price. */
export async function pumpCurvePriceUsd(t: TicketConfig, solUsd: number): Promise<number | null> {
  const curve = await curveState(pumpConnection(t), new PublicKey(t.mint));
  if (curve.complete || (!curve.quoteMint.equals(NATIVE_MINT) && !curve.quoteMint.equals(PublicKey.default))) return null;
  const tokens = Number(curve.virtualTokenReserves.toString()) / 10 ** t.decimals;
  const sol = Number(curve.virtualQuoteReserves.toString()) / 1e9;
  const p = sol / tokens * solUsd;
  return Number.isFinite(p) && p > 0 ? p : null;
}

export interface PumpBuyQuote {
  route: string;
  tokens: string;
  maxLamports: number;
  instructions: TransactionInstruction[];
}

/** A fixed token output with a 1% maximum SOL cost increase. Nothing is signed or sent here. */
export async function buildPumpBuy(t: TicketConfig, address: string, sol: number): Promise<PumpBuyQuote> {
  (globalThis as unknown as { Buffer: typeof Buffer }).Buffer ??= Buffer;
  if (!Number.isFinite(sol) || sol < 0.001 || sol > 10) throw new Error('Enter between 0.001 and 10 SOL.');
  const conn = pumpConnection(t), mint = new PublicKey(t.mint), user = new PublicKey(address);
  const info = await conn.getAccountInfo(mint);
  if (!info) throw new Error('The official coin is not available yet.');
  const program = info.owner;
  if (!program.equals(TOKEN_PROGRAM_ID) && !program.equals(TOKEN_2022_PROGRAM_ID)) throw new Error('Invalid coin mint.');
  const amount = new BN(Math.floor(sol * 1e9));
  const curve = await curveState(conn, mint);
  if (!curve.quoteMint.equals(NATIVE_MINT) && !curve.quoteMint.equals(PublicKey.default)) throw new Error('This coin is not paired with SOL.');
  let tokens: BN, instructions: TransactionInstruction[], max: BN, route: string;
  if (!curve.complete) {
    const sdk = new OnlinePumpSdk(conn);
    const [global, feeConfig, state, token] = await Promise.all([sdk.fetchGlobal(), sdk.fetchFeeConfig(), sdk.fetchBuyState(mint, user, program), getMint(conn, mint, 'confirmed', program)]);
    const { getBuyV3TokenAmountFromQuoteAmount } = await import('@pump-fun/pump-sdk');
    tokens = getBuyV3TokenAmountFromQuoteAmount({ global, feeConfig, mintSupply: new BN(token.supply.toString()), bondingCurve: state.bondingCurve, amount, curveBaseTokenBalance: state.curveBaseTokenBalance });
    if (state.bondingCurve.complete) throw new Error('The coin just graduated. Refresh the quote to use PumpSwap.');
    instructions = await PUMP_SDK.buyV3Instructions({ bondingCurve: state.bondingCurve, associatedUserAccountInfo: state.associatedUserAccountInfo, mint, user, amount: tokens, quoteAmount: amount, slippage: 1, tokenProgram: program, quoteTokenProgram: TOKEN_PROGRAM_ID });
    max = amount.add(amount.divn(100)); route = 'pump.fun';
  } else {
    const state = await new OnlinePumpAmmSdk(conn).swapSolanaState(canonicalPumpPoolPda(mint), user);
    if (!state.pool.baseMint.equals(mint) || !state.pool.quoteMint.equals(NATIVE_MINT)) throw new Error('The official PumpSwap pool is not ready.');
    const q = buyQuoteInput({ ...state, baseReserve: state.poolBaseAmount, quoteReserve: state.poolQuoteAmount, virtualQuoteReserves: state.pool.virtualQuoteReserves, baseMint: mint, quote: amount, slippage: 1, coinCreator: state.pool.coinCreator, creator: state.pool.creator, quoteMint: state.pool.quoteMint, isMayhemMode: state.pool.isMayhemMode, creatorFeeBps: state.pool.creatorFeeBps });
    tokens = q.base; max = q.maxQuote;
    instructions = await PUMP_AMM_SDK.buyInstructions(state, tokens, max); route = 'PumpSwap';
  }
  if (tokens.lten(0)) throw new Error('No coins available at this amount. Refresh your quote.');
  return { route, tokens: tokens.toString(), maxLamports: max.toNumber(), instructions };
}
