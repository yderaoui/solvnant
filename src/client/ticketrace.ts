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

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

interface Seat {
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
  lobby: { id: string; status: string; settleBy: number; seats: number; maxSeats: number; pot: number; prize: number; youWon: boolean };
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

export async function renderRacePage() {
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
    el.innerHTML = `<p class="garage-note">${icon('alert', 14)}Ticketed races are not switched on for this server.</p>`;
    return;
  }
  const how = `
    <button class="tr-intro" id="tr-intro">▶ Why are they racing? Watch the intro</button>
    <ol class="tr-how">
      <li><b>Buy a ticket</b><span>${escapeHtml(priceLabel(t))} each, paid in ${sym}</span></li>
      <li><b>Race the ghosts</b><span>The recorded runs of the players already in your lobby. No bots, no waiting.</span></li>
      <li><b>Fastest wins it all</b><span>The lobby settles at 5 players, or at 4 after 30 minutes. 3 or fewer: tickets refunded.</span></li>
    </ol>`;
  if (!account.me) {
    el.innerHTML = `<div class="tr-grid"><section class="card tr-main">${pot(t, sym)}${how}
      <button class="btn btn-lime tr-go" id="tr-signin">${icon('flag', 16)}SIGN IN WITH X TO RACE</button>
      <a class="btn btn-ghost tr-alt" href="#/drive">${icon('pad', 14)}Test drive first, free</a></section></div>`;
    $('tr-signin').onclick = () => showAuthModal();
    $('tr-intro').onclick = () => showIntro();
    return;
  }
  let mine: Mine;
  try {
    mine = await account.api<Mine>('/api/lobby/mine');
  } catch (e) {
    el.innerHTML = `<p class="garage-note">${icon('alert', 14)}${escapeHtml((e as Error).message)}</p>`;
    return;
  }
  if ($('view-race').hidden) return;
  const devnet = t.cluster === 'devnet';
  el.innerHTML = `
    <div class="tr-grid">
      <section class="card tr-main">
        ${pot(t, sym)}
        ${how}
        <div class="lb-ticket"><span><b>Your tickets: <span id="tr-tix">${mine.tickets}</span></b><small>${escapeHtml(priceLabel(t))} each${t.priceUsd ? `, paid in ${sym} at the live price` : ''}${devnet ? ' · test coins, no real value' : ''}</small></span>
          <button class="btn small" id="tr-buy">${icon('zap', 14)}Buy ticket</button></div>
        ${devnet ? `<button class="btn small btn-ghost lb-faucet" id="tr-faucet">${icon('zap', 14)}Get free test ${sym}</button>` : ''}
        <p class="muted small" id="tr-step"></p>
        <button class="btn btn-lime tr-go" id="tr-go" ${mine.tickets ? '' : 'disabled'}>${icon('flag', 16)}RACE NOW <small>uses 1 ticket</small></button>
        <p class="muted small tr-note">Once you start, the run counts: leaving mid-race is a DNF.</p>
      </section>
      <section class="card tr-side">
        ${mine.owed ? `<div class="tr-owed">${icon('trophy', 18)}<span><b>${mine.owed.toLocaleString('en-US')} ${sym} won</b><small>Paid out onchain once the prize escrow is live.</small></span></div>` : ''}
        <h3>Your races</h3>
        ${mine.lobbies.length ? mine.lobbies.map((l) => lobbyCard(l, sym)).join('') : `<p class="muted small">No races yet. Your lobbies show up here.</p>`}
      </section>
    </div>`;
  $('tr-go').onclick = () => raceNow();
  $('tr-intro').onclick = () => showIntro();
  $('tr-buy').onclick = () => void buy();
  const f = document.getElementById('tr-faucet');
  if (f) f.onclick = () => void faucet();
}

function pot(t: { price: number; priceUsd?: number }, sym: string) {
  const full = (t.priceUsd ?? t.price) * 5;
  const n = (v: number) => v.toLocaleString('en-US');
  const big = t.priceUsd ? `$${n(full * 0.8)} <small>in ${sym}</small>` : `${n(full * 0.8)} <small>${sym}</small>`;
  return `<div class="tr-pot">
    <div class="tr-kicker">5 PLAYERS · ONE TRACK · WINNER TAKES ALL</div>
    <div class="tr-big">${big}</div>
    <div class="muted small">to the winner of a full lobby (80% of ${t.priceUsd ? '$' : ''}${n(full)}${t.priceUsd ? '' : ' ' + sym}). 15% is burned, 5% goes to the team.</div>
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
  return ' <span class="tr-paid wait">paid by the team shortly</span>';
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
        ? `<span class="tr-chip">REFUNDED</span>`
        : `<span class="tr-chip open">${L.seats}/${L.maxSeats} · settles by ${new Date(L.settleBy).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>`;
  const best = v.seats.find((s) => s.finished)?.finishTime ?? null;
  const rows = v.seats
    .map((s, i) => {
      const time = s.racing ? 'racing…' : s.finished ? (i === 0 || best === null ? fmt(s.finishTime!, 2) : `+${(s.finishTime! - best).toFixed(2)}s`) : 'DNF';
      return `<li class="${s.you ? 'me' : ''}"><span class="p">${i + 1}</span><span class="dot" style="--c:${s.color}"></span><span class="n">${s.you ? 'You' : escapeHtml(s.name)}</span><span class="g">${time}</span></li>`;
    })
    .join('');
  return `<div class="tr-lobby"><div class="tr-lobby-top">${chip}<span class="muted small">pot ${L.pot.toLocaleString('en-US')} ${sym}</span></div><ol>${rows}</ol></div>`;
}

function raceNow() {
  const color = (() => {
    try {
      return localStorage.getItem('agp-color') ?? PLAYER_COLORS[0];
    } catch {
      return PLAYER_COLORS[0];
    }
  })();
  pending = () => account.api<TicketRun>('/api/lobby/join', { color });
  location.hash = '#/run';
}

async function buy() {
  const step = $('tr-step');
  const btn = $<HTMLButtonElement>('tr-buy');
  btn.disabled = true;
  try {
    const { buyTicket } = await import('./tickets');
    const n = await buyTicket((t) => (step.textContent = t));
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
