import { account, showAuthModal } from './account';
import { escapeHtml } from './codeViewer';
import { icon } from './icons';
import { quoteCoinBuy, approveCoinBuy, type CoinQuote } from './coinPurchase';

let hooked = false;
let generation = 0;
export function renderBuyPage() {
  const version = ++generation;
  if (!hooked) { hooked = true; account.onChange(() => { if (!document.getElementById('view-buy')!.hidden) renderBuyPage(); }); }
  const body = document.getElementById('buy-body')!;
  const t = account.cfg?.tickets;
  const ready = !!t && account.cfg?.coinLaunch?.status === 'live' && account.cfg.coinLaunch.buyEnabled && t.cluster === 'mainnet-beta';
  const sym = escapeHtml(ready ? t!.symbol : 'the official coin');
  body.innerHTML = `<section class="card coin-buy-card">
    <span class="hero-label">PumpKart · Solana</span><h2>${ready ? `Get ${sym}` : 'The official coin is launching soon.'}</h2>
    ${!ready ? '<p class="muted">Buying is paused until the official coin is verified. You can practice for free now.</p><a class="btn btn-lime" href="#/drive">Practice for free</a>' : `
      <p class="muted">Buy with SOL through pump.fun or PumpSwap. Coins arrive in the wallet you use to race.</p>
      <form id="coin-buy-form"><label for="coin-sol">How much SOL do you want to spend?</label>
        <div class="input-row"><input id="coin-sol" type="number" min="0.001" max="10" step="0.001" inputmode="decimal" placeholder="0.05" required /><button class="btn btn-lime">${account.me ? 'Review purchase' : 'Sign in with X'}</button></div></form>
      <p class="small muted">Coin buying uses SOL for fees and account setup. Keep at least 0.01 SOL extra. Ticket payments can have their fees covered separately.</p>
      <details><summary>Official coin &amp; wallet funding</summary><p class="small">Official mint: <code>${escapeHtml(t!.mint)}</code></p>
        <a class="hero-link" href="https://pump.fun/coin/${encodeURIComponent(t!.mint)}" target="_blank" rel="noopener noreferrer">View official coin on pump.fun${icon('overtake', 14)}</a>
        <p class="small muted">Need SOL? Send SOL on Solana mainnet to your game wallet. Open your account menu to copy its address.</p></details>
      <div id="coin-review"></div><p id="coin-status" role="status" aria-live="polite"></p>`}
  </section>`;
  if (!ready) return;
  const form = body.querySelector<HTMLFormElement>('#coin-buy-form')!;
  const status = body.querySelector<HTMLElement>('#coin-status')!;
  const review = body.querySelector<HTMLElement>('#coin-review')!;
  const button = form.querySelector<HTMLButtonElement>('button')!;
  let q: CoinQuote | null = null;
  const current = () => version === generation && body.isConnected && !document.getElementById('view-buy')!.hidden;
  form.onsubmit = async e => {
    e.preventDefault();
    if (!account.me) return showAuthModal();
    q = null; review.innerHTML = ''; button.disabled = true;
    status.textContent = 'Getting your live price…';
    try {
      const quote = await quoteCoinBuy(Number(body.querySelector<HTMLInputElement>('#coin-sol')!.value));
      if (!current()) return;
      q = quote;
      const tokens = Number(quote.tokens) / 10 ** quote.decimals;
      review.innerHTML = `<div class="checkout-total"><span>You receive</span><strong>${tokens.toLocaleString('en-US', { maximumFractionDigits: 4 })} ${sym}</strong>
        <small>Maximum coin cost: ${(quote.maxLamports / 1e9).toFixed(6)} SOL · includes up to 1% price movement</small></div>
        <p class="small muted">Route: ${quote.route}. Network fees and account setup are extra and shown in your wallet. Quote expires in 30 seconds.</p>
        <p class="small">Receiving wallet: <code>${escapeHtml(quote.address)}</code></p>
        <button class="btn btn-lime" id="coin-approve">Approve coin purchase${icon('overtake', 16)}</button>`;
      status.textContent = 'Buying coins does not buy a race ticket. Review and approve to continue.';
      review.querySelector<HTMLButtonElement>('#coin-approve')!.onclick = async () => {
        if (!q) return;
        const buying = q; q = null;
        const approve = review.querySelector<HTMLButtonElement>('#coin-approve')!;
        approve.disabled = true; button.disabled = true;
        try {
          const signature = await approveCoinBuy(buying, text => { if (current()) status.textContent = text; });
          if (!current()) return;
          review.innerHTML = `<p>Coins received in your game wallet.</p><a class="hero-link" href="https://solscan.io/tx/${encodeURIComponent(signature)}" target="_blank" rel="noopener noreferrer">View transaction</a><div class="res-foot"><button class="btn btn-lime" id="coin-ticket">Buy 1 race ticket</button></div>`;
          status.textContent = 'Next: buy your ticket, then start your race.';
          review.querySelector<HTMLButtonElement>('#coin-ticket')!.onclick = async () => { const { ticketCheckout } = await import('./ticketCheckout'); void ticketCheckout().catch(e => { if (current()) status.textContent = e.message; }); };
        } catch (e) { if (current()) status.textContent = (e as Error).message; }
        finally { if (current()) button.disabled = false; }
      };
    } catch (e) { if (current()) status.textContent = (e as Error).message; }
    finally { if (current()) button.disabled = false; }
  };
}
