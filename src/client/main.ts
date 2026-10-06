import './style.css';
import { RaceRenderer } from './renderer';
import { Broadcast, fmtTime } from './broadcast';
import { LiveGame } from './livegame';
import { audio, get3d } from './view3d';
import { initFanUi } from './seatPicker';
import { CodeViewer, escapeHtml } from './codeViewer';
import { hydrateIcons, icon } from './icons';
import { toast } from './toast';
import { account, fmtPts, handleAuthHash, initAccountUi } from './account';
import { BetWidget } from './bets';
import { loadDraft, practiceEntries, renderAgentPage } from './agent';
import { LeagueLobby } from './leagueLobby';
import { renderBuyPage } from './buy';
import {
  db,
  fetchHistory,
  fetchLeaderboard,
  fetchLiveHistory,
  fetchLiveRace,
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
const live = new LiveGame(renderer);
initFanUi();
const viewer = new CodeViewer();
initAccountUi(toast);
const leagueLobby = new LeagueLobby((html) => broadcast.center(html));
void account.load();

broadcast.onSelectCar = (car) => {
  const race = broadcast.race;
  if (!race) return;
  renderer.selected = car;
  broadcast.setCamera('car', car);
  const result = broadcast.record?.results?.find((r) => r.car === car) ?? null;
  viewer.open(race.entries[car], result, () => {
    renderer.selected = -1;
    if (!broadcast.in3d) broadcast.setCamera('overview'); // in 3D: keep watching, back to the leader
  });
};
// Standings rows: in the AI league they open the driver's code; in the live game they spectate that car.
const pickCar = (car: number) => (live.active ? live.spectateCar(car) : broadcast.onSelectCar(car));
$('tower').addEventListener('click', (e) => {
  const li = (e.target as HTMLElement).closest<HTMLElement>('li[data-car]');
  if (li) pickCar(Number(li.dataset.car));
});
$('tower').addEventListener('keydown', (e) => {
  const li = (e.target as HTMLElement).closest<HTMLElement>('li[data-car]');
  if (li && (e.key === 'Enter' || e.key === ' ')) {
    e.preventDefault();
    pickCar(Number(li.dataset.car));
  }
});
// AI League keys: C cycles cameras, V = next stand in the fan view, M = mute. (The live game has its own.)
window.addEventListener('keydown', (e) => {
  if (live.active || !['league', 'replay'].includes(document.body.dataset.page ?? '')) return;
  const tag = (e.target as HTMLElement)?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA') return;
  if (e.code === 'KeyC') {
    const cams = ['cam-overview', 'cam-leader', 'cam-chase', 'cam-fan'];
    const at = cams.findIndex((id) => $(id).classList.contains('active'));
    $(cams[(at + 1) % cams.length]).click();
  } else if (e.code === 'KeyV') get3d()?.nextFanSpot();
  else if (e.code === 'KeyM') toggleMute();
});
function paintMute() {
  const b = $('mute-btn');
  b.innerHTML = icon(audio.muted ? 'mute' : 'sound');
  b.setAttribute('aria-pressed', String(audio.muted));
}
function toggleMute() {
  audio.start();
  audio.setMuted(!audio.muted);
  paintMute();
}
$('mute-btn').addEventListener('click', () => {
  if (!live.active) toggleMute();
});
paintMute();

// Graphics quality (shared 3D view): Auto -> High -> Low
const gfxLabel = (m: string) => `GFX ${m.toUpperCase()}`;
const gfxSaved = (() => {
  try {
    return localStorage.getItem('tl-gfx') || 'auto';
  } catch {
    return 'auto';
  }
})();
$('gfx-btn').textContent = gfxLabel(gfxSaved);
$('gfx-btn').addEventListener('click', () => {
  const order = ['auto', 'high', 'low'] as const;
  const cur = (get3d()?.graphics ?? gfxSaved) as (typeof order)[number];
  const next = order[(order.indexOf(cur) + 1) % order.length];
  get3d()?.setGraphics(next);
  try {
    localStorage.setItem('tl-gfx', next);
  } catch {
    /* ignore */
  }
  $('gfx-btn').textContent = gfxLabel(next);
  toast(next === 'auto' ? 'Graphics: automatic' : next === 'high' ? 'Graphics: high quality' : 'Graphics: low (smoothest)');
});

// Performance help: shown once when 3D runs on the CPU (no hardware acceleration), or when the
// game is still slow on the lightest graphics setting.
window.addEventListener('tl-slow', (e) => {
  const { gpu, software } = (e as CustomEvent<{ gpu: string; software: boolean }>).detail;
  const key = software ? 'tl-tip-sw' : 'tl-tip-slow';
  try {
    if (localStorage.getItem(key)) return;
  } catch {
    /* show it */
  }
  document.querySelector('.perf-tip')?.remove();
  const el = document.createElement('div');
  el.className = 'perf-tip';
  el.setAttribute('role', 'status');
  el.innerHTML = software
    ? `<b>${icon('alert', 16)}3D is running on your CPU</b>
       <p>Your browser has graphics acceleration turned off, so the race is drawn without the graphics chip and will be slow.</p>
       <ol><li><b>Chrome / Edge:</b> Settings → System → turn on <i>Use graphics acceleration when available</i>, then restart the browser.</li>
       <li>Still slow? Update your graphics driver.</li></ol>`
    : `<b>${icon('zap', 16)}Running slowly on this computer</b>
       <p>Graphics are already on the lightest setting${gpu ? ` (your browser is using <i>${escapeHtml(gpu)}</i>)` : ''}. These help most:</p>
       <ol><li><b>Plug in the charger</b>: on battery, Windows slows the graphics chip down.</li>
       <li>Close other tabs and apps (video calls, games, editors).</li>
       <li>Use Chrome or Edge and keep the browser up to date.</li>
       <li>Laptop with two graphics chips? Windows Settings → System → Display → Graphics → your browser → <i>High performance</i>.</li>
       <li>Or watch on the <b>Map</b> view (2D), which is very light.</li></ol>`;
  const close = document.createElement('button');
  close.className = 'icon-btn';
  close.setAttribute('aria-label', 'Close');
  close.innerHTML = icon('x', 16);
  close.onclick = () => {
    el.remove();
    try {
      localStorage.setItem(key, '1');
    } catch {
      /* ignore */
    }
  };
  el.prepend(close);
  document.body.appendChild(el);
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
  const isLive = now >= start && now < start + 150_000;
  el.classList.toggle('is-live', isLive);
  if (isLive) el.innerHTML = `<span class="dot" aria-hidden="true"></span><span>Race live now</span>`;
  else {
    const target = now < start ? start : raceStartAt(slot + 1);
    el.innerHTML = `${icon('clock', 14)}<span class="lbl">Next race</span><b>${fmtTime((target - now) / 1000).slice(0, -2)}</b>`;
  }
}
updateNextRace();
setInterval(updateNextRace, 1000);

if (isLocalMode) $('mode-pill').hidden = false;

// ---------------------------------------------------------------- routing
let session = 0;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, Math.max(0, ms)));

