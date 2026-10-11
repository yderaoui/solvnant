import { account } from './account';
import { escapeHtml } from './codeViewer';
import { icon } from './icons';
import { audio } from './view3d';
import './winnerCelebration.css';

const seen = new Set<string>();
let dismiss: (() => void) | undefined;

/** Only a final server verdict can reveal a paid prize. */
export function celebrateSettledWin(view: {
  lobby: { id: string; status: string; youWon: boolean; prize: number };
  payout?: { status: string } | null;
}) {
  if (!account.me || view.lobby.status !== 'settled' || !view.lobby.youWon) return;
  celebrateWin(`paid:${account.me.id}:${view.lobby.id}`, 'Race winner',
    `${view.lobby.prize.toLocaleString('en-US')} ${account.cfg?.tickets?.symbol ?? ''}`,
    view.payout?.status === 'paid' ? 'Prize paid to your game wallet.' : 'Prize won. Check your race results for payout status.');
}

export function celebrateWin(id: string, label: string, prize?: string, note = 'First across the line. Enjoy the moment.', details?: { finishTime: number | null; laps: number }) {
  if (dismiss || seen.has(id)) return;
  let saved: string[] = [];
  try { saved = JSON.parse(sessionStorage.getItem('pumpkart-celebrated') ?? '[]'); } catch { /* Storage may be unavailable. */ }
  if (!Array.isArray(saved)) saved = [];
  if (saved.includes(id)) return;
  seen.add(id);
  try { sessionStorage.setItem('pumpkart-celebrated', JSON.stringify([...saved, id].slice(-100))); } catch { /* Memory still prevents duplicates. */ }
  const opener = document.activeElement as HTMLElement | null;
  const overlay = document.createElement('div');
  overlay.className = 'pk-win';
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const particles = reduced ? '' : Array.from({ length: 72 }, (_, i) =>
    `<i style="--x:${i % 2 ? 92 : 8}%;--delay:${((i * 17) % 23) * 0.025}s;--burst:${(i % 2 ? -1 : 1) * (8 + ((i * 47) % 73) / 73 * 55)}vw;--rise:${45 + ((i * 29) % 71) / 71 * 40}vh;--drift:${(i % 2 ? 1 : -1) * (20 + i % 60)}px;--turn:${(i % 2 ? 1 : -1) * (360 + ((i * 53) % 720))}deg;--color:${['#ff006e', '#00ffff', '#ffd36a', '#fff'][i % 4]}" ></i>`).join('');
  const time = details?.finishTime;
  const hundredths = time != null && Number.isFinite(time) && time > 0 ? Math.round(time * 100) : null;
  const finishTime = hundredths != null ? `${Math.floor(hundredths / 6000)}:${((hundredths % 6000) / 100).toFixed(2).padStart(5, '0')}` : null;
  overlay.innerHTML = `<div class="pk-win-lights" aria-hidden="true"><span></span><span></span></div><div class="pk-win-confetti" aria-hidden="true">${particles}</div>
    <section class="pk-win-card" role="dialog" aria-modal="true" aria-labelledby="pk-win-title" aria-describedby="pk-win-note" tabindex="-1">
      <button class="pk-win-close icon-btn" aria-label="Close celebration">${icon('x', 18)}</button>
      <p class="pk-win-kicker">${escapeHtml(label)}</p>
      <div class="pk-win-emblem" aria-hidden="true"><span class="pk-win-ring"></span><span class="pk-win-podium"></span>
        <svg class="pk-win-laurel" viewBox="0 0 200 180" fill="none" stroke="currentColor" stroke-width="2"><path d="M66 148C12 120 12 60 45 29M134 148C188 120 188 60 155 29"/><path d="M27 65l-9-20m9 20 17-9M21 86 8 70m13 16 17-7M27 108l-17-12m17 12 16-9M42 130l-20-5m20 5 10-16M173 65l9-20m-9 20-17-9M179 86l13-16m-13 16-17-7M173 108l17-12m-17 12-16-9M158 130l20-5m-20 5-10-16"/></svg>
        ${icon('trophy', 102)}<span class="pk-win-place">1ST PLACE</span>
      </div>
      <h2 id="pk-win-title">YOU <span>WON</span></h2>
      ${finishTime && Number.isInteger(details?.laps) ? `<div class="pk-win-stats"><div><small>RACE TIME</small><strong>${finishTime}</strong></div><div><small>LAPS</small><strong>${details!.laps}</strong></div></div>` : ''}
      ${prize ? `<div class="pk-win-prize"><small>YOUR PRIZE</small><strong>${escapeHtml(prize)}</strong></div>` : ''}
      <p id="pk-win-note">${escapeHtml(note)}</p>
      <button class="btn btn-lime pk-win-continue">Continue${icon('overtake', 18)}</button>
    </section>`;
  const card = overlay.querySelector<HTMLElement>('.pk-win-card')!;
  const buttons = [...overlay.querySelectorAll<HTMLButtonElement>('button')];
  // Keep the page out of the modal's keyboard and accessibility navigation.
  const background = [...document.body.children].filter((el): el is HTMLElement => el instanceof HTMLElement && !el.inert);
  background.forEach(el => el.inert = true);
  document.body.append(overlay);
  const stopSound = audio.victory();
  const cleanupParticles = setTimeout(() => overlay.querySelector('.pk-win-confetti')?.remove(), 4600);
  const onKey = (e: KeyboardEvent) => {
    e.stopImmediatePropagation();
    if (e.type !== 'keydown') return;
    if (e.key === 'Escape') { e.preventDefault(); dismiss?.(); }
    if (e.key === 'Tab') {
      e.preventDefault();
      const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
      const next = index < 0 ? (e.shiftKey ? buttons.length - 1 : 0) : (index + (e.shiftKey ? -1 : 1) + buttons.length) % buttons.length;
      buttons[next].focus();
    }
  };
  dismiss = () => {
    clearTimeout(cleanupParticles);
    stopSound?.();
    overlay.remove();
    background.forEach(el => el.inert = false);
    window.removeEventListener('keydown', onKey, true);
    window.removeEventListener('keyup', onKey, true);
    window.removeEventListener('hashchange', close);
    unsubscribe();
    dismiss = undefined;
    if (opener?.isConnected) opener.focus({ preventScroll: true });
  };
  const close = () => dismiss?.();
  const unsubscribe = account.onChange(() => { if (!account.me) close(); });
  buttons.forEach(button => button.onclick = close);
  window.addEventListener('keydown', onKey, true);
  window.addEventListener('keyup', onKey, true);
  window.addEventListener('hashchange', close);
  card.focus({ preventScroll: true });
}
