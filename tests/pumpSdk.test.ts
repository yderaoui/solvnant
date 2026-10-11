import { expect, it } from 'vitest';
import BN from 'bn.js';
import { ComputeBudgetProgram, Keypair, PublicKey, Transaction } from '@solana/web3.js';
import { getAssociatedTokenAddressSync, NATIVE_MINT, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { PUMP_AMM_SDK, PUMP_AMM_PROGRAM_ID, canonicalPumpPoolPda, type SwapSolanaState } from '@pump-fun/pump-swap-sdk';
import { PUMP_SDK, PUMP_PROGRAM_ID, getBuyV3TokenAmountFromQuoteAmount, type BondingCurve, type FeeConfig, type Global } from '@pump-fun/pump-sdk';

it('the official SDK builds a bounded SOL buy for the selected mint that fits a Solana transaction', async () => {
  const user = Keypair.generate().publicKey, mint = Keypair.generate().publicKey;
  const fees = { lpFeeBps: new BN(0), protocolFeeBps: new BN(100), creatorFeeBps: new BN(0) };
  const feeConfig = { feeTiers: [{ marketCapLamportsThreshold: new BN(0), fees }] } as FeeConfig;
  const global = { creatorFeeConfigurable: false } as Global;
  const curve = {
    virtualTokenReserves: new BN('1073000000000000'), virtualQuoteReserves: new BN('30000000000'),
    realTokenReserves: new BN('793100000000000'), realQuoteReserves: new BN(0), tokenTotalSupply: new BN('1000000000000000'),
    complete:false,creator:PublicKey.default,isMayhemMode:false,isCashbackCoin:false,quoteMint:NATIVE_MINT,creatorFeeBps:new BN(0),
  } as BondingCurve;
  const budget = new BN(50_000_000);
  const tokens = getBuyV3TokenAmountFromQuoteAmount({global,feeConfig,mintSupply:curve.tokenTotalSupply,bondingCurve:curve,amount:budget,curveBaseTokenBalance:curve.tokenTotalSupply});
  expect(tokens.gtn(0)).toBe(true);
  const instructions = await PUMP_SDK.buyV3Instructions({bondingCurve:curve,associatedUserAccountInfo:null,mint,user,amount:tokens,quoteAmount:budget,slippage:1,tokenProgram:TOKEN_2022_PROGRAM_ID,quoteTokenProgram:TOKEN_PROGRAM_ID});
  const buy = instructions.find(i=>i.programId.equals(PUMP_PROGRAM_ID))!;
  expect(buy.keys.some(k=>k.pubkey.equals(mint))).toBe(true);
  expect(buy.keys.filter(k=>k.isSigner).map(k=>k.pubkey.toBase58())).toEqual([user.toBase58()]);
  expect(buy.data.readBigUInt64LE(16)).toBe(50_500_000n);
  const tx = new Transaction({feePayer:user,recentBlockhash:NATIVE_MINT.toBase58()});
  tx.add(ComputeBudgetProgram.setComputeUnitLimit({units:400_000}),...instructions);
  expect(tx.serialize({requireAllSignatures:false,verifySignatures:false}).length).toBeLessThanOrEqual(1232);
});

it('the official PumpSwap SDK builds a graduated-coin buy with account setup that fits on-chain', async () => {
  const key = () => Keypair.generate().publicKey;
  const user=key(), mint=key(), creator=key(), recipient=key(), buyback=key();
  const pool = {baseMint:mint,quoteMint:NATIVE_MINT,creator,coinCreator:creator,isMayhemMode:false,isCashbackCoin:false,virtualQuoteReserves:new BN(0),creatorFeeBps:new BN(0),poolBaseTokenAccount:key(),poolQuoteTokenAccount:key()};
  const state = {
    poolKey:canonicalPumpPoolPda(mint),poolAccountInfo:{data:Buffer.alloc(300)},pool,
    globalConfig:{protocolFeeRecipients:Array(8).fill(recipient),buybackFeeRecipients:Array(8).fill(buyback)},
    user,baseMint:mint,baseTokenProgram:TOKEN_2022_PROGRAM_ID,quoteTokenProgram:TOKEN_PROGRAM_ID,
    userBaseTokenAccount:getAssociatedTokenAddressSync(mint,user,false,TOKEN_2022_PROGRAM_ID),
    userQuoteTokenAccount:getAssociatedTokenAddressSync(NATIVE_MINT,user),userBaseAccountInfo:null,userQuoteAccountInfo:null,
  } as unknown as SwapSolanaState;
  const ixs=await PUMP_AMM_SDK.buyInstructions(state,new BN(1_000_000),new BN(50_500_000));
  const buy=ixs.find(i=>i.programId.equals(PUMP_AMM_PROGRAM_ID))!;
  expect(buy.keys.some(k=>k.pubkey.equals(mint))).toBe(true);
  expect(buy.data.readBigUInt64LE(16)).toBe(50_500_000n);
  const tx=new Transaction({feePayer:user,recentBlockhash:NATIVE_MINT.toBase58()});
  tx.add(ComputeBudgetProgram.setComputeUnitLimit({units:400_000}),...ixs);
  expect(tx.serialize({requireAllSignatures:false,verifySignatures:false}).length).toBeLessThanOrEqual(1232);
});
