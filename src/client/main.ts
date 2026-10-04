import './style.css';
import { RaceRenderer } from './renderer';
import { Broadcast, fmtTime } from './broadcast';
import { CodeViewer, escapeHtml } from './codeViewer';
import { hydrateIcons, icon } from './icons';
import {
  db,
  fetchHistory,
  fetchLeaderboard,
  fetchRaceById,
  fetchRaceBySlot,
  fetchResults,
  houseEntries,
  isLocalMode,
  localRace,
  type RaceInfo,
} from './data';
import { generateTrack, lapsFor } from '../sim/track';
import { raceStartAt, slotAt, slotStart } from '../sim/schedule';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

hydrateIcons();
await document.fonts.ready; // badges on the map measure their text, so the real font must be loaded first
const renderer = await RaceRenderer.create($('stage-canvas'));
const broadcast = new Broadcast(renderer);
const viewer = new CodeViewer();

broadcast.onSelectCar = (car) => {
  const race = broadcast.race;
  if (!race) return;
  renderer.selected = car;
  broadcast.setCamera('car', car);
  const result = broadcast.record?.results?.find((r) => r.car === car) ?? null;
  viewer.open(race.entries[car], result, () => {
    renderer.selected = -1;
    broadcast.setCamera('overview');
  });
};
$('tower').addEventListener('click', (e) => {
  const li = (e.target as HTMLElement).closest<HTMLElement>('li[data-car]');
  if (li) broadcast.onSelectCar(Number(li.dataset.car));
});
$('tower').addEventListener('keydown', (e) => {
  const li = (e.target as HTMLElement).closest<HTMLElement>('li[data-car]');
  if (li && (e.key === 'Enter' || e.key === ' ')) {
    e.preventDefault();
    broadcast.onSelectCar(Number(li.dataset.car));
  }
});
// Mobile: the standings panel starts collapsed (it would cover the track) and expands on tap.
if (matchMedia('(max-width: 760px)').matches) {
  $('tower-toggle').parentElement!.classList.add('collapsed');
  $('tower-toggle').setAttribute('aria-expanded', 'false');
}
$('tower-toggle').addEventListener('click', () => {
  if (!matchMedia('(max-width: 760px)').matches) return;
  const wrap = $('tower-toggle').parentElement!;
  const collapsed = wrap.classList.toggle('collapsed');
  $('tower-toggle').setAttribute('aria-expanded', String(!collapsed));
});

// Header: always show when the next race starts (or that one is live now).
function updateNextRace() {
  const now = Date.now();
  const slot = slotAt(now);
  const start = raceStartAt(slot);
  const el = $('next-race');
  const live = now >= start && now < start + 150_000;
  el.classList.toggle('is-live', live);
  if (live) el.innerHTML = `<span class="dot" aria-hidden="true"></span><span>Race live now</span>`;
  else {
    const target = now < start ? start : raceStartAt(slot + 1);
    el.innerHTML = `${icon('clock', 14)}<span class="lbl">Next race</span><b>${fmtTime((target - now) / 1000).slice(0, -2)}</b>`;
  }
}
updateNextRace();
setInterval(updateNextRace, 1000);

export function toast(text: string) {
  document.querySelector('.toast')?.remove();
  const t = document.createElement('div');
  t.className = 'toast';
  t.setAttribute('role', 'status');
  t.innerHTML = `${icon('check', 16)}${escapeHtml(text)}`;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 2500);
}

if (isLocalMode) $('mode-pill').hidden = false;

// ---------------------------------------------------------------- routing
let session = 0;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, Math.max(0, ms)));

function show(view: 'stage' | 'leaderboard' | 'history') {
  for (const v of ['stage', 'leaderboard', 'history']) $(`view-${v}`).hidden = v !== view;
  for (const a of document.querySelectorAll<HTMLAnchorElement>('nav a')) {
    const href = a.getAttribute('href')!;
    const on = location.hash.startsWith(href) || (href === '#/live' && (location.hash === '' || location.hash.startsWith('#/replay')));
    a.classList.toggle('active', on);
    if (on) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  }
}

