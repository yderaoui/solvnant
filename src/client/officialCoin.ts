import { account } from './account';
import { escapeHtml } from './codeViewer';
import { icon } from './icons';
import { toast } from './toast';

/** Identity comes from the same verified runtime configuration used by every coin payment. */
export function initOfficialCoin() {
  const host = document.getElementById('official-coin');
  if (!host) return;
  const render = () => {
    const cfg = account.cfg, t = cfg?.tickets;
    const official = cfg?.coinLaunch?.mode === 'official' && cfg.coinLaunch.buyEnabled
      && t?.cluster === 'mainnet-beta' && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(t.mint);
    host.hidden = !official;
    if (!official || !t) { host.innerHTML = ''; return; }
    const mint = t.mint;
    host.innerHTML = `<div class="official-coin-heading"><h2 id="official-coin-title">Official coin CA</h2><span>${escapeHtml(t.symbol)}</span></div>
      <div class="official-coin-address"><code id="official-coin-ca">${escapeHtml(mint)}</code><button class="btn btn-ghost small" id="official-coin-copy" type="button" aria-label="Copy official coin address">${icon('copy', 14)}Copy</button></div>
      <div class="official-coin-links"><a href="https://solscan.io/token/${encodeURIComponent(mint)}" target="_blank" rel="noopener noreferrer">Solscan ${icon('overtake', 12)}</a><a href="https://pump.fun/coin/${encodeURIComponent(mint)}" target="_blank" rel="noopener noreferrer">pump.fun ${icon('overtake', 12)}</a><a href="#/buy">Get ${escapeHtml(t.symbol)} ${icon('overtake', 12)}</a></div>`;
    host.querySelector<HTMLButtonElement>('#official-coin-copy')!.onclick = async () => {
      try { await navigator.clipboard.writeText(mint); toast('Official coin address copied.'); }
      catch { toast('Select and copy the full address shown.'); }
    };
  };
  account.onChange(render);
  render();
}
