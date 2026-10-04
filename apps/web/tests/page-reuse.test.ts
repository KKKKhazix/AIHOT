// Failure modes fixed before adding page reuse: unbounded retention, renewal on a hit,
// cross-query confusion, cached failures/cancelled work, and explicit revalidation keeping old data.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cachedLoader, shouldRevalidate } from '../app/lib/page-reuse.ts';

test('visited pages retain their original deadline, bound memory, and refresh explicitly', async () => {
  const load = cachedLoader<() => {expiresAt:number;title:string}>();
  let calls = 0;
  const expiresAt = Date.now()+60_000;
  const read = (key:string) => load({request:new Request('http://page.local/'+key),serverLoader:async()=>({expiresAt,title:'read '+ ++calls})} as unknown as Parameters<typeof load>[0]);
  assert.equal((await read('reuse-a')).title,'read 1');
  assert.equal((await read('reuse-b?q=1')).title,'read 2');
  assert.equal((await read('reuse-a')).title,'read 1');
  assert.equal((await read('reuse-a')).expiresAt,expiresAt,'reuse cannot renew a result');
  assert.equal((await read('reuse-b?q=2')).title,'read 3');
  for(let i=0;i<50;i++)await read('reuse-'+i);
  const before = calls;
  await read('reuse-a');
  assert.equal(calls,before+1,'old entries must eventually leave memory');
  const url=new URL('http://page.local/reuse-a');
  assert.equal(shouldRevalidate({currentUrl:url,nextUrl:url,defaultShouldRevalidate:true} as Parameters<typeof shouldRevalidate>[0]),true);
  await read('reuse-a');
  assert.equal(calls,before+2,'an explicit revalidation cannot reuse the previous result');
});

test('expired data, rejected loads and loads cancelled before completion never become reusable',async()=>{
  const load=cachedLoader<() => {expiresAt:number;title:string}>();
  let calls=0;
  const read=(key:string,serverLoader:()=>Promise<unknown>,signal?:AbortSignal)=>load({request:new Request('http://page.local/'+key,{signal}),serverLoader} as unknown as Parameters<typeof load>[0]);
  const expired=async()=>({expiresAt:Date.now()-1,title:String(++calls)});
  await read('expired',expired);await read('expired',expired);assert.equal(calls,2);
  await assert.rejects(read('failure',async()=>{throw new Error('unavailable');}));
  assert.equal((await read('failure',async()=>({expiresAt:Date.now()+60_000,title:'recovered'}))).title,'recovered');
  const controller=new AbortController();
  await read('cancelled',async()=>{controller.abort();return {expiresAt:Date.now()+60_000,title:'cancelled'};},controller.signal);
  assert.equal((await read('cancelled',async()=>({expiresAt:Date.now()+60_000,title:'current'}))).title,'current');
});
