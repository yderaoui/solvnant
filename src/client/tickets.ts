// Race tickets paid in the game coin. The player's wallet sends the quoted coins to the
// treasury with a one-time memo; the game server verifies the transfer and credits one ticket
// or an invite-bound entry. Live/play-point races do not consume coin tickets.
// No smart contract involved: it's a plain SPL token transfer the player approves in their wallet.
import { account } from "./account";
import type { TicketConfig } from "../game/config";
import { hasPurchaseMemo } from "../game/purchaseMemo";
import { withPaymentLock } from './paymentLock';

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

export async function payer(): Promise<Payer> {
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

export type PaymentReview = (quote: TicketConfig & { usd?: number | null }, address: string, sponsored: boolean) => Promise<void>;

export async function buyTicket(step: (text: string) => void, review?: PaymentReview, code?: string): Promise<number> {
  const r = await payCoins(
    "/api/ticket/intent",
    code ? { code } : {},
    "/api/ticket/claim",
    "tl-pending-ticket",
    step,
    review,
  );
  if (code) {
    const entry = r as { entryReady?: boolean; refunded?: boolean };
    if (!entry.entryReady) throw new Error(entry.refunded ? 'This entry could not be accepted. A full coin refund is queued to the wallet that paid.' : 'Open your friend lobby to check your entry.');
    return 1;
  }
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
  review?: PaymentReview,
): Promise<object> {
  if (!account.me) throw new Error("Sign in first.");
  const uid = account.me.id;
  const scopedKey = `${pendingKey}:${uid}`;
  return await withPaymentLock(uid, async () => {
    const previous = await claimSaved(scopedKey, claimPath, uid);
    if (previous) return previous;
    const pending = paymentSignature(scopedKey);
    if (pending) throw new Error(`Your earlier payment is still being checked. Do not pay again. Transaction: ${pending}`);
    return await sendPayment(scopedKey, uid);
  });

  async function sendPayment(pendingKey: string, uid: string): Promise<object> {
    step("Connecting your wallet…");
    const wallet = await payer();
    const publicKey = { toString: () => wallet.address };
    const intent = await account.api<TicketConfig & { memo: string; code?: string; entryUnits?: string }>(
      intentPath,
      { ...intentBody, coinRevision: account.cfg?.coinLaunch?.revision },
    );
    const expectedCode = (intentBody as { code?: string }).code;
    if (expectedCode && (intent.code !== expectedCode || !/^\d+$/.test(intent.entryUnits ?? '') || BigInt(intent.entryUnits!) <= 0n)) {
      throw new Error('This game server needs the friend-lobby update. No payment was made.');
    }
    if (review) await review(intent, wallet.address, !!(account.cfg as { sponsor?: string | null } | null)?.sponsor && !!wallet.signOnly);
    const coinRevision = (intent as TicketConfig & { coinRevision?: string }).coinRevision;
    await account.api('/api/coin/preflight', { mint: intent.mint, coinRevision, purpose: 'ticket', memo: intent.memo });
    step("Preparing the payment…");
    // The Solana libraries expect Node's Buffer: give the browser one before loading them.
    const { Buffer } = await import("buffer");
    (globalThis as unknown as { Buffer: typeof Buffer }).Buffer ??= Buffer;
    const [{ Connection, PublicKey, Transaction, TransactionInstruction }, spl] =
      await Promise.all([import("@solana/web3.js"), import("@solana/spl-token")]);
    const conn = new Connection(intent.rpcUrl, { commitment: 'confirmed', disableRetryOnRateLimit: true,
      fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(15_000) }) });
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
    const exactUnits = (intent as TicketConfig & { entryUnits?: string }).entryUnits;
    const units = exactUnits ? BigInt(exactUnits) : BigInt(Math.floor(intent.price * 10 ** decimals + 1e-6));
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
    const latest = await conn.getLatestBlockhash("confirmed");
    tx.recentBlockhash = latest.blockhash;
    await account.api('/api/coin/preflight', { mint: intent.mint, coinRevision, purpose: 'ticket', memo: intent.memo });
    if (account.me?.id !== uid) throw new Error('Account changed. Open checkout again. Nothing was sent.');
    step(`Approve ${intent.price.toLocaleString('en-US')} ${intent.symbol}${(intent as { usd?: number | null }).usd ? ` (≈ $${(intent as { usd?: number }).usd})` : ''} in your wallet…`);
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
      if (account.me?.id !== uid) throw new Error('Account changed during approval. Nothing was sent.');
      step('Preparing your signed payment…');
      const prepared = await account.api<{ signature: string; wire?: string }>(
        "/api/pay/sponsor",
        { tx: Buffer.from(signedTx).toString("base64"), coinRevision, prepareOnly: true },
      );
      const wire = await preparedWire(prepared, tx);
      await account.api('/api/coin/preflight', { mint: intent.mint, coinRevision, purpose: 'ticket', memo: intent.memo });
      if (account.me?.id !== uid) throw new Error('Account changed during approval. Nothing was sent.');
      rememberPurchase(pendingKey, prepared.signature);
      step('Sending (the game pays the network fee)…');
      try { await conn.sendRawTransaction(wire, { skipPreflight: false, maxRetries: 5 }); }
      catch { /* The saved signature, not a second approval, determines the outcome. */ }
      return await confirm(prepared.signature);
    }
    let signature: string;
    let known: string | null = null;
    await account.api('/api/coin/preflight', { mint: intent.mint, coinRevision, purpose: 'ticket', memo: intent.memo });
    try {
      signature = await wallet.send(tx, conn, (sig) => {
        known = sig;
        rememberPurchase(pendingKey, sig); // credited later even if this page closes now
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
      rememberPurchase(pendingKey, signature);
      for (let i = 0; i < 30; i++) {
        let r: { ok: boolean; pending?: boolean };
        try {
          r = await account.api<{ ok: boolean; pending?: boolean }>(claimPath, {
            signature,
          });
        } catch (e) {
          const msg = (e as Error).message;
          if (/already used|memo|costs|failed on-chain|expired/i.test(msg)) {
            if (/failed on-chain/i.test(msg)) remember(pendingKey, null);
            throw e; // a real problem with this payment
          }
          r = { ok: false, pending: true }; // network hiccup: keep trying
        }
        if (r.ok) {
          remember(pendingKey, null);
          if (account.me?.id === uid) await account.refresh().catch(() => {});
          return r;
        }
        await new Promise((res) => setTimeout(res, 2000));
      }
      throw new Error(
        `Payment sent but not confirmed yet. Do not pay again. Transaction: ${signature}`,
      );
    }

    function rememberPurchase(key: string, signature: string) {
      remember(key, JSON.stringify({ signature, rpcUrl: intent.rpcUrl, lastValidBlockHeight: latest.lastValidBlockHeight }));
    }
  }
}

