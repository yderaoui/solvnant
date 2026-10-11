// Race page: ticketed ghost lobbies (5 seats, winner takes all). Shows how it works, your tickets, a
// "Race now" button that takes a seat (one ticket) and your recent lobbies. The race itself runs on the
// stage (#/run, PracticeDrive in ticket mode).
import { account, priceLabel, showAuthModal } from './account';
import { escapeHtml } from './codeViewer';
import { icon } from './icons';
import { toast } from './toast';
import { fmt } from './livegame';
import { PLAYER_COLORS } from '../game/protocol';
import type { TicketRun } from './practice';
import { showIntro } from './intro';
import { friendLobbyHtml, mountFriendLobbies, friendHref } from './friendLobbies';
import { celebrateSettledWin } from './winnerCelebration';
import { racerPortrait } from './portraits';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

interface Seat {
  ready?: boolean;
  name: string;
  color: string;
  you: boolean;
  racing: boolean;
  finished: boolean;
  finishTime: number | null;
  progress: number;
  note: string | null;
}
interface LobbyView {
  payout?: { status: string; sig: string | null } | null;
  refund?: { amount: number; status: string; sig: string | null } | null;
  lobby: { id: string; code?: string | null; status: string; settleBy: number; seats: number; maxSeats: number; pot: number; prize: number; youWon: boolean };
  seats: Seat[];
}
interface Mine {
  lobbies: LobbyView[];
  owed: number;
  tickets: number;
  pot: number;
  prize: number;
  burn: number;
  team: number;
}

let pending: (() => Promise<TicketRun>) | null = null;
/** "Race now" was pressed: the stage takes the seat once its 3D view is ready (once). */
export function takeTicketRun(): (() => Promise<TicketRun>) | null {
  const p = pending;
  pending = null;
  return p;
}

let hooked = false;
let renderVersion = 0;

