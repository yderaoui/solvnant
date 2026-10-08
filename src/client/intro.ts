// The intro: the RaceTrench lore in five quick cards. Plays once on a first visit (skippable), and
// again from the Race page. Space / Enter / click = next, Esc = skip.
import { SKINS } from '../game/skins';

const SEEN = 'rt-intro-seen';
const PIC = (file: string) => `${import.meta.env.BASE_URL}assets/characters/${file}.webp`;

interface Card {
  kicker: string;
  title: string;
  text: string;
  art?: string; // inner HTML for the picture area
}

const racers = (ids: string[]) =>
  `<div class="in-row">${ids
    .map((id, i) => {
      const s = SKINS.find((k) => k.id === id);
      return s ? `<img src="${PIC(s.file)}" alt="${s.name}" style="--d:${i * 0.12}s" />` : '';
    })
    .join('')}</div>`;

const CARDS: Card[] = [
  {
    kicker: 'THE YEAR IS 2049',
    title: 'The charts went to zero.',
    text: 'Every memecoin. Every “100x gem”. And the KOLs who shilled them went down with the ship.',
    art: `<div class="in-chart"><svg viewBox="0 0 300 120" aria-hidden="true"><polyline points="0,20 40,30 70,18 110,45 140,40 180,80 210,74 250,108 300,116" /></svg><span>-99.9%</span></div>`,
  },
  {
    kicker: 'THE BOTTLES RAN DRY',
    title: 'No more champagne.',
    text: 'They sold the chains. They sold the cars. Orangie even sold the tacos. Bottle service is a distant memory.',
    art: `<div class="in-bottle" aria-hidden="true"><span>🍾</span><b>EMPTY</b></div>`,
  },
  {
    kicker: 'THEN, A RUMOR ON THE TIMELINE',
    title: 'The Magic Ledger.',
    text: 'Somewhere at the end of the Trench lies a wallet that never runs dry. Its seed phrase is painted on the finish line.',
    art: `<div class="in-ledger" aria-hidden="true"><div class="in-glow"></div><div class="in-book">LEDGER</div></div>`,
  },
  {
    kicker: 'ONE RULE',
    title: 'First across the line signs.',
    text: 'Five racers. One track. The winner takes the whole pot. Everyone else goes home thirsty.',
    art: `<div class="in-flag" aria-hidden="true"></div>`,
  },
  {
    kicker: 'SO THEY RACED',
    title: 'In whatever they had left.',
    text: 'A wheelchair. A shopping cart. A bull. A land yacht. Pick your KOL and race for the Ledger.',
    art: racers(['orangie', 'rasmr', 'ansem', 'jack', 'tjr']),
  },
];

let open = false;

export function introSeen(): boolean {
  try {
    return localStorage.getItem(SEEN) === '1';
  } catch {
    return true; // storage blocked: don't nag every visit
  }
}

export function showIntro() {
  if (open) return;
  open = true;
  try {
    localStorage.setItem(SEEN, '1');
  } catch {
    /* ignore */
  }
  const el = document.createElement('div');
  el.className = 'intro';
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-modal', 'true');
  el.setAttribute('aria-label', 'RaceTrench intro');
  document.body.appendChild(el);
  let i = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const close = () => {
    clearTimeout(timer);
    window.removeEventListener('keydown', onKey, true);
    el.classList.add('out');
    setTimeout(() => el.remove(), 350);
    open = false;
  };
  const go = (n: number) => {
    clearTimeout(timer);
    if (n >= CARDS.length) {
      close();
      if (!location.hash.startsWith('#/race')) location.hash = '#/race';
      return;
    }
    i = n;
    const c = CARDS[i];
    const last = i === CARDS.length - 1;
    el.innerHTML = `
      <div class="in-card" key="${i}">
        <div class="in-art">${c.art ?? ''}</div>
        <div class="in-kicker">${c.kicker}</div>
        <h2 class="in-title">${c.title}</h2>
        <p class="in-text">${c.text}</p>
        ${last ? `<button class="btn btn-lime in-cta" data-next>RACE FOR THE LEDGER</button>` : ''}
      </div>
      <div class="in-dots">${CARDS.map((_, k) => `<i class="${k === i ? 'on' : ''}"></i>`).join('')}</div>
      <button class="in-skip" data-skip>${last ? 'Close' : 'Skip intro'}</button>
      ${last ? '' : `<button class="in-next" data-next aria-label="Next">›</button>`}`;
    if (!last) timer = setTimeout(() => go(i + 1), 5200);
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') close();
    else if (e.key === ' ' || e.key === 'Enter' || e.key === 'ArrowRight') go(i + 1);
    else if (e.key === 'ArrowLeft') go(Math.max(0, i - 1));
    else return;
    e.preventDefault();
    e.stopPropagation();
  };
  el.addEventListener('click', (e) => {
    const t = e.target as HTMLElement;
    if (t.closest('[data-skip]')) close();
    else go(i + 1);
  });
  window.addEventListener('keydown', onKey, true);
  go(0);
}
