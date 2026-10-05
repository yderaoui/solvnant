// Sessions and X (Twitter) login. Sessions are HMAC-SHA256 signed tokens (no database lookup to
// verify), so the live room and the hub can both check them with the shared SESSION_SECRET.
// X login is OAuth 2.0 Authorization Code + PKCE; the verifier travels in a signed HttpOnly cookie.
import type { XConfig } from './config';

export interface Session {
  uid: string; // "x:<id>" or "g:<random>"
  name: string;
  kind: 'x' | 'guest';
  avatar?: string;
  exp: number; // epoch ms
}

const enc = new TextEncoder();
const dec = new TextDecoder();

export function b64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromB64url(s: string): Uint8Array {
  const b = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4));
  const out = new Uint8Array(b.length);
  for (let i = 0; i < b.length; i++) out[i] = b.charCodeAt(i);
  return out;
}

async function hmacKey(secret: string) {
  return crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

/** Sign any JSON payload: "<payload>.<signature>" (both base64url). */
export async function sign(payload: unknown, secret: string): Promise<string> {
  const body = b64url(enc.encode(JSON.stringify(payload)));
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', await hmacKey(secret), enc.encode(body)));
  return `${body}.${b64url(sig)}`;
}

export async function verify<T>(token: string | null | undefined, secret: string): Promise<T | null> {
  if (!token || typeof token !== 'string') return null;
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  try {
    const ok = await crypto.subtle.verify('HMAC', await hmacKey(secret), fromB64url(sig) as BufferSource, enc.encode(body));
    if (!ok) return null;
    return JSON.parse(dec.decode(fromB64url(body))) as T;
  } catch {
    return null;
  }
}

export const SESSION_DAYS = 30;

export async function signSession(s: Omit<Session, 'exp'>, secret: string, now = Date.now()): Promise<string> {
  return sign({ ...s, exp: now + SESSION_DAYS * 86400_000 } satisfies Session, secret);
}

export async function verifySession(token: string | null | undefined, secret: string, now = Date.now()): Promise<Session | null> {
  const s = await verify<Session>(token, secret);
  if (!s || typeof s.uid !== 'string' || typeof s.exp !== 'number' || s.exp < now) return null;
  return s;
}

export function bearer(req: Request): string | null {
  const h = req.headers.get('authorization') ?? '';
  return h.startsWith('Bearer ') ? h.slice(7).trim() : null;
}

export function randomToken(bytes = 32): string {
  return b64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

// ------------------------------------------------------------------ X OAuth 2.0 + PKCE

export async function pkceChallenge(verifier: string): Promise<string> {
  return b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(verifier))));
}

export function xAuthorizeUrl(x: XConfig, redirectUri: string, state: string, challenge: string): string {
  const u = new URL('https://x.com/i/oauth2/authorize');
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('client_id', x.clientId);
  u.searchParams.set('redirect_uri', redirectUri);
  u.searchParams.set('scope', 'users.read tweet.read');
  u.searchParams.set('state', state);
  u.searchParams.set('code_challenge', challenge);
  u.searchParams.set('code_challenge_method', 'S256');
  return u.toString();
}

export interface XUser {
  id: string;
  username: string;
  name: string;
  created_at?: string;
  profile_image_url?: string;
  public_metrics?: { followers_count?: number };
}

export async function xExchangeAndFetchUser(x: XConfig, code: string, verifier: string, redirectUri: string, fetchFn: typeof fetch = fetch): Promise<XUser> {
  const tokenRes = await fetchFn('https://api.x.com/2/oauth2/token', {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      authorization: `Basic ${btoa(`${x.clientId}:${x.clientSecret}`)}`,
    },
    body: new URLSearchParams({ code, grant_type: 'authorization_code', client_id: x.clientId, redirect_uri: redirectUri, code_verifier: verifier }),
  });
  if (!tokenRes.ok) throw new Error(`X token exchange failed (${tokenRes.status})`);
  const { access_token } = (await tokenRes.json()) as { access_token?: string };
  if (!access_token) throw new Error('X did not return an access token');
  const meRes = await fetchFn('https://api.x.com/2/users/me?user.fields=created_at,public_metrics,profile_image_url', {
    headers: { authorization: `Bearer ${access_token}` },
  });
  if (!meRes.ok) throw new Error(`X profile lookup failed (${meRes.status})`);
  const { data } = (await meRes.json()) as { data?: XUser };
  if (!data?.id) throw new Error('X returned no profile');
  return data;
}

/** Anti-bot rules for new accounts. Returns a reason when the account is too new / too empty. */
export function xAccountProblem(u: XUser, x: XConfig, now = Date.now()): string | null {
  if (u.created_at) {
    const days = (now - Date.parse(u.created_at)) / 86400_000;
    if (days < x.minAccountDays) return `Your X account must be at least ${x.minAccountDays} days old to race.`;
  }
  const followers = u.public_metrics?.followers_count ?? 0;
  if (followers < x.minFollowers) return `Your X account needs at least ${x.minFollowers} followers to race.`;
  return null;
}
