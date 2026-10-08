// Vercel serverless function: lets the game server (a Cloudflare Worker) read Solana transactions.
// Solana's public RPC refuses requests from Cloudflare Workers (403), but not from Vercel, so the
// ticket check goes through here. Read-only and locked down: one method, and a shared secret.
//   Env (Vercel project settings): RPC_PROXY_KEY (same value as the Worker's TICKET_VERIFY_KEY),
//   optional SOLANA_UPSTREAM_DEVNET / SOLANA_UPSTREAM_MAINNET (e.g. a Helius URL).
const UPSTREAM = {
  devnet: process.env.SOLANA_UPSTREAM_DEVNET || 'https://api.devnet.solana.com',
  'mainnet-beta': process.env.SOLANA_UPSTREAM_MAINNET || 'https://api.mainnet-beta.solana.com',
};

// What the players' browsers (and Privy's wallet) may ask for: reading balances and sending a signed payment.
const BROWSER_METHODS = new Set([
  'getAccountInfo', 'getBalance', 'getTokenAccountBalance', 'getLatestBlockhash', 'getMinimumBalanceForRentExemption',
  'getSignatureStatuses', 'getFeeForMessage', 'getRecentPrioritizationFees', 'sendTransaction', 'simulateTransaction',
  'getEpochInfo', 'getSlot', 'getBlockHeight', 'getGenesisHash', 'getVersion', 'getSignaturesForAddress', 'getTokenAccountsByOwner',
]);
const ORIGINS = ['https://www.racetrench.com', 'https://racetrench.com', 'https://solvnant.vercel.app', 'http://localhost:5173'];

export default async function handler(req, res) {
  const origin = req.headers.origin;
  if (ORIGINS.includes(origin)) {
    res.setHeader('access-control-allow-origin', origin);
    res.setHeader('access-control-allow-headers', 'content-type, solana-client');
    res.setHeader('access-control-allow-methods', 'POST, OPTIONS');
  }
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const key = process.env.RPC_PROXY_KEY;
  const server = !!key && req.headers['x-rpc-key'] === key;
  const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {};
  if (Array.isArray(body)) return res.status(400).json({ error: 'no batches' });
  const allowed = server ? body.method === 'getTransaction' || BROWSER_METHODS.has(body.method) : BROWSER_METHODS.has(body.method);
  if (!allowed) {
    console.log(`rpc refused method ${body.method}`);
    return res.status(server ? 400 : 401).json({ error: 'method not allowed' });
  }
  const cluster = req.query.cluster === 'mainnet-beta' ? 'mainnet-beta' : 'devnet';
  try {
    const r = await fetch(UPSTREAM[cluster], {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: body.id ?? 1, method: body.method, params: body.params }),
    });
    const text = await r.text();
    // Diagnostics for payments: which call, and the network's error if there was one.
    if (body.method !== 'getTransaction') {
      let err = null;
      try {
        err = JSON.parse(text).error ?? null;
      } catch {
        err = 'unparseable';
      }
      console.log(`rpc ${cluster} ${body.method} ${r.status}${err ? ' ERROR ' + JSON.stringify(err).slice(0, 400) : ''}`);
    }
    res.status(r.status).setHeader('content-type', 'application/json').send(text);
  } catch (e) {
    res.status(502).json({ error: 'upstream unreachable' });
  }
}
