import { escapeHtml } from './codeViewer';
import { icon } from './icons';
import { buyTicket } from './tickets';
import { account } from './account';

let active: Promise<number> | null = null;
let activeCode: string | undefined;

/** One review screen shared by the race page and account menu. No payment until approval. */
export function ticketCheckout(code?: string): Promise<number> {
  if (active) return code === activeCode ? active : Promise.reject(new Error('Finish the open checkout before paying another entry.'));
  activeCode = code;
  active = openCheckout(code).finally(() => { active = null; activeCode = undefined; });
  return active;
}

async function openCheckout(code?: string): Promise<number> {
  const opener = document.activeElement as HTMLElement | null;
  const modal = document.createElement('div');
  modal.className = 'modal ticket-checkout';
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');
  modal.setAttribute('aria-labelledby', 'checkout-title');
  modal.innerHTML = `<section class="checkout-card card">
    <header><h2 id="checkout-title">${code ? 'Pay friend lobby entry' : 'Buy 1 race ticket'}</h2><button class="icon-btn" id="checkout-close" aria-label="Close checkout">${icon('x', 18)}</button></header>
    <p class="muted">${code ? `Lobby ${escapeHtml(code)}. Everyone pays the same locked coin amount. Payment reserves your place; start your run from the lobby.` : 'One ticket lets you enter one paid race. Buying it does not start the race.'}</p>
    <div id="checkout-review"></div>
    <p id="checkout-status" role="status" aria-live="polite">Getting your current price…</p>
    <div id="checkout-actions"></div>
  </section>`;
  document.body.appendChild(modal);
  const closeButton = modal.querySelector<HTMLButtonElement>('#checkout-close')!;
  const status = modal.querySelector<HTMLElement>('#checkout-status')!;
  const actions = modal.querySelector<HTMLElement>('#checkout-actions')!;
  let cancelReview: (() => void) | null = null;
  let closed = false;
  let busy = false;
  const close = () => {
    if (busy) return;
    closed = true;
    cancelReview?.();
    modal.remove();
    document.removeEventListener('keydown', keyboard);
    if (opener?.isConnected) opener.focus();
  };
  const keyboard = (e: KeyboardEvent) => {
    if (e.key === 'Escape') { e.preventDefault(); close(); }
    if (e.key === 'Tab') {
      const focusable = Array.from(modal.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], summary'));
      const first = focusable[0], last = focusable.at(-1);
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
    }
  };
  closeButton.onclick = close;
  modal.onclick = (e) => { if (e.target === modal) close(); };
  document.addEventListener('keydown', keyboard);
  closeButton.focus();
  try {
    const count = await buyTicket((text) => { status.textContent = text; }, async (quote, address, sponsored) => {
      if (closed) throw new Error('Checkout closed. No payment was made.');
      const sym = escapeHtml(quote.symbol);
      const usd = quote.usd ?? quote.priceUsd;
      modal.querySelector('#checkout-review')!.innerHTML = `
        ${quote.cluster === 'devnet' ? '<p class="checkout-test">Test network · test coins only, no real money</p>' : ''}
        ${quote.cluster === 'mainnet-beta' && account.cfg?.coinLaunch.mode === 'test' ? '<p class="checkout-test">Temporary test coin · real Solana payment</p>' : ''}
        <div class="checkout-total"><span>${code ? 'Entry per player · value when lobby was created' : 'Total for 1 ticket'}</span><strong>${usd ? `$${usd.toLocaleString('en-US')}` : `${quote.price.toLocaleString('en-US')} ${sym}`}</strong>
          <small>Pay ${quote.price.toLocaleString('en-US', { maximumFractionDigits: quote.decimals })} ${sym}</small></div>
        <p class="muted">${sponsored ? 'PumpKart covers the network fee. You do not need SOL.' : 'Your wallet pays the Solana network fee separately.'}</p>
        <p class="checkout-refund">${icon('history', 16)}<span>${code ? 'If fewer than 4 players finish by the lobby deadline, your full entry is refunded automatically.' : 'If fewer than 4 players finish by the race deadline, your ticket is returned automatically.'}</span></p>
        <details class="checkout-funding"><summary>Need ${sym} in your game wallet?</summary>
          <a class="btn btn-lime small" id="checkout-get-coins" href="#/buy">Get the game coin${icon('overtake', 14)}</a>
          <p>Send ${sym} to the address below on ${quote.cluster === 'devnet' ? 'Solana devnet' : 'Solana'}. Payments come from this wallet and race prizes arrive here.</p>
          <code>${escapeHtml(address)}</code><button class="btn btn-ghost small" id="checkout-copy">${icon('copy', 14)}Copy wallet address</button>
          <p class="muted small">Use only the game coin with this mint: <code>${escapeHtml(quote.mint)}</code></p>
        </details>
        <p class="muted small">${code ? 'This amount is fixed for all five players. Its dollar value can change with the coin price. If the lobby cannot accept your payment, the coins are returned to this wallet.' : 'You will approve the payment in your wallet next. Ticket payment is separate from joining a race.'}</p>`;
      modal.querySelector<HTMLButtonElement>('#checkout-copy')!.onclick = async () => {
        try { await navigator.clipboard.writeText(address); status.textContent = 'Wallet address copied.'; }
        catch { status.textContent = 'Copy the wallet address shown above.'; }
      };
      modal.querySelector<HTMLAnchorElement>('#checkout-get-coins')!.onclick = close;
      status.textContent = 'Review the total, then continue to your wallet.';
      actions.innerHTML = `<button class="btn btn-lime" id="checkout-confirm">Approve payment in wallet${icon('overtake', 16)}</button>`;
      await new Promise<void>((resolve, reject) => {
        cancelReview = () => reject(new Error('Checkout closed. No payment was made.'));
        modal.querySelector<HTMLButtonElement>('#checkout-confirm')!.onclick = () => {
          busy = true;
          cancelReview = null;
          closeButton.disabled = true;
          actions.innerHTML = `<button class="btn" disabled>${code ? 'Confirming your entry…' : 'Buying your ticket…'}</button>`;
          resolve();
        };
      });
    }, code);
    busy = false;
    closeButton.disabled = false;
    modal.querySelector('#checkout-title')!.textContent = code ? 'Your entry is paid' : 'Your ticket is ready';
    status.textContent = code ? 'Payment confirmed. Return to your friend lobby and start your run.' : `Payment confirmed. You now have ${count} ticket${count === 1 ? '' : 's'}.`;
    actions.innerHTML = '<button class="btn btn-lime" id="checkout-done">Continue to race</button>';
    modal.querySelector<HTMLButtonElement>('#checkout-done')!.onclick = () => { close(); if (code) location.hash = `#/race/friends/${encodeURIComponent(code)}`; else if (!location.hash.startsWith('#/race')) location.hash = '#/race'; document.getElementById('race-body')?.scrollIntoView({ block: 'start' }); };
    modal.querySelector<HTMLButtonElement>('#checkout-done')!.focus();
    return count;
  } catch (e) {
    busy = false;
    closeButton.disabled = false;
    if (!closed) {
      status.textContent = (e as Error).message;
      actions.innerHTML = '<button class="btn btn-ghost" id="checkout-back">Back to game</button>';
      modal.querySelector<HTMLButtonElement>('#checkout-back')!.onclick = close;
      modal.querySelector<HTMLButtonElement>('#checkout-back')!.focus();
    }
    throw e;
  }
}
