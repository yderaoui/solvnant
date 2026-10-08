// Accounts: sign in (X, or a guest nickname while X isn't set up), the session token, the PLAY-MONEY
// points balance, the daily bonus, linking a Solana wallet (token gate) and the points history.
// Everything goes through the game server's /api/* routes (src/game/hub.ts).
import { GAME_URL } from './net';
import { escapeHtml } from './codeViewer';
import { icon } from './icons';
import type { PublicConfig } from '../game/config';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

/** http(s) base of the game server: VITE_API_URL, or the WebSocket URL without /ws. */
export const API_URL = ((import.meta.env.VITE_API_URL as string | undefined) || GAME_URL.replace(/^ws/, 'http').replace(/\/ws$/, '')).replace(/\/+$/, '');

export interface Me {
  id: string;
  kind: 'x' | 'guest' | 'privy';
  handle: string | null;
  name: string;
  avatar: string | null;
  points: number;
  wallet: string | null;
  holdUsd: number | null;
  canRace: boolean;
  raceBlock: string | null;
  dailyAt: number;
  tickets?: number; // race tickets bought with the game coin, not used yet
  skins?: string[]; // racer skins this player owns (free ones included)
  skin?: string; // the one they race with
}

const store = {
  get(k: string): string | null {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set(k: string, v: string | null) {
    try {
      if (v === null) localStorage.removeItem(k);
      else localStorage.setItem(k, v);
    } catch {
      /* private mode: the session lasts until the tab closes */
    }
  },
};

class Account {
  token: string | null = store.get('tl-token');
  me: Me | null = null;
  cfg: PublicConfig | null = null;
  /** True once we've asked the server who we are (or failed to). */
  ready = false;
  private listeners = new Set<() => void>();

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit() {
    for (const fn of this.listeners) fn();
  }

  async api<T>(path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = {};
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    if (body !== undefined) headers['content-type'] = 'application/json';
    let r: Response;
    try {
      r = await fetch(`${API_URL}${path}`, { method: body !== undefined ? 'POST' : 'GET', headers, body: body !== undefined ? JSON.stringify(body) : undefined });
    } catch {
      throw new Error('The game server is not reachable.');
    }
    const j = (await r.json().catch(() => ({}))) as T & { error?: string };
    if (!r.ok) {
      if (r.status === 401 && this.token) this.signOut(); // expired session
      throw new Error(j.error ?? `Server error ${r.status}`);
    }
    return j;
  }

  async load() {
    try {
      this.cfg = await this.api<PublicConfig>('/api/config');
    } catch {
      this.cfg = null;
    }
    if (this.token) {
      try {
        this.me = await this.api<Me>('/api/me');
      } catch {
        this.me = null;
      }
    }
    this.ready = true;
    this.emit();
  }

  async setToken(token: string) {
    this.token = token;
    store.set('tl-token', token);
    await this.load();
  }

  signOut() {
    this.token = null;
    this.me = null;
    store.set('tl-token', null);
    this.emit();
  }

  /** The live room tells us when the balance changes (entry fee, refund, prize). */
  setPoints(points: number) {
    if (!this.me || this.me.points === points) return;
    this.me = { ...this.me, points };
    this.emit();
  }

  async refresh() {
    if (!this.token) return;
    try {
      this.me = await this.api<Me>('/api/me');
      this.emit();
    } catch {
      /* keep what we have */
    }
  }

  setMe(me: Me) {
    this.me = me;
    this.emit();
  }
}

export const account = new Account();

/** A price in tickets, as players see it: dollars when tickets are priced in USD, else coins. */
export function priceLabel(t: { price: number; priceUsd?: number; symbol: string }, tickets = 1): string {
  return t.priceUsd ? `$${(t.priceUsd * tickets).toLocaleString('en-US')}` : `${(t.price * tickets).toLocaleString('en-US')} ${t.symbol}`;
}

export const fmtPts = (n: number) => `${Math.round(n).toLocaleString('en-US')}`;

/** X sends people back to #/auth?token=… (or ?error=…). Returns true if this was that callback. */
export function handleAuthHash(toast: (t: string) => void): boolean {
  const m = /^#\/auth\??(.*)$/.exec(location.hash);
  if (!m) return false;
  const q = new URLSearchParams(m[1]);
  const back = store.get('tl-after-login') || '#/race';
  store.set('tl-after-login', null);
  const token = q.get('token');
  if (token)
    void account.setToken(token).then(() => {
      if (account.me) toast(`Signed in as @${account.me.handle ?? account.me.name}`);
    });
  else if (q.get('error')) showAuthModal(q.get('error')!);
  history.replaceState(null, '', back);
  window.dispatchEvent(new HashChangeEvent('hashchange'));
  return true;
}

// ====================================================================== UI: header chip + menu
let toastFn: ((t: string) => void) | null = null;
let preloaded = false;

export function initAccountUi(toast: (t: string) => void) {
  toastFn = toast;
  const host = $('account');
  const paint = () => {
    const me = account.me;
    if (account.ready && !me && account.cfg?.privy && !preloaded) {
      preloaded = true;
      void import('./privy/client').then((p) => p.preloadPrivy());
    }
    if (!account.ready) {
      host.innerHTML = '';
      return;
    }
    if (!account.cfg) {
      host.innerHTML = `<span class="pill pill-warn" title="Start it with: npm run game">Game server offline</span>`;
      return;
    }
    if (!me) {
      host.innerHTML = `<button class="x-btn" id="acct-signin">${xLogo()}<span><b>Sign in</b><small>${account.cfg.privy || account.cfg.x ? 'with X' : 'guest'}</small></span></button>`;
      $('acct-signin').onclick = () => showAuthModal();
      return;
    }
    host.innerHTML = `<button class="acct-chip" id="acct-chip" aria-haspopup="dialog" aria-expanded="false">
        ${avatarHtml(me)}<span class="acct-who"><b>${escapeHtml(me.handle ? '@' + me.handle : me.name)}</b><small>${me.kind === 'guest' ? 'guest' : me.kind === 'privy' ? 'signed in' : 'X account'}</small></span>
        <span class="acct-pts"><b id="acct-points">${fmtPts(me.points)}</b><small>PTS</small></span></button>`;
    $('acct-chip').onclick = () => toggleMenu(toast);
  };
  account.onChange(() => {
    paint();
    if (!$('acct-menu').hidden) renderMenu(toast);
  });
  paint();
  document.addEventListener('click', (e) => {
    const menu = $('acct-menu');
    if (!menu.hidden && !menu.contains(e.target as Node) && !(e.target as HTMLElement).closest('#acct-chip')) closeMenu();
  });
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!$('acct-menu').hidden) closeMenu();
    if (!$('auth-modal').hidden) closeAuthModal();
  });
  $('auth-modal').addEventListener('click', (e) => {
    if (e.target === $('auth-modal')) closeAuthModal();
  });
}

