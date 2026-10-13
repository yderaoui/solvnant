import { account } from './account';
import { escapeHtml } from './codeViewer';
import { icon } from './icons';
import { placeLeagueBet, type LeagueBetResult } from './tickets';
import type { TicketConfig } from '../game/config';

let active: Promise<LeagueBetResult> | null = null;
/** Only the actual payer's wallet approval can send a coin bet. Closing the review spends nothing. */
export function coinBetCheckout(market: string, pick: string, usd: number): Promise<LeagueBetResult> {
  if (active) return Promise.reject(new Error('Finish the open bet checkout first.'));
  active = open(market, pick, usd).finally(() => { active = null; });
  return active;
}
async function open(market: string, pick: string, usd: number) {
  const opener = document.activeElement as HTMLElement | null;
  const modal = document.createElement('div');
  modal.className = 'modal ticket-checkout coin-bet-checkout';
  modal.setAttribute('role', 'dialog'); modal.setAttribute('aria-modal', 'true'); modal.setAttribute('aria-labelledby', 'cb-title');
  modal.innerHTML = `<section class="checkout-card card"><header><h2 id="cb-title">Review your coin bet</h2><button class="icon-btn" id="cb-close" aria-label="Close bet checkout">${icon('x',18)}</button></header><div id="cb-review"></div><p id="cb-status" role="status" aria-live="polite">Getting the live coin price…</p><div id="cb-actions"></div><p id="cb-receipt" class="small"></p></section>`;
  document.body.append(modal);
  const $ = <T extends HTMLElement = HTMLElement>(id: string) => modal.querySelector<T>('#'+id)!;
  let closed = false, busy = false, cancel: (() => void) | null = null;
  const close = () => {
    if (busy) return;
    closed = true; cancel?.(); modal.remove(); document.removeEventListener('keydown', keys);
    if (opener?.isConnected) opener.focus();
  };
  const keys = (e: KeyboardEvent) => {
    if (e.key === 'Escape') { e.preventDefault(); close(); }
    if (e.key === 'Tab') {
      const list = Array.from(modal.querySelectorAll<HTMLElement>('button:not(:disabled),a[href],summary'));
      if (e.shiftKey && document.activeElement === list[0]) { e.preventDefault(); list.at(-1)?.focus(); }
      else if (!e.shiftKey && document.activeElement === list.at(-1)) { e.preventDefault(); list[0]?.focus(); }
    }
  };
  $('cb-close').onclick = close;
  modal.onclick = e => { if (e.target === modal) close(); };
  document.addEventListener('keydown', keys); $('cb-close').focus();
  let quoteTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await placeLeagueBet(market, pick, usd, text => { if (!closed) $('cb-status').textContent = text; }, async (base, address, sponsored) => {
      if (closed) throw new Error('Bet review closed. No payment was made.');
      const q = base as TicketConfig & { betName: string; betMarket: string; expires: number; closesAt: number; usd: number };
      $('cb-review').innerHTML = `${q.cluster === 'devnet' ? '<p class="checkout-test">Devnet · test coins only</p>' : account.cfg?.coinLaunch.mode === 'test' ? '<p class="checkout-test">Temporary test coin · real Solana payment</p>' : ''}
        <p><b>${escapeHtml(q.betName)}</b> to win <span class="muted">race #${escapeHtml(q.betMarket.split(':')[1])}</span></p>
        <div class="checkout-total"><span>Your stake</span><strong>$${q.usd.toLocaleString('en-US')}</strong><small>Pay ${q.price.toLocaleString('en-US',{maximumFractionDigits:q.decimals})} ${escapeHtml(q.symbol)}</small></div>
        <p class="muted">${sponsored ? 'PumpKart pays the network fee.' : 'Your wallet pays the Solana network fee.'}</p>
        <p class="checkout-refund">${icon('trophy',16)}<span>Winning bets share 80% of the pool in proportion to their stake. 15% is burned; 5% goes to the treasury. Returns can change until betting closes and may be less than your stake.</span></p>
        <p class="small muted">Your bet must confirm before betting closes. A cancelled race, no winning bets or late confirmation returns the full stake automatically to the wallet that paid.</p>
        <details class="checkout-funding"><summary>Payment wallet and coin</summary><code>${escapeHtml(address)}</code><code>${escapeHtml(q.mint)}</code><a class="btn small" href="#/buy" id="cb-coins">Buy coins</a></details>`;
      $('cb-coins').onclick = close;
      $('cb-status').textContent = 'Review the stake, then approve in your wallet. In Privy, click Close after signing.';
      $('cb-actions').innerHTML = `<button class="btn btn-lime" id="cb-confirm">Approve coin bet${icon('overtake',16)}</button>`;
      await new Promise<void>((resolve, reject) => {
        cancel = () => reject(new Error('Bet review closed. No payment was made.'));
        quoteTimer = setTimeout(() => {
          cancel = null;
          $('cb-status').textContent = 'This price or race expired. Close and review the next race.';
          $('cb-confirm').setAttribute('disabled','');
          reject(new Error('Bet quote expired. No payment was made.'));
        }, Math.max(0,q.expires-Date.now()));
        $('cb-confirm').onclick = () => {
          clearTimeout(quoteTimer); cancel = null; busy = true;
          $('cb-close').setAttribute('disabled','');
          $('cb-actions').innerHTML = '<button class="btn" disabled>Waiting for wallet approval…</button>';
          resolve();
        };
      });
    }, signature => {
      const dev = account.cfg?.tickets?.cluster === 'devnet' ? '?cluster=devnet' : '';
      if (!closed) $('cb-receipt').innerHTML = `<a href="https://solscan.io/tx/${encodeURIComponent(signature)}${dev}" target="_blank" rel="noopener">View bet transaction${icon('overtake',14)}</a>`;
    });
    busy = false; $('cb-close').removeAttribute('disabled');
    if (!closed) {
      const recovered = result.market !== market || result.pick !== pick;
      $('cb-title').textContent = result.refunded ? 'Full refund queued' : recovered ? 'Earlier bet recovered' : 'Your bet is confirmed';
      if (recovered && result.view.market) $('cb-review').innerHTML = `<p>Your earlier payment belongs to <b>${escapeHtml(result.view.market.title)}</b>. This checkout did not place another bet.</p>`;
      $('cb-status').textContent = result.refunded ? 'This payment could not enter the race. Your full stake is returning to the payment wallet. Check History for the refund receipt.' : 'Your coins are in the race pool. Winnings arrive automatically in the wallet that paid. Check History for the payout receipt.';
      $('cb-actions').innerHTML = '<button class="btn btn-lime" id="cb-done">Continue watching</button><a class="btn btn-ghost" href="#/history" id="cb-history">My bet receipts</a>';
      $('cb-done').onclick = close; $('cb-history').onclick = close; $('cb-done').focus();
    }
    return result;
  } catch(e) {
    busy = false;
    if (!closed) {
      $('cb-close').removeAttribute('disabled'); $('cb-status').textContent = (e as Error).message;
      $('cb-actions').innerHTML = '<button class="btn btn-ghost" id="cb-back">Back to league</button>';
      $('cb-back').onclick = close; $('cb-back').focus();
    }
    throw e;
  } finally { clearTimeout(quoteTimer); }
}