/** Never broadcast a preparation response that differs from the player's reviewed transaction. */
async function preparedWire(prepared: { signature: string; wire?: string }, original: import('@solana/web3.js').Transaction): Promise<Uint8Array> {
  if (!prepared.wire) throw new Error('The payment server needs an update. Check your wallet activity before trying again.');
  const [{ Buffer }, { Transaction }, { base58Encode }] = await Promise.all([import('buffer'), import('@solana/web3.js'), import('../game/solana')]);
  const bytes = new Uint8Array(Buffer.from(prepared.wire, 'base64'));
  const tx = Transaction.from(bytes);
  if (!tx.serializeMessage().equals(original.serializeMessage()) || !tx.signature || !tx.verifySignatures() || base58Encode(new Uint8Array(tx.signature)) !== prepared.signature) {
    throw new Error('The server returned an invalid signed payment. Nothing was sent.');
  }
  return bytes;
}

const receiptMemory = new Map<string, string>();

function saved(key: string): string | null {
  try { return localStorage.getItem(key) ?? receiptMemory.get(key) ?? null; } catch { return receiptMemory.get(key) ?? null; }
}

function paymentSignature(key: string): string | null {
  const raw = saved(key);
  if (!raw || !raw.startsWith('{')) return raw;
  try { return (JSON.parse(raw) as { signature: string }).signature; } catch { return raw; }
}

