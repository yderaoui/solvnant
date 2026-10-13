// Pool betting widget: live spectators use play points; AI League coin markets use wallet checkout.
// The server supplies the currency. Pool return estimates change until betting closes.
import { account, fmtPts, showAuthModal } from './account';
import { escapeHtml } from './codeViewer';
import { icon } from './icons';

export interface MarketView {
  market: { id: string; kind: string; title: string; status: 'open' | 'closed' | 'settled' | 'void'; closesAt: number | null; picks: { id: string; name: string; color: string }[]; winner: string | null } | null;
  pools: Record<string, number>;
  odds: Record<string, number | null>;
  total: number;
  mine: { pick: string; amount: number; payout: number | null; state?: string; signature?: string; paymentStatus?: string | null; payoutSignature?: string | null; reason?: string | null }[];
  currency?: 'coin' | 'points'; symbol?: string; mint?: string; cluster?: string; enabled?: boolean; minUsd?: number; maxUsd?: number;
  youDrive: boolean;
  yourPick: string | null; // live races: a driver may only back their own car
}

export class BetWidget {
  private id: string | null = null;
  private view: MarketView | null = null;
  private pick: string | null = null;
  private amount = 50;
  private usd = 1;
  private timer: ReturnType<typeof setInterval> | null = null;
  private busy = false;
  private msg = '';
  /** Live races close bets on the server's signal, not a clock time. */
  open = true;
  /** Called with each fresh market view (the AI League lobby shows the lineup from it). */
  onView: (v: MarketView) => void = () => {};

  constructor(
    private el: HTMLElement,
    private title: string,
    private toast: (t: string) => void,
    private kind: 'live' | 'league' = 'live',
  ) {
    account.onChange(() => {
      if (this.id) void this.load();
    });
  }

  setMarket(id: string | null) {
    if (id === this.id) return;
    this.id = id;
    this.view = null;
    this.pick = null;
    this.msg = '';
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (!id) {
      this.render();
      return;
    }
    void this.load();
    this.timer = setInterval(() => {
      if (this.el.offsetParent !== null) void this.load(); // only while on screen
    }, 3000);
    this.render();
  }

  private async load() {
    const id = this.id;
    if (!id) return;
    try {
      const v = await account.api<MarketView>(`/api/market?id=${encodeURIComponent(id)}`);
      if (id !== this.id) return;
      this.view = v;
      if (v.yourPick !== null) this.pick = v.yourPick; // drivers: always your own car
      this.onView(v);
    } catch {
      /* keep the last view */
    }
    if ((document.activeElement as HTMLElement | null)?.id === 'bw-amount' && this.el.contains(document.activeElement)) return; // don't yank the input while typing
    this.render();
  }

