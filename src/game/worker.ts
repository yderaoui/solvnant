// Cloudflare Worker entry.
//   /ws              live race room (WebSocket)
//   /api/*           accounts, points, bets, wallet (Hub Durable Object)
//   /auth/x/start    "Sign in with X" (OAuth 2.0 + PKCE)
//   /auth/x/callback X sends people back here; we create the account and hand the browser a session
export { GameRoom } from './room';
export { Hub } from './hub';
import { readConfig } from './config';
import { pkceChallenge, randomToken, sign, signSession, verify, xAccountProblem, xAuthorizeUrl, xExchangeAndFetchUser } from './auth';

interface DONamespace {
  idFromName(name: string): unknown;
  get(id: unknown): { fetch(req: Request): Promise<Response> };
}
interface Env {
  ROOM: DONamespace;
  HUB: DONamespace;
  [k: string]: unknown;
}

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'authorization, content-type',
  'access-control-max-age': '86400',
};

function withCors(r: Response): Response {
  const h = new Headers(r.headers);
  for (const [k, v] of Object.entries(CORS)) h.set(k, v);
  return new Response(r.body, { status: r.status, headers: h });
}

export function hubStub(env: Env) {
  return env.HUB.get(env.HUB.idFromName('hub'));
}

const strEnv = (env: Env) => Object.fromEntries(Object.entries(env).filter(([, v]) => typeof v === 'string')) as Record<string, string>;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const cfg = readConfig(strEnv(env));
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    if (url.pathname === '/ws') return env.ROOM.get(env.ROOM.idFromName('main')).fetch(request);
    if (url.pathname === '/health') return new Response('ok');
    if (url.pathname.startsWith('/api/')) return withCors(await hubStub(env).fetch(request));

    // ---------------------------------------------------------------- Sign in with X
    if (url.pathname === '/auth/x/start') {
      if (!cfg.x) return Response.redirect(`${cfg.siteUrl}/#/auth?error=${encodeURIComponent('X login is not set up on this server yet.')}`, 302);
      const verifier = randomToken(48);
      const state = randomToken(16);
      const cookie = await sign({ state, verifier, exp: Date.now() + 10 * 60_000 }, cfg.sessionSecret);
      const redirect = `${url.origin}/auth/x/callback`;
      return new Response(null, {
        status: 302,
        headers: {
          location: xAuthorizeUrl(cfg.x, redirect, state, await pkceChallenge(verifier)),
          'set-cookie': `xauth=${cookie}; Path=/auth/x; HttpOnly; Secure; SameSite=Lax; Max-Age=600`,
        },
      });
    }
    if (url.pathname === '/auth/x/callback') {
      const back = (q: string) =>
        new Response(null, { status: 302, headers: { location: `${cfg.siteUrl}/#/auth?${q}`, 'set-cookie': 'xauth=; Path=/auth/x; Max-Age=0' } });
      if (!cfg.x) return back(`error=${encodeURIComponent('X login is not set up.')}`);
      const raw = /(?:^|;\s*)xauth=([^;]+)/.exec(request.headers.get('cookie') ?? '')?.[1];
      const saved = await verify<{ state: string; verifier: string; exp: number }>(raw, cfg.sessionSecret);
      const code = url.searchParams.get('code');
      if (url.searchParams.get('error')) return back(`error=${encodeURIComponent('X login was cancelled.')}`);
      if (!saved || saved.exp < Date.now() || saved.state !== url.searchParams.get('state') || !code)
        return back(`error=${encodeURIComponent('Login expired. Please try again.')}`);
      try {
        const u = await xExchangeAndFetchUser(cfg.x, code, saved.verifier, `${url.origin}/auth/x/callback`);
        const problem = xAccountProblem(u, cfg.x);
        if (problem) return back(`error=${encodeURIComponent(problem)}`);
        await hubStub(env).fetch(
          new Request('https://hub/internal/upsert-x', {
            method: 'POST',
            body: JSON.stringify({ id: u.id, handle: u.username, name: u.name || u.username, avatar: u.profile_image_url ?? null }),
          }),
        );
        const token = await signSession({ uid: `x:${u.id}`, name: u.username, kind: 'x', avatar: u.profile_image_url }, cfg.sessionSecret);
        return back(`token=${encodeURIComponent(token)}`);
      } catch (e) {
        return back(`error=${encodeURIComponent(e instanceof Error ? e.message : 'X login failed.')}`);
      }
    }
    return new Response('TrackLab 3D game server. WebSocket: /ws  API: /api/*', { headers: { 'content-type': 'text/plain' } });
  },
};
