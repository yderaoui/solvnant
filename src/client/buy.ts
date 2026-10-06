// "Buy the coin" page: a DEMO of how buying the game's token will look (for showing the concept).
// Nothing here touches a blockchain or a real wallet: the price is simulated, the wallet is a demo
// wallet and a "purchase" only updates a demo balance stored in this browser.
import { escapeHtml } from './codeViewer';
import { icon } from './icons';
import { toast } from './toast';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

/** Shown everywhere on the page; change when the real token has a name. */
export const TOKEN = { symbol: '$TRACK', name: 'TrackLab Token' };
const SOL_USD = 182.4; // demo SOL price
const HOLD_USD = 20; // race requirement shown on the page

const store = {
  get<T>(k: string, d: T): T {
    try {
      const v = localStorage.getItem(k);
      return v === null ? d : (JSON.parse(v) as T);
    } catch {
      return d;
    }
  },
  set(k: string, v: unknown) {
    try {
      localStorage.setItem(k, JSON.stringify(v));
    } catch {
      /* private mode */
    }
  },
};

// Simulated price history: a seeded random walk over 7 days, drifting up.
function history(): number[] {
  let x = 1234567;
  const rnd = () => ((x = (x * 1103515245 + 12345) % 2147483648) / 2147483648);
  const pts: number[] = [];
  let p = 0.0031;
  for (let i = 0; i < 168; i++) {
    p *= 1 + (rnd() - 0.46) * 0.045;
    pts.push(p);
  }
  return pts;
}

let prices = history();
let live: ReturnType<typeof setInterval> | null = null;
const price = () => prices[prices.length - 1];
const fmtUsd = (n: number, dp = 2) => `$${n.toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp })}`;
const fmtTok = (n: number) => Math.round(n).toLocaleString('en-US');

interface Wallet {
  address: string;
  sol: number;
}

export function renderBuyPage() {
  const el = $('buy-body');
  const change = (price() / prices[prices.length - 25] - 1) * 100;
  el.innerHTML = `
    <div class="demo-banner" role="note">${icon('alert', 16)}<span><b>Demo mode.</b> This page shows how buying ${TOKEN.symbol} will work. No real transaction is made, no wallet is charged and no money moves.</span></div>
    <div class="buy-grid">
      <section class="lcard buy-token">
        <div class="tok-head">
          <span class="tok-logo" aria-hidden="true"><i></i><i></i></span>
          <div><h2>${TOKEN.symbol}</h2><small>${TOKEN.name} · Solana</small></div>
          <div class="tok-price"><b id="tok-price">${fmtUsd(price(), 6)}</b><span id="tok-change" class="${change >= 0 ? 'up' : 'down'}">${change >= 0 ? '+' : ''}${change.toFixed(1)}% 24h</span></div>
        </div>
        <canvas id="tok-chart" width="760" height="260" aria-label="${TOKEN.symbol} price, last 7 days (simulated)"></canvas>
        <div class="tok-range"><span>7 days ago</span><span>now</span></div>
        <dl class="tok-stats">
          <div><dt>Market cap</dt><dd id="tok-mcap">${fmtUsd(price() * 1_000_000_000, 0)}</dd></div>
          <div><dt>Liquidity</dt><dd>$412,800</dd></div>
          <div><dt>24h volume</dt><dd>$96,350</dd></div>
          <div><dt>Holders</dt><dd>3,184</dd></div>
        </dl>
        <h3>WHAT ${TOKEN.symbol} UNLOCKS</h3>
        <ul class="tok-perks">
          <li>${icon('flag', 16)}<span><b>Race without an X account</b>: hold ${fmtUsd(HOLD_USD, 0)} of ${TOKEN.symbol} in a linked wallet.</span></li>
          <li>${icon('trophy', 16)}<span><b>Token prize pots</b>: entry fees and prizes in ${TOKEN.symbol} (coming soon).</span></li>
          <li>${icon('zap', 16)}<span><b>Priority entry</b>: skip the queue in busy races.</span></li>
        </ul>
      </section>

      <section class="lcard buy-swap" aria-label="Buy ${TOKEN.symbol}">
        <h3>BUY ${TOKEN.symbol}</h3>
        <div class="wallet-row" id="wallet-row"></div>
        <label class="swap-box"><span class="lbl">You pay</span>
          <span class="swap-in"><input id="pay" type="number" inputmode="decimal" min="0" step="0.01" value="0.25" aria-label="SOL to pay" /><b>SOL</b></span>
          <small id="pay-usd"></small>
        </label>
        <div class="swap-arrow" aria-hidden="true">${icon('down', 18)}</div>
        <div class="swap-box"><span class="lbl">You receive</span>
          <span class="swap-in"><output id="get">0</output><b>${TOKEN.symbol}</b></span>
          <small id="rate"></small>
        </div>
        <div class="quick" role="group" aria-label="Quick amounts">${[0.1, 0.25, 0.5, 1].map((v) => `<button class="chip" data-sol="${v}">${v} SOL</button>`).join('')}</div>
        <dl class="swap-meta">
          <div><dt>Slippage</dt><dd>0.5%</dd></div>
          <div><dt>Network fee</dt><dd>~0.000005 SOL</dd></div>
          <div><dt>Route</dt><dd>SOL → ${TOKEN.symbol}</dd></div>
        </dl>
        <button class="btn btn-lime btn-big" id="buy-go"></button>
        <div class="holding" id="holding"></div>
      </section>
    </div>
    <div id="buy-modal" class="modal" hidden role="dialog" aria-modal="true" aria-labelledby="bm-title"></div>`;

  const pay = $<HTMLInputElement>('pay');
  const update = () => {
    const sol = Math.max(0, Number(pay.value) || 0);
    const usd = sol * SOL_USD;
    $('pay-usd').textContent = `≈ ${fmtUsd(usd)}`;
    $('get').textContent = fmtTok((usd / price()) * 0.995);
    $('rate').textContent = `1 SOL ≈ ${fmtTok(SOL_USD / price())} ${TOKEN.symbol}`;
    paintWallet();
  };
  pay.oninput = update;
  for (const b of el.querySelectorAll<HTMLButtonElement>('[data-sol]'))
    b.onclick = () => {
      pay.value = b.dataset.sol!;
      update();
    };
  $('buy-go').onclick = () => {
    const w = store.get<Wallet | null>('tl-demo-wallet', null);
    if (!w) return connect();
    void buy(Math.max(0, Number(pay.value) || 0));
  };
  update();
  drawChart();
  if (live) clearInterval(live);
  live = setInterval(() => {
    if (document.body.dataset.page !== 'buy') {
      clearInterval(live!);
      live = null;
      return;
    }
    // simulated live ticks
    prices = [...prices.slice(1), price() * (1 + (Math.random() - 0.48) * 0.012)];
    const p = document.getElementById('tok-price');
    if (!p) return;
    p.textContent = fmtUsd(price(), 6);
    $('tok-mcap').textContent = fmtUsd(price() * 1_000_000_000, 0);
    drawChart();
    update();
  }, 3000);
}

