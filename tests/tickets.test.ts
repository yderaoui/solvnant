// Coin tickets: the on-chain payment check (RPC responses mocked in the shape Solana returns).
import { describe, expect, it } from 'vitest';
import { verifyTicketPayment } from '../src/game/solana';
import type { TicketConfig } from '../src/game/config';

const cfg: TicketConfig = {
  cluster: 'devnet',
  rpcUrl: 'https://rpc.test',
  mint: 'MintAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  decimals: 6,
  treasury: 'TreasuryBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
  price: 100,
  symbol: '$TRACK',
};
const SIG = '5'.repeat(88);
const MEMO = 'TrackLab ticket abc123';
const PLAYER = 'PlayerCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC';

function tx(o: { memo?: string; received?: number; mint?: string; owner?: string; err?: unknown } = {}) {
  const bal = (amt: number) => ({ owner: o.owner ?? cfg.treasury, mint: o.mint ?? cfg.mint, uiTokenAmount: { uiAmount: amt } });
  return {
    meta: { err: o.err ?? null, preTokenBalances: [bal(50)], postTokenBalances: [bal(50 + (o.received ?? 100))] },
    transaction: {
      message: {
        accountKeys: [{ pubkey: PLAYER, signer: true }],
        instructions: [{ program: 'spl-token', parsed: { type: 'transferChecked' } }, { program: 'spl-memo', parsed: o.memo ?? MEMO }],
      },
    },
  };
}
const rpc = (result: unknown) => (async () => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }))) as unknown as typeof fetch;

describe('coin ticket payments', () => {
  it('accepts a payment of the price to the treasury with our memo', async () => {
    expect(await verifyTicketPayment(cfg, SIG, MEMO, rpc(tx()))).toEqual({ wallet: PLAYER, amount: 100 });
  });
  it('accepts paying more than the price', async () => {
    expect((await verifyTicketPayment(cfg, SIG, MEMO, rpc(tx({ received: 150 }))))?.amount).toBe(150);
  });
  it('waits (null) while the transaction is not confirmed yet', async () => {
    expect(await verifyTicketPayment(cfg, SIG, MEMO, rpc(null))).toBeNull();
  });
  it('rejects a payment made for another purchase (memo)', async () => {
    await expect(verifyTicketPayment(cfg, SIG, MEMO, rpc(tx({ memo: 'TrackLab ticket other' })))).rejects.toThrow(/memo/);
  });
  it('rejects too little', async () => {
    await expect(verifyTicketPayment(cfg, SIG, MEMO, rpc(tx({ received: 99 })))).rejects.toThrow(/costs 100/);
  });
  it('rejects a different coin', async () => {
    await expect(verifyTicketPayment(cfg, SIG, MEMO, rpc(tx({ mint: 'OtherMintDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD' })))).rejects.toThrow(/received 0/);
  });
  it('rejects coins sent to a different wallet', async () => {
    await expect(verifyTicketPayment(cfg, SIG, MEMO, rpc(tx({ owner: 'SomeoneElseEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEE' })))).rejects.toThrow(/received 0/);
  });
  it('rejects a failed transaction', async () => {
    await expect(verifyTicketPayment(cfg, SIG, MEMO, rpc(tx({ err: { InstructionError: [0, 'Custom'] } })))).rejects.toThrow(/failed/);
  });
  it('treats a refusing / rate-limited RPC as "try again" (null), not a failure', async () => {
    for (const status of [403, 429, 503]) {
      const f = (async () => new Response('nope', { status })) as unknown as typeof fetch;
      expect(await verifyTicketPayment(cfg, SIG, MEMO, f)).toBeNull();
    }
    const down = (async () => {
      throw new Error('network down');
    }) as unknown as typeof fetch;
    expect(await verifyTicketPayment(cfg, SIG, MEMO, down)).toBeNull();
  });
  it('rejects something that is not a signature', async () => {
    await expect(verifyTicketPayment(cfg, 'not-a-sig', MEMO, rpc(tx()))).rejects.toThrow(/signature/);
  });
});
