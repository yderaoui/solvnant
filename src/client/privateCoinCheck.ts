import './style.css';
import './theme.css';
import './privateCoinCheck.css';
import { account, initAccountUi, showAuthModal } from './account';
import { privyWallet } from './privy/client';
import { PRIVATE_BUY_CHECK, privateBuyMessage, type PrivateBuyProof } from '../game/privateBuyCheck';
import { base58Encode } from '../game/solana';
import { quoteCoinBuy, approveCoinBuy, type CoinQuote } from './coinPurchase';
import { checkPrivateBuyBudget } from './privateBuyBudget';

const status = document.getElementById('test-message')!;
const verify = document.getElementById('test-verify') as HTMLButtonElement;
const retry = document.getElementById('test-retry') as HTMLButtonElement;
const view = document.getElementById('view-buy')!;
const body = document.getElementById('buy-body')!;
const report = (text: string) => { status.textContent = text; };
const liveApi = account.api.bind(account);
let proof: PrivateBuyProof | null = null;
let proofToken: string | null = null;
let quote: CoinQuote | null = null;
let busy = false;
let completed = false;
let loadingSession = false;

function reportSession() {
  if (loadingSession || busy || completed || proof) return;
  const unavailable = !account.cfg || (!!account.token && !account.me);
  verify.disabled = unavailable;
  retry.hidden = !unavailable;
  report(!account.cfg
    ? 'Could not connect to PumpKart. Retry the connection; your saved login stays in this browser.'
    : account.token && !account.me
      ? 'Could not check your saved session. Retry the connection before verifying your wallet.'
      : account.me
        ? 'Your existing X session is connected. Verify your wallet to begin.'
        : 'Open PumpKart in this browser and sign in with your existing X account first.');
}

async function loadSession() {
  if (loadingSession || busy || completed || proof) return;
  loadingSession = true; verify.disabled = true; retry.disabled = true;
  report('Connecting to PumpKart and checking your existing session…');
  try { await account.load(); }
  catch { /* Keep the saved token and offer a retry instead of another X login. */ }
  finally { loadingSession = false; retry.disabled = false; reportSession(); }
}
retry.onclick = () => { void loadSession(); };