function paintWallet() {
  const w = store.get<Wallet | null>('tl-demo-wallet', null);
  const held = store.get<number>('tl-demo-track', 0);
  const row = document.getElementById('wallet-row');
  if (!row) return;
  row.innerHTML = w
    ? `<span class="wdot"></span><span><b>Demo wallet</b> <code>${escapeHtml(w.address.slice(0, 4))}…${escapeHtml(w.address.slice(-4))}</code></span><span class="wbal">${w.sol.toFixed(3)} SOL</span><button class="btn small btn-ghost" id="w-off">Disconnect</button>`
    : `<span class="wdot off"></span><span>No wallet connected</span>`;
  document.getElementById('w-off')?.addEventListener('click', () => {
    store.set('tl-demo-wallet', null);
    paintWallet();
  });
  $('buy-go').innerHTML = w ? `BUY ${TOKEN.symbol} ${icon('zap', 16)}` : `CONNECT WALLET ${icon('link', 16)}`;
  const usd = held * price();
  $('holding').innerHTML = held
    ? `<div><span>Your ${TOKEN.symbol}</span><b>${fmtTok(held)}</b><small>≈ ${fmtUsd(usd)}</small></div>
       <p class="${usd >= HOLD_USD ? 'ok' : 'warn'}">${icon(usd >= HOLD_USD ? 'check' : 'alert', 14)}${usd >= HOLD_USD ? `Meets the ${fmtUsd(HOLD_USD, 0)} race requirement` : `Hold ${fmtUsd(HOLD_USD - usd)} more to race without X`}</p>`
    : `<p class="muted">Hold ${fmtUsd(HOLD_USD, 0)} of ${TOKEN.symbol} to race without an X account.</p>`;
}

