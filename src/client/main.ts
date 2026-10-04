import './style.css';
import { RaceRenderer } from './renderer';
import { Broadcast, fmtTime } from './broadcast';
import { CodeViewer, escapeHtml } from './codeViewer';
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

if (isLocalMode) $('mode-pill').hidden = false;

// ---------------------------------------------------------------- routing
let session = 0;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, Math.max(0, ms)));

function show(view: 'stage' | 'leaderboard' | 'history') {
  for (const v of ['stage', 'leaderboard', 'history']) $(`view-${v}`).hidden = v !== view;
  for (const a of document.querySelectorAll<HTMLAnchorElement>('nav a')) {
    a.classList.toggle('active', location.hash.startsWith(a.getAttribute('href')!) || (a.getAttribute('href') === '#/live' && location.hash === ''));
  }
}

async function route() {
  const my = ++session;
  viewer.close();
  const parts = location.hash.replace(/^#\/?/, '').split('/');
  const page = parts[0] || 'live';
  document.body.dataset.page = page;
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
    broadcast.center(`<div class="results"><div class="res-head">Race not found</div><p>It may not have finished yet, or Supabase isn't configured.</p><a class="btn" href="#/live">Back to live</a></div>`);
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
  $<HTMLInputElement>('lab-input').value = seed;
  $('lab-stats').innerHTML = `
    <div><b>${(t.length / 1000).toFixed(2)}</b> km</div>
    <div><b>${t.corners.length}</b> corners</div>
    <div><b>${lapsFor(t)}</b> laps</div>
    <div><b>${Math.min(...t.widths).toFixed(0)}–${Math.max(...t.widths).toFixed(0)}</b> m wide</div>`;
  $('lab-corners').innerHTML = t.corners
    .map((c) => `<li><b>T${c.id}</b> ${c.direction} · ${c.angle}° · r ${c.radius} m <span>${c.distance} m</span></li>`)
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
  $('lab-copy').textContent = 'Link copied ✓';
  setTimeout(() => ($('lab-copy').textContent = 'Copy link'), 1500);
};

// ---------------------------------------------------------------- leaderboard / history
async function renderLeaderboard() {
  const el = $('leaderboard-body');
  if (isLocalMode) {
    el.innerHTML = `<p class="empty">The model leaderboard needs Supabase. Add <code>VITE_SUPABASE_URL</code> and <code>VITE_SUPABASE_ANON_KEY</code> to <code>.env</code> (see README).</p>`;
    return;
  }
  el.innerHTML = '<p class="empty">Loading…</p>';
  try {
    const rows = await fetchLeaderboard();
    if (!rows.length) {
      el.innerHTML = '<p class="empty">No finished races yet.</p>';
      return;
    }
    el.innerHTML = `<table class="table"><thead><tr><th>#</th><th>Model</th><th>Races</th><th>Wins</th><th>Podiums</th><th>Avg pos</th><th>Crashes</th><th>Best lap</th></tr></thead><tbody>
      ${rows
        .map(
          (r, i) => `<tr><td>${i + 1}</td><td class="model">${escapeHtml(r.model)}</td><td>${r.races}</td><td><b>${r.wins}</b></td><td>${r.podiums}</td>
            <td>${Number(r.avg_position).toFixed(2)}</td><td>${r.crashes}</td><td>${r.best_lap ? Number(r.best_lap).toFixed(2) + 's' : '–'}</td></tr>`,
        )
        .join('')}</tbody></table>`;
  } catch (e) {
    el.innerHTML = `<p class="empty">Couldn't load leaderboard: ${escapeHtml(String(e))}</p>`;
  }
}

async function renderHistory() {
  const el = $('history-body');
  if (isLocalMode) {
    const now = slotAt(Date.now());
    const rows = [];
    for (let s = now - 1; s > now - 13; s--) {
      rows.push(`<tr><td>${new Date(raceStartAt(s)).toLocaleTimeString()}</td><td>local-${s}</td><td>House bots</td><td><a class="btn small" href="#/replay/local/${s}">Replay</a></td></tr>`);
    }
    el.innerHTML = `<p class="empty">Local mode: these are house races, re-computed in your browser from the slot number.</p>
      <table class="table"><thead><tr><th>Started</th><th>Seed</th><th>Field</th><th></th></tr></thead><tbody>${rows.join('')}</tbody></table>`;
    return;
  }
  el.innerHTML = '<p class="empty">Loading…</p>';
  try {
    const rows = await fetchHistory();
    el.innerHTML = rows.length
      ? `<table class="table"><thead><tr><th>Race</th><th>Started</th><th>Seed</th><th>Winner</th><th></th></tr></thead><tbody>
        ${rows
          .map(
            (r) => `<tr><td>#${r.id}</td><td>${new Date(r.start_at).toLocaleString()}</td><td>${escapeHtml(r.seed)}</td>
              <td>${escapeHtml(r.winner ?? '–')}</td><td><a class="btn small" href="#/replay/${r.id}">Replay</a></td></tr>`,
          )
          .join('')}</tbody></table>`
      : '<p class="empty">No finished races yet.</p>';
  } catch (e) {
    el.innerHTML = `<p class="empty">Couldn't load history: ${escapeHtml(String(e))}</p>`;
  }
}

route();
