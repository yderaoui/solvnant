// Privy sign-in: check a Privy access token (ES256 JWT) against the app's public keys (JWKS), so the
// game can trust "this person is Privy user did:privy:…". No Privy secret is needed for this.
import { fromB64url } from './auth';

interface Jwk extends JsonWebKey {
  kid?: string;
}

let jwksCache: { appId: string; keys: Jwk[]; at: number } | null = null;

async function keysFor(appId: string, fetchFn: typeof fetch): Promise<Jwk[]> {
  if (jwksCache && jwksCache.appId === appId && Date.now() - jwksCache.at < 3600_000) return jwksCache.keys;
  const r = await fetchFn(`https://auth.privy.io/api/v1/apps/${encodeURIComponent(appId)}/jwks.json`);
  if (!r.ok) throw new Error(`Privy keys unavailable (${r.status})`);
  const keys = ((await r.json()) as { keys?: Jwk[] }).keys ?? [];
  jwksCache = { appId, keys, at: Date.now() };
  return keys;
}

/** Returns the Privy user id (did:privy:…) if the token is genuine and current, else null. */
export async function verifyPrivyToken(token: string, appId: string, fetchFn: typeof fetch = fetch, now = Date.now()): Promise<string | null> {
  const parts = String(token).split('.');
  if (parts.length !== 3) return null;
  let header: { alg?: string; kid?: string }, claims: { iss?: string; aud?: string | string[]; sub?: string; exp?: number };
  try {
    header = JSON.parse(new TextDecoder().decode(fromB64url(parts[0])));
    claims = JSON.parse(new TextDecoder().decode(fromB64url(parts[1])));
  } catch {
    return null;
  }
  if (header.alg !== 'ES256') return null;
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (claims.iss !== 'privy.io' || !aud.includes(appId) || !claims.sub || !claims.exp || claims.exp * 1000 < now) return null;
  const keys = await keysFor(appId, fetchFn);
  const jwk = keys.find((k) => !header.kid || k.kid === header.kid);
  if (!jwk) return null;
  const key = await crypto.subtle.importKey('jwk', { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y }, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  const ok = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, fromB64url(parts[2]) as BufferSource, new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
  return ok ? claims.sub : null;
}