function connect() {
  const m = $('buy-modal');
  m.innerHTML = `<div class="auth-card">
      <div class="sp-head"><div><h2 id="bm-title">Connect a wallet</h2><p class="muted">Demo: picks a pretend wallet with some SOL in it.</p></div>
        <button class="icon-btn" id="bm-x" aria-label="Close">${icon('x', 18)}</button></div>
      ${['Phantom', 'Solflare', 'Backpack'].map((n) => `<button class="btn wallet-pick" data-w="${n}">${icon('link', 16)}${n}<small>demo</small></button>`).join('')}
    </div>`;
  m.hidden = false;
  $('bm-x').onclick = () => (m.hidden = true);
  for (const b of m.querySelectorAll<HTMLButtonElement>('[data-w]'))
    b.onclick = () => {
      const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
      const address = Array.from({ length: 44 }, () => B58[Math.floor(Math.random() * B58.length)]).join('');
      store.set('tl-demo-wallet', { address, sol: 2.5 });
      m.hidden = true;
      toast(`${b.dataset.w} demo wallet connected`);
      paintWallet();
    };
}

async function buy(sol: number) {
  const w = store.get<Wallet | null>('tl-demo-wallet', null)!;
  if (sol <= 0) return toast('Enter how much SOL to pay');
  if (sol > w.sol) return toast('Not enough SOL in the demo wallet');
  const tokens = ((sol * SOL_USD) / price()) * 0.995;
  const m = $('buy-modal');
  const step = (n: number, text: string) =>
    (m.innerHTML = `<div class="auth-card buy-steps">
        <h2 id="bm-title">Buying ${fmtTok(tokens)} ${TOKEN.symbol}</h2>
        <ol>${['Approve in your wallet', 'Sending transaction', 'Confirmed'].map((t, i) => `<li class="${i < n ? 'done' : i === n ? 'now' : ''}">${i < n ? icon('check', 14) : i === n ? '<span class="spinner"></span>' : '<span class="dotx"></span>'}${t}</li>`).join('')}</ol>
        <p class="muted">${text}</p></div>`);
  m.hidden = false;
  step(0, 'Demo: no wallet pop-up, nothing is signed.');
  await new Promise((r) => setTimeout(r, 1200));
  step(1, 'Demo: nothing is sent to the blockchain.');
  await new Promise((r) => setTimeout(r, 1500));
  store.set('tl-demo-wallet', { ...w, sol: w.sol - sol });
  store.set('tl-demo-track', store.get<number>('tl-demo-track', 0) + tokens);
  const tx = `demo-${Math.random().toString(36).slice(2, 10)}`;
  m.innerHTML = `<div class="auth-card buy-steps">
      <h2 id="bm-title">${icon('check', 22)} Purchase complete</h2>
      <p>You received <b>${fmtTok(tokens)} ${TOKEN.symbol}</b> for ${sol} SOL.</p>
      <p class="muted">Transaction <code>${tx}</code> (demo, not on-chain)</p>
      <div class="acct-row"><a class="btn btn-lime" href="#/live">${icon('flag', 16)}Go race</a><button class="btn btn-ghost" id="bm-done">Close</button></div>
    </div>`;
  $('bm-done').onclick = () => (m.hidden = true);
  paintWallet();
}

function drawChart() {
  const cv = document.getElementById('tok-chart') as HTMLCanvasElement | null;
  const ctx = cv?.getContext('2d');
  if (!cv || !ctx) return;
  const W = cv.width,
    H = cv.height,
    pad = 10;
  const lo = Math.min(...prices),
    hi = Math.max(...prices);
  const X = (i: number) => pad + (i / (prices.length - 1)) * (W - pad * 2);
  const Y = (p: number) => H - pad - ((p - lo) / (hi - lo || 1)) * (H - pad * 2);
  ctx.clearRect(0, 0, W, H);
  ctx.strokeStyle = 'rgba(255,255,255,0.06)';
  ctx.lineWidth = 1;
  for (let k = 1; k < 4; k++) {
    ctx.beginPath();
    ctx.moveTo(0, (H * k) / 4);
    ctx.lineTo(W, (H * k) / 4);
    ctx.stroke();
  }
  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, 'rgba(140,255,46,0.35)');
  g.addColorStop(1, 'rgba(140,255,46,0)');
  ctx.beginPath();
  prices.forEach((p, i) => (i ? ctx.lineTo(X(i), Y(p)) : ctx.moveTo(X(i), Y(p))));
  ctx.lineTo(X(prices.length - 1), H);
  ctx.lineTo(X(0), H);
  ctx.closePath();
  ctx.fillStyle = g;
  ctx.fill();
  ctx.beginPath();
  prices.forEach((p, i) => (i ? ctx.lineTo(X(i), Y(p)) : ctx.moveTo(X(i), Y(p))));
  ctx.strokeStyle = '#8cff2e';
  ctx.lineWidth = 2.5;
  ctx.lineJoin = 'round';
  ctx.stroke();
  const lx = X(prices.length - 1),
    ly = Y(price());
  ctx.fillStyle = '#8cff2e';
  ctx.beginPath();
  ctx.arc(lx, ly, 5, 0, Math.PI * 2);
  ctx.fill();
}
