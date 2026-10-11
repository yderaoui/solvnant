import { PRIVATE_BUY_CHECK, validPrivateBuyProof } from '../src/game/privateBuyCheck';
import type { PublicConfig } from '../src/game/config';

interface Req { method?: string; headers: Record<string, string | string[] | undefined>; body?: unknown }
interface Res { setHeader(name: string, value: string): void; status(code: number): Res; json(body: unknown): unknown }
const GAME = 'https://ai-grand-prix-game.ai-grand-prix.workers.dev';
const ORIGINS = new Set(['https://www.pumpkart.racing', 'https://pumpkart.racing', 'https://solvnant.vercel.app', 'http://localhost:5173']);

// No signer, payment submission, ticket endpoint or production settings mutation exists here.
export default async function handler(req: Req, res: Res) {
  res.setHeader('cache-control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only.' });
  if (typeof req.headers.origin !== 'string' || !ORIGINS.has(req.headers.origin)) return res.status(403).json({ error: 'Open the test from the PumpKart site.' });
  const auth = req.headers.authorization;
  if (typeof auth !== 'string' || !auth.startsWith('Bearer ') || auth.length > 4096) return res.status(401).json({ error: 'Sign in to PumpKart first.' });
  try {
    const b = (typeof req.body === 'string' ? JSON.parse(req.body) : req.body) as Record<string, unknown> | null;
    if (!b || !['config', 'preflight'].includes(String(b.action))) return res.status(400).json({ error: 'Only the private coin-buy check is supported.' });
    if (Date.now() >= PRIVATE_BUY_CHECK.expiresAt) return res.status(409).json({ error: 'This temporary owner check has closed.' });
    if (!await validPrivateBuyProof(auth.slice(7), b.proof)) return res.status(403).json({ error: 'Verify the owner wallet again. No purchase was made.' });
    const who = await fetch(`${GAME}/api/me`, { headers: { authorization: auth }, signal: AbortSignal.timeout(8000) });
    if (!who.ok) return res.status(401).json({ error: 'Your game session expired. Open PumpKart again.' });
    const me = await who.json() as { kind?: string; id?: string };
    if (me.kind !== 'privy' || !me.id?.startsWith('privy:')) return res.status(403).json({ error: 'Use your existing X / Privy account.' });
    if (b.action === 'preflight') {
      if (b.purpose !== 'coin' || b.mint !== PRIVATE_BUY_CHECK.mint || b.coinRevision !== PRIVATE_BUY_CHECK.revision) return res.status(409).json({ error: 'This check only permits the selected test coin. Tickets and withdrawals are unavailable.' });
      return res.status(200).json({ ok: true });
    }
    const response = await fetch(`${GAME}/api/config`, { signal: AbortSignal.timeout(8000) });
    if (!response.ok) return res.status(503).json({ error: 'Could not load the game settings.' });
    const cfg = await response.json() as PublicConfig;
    const testCfg: PublicConfig & { sponsor: null } = {
      ...cfg, sponsor: null,
      tickets: { cluster: 'mainnet-beta', rpcUrl: 'https://solvnant.vercel.app/api/solana-rpc?cluster=mainnet-beta', mint: PRIVATE_BUY_CHECK.mint, symbol: '$RACE', decimals: 6, treasury: '11111111111111111111111111111111', price: 0 },
      coinLaunch: { status: 'live', revision: PRIVATE_BUY_CHECK.revision, buyEnabled: true },
    };
    return res.status(200).json(testCfg);
  } catch {
    return res.status(503).json({ error: 'The private check could not complete. No purchase was submitted by this server.' });
  }
}