export async function renderRacePage() {
  const version = ++renderVersion;
  const friendRoute = location.hash.startsWith('#/race/friends/');
  const hero = document.querySelector<HTMLElement>('.race-hero');
  if (hero) hero.hidden = friendRoute;
  if (!hooked) {
    hooked = true;
    account.onChange(() => {
      if (!$('view-race').hidden) void renderRacePage();
    });
  }
  const el = $('race-body');
  const t = account.cfg?.tickets;
  const sym = escapeHtml(t?.symbol ?? '$TRACK');
  if (!t) {
    el.innerHTML = `<section class="card race-unavailable">
      <div class="race-unavailable-icon">${icon('flag', 28)}</div>
      <div><h2>${account.ready ? 'Warm up on the track.' : 'Getting the grid ready.'}</h2>
        <p class="muted">${account.ready ? 'Ticketed races are unavailable on this server. You can still take any racer for a free test drive.' : 'Connecting to the game server. You can take a free test drive while you wait.'}</p></div>
      <a class="btn btn-lime" href="#/drive">${icon('pad', 16)}Test drive${icon('overtake', 16)}</a>
    </section>`;
    return;
  }
  if (friendRoute) {
    el.innerHTML = friendLobbyHtml();
    mountFriendLobbies(raceNow);
    return;
  }
  if (account.cfg?.coinLaunch?.status !== 'live' || account.cfg.coinLaunch.paidEnabled === false) {
    const coinTest = account.cfg?.coinLaunch?.status === 'live' && account.cfg.coinLaunch.buyEnabled;
    el.innerHTML = `<section class="card"><h2>${coinTest ? 'Coin buying is ready to test.' : 'The official coin is launching soon.'}</h2><p class="muted">${coinTest ? 'Try a small purchase in your game wallet. Ticket sales and paid races open after the payment checks.' : 'Coin purchases and paid race entry are paused. Practice for free while we get the grid ready.'}</p>${coinTest ? '<a class="btn btn-lime" href="#/buy">Buy test coins</a>' : ''}<a class="btn ${coinTest ? 'btn-ghost' : 'btn-lime'}" href="#/drive">Practice for free</a></section>${friendLobbyHtml()}`;
    mountFriendLobbies(raceNow);
    return;
  }
  const how = `
    <ol class="tr-how">
      <li><b>Sign in with X</b><span>Your game wallet is created for you.</span></li>
      <li><b>Buy 1 ticket for ${escapeHtml(priceLabel(t))}</b><span>Pay with ${sym} from your game wallet. Review the amount before approving.</span></li>
      <li><b>Start racing</b><span>Race on the same track as real players. The fastest completed run wins.</span></li>
    </ol>
    <details class="tr-rules"><summary>Race rules &amp; prizes</summary>
      <p>Up to 5 real players. You race against recordings of earlier runs, so you can start without waiting. No bots in paid races.</p>
      <p>The winner receives 80% of the coins paid into the pot. 15% is burned and 5% goes to the team.</p>
      <p>Results are final once all 5 players finish, or after 30 minutes with at least 4 players. With 3 or fewer players, tickets are returned. Settlement waits for active runs to finish.</p>
      <p>Leaving a started race counts as not finishing. Paid cars are cosmetic and do not improve your performance.</p>
      <button class="tr-intro" id="tr-intro">${icon('play', 14)}Watch the story</button>
    </details>`;
  if (!account.me) {
    el.innerHTML = `${friendLobbyHtml()}<div class="tr-grid"><section class="card tr-main">${pot(t, sym)}${how}
      <button class="btn btn-lime tr-go" id="tr-signin">${icon('flag', 16)}Sign in with X${icon('overtake', 16)}</button>
      <a class="btn btn-ghost tr-alt" href="#/drive">${icon('pad', 14)}Practice for free</a></section>
      <aside class="card tr-showcase"><span class="hero-label">Find your racer</span>
        <img src="${racerPortrait('rowdy')}" alt="Rowdy in a black supercar" width="960" height="720" loading="lazy" />
        <h2>Make an entrance.</h2><p class="muted">Test drive every racer. Pick the one that feels like you.</p>
        <a class="hero-link" href="#/garage">Explore the garage${icon('overtake', 16)}</a></aside></div>`;
    $('tr-signin').onclick = () => showAuthModal();
    $('tr-intro').onclick = () => showIntro();
    mountFriendLobbies(raceNow);
    return;
  }
  let mine: Mine;
  try {
    mine = await account.api<Mine>('/api/lobby/mine');
  } catch (e) {
    el.innerHTML = `<p class="garage-note">${icon('alert', 14)}${escapeHtml((e as Error).message)}</p>`;
    return;
  }
  if ($('view-race').hidden || version !== renderVersion) return;
  const devnet = t.cluster === 'devnet';
  el.innerHTML = `
    ${friendLobbyHtml()}
    <div class="tr-grid">
      <section class="card tr-main">
        ${pot(t, sym)}
        ${how}
        <div class="lb-ticket"><span><b>Your tickets: <span id="tr-tix">${mine.tickets}</span></b><small>${escapeHtml(priceLabel(t))} each${t.priceUsd ? `, paid in ${sym} at the live price` : ''}${devnet ? ' · test coins, no real value' : ''}</small></span>
          <button class="btn small" id="tr-buy">${icon('zap', 14)}Buy ticket</button></div>
        ${devnet ? `<button class="btn small btn-ghost lb-faucet" id="tr-faucet">${icon('zap', 14)}Get free test ${sym}</button>` : ''}
        <p class="muted small" id="tr-step" role="status" aria-live="polite"></p>
        <button class="btn btn-lime tr-go" id="tr-go" >${icon('flag', 16)}${mine.tickets ? 'Start race <small>uses 1 ticket</small>' : `Buy 1 ticket for ${escapeHtml(priceLabel(t))}`} </button>
        <p class="muted small tr-note">Once you start, the run counts: leaving mid-race counts as not finishing.</p>
      </section>
      <section class="card tr-side">
        ${mine.owed ? `<div class="tr-owed">${icon('trophy', 18)}<span><b>${mine.owed.toLocaleString('en-US')} ${sym} won</b><small>Check the payout status beside your race below.</small></span></div>` : ''}
        <h3>Your races</h3><a class="btn btn-ghost small" href="#/drive">Practice for free</a>
        ${mine.lobbies.length ? mine.lobbies.map((l) => lobbyCard(l, sym)).join('') : `<p class="muted small">Your results will appear here after your first race. Try a free practice run whenever you like.</p>`}
      </section>
    </div>`;
  $('tr-go').onclick = () => mine.tickets ? raceNow() : void buy();
  $('tr-intro').onclick = () => showIntro();
  $('tr-buy').onclick = () => void buy();
  const f = document.getElementById('tr-faucet');
  if (f) f.onclick = () => void faucet();
  mountFriendLobbies(raceNow);
  mine.lobbies.forEach(celebrateSettledWin);
}

