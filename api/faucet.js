// Vercel serverless function: free TEST coins on Solana devnet, so testers can buy race tickets.
// Sends 1,000 test coins (and a little devnet SOL for fees if the wallet has none). Devnet only:
// the coins have no value. Refuses wallets that already hold plenty, to keep the faucet from draining.
//   Env: FAUCET_SECRET (the test coin's mint authority secret key, JSON array), FAUCET_MINT,
//        optional FAUCET_DECIMALS (6), SOLANA_UPSTREAM_DEVNET (RPC URL).
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction } from '@solana/web3.js';
import { createAssociatedTokenAccountIdempotentInstruction, createMintToInstruction, getAssociatedTokenAddressSync } from '@solana/spl-token';

const COINS = 1000;
const SOL_GIFT = 0.01; // enough for many ticket payments' fees

export default async function handler(req, res) {
  res.setHeader('access-control-allow-origin', '*');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  if (!process.env.FAUCET_SECRET || !process.env.FAUCET_MINT) return res.status(503).json({ error: 'The test-coin faucet is not set up.' });
  const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {};
  let to;
  try {
    to = new PublicKey(String(body.address ?? ''));
  } catch {
    return res.status(400).json({ error: 'That is not a Solana wallet address.' });
  }
  const conn = new Connection(process.env.SOLANA_UPSTREAM_DEVNET || 'https://api.devnet.solana.com', 'confirmed');
  const authority = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(process.env.FAUCET_SECRET)));
  const mint = new PublicKey(process.env.FAUCET_MINT);
  const decimals = Number(process.env.FAUCET_DECIMALS || 6);
  const ata = getAssociatedTokenAddressSync(mint, to);
  try {
    const have = await conn.getTokenAccountBalance(ata).then((b) => b.value.uiAmount ?? 0).catch(() => 0);
    if (have >= 500) return res.status(429).json({ error: `This wallet already has ${have} test coins. That's plenty for testing.` });
    const tx = new Transaction()
      .add(createAssociatedTokenAccountIdempotentInstruction(authority.publicKey, ata, to, mint))
      .add(createMintToInstruction(mint, ata, authority.publicKey, BigInt(COINS) * 10n ** BigInt(decimals)));
    const sol = await conn.getBalance(to);
    if (sol < 0.005 * LAMPORTS_PER_SOL) tx.add(SystemProgram.transfer({ fromPubkey: authority.publicKey, toPubkey: to, lamports: SOL_GIFT * LAMPORTS_PER_SOL }));
    const signature = await sendAndConfirmTransaction(conn, tx, [authority], { commitment: 'confirmed' });
    return res.status(200).json({ ok: true, coins: COINS, sol: sol < 0.005 * LAMPORTS_PER_SOL ? SOL_GIFT : 0, signature });
  } catch (e) {
    return res.status(502).json({ error: `The test network is busy, try again in a minute (${String(e.message || e).slice(0, 80)}).` });
  }
}