async function discardExpiredPayment(key: string): Promise<void> {
  const raw = saved(key);
  if (!raw?.startsWith('{')) return; // Older receipts have no safe expiry information.
  try {
    const receipt = JSON.parse(raw) as { signature: string; rpcUrl: string; lastValidBlockHeight: number };
    if (!Number.isSafeInteger(receipt.lastValidBlockHeight)) return;
    const { Connection } = await import('@solana/web3.js');
    const conn = new Connection(receipt.rpcUrl, { commitment: 'confirmed', fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(15_000) }) });
    const s = (await conn.getSignatureStatuses([receipt.signature], { searchTransactionHistory: true })).value[0];
    if (s?.err || (!s && (await conn.getBlockHeight('finalized')) > receipt.lastValidBlockHeight + 10)) remember(key, null);
  } catch { /* An unavailable RPC is not proof of failure. Keep the receipt. */ }
}

/** A server/network/login error is not evidence that a signed payment failed. */
async function claimSaved(key: string, path: string, uid: string): Promise<object | null> {
  const signature = paymentSignature(key);
  if (!signature || account.me?.id !== uid || !ticketsOn()) return null;
  let result: { ok?: boolean };
  try { result = await account.api(path, { signature }); }
  catch (e) {
    // Keep legacy receipts on shared browsers until their actual owner claims them.
    if (key.endsWith(`:${uid}`) && /failed on-chain|not a transaction signature/i.test((e as Error).message)) remember(key, null);
    return null;
  }
  if (!result.ok) { await discardExpiredPayment(key); return null; }
  remember(key, null);
  if (account.me?.id === uid) await account.refresh().catch(() => {});
  return result;
}

