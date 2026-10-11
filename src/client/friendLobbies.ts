import { account, priceLabel, showAuthModal } from './account';
import { escapeHtml } from './codeViewer';
import { icon } from './icons';
import { normalizeFriendCode, friendEntryUsd } from '../game/friendLobbies';
import { celebrateSettledWin } from './winnerCelebration';

interface FriendView {
  payout?: { status: string; sig?: string | null } | null;
  tickets: number;
  entryReady?: boolean;
  refund?: { amount: number; status: string; sig?: string | null } | null;
  lobby: { id: string; code: string; status: string; hostedByYou: boolean; seats: number; maxSeats: number; settleBy: number; pot: number; prize: number; youWon: boolean; entry?: { usd: number; coins: number } | null };
  seats: { name: string; you: boolean; racing: boolean; finished: boolean; finishTime: number | null; ready?: boolean }[];
}

let generation = 0;
let refreshTimer: ReturnType<typeof setTimeout> | undefined;
export const friendHref = (code: string) => `#/race/friends/${encodeURIComponent(code)}`;
export const friendLink = (code: string) => `${location.origin}${location.pathname}${friendHref(code)}`;

export function friendLobbyHtml(): string {
  const invite = location.hash.startsWith('#/race/friends/');
  const test = account.cfg?.coinLaunch?.mode === 'test';
  const initialEntry = test ? 0.01 : 20;
  const quickEntries = test ? [0.01, 0.05, 0.1, 1] : [5, 10, 20, 50];
  return `<section class="card friends-panel" aria-labelledby="friends-title">
    <div class="friends-heading"><div><h2 id="friends-title">Race with friends</h2><p class="muted">Choose the entry. Invite four friends. Everyone pays the same amount.</p></div></div>
    ${invite ? '<details class="friends-another"><summary>Create another lobby</summary>' : ''}<form id="friends-create-form" class="friends-create-form">
      <label for="friends-entry">Entry per player <span class="muted">USD</span></label>
      <div class="friends-entry-row"><div class="friends-dollar-input"><span aria-hidden="true">$</span><input id="friends-entry" type="number" min="0.01" step="0.01" value="${initialEntry}" inputmode="decimal" required aria-describedby="friends-entry-note" /></div><button class="btn btn-lime" id="friends-create">${icon('users', 16)}<span>Create $${initialEntry} lobby</span></button></div>
      <div class="friends-amounts" aria-label="Quick entry amounts">${quickEntries.map(n => `<button class="btn btn-ghost small" type="button" data-entry="${n}" aria-pressed="${n === initialEntry}">$${n}</button>`).join('')}</div>
      <p class="small muted" id="friends-entry-note">Creating a lobby costs nothing. All five players approve the same coin payment. Winner gets 80% of the pot.</p>
    </form>${invite ? '</details>' : ''}
    <form id="friends-join" class="friends-join"><label for="friends-code">Have an invite?</label><div class="input-row"><input id="friends-code" placeholder="Paste lobby code or link" autocomplete="off" spellcheck="false" maxlength="300" /><button class="btn">Open lobby</button></div></form>
    <p class="small muted" id="friends-status" role="status" aria-live="polite"></p>
    <div id="friends-room"></div>
  </section>`;
}