function pot(t: { price: number; priceUsd?: number }, sym: string) {
  const full = (t.priceUsd ?? t.price) * 5;
  const n = (v: number) => v.toLocaleString('en-US');
  const big = t.priceUsd ? `$${n(full * 0.8)} <small>in ${sym}</small>` : `${n(full * 0.8)} <small>${sym}</small>`;
  return `<div class="tr-pot">
    <div class="tr-kicker">1 TICKET = 1 RACE</div>
    <div class="tr-big">${big}</div><b>Winner's prize at a full 5-player lobby</b>
    <div class="muted small">${t.priceUsd ? "Shown at ticket purchase value; the coin's market value can change." : '80% of the coins paid into a full lobby.'}</div>
  </div>`;
}

/** Winner's payout: paid (with a link to the transaction), on its way, or done by hand. */
export function payoutNote(p: { status: string; sig: string | null } | null | undefined): string {
  if (!p) return '';
  if (p.status === 'paid' && p.sig) {
    const dev = account.cfg?.tickets?.cluster === 'devnet' ? '?cluster=devnet' : '';
    return ` <a class="tr-paid" href="https://solscan.io/tx/${p.sig}${dev}" target="_blank" rel="noopener">${icon('check', 12)}Paid · view</a>`;
  }
  if (p.status === 'pending' || p.status === 'sent') return ' <span class="tr-paid wait">paying…</span>';
  return ' <span class="tr-paid wait">needs team attention</span>';
}

function lobbyCard(v: LobbyView, sym: string) {
  const L = v.lobby;
  const mineAt = v.seats.findIndex((s) => s.you);
  const chip =
    L.status === 'settled'
      ? L.youWon
        ? `<span class="tr-chip win">${icon('trophy', 12)}WON ${L.prize.toLocaleString('en-US')} ${sym}</span>${payoutNote(v.payout)}`
        : `<span class="tr-chip">SETTLED · P${mineAt + 1}</span>`
      : L.status === 'refunded'
        ? `<span class="tr-chip">${v.refund ? v.refund.status === 'paid' ? 'COINS REFUNDED' : v.refund.status === 'failed' ? 'REFUND NEEDS ATTENTION' : 'REFUND PENDING' : 'TICKET RETURNED'}</span>${v.refund ? payoutNote(v.refund) : ''}`
        : `<span class="tr-chip open">${L.seats}/${L.maxSeats} · settles by ${new Date(L.settleBy).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>`;
  const best = v.seats.find((s) => s.finished)?.finishTime ?? null;
  const rows = v.seats
    .map((s, i) => {
      const time = s.ready ? 'paid · ready' : s.racing ? 'racing…' : s.finished ? (i === 0 || best === null ? fmt(s.finishTime!, 2) : `+${(s.finishTime! - best).toFixed(2)}s`) : 'DNF';
      return `<li class="${s.you ? 'me' : ''}"><span class="p">${i + 1}</span><span class="dot" style="--c:${s.color}"></span><span class="n">${s.you ? 'You' : escapeHtml(s.name)}</span><span class="g">${time}</span></li>`;
    })
    .join('');
  return `<div class="tr-lobby">${L.code ? `<a class="hero-link" href="${friendHref(L.code)}">Friend lobby · ${escapeHtml(L.code)}</a>` : ''}<div class="tr-lobby-top">${chip}<span class="muted small">pot ${L.pot.toLocaleString('en-US')} ${sym}</span></div><ol>${rows}</ol></div>`;
}

function raceNow(code?: string) {
  const color = (() => {
    try {
      return localStorage.getItem('agp-color') ?? PLAYER_COLORS[0];
    } catch {
      return PLAYER_COLORS[0];
    }
  })();
  pending = async () => {
    try { return await account.api<TicketRun>('/api/lobby/join', { color, coinRevision: account.cfg?.coinLaunch?.revision, ...(code ? { code } : {}) }); }
    catch (e) {
      if (code) { toast((e as Error).message); location.hash = friendHref(code); }
      throw e;
    }
  };
  location.hash = '#/run';
}

async function buy() {
  const step = $('tr-step');
  const btn = $<HTMLButtonElement>('tr-buy');
  btn.disabled = true;
  try {
    const { ticketCheckout } = await import('./ticketCheckout');
    const n = await ticketCheckout();
    step.textContent = '';
    toast(`Ticket bought: you have ${n}`);
    void renderRacePage();
  } catch (e) {
    step.textContent = (e as Error).message;
  } finally {
    btn.disabled = false;
  }
}

async function faucet() {
  const step = $('tr-step');
  const btn = $<HTMLButtonElement>('tr-faucet');
  btn.disabled = true;
  try {
    const { getTestCoins } = await import('./tickets');
    step.textContent = await getTestCoins((t) => (step.textContent = t));
  } catch (e) {
    step.textContent = (e as Error).message;
  } finally {
    btn.disabled = false;
  }
}
