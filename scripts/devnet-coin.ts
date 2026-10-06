// Devnet setup for coin tickets: a TEST version of the game coin on Solana devnet (no real value).
//   npx tsx scripts/devnet-coin.ts                 create (or reuse) the test coin + test wallets
//   npx tsx scripts/devnet-coin.ts mint <wallet> [amount]   send test coins to a wallet (e.g. your Phantom)
// Keys are saved in .devnet/ (git-ignored). Never use these keys on mainnet.
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction, clusterApiUrl, sendAndConfirmTransaction } from '@solana/web3.js';
import { createMint, getOrCreateAssociatedTokenAccount, mintTo } from '@solana/spl-token';

const DIR = '.devnet';
const DECIMALS = 6;
const conn = new Connection(process.env.SOLANA_RPC_URL || clusterApiUrl('devnet'), 'confirmed');

function keypair(name: string): Keypair {
  const p = `${DIR}/${name}.json`;
  if (existsSync(p)) return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(p, 'utf8'))));
  const k = Keypair.generate();
  writeFileSync(p, JSON.stringify([...k.secretKey]));
  return k;
}

async function fund(k: Keypair, min = 0.5, from?: Keypair) {
  const bal = (await conn.getBalance(k.publicKey)) / LAMPORTS_PER_SOL;
  if (bal >= min) return;
  if (from) {
    // top up from a funded wallet instead of the (often rate-limited) faucet
    const tx = new Transaction().add(SystemProgram.transfer({ fromPubkey: from.publicKey, toPubkey: k.publicKey, lamports: Math.round(min * LAMPORTS_PER_SOL) }));
    await sendAndConfirmTransaction(conn, tx, [from]);
    console.log(`  sent ${min} devnet SOL to ${k.publicKey.toBase58()}`);
    return;
  }
  console.log(`  airdropping devnet SOL to ${k.publicKey.toBase58()}…`);
  let sig = "";
  for (let t = 0; t < 4 && !sig; t++) {
    try {
      sig = await conn.requestAirdrop(k.publicKey, 0.5 * LAMPORTS_PER_SOL);
    } catch (e) {
      console.log(`  faucet refused (${(e as Error).message.slice(0, 60)}), retrying…`);
      await new Promise((r) => setTimeout(r, 4000 * (t + 1)));
    }
  }
  if (!sig) throw new Error(`devnet faucet unavailable: send some devnet SOL to ${k.publicKey.toBase58()} (https://faucet.solana.com) and run again`);
  await conn.confirmTransaction(sig, 'confirmed');
}

async function main() {
  mkdirSync(DIR, { recursive: true });
  const authority = keypair('coin-authority');
  await fund(authority);
  let mint: PublicKey;
  if (existsSync(`${DIR}/mint.txt`)) mint = new PublicKey(readFileSync(`${DIR}/mint.txt`, 'utf8').trim());
  else {
    mint = await createMint(conn, authority, authority.publicKey, null, DECIMALS);
    writeFileSync(`${DIR}/mint.txt`, mint.toBase58());
    console.log('created test coin', mint.toBase58());
  }
  const [cmd, wallet, amount] = process.argv.slice(2);
  if (cmd === 'mint') {
    const to = new PublicKey(wallet);
    const ata = await getOrCreateAssociatedTokenAccount(conn, authority, mint, to);
    await mintTo(conn, authority, mint, ata.address, authority, BigInt(Number(amount ?? 10000) * 10 ** DECIMALS));
    console.log(`sent ${amount ?? 10000} test coins to ${to.toBase58()}`);
    return;
  }
  const treasury = keypair('treasury');
  const player = keypair('test-player');
  await fund(player, 0.05, authority);
  const pAta = await getOrCreateAssociatedTokenAccount(conn, authority, mint, player.publicKey);
  if (Number(pAta.amount) < 1000 * 10 ** DECIMALS) await mintTo(conn, authority, mint, pAta.address, authority, BigInt(10000 * 10 ** DECIMALS));
  console.log(JSON.stringify({ cluster: 'devnet', mint: mint.toBase58(), decimals: DECIMALS, treasury: treasury.publicKey.toBase58(), testPlayer: player.publicKey.toBase58() }, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