function remember(key: string, sig: string | null) {
  if (sig) receiptMemory.set(key, sig); else receiptMemory.delete(key);
  try {
    if (sig) localStorage.setItem(key, sig);
    else localStorage.removeItem(key);
    receiptMemory.delete(key); // durable browser storage succeeded
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
  const uid = account.me?.id;
  if (!uid) return false;
  const scoped = await claimSaved(`${key}:${uid}`, path, uid);
  const legacy = await claimSaved(key, path, uid);
  return !!(scoped || legacy);
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
 * an error after sending): list this wallet's recent purchases and let the server credit them.
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
  await claimPendingTicket();
  const r = await fetch(t.rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    signal: AbortSignal.timeout(15_000),
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
        hasPurchaseMemo(x.memo) &&
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
export async function coinBalance(signal?: AbortSignal): Promise<number | null> {
  const t = account.cfg?.tickets;
  if (!t) return null;
  const { privyWallet } = await import('./privy/client');
  const w = await privyWallet(15_000);
  const r = await fetch(t.rpcUrl, {
    method: 'POST',
    signal: signal ?? AbortSignal.timeout(8_000),
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getTokenAccountsByOwner', params: [w.address, { mint: t.mint }, { encoding: 'jsonParsed' }] }),
  });
  const j = await r.json() as { result?: { value: { account: { data: { parsed: { info: { tokenAmount: { uiAmount: number } } } } } }[] } };
  if (!r.ok || !Array.isArray(j.result?.value)) throw new Error('Coin balance is unavailable. Please retry.');
  const v = j.result.value;
  return v.reduce((s, a) => s + (a.account.data.parsed.info.tokenAmount.uiAmount ?? 0), 0);
}

/** Send coins out of the game wallet to any Solana address. The game pays the fee when it can. */
export function savedWithdrawalReceipt(): { signature: string; confirmed: boolean } | null {
  const uid = account.me?.id;
  if (!uid) return null;
  const pending = saved(`tl-pending-withdrawal:${uid}`);
  const previous = saved(`tl-last-withdrawal:${uid}`);
  try {
    const receipt = JSON.parse(pending ?? previous ?? 'null');
    if (!/^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(receipt?.signature ?? '')) return null;
    return { signature: receipt.signature, confirmed: !pending && receipt.confirmed === true };
  } catch { return null; }
}

export async function withdrawCoins(to: string, amount: number, step: (text: string) => void, receiptReady?: (signature: string) => void): Promise<{ signature: string; confirmed: boolean }> {
  const configured = account.cfg?.tickets;
  if (!configured || !account.me) throw new Error('Sign in first.');
  const t: TicketConfig = configured;
  const uid = account.me.id;
  return await withPaymentLock(uid, withdraw);

  async function withdraw(): Promise<{ signature: string; confirmed: boolean }> {
    const key = `tl-pending-withdrawal:${uid}`;
    step('Preparing…');
    const { Buffer } = await import('buffer');
    (globalThis as unknown as { Buffer: typeof Buffer }).Buffer ??= Buffer;
    const [{ Connection, PublicKey, Transaction, ComputeBudgetProgram }, spl] = await Promise.all([import('@solana/web3.js'), import('@solana/spl-token')]);
    const connection = (url: string, deadline?: AbortSignal) => new Connection(url, { commitment: 'confirmed', disableRetryOnRateLimit: true, fetch: (input, init) => fetch(input, { ...init, signal: deadline ? AbortSignal.any([deadline, AbortSignal.timeout(8_000)]) : AbortSignal.timeout(15_000) }) });
    const old = saved(key);
    if (old) {
      const receipt = JSON.parse(old) as { signature: string; rpcUrl: string; lastValidBlockHeight: number };
      receiptReady?.(receipt.signature);
      step('Checking your previous withdrawal…');
      return await check(receipt, false);
    }
    if (!(amount > 0) || !Number.isFinite(amount)) throw new Error('Enter a valid amount.');
    let dest: InstanceType<typeof PublicKey>;
    try {
      dest = new PublicKey(to.trim());
    } catch {
      throw new Error('That is not a Solana address.');
    }
    const wallet = await payer();
    const conn = connection(t.rpcUrl);
    const owner = new PublicKey(wallet.address);
    if (dest.equals(owner)) throw new Error('Enter a receiving wallet different from your game wallet.');
    const mint = new PublicKey(t.mint);
    const mintAccount = await conn.getAccountInfo(mint);
    if (!mintAccount) throw new Error('The coin is unavailable on this network. Nothing was sent.');
    const programId = mintAccount.owner;
    const decimals = (await spl.getMint(conn, mint, 'confirmed', programId)).decimals;
    const from = spl.getAssociatedTokenAddressSync(mint, owner, false, programId);
    const toAta = spl.getAssociatedTokenAddressSync(mint, dest, true, programId);
    const units = BigInt(Math.floor(amount * 10 ** decimals + 1e-6));
    if (units <= 0n) throw new Error('The amount is smaller than one coin unit.');
    const bal = BigInt((await conn.getTokenAccountBalance(from)).value.amount);
    if (bal < units) throw new Error(`You only have ${Number(bal) / 10 ** decimals} ${t.symbol}.`);
    const sponsorAddr = (account.cfg as { sponsor?: string | null } | null)?.sponsor ?? null;
    const sponsor = sponsorAddr && wallet.signOnly ? new PublicKey(sponsorAddr) : null;
    const tx = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 100_000 }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 10_000 }));
    if (!(await conn.getAccountInfo(toAta))) tx.add(spl.createAssociatedTokenAccountIdempotentInstruction(sponsor ?? owner, toAta, dest, mint, programId));
    tx.add(spl.createTransferCheckedInstruction(from, mint, toAta, owner, units, decimals, [], programId));
    tx.feePayer = sponsor ?? owner;
    const latest = await conn.getLatestBlockhash('confirmed');
    tx.recentBlockhash = latest.blockhash;
    if (account.me?.id !== uid) throw new Error('Account changed. Nothing was sent.');
    step(`Approve sending ${amount.toLocaleString('en-US')} ${t.symbol} in your wallet…`);
    let sig: string;
    if (sponsor) {
      const signedTx = await wallet.signOnly!(tx);
      if (account.me?.id !== uid || account.cfg?.tickets?.mint !== t.mint) throw new Error('Account or coin changed during approval. Nothing was sent.');
      if (!(await conn.isBlockhashValid(latest.blockhash, { commitment: 'confirmed' })).value) throw new Error('Wallet approval took too long and this transaction expired. Nothing was sent. Try again for a fresh approval.');
      step('Preparing your signed withdrawal…');
      const prepared = await account.api<{ signature: string; wire?: string }>('/api/pay/withdraw', { tx: Buffer.from(signedTx).toString('base64'), prepareOnly: true });
      const wire = await preparedWire(prepared, tx);
      if (account.me?.id !== uid || account.cfg?.tickets?.mint !== t.mint) throw new Error('Account or coin changed during approval. Nothing was sent.');
      sig = prepared.signature;
      const receipt = { signature: sig, rpcUrl: t.rpcUrl, lastValidBlockHeight: latest.lastValidBlockHeight, wire: prepared.wire };
      remember(key, JSON.stringify(receipt));
      receiptReady?.(sig);
      step('Sending (the game pays the network fee)…');
      try { await conn.sendRawTransaction(wire, { skipPreflight: false, maxRetries: 20 }); }
      catch { /* Check this signature; never automatically sign a replacement. */ }
      step('Checking your withdrawal…');
      return await check(receipt, true);
    } else {
      let known: string | null = null;
      try {
        sig = await wallet.send(tx, conn, signature => {
          known = signature;
          remember(key, JSON.stringify({ signature, rpcUrl: t!.rpcUrl, lastValidBlockHeight: latest.lastValidBlockHeight }));
          receiptReady?.(signature);
        });
      } catch (e) {
        if (!known) throw e;
        sig = known;
      }
    }
    const receipt = { signature: sig, rpcUrl: t!.rpcUrl, lastValidBlockHeight: latest.lastValidBlockHeight };
    remember(key, JSON.stringify(receipt));
    step('Waiting for the network to confirm…');
    return await check(receipt, true);

    async function check(receipt: { signature: string; rpcUrl: string; lastValidBlockHeight: number; wire?: string }, wait: boolean) {
      // One overall deadline bounds all status/expiry reads together. Independent
      // per-request timeouts inside forty polls could otherwise hold the UI for minutes.
      const deadline = AbortSignal.timeout(wait ? 12_000 : 8_000);
      const statusConn = connection(receipt.rpcUrl, deadline);
      let rebroadcast = false;
      for (let i = 0; i < (wait ? 7 : 1) && !deadline.aborted; i++) {
        let s;
        try { s = (await statusConn.getSignatureStatuses([receipt.signature], { searchTransactionHistory: true })).value[0]; }
        catch { break; }
        if (s?.err) {
          remember(key, null);
          throw new Error('The withdrawal failed on-chain. No coins were transferred.');
        }
        if (s && (s.confirmationStatus === 'confirmed' || s.confirmationStatus === 'finalized')) {
          remember(`tl-last-withdrawal:${uid}`, JSON.stringify({ signature: receipt.signature, confirmed: true }));
          remember(key, null);
          return { signature: receipt.signature, confirmed: true };
        }
        if (!s) {
          try {
            if ((await statusConn.getBlockHeight('finalized')) > receipt.lastValidBlockHeight + 10) {
              remember(key, null);
              throw new Error('The withdrawal expired before it reached the network. No coins were transferred. Try again.');
            }
          } catch (e) { if ((e as Error).message.startsWith('The withdrawal expired')) throw e; }
        }
        if (!rebroadcast && receipt.wire && !deadline.aborted) {
          // Retry the exact saved signature, never a fresh approval. Solana deduplicates
          // this wire; a lost RPC broadcast must not become a second transfer.
          const bytes = new Uint8Array(Buffer.from(receipt.wire, 'base64'));
          const signed = Transaction.from(bytes);
          const { base58Encode } = await import('../game/solana');
          if (!signed.signature || !signed.verifySignatures() || base58Encode(new Uint8Array(signed.signature)) !== receipt.signature) throw new Error('Saved withdrawal does not match its receipt. Contact support before sending again.');
          rebroadcast = true;
          try { await statusConn.sendRawTransaction(bytes, { skipPreflight: false, maxRetries: 20 }); } catch { /* Keep checking this same ID. */ }
        }
        if (wait) await new Promise((r) => setTimeout(r, 1500));
      }
      return { signature: receipt.signature, confirmed: false };
    }
  }
}