async function route() {
  const my = ++session;
  viewer.close();
  const parts = location.hash.replace(/^#\/?/, '').split('/');
  const page = parts[0] || 'live';
  document.body.dataset.page = page;
  document.body.classList.remove('is-replay');
  if (my > 1) $('main').focus({ preventScroll: true }); // screen readers: announce the new view
  switch (page) {
    case 'leaderboard':
      show('leaderboard');
      return renderLeaderboard();
    case 'history':
      show('history');
      return renderHistory();
    case 'lab':
      show('stage');
      return openLab(parts[1] ? decodeURIComponent(parts[1]) : randomSeed());
    case 'replay':
      show('stage');
      return openReplay(parts.slice(1));
    default:
      show('stage');
      return runLive(my);
  }
}
window.addEventListener('hashchange', route);
window.addEventListener('resize', () => renderer.resetCamera());

// ---------------------------------------------------------------- live
async function runLive(my: number) {
  while (my === session) {
    const slot = slotAt(Date.now());
    let race: RaceInfo | null = null;
    let note: string | undefined;
    try {
      race = await fetchRaceBySlot(slot);
    } catch {
      /* fall through to local */
    }
    if (!race) {
      race = localRace(slot);
      if (db) note = 'No scheduled race for this slot. Showing a house race.';
    }
    if (my !== session) return;
    await broadcast.load(race, 'live', note);
    // Live races: fetch the stored result once the race is over and verify our replay against it.
    if (race.id !== null) {
      const id = race.id;
      const endIn = race.startAt + (broadcast.record?.duration ?? 0) * 1000 - Date.now() + 3000;
      setTimeout(async () => {
        if (my !== session || broadcast.race?.id !== id) return;
        const stored = await fetchResults(id);
        if (stored) broadcast.verify(stored);
      }, endIn);
    }
    while (my === session && Date.now() < slotStart(slot + 1)) {
      const next = document.getElementById('next-in');
      if (next) next.textContent = fmtTime(Math.max(0, (raceStartAt(slot + 1) - Date.now()) / 1000)).slice(0, -2);
      await sleep(250);
    }
  }
}

// ---------------------------------------------------------------- replay
async function openReplay(args: string[]) {
  let race: RaceInfo | null = null;
  if (args[0] === 'local' && args[1]) race = localRace(Number(args[1]));
  else if (args[0]) race = await fetchRaceById(Number(args[0]));
  if (!race) {
    broadcast.center(`<div class="card results"><div class="res-head">${icon('alert', 24)}Race not found</div>
      <p class="muted">It may not have finished yet, or the database isn't configured.</p>
      <a class="btn btn-primary" href="#/live">${icon('live')}Watch live</a></div>`);
    return;
  }
  await broadcast.load(race, 'replay');
}

// ---------------------------------------------------------------- track lab
function randomSeed(): string {
  const words = ['apex', 'drift', 'nitro', 'slick', 'pole', 'chicane', 'turbo', 'kerb', 'pit', 'grid', 'vortex', 'delta'];
  return `${words[Math.floor(Math.random() * words.length)]}-${Math.floor(Math.random() * 100000)}`;
}

function openLab(seed: string) {
  broadcast.showTrack(seed);
  const t = generateTrack(seed);
  $('lab-seed').textContent = seed;
  const clockwise = t.curvature.reduce((s, k) => s + k, 0) > 0;
  $('lab-sub').textContent = `${t.corners.length} TURNS · ${clockwise ? 'CLOCKWISE' : 'ANTI-CLOCKWISE'}`;
  $<HTMLInputElement>('lab-input').value = seed;
  const stat = (v: string, label: string) => `<div class="stat"><b>${v}</b><span>${label}</span></div>`;
  $('lab-stats').innerHTML =
    stat((t.length / 1000).toFixed(2), 'km length') +
    stat(String(t.corners.length), 'corners') +
    stat(String(lapsFor(t)), lapsFor(t) === 1 ? 'lap per race' : 'laps per race') +
    stat(`${Math.min(...t.widths).toFixed(0)}–${Math.max(...t.widths).toFixed(0)}`, 'm wide');
  $('lab-corners').innerHTML = t.corners
    .map((c) => `<li><b>T${c.id}</b>${c.direction === 'left' ? 'Left' : 'Right'} · ${c.angle}° · r ${c.radius} m<span>${c.distance} m</span></li>`)
    .join('');
}

$('lab-new').onclick = () => (location.hash = `#/lab/${encodeURIComponent(randomSeed())}`);
$('lab-form').onsubmit = (e) => {
  e.preventDefault();
  const v = $<HTMLInputElement>('lab-input').value.trim();
  if (v) location.hash = `#/lab/${encodeURIComponent(v)}`;
};
$('lab-race').onclick = () => {
  const seed = $('lab-seed').textContent!;
  broadcast.load(
    { id: null, slot: null, seed, laps: null, startAt: 0, simVersion: null, entries: houseEntries(), results: null, local: true },
    'replay',
  );
};
$('lab-copy').onclick = async () => {
  await navigator.clipboard.writeText(location.href);
  toast('Track link copied');
};

// ---------------------------------------------------------------- leaderboard / history
const skeleton = (rows: number) => `<div class="table-wrap" style="border:0;background:none">${'<div class="skeleton"></div>'.repeat(rows)}</div>`;
const empty = (ic: Parameters<typeof icon>[0], text: string, action = `<a class="btn btn-primary" href="#/live">${icon('live')}Watch the live race</a>`) =>
  `<div class="empty">${icon(ic, 32)}<p>${text}</p>${action}</div>`;

async function renderLeaderboard() {
  const el = $('leaderboard-body');
  if (isLocalMode) {
    el.innerHTML = empty('chart', 'The model leaderboard needs the database. Add <code>VITE_SUPABASE_URL</code> and <code>VITE_SUPABASE_ANON_KEY</code> to <code>.env</code> (see README).');
    return;
  }
  el.innerHTML = skeleton(6);
  try {
    const rows = await fetchLeaderboard();
    if (!rows.length) {
      el.innerHTML = empty('trophy', 'No finished races yet. The first results land here a few minutes after the first race.');
      return;
    }
    el.innerHTML = `<div class="table-wrap"><table class="table"><thead><tr>
        <th>#</th><th>Model</th><th class="num hide-sm">Races</th><th class="num">Wins</th><th class="num">Win rate</th><th class="num hide-sm">Podiums</th>
        <th class="num">Avg pos</th><th class="num hide-sm">Crashes</th><th class="num hide-sm">Best lap</th></tr></thead><tbody>
      ${rows
        .map((r, i) => {
          const rate = r.races ? r.wins / r.races : 0;
          const house = r.model.startsWith('House Bot');
          const [vendor, id] = r.model.includes('/') ? r.model.split('/') : ['', r.model];
          return `<tr><td><span class="rank ${i < 3 ? 'r' + (i + 1) : ''}">${i + 1}</span></td>
            <td class="model">${escapeHtml(id.replace(/:free$/, ''))}${house ? '<span class="tag">BASELINE</span>' : ''}<small>${escapeHtml(vendor)}</small></td>
            <td class="num hide-sm">${r.races}</td><td class="num"><b>${r.wins}</b></td>
            <td class="num"><div class="winbar">${Math.round(rate * 100)}%<span><i style="width:${rate * 100}%"></i></span></div></td>
            <td class="num hide-sm">${r.podiums}</td><td class="num">${Number(r.avg_position).toFixed(2)}</td>
            <td class="num hide-sm">${r.crashes}</td><td class="num hide-sm">${r.best_lap ? Number(r.best_lap).toFixed(2) + 's' : '–'}</td></tr>`;
        })
        .join('')}</tbody></table></div>`;
  } catch (e) {
    el.innerHTML = empty('alert', `Couldn't load the leaderboard: ${escapeHtml(String(e))}`, `<button class="btn" onclick="location.reload()">${icon('replay')}Try again</button>`);
  }
}

async function renderHistory() {
  const el = $('history-body');
  const replayBtn = (href: string) => `<a class="btn small" href="${href}">${icon('play', 14)}Replay</a>`;
  if (isLocalMode) {
    const now = slotAt(Date.now());
    const rows = [];
    for (let s = now - 1; s > now - 13; s--) {
      rows.push(`<tr><td class="mono">${new Date(raceStartAt(s)).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</td>
        <td class="mono hide-sm">local-${s}</td><td>House bots</td><td class="num">${replayBtn(`#/replay/local/${s}`)}</td></tr>`);
    }
    el.innerHTML = `<p class="muted" style="margin-top:16px">Local mode: house races, re-computed in your browser from the time slot.</p>
      <div class="table-wrap"><table class="table"><thead><tr><th>Started</th><th class="hide-sm">Seed</th><th>Field</th><th></th></tr></thead><tbody>${rows.join('')}</tbody></table></div>`;
    return;
  }
  el.innerHTML = skeleton(8);
  try {
    const rows = await fetchHistory();
    el.innerHTML = rows.length
      ? `<div class="table-wrap"><table class="table"><thead><tr><th>Race</th><th>Started</th><th class="hide-sm">Seed</th><th>Winner</th><th></th></tr></thead><tbody>
        ${rows
          .map(
            (r) => `<tr><td class="mono">#${r.id}</td><td>${new Date(r.start_at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</td>
              <td class="mono hide-sm">${escapeHtml(r.seed)}</td>
              <td>${r.winner ? `${icon('trophy', 14)} ${escapeHtml(r.winner)}` : '–'}</td><td class="num">${replayBtn(`#/replay/${r.id}`)}</td></tr>`,
          )
          .join('')}</tbody></table></div>`
      : empty('history', 'No finished races yet. Races run every 5 minutes.');
  } catch (e) {
    el.innerHTML = empty('alert', `Couldn't load history: ${escapeHtml(String(e))}`, `<button class="btn" onclick="location.reload()">${icon('replay')}Try again</button>`);
  }
}

route();
