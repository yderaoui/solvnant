// Race tickets paid in the game coin. The player's wallet (Phantom) sends `price` coins to the
// treasury wallet with a one-time memo; the game server reads that transaction on-chain and credits
// one ticket. Joining a live race uses a ticket; leaving before lights out gives it back.
// No smart contract involved: it's a plain SPL token transfer the player approves in their wallet.
import { account } from "./account";
import type { TicketConfig } from "../game/config";

interface SolanaProvider {
  isPhantom?: boolean;
  publicKey?: { toString(): string } | null;
  connect(): Promise<{ publicKey: { toString(): string } }>;
  signAndSendTransaction(tx: unknown): Promise<{ signature: string }>;
}

const MEMO_PROGRAM = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";

export function walletProvider(): SolanaProvider | null {
  const w = window as unknown as {
    phantom?: { solana?: SolanaProvider };
    solana?: SolanaProvider;
  };
  return w.phantom?.solana ?? w.solana ?? null;
}

export const ticketsOn = () => !!account.cfg?.tickets;

/**
 * Buy one ticket. `step` reports progress for the UI. Resolves with the new ticket count.
 * Throws with a readable message (wallet missing, rejected, not enough coins, …).
 */
/** The wallet that pays: the Privy wallet when Privy is on, else Phantom (or another injected wallet). */
type Web3 = typeof import("@solana/web3.js");
interface Payer {
  address: string;
  /** Sign and send; `signed(sig)` is called as soon as the transaction's id is known (before sending). */
  send: (
    tx: import("@solana/web3.js").Transaction,
    conn: import("@solana/web3.js").Connection,
    signed: (sig: string) => void,
  ) => Promise<string>;
  /** Sign only (Privy): the game's server adds its signature as fee payer and sends it. */
  signOnly?: (tx: import("@solana/web3.js").Transaction) => Promise<Uint8Array>;
}

async function payer(): Promise<Payer> {
  const { privyOn, privyWallet } = await import("./privy/client");
  if (privyOn()) {
    const w = await privyWallet();
    const web3: Web3 = await import("@solana/web3.js");
    const { base58Encode } = await import("../game/solana");
    return {
      address: w.address,
      signOnly: (tx) =>
        w.sign(
          new Uint8Array(
            tx.serialize({
              requireAllSignatures: false,
              verifySignatures: false,
            }),
          ),
        ),
      // Privy only signs; we send it ourselves. Privy's own send-and-confirm reported failures for
      // payments that had in fact gone through (its confirmation step broke), so the game never
      // learned the transaction id.
      send: async (tx, conn, signed) => {
        const bytes = await w.sign(
          new Uint8Array(
            tx.serialize({
              requireAllSignatures: false,
              verifySignatures: false,
            }),
          ),
        );
        const sigBytes = web3.Transaction.from(bytes).signature;
        if (!sigBytes) throw new Error("The wallet did not sign the payment.");
        const sig = base58Encode(new Uint8Array(sigBytes));
        signed(sig);
        await conn.sendRawTransaction(bytes, {
          skipPreflight: false,
          maxRetries: 5,
        });
        return sig;
      },
    };
  }
  const provider = walletProvider();
  if (!provider)
    throw new Error(
      "No Solana wallet found. Install Phantom (phantom.app), then reload this page.",
    );
  const { publicKey } = await provider.connect();
  return {
    address: publicKey.toString(),
    send: async (tx, _conn, signed) => {
      const sig = (await provider.signAndSendTransaction(tx)).signature;
      signed(sig);
      return sig;
    },
  };
}

export async function buyTicket(step: (text: string) => void): Promise<number> {
  const r = await payCoins(
    "/api/ticket/intent",
    {},
    "/api/ticket/claim",
    "tl-pending-ticket",
    step,
  );
  return (r as { tickets?: number }).tickets ?? 0;
}

/** Buy a racer skin with the game coin (same payment as a ticket, the skin's own price). */
export async function buySkin(
  skin: string,
  step: (text: string) => void,
): Promise<void> {
  await payCoins(
    "/api/skin/intent",
    { skin },
    "/api/skin/claim",
    "tl-pending-skin",
    step,
  );
}

/**
 * Pay the treasury in the game coin and have the server credit it: `intentPath` returns the price and
 * a one-time memo, `claimPath` checks the transaction on-chain. Resolves with the claim's answer.
 */
