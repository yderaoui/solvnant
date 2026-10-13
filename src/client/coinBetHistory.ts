import { account } from './account';
import type { MarketView } from './bets';
import { escapeHtml } from './codeViewer';
import { icon } from './icons';

let timer: ReturnType<typeof setInterval> | undefined;
let generation = 0;
export function mountCoinBetHistory(host: HTMLElement) {
  clearInterval(timer);
  const version = ++generation, uid = account.me?.id;
  if (!uid || !account.cfg?.leagueCoinBets) return;
  const panel = document.createElement('section'); panel.className = 'coin-bet-history';
  panel.innerHTML = '<h2 class="hist-h">Your AI League coin bets</h2><div class="coin-bet-history-body" role="status">Loading bet receipts…</div>';
  host.prepend(panel);
  const body = panel.querySelector<HTMLElement>('.coin-bet-history-body')!;
  let previous = '';
  const load = async () => {
    if (!panel.isConnected || version !== generation || account.me?.id !== uid) { clearInterval(timer); return; }
    try {
      const views = await account.api<MarketView[]>('/api/league/bets');
      if (!panel.isConnected || account.me?.id !== uid) return;
      const html = views.map(v => {
        const m = v.market;
        if (!m) return '';
        const sym = escapeHtml(v.symbol ?? 'coins'), fmt = (n:number)=>n.toLocaleString('en-US',{maximumFractionDigits:6});
        const dev = v.cluster === 'devnet' ? '?cluster=devnet' : '';
        const link = (sig:string|undefined|null,label:string)=>sig&&/^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(sig)?`<a class="hero-link" href="https://solscan.io/tx/${encodeURIComponent(sig)}${dev}" target="_blank" rel="noopener">${label}${icon('overtake',14)}</a>`:'';
        return `<article class="card coin-bet-record"><h3>${escapeHtml(m.title)}</h3>${v.mine.map(b=>{
          const name=m.picks.find(p=>p.id===b.pick)?.name??'Driver';
          const status=b.state==='lost'?'Lost':b.state==='refund'?b.paymentStatus==='paid'?'Refund paid':'Full refund pending':b.state==='won'?b.paymentStatus==='paid'?'Winnings paid':'Winnings pending':'Bet confirmed · waiting for the race';
          return `<div class="coin-bet-record-line"><p><b>${escapeHtml(name)}</b> · ${fmt(b.amount)} ${sym}</p><p class="${b.state==='lost'?'muted':'info'}">${status}${b.payout!==null&&b.payout>0?` · ${fmt(b.payout)} ${sym}`:''}</p>${b.reason?`<p class="muted small">${escapeHtml(b.reason)}</p>`:''}<div class="coin-links">${link(b.signature,'Bet transaction')}${link(b.payoutSignature,b.state==='refund'?'Refund transaction':'Payout transaction')}</div></div>`;
        }).join('')}</article>`;
      }).join('') || '<p class="muted">No coin bets yet. Choose an AI driver before its race starts.</p><a class="btn small" href="#/league">Watch AI League</a>';
      if (html !== previous) { body.innerHTML=html; previous=html; }
    }catch { if(!previous) body.textContent='Bet receipts are unavailable. They will retry automatically.'; }
  };
  void load();
  timer=setInterval(()=>{if(!document.hidden&&!document.getElementById('view-history')?.hidden)void load();},5000);
}