function show(view: 'stage' | 'leaderboard' | 'history' | 'agent' | 'buy') {
  for (const v of ['stage', 'leaderboard', 'history', 'agent', 'buy']) $(`view-${v}`).hidden = v !== view;
  for (const a of document.querySelectorAll<HTMLAnchorElement>('nav a')) {
    const href = a.getAttribute('href')!;
    const on = location.hash.startsWith(href) || (href === '#/live' && location.hash === '') || (href === '#/league' && location.hash.startsWith('#/replay'));
    a.classList.toggle('active', on);
    if (on) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  }
}

async function route() {
  if (handleAuthHash(toast)) return; // X login callback: rewrites the hash and routes again
  const my = ++session;
  leagueLobby.hide();
  viewer.close();
  const parts = location.hash.replace(/^#\/?/, '').split('/');
  const page = parts[0] || 'live';
  // Switching between pages that share the 3D stage: cover it so the new track builds out of sight.
  const stagePages = ['live', 'league', 'lab', 'replay', ''];
  const prevPage = document.body.dataset.page ?? '';
  if (prevPage !== page && stagePages.includes(prevPage) && stagePages.includes(page))
    get3d()?.cover(page === 'live' ? 'LIVE RACE' : page === 'lab' ? 'TRACK LAB' : page === 'replay' ? 'REPLAY' : 'AI LEAGUE');
  document.body.dataset.page = page;
  document.body.classList.remove('is-replay');
  if (my > 1) $('main').focus({ preventScroll: true }); // screen readers: announce the new view
  // The live multiplayer game and the AI-league broadcast share one stage; only one drives it.
  if (page === 'live') {
    broadcast.deactivate();
    show('stage');
    live.start();
    return;
  }
  if (live.active) live.stop();
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
    case 'buy':
      show('buy');
      return renderBuyPage();
    case 'agent':
      show('agent');
      return renderAgentPage();
    default:
      show('stage');
      return runLeague(my);
  }
}
window.addEventListener('hashchange', route);
window.addEventListener('resize', () => renderer.resetCamera());