async function payCoins(
  intentPath: string,
  intentBody: object,
  claimPath: string,
  pendingKey: string,
  step: (text: string) => void,
): Promise<object> {
  if (!account.me) throw new Error("Sign in first.");
  step("Connecting your wallet…");
  const wallet = await payer();
  const publicKey = { toString: () => wallet.address };
  const intent = await account.api<TicketConfig & { memo: string }>(
    intentPath,
    intentBody,
  );
  step("Preparing the payment…");
  // The Solana libraries expect Node's Buffer: give the browser one before loading them.
  const { Buffer } = await import("buffer");
  (globalThis as unknown as { Buffer: typeof Buffer }).Buffer ??= Buffer;
  const [{ Connection, PublicKey, Transaction, TransactionInstruction }, spl] =
    await Promise.all([import("@solana/web3.js"), import("@solana/spl-token")]);
  const conn = new Connection(intent.rpcUrl, "confirmed");
  const owner = new PublicKey(publicKey.toString());
  const mint = new PublicKey(intent.mint);
  const treasury = new PublicKey(intent.treasury);
  // The coin may be a classic SPL token or a Token-2022 one (newer pump.fun coins): ask the chain.
  const mintInfo = await conn.getAccountInfo(mint);
  if (!mintInfo)
    throw new Error(
      `Can't find the ${intent.symbol} coin on this network. Try again in a moment.`,
    );
  const programId = mintInfo.owner;
  const decimals = (await spl.getMint(conn, mint, "confirmed", programId))
    .decimals;
  const from = spl.getAssociatedTokenAddressSync(mint, owner, false, programId);
  const to = spl.getAssociatedTokenAddressSync(mint, treasury, true, programId);
  const units = BigInt(Math.floor(intent.price * 10 ** decimals + 1e-6)); // same rounding as the server
  // Sponsored gas: the game's house wallet pays the network fee, so players need no SOL.
  const sponsorAddr =
    (account.cfg as { sponsor?: string | null } | null)?.sponsor ?? null;
  const sponsor =
    sponsorAddr && wallet.signOnly ? new PublicKey(sponsorAddr) : null;
  if (!sponsor) {
    const lamports = await conn.getBalance(owner);
    if (lamports < 2_500_000)
      throw new Error(
        `Your wallet needs a little SOL for network fees (about 0.003 SOL). Send some to ${wallet.address} (copy it from your account menu).`,
      );
  }
  // Friendly errors before the wallet pops up
  try {
    const bal = await conn.getTokenAccountBalance(from);
    if (BigInt(bal.value.amount) < units)
      throw new Error(
        `You need ${intent.price} ${intent.symbol} in this wallet (you have ${bal.value.uiAmountString}).`,
      );
  } catch (e) {
    if (e instanceof Error && e.message.startsWith("You need")) throw e;
    throw new Error(
      `This wallet has no ${intent.symbol} yet${intent.cluster === "devnet" ? " (devnet test coins)" : ""}.`,
    );
  }
  const tx = new Transaction();
  if (sponsor) {
    // the house pays the fee (and creates its own coin account the very first time)
    if (!(await conn.getAccountInfo(to)))
      tx.add(
        spl.createAssociatedTokenAccountIdempotentInstruction(
          sponsor,
          to,
          treasury,
          mint,
          programId,
        ),
      );
  } else
    tx.add(
      spl.createAssociatedTokenAccountIdempotentInstruction(
        owner,
        to,
        treasury,
        mint,
        programId,
      ),
    ); // treasury's coin account, if new
  tx.add(
    spl.createTransferCheckedInstruction(
      from,
      mint,
      to,
      owner,
      units,
      decimals,
      [],
      programId,
    ),
  );
  tx.add(
    new TransactionInstruction({
      programId: new PublicKey(MEMO_PROGRAM),
      keys: [],
      data: Buffer.from(intent.memo, "utf8"),
    }),
  );
  tx.feePayer = sponsor ?? owner;
  tx.recentBlockhash = (await conn.getLatestBlockhash("confirmed")).blockhash;
  step(`Approve ${intent.price} ${intent.symbol} in your wallet…`);
  if (sponsor) {
    let signedTx: Uint8Array;
    try {
      signedTx = await wallet.signOnly!(tx);
    } catch (e) {
      const why = (e as Error).message ?? "";
      throw new Error(
        /reject|cancel|denied|closed/i.test(why)
          ? "You cancelled the payment."
          : `Wallet error: ${why}`,
      );
    }
    step("Sending (the game pays the network fee)…");
    const { signature } = await account.api<{ signature: string }>(
      "/api/pay/sponsor",
      { tx: Buffer.from(signedTx).toString("base64") },
    );
    return await confirm(signature);
  }
  let signature: string;
  let known: string | null = null;
  try {
    signature = await wallet.send(tx, conn, (sig) => {
      known = sig;
      remember(pendingKey, sig); // credited later even if this page closes now
    });
  } catch (e) {
    if (known) {
      // Signed, and the send reported a problem: it may still land. Let the server look for it.
      signature = known;
    } else {
      console.error(
        "payment: the wallet could not send",
        e,
        (e as { cause?: unknown }).cause,
      );
      const why = [
        (e as Error).message,
        String((e as { cause?: { message?: string } }).cause?.message ?? ""),
      ]
        .filter(Boolean)
        .join(" / ");
      throw new Error(
        /reject|cancel|denied|closed/i.test(why)
          ? "You cancelled the payment."
          : `Wallet error: ${why}`,
      );
    }
  }
  return await confirm(signature);

  async function confirm(signature: string): Promise<object> {
    step("Waiting for the network to confirm…");
    remember(pendingKey, signature);
    for (let i = 0; i < 30; i++) {
      let r: { ok: boolean; pending?: boolean };
      try {
        r = await account.api<{ ok: boolean; pending?: boolean }>(claimPath, {
          signature,
        });
      } catch (e) {
        const msg = (e as Error).message;
        if (/already used|memo|costs|failed on-chain|expired/i.test(msg))
          throw e; // a real problem with this payment
        r = { ok: false, pending: true }; // network hiccup: keep trying
      }
      if (r.ok) {
        remember(pendingKey, null);
        await account.refresh();
        return r;
      }
      await new Promise((res) => setTimeout(res, 2000));
    }
    throw new Error(
      `Payment sent but not confirmed yet. It will be credited when it confirms (transaction ${signature.slice(0, 8)}…).`,
    );
  }
}

