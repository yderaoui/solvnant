// Betting widget (PLAY-MONEY points, pool betting) shared by the live race spectator bar and the
// AI League "next race" panel. Odds come from the pools: winners split everything that was bet
// (minus a small rake), in proportion to their stake.
import { account, fmtPts, showAuthModal } from './account';
import { escapeHtml } from './codeViewer';
import { icon } from './icons';

interface MarketView {
  market: { id: string; kind: string; title: string; status: 'open' | 'closed' | 'settled' | 'void'; closesAt: number | null; picks: { id: string; name: string; color: string }[]; winner: string | null } | null;
  pools: Record<string, number>;
  odds: Record<string, number | null>;
  total: number;
  mine: { pick: string; amount: number; payout: number | null }[];
  youDrive: boolean;
}

export class BetWidget {
  private id: string | null = null;
  private view: MarketView | null = null;
  private pick: string | null = null;
  private amount = 50;
  private timer: ReturnType<typeof setInterval> | null = null;
  private busy = false;
  private msg = '';
  /** Live races close bets on the server's signal, not a clock time. */
  open = true;

  constructor(
    private el: HTMLElement,
    private title: string,
    private toast: (t: string) => void,
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
      this.el.innerHTML = `<div class="bw-head"><span class="bw-title">${this.title}</span><span class="bw-status">${this.id ? 'Loading…' : 'Betting opens when the race starts'}</span></div>`;
      return;
    }
    const closesIn = m.closesAt ? m.closesAt - Date.now() : null;
    const open = m.status === 'open' && this.open && (closesIn === null || closesIn > 0);
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
      .map((p) => {
        const odds = v.odds[p.id];
        const on = this.pick === p.id;
        return `<button class="bw-pick ${on ? 'on' : ''}" data-pick="${escapeHtml(p.id)}" aria-pressed="${on}" ${open ? '' : 'disabled'}>
          <span class="sw" style="background:${escapeHtml(p.color)}"></span><span class="n">${escapeHtml(p.name)}</span><b>${odds ? `${odds.toFixed(1)}x` : '–'}</b></button>`;
      })
      .join('');
    const mine = v.mine.length
      ? `<div class="bw-mine">Your bets: ${v.mine
          .map((b) => {
            const p = m.picks.find((x) => x.id === b.pick);
            const res = b.payout === null ? '' : b.payout > 0 ? ` <b class="up">+${fmtPts(b.payout)}</b>` : ' <b class="down">lost</b>';
            return `${fmtPts(b.amount)} on ${escapeHtml(p?.name ?? '?')}${res}`;
          })
          .join(' · ')}</div>`
      : '';
    const me = account.me;
    const cfg = account.cfg;
    let action: string;
    if (v.youDrive) action = `<span class="bw-note">You're driving in this race, so no bets.</span>`;
    else if (!open) action = '';
    else if (!me) action = `<button class="btn btn-lime" id="bw-signin">Sign in to bet</button>`;
    else
      action = `<label class="bw-amt"><span class="sr-only">Points to bet</span><input id="bw-amount" type="number" inputmode="numeric" min="${cfg?.points.betMin ?? 10}" max="${cfg?.points.betMax ?? 5000}" step="10" value="${this.amount}" /><small>PTS</small></label>
        <button class="btn btn-lime" id="bw-go" ${this.pick === null || this.busy ? 'disabled' : ''}>PLACE BET</button>`;
    this.el.innerHTML = `
      <div class="bw-head"><span class="bw-title">${this.title}</span><span class="bw-status ${open ? 'is-open' : ''}">${status}</span><span class="bw-pool">Pool <b>${fmtPts(v.total)}</b> pts</span></div>
      <div class="bw-picks" role="group" aria-label="Pick a winner">${picks}</div>
      <div class="bw-foot">${action}${mine}${this.msg ? `<span class="bw-msg" role="status">${escapeHtml(this.msg)}</span>` : ''}</div>`;
    for (const b of this.el.querySelectorAll<HTMLButtonElement>('[data-pick]'))
      b.onclick = () => {
        this.pick = b.dataset.pick!;
        this.msg = '';
        this.render();
      };
    this.el.querySelector<HTMLButtonElement>('#bw-signin')?.addEventListener('click', () => showAuthModal());
    const amt = this.el.querySelector<HTMLInputElement>('#bw-amount');
    if (amt) amt.oninput = () => (this.amount = Math.max(0, Math.floor(Number(amt.value) || 0)));
    this.el.querySelector<HTMLButtonElement>('#bw-go')?.addEventListener('click', () => void this.place());
  }

  private async place() {
    if (!this.id || this.pick === null || this.busy) return;
    this.busy = true;
    this.render();
    try {
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