  private render() {
    const v = this.view;
    const m = v?.market;
    if (!this.id || !m) {
      this.el.innerHTML = `<div class="bw-head"><span class="bw-title">${this.title}</span><span class="bw-status">${this.id ? 'Loading…' : this.kind === 'league' ? 'Waiting for the next AI race' : 'Betting opens when the race starts'}</span></div>`;
      return;
    }
    const closesIn = m.closesAt ? m.closesAt - Date.now() : null;
    const coin = v.currency === 'coin';
    const fmt = (n: number) => coin ? n.toLocaleString('en-US',{maximumFractionDigits:6}) : fmtPts(n);
    const sym = coin ? escapeHtml(v.symbol ?? 'coins') : 'pts';
    const open = m.status === 'open' && this.open && (closesIn === null || closesIn > 0) && (!coin || v.enabled !== false);
    const winner = m.winner !== null ? m.picks.find((p) => p.id === m.winner) : null;
    const status =
      m.status === 'settled'
        ? `${icon('trophy', 14)}${escapeHtml(winner?.name ?? '?')} won`
        : m.status === 'void'
          ? 'Cancelled: bets refunded'
          : open
            ? `<span class="dot"></span>OPEN${closesIn !== null ? ` · closes in ${fmtLeft(closesIn)}` : ''}`
            : 'Bets closed';
    const picks = m.picks
      .filter((p) => v.yourPick === null || p.id === v.yourPick) // drivers only ever see their own car
      .map((p) => {
        const odds = v.odds[p.id];
        const on = this.pick === p.id;
        const allowed = open && !this.busy && (v.yourPick === null || v.yourPick === p.id);
        return `<button class="bw-pick ${on ? 'on' : ''} ${v.yourPick === p.id ? 'you' : ''}" data-pick="${escapeHtml(p.id)}" aria-pressed="${on}" ${allowed ? '' : 'disabled'}>
          <span class="sw" style="background:${escapeHtml(p.color)}"></span><span class="n">${escapeHtml(p.name)}</span><b>${odds ? `${odds.toFixed(1)}x` : '–'}</b></button>`;
      })
      .join('');
    const mine = v.mine.length
      ? `<div class="bw-mine">Your bets: ${v.mine
          .map((b) => {
            const p = m.picks.find((x) => x.id === b.pick);
            const res = b.payout === null ? '' : b.payout > 0 ? ` <b class="up">${b.state === 'refund' ? 'Refund' : '+'}${fmt(b.payout)} ${sym}${coin ? b.paymentStatus === 'paid' ? ' · paid' : ' · pending' : ''}</b>` : ' <b class="down">lost</b>';
            const dev = v.cluster === 'devnet' ? '?cluster=devnet' : '';
            const receipt = b.payoutSignature ? ` <a href="https://solscan.io/tx/${encodeURIComponent(b.payoutSignature)}${dev}" target="_blank" rel="noopener">Receipt${icon('overtake',12)}</a>` : '';
            return `${fmt(b.amount)} ${sym} on ${escapeHtml(p?.name ?? '?')}${res}${receipt}`;
          })
          .join(' · ')}</div>`
      : '';
    const me = account.me;
    const cfg = account.cfg;
    let action: string;
    if (!open) action = '';
    else if (!me) action = `<button class="btn btn-lime" id="bw-signin">Sign in to bet</button>`;
    else if (coin)
      action = `<label class="bw-amt"><span class="sr-only">Bet value in dollars, paid in ${sym}</span><small>$</small><input id="bw-amount" type="number" inputmode="decimal" min="${v.minUsd ?? .01}" max="${v.maxUsd ?? 100}" step="0.01" value="${this.usd}" ${this.busy ? 'disabled' : ''}/></label>
        <button class="btn btn-lime" id="bw-go" ${this.pick === null || this.busy ? 'disabled' : ''}>${this.busy ? 'CHECKING BET…' : 'REVIEW COIN BET'}</button>`;
    else
      action = `<label class="bw-amt"><span class="sr-only">Points to bet</span><input id="bw-amount" type="number" inputmode="numeric" min="${cfg?.points.betMin ?? 10}" max="${cfg?.points.betMax ?? 5000}" step="10" value="${this.amount}" /><small>PTS</small></label>
        <button class="btn btn-lime" id="bw-go" ${this.pick === null || this.busy ? 'disabled' : ''}>${v.yourPick !== null ? 'BACK YOURSELF' : 'PLACE BET'}</button>
        ${v.yourPick !== null ? '<span class="bw-note">You’re driving: you can only bet on yourself.</span>' : ''}`;
    this.el.innerHTML = `
      <div class="bw-head"><span class="bw-title">${coin ? `BET WITH ${sym}` : this.title}</span><span class="bw-status ${open ? 'is-open' : ''}">${status}</span><span class="bw-pool">Pool <b>${fmt(v.total)}</b> ${sym}</span></div>
      <div class="bw-picks" role="group" aria-label="Pick a winner">${picks}</div>
      ${coin ? `<p class="bw-coin-rules">Estimated pool returns · 80% to winning bets, 15% burned, 5% treasury. <a href="#/history">My bets &amp; receipts</a></p>` : ''}
      <div class="bw-foot">${action}${mine}${this.msg ? `<span class="bw-msg" role="status">${escapeHtml(this.msg)}</span>` : ''}</div>`;
    for (const b of this.el.querySelectorAll<HTMLButtonElement>('[data-pick]'))
      b.onclick = () => {
        this.pick = b.dataset.pick!;
        this.msg = '';
        this.render();
      };
    this.el.querySelector<HTMLButtonElement>('#bw-signin')?.addEventListener('click', () => showAuthModal());
    const amt = this.el.querySelector<HTMLInputElement>('#bw-amount');
    if (amt) amt.oninput = () => { if (coin) this.usd = Number(amt.value); else this.amount = Math.max(0,Math.floor(Number(amt.value)||0)); };
    this.el.querySelector<HTMLButtonElement>('#bw-go')?.addEventListener('click', () => void this.place());
  }

  private async place() {
    if (!this.id || this.pick === null || this.busy) return;
    this.busy = true;
    this.render();
    const id = this.id, pick = this.pick;
    try {
      if (this.view?.currency === 'coin') {
        const { coinBetCheckout } = await import('./coinBetCheckout');
        const r = await coinBetCheckout(id,pick,this.usd);
        if (this.id === r.market) this.view = r.view;
        this.toast(r.refunded ? 'Full coin refund queued. Check your bet history.' : 'Coin bet confirmed. Good luck!');
        this.msg = '';
        return;
      }
      const r = await account.api<{ points: number; view: MarketView }>('/api/bet', { market: this.id, pick: this.pick, amount: this.amount });
      this.view = r.view;
      account.setPoints(r.points);
      const name = r.view.market?.picks.find((p) => p.id === this.pick)?.name ?? '';
      this.toast(`Bet placed: ${fmtPts(this.amount)} on ${name}`);
      this.msg = '';
    } catch (e) {
      this.msg = (e as Error).message;
    } finally {
      this.busy = false;
      this.render();
    }
  }
}

function fmtLeft(ms: number) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
