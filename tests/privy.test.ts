// Privy sign-in: the server only trusts access tokens signed by the app's Privy key (ES256 / JWKS).
import { beforeAll, describe, expect, it } from 'vitest';
import { verifyPrivyToken } from '../src/game/privy';
import { b64url } from '../src/game/auth';

const APP = 'cmuxzi8fk01ja0bjtygjpghge';
let keys: CryptoKeyPair, other: CryptoKeyPair, jwks: unknown;

async function token(claims: Record<string, unknown>, key = keys.privateKey, kid = 'k1') {
  const enc = (o: unknown) => b64url(new TextEncoder().encode(JSON.stringify(o)));
  const head = enc({ alg: 'ES256', typ: 'JWT', kid });
  const body = enc(claims);
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, new TextEncoder().encode(`${head}.${body}`)));
  return `${head}.${body}.${b64url(sig)}`;
}
const good = (over: Record<string, unknown> = {}) => ({ iss: 'privy.io', aud: APP, sub: 'did:privy:abc123', exp: Math.floor(Date.now() / 1000) + 3600, ...over });
const fetchJwks = (async () => new Response(JSON.stringify(jwks))) as unknown as typeof fetch;

beforeAll(async () => {
  keys = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair;
  other = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair;
  jwks = { keys: [{ ...(await crypto.subtle.exportKey('jwk', keys.publicKey)), kid: 'k1' }] };
});

describe('Privy sign-in tokens', () => {
  it('accepts a token signed by the app key and returns the Privy user id', async () => {
    expect(await verifyPrivyToken(await token(good()), APP, fetchJwks)).toBe('did:privy:abc123');
  });
  it('rejects a token signed by another key (forged)', async () => {
    expect(await verifyPrivyToken(await token(good(), other.privateKey), APP, fetchJwks)).toBeNull();
  });
  it('rejects an expired token', async () => {
    expect(await verifyPrivyToken(await token(good({ exp: Math.floor(Date.now() / 1000) - 10 })), APP, fetchJwks)).toBeNull();
  });
  it('rejects a token for another Privy app', async () => {
    expect(await verifyPrivyToken(await token(good({ aud: 'some-other-app' })), APP, fetchJwks)).toBeNull();
  });
  it('rejects a token not issued by Privy', async () => {
    expect(await verifyPrivyToken(await token(good({ iss: 'evil.example' })), APP, fetchJwks)).toBeNull();
  });
  it('rejects garbage', async () => {
    expect(await verifyPrivyToken('not.a.jwt', APP, fetchJwks)).toBeNull();
    expect(await verifyPrivyToken('', APP, fetchJwks)).toBeNull();
  });
});
