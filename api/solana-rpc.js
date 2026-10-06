// Vercel serverless function: lets the game server (a Cloudflare Worker) read Solana transactions.
// Solana's public RPC refuses requests from Cloudflare Workers (403), but not from Vercel, so the
// ticket check goes through here. Read-only and locked down: one method, and a shared secret.
//   Env (Vercel project settings): RPC_PROXY_KEY (same value as the Worker's TICKET_VERIFY_KEY),
//   optional SOLANA_UPSTREAM_DEVNET / SOLANA_UPSTREAM_MAINNET (e.g. a Helius URL).
const UPSTREAM = {
  devnet: process.env.SOLANA_UPSTREAM_DEVNET || 'https://api.devnet.solana.com',
  'mainnet-beta': process.env.SOLANA_UPSTREAM_MAINNET || 'https://api.mainnet-beta.solana.com',
};

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const key = process.env.RPC_PROXY_KEY;
  if (!key || req.headers['x-rpc-key'] !== key) return res.status(401).json({ error: 'unauthorized' });
  const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {};
  if (body.method !== 'getTransaction') return res.status(400).json({ error: 'only getTransaction is allowed' });
  const cluster = req.query.cluster === 'mainnet-beta' ? 'mainnet-beta' : 'devnet';
  try {
    const r = await fetch(UPSTREAM[cluster], {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getTransaction', params: body.params }),
    });
    res.status(r.status).setHeader('content-type', 'application/json').send(await r.text());
  } catch (e) {
    res.status(502).json({ error: 'upstream unreachable' });
  }
}
