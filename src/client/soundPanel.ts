// Sound panel: opens from the speaker button. Volume, engine / crowd / effects levels, engine style
// and a test drive of the sound. Saved per player (audio.configure). M still mutes straight away.
import { audio } from './view3d';
import { SOUND_DEFAULTS, type EngineStyle, type SoundSettings } from './audio';
import { icon } from './icons';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
let panel: HTMLDivElement | null = null;

export function paintSoundButton() {
  const b = $('mute-btn');
  b.innerHTML = icon(audio.muted ? 'mute' : 'sound');
  b.setAttribute('aria-label', 'Sound settings');
  b.setAttribute('title', 'Sound settings (M mutes)');
  b.setAttribute('aria-expanded', String(!!panel));
}

const SLIDERS: [keyof SoundSettings, string][] = [
  ['volume', 'Volume'],
  ['engine', 'Engine'],
  ['crowd', 'Crowd'],
  ['fx', 'Tyres & crashes'],
];
const STYLE_NAMES: [EngineStyle, string, string][] = [
  ['deep', 'Deep', 'low V8 rumble'],
  ['classic', 'Classic', 'the default'],
  ['screamer', 'Screamer', 'high-revving race car'],
];

export function toggleSoundPanel() {
  if (panel) return closeSoundPanel();
  audio.start(); // the click is a user gesture: sound may start now
  panel = document.createElement('div');
  panel.className = 'snd-panel';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', 'Sound settings');
  document.body.appendChild(panel);
  paint();
  place();
  setTimeout(() => {
    document.addEventListener('pointerdown', outside, true);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', place);
  });
  paintSoundButton();
}

export function closeSoundPanel() {
  panel?.remove();
  panel = null;
  document.removeEventListener('pointerdown', outside, true);
  window.removeEventListener('keydown', onKey, true);
  window.removeEventListener('resize', place);
  paintSoundButton();
}

/** M key: mute / unmute (keeps an open panel in sync). */
export function toggleMuteQuick() {
  audio.start();
  audio.setMuted(!audio.muted);
  paintSoundButton();
  if (panel) paint();
}

function outside(e: Event) {
  const t = e.target as Node;
  if (panel?.contains(t) || $('mute-btn').contains(t)) return;
  closeSoundPanel();
}

function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    e.stopPropagation();
    closeSoundPanel();
    $('mute-btn').focus();
  }
}

function place() {
  if (!panel) return;
  const r = $('mute-btn').getBoundingClientRect();
  const w = Math.min(300, window.innerWidth - 16);
  panel.style.width = `${w}px`;
  panel.style.left = `${Math.max(8, Math.min(window.innerWidth - w - 8, r.left + r.width / 2 - w / 2))}px`;
  const below = r.bottom + 8;
  if (below + 380 < window.innerHeight) {
    panel.style.top = `${below}px`;
    panel.style.bottom = '';
  } else {
    panel.style.top = '';
    panel.style.bottom = `${window.innerHeight - r.top + 8}px`;
  }
}

function paint() {
  if (!panel) return;
  const s = audio.settings;
  panel.innerHTML = `
    <div class="snd-head"><b>Sound</b>
      <button class="snd-mute ${audio.muted ? 'on' : ''}" id="snd-mute" aria-pressed="${audio.muted}">${icon(audio.muted ? 'mute' : 'sound', 14)}${audio.muted ? 'Muted' : 'On'}</button></div>
    ${SLIDERS.map(
      ([k, label]) => `
      <label class="snd-row"><span>${label}</span>
        <input type="range" min="0" max="100" step="1" value="${Math.round((s[k] as number) * 100)}" data-k="${k}" aria-label="${label}" ${audio.muted ? 'disabled' : ''} />
        <output>${Math.round((s[k] as number) * 100)}</output></label>`,
    ).join('')}
    <div class="snd-label">Engine sound</div>
    <div class="snd-styles" role="radiogroup" aria-label="Engine sound">
      ${STYLE_NAMES.map(([id, name, hint]) => `<button role="radio" aria-checked="${s.style === id}" class="${s.style === id ? 'on' : ''}" data-style="${id}" title="${hint}">${name}</button>`).join('')}
    </div>
    <div class="snd-foot">
      <button class="btn small btn-lime" id="snd-test">${icon('play', 12)}Test sound</button>
      <button class="btn small btn-ghost" id="snd-reset">Reset</button>
    </div>`;
  for (const r of panel.querySelectorAll<HTMLInputElement>('input[type=range]'))
    r.oninput = () => {
      audio.configure({ [r.dataset.k!]: Number(r.value) / 100 });
      (r.nextElementSibling as HTMLOutputElement).textContent = r.value;
    };
  for (const b of panel.querySelectorAll<HTMLButtonElement>('[data-style]'))
    b.onclick = () => {
      audio.configure({ style: b.dataset.style as EngineStyle });
      paint();
      audio.preview();
    };
  $('snd-mute').onclick = () => toggleMuteQuick();
  $('snd-test').onclick = () => audio.preview();
  $('snd-reset').onclick = () => {
    audio.configure({ ...SOUND_DEFAULTS });
    paint();
  };
}
