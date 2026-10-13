import { DatabaseSync } from 'node:sqlite';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { Hub } from '../src/game/hub';
import { signSession } from '../src/game/auth';

const mocked=vi.hoisted(()=>({read:vi.fn(),price:vi.fn(),build:vi.fn(),send:vi.fn(),status:vi.fn(),readiness:vi.fn(),height:vi.fn()}));
vi.mock('../src/game/solana',async original=>({...await original<object>(),readPayment:mocked.read,coinPriceUsd:mocked.price}));
vi.mock('../src/game/paidReadiness',()=>({paidReadinessProblem:mocked.readiness}));
vi.mock('../src/game/house',async original=>({...await original<object>(),loadHouse:async()=>({address:'11111111111111111111111111111111',signer:{}}),buildPayout:mocked.build,sendWire:mocked.send,txStatus:mocked.status,blockHeight:mocked.height}));
const mint='So11111111111111111111111111111111111111112',wallet='BJLoxTq2dkU46hXzL2UNjDPEHWs5ugKirFERYffpump'; // public fixture addresses; no signing/network transfers
const env={SESSION_SECRET:'coin-bet-fixture',COIN_ADMIN_KEY:'operations-fixture',ALLOW_GUESTS:'true',COIN_LAUNCH_READY:'true',COIN_LAUNCH_REVISION:'fixture-v1',COIN_BUY_ENABLED:'true',TICKET_MINT:mint,TICKET_CLUSTER:'devnet',TICKET_DECIMALS:'6',TICKET_TREASURY:'11111111111111111111111111111111',TEAM_WALLET:'11111111111111111111111111111111',HOUSE_SECRET:'fixture-no-key',SUPABASE_URL:'https://league.fixture',SUPABASE_SERVICE_ROLE_KEY:'service-fixture',SUPABASE_ANON_KEY:'anon-fixture',LEAGUE_COIN_BETS:'true'};
let db:DatabaseSync,hub:Hub,now:number,start:number,ends:number,leak:boolean,results:unknown[],signatureCounter:number;
function state(){return{storage:{sql:{exec(q:string,...args:unknown[]){const s=db.prepare(q),values=args as (string|number|null)[];const rows=s.columns().length?s.all(...values):(s.run(...values),[]);return{toArray:()=>rows,one:()=>{if(rows.length!==1)throw Error('Expected row');return rows[0];}};}},transactionSync<T>(fn:()=>T){db.exec('SAVEPOINT fixture');try{const result=fn();db.exec('RELEASE fixture');return result;}catch(e){db.exec('ROLLBACK TO fixture');db.exec('RELEASE fixture');throw e;}},getAlarm:async()=>now+60000,setAlarm:async()=>{},deleteAlarm:async()=>{}}};}
const sig=()=>String(++signatureCounter).padStart(88,'5');
beforeEach(async()=>{
 db=new DatabaseSync(':memory:');now=1800000000000;start=now+225000;ends=start+120000;leak=false;results=[];signatureCounter=0;
 vi.spyOn(Date,'now').mockImplementation(()=>now);
 mocked.read.mockReset();mocked.price.mockReset().mockResolvedValue(.002);mocked.readiness.mockReset().mockResolvedValue(null);
 mocked.build.mockReset().mockImplementation(async()=>({signature:sig(),wire:'fixture-wire',lastValid:1000}));mocked.send.mockReset().mockResolvedValue('sent');mocked.status.mockReset().mockResolvedValue({ok:true});
 mocked.height.mockReset().mockResolvedValue(100);
 vi.stubGlobal('fetch',vi.fn(async(input,init)=>{
  const u=new URL(String(input)),headers=init?.headers as Record<string,string>;
  if(u.origin!=='https://league.fixture')throw Error('Unexpected network call');
  if(headers.apikey==='anon-fixture')return Response.json(leak?[{id:1,seed:'revealed'}]:[]);
  if(u.pathname.endsWith('/race_results'))return Response.json(u.searchParams.get('position')==='eq.1'?results.slice(0,1):results);
  return Response.json([{id:1,start_at:new Date(start).toISOString(),ends_at:new Date(ends).toISOString(),race_entries:[{car:0,name:'Agent A',color:'#ff006e'},{car:1,name:'Agent B',color:'#00ffff'}]}]);
 }));
 hub=new Hub(state(),env);await hub.alarm();
});
afterEach(()=>{db.close();vi.restoreAllMocks();vi.unstubAllGlobals();});
async function api(path:string,body?:object,uid='alice'){
 const token=await signSession({uid,name:uid,kind:'guest'},env.SESSION_SECRET);
 return hub.fetch(new Request('https://fixture'+path,{method:body===undefined?'GET':'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)}));
}
async function quote(pick='0',usd=1,uid='alice'){
 const response=await api('/api/league/bet/intent',{market:'league:1',pick,usd,coinRevision:'fixture-v1'},uid);
 expect(response.status,await response.clone().text()).toBe(200);return response.json();
}
async function pay(q:any,uid='alice',extra:object={}){
 const signature=sig();mocked.read.mockResolvedValue({wallet,amount:q.price,units:q.entryUnits,payerUnits:q.entryUnits,blockTime:Math.floor(now/1000),memos:[q.memo],...extra});
 const response=await api('/api/league/bet/claim',{signature},uid);return{signature,response,json:await response.json()};
}
it('opens a coin market without publishing its seed, results or server key',async()=>{
 const response=await api('/api/market?id=league:1');const v=await response.json();
 expect(v.currency).toBe('coin');expect(v.market.picks).toHaveLength(2);expect(JSON.stringify(v)).not.toMatch(/service-fixture|seed|ends_at/);
 const q=await quote();expect(q.entryUnits).toBe('500000000');expect(q.usd).toBe(1);
});
it('refuses anonymous intent/claim/track and rejects stale revisions',async()=>{
 for(const path of ['/api/league/bet/intent','/api/league/bet/claim','/api/league/bet/track','/api/league/bets'])expect((await hub.fetch(new Request('https://fixture'+path))).status).toBe(401);
 expect((await api('/api/league/bet/intent',{market:'league:1',pick:'0',usd:1,coinRevision:'old'})).status).toBe(409);
});
it('refuses a revealed outcome and an unfunded payout treasury before issuing a quote',async()=>{
 leak=true;expect((await api('/api/league/bet/intent',{market:'league:1',pick:'0',usd:1,coinRevision:'fixture-v1'})).status).toBe(409);
 expect(db.prepare('SELECT COUNT(*) AS n FROM league_bet_intents').get()!.n).toBe(0);
 leak=false;mocked.readiness.mockResolvedValue('Treasury needs SOL.');expect((await api('/api/league/bet/intent',{market:'league:1',pick:'0',usd:1,coinRevision:'fixture-v1'})).status).toBe(409);
});
it('credits a verified bet once, never deducts points, and prevents cross-currency reuse',async()=>{
 const q=await quote(),payment=await pay(q);expect(payment.json.accepted).toBe(true);
 const again=await api('/api/league/bet/claim',{signature:payment.signature});expect((await again.json()).accepted).toBe(true);
 expect(db.prepare('SELECT COUNT(*) AS n FROM league_coin_bets').get()!.n).toBe(1);
 expect(db.prepare('SELECT COUNT(*) AS n FROM ledger WHERE reason = ?').get('bet')!.n).toBe(0);
 expect((await api('/api/league/bet/claim',{signature:payment.signature},'bob')).status).toBe(400);
 expect((await api('/api/ticket/claim',{signature:payment.signature})).status).toBe(400);
 expect((await api('/api/skin/claim',{signature:payment.signature})).status).toBe(400);
});
it('queues exact winner/burn/team units and cannot pay again on another alarm or restart',async()=>{
 await pay(await quote('0',1));await pay(await quote('1',2,'bob'),'bob');
 now=ends+1;results=[{car:0,position:1,finished:true},{car:1,position:2,finished:true}];await hub.alarm();
 expect(mocked.build).toHaveBeenCalledTimes(1);expect(mocked.build.mock.calls[0][2].rawUnits).toEqual({prize:'1200000000',burn:'225000000',team:'75000000'});
 expect(db.prepare("SELECT status FROM league_coin_markets").get()!.status).toBe('settled');
 hub=new Hub(state(),env);await hub.alarm();await hub.alarm();expect(mocked.build).toHaveBeenCalledTimes(1);
 const history=await(await api('/api/league/bets')).json();expect(history[0].mine[0].paymentStatus).toBe('paid');expect(history[0].mine[0].payoutSignature).toBeTruthy();
});
it.each(['late','amount','duplicate'])('refunds the complete original payment for %s without burn/team',async scenario=>{
 const q=await quote();if(scenario==='duplicate')await pay(q);if(scenario==='late')now=start-45000+1000;
 const units=scenario==='amount'?'500000001':q.entryUnits;
 const r=await pay(q,'alice',{units,payerUnits:units,amount:Number(units)/1e6});expect(r.json.refunded).toBe(true);
 const row=db.prepare("SELECT * FROM lobby_payouts WHERE kind='league'").get()!;expect(JSON.parse(String(row.raw_units))).toEqual({prize:units,burn:'0',team:'0'});expect(row.wallet).toBe(wallet);
});
it('requires the original token debit and keeps unknown chain times pending',async()=>{
 const q=await quote();expect((await pay(q,'alice',{payerUnits:'0'})).response.status).toBe(409);
 expect((await pay(q,'alice',{blockTime:null})).json.pending).toBe(true);
 expect(db.prepare('SELECT COUNT(*) AS n FROM league_coin_bets').get()!.n).toBe(0);
});
it('refunds a pre-signed payment first confirmed after seed disclosure even with an earlier block time',async()=>{
 const q=await quote(),ontimeBlock=Math.floor(now/1000);now=start-45000+1;
 const r=await pay(q,'alice',{blockTime:ontimeBlock});expect(r.json.refunded).toBe(true);
 expect(db.prepare("SELECT COUNT(*) AS n FROM league_coin_bets WHERE state='accepted'").get()!.n).toBe(0);
 expect(JSON.parse(String(db.prepare('SELECT raw_units FROM lobby_payouts').get()!.raw_units))).toEqual({prize:q.entryUnits,burn:'0',team:'0'});
});
it('waits for all authoritative results; refunds on a database outage without page polling',async()=>{
 await pay(await quote());now=ends+1;results=[{car:0,position:1,finished:true}];await hub.alarm();expect(mocked.build).not.toHaveBeenCalled();
 vi.mocked(fetch).mockRejectedValue(Error('Database offline'));now=ends+15*60000+1;await hub.alarm();
 expect(mocked.build.mock.calls[0][2].rawUnits).toEqual({prize:'500000000',burn:'0',team:'0'});
});
it('automatically recovers a signed payment after the browser disappears',async()=>{
 const q=await quote(),signature=sig();expect((await api('/api/league/bet/track',{signature,memo:q.memo})).status).toBe(200);
 mocked.read.mockResolvedValue({wallet,amount:q.price,units:q.entryUnits,payerUnits:q.entryUnits,blockTime:Math.floor(now/1000),memos:[q.memo]});
 await hub.alarm();expect(db.prepare('SELECT sig FROM league_coin_bets').get()!.sig).toBe(signature);
});
it('never expires a processed receipt; retires an absent one only after finalized expiry',async()=>{
 const q=await quote(),signature=sig();
 db.prepare('INSERT INTO league_bet_receipts (sig,uid,memo,created,last_valid) VALUES (?,?,?,?,?)').run(signature,'alice',q.memo,now,100);
 mocked.read.mockResolvedValue(null);mocked.status.mockResolvedValue({ok:null});mocked.height.mockResolvedValue(111);now+=31000;
 await hub.alarm();expect(db.prepare('SELECT status FROM league_bet_receipts').get()!.status).toBe('pending');
 mocked.status.mockResolvedValue(null);mocked.height.mockResolvedValue(110);now+=11000;await hub.alarm();expect(db.prepare('SELECT status FROM league_bet_receipts').get()!.status).toBe('pending');
 mocked.height.mockResolvedValue(111);now+=11000;await hub.alarm();expect(db.prepare('SELECT status FROM league_bet_receipts').get()!.status).toBe('done');
 expect(db.prepare('SELECT COUNT(*) AS n FROM league_coin_bets').get()!.n).toBe(0);
});
it('does not trust an expiry height supplied by the browser',async()=>{
 const q=await quote(),signature=sig();await api('/api/league/bet/track',{signature,memo:q.memo,lastValid:0});
 expect(db.prepare('SELECT last_valid FROM league_bet_receipts').get()!.last_valid).toBeNull();
});
it('cannot switch the configured mint while a coin-bet pool holds stakes',async()=>{
 await pay(await quote());
 const admin=async(action:string,extra:object={})=>{const cfg=await(await hub.fetch(new Request('https://fixture/api/config'))).json();return hub.fetch(new Request('https://fixture/api/admin/coin',{method:'POST',headers:{authorization:'Bearer operations-fixture','content-type':'application/json'},body:JSON.stringify({action,revision:cfg.coinLaunch.revision,...extra})}));};
 await admin('pause');now+=120001;
 expect((await admin('prepare',{mint:'11111111111111111111111111111111',symbol:'$NEXT'})).status).toBe(409);
});
