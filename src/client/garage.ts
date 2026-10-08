// Garage: pick your racer skin. Free skins work for everyone; paid ones are bought once with the game
// coin (same wallet payment as a race ticket) and kept on the account. Any skin can be test driven.
import { SKINS, DEFAULT_SKIN, isSkin, skinById } from '../game/skins';
import { account, showAuthModal } from './account';
import { escapeHtml } from './codeViewer';
import { icon } from './icons';
import { toast } from './toast';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const SLOTS = 10; // the garage shows this many bays; empty ones say "coming soon"
const ASSET = (p: string) => `${import.meta.env.BASE_URL}assets/${p}`;

let trySkin: string | null = null; // picked with "Test drive" in the garage
let busy: string | null = null; // skin being bought
const steps = new Map<string, string>(); // progress / error text per skin

/** Test drive: drive this racer (any of them, owned or not). */
export function setTrySkin(id: string) {
  trySkin = isSkin(id) ? id : null;
}

/** The skin you drive in the test drive: the one you're trying, else your own. */
export function driveSkin(): string {
  return trySkin ?? mySkin();
}

export function mySkin(): string {
  const s = account.me?.skin;
  return isSkin(s) ? s : DEFAULT_SKIN;
}

const owned = (id: string) => skinById(id).price === 0 || (account.me?.skins ?? []).includes(id);

let hooked = false;
export function renderGarage() {
  if (!hooked) {
    hooked = true;
    account.onChange(() => {
      if (!$('view-garage').hidden) renderGarage();
    });
  }
  const sym = account.cfg?.tickets?.symbol ?? '$TRACK';
  const payOn = !!account.cfg?.tickets;
  const mine = mySkin();
  const cards = SKINS.map((s) => {
    const have = owned(s.id);
    const on = have && s.id === mine;
    const step = steps.get(s.id) ?? '';
    const action = on
      ? `<button class="btn small btn-lime" disabled>${icon('check', 14)}Racing with it</button>`
      : have
        ? `<button class="btn small btn-lime" data-use="${s.id}">Race with it</button>`
        : `<button class="btn small btn-lime" data-buy="${s.id}" ${busy || !payOn ? 'disabled' : ''}>${icon('zap', 14)}Buy for ${s.price.toLocaleString('en-US')} ${escapeHtml(sym)}</button>`;
    return `<article class="bay${on ? ' on' : ''}${have ? '' : ' locked'}">
      <div class="bay-pic"><img src="${ASSET(`characters/${s.file}.webp`)}" alt="${escapeHtml(s.name)}" loading="lazy" width="480" height="360" /></div>
      <div class="bay-info">
        <div class="bay-top"><h2>${escapeHtml(s.name)}</h2><span class="bay-tag">${s.price === 0 ? 'FREE' : have ? 'OWNED' : `${icon('lock', 12)}${s.price.toLocaleString('en-US')} ${escapeHtml(sym)}`}</span></div>
        <p class="muted small">${escapeHtml(s.tagline)}</p>
        <div class="bay-actions">${action}<button class="btn small btn-ghost" data-try="${s.id}">${icon('pad', 14)}Test drive</button></div>
        <p class="muted small bay-step" aria-live="polite">${escapeHtml(step)}</p>
      </div>
    </article>`;
  });
  for (let i = SKINS.length; i < SLOTS; i++)
    cards.push(`<article class="bay empty" aria-hidden="true"><div class="bay-pic">${icon('car', 40)}</div><div class="bay-info"><h2>New racer</h2><p class="muted small">Coming soon</p></div></article>`);
  const devnet = account.cfg?.tickets?.cluster === 'devnet';
  $('garage-body').innerHTML = `
    ${!account.me ? `<p class="garage-note">${icon('alert', 14)}Sign in to buy racers and use them in live races. You can test drive any of them right now.</p>` : ''}
    ${devnet ? `<p class="garage-note">${icon('alert', 14)}Test network: racers are paid with free test ${escapeHtml(sym)} (no real value). Get some from your account menu.</p>` : ''}
    <div class="garage-grid">${cards.join('')}</div>`;

  const body = $('garage-body');
  for (const b of body.querySelectorAll<HTMLButtonElement>('[data-try]'))
    b.onclick = () => {
      trySkin = b.dataset.try!;
      location.hash = '#/drive';
    };
  for (const b of body.querySelectorAll<HTMLButtonElement>('[data-use]')) b.onclick = () => void use(b.dataset.use!);
  for (const b of body.querySelectorAll<HTMLButtonElement>('[data-buy]')) b.onclick = () => void buy(b.dataset.buy!);
}

async function use(id: string) {
  trySkin = null;
  if (!account.me) {
    toast(`${skinById(id).name} is ready for the test drive. Sign in to race with it live.`);
    return renderGarage();
  }
  try {
    const r = await account.api<{ skin: string; skins: string[] }>('/api/skin/select', { skin: id });
    account.setMe({ ...account.me, skin: r.skin, skins: r.skins });
    toast(`You race as ${skinById(id).name} now.`);
  } catch (e) {
    toast((e as Error).message);
  }
}

async function buy(id: string) {
  if (!account.me) return showAuthModal();
  if (busy) return;
  busy = id;
  const say = (t: string) => {
    steps.set(id, t);
    renderGarage();
  };
  try {
    const { buySkin } = await import('./tickets');
    await buySkin(id, say);
    trySkin = null;
    steps.set(id, '');
    toast(`${skinById(id).name} is yours! You race with it from now on.`);
  } catch (e) {
    steps.set(id, (e as Error).message);
  } finally {
    busy = null;
    renderGarage();
  }
}