// ---------------------------------------------------------------- live
async function runLeague(my: number) {
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
    leagueLobby.hide();
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
    const replay = race.id !== null ? `#/replay/${race.id}` : `#/replay/local/${slot}`;
    while (my === session && Date.now() < slotStart(slot + 1)) {
      // Once the results have had their moment, the lobby for the next race takes over.
      const rec = broadcast.record;
      if (rec?.complete && Date.now() > race.startAt + rec.duration * 1000 + 12_000) leagueLobby.show(slot + 1, replay);
      const next = document.getElementById('next-in');
      if (next) next.textContent = fmtTime(Math.max(0, (raceStartAt(slot + 1) - Date.now()) / 1000)).slice(0, -2);
      await sleep(250);
    }
  }
}

// ---------------------------------------------------------------- replay
async function openReplay(args: string[]) {
  let race: RaceInfo | null = null;
  if (args[0] === 'practice') return openPractice();
  if (args[0] === 'local' && args[1]) race = localRace(Number(args[1]));
  else if (args[0] === 'live' && args[1]) race = await fetchLiveRace(Number(args[1]));
  else if (args[0]) race = await fetchRaceById(Number(args[0]));
  if (!race) {
    broadcast.center(`<div class="card results"><div class="res-head">${icon('alert', 24)}Race not found</div>
      <p class="muted">It may not have finished yet, or the database isn't configured.</p>
      <a class="btn btn-primary" href="#/league">${icon('live')}Watch the AI league</a></div>`);
    return;
  }
  await broadcast.load(race, 'replay');
}

async function openPractice() {
  const d = loadDraft();
  const seed = randomSeed();
  await broadcast.load(
    { id: null, slot: null, seed, laps: null, startAt: 0, simVersion: null, entries: practiceEntries(d), results: null, local: true },
    'replay',
    'Practice race: your agent against the house bots. Nothing is saved.',
  );
  // Watch your own car (car 0), in whichever camera is on.
  renderer.selected = 0;
  broadcast.setCamera('car', 0);
}

// ---------------------------------------------------------------- AI League betting
// Bets on a league race close when its slot opens (the seed is revealed then), so the panel always
// offers the NEXT race while the current one plays.
const leagueBets = new BetWidget($('league-bet'), 'BET ON THE NEXT RACE', toast);
async function pollLeagueMarket() {
  if (document.body.dataset.page !== 'league' || !account.cfg?.leagueBets) {
    leagueBets.setMarket(null);
    document.body.classList.remove('has-league-bet');
    return;
  }
  try {
    const rows = await account.api<{ id: string; status: string; closes_at: number | null }[]>('/api/markets?kind=league');
    const next = rows.filter((r) => r.status === 'open' && (r.closes_at ?? 0) > Date.now()).sort((a, b) => (a.closes_at ?? 0) - (b.closes_at ?? 0))[0];
    leagueBets.setMarket(next?.id ?? null);
    document.body.classList.toggle('has-league-bet', !!next);
  } catch {
    /* game server offline */
  }
}
setInterval(pollLeagueMarket, 10_000);
account.onChange(() => void pollLeagueMarket());
window.addEventListener('hashchange', () => void pollLeagueMarket());