function remember(key: string, sig: string | null) {
  try {
    if (sig) localStorage.setItem(key, sig);
    else localStorage.removeItem(key);
  } catch {
    /* ignore */
  }
}

/** Purchases whose confirmation we didn't see (tab closed, slow network): credit them now. */
export async function claimPendingTicket(): Promise<boolean> {
  const a = await claimPending("tl-pending-ticket", "/api/ticket/claim");
  const b = await claimPending("tl-pending-skin", "/api/skin/claim");
  return a || b;
}

async function claimPending(key: string, path: string): Promise<boolean> {
  let sig: string | null = null;
  try {
    sig = localStorage.getItem(key);
  } catch {
    return false;
  }
  if (!sig || !account.me || !ticketsOn()) return false;
  try {
    const r = await account.api<{ ok: boolean }>(path, { signature: sig });
    if (r.ok) {
      remember(key, null);
      await account.refresh();
      return true;
    }
  } catch {
    remember(key, null); // expired or invalid: don't keep retrying
  }
  return false;
}

/** Devnet only: ask the site's faucet for free test coins (and a little test SOL for fees). */
export async function getTestCoins(
  step: (text: string) => void,
): Promise<string> {
  step("Connecting your wallet…");
  const wallet = await payer();
  const publicKey = { toString: () => wallet.address };
  step("Sending you test coins (about 10 s)…");
  const base =
    location.hostname === "localhost" || location.hostname === "127.0.0.1"
      ? "https://solvnant.vercel.app"
      : "";
  const r = await fetch(`${base}/api/faucet`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ address: publicKey.toString() }),
  });
  const j = (await r.json().catch(() => ({}))) as {
    ok?: boolean;
    coins?: number;
    sol?: number;
    error?: string;
  };
  if (!r.ok || !j.ok) throw new Error(j.error ?? `Faucet error ${r.status}`);
  const sym = account.cfg?.tickets?.symbol ?? "$TRACK";
  const privy = (await import("./privy/client")).privyOn();
  return `Received ${j.coins} test ${sym}${j.sol ? ` and ${j.sol} test SOL for fees` : ""}.${privy ? " You can buy a ticket now." : " Switch Phantom to the test network (Settings → Developer settings → Testnet mode → Solana Devnet) to see them."}`;
}

/**
 * Payments that reached the treasury but were never credited (the page closed, or the wallet reported
 * an error after sending): list this wallet's recent RaceTrench payments and let the server credit them.
 * Resolves with what was recovered.
 */
export async function recoverPayments(): Promise<{
  tickets: number;
  skins: string[];
}> {
  const none = { tickets: 0, skins: [] as string[] };
  const t = account.cfg?.tickets;
  if (!t || !account.me) return none;
  const { privyOn, privyWallet } = await import("./privy/client");
  if (!privyOn()) return none;
  const w = await privyWallet(15_000);
  const r = await fetch(t.rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "getSignaturesForAddress",
      params: [w.address, { limit: 25 }],
    }),
  });
  const list =
    (
      (await r.json()) as {
        result?: {
          signature: string;
          err: unknown;
          memo: string | null;
          blockTime: number | null;
        }[];
      }
    ).result ?? [];
  const weekAgo = Date.now() / 1000 - 7 * 86400;
  const sigs = list
    .filter(
      (x) =>
        !x.err &&
        x.memo?.includes("RaceTrench ") &&
        (x.blockTime ?? 0) > weekAgo,
    )
    .map((x) => x.signature);
  if (!sigs.length) return none;
  const res = await account.api<{
    tickets: number;
    skins: string[];
    me: import("./account").Me;
  }>("/api/pay/recover", { signatures: sigs });
  if (res.me) account.setMe(res.me);
  return { tickets: res.tickets, skins: res.skins };
}