const xLogo = () =>
  `<svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M18.9 2H22l-6.8 7.8L23 22h-6.2l-4.9-6.4L6.3 22H3.2l7.3-8.3L1 2h6.3l4.4 5.9zm-1.1 18h1.7L6.3 3.9H4.5z"/></svg>`;

function avatarHtml(me: Me) {
  return me.avatar
    ? `<img class="acct-av" src="${escapeHtml(me.avatar)}" alt="" width="28" height="28" referrerpolicy="no-referrer" />`
    : `<span class="acct-av">${escapeHtml(me.name.slice(0, 1).toUpperCase())}</span>`;
}

function toggleMenu(toast: (t: string) => void) {
  if ($('acct-menu').hidden) {
    renderMenu(toast);
    $('acct-menu').hidden = false;
    $('acct-chip')?.setAttribute('aria-expanded', 'true');
    void account.refresh();
  } else closeMenu();
}

function closeMenu() {
  $('acct-menu').hidden = true;
  document.getElementById('acct-chip')?.setAttribute('aria-expanded', 'false');
}

function renderMenu(toast: (t: string) => void) {
  const me = account.me;
  const cfg = account.cfg;
  const el = $('acct-menu');
  if (!me || !cfg) {
    closeMenu();
    return;
  }
  const dailyIn = me.dailyAt - Date.now();
  const gate = cfg.gate;
  const race = me.canRace
    ? `<p class="acct-ok">${icon('check', 14)}You can race in live rounds.</p>`
    : `<p class="acct-warn">${icon('alert', 14)}${escapeHtml(me.raceBlock ?? 'You can’t race yet.')}</p>`;
  const wallet = gate
    ? `<section><h4>Token gate</h4>
        <p class="muted small">Hold at least <b>$${gate.minUsd}</b> of the token to race without X.</p>
        ${
          me.wallet
            ? `<div class="acct-wallet"><code>${escapeHtml(me.wallet.slice(0, 4))}…${escapeHtml(me.wallet.slice(-4))}</code><span>${me.holdUsd === null ? 'checking…' : `$${me.holdUsd.toFixed(2)} held`}</span></div>
               <div class="acct-row"><button class="btn small" id="am-wrefresh">${icon('replay', 14)}Re-check</button><button class="btn small btn-ghost" id="am-wunlink">Unlink</button></div>`
            : `<button class="btn small" id="am-wlink">${icon('link', 14)}Link Phantom wallet</button>`
        }</section>`
    : '';
  el.innerHTML = `
    <div class="acct-head">${avatarHtml(me)}<div><b>${escapeHtml(me.name)}</b><small>${me.handle ? '@' + escapeHtml(me.handle) : me.kind === 'privy' ? 'Signed in with Privy' : 'Guest account'}</small></div></div>
    <div class="acct-balance"><span>Balance</span><b>${fmtPts(me.points)} <small>PTS</small></b></div>
    <p class="muted small">Points are play money: no cash value, nothing to withdraw.</p>
    <button class="btn btn-lime small" id="am-daily" ${dailyIn > 0 ? 'disabled' : ''}>${icon('zap', 14)}${dailyIn > 0 ? `Daily bonus in ${Math.ceil(dailyIn / 3600_000)} h` : `Claim daily +${cfg.points.daily}`}</button>
    ${race}
    ${
      cfg.tickets
        ? `<section><h4>Race tickets</h4>
            <div class="acct-wallet"><span>You have <b>${me.tickets ?? 0}</b> ticket${me.tickets === 1 ? '' : 's'}</span><span>${escapeHtml(priceLabel(cfg.tickets))} each</span></div>
            <div class="acct-row"><button class="btn small btn-lime" id="am-buyticket">${icon('zap', 14)}Buy a ticket</button>
            ${cfg.tickets.cluster === 'devnet' ? `<button class="btn small btn-ghost" id="am-faucet">Get free test ${escapeHtml(cfg.tickets.symbol)}</button>` : ''}</div>
            <p class="muted small" id="am-buystep">${cfg.tickets.cluster === 'devnet' ? 'Test network (devnet): uses test coins with no real value.' : ''}</p></section>
          ${cfg.privy ? `<section><h4>Your wallet</h4><div class="acct-wallet" id="am-mywallet"><span class="muted small">Loading…</span></div><p class="muted small">Payments come from this wallet, and prizes arrive here.</p>
            <details class="am-withdraw"><summary>Withdraw ${escapeHtml(cfg.tickets?.symbol ?? '')}</summary>
              <input id="am-wd-to" placeholder="Send to (Solana address)" autocomplete="off" spellcheck="false" />
              <div class="acct-row"><input id="am-wd-amt" type="number" min="0" step="any" placeholder="Amount" /><button class="btn small btn-ghost" id="am-wd-max">Max</button></div>
              <button class="btn small btn-lime" id="am-wd-go">Withdraw</button>
              <p class="muted small" id="am-wd-step"></p>
            </details></section>` : ''}`
        : ''
    }
    ${wallet}
    <section><h4>Recent activity</h4><ol class="acct-ledger" id="am-ledger"><li class="muted">Loading…</li></ol></section>
    <div class="acct-row"><a class="btn small btn-ghost" href="#/agent">${icon('code', 14)}My agent</a><button class="btn small btn-ghost" id="am-out">Sign out</button></div>`;
  $('am-out').onclick = () => {
    closeMenu();
    account.signOut();
    void import('./privy/client').then((p) => p.privyLogout());
    toast('Signed out');
  };
  $('am-daily').onclick = async () => {
    try {
      const r = await account.api<{ ok: boolean; points: number }>('/api/daily', {});
      if (r.ok) toast(`+${cfg.points.daily} points`);
      await account.refresh();
    } catch (e) {
      toast((e as Error).message);
    }
  };
  document.getElementById('am-wlink')?.addEventListener('click', () => void linkWallet(toast));
  if (cfg.privy && document.getElementById('am-mywallet')) void paintMyWallet(cfg.tickets?.rpcUrl);
  document.getElementById('am-wd-max')?.addEventListener('click', async () => {
    const { coinBalance } = await import('./tickets');
    const b = await coinBalance().catch(() => null);
    if (b !== null) (document.getElementById('am-wd-amt') as HTMLInputElement).value = String(b);
  });
  document.getElementById('am-wd-go')?.addEventListener('click', async () => {
    const step = document.getElementById('am-wd-step')!;
    const btn = document.getElementById('am-wd-go') as HTMLButtonElement;
    btn.disabled = true;
    try {
      const { withdrawCoins } = await import('./tickets');
      const to = (document.getElementById('am-wd-to') as HTMLInputElement).value;
      const amt = Number((document.getElementById('am-wd-amt') as HTMLInputElement).value);
      const sig = await withdrawCoins(to, amt, (t) => (step.textContent = t));
      const dev = cfg.tickets?.cluster === 'devnet' ? '?cluster=devnet' : '';
      step.innerHTML = `Sent ✓ <a href="https://solscan.io/tx/${sig}${dev}" target="_blank" rel="noopener">view</a>`;
      void paintMyWallet(cfg.tickets?.rpcUrl);
    } catch (e) {
      step.textContent = (e as Error).message;
    } finally {
      btn.disabled = false;
    }
  });
  document.getElementById('am-faucet')?.addEventListener('click', async () => {
    const step = document.getElementById('am-buystep')!;
    try {
      const { getTestCoins } = await import('./tickets');
      step.textContent = await getTestCoins((t) => (step.textContent = t));
    } catch (e) {
      step.textContent = (e as Error).message;
    }
  });
  document.getElementById('am-buyticket')?.addEventListener('click', async () => {
    const step = document.getElementById('am-buystep')!;
    try {
      const { buyTicket } = await import('./tickets');
      const n = await buyTicket((t) => (step.textContent = t));
      toast(`Ticket bought: you have ${n}`);
    } catch (e) {
      step.textContent = (e as Error).message;
    }
  });
  document.getElementById('am-wrefresh')?.addEventListener('click', async () => {
    try {
      account.setMe(await account.api<Me>('/api/wallet/refresh', {}));
    } catch (e) {
      toast((e as Error).message);
    }
  });
  document.getElementById('am-wunlink')?.addEventListener('click', async () => {
    try {
      account.setMe(await account.api<Me>('/api/wallet/unlink', {}));
    } catch (e) {
      toast((e as Error).message);
    }
  });
  void account
    .api<{ delta: number; reason: string; ts: number }[]>('/api/ledger')
    .then((rows) => {
      const l = document.getElementById('am-ledger');
      if (!l) return;
      l.innerHTML = rows.length
        ? rows
            .slice(0, 8)
            .map((r) => `<li><span>${escapeHtml(r.reason)}</span><b class="${r.delta > 0 ? 'up' : 'down'}">${r.delta > 0 ? '+' : ''}${fmtPts(r.delta)}</b></li>`)
            .join('')
        : '<li class="muted">Nothing yet.</li>';
    })
    .catch(() => {});
}