async function privateApi<T>(action: string, extra: object = {}): Promise<T> {
  if (!account.token || account.token !== proofToken || !proof) throw new Error('Verify your wallet first. No purchase was made.');
  const r = await fetch('/api/private-coin-check', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${account.token}` }, body: JSON.stringify({ action, proof, ...extra }), signal: AbortSignal.timeout(20000) });
  const result = await r.json();
  if (!r.ok) throw new Error(result.error || 'Could not complete the private check.');
  return result as T;
}

account.api = async <T>(path: string, data?: unknown): Promise<T> => {
  if (path === '/api/config') return proof ? privateApi<T>('config') : liveApi<T>(path);
  if (path === '/api/coin/preflight') return privateApi<T>('preflight', data as object);
  if (['/api/me', '/api/privy', '/api/ledger'].includes(path)) return liveApi<T>(path, data);
  throw new Error('Ticket payments, races and withdrawals are unavailable on this test page.');
};

function paintReview() {
  view.hidden = false;
  body.innerHTML = `<section class="card coin-buy-card"><span class="hero-label">TEMPORARY TEST COIN</span><h2>Review your test purchase.</h2><p>Receiving wallet: <code>${PRIVATE_BUY_CHECK.wallet}</code></p><p class="small muted">Test mint: <code>${PRIVATE_BUY_CHECK.mint}</code></p><button class="btn btn-lime" id="test-quote">Review 0.001 SOL purchase</button><div id="test-review"></div></section>`;
  document.getElementById('test-quote')!.onclick = async () => {
    if (busy || completed) return;
    busy = true; quote = null;
    const button = document.getElementById('test-quote') as HTMLButtonElement;
    const review = document.getElementById('test-review')!;
    button.disabled = true; review.replaceChildren(); report('Getting the live quote and checking all costs…');
    try {
      const q = await quoteCoinBuy(PRIVATE_BUY_CHECK.inputSol);
      const { Connection, PublicKey, Transaction, ComputeBudgetProgram } = await import('@solana/web3.js');
      const conn = new Connection(q.ticket.rpcUrl, 'confirmed');
      const tx = new Transaction({ ...await conn.getLatestBlockhash('confirmed'), feePayer: new PublicKey(q.address) });
      tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }), ...q.instructions);
      const debit = await checkPrivateBuyBudget(tx, conn, q);
      if (Date.now() >= q.expires) throw new Error('This quote expired while checking. Get a fresh quote.');
      quote = q;
      review.innerHTML = `<div class="checkout-total"><span>You receive</span><strong>${(Number(q.tokens) / 10 ** q.decimals).toLocaleString('en-US', { maximumFractionDigits: 4 })} $RACE</strong><small>Estimated total: ${(debit / 1e9).toFixed(8)} SOL, including fees and account setup.</small></div><p class="small muted">Maximum coin cost: ${(q.maxLamports / 1e9).toFixed(6)} SOL. This check conservatively reserves extra within the 0.005 SOL limit. Quote valid for 30 seconds.</p><button class="btn btn-lime" id="test-approve">Approve this test purchase</button>`;
      document.getElementById('test-approve')!.onclick = approve;
      report('Review the total, then approve the purchase in Privy. No ticket will be bought.');
    } catch (error) { report((error as Error).message); }
    finally { button.disabled = false; busy = false; }
  };
}

async function approve() {
  if (busy || completed || !quote) return;
  busy = true;
  const q = quote; quote = null;
  const button = document.getElementById('test-approve') as HTMLButtonElement;
  const refresh = document.getElementById('test-quote') as HTMLButtonElement;
  button.disabled = true; refresh.disabled = true; verify.disabled = true;
  try {
    const signature = await approveCoinBuy(q, report, async (tx, conn) => {
      if (Date.now() >= PRIVATE_BUY_CHECK.expiresAt) throw new Error('This temporary check has closed.');
      const cost = await checkPrivateBuyBudget(tx, conn, q);
      report(`Estimated total ${(cost / 1e9).toFixed(8)} SOL. Opening Privy purchase approval…`);
    });
    const link = document.createElement('a');
    link.href = `https://solscan.io/tx/${encodeURIComponent(signature)}`; link.target = '_blank'; link.rel = 'noopener noreferrer'; link.textContent = 'View confirmed transaction';
    document.getElementById('test-review')!.replaceChildren(link);
    completed = true;
    try { sessionStorage.setItem(PRIVATE_BUY_CHECK.revision, signature); } catch { /* memory still blocks another buy */ }
    report('Test purchase confirmed. The coins are in your game wallet. Copy the transaction link so we can verify it.');
  } catch (error) { report((error as Error).message); }
  finally { busy = false; refresh.disabled = completed; verify.disabled = completed; }
}

verify.onclick = async () => {
  if (busy || completed || loadingSession) return;
  if (!account.cfg || (account.token && !account.me)) { await loadSession(); return; }
  if (!account.me || !account.token) { showAuthModal(); return; }
  busy = true; verify.disabled = true; quote = null;
  try {
    const token = account.token;
    const wallet = await privyWallet();
    if (!wallet.embedded || wallet.address !== PRIVATE_BUY_CHECK.wallet) throw new Error('Use the same X account as your funded PumpKart wallet.');
    if (!wallet.signMessage) throw new Error('Your wallet cannot verify ownership.');
    const timestamp = Date.now();
    const message = await privateBuyMessage(token, timestamp);
    report('Approve the free wallet-verification message in Privy. This does not spend SOL.');
    const signed = await wallet.signMessage(new TextEncoder().encode(message));
    if (account.token !== token) throw new Error('Your account changed. Verify again.');
    proof = { timestamp, signature: base58Encode(signed) }; proofToken = token;
    account.cfg = await privateApi('config');
    paintReview(); report('Wallet verified. Review the 0.001 SOL purchase when ready.');
  } catch (error) { proof = null; proofToken = null; view.hidden = true; report((error as Error).message); }
  finally { busy = false; verify.disabled = false; }
};

account.onChange(() => {
  if (proof && account.token !== proofToken) { proof = null; proofToken = null; quote = null; view.hidden = true; }
  reportSession();
});
initAccountUi(report);
function restoreCompleted() {
  try {
    const signature = sessionStorage.getItem(PRIVATE_BUY_CHECK.revision);
    if (signature && /^[1-9A-HJ-NP-Za-km-z]{80,90}$/.test(signature)) {
      completed = true; verify.disabled = true;
      const link = document.createElement('a');
      link.href = `https://solscan.io/tx/${encodeURIComponent(signature)}`; link.target = '_blank'; link.rel = 'noopener noreferrer'; link.textContent = 'View your confirmed test transaction';
      status.replaceChildren('This test purchase is already complete. ', link);
      return true;
    }
  } catch { /* optional storage */ }
  return false;
}
if (!restoreCompleted()) void loadSession();
