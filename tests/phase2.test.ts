import { describe, expect, it } from 'vitest';
import { readConfig, publicConfig } from '../src/game/config';
import { signSession, verifySession, sign, verify, pkceChallenge, xAccountProblem } from '../src/game/auth';
import { base58Decode, base58Encode, isSolanaAddress, verifyWalletSignature, walletMessage } from '../src/game/solana';
import { prizeSplit, settlePool, poolOdds } from '../src/game/economy';

describe('config', () => {
  it('works with no settings (local dev) and never leaks secrets', () => {
    const c = readConfig({});
    expect(c.x).toBeNull();
    expect(c.allowGuests).toBe(true);
    expect(c.devSecret).toBe(true);
    expect(c.gate).toBeNull();
    const p = JSON.stringify(publicConfig(readConfig({ SESSION_SECRET: 's3cret', X_CLIENT_ID: 'id', X_CLIENT_SECRET: 'xsecret', SUPABASE_URL: 'https://a.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'srk' })));
    expect(p).not.toContain('s3cret');
    expect(p).not.toContain('xsecret');
    expect(p).not.toContain('srk');
  });
  it('turns guests off once X is configured, unless forced', () => {
    expect(readConfig({ X_CLIENT_ID: 'a', X_CLIENT_SECRET: 'b' }).allowGuests).toBe(false);
    expect(readConfig({ X_CLIENT_ID: 'a', X_CLIENT_SECRET: 'b', ALLOW_GUESTS: 'true' }).allowGuests).toBe(true);
    expect(readConfig({ TOKEN_MINT: 'So11111111111111111111111111111111111111112' }).gate?.minUsd).toBe(20);
  });
});

describe('sessions', () => {
  it('signs and verifies; rejects tampering, wrong secret and expiry', async () => {
    const t = await signSession({ uid: 'x:1', name: 'Nova', kind: 'x' }, 'k');
    expect((await verifySession(t, 'k'))?.uid).toBe('x:1');
    expect(await verifySession(t, 'other')).toBeNull();
    const [body, sig] = t.split('.');
    const forged = btoa(JSON.stringify({ uid: 'x:2', name: 'Evil', kind: 'x', exp: Date.now() + 1e9 })).replace(/=+$/, '');
    expect(await verifySession(`${forged}.${sig}`, 'k')).toBeNull();
    expect(await verifySession(`${body}.AAAA`, 'k')).toBeNull();
    expect(await verifySession(t, 'k', Date.now() + 31 * 86400_000)).toBeNull();
    expect(await verify(await sign({ a: 1 }, 'k'), 'k')).toEqual({ a: 1 });
  });
  it('PKCE challenge is the RFC 7636 S256 value', async () => {
    expect(await pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  });
  it('anti-bot: account age and followers', () => {
    const x = { clientId: '', clientSecret: '', minAccountDays: 30, minFollowers: 5 };
    const now = Date.parse('2026-10-05');
    expect(xAccountProblem({ id: '1', username: 'a', name: 'a', created_at: '2026-10-01T00:00:00Z', public_metrics: { followers_count: 100 } }, x, now)).toMatch(/30 days/);
    expect(xAccountProblem({ id: '1', username: 'a', name: 'a', created_at: '2020-01-01T00:00:00Z', public_metrics: { followers_count: 1 } }, x, now)).toMatch(/followers/);
    expect(xAccountProblem({ id: '1', username: 'a', name: 'a', created_at: '2020-01-01T00:00:00Z', public_metrics: { followers_count: 9 } }, x, now)).toBeNull();
  });
});

describe('wallet proofs', () => {
  it('base58 round-trips', () => {
    const b = new Uint8Array([0, 0, 1, 2, 3, 250, 255]);
    expect(base58Decode(base58Encode(b))).toEqual(b);
    expect(isSolanaAddress('So11111111111111111111111111111111111111112')).toBe(true);
    expect(isSolanaAddress('not-an-address')).toBe(false);
  });
  it('accepts a real Ed25519 signature from the wallet and rejects others', async () => {
    const kp = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])) as CryptoKeyPair;
    const pub = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey));
    const address = base58Encode(pub);
    const msg = walletMessage('x:1', 'n0nce');
    const sig = base58Encode(new Uint8Array(await crypto.subtle.sign('Ed25519', kp.privateKey, new TextEncoder().encode(msg))));
    expect(await verifyWalletSignature(address, msg, sig)).toBe(true);
    expect(await verifyWalletSignature(address, walletMessage('x:2', 'n0nce'), sig)).toBe(false);
    const other = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])) as CryptoKeyPair;
    const otherAddr = base58Encode(new Uint8Array(await crypto.subtle.exportKey('raw', other.publicKey)));
    expect(await verifyWalletSignature(otherAddr, msg, sig)).toBe(false);
  });
});

describe('points economy', () => {
  it('prize split 60/30/10, renormalised, never creates or loses points', () => {
    expect(prizeSplit(1000, 5)).toEqual([600, 300, 100, 0, 0]);
    expect(prizeSplit(100, 2)).toEqual([67, 33]);
    expect(prizeSplit(50, 1)).toEqual([50]);
    for (const pot of [1, 7, 99, 151, 1003]) for (const n of [1, 2, 3, 4, 10]) expect(prizeSplit(pot, n).reduce((a, b) => a + b, 0)).toBe(pot);
  });
  it('pool betting pays winners pro rata after rake; refunds when nobody backed the winner', () => {
    const bets = [
      { uid: 'a', pick: '1', amount: 100 },
      { uid: 'b', pick: '1', amount: 300 },
      { uid: 'c', pick: '2', amount: 600 },
    ];
    const r = settlePool(bets, '1', 5);
    expect(r.refunded).toBe(false);
    expect(r.payouts.get('a')).toBe(237); // 950 * 100/400
    expect(r.payouts.get('b')).toBe(712);
    expect(r.payouts.get('c')).toBeUndefined();
    expect([...r.payouts.values()].reduce((s, v) => s + v, 0) + r.rake).toBe(1000);
    const none = settlePool(bets, '3', 5);
    expect(none.refunded).toBe(true);
    expect(none.payouts.get('c')).toBe(600);
    expect(settlePool(bets, null, 5).payouts.get('a')).toBe(100);
    expect(poolOdds({ '1': 400, '2': 600, '3': 0 }, 5)).toEqual({ '1': 2.38, '2': 1.58, '3': null });
  });
});