/** The game wallet's coin balance (for the account menu). */
export async function coinBalance(): Promise<number | null> {
  const t = account.cfg?.tickets;
  if (!t) return null;
  const { privyWallet } = await import('./privy/client');
  const w = await privyWallet(15_000);
  const r = await fetch(t.rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getTokenAccountsByOwner', params: [w.address, { mint: t.mint }, { encoding: 'jsonParsed' }] }),
  });
  const v = ((await r.json()) as { result?: { value: { account: { data: { parsed: { info: { tokenAmount: { uiAmount: number } } } } } }[] } }).result?.value ?? [];
  return v.reduce((s, a) => s + (a.account.data.parsed.info.tokenAmount.uiAmount ?? 0), 0);
}

/** Send coins out of the game wallet to any Solana address. The game pays the fee when it can. */
export async function withdrawCoins(to: string, amount: number, step: (text: string) => void): Promise<string> {
  const t = account.cfg?.tickets;
  if (!t || !account.me) throw new Error('Sign in first.');
  if (!(amount > 0)) throw new Error('Enter an amount.');
  step('Preparing…');
  const { Buffer } = await import('buffer');
  (globalThis as unknown as { Buffer: typeof Buffer }).Buffer ??= Buffer;
  const [{ Connection, PublicKey, Transaction }, spl] = await Promise.all([import('@solana/web3.js'), import('@solana/spl-token')]);
  let dest: InstanceType<typeof PublicKey>;
  try {
    dest = new PublicKey(to.trim());
  } catch {
    throw new Error('That is not a Solana address.');
  }
  const wallet = await payer();
  const conn = new Connection(t.rpcUrl, 'confirmed');
  const owner = new PublicKey(wallet.address);
  const mint = new PublicKey(t.mint);
  const programId = (await conn.getAccountInfo(mint))!.owner;
  const decimals = (await spl.getMint(conn, mint, 'confirmed', programId)).decimals;
  const from = spl.getAssociatedTokenAddressSync(mint, owner, false, programId);
  const toAta = spl.getAssociatedTokenAddressSync(mint, dest, true, programId);
  const units = BigInt(Math.floor(amount * 10 ** decimals + 1e-6));
  const bal = BigInt((await conn.getTokenAccountBalance(from)).value.amount);
  if (bal < units) throw new Error(`You only have ${Number(bal) / 10 ** decimals} ${t.symbol}.`);
  const sponsorAddr = (account.cfg as { sponsor?: string | null } | null)?.sponsor ?? null;
  const sponsor = sponsorAddr && wallet.signOnly ? new PublicKey(sponsorAddr) : null;
  const tx = new Transaction();
  if (!(await conn.getAccountInfo(toAta))) tx.add(spl.createAssociatedTokenAccountIdempotentInstruction(sponsor ?? owner, toAta, dest, mint, programId));
  tx.add(spl.createTransferCheckedInstruction(from, mint, toAta, owner, units, decimals, [], programId));
  tx.feePayer = sponsor ?? owner;
  tx.recentBlockhash = (await conn.getLatestBlockhash('confirmed')).blockhash;
  step(`Approve sending ${amount.toLocaleString('en-US')} ${t.symbol} in your wallet…`);
  let sig: string;
  if (sponsor) {
    const signedTx = await wallet.signOnly!(tx);
    step('Sending (the game pays the network fee)…');
    sig = (await account.api<{ signature: string }>('/api/pay/withdraw', { tx: Buffer.from(signedTx).toString('base64') })).signature;
  } else sig = await wallet.send(tx, conn, () => {});
  step('Waiting for the network to confirm…');
  for (let i = 0; i < 40; i++) {
    const s = (await conn.getSignatureStatuses([sig])).value[0];
    if (s?.err) throw new Error('The withdrawal failed on-chain.');
    if (s && (s.confirmationStatus === 'confirmed' || s.confirmationStatus === 'finalized')) return sig;
    await new Promise((r) => setTimeout(r, 1500));
  }
  return sig; // sent; the explorer link shows it once it confirms
}