/** Account menu: the Privy wallet's address (copy button) and SOL balance. */
async function paintMyWallet(rpcUrl: string | undefined) {
  const box = document.getElementById('am-mywallet');
  if (!box) return;
  try {
    const { privyWallet } = await import('./privy/client');
    const w = await privyWallet(15_000);
    let sol = '';
    if (rpcUrl) {
      const r = await fetch(rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getBalance', params: [w.address] }) });
      const j = (await r.json()) as { result?: { value: number } };
      if (j.result) sol = `${(j.result.value / 1e9).toFixed(4)} SOL`;
    }
    const coins = await import('./tickets').then((t) => t.coinBalance()).catch(() => null);
    if (coins !== null) sol = `${coins.toLocaleString('en-US', { maximumFractionDigits: 2 })} ${account.cfg?.tickets?.symbol ?? ''}${sol ? ' · ' + sol : ''}`;
    box.innerHTML = `<code title="${escapeHtml(w.address)}">${escapeHtml(w.address.slice(0, 6))}…${escapeHtml(w.address.slice(-6))}</code><span>${sol}</span><button class="btn small btn-ghost" id="am-copyw">${icon('copy', 14)}Copy</button>`;
    document.getElementById('am-copyw')!.onclick = () => void navigator.clipboard.writeText(w.address).then(() => toastFn?.('Wallet address copied'));
  } catch (e) {
    box.innerHTML = `<span class="muted small">${escapeHtml((e as Error).message)}</span>`;
  }
}

interface PhantomProvider {
  connect(): Promise<{ publicKey: { toString(): string } }>;
  signMessage(msg: Uint8Array, enc: 'utf8'): Promise<{ signature: Uint8Array }>;
}

async function linkWallet(toast: (t: string) => void) {
  const w = window as unknown as { phantom?: { solana?: PhantomProvider }; solana?: PhantomProvider };
  const provider = w.phantom?.solana ?? w.solana;
  if (!provider) {
    toast('No Solana wallet found. Install Phantom, then try again.');
    return;
  }
  try {
    const { publicKey } = await provider.connect();
    const { message } = await account.api<{ message: string }>('/api/wallet/nonce', {});
    const { signature } = await provider.signMessage(new TextEncoder().encode(message), 'utf8');
    const sig = btoa(String.fromCharCode(...signature));
    account.setMe(await account.api<Me>('/api/wallet/verify', { address: publicKey.toString(), signature: sig }));
    toast('Wallet linked');
  } catch (e) {
    toast((e as Error).message || 'Wallet linking was cancelled.');
  }
}

// ====================================================================== UI: sign-in dialog
let modalOpener: HTMLElement | null = null;

export function showAuthModal(error?: string) {
  const cfg = account.cfg;
  // Privy has its own sign-in window (X only).
  if (cfg?.privy && !error) {
    // If Privy is still downloading, say so (otherwise the click looks like it did nothing).
    const slow = setTimeout(() => toastFn?.('Opening X sign-in…'), 350);
    void import('./privy/client')
      .then((p) => p.privyLogin())
      .catch((e) => showAuthModal((e as Error).message || 'Sign-in failed.'))
      .finally(() => clearTimeout(slow));
    return;
  }
  const m = $('auth-modal');
  modalOpener = document.activeElement as HTMLElement | null;
  const x = cfg?.x
    ? `<a class="btn btn-big auth-x" id="auth-x" href="${API_URL}/auth/x/start">${xLogo()}Sign in with X</a>
       <p class="muted small">We only read your public profile. Accounts must be at least a few weeks old and have some followers, to keep bots out.</p>`
    : '';
  const guest = cfg?.guests
    ? `<form id="auth-guest" class="auth-guest">
        ${cfg.x ? '<div class="or"><span>or play as a guest</span></div>' : ''}
        <label for="auth-name">Nickname</label>
        <div class="input-row"><input id="auth-name" maxlength="16" autocomplete="nickname" spellcheck="false" placeholder="e.g. NovaRacer" /><button class="btn btn-lime">Play</button></div>
       </form>`
    : '';
  m.innerHTML = `<div class="auth-card" role="document">
      <div class="sp-head"><div><h2 id="auth-title">Sign in to race</h2><p class="muted">You get <b>${cfg ? fmtPts(cfg.points.signup) : '1,000'} points</b> to start. Points are play money.</p></div>
        <button class="icon-btn" id="auth-close" aria-label="Close">${icon('x', 18)}</button></div>
      ${error ? `<p class="err" role="alert">${escapeHtml(error)}</p>` : ''}
      ${cfg ? x + guest : '<p class="err">The game server is offline. Start it with <code>npm run game</code>.</p>'}
      ${cfg && !cfg.x && !cfg.guests ? '<p class="err">Sign-in is not set up on this server.</p>' : ''}
      <p class="muted small">By signing in you agree to the <a href="/terms.html" target="_blank" rel="noopener">Terms</a> and <a href="/privacy.html" target="_blank" rel="noopener">Privacy Policy</a>.</p>
    </div>`;
  m.hidden = false;
  $('auth-close').onclick = closeAuthModal;
  document.getElementById('auth-x')?.addEventListener('click', () => store.set('tl-after-login', location.hash || '#/race'));
  const form = document.getElementById('auth-guest') as HTMLFormElement | null;
  if (form) {
    form.onsubmit = async (e) => {
      e.preventDefault();
      const name = $<HTMLInputElement>('auth-name').value.trim();
      try {
        const { token } = await account.api<{ token: string }>('/api/guest', { name });
        await account.setToken(token);
        closeAuthModal();
      } catch (err) {
        form.querySelector('.err')?.remove();
        form.insertAdjacentHTML('beforeend', `<p class="err" role="alert">${escapeHtml((err as Error).message)}</p>`);
      }
    };
    $<HTMLInputElement>('auth-name').value = store.get('agp-name') ?? '';
  }
  (document.getElementById('auth-x') ?? document.getElementById('auth-name') ?? $('auth-close')).focus();
}

export function closeAuthModal() {
  $('auth-modal').hidden = true;
  modalOpener?.focus?.();
}