export function mountFriendLobbies(startRace: (code: string) => void) {
  const my = ++generation;
  clearTimeout(refreshTimer);
  const found = document.querySelector<HTMLElement>('.friends-panel');
  if (!found) return;
  const panel = found;
  const status = panel.querySelector<HTMLElement>('#friends-status')!;
  const input = panel.querySelector<HTMLInputElement>('#friends-code')!;
  const routeCode = location.hash.match(/^#\/race\/friends\/([^/?#]+)/)?.[1];
  const code = routeCode ? normalizeFriendCode(routeCode) : null;
  const current = () => my === generation && panel.isConnected && !document.getElementById('view-race')!.hidden;
  const signin = () => { status.textContent = 'Sign in with X to open your friend lobby. Your invite will stay here.'; showAuthModal(); };

  panel.querySelector<HTMLFormElement>('#friends-join')!.onsubmit = (e) => {
    e.preventDefault();
    const next = normalizeFriendCode(input.value);
    if (!next) { status.textContent = 'Enter an 8-character code or paste a PumpKart lobby link.'; input.focus(); return; }
    if (location.hash === friendHref(next)) void load();
    else location.hash = friendHref(next);
  };
  const createForm = panel.querySelector<HTMLFormElement>('#friends-create-form')!;
  const fundingLive = account.cfg?.coinLaunch?.status === 'live' && account.cfg.coinLaunch.paidEnabled !== false;
  if (!fundingLive) {
    panel.querySelector<HTMLButtonElement>('#friends-create')!.disabled = true;
    panel.querySelector<HTMLElement>('#friends-entry-note')!.textContent = 'Custom paid lobbies open when the official coin launches. You can preview an entry amount now and practice for free.';
  }
  const amountInput = panel.querySelector<HTMLInputElement>('#friends-entry')!;
  const paintAmount = () => {
    const usd = friendEntryUsd(amountInput.valueAsNumber);
    panel.querySelector('#friends-create span')!.textContent = usd ? `Create $${usd.toLocaleString('en-US')} lobby` : 'Create lobby';
    for (const preset of panel.querySelectorAll<HTMLButtonElement>('[data-entry]')) preset.setAttribute('aria-pressed', String(Number(preset.dataset.entry) === usd));
  };
  amountInput.oninput = paintAmount;
  for (const preset of panel.querySelectorAll<HTMLButtonElement>('[data-entry]')) preset.onclick = () => { amountInput.value = preset.dataset.entry!; paintAmount(); };
  createForm.onsubmit = async (e) => {
    e.preventDefault();
    if (!fundingLive) { status.textContent = 'Paid lobbies open when the official coin launches.'; return; }
    if (!account.me) return signin();
    const entryUsd = friendEntryUsd(amountInput.valueAsNumber);
    if (entryUsd === null) { status.textContent = 'Choose a dollar amount of at least $0.01, with up to two decimal places.'; amountInput.focus(); return; }
    const btn = panel.querySelector<HTMLButtonElement>('#friends-create')!;
    btn.disabled = true;
    status.textContent = 'Creating your private lobby…';
    try {
      const v = await account.api<FriendView>('/api/lobby/private/create', { entryUsd, coinRevision: account.cfg?.coinLaunch?.revision });
      if (!current()) return;
      if (!v.lobby.entry || v.lobby.entry.usd !== entryUsd || !(v.lobby.entry.coins > 0)) {
        throw new Error('Custom entries are not available on this game server yet. Try again after it is updated.');
      }
      location.hash = friendHref(v.lobby.code);
    } catch (e) { if (current()) status.textContent = (e as Error).message; }
    finally { btn.disabled = false; }
  };
  if (routeCode && !code) { status.textContent = 'This invite code is invalid. Ask your friend for a new link.'; return; }
  if (!code) return;
  input.value = code;
  if (!account.me) {
    status.textContent = `You have been invited to lobby ${code}. Sign in with X to see the players and enter.`;
    const room = panel.querySelector<HTMLElement>('#friends-room')!;
    room.innerHTML = '<button class="btn btn-lime" id="friends-signin">Sign in to open lobby</button>';
    room.querySelector<HTMLButtonElement>('#friends-signin')!.onclick = signin;
    return;
  }
  void load();

  async function load() {
    clearTimeout(refreshTimer);
    if (!current() || !code || !account.me) return;
    try {
      const v = await account.api<FriendView>('/api/lobby/private/view', { code });
      if (!current()) return;
      status.textContent = '';
      const L = v.lobby;
      const mine = v.seats.find((s) => s.you && !s.ready);
      const entry = L.entry;
      const paid = entry ? !!v.entryReady : v.tickets > 0;
      const entryLabel = entry ? `$${entry.usd.toLocaleString('en-US')}` : escapeHtml(priceLabel(account.cfg!.tickets!));
      const closed = L.status !== 'open' || Date.now() >= L.settleBy;
      const full = L.seats >= L.maxSeats;
      const sym = escapeHtml(account.cfg?.tickets?.symbol ?? 'game coins');
      const url = friendLink(code);
      const room = panel.querySelector<HTMLElement>('#friends-room')!;
      const hadFocus = room.contains(document.activeElement);
      const focusedId = hadFocus ? (document.activeElement as HTMLElement).id : '';
      const fundingOpen = !!room.querySelector<HTMLDetailsElement>('details')?.open;
      room.innerHTML = `<div class="friends-room-head"><div><span class="muted small">Private lobby${L.hostedByYou ? ' · created by you' : ''}</span><h3>${escapeHtml(code.slice(0, 4))}<span> </span>${escapeHtml(code.slice(4))}</h3></div><span class="pill">${L.seats}/${L.maxSeats} players</span></div>
        ${entry ? `<div class="friends-stake"><div><span>Same entry for everyone</span><strong>${entryLabel}<small> / player</small></strong><p>${entry.coins.toLocaleString('en-US', { maximumFractionDigits: account.cfg?.tickets?.decimals ?? 6 })} ${sym}</p></div><div><span>Winner at a full lobby</span><strong>$${(entry.usd * 4).toLocaleString('en-US')}</strong><p>80% of the 5-player pot</p></div></div><p class="small muted">Coin amount locked when this lobby was created. Dollar value can change. The creator pays the same entry as everyone else.</p>` : ''}
        <div class="friends-share"><button class="btn small" id="friends-copy-link">${icon('link', 14)}Copy invite link</button><button class="btn btn-ghost small" id="friends-copy-code">${icon('copy', 14)}Copy code</button></div>
        <details ${fundingOpen ? 'open' : ''}><summary class="small muted">Show invite link</summary><input aria-label="Invite link" id="friends-link" value="${escapeHtml(url)}" readonly /></details>
        <ol class="friends-seats">${Array.from({ length: L.maxSeats }, (_, i) => {
          const s = v.seats[i];
          return `<li><span>${i + 1}</span><b>${s ? s.you ? 'You' : escapeHtml(s.name) : 'Waiting for a friend'}</b><small>${s ? s.ready ? 'Paid · ready' : s.racing ? 'Racing' : s.finished ? 'Run complete' : 'Did not finish' : 'Open seat'}</small></li>`;
        }).join('')}</ol>
        <p class="small muted">${L.status === 'settled' ? `Results are final. ${L.youWon ? 'You won!' : 'The fastest run won.'}` : L.status === 'refunded' ? entry ? 'Lobby closed. Full coin refunds are sent to the wallets that paid.' : 'Lobby closed. Entered players received their tickets back.' : `Invite up to 4 friends. Entry closes at ${new Date(L.settleBy).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}. At least 4 completed runs are needed for a prize; otherwise ${entry ? 'the entry coins are refunded' : 'tickets are returned'}.`}</p>
        <p class="small muted">Each player drives their own run on the same track. Earlier runs appear as ghosts. Winner gets 80% of the pot, 15% is burned, 5% goes to the team. No bots.</p>
        <p class="small">${entry ? '' : `Entry: 1 ticket (${entryLabel}). `}Race pot: ${L.pot.toLocaleString('en-US')} ${sym}</p>
        ${v.refund ? `<p class="friends-entered">${v.refund.status === 'paid' ? 'Refund paid' : ['failed', 'manual'].includes(v.refund.status) ? 'Refund needs team attention' : 'Refund pending'}: ${v.refund.amount.toLocaleString('en-US')} ${sym} to the wallet that paid.${paymentLink(v.refund.sig)}</p>` : ''}
        ${L.youWon && v.payout ? `<p class="friends-entered">${v.payout.status === 'paid' ? 'Prize paid' : ['failed', 'manual'].includes(v.payout.status) ? 'Prize needs team attention' : 'Sending your prize'}: ${L.prize.toLocaleString('en-US')} ${sym}.${paymentLink(v.payout.sig)}</p>` : ''}
        ${mine ? `<p class="friends-entered">${mine.racing ? 'Your run has started. You cannot restart it.' : 'Your run is recorded. Check back here for your friends’ results.'}</p>` : closed || (full && !paid) ? `<p class="friends-entered">${closed ? 'This lobby is closed. Create a new lobby to race again.' : 'All seats are taken.'}</p>` : `<button class="btn btn-lime" id="friends-race">${paid ? entry ? 'Start my run · entry paid' : 'Start my run · uses 1 ticket' : entry ? `Pay ${entryLabel} entry` : `Buy 1 ticket for ${entryLabel}`}</button><p class="small muted">${paid ? 'Leaving a started race counts as not finishing.' : entry ? 'Review and approve your coin payment, then start your run. Regular race tickets do not pay a custom lobby entry.' : 'Buying a ticket does not take a seat. Return here to start your run.'}</p>`}
        <a class="hero-link" href="#/race">Back to public races</a>`;
      const copy = async (text: string) => {
        try { await navigator.clipboard.writeText(text); status.textContent = 'Copied. Send it to your friends.'; }
        catch { status.textContent = 'Copy the invite link shown below.'; room.querySelector<HTMLDetailsElement>('details')!.open = true; room.querySelector<HTMLInputElement>('#friends-link')!.select(); }
      };
      room.querySelector<HTMLButtonElement>('#friends-copy-link')!.onclick = () => void copy(url);
      room.querySelector<HTMLButtonElement>('#friends-copy-code')!.onclick = () => void copy(code);
      const go = room.querySelector<HTMLButtonElement>('#friends-race');
      if (go && !fundingLive) { go.disabled = true; go.textContent = 'Paid entry is paused'; }
      if (go) go.onclick = async () => {
        clearTimeout(refreshTimer);
        go.disabled = true;
        if (paid) { startRace(code); return; }
        try { const { ticketCheckout } = await import('./ticketCheckout'); await ticketCheckout(entry ? code : undefined); }
        catch (e) { if (current()) status.textContent = (e as Error).message; }
        finally { if (current()) { go.disabled = false; void load(); } }
      };
      if (focusedId) room.querySelector<HTMLElement>(`#${focusedId}`)?.focus({ preventScroll: true });
      celebrateSettledWin(v);
      // Crossing the deadline or submitting a wire is not a final result. Keep polling
      // until the server closes the room and confirms its refund/prize on-chain.
      if (L.status === 'open' || ['pending', 'sent'].includes(v.refund?.status ?? '') || ['pending', 'sent'].includes(v.payout?.status ?? '')) refreshTimer = setTimeout(() => void load(), 8000);
    } catch (e) {
      if (current()) { status.textContent = (e as Error).message; refreshTimer = setTimeout(() => void load(), 15000); }
    }
  }
}

function paymentLink(sig?: string | null): string {
  if (!sig || !/^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(sig)) return '';
  const dev = account.cfg?.tickets?.cluster === 'devnet' ? '?cluster=devnet' : '';
  return ` <a href="https://solscan.io/tx/${sig}${dev}" target="_blank" rel="noopener">View transaction ↗</a>`;
}
