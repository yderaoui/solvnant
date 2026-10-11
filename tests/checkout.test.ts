import { beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ api: vi.fn(), sign: vi.fn() }));
vi.mock('../src/client/account', () => ({ account: {
  me: { id: 'checkout-test' }, cfg: { sponsor: 'public-sponsor-address' }, api: mocks.api,
} }));
vi.mock('../src/client/privy/client', () => ({
  privyOn: () => true,
  privyWallet: async () => ({ address: 'public-player-address', sign: mocks.sign }),
}));
vi.mock('@solana/web3.js', () => ({}));
vi.mock('../src/game/solana', () => ({ base58Encode: vi.fn() }));

import { buyTicket } from '../src/client/tickets';

beforeEach(() => vi.clearAllMocks());

it('shows the server quote and stops before signing or claiming when checkout is cancelled', async () => {
  const quote = { memo: 'PumpKart ticket test', price: 1234.56789, usd: 20, symbol: '$TEST', decimals: 6 };
  mocks.api.mockResolvedValue(quote);
  const review = vi.fn(async () => { throw new Error('Checkout closed'); });
  await expect(buyTicket(vi.fn(), review)).rejects.toThrow('Checkout closed');
  expect(review).toHaveBeenCalledWith(quote, 'public-player-address', true);
  expect(mocks.api).toHaveBeenCalledTimes(1);
  expect(mocks.api).toHaveBeenCalledWith('/api/ticket/intent', { coinRevision: undefined });
  expect(mocks.sign).not.toHaveBeenCalled();
});

it('refuses a regular ticket quote for a friend lobby before review or signing', async () => {
  mocks.api.mockResolvedValue({ memo: 'legacy-ticket', price: 2000, usd: 20 });
  const review = vi.fn();
  await expect(buyTicket(vi.fn(), review, 'ABCDEFGH')).rejects.toThrow('No payment was made');
  expect(mocks.api).toHaveBeenCalledWith('/api/ticket/intent', { code: 'ABCDEFGH', coinRevision: undefined });
  expect(mocks.api).toHaveBeenCalledTimes(1);
  expect(review).not.toHaveBeenCalled();
  expect(mocks.sign).not.toHaveBeenCalled();
});

it('reviews the exact friend-lobby quote and allows cancellation without payment', async () => {
  const quote = { memo: 'friend-entry', code: 'ABCDEFGH', entryUnits: '1250000000', price: 1250, usd: 12.5, symbol: '$TEST', decimals: 6 };
  mocks.api.mockResolvedValue(quote);
  const review = vi.fn(async () => { throw new Error('Checkout closed'); });
  await expect(buyTicket(vi.fn(), review, 'ABCDEFGH')).rejects.toThrow('Checkout closed');
  expect(review).toHaveBeenCalledWith(quote, 'public-player-address', true);
  expect(mocks.api).toHaveBeenCalledWith('/api/ticket/intent', { code: 'ABCDEFGH', coinRevision: undefined });
  expect(mocks.api).toHaveBeenCalledTimes(1);
  expect(mocks.sign).not.toHaveBeenCalled();
});
