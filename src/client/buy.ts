import './buy.css';
import { account, showAuthModal } from './account';
import { escapeHtml } from './codeViewer';
import { icon } from './icons';
import { quoteCoinBuy, estimateCoinBuy, approveCoinBuy, type CoinQuote } from './coinPurchase';

let hooked = false;
let generation = 0;
let busy = false;
let expiryTimer: ReturnType<typeof setTimeout> | undefined;
let countdownTimer: ReturnType<typeof setInterval> | undefined;
const solText = (lamports: number) => (lamports / 1e9).toFixed(6);

export function renderBuyPage() {
  // Keep the active approval intact across account refreshes and route changes.
  if (busy) return;
  clearTimeout(expiryTimer);
  clearInterval(countdownTimer);
  const version = ++generation;
  if (!hooked) { hooked = true; account.onChange(() => { if (!document.getElementById('view-buy')?.hidden) renderBuyPage(); }); }
  const body = document.getElementById('buy-body')!;
  const cfg = account.cfg;
  const t = cfg?.tickets;
  const ready = !!t && cfg?.coinLaunch?.status === 'live' && cfg.coinLaunch.buyEnabled && t.cluster === 'mainnet-beta';
  const test = cfg?.coinLaunch?.mode === 'test';
  const paid = cfg?.coinLaunch?.paidEnabled !== false;
  const sym = escapeHtml(t?.symbol ?? 'the game coin');
  body.innerHTML = `<section class="card coin-buy-card">
    <span class="hero-label">${test ? 'Temporary test coin · real SOL' : 'PumpKart · Solana'}</span>
    <h2>${ready ? `Buy ${sym}.` : 'Coin buying is paused.'}</h2>
    ${!ready ? '<p class="muted">Buying opens once the selected coin is verified. Practice is free.</p><a class="btn btn-lime" href="#/drive">Practice for free</a>' : `
      <p class="muted">Pay with SOL. Receive coins in your PumpKart wallet.</p>
      ${test ? `<p class="coin-test-note">This is a temporary coin for testing, bought with real SOL. It is not the official PumpKart coin. ${paid ? 'Paid test races are open.' : 'Paid races are closed.'}</p>` : ''}
      <ol class="coin-steps" aria-label="Purchase steps"><li class="active" aria-current="step">1 <span>Choose</span></li><li>2 <span>Review</span></li><li>3 <span>Approve</span></li></ol>
      <form id="coin-buy-form"><label for="coin-sol">Spend in SOL</label>
        <div class="coin-amount"><input id="coin-sol" type="number" min="0.001" max="10" step="any" inputmode="decimal" value="${test ? '0.001' : '0.01'}" required/><span>SOL</span></div>
        <div class="coin-presets" aria-label="Quick amounts">${(test ? ['0.001','0.005','0.01'] : ['0.01','0.05','0.1']).map((v, i) => `<button type="button" data-sol="${v}" aria-pressed="${i === 0}" class="btn btn-ghost small">${v} SOL</button>`).join('')}</div>
        <button class="btn btn-lime coin-action" id="coin-review-button" type="submit">${account.me ? 'Review purchase' : 'Sign in with X'}${icon('overtake', 16)}</button>
      </form>
      <div id="coin-review"></div><p id="coin-status" class="coin-status" role="status" aria-live="polite"></p>
      <p class="small muted">Keep 0.01 SOL in your wallet for fees. Buying coins does not buy a race ticket.</p>
      <details class="coin-details"><summary>Coin address &amp; wallet funding</summary>
        <p class="small">${test ? 'Test coin' : 'Game coin'} address</p><code class="coin-address">${escapeHtml(t!.mint)}</code>
        <div class="coin-links"><button class="btn btn-ghost small" id="coin-copy-mint">${icon('copy', 14)}Copy coin address</button>
        <a class="hero-link" href="https://solscan.io/token/${encodeURIComponent(t!.mint)}" target="_blank" rel="noopener noreferrer">Solscan${icon('overtake', 14)}</a>
        <a class="hero-link" href="https://pump.fun/coin/${encodeURIComponent(t!.mint)}" target="_blank" rel="noopener noreferrer">pump.fun${icon('overtake', 14)}</a></div>
        <p class="small muted">Need SOL? Copy your wallet address from the account menu, then send SOL on Solana mainnet.</p></details>`}
  </section>`;
  if (!ready) return;
  const form = body.querySelector<HTMLFormElement>('#coin-buy-form')!;
  const status = body.querySelector<HTMLElement>('#coin-status')!;
  const review = body.querySelector<HTMLElement>('#coin-review')!;
  const input = form.querySelector<HTMLInputElement>('#coin-sol')!;
  const reviewButton = form.querySelector<HTMLButtonElement>('#coin-review-button')!;
  let q: CoinQuote | null = null;
  const current = () => version === generation && body.isConnected;
  const setStatus = (text: string, tone: 'pending' | 'error' | 'success' | 'info' = 'info') => {
    status.textContent = text;
    status.dataset.tone = tone;
  };
  body.querySelector<HTMLButtonElement>('#coin-copy-mint')!.onclick = async () => {
    try { await navigator.clipboard.writeText(t!.mint); setStatus('Coin address copied.'); }
    catch { setStatus('Select and copy the coin address above.'); }
  };
  const setBusy = (value: boolean) => {
    busy = value;
    form.querySelectorAll<HTMLInputElement | HTMLButtonElement>('input, button').forEach(el => { el.disabled = value; });
    body.querySelector('.coin-buy-card')?.setAttribute('aria-busy', String(value));
  };
  const steps = (at: number) => body.querySelectorAll('.coin-steps li').forEach((el, i) => {
    el.classList.toggle('active', i <= at);
    if (i === at) el.setAttribute('aria-current', 'step'); else el.removeAttribute('aria-current');
  });
  const invalidate = () => {
    q = null; clearTimeout(expiryTimer); clearInterval(countdownTimer); review.innerHTML = ''; setStatus(''); steps(0);
    form.querySelectorAll<HTMLButtonElement>('[data-sol]').forEach(el => el.setAttribute('aria-pressed', String(Number(el.dataset.sol) === Number(input.value))));
    reviewButton.innerHTML = `${account.me ? 'Review purchase' : 'Sign in with X'}${icon('overtake', 16)}`;
  };
  input.oninput = invalidate;
  form.querySelectorAll<HTMLButtonElement>('[data-sol]').forEach(el => el.onclick = () => { input.value = el.dataset.sol!; invalidate(); });
  form.onsubmit = async e => {
    e.preventDefault();
    if (busy) return;
    if (!account.me) return showAuthModal();
    invalidate(); setBusy(true); setStatus('Getting a live price and checking fees…', 'pending');
    reviewButton.textContent = 'Checking price…';
    try {
      const quote = await quoteCoinBuy(Number(input.value));
      const estimate = await estimateCoinBuy(quote);
      const totalLimit = test && quote.sol === 0.001 ? 5_000_000 : estimate.totalLamports + quote.maxLamports;
      if (estimate.totalLamports + quote.maxLamports > totalLimit) throw new Error('This small test exceeds 0.005 SOL including fees. Nothing was sent.');
      if (!current()) return;
      if (Date.now() >= quote.expires) throw new Error('The price expired while checking fees. Review again for a fresh price.');
      q = quote; steps(1);
      const tokens = Number(quote.tokens) / 10 ** quote.decimals;
      review.innerHTML = `<div class="coin-review-panel" tabindex="-1" aria-label="Review your purchase"><span class="small muted">You receive</span>
        <strong class="coin-receive">${tokens.toLocaleString('en-US', { maximumFractionDigits: 2 })} <small>${sym}</small></strong>
        <dl class="coin-totals"><div class="coin-total-primary"><dt>Estimated total, including fees</dt><dd>${solText(estimate.totalLamports)} SOL</dd></div>
          <div><dt>Maximum coin cost</dt><dd>${solText(quote.maxLamports)} SOL</dd></div>
          <div><dt>Your available balance</dt><dd>${solText(estimate.balanceLamports)} SOL</dd></div>
          <div><dt>Purchase through</dt><dd>${escapeHtml(quote.route)}</dd></div></dl>
        <p class="small muted">The total includes network fees and account setup. The coin cost allows up to 1% price movement. Review the final transaction in your wallet.</p>
        <p class="small">Receiving wallet</p><code class="coin-address">${escapeHtml(quote.address)}</code>
        <div class="coin-price-clock">${icon('clock', 14)}<span id="coin-price-time"></span></div>
        <button class="btn btn-lime coin-action" id="coin-approve">Approve purchase${icon('overtake', 16)}</button>
        <button class="btn btn-ghost coin-action" id="coin-refresh" hidden>Refresh price${icon('replay', 16)}</button></div>`;
      setStatus('Review the total. Approve purchase opens your wallet.');
      const approve = review.querySelector<HTMLButtonElement>('#coin-approve')!;
      review.querySelector<HTMLButtonElement>('#coin-refresh')!.onclick = () => form.requestSubmit();
      const tick = () => {
        if (!current() || !q || document.getElementById('view-buy')?.hidden) { clearInterval(countdownTimer); return; }
        review.querySelector('#coin-price-time')!.textContent = `Price valid for ${Math.max(0, Math.ceil((quote.expires - Date.now()) / 1000))}s`;
      };
      tick(); countdownTimer = setInterval(tick, 1000);
      expiryTimer = setTimeout(() => {
        if (!current() || !q) return;
        q = null; clearInterval(countdownTimer); approve.hidden = true;
        review.querySelector('#coin-price-time')!.textContent = 'Price expired';
        review.querySelector<HTMLButtonElement>('#coin-refresh')!.hidden = false;
        setStatus('Refresh the price to continue. Nothing has been sent.');
      }, Math.max(0, quote.expires - Date.now()));
      review.querySelector<HTMLElement>('.coin-review-panel')!.focus({ preventScroll: true });
      review.scrollIntoView({ block: 'nearest', behavior: 'instant' });
      approve.onclick = async () => {
        if (!q || busy) return;
        const buying = q; q = null; clearTimeout(expiryTimer); clearInterval(countdownTimer);
        approve.disabled = true; setBusy(true); steps(2);
        review.querySelector('#coin-price-time')!.textContent = 'Wallet approval in progress';
        setStatus('Preparing your wallet approval…', 'pending');
        try {
          const signature = await approveCoinBuy(buying, text => { if (current()) setStatus(text, 'pending'); }, async (_tx, _conn, fresh) => {
            if (fresh.totalLamports + buying.maxLamports > totalLimit) throw new Error('The estimated cost changed. Review a fresh price before approving. Nothing was sent.');
          });
          if (!current()) return;
          form.hidden = true;
          body.querySelector<HTMLElement>('.coin-steps')!.hidden = true;
          review.innerHTML = `<div class="coin-review-panel coin-complete">${icon('check', 24)}<h3>Coins received.</h3><p class="muted">Your purchase is confirmed on Solana.</p>
            <a class="hero-link" href="https://solscan.io/tx/${encodeURIComponent(signature)}" target="_blank" rel="noopener noreferrer">View transaction${icon('overtake', 14)}</a>
            ${paid ? '<button class="btn btn-lime coin-action" id="coin-ticket">Buy a race ticket</button>' : '<a class="btn btn-lime coin-action" href="#/drive">Practice for free</a>'}</div>`;
          setStatus(paid ? 'Your coins are ready. Buy a ticket when you want to race for a prize.' : 'Test purchase complete. Paid tickets and races remain closed.', 'success');
          const ticket = review.querySelector<HTMLButtonElement>('#coin-ticket');
          if (ticket) ticket.onclick = async () => { const { ticketCheckout } = await import('./ticketCheckout'); void ticketCheckout().catch(e => { if (current()) status.textContent = e.message; }); };
        } catch (e) {
          if (current()) {
            showError(e);
            const refresh = review.querySelector<HTMLButtonElement>('#coin-refresh');
            if (refresh) {
              approve.hidden = true; refresh.hidden = false;
              review.querySelector('#coin-price-time')!.textContent = 'Review a fresh price to try again';
            }
          }
        }
        finally { setBusy(false); }
      };
    } catch (e) { if (current()) showError(e); }
    finally { setBusy(false); reviewButton.innerHTML = `Review purchase${icon('overtake', 16)}`; }
  };
  function showError(e: unknown) {
    const message = e instanceof Error ? e.message : 'Could not complete the purchase. Try again.';
    const signature = message.match(/transaction ([1-9A-HJ-NP-Za-km-z]{64,88})/)?.[1];
    setStatus(signature ? message : /abort|fetch|network request|timeout/i.test(message) ? 'The network is slow. Check your wallet and any pending transaction before trying again.' : message, signature ? 'pending' : 'error');
    if (signature) review.innerHTML = `<div class="coin-review-panel"><h3>Check your purchase.</h3><p class="muted">Wait for its final status before buying again.</p><a class="hero-link" href="https://solscan.io/tx/${encodeURIComponent(signature)}" target="_blank" rel="noopener noreferrer">View transaction${icon('overtake', 14)}</a></div>`;
  }
}
