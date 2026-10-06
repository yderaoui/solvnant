// AI League lobby: between races (after the results have had their moment, until the next race's
// slot opens) the stage shows what's next: countdown, the next grid, betting on it, recent winners
// and a way to enter your own agent. Bets on a league race close when its slot opens, because the
// seed (and so the result) is revealed then.
import { account } from './account';
import { BetWidget, type MarketView } from './bets';
import { escapeHtml } from './codeViewer';
import { fetchHistory, houseEntries, isLocalMode, type HistoryRow } from './data';
import { icon } from './icons';
import { toast } from './toast';
import { raceStartAt, slotStart } from '../sim/schedule';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const clock = (ms: number) => {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

export class LeagueLobby {
  private betHost = document.createElement('div');
  private bets = new BetWidget(this.betHost, 'BET ON THE WINNER', toast);
  private picks: { name: string; color: string }[] = [];
  private winners: HistoryRow[] = [];
  private shownFor = -1; // slot whose lobby is on screen
  private timer: ReturnType<typeof setInterval> | null = null;
  private marketTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private center: (html: string) => void) {
    this.betHost.className = 'bw';
    this.bets.onView = (v: MarketView) => {
      this.picks = v.market?.picks ?? [];
      this.paintGrid();
    };
  }

  get visible() {
    return this.shownFor >= 0;
  }

  /** Show the lobby for the race in `nextSlot` (call repeatedly; it renders once per slot). */
  show(nextSlot: number, lastReplay: string | null) {
    if (this.shownFor === nextSlot) return;
    this.shownFor = nextSlot;
    document.body.classList.add('league-lobby');
    this.picks = isLocalMode ? houseEntries().map((e) => ({ name: e.name, color: e.color })) : [];
    const cfg = account.cfg;
    this.center(`
      <div class="lobby league-lobby-card" role="dialog" aria-label="AI League lobby">
        <section class="lcard join-card">
          <h2>NEXT AI RACE</h2>
          <p class="sub">AI models race with code they wrote themselves.</p>
          <div class="cd-row">
            <div class="lights" aria-hidden="true">${'<span></span>'.repeat(5)}</div>
            <div class="lobby-cd"><span>LIGHTS OUT IN</span><b id="ll-time" role="timer"></b></div>
          </div>
          <dl class="facts">
            <div><dt>${icon('zap', 16)}Betting closes</dt><dd id="ll-close"></dd></div>
            <div><dt>${icon('bot', 16)}Drivers</dt><dd id="ll-count">–</dd></div>
            <div><dt>${icon('replay', 16)}Every race</dt><dd>re-run in your browser<small>and checked against the server</small></dd></div>
          </dl>
          <a class="btn btn-lime btn-big" href="#/agent">ENTER YOUR OWN AGENT ${icon('code', 16)}</a>
          ${lastReplay ? `<a class="btn btn-ghost" href="${lastReplay}" style="margin-top:8px;width:100%">${icon('replay')}Watch the last race again</a>` : ''}
        </section>
        <section class="lcard queue-card" aria-label="Next race grid">
          <h3>STARTING GRID</h3>
          <p class="sub" id="ll-grid-sub"></p>
          <ol id="ll-grid" class="queue"></ol>
        </section>
        <section class="side-col">
          <div class="lcard" id="ll-bet">
            ${cfg?.leagueBets ? '' : '<h3>BET ON THE WINNER</h3><p class="sub">Betting on AI races needs the game server and database.</p>'}
          </div>
          <div class="lcard">
            <h3>RECENT WINNERS</h3>
            <ol class="winners" id="ll-winners"><li class="empty">Loading…</li></ol>
          </div>
        </section>
      </div>`);
    if (cfg?.leagueBets) $('ll-bet').appendChild(this.betHost);
    this.paintGrid();
    this.tick();
    this.timer ??= setInterval(() => this.tick(), 250);
    void this.loadMarket();
    this.marketTimer ??= setInterval(() => void this.loadMarket(), 10_000);
    void fetchHistory()
      .then((rows) => {
        this.winners = rows.slice(0, 3);
        this.paintWinners();
      })
      .catch(() => this.paintWinners());
  }

  hide() {
    if (this.shownFor < 0) return;
    this.shownFor = -1;
    document.body.classList.remove('league-lobby');
    if (this.timer) clearInterval(this.timer);
    if (this.marketTimer) clearInterval(this.marketTimer);
    this.timer = this.marketTimer = null;
    this.bets.setMarket(null);
    this.betHost.remove();
  }

  private async loadMarket() {
    if (!account.cfg?.leagueBets) return;
    try {
      const rows = await account.api<{ id: string; status: string; closes_at: number | null }[]>('/api/markets?kind=league');
      const next = rows.filter((r) => r.status === 'open' && (r.closes_at ?? 0) > Date.now()).sort((a, b) => (a.closes_at ?? 0) - (b.closes_at ?? 0))[0];
      this.bets.setMarket(next?.id ?? null);
    } catch {
      /* game server offline: the panel says so */
    }
  }

  private tick() {
    const slot = this.shownFor;
    if (slot < 0 || !document.getElementById('ll-time')) return;
    const now = Date.now();
    const lights = raceStartAt(slot) - now;
    $('ll-time').textContent = clock(lights);
    const close = slotStart(slot) - now;
    $('ll-close').innerHTML = close > 0 ? `in ${clock(close)}<small>when the track is revealed</small>` : 'closed';
    const lit = lights <= 5000 ? Math.max(0, Math.min(5, 5 - Math.floor(lights / 1000))) : 0;
    document.querySelectorAll('.league-lobby-card .lights span').forEach((el, i) => el.classList.toggle('on', i < lit));
  }

  private paintGrid() {
    const el = document.getElementById('ll-grid');
    if (!el) return;
    $('ll-count').textContent = this.picks.length ? String(this.picks.length) : '–';
    $('ll-grid-sub').textContent = this.picks.length ? 'Grid order is drawn at lights out' : 'The grid is announced when betting opens';
    el.innerHTML = this.picks.length
      ? this.picks
          .map(
            (p, i) =>
              `<li><span class="qn">${i + 1}</span><span class="av" style="--c:${escapeHtml(p.color)}">${icon(/agent/i.test(p.name) ? 'code' : 'bot', 14)}</span><span class="n">${escapeHtml(p.name)}</span><span class="sw" style="background:${escapeHtml(p.color)}"></span></li>`,
          )
          .join('')
      : `<li class="open"><span class="qn">–</span><span class="av ghost">${icon('bot', 14)}</span><span class="n">Waiting for the scheduler…</span></li>`;
  }

  private paintWinners() {
    const el = document.getElementById('ll-winners');
    if (!el) return;
    el.innerHTML = this.winners.length
      ? this.winners
          .map((w, i) => `<li><span class="p">${i + 1}.</span><span class="av" style="--c:var(--gold)">${icon('trophy', 14)}</span><span class="n">${escapeHtml(w.winner ?? '–')}</span><span></span><a class="a" href="#/replay/${w.id}">replay</a></li>`)
          .join('')
      : '<li class="empty">No finished races yet.</li>';
  }
}
