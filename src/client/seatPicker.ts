// Fan view controls (shared by the live game and the AI League): where you're standing/sitting,
// follow-the-car toggle, and a map to pick any grandstand, terrace or viewing platform.
import { get3d } from './view3d';
import { escapeHtml } from './codeViewer';
import type { SeatArea } from './chase3d';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
type Pt = [number, number];

const KIND_COLOR: Record<SeatArea['kind'], string> = { stand: '#22d3ee', terrace: '#a463ff', platform: '#ffd60a' };
const KIND_LABEL: Record<SeatArea['kind'], string> = { stand: 'Seated · covered grandstand', terrace: 'Standing · right at the fence', platform: 'Standing · raised, over the crowd' };

export function initFanUi() {
  $('fan-pick').onclick = () => openPicker();
  $('fan-follow').onclick = () => {
    const c = get3d();
    if (!c) return;
    c.setFollow(!c.fanStatus().follow);
    refresh();
  };
  $('sp-close').onclick = closePicker;
  $('seat-picker').addEventListener('click', (e) => {
    if (e.target === $('seat-picker')) closePicker();
  });
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('seat-picker').hidden) closePicker();
  });
  $('sp-map').addEventListener('click', (e) => {
    const hit = hitArea(e);
    if (hit !== null) choose(hit);
  });
  setInterval(refresh, 250);
}

function refresh() {
  if (!document.body.classList.contains('view-fan')) return;
  const st = get3d()?.fanStatus();
  if (!st) return;
  $('fan-area').textContent = st.auto ? `${st.area} (auto)` : st.area;
  $('fan-detail').textContent = st.detail;
  const f = $('fan-follow');
  f.setAttribute('aria-pressed', String(st.follow));
  f.querySelector('span')!.textContent = st.follow ? 'Following car' : 'Free look';
}

// ------------------------------------------------------------------ picker
let view: { s: number; ox: number; oy: number } = { s: 1, ox: 0, oy: 0 };

function openPicker() {
  const c = get3d();
  if (!c) return;
  const areas = c.seatAreas();
  const cur = c.fanStatus();
  $('sp-list').innerHTML =
    `<button class="sp-item ${cur.auto ? 'on' : ''}" data-a="-1"><span class="sw" style="background:#fff"></span><span><b>Automatic</b><small>Walk to the stand nearest the action</small></span></button>` +
    areas
      .map(
        (a, i) =>
          `<button class="sp-item ${!cur.auto && cur.area === a.name ? 'on' : ''}" data-a="${i}"><span class="sw" style="background:${KIND_COLOR[a.kind]}"></span><span><b>${escapeHtml(a.name)}</b><small>${KIND_LABEL[a.kind]}</small></span></button>`,
      )
      .join('');
  for (const b of $('sp-list').querySelectorAll<HTMLButtonElement>('[data-a]')) b.onclick = () => choose(Number(b.dataset.a));
  $('seat-picker').hidden = false;
  drawMap();
  $('sp-list').querySelector<HTMLButtonElement>('.on')?.focus();
}

function closePicker() {
  $('seat-picker').hidden = true;
}

function choose(a: number) {
  get3d()?.chooseSeat(a);
  closePicker();
  refresh();
}

function drawMap() {
  const c = get3d();
  const cv = $<HTMLCanvasElement>('sp-map');
  const ctx = cv.getContext('2d');
  if (!c || !ctx) return;
  const track = c.trackOutline();
  const areas = c.seatAreas();
  const all: Pt[] = [...track, ...areas.flatMap((a) => a.outline)];
  if (!all.length) return;
  const xs = all.map((p) => p[0]),
    ys = all.map((p) => p[1]);
  const minX = Math.min(...xs),
    maxX = Math.max(...xs),
    minY = Math.min(...ys),
    maxY = Math.max(...ys);
  const W = cv.width,
    H = cv.height,
    pad = 36;
  const s = Math.min((W - pad * 2) / (maxX - minX), (H - pad * 2) / (maxY - minY));
  view = { s, ox: (W - (maxX - minX) * s) / 2 - minX * s, oy: (H - (maxY - minY) * s) / 2 - minY * s };
  const X = (p: Pt) => p[0] * s + view.ox,
    Y = (p: Pt) => p[1] * s + view.oy;
  ctx.clearRect(0, 0, W, H);
  ctx.lineJoin = 'round';
  ctx.beginPath();
  track.forEach((p, i) => (i ? ctx.lineTo(X(p), Y(p)) : ctx.moveTo(X(p), Y(p))));
  ctx.closePath();
  ctx.strokeStyle = '#3a4350';
  ctx.lineWidth = 12;
  ctx.stroke();
  ctx.strokeStyle = '#c9d1dc';
  ctx.lineWidth = 2;
  ctx.stroke();
  const cur = c.fanStatus();
  areas.forEach((a) => {
    ctx.beginPath();
    a.outline.forEach((p, i) => (i ? ctx.lineTo(X(p), Y(p)) : ctx.moveTo(X(p), Y(p))));
    ctx.closePath();
    const on = !cur.auto && cur.area === a.name;
    ctx.fillStyle = KIND_COLOR[a.kind] + (on ? 'ff' : '99');
    ctx.fill();
    if (on) {
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 3;
      ctx.stroke();
    }
  });
  // Labels last so shapes never cover them: platforms get a numbered dot, stands/terraces their name.
  areas.forEach((a) => {
    const [cx, cy] = centroid(a.outline);
    const x = cx * s + view.ox,
      y = cy * s + view.oy;
    if (a.kind === 'platform') {
      ctx.beginPath();
      ctx.arc(x, y, 9, 0, Math.PI * 2);
      ctx.fillStyle = '#ffd60a';
      ctx.fill();
      ctx.fillStyle = '#111';
      ctx.font = '700 10px Barlow, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(a.name.replace(/\D+/g, ''), x, y + 0.5);
    } else {
      ctx.font = '700 12px Barlow, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'alphabetic';
      ctx.lineWidth = 3;
      ctx.strokeStyle = 'rgba(0,0,0,0.75)';
      const label = a.name.replace('Grandstand', 'Stand').replace('Fence terrace', 'Terrace');
      const ly = a.kind === 'stand' ? y - 12 : y + 20;
      ctx.strokeText(label, x, ly);
      ctx.fillStyle = '#ffffff';
      ctx.fillText(label, x, ly);
    }
  });
}

function centroid(pts: Pt[]): Pt {
  let x = 0,
    y = 0;
  for (const p of pts) {
    x += p[0];
    y += p[1];
  }
  return [x / pts.length, y / pts.length];
}

function hitArea(e: MouseEvent): number | null {
  const c = get3d();
  const cv = $<HTMLCanvasElement>('sp-map');
  if (!c) return null;
  const r = cv.getBoundingClientRect();
  const mx = ((e.clientX - r.left) / r.width) * cv.width,
    my = ((e.clientY - r.top) / r.height) * cv.height;
  let best: number | null = null,
    bd = 40;
  c.seatAreas().forEach((a, i) => {
    const [cx, cy] = centroid(a.outline);
    const d = Math.hypot(cx * view.s + view.ox - mx, cy * view.s + view.oy - my);
    if (d < bd) {
      bd = d;
      best = i;
    }
  });
  return best;
}
