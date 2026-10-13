import { expect, it } from 'vitest';
import { leaguePaymentInTime, leagueStakeUsd, settleCoinPool } from '../src/game/leagueCoinPool';

it('conserves every raw unit across multiple winning bets and the 80/15/5 split', () => {
  const result = settleCoinPool([{id:'a',pick:'winner',units:'1000000'},{id:'b',pick:'winner',units:'2000000'},{id:'c',pick:'loser',units:'7000000'}], 'winner');
  expect(result).toMatchObject({total:'10000000',prize:'8000000',burn:'1500000',team:'500000',refunded:false});
  expect(result.payouts.get('a')).toBe('2666667'); expect(result.payouts.get('b')).toBe('5333333'); expect(result.payouts.get('c')).toBe('0');
  expect([...result.payouts.values()].reduce((s,x)=>s+BigInt(x),0n)+BigInt(result.burn)+BigInt(result.team)).toBe(10000000n);
});
it('keeps arithmetic exact beyond the JS safe integer range', () => {
  const n='18446744073709550000';
  const result=settleCoinPool([{id:'a',pick:'w',units:n}], 'w');
  expect(BigInt(result.payouts.get('a')!)+BigInt(result.burn)+BigInt(result.team)).toBe(BigInt(n));
});
it.each([null,'unbacked'])('refunds all stakes without fees for %s', winner => {
  const result=settleCoinPool([{id:'a',pick:'0',units:'99'},{id:'b',pick:'1',units:'101'}],winner);
  expect(result.refunded).toBe(true); expect(result.burn).toBe('0');expect(result.team).toBe('0');expect([...result.payouts.values()]).toEqual(['99','101']);
});
it('rejects invalid raw stakes',()=>{for(const units of ['0','-1','1.5','1e3','bad'])expect(()=>settleCoinPool([{id:'a',pick:'0',units}],null)).toThrow();});
it('accepts only bounded dollar stakes in whole cents',()=>{
  expect(leagueStakeUsd(.01)).toBe(.01);expect(leagueStakeUsd(100)).toBe(100);
  for(const value of ['1',0,.001,100.01,NaN,Infinity,null])expect(leagueStakeUsd(value)).toBeNull();
});
it('counts only chain payments whose entire block second precedes seed disclosure',()=>{
  const closes=1800000000123;
  expect(leaguePaymentInTime(1799999999,closes)).toBe(true);
  expect(leaguePaymentInTime(1800000000,closes)).toBe(false);
  expect(leaguePaymentInTime(null,closes)).toBe(false);
});