// ---------------------------------------------------------------- track lab
function randomSeed(): string {
  const words = ['apex', 'drift', 'nitro', 'slick', 'pole', 'chicane', 'turbo', 'kerb', 'pit', 'grid', 'vortex', 'delta'];
  return `${words[Math.floor(Math.random() * words.length)]}-${Math.floor(Math.random() * 100000)}`;
}

function openLab(seed: string) {
  broadcast.showTrack(seed);
  $('lab-3d').setAttribute('aria-pressed', 'false');
  document.body.classList.remove('lab-3d');
  $('lab-3d').querySelector('span')!.textContent = '3D flyover';
  const t = generateTrack(seed);
  $('lab-seed').textContent = seed;
  const clockwise = t.curvature.reduce((s, k) => s + k, 0) > 0;
  $('lab-sub').textContent = `${t.corners.length} TURNS · ${clockwise ? 'CLOCKWISE' : 'ANTI-CLOCKWISE'}`;
  $('lab-info').innerHTML = `<span>${t.corners.length} TURNS</span><span>${(t.length / 1000).toFixed(1)} KM</span><b>WOODLAND CIRCUIT</b>`;
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

$('lab-3d').onclick = () => {
  const on = !broadcast.in3d;
  if (on) broadcast.setCamera3d('3d');
  else broadcast.setCamera('overview');
  $('lab-3d').setAttribute('aria-pressed', String(on));
  document.body.classList.toggle('lab-3d', on);
  $('lab-3d').querySelector('span')!.textContent = on ? '2D map' : '3D flyover';
};
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
const empty = (ic: Parameters<typeof icon>[0], text: string, action = `<a class="btn btn-primary" href="#/league">${icon('live')}Watch the AI league</a>`) =>
  `<div class="empty">${icon(ic, 32)}<p>${text}</p>${action}</div>`;

let lbTab: 'models' | 'players' = 'models';
let lbToken = 0; // a slow response for the other tab must not overwrite this one
for (const b of document.querySelectorAll<HTMLButtonElement>('[data-lb-tab]'))
  b.onclick = () => {
    lbTab = b.dataset.lbTab as typeof lbTab;
    void renderLeaderboard();
  };

async function renderLeaderboard() {
  for (const b of document.querySelectorAll<HTMLButtonElement>('[data-lb-tab]')) {
    const on = b.dataset.lbTab === lbTab;
    b.classList.toggle('active', on);
    b.setAttribute('aria-selected', String(on));
  }
  $('lb-title').textContent = lbTab === 'models' ? 'Model leaderboard' : 'Player leaderboard';
  $('lb-desc').textContent =
    lbTab === 'models'
      ? 'Every finished AI League race, by model and player agent. Only races a model drove with its own code count. House bots are a hand-written baseline.'
      : 'Points from live races (prize pots), bets and daily bonuses. Points are play money.';
  const token = ++lbToken;
  if (lbTab === 'players') return renderPlayers(token);
  const el = $('leaderboard-body');
  if (isLocalMode) {
    el.innerHTML = empty('chart', 'The model leaderboard needs the database. Add <code>VITE_SUPABASE_URL</code> and <code>VITE_SUPABASE_ANON_KEY</code> to <code>.env</code> (see README).');
    return;
  }
  el.innerHTML = skeleton(6);
  try {
    const rows = await fetchLeaderboard();
    if (token !== lbToken) return;
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
          const agent = r.model.startsWith('agent:');
          const [vendor, id] = agent ? [r.model.slice(6).split('/')[0], r.model.split('/').slice(1).join('/')] : r.model.includes('/') ? r.model.split('/') : ['', r.model];
          return `<tr><td><span class="rank ${i < 3 ? 'r' + (i + 1) : ''}">${i + 1}</span></td>
            <td class="model">${escapeHtml(id.replace(/:free$/, ''))}${house ? '<span class="tag">BASELINE</span>' : agent ? '<span class="tag tag-agent">PLAYER AGENT</span>' : ''}<small>${escapeHtml(vendor)}</small></td>
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

async function renderPlayers(token: number) {
  const el = $('leaderboard-body');
  el.innerHTML = skeleton(6);
  try {
    const rows = await account.api<{ name: string; handle: string | null; avatar: string | null; kind: string; points: number }[]>('/api/leaderboard');
    if (token !== lbToken) return;
    el.innerHTML = rows.length
      ? `<div class="table-wrap"><table class="table"><thead><tr><th>#</th><th>Player</th><th class="num">Points</th></tr></thead><tbody>
        ${rows
          .map(
            (r, i) => `<tr class="${account.me && (r.handle ? r.handle === account.me.handle : r.name === account.me.name) ? 'me' : ''}"><td><span class="rank ${i < 3 ? 'r' + (i + 1) : ''}">${i + 1}</span></td>
              <td class="model">${escapeHtml(r.handle ? '@' + r.handle : r.name)}${r.kind === 'guest' ? '<span class="tag">GUEST</span>' : ''}</td>
              <td class="num"><b>${fmtPts(r.points)}</b></td></tr>`,
          )
          .join('')}</tbody></table></div>`
      : empty('trophy', 'No players yet. Sign in and race to get on the board.', `<a class="btn btn-primary" href="#/live">${icon('flag')}Race now</a>`);
  } catch (e) {
    el.innerHTML = empty('alert', `Couldn't load players: ${escapeHtml((e as Error).message)}`, `<button class="btn" onclick="location.reload()">${icon('replay')}Try again</button>`);
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
    const [rows, live] = await Promise.all([fetchHistory(), fetchLiveHistory().catch(() => [])]);
    const liveHtml = live.length
      ? `<h2 class="hist-h">Live races</h2><div class="table-wrap"><table class="table"><thead><tr><th>Race</th><th>Started</th><th>Winner</th><th class="num hide-sm">Players</th><th></th></tr></thead><tbody>
        ${live
          .map((r) => {
            const win = r.entries.find((e) => e.car === r.results.find((x) => x.position === 1)?.car);
            return `<tr><td class="mono">#${r.id}</td><td>${new Date(r.started_at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</td>
              <td>${win ? `${icon('trophy', 14)} ${escapeHtml(win.name)}` : '–'}</td><td class="num hide-sm">${r.entries.filter((e) => e.kind === 'human').length}</td>
              <td class="num">${replayBtn(`#/replay/live/${r.id}`)}</td></tr>`;
          })
          .join('')}</tbody></table></div><h2 class="hist-h">AI League</h2>`
      : '';
    el.innerHTML = liveHtml + (rows.length
      ? `<div class="table-wrap"><table class="table"><thead><tr><th>Race</th><th>Started</th><th class="hide-sm">Seed</th><th>Winner</th><th></th></tr></thead><tbody>
        ${rows
          .map(
            (r) => `<tr><td class="mono">#${r.id}</td><td>${new Date(r.start_at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</td>
              <td class="mono hide-sm">${escapeHtml(r.seed)}</td>
              <td>${r.winner ? `${icon('trophy', 14)} ${escapeHtml(r.winner)}` : '–'}</td><td class="num">${replayBtn(`#/replay/${r.id}`)}</td></tr>`,
          )
          .join('')}</tbody></table></div>`
      : empty('history', 'No finished races yet. Races run every 5 minutes.'));
  } catch (e) {
    el.innerHTML = empty('alert', `Couldn't load history: ${escapeHtml(String(e))}`, `<button class="btn" onclick="location.reload()">${icon('replay')}Try again</button>`);
  }
}

route();
