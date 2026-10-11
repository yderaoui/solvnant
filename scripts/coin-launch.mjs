#!/usr/bin/env node
// No private keys. COIN_ADMIN_KEY is a separate operations secret, never a wallet key.
const [action, mint, symbol, mode] = process.argv.slice(2);
if (!['status','pause','prepare','enable'].includes(action) || (mode !== undefined && (action !== 'prepare' || mode !== '--test'))) throw new Error('Usage: node scripts/coin-launch.mjs status|pause|prepare <CA> <ticker> [--test]|enable');
const base = process.env.PUMPKART_API_URL;
const key = process.env.COIN_ADMIN_KEY;
if (!base || !/^https:\/\//.test(base) && !/^http:\/\/(localhost|127\.0\.0\.1)(:|\/)/.test(base)) throw new Error('Set PUMPKART_API_URL to the game server URL.');
async function config() {
  const r = await fetch(`${base.replace(/\/$/,'')}/api/config`, {cache:'no-store'});
  if (!r.ok) throw new Error('Cannot read launch status.');
  return r.json();
}
const before = await config();
if (action==='status') {
  console.log(JSON.stringify({coinLaunch:before.coinLaunch,mint:before.tickets?.mint,symbol:before.tickets?.symbol},null,2));
} else {
  if (!key) throw new Error('Set the COIN_ADMIN_KEY operations secret locally. Do not put it in the command arguments.');
  const r=await fetch(`${base.replace(/\/$/,'')}/api/admin/coin`, {
    method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${key}`},
    body:JSON.stringify({action,mint,symbol,...(mode === '--test' ? {mode:'test',paidEnabled:false} : {}),revision:before.coinLaunch?.revision})
  });
  const result=await r.json();
  if(!r.ok) throw new Error(result.error || `Launch operation failed (${r.status}).`);
  const after=await config();
  if(after.coinLaunch.revision!==result.coinLaunch.revision) throw new Error('Verification failed: public settings do not match the switch. Leave purchases paused.');
  console.log(JSON.stringify({coinLaunch:after.coinLaunch,mint:after.tickets.mint,symbol:after.tickets.symbol},null,2));
}
