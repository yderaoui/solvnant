import { describe, expect, it } from 'vitest';
import { coinPriceUsd, coinsFor } from '../src/game/solana';
import { splitPot } from '../src/game/lobbies';

const M = 'Mint1111111111111111111111111111111111111111';
function fakeFetch(jup: number | null, dex: number | null): typeof fetch {
  return (async (url: string) => {
    if (String(url).includes('jup.ag')) return new Response(JSON.stringify({ [M]: jup === null ? { decimals: 6 } : { usdPrice: jup } }));
    if (String(url).includes('dexscreener')) return new Response(JSON.stringify({ pairs: dex === null ? [] : [{ priceUsd: String(dex), liquidity: { usd: 5000 } }] }));
    throw new Error('unexpected ' + url);
  }) as unknown as typeof fetch;
}

describe('USD ticket pricing', () => {
  it('$20 at a cheap coin price: whole coins, rounded up', () => {
    expect(coinsFor(20, 0.0000675)).toBe(296297); // 296,296.3 -> 296,297 (never less than $20)
    expect(coinsFor(20, 0.5)).toBe(40);
    expect(coinsFor(20, 3)).toBe(6.666667); // pricey coin: 6 decimals, rounded up
    expect(coinsFor(20, 0.3)).toBe(66.67); // 66.666 -> 66.67
    expect(coinsFor(20, 0.0000675) * 0.0000675).toBeGreaterThanOrEqual(20);
  });

  it('uses the LOWER of the two prices (more coins, so a pumped market cannot make tickets cheap)', async () => {
    expect(await coinPriceUsd(M, fakeFetch(0.0001, 0.00008))).toBe(0.00008);
    expect(await coinPriceUsd(M, fakeFetch(0.00007, 0.0002))).toBe(0.00007);
  });

  it('one source down: uses the other; no market at all: null (the fixed coin price is used)', async () => {
    expect(await coinPriceUsd(M, fakeFetch(null, 0.00009))).toBe(0.00009);
    expect(await coinPriceUsd(M, fakeFetch(0.00009, null))).toBe(0.00009);
    expect(await coinPriceUsd(M, fakeFetch(null, null))).toBeNull();
  });

  it('splits the coins actually paid in: 80 / 15 / 5', () => {
    // 5 tickets bought at slightly different prices during the lobby
    const pot = 296297 + 290000 + 301500 + 299999 + 295000;
    const s = splitPot(pot);
    expect(s.pot).toBe(pot);
    expect(s.prize).toBeCloseTo(pot * 0.8, 5);
    expect(s.burn).toBeCloseTo(pot * 0.15, 5);
    expect(s.prize + s.burn + s.team).toBeCloseTo(pot, 6);
  });
});
