import test from 'node:test';
import assert from 'node:assert/strict';
import {createWorkspaceCache,CACHE_KEY,CACHE_TTL,cacheableRead} from '../public/workspaceCache.js';
import {workspaceWarmupTasks,warmWorkspace,workspaceIdle} from '../public/workspaceWarmup.js';
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
const storage=()=>{const data=new Map();return {getItem:key=>data.get(key),setItem:(key,value)=>data.set(key,value),removeItem:key=>data.delete(key)};};
const turn=()=>new Promise(resolve=>setImmediate(resolve));

test('a fresh authorized scope reuses persisted first-page reads on reload, then expires',async()=>{
  let time=1000,calls=0;const store=storage(),options={storage:()=>store,now:()=>time};
  const fetcher=async()=>Response.json({version:++calls});
  const first=createWorkspaceCache(options);first.activate('session:a:tenant:a:permissions');
  assert.equal((await (await first.fetch('/api/bookings?page=1&pageSize=50',{},fetcher)).json()).version,1);
  const reload=createWorkspaceCache(options);
  // No authorized bootstrap yet: disk data cannot be used.
  await reload.fetch('/api/bookings?page=1&pageSize=50',{},fetcher);assert.equal(calls,2);
  reload.activate('session:a:tenant:a:permissions');
  assert.equal((await (await reload.fetch('/api/bookings?pageSize=50&page=1',{},fetcher)).json()).version,1);
  time+=CACHE_TTL;await reload.fetch('/api/bookings?page=1&pageSize=50',{},fetcher);assert.equal(calls,3);
});

test('user, tenant and access changes purge persisted data; invalidation rejects late refills',async()=>{
  const store=storage(),cache=createWorkspaceCache({storage:()=>store});let calls=0;
  const fetcher=async()=>Response.json({n:++calls});cache.activate('alice:alpha:staff');
  await cache.fetch('/api/overview',{},fetcher);cache.activate('alice:alpha:viewer');
  await cache.fetch('/api/overview',{},fetcher);cache.activate('bob:beta:staff');
  await cache.fetch('/api/overview',{},fetcher);assert.equal(calls,3);
  const slow=deferred();const pending=cache.fetch('/api/web-forms',{},()=>slow.promise);
  await turn();cache.invalidate();slow.resolve(Response.json({old:true}));await pending;
  assert.equal(store.getItem(CACHE_KEY),undefined);
  await cache.fetch('/api/web-forms',{},fetcher);assert.equal(calls,4);
  cache.activate(null);assert.equal(store.getItem(CACHE_KEY),undefined);
});

test('warmup and foreground share one read; cancelling warmup leaves the foreground alive',async()=>{
  const cache=createWorkspaceCache({storage});cache.activate('scope');
  const slow=deferred(),warm=new AbortController();let calls=0,networkSignal;
  const fetcher=options=>{calls++;networkSignal=options.signal;return slow.promise;};
  const background=cache.fetch('/api/web-forms',{signal:warm.signal},fetcher);
  const foreground=cache.fetch('/api/web-forms',{},fetcher);
  const aborted=assert.rejects(background,{name:'AbortError'});
  await turn();warm.abort();await aborted;assert.equal(networkSignal.aborted,false);
  slow.resolve(Response.json({forms:[1]}));assert.deepEqual(await (await foreground).json(),{forms:[1]});assert.equal(calls,1);
  assert.deepEqual(await (await cache.fetch('/api/web-forms',{},fetcher)).json(),{forms:[1]});assert.equal(calls,1);
});

test('last caller cancellation releases network, and the next caller retries immediately',async()=>{
  const cache=createWorkspaceCache({storage});cache.activate('scope');
  const controller=new AbortController();let networkSignal;
  const old=cache.fetch('/api/overview',{signal:controller.signal},options=>{networkSignal=options.signal;return new Promise(()=>{});});
  const aborted=assert.rejects(old,{name:'AbortError'});await turn();controller.abort();await aborted;
  assert.equal(networkSignal.aborted,true);
  assert.equal((await cache.fetch('/api/overview',{},async()=>Response.json({}))).status,200);
});

test('completing a read never aborts its response body before the page consumes it',async()=>{
  const cache=createWorkspaceCache({storage});cache.activate('scope');let signal;
  const response=await cache.fetch('/api/overview',{},async options=>{signal=options.signal;return Response.json({total:12});});
  assert.equal(signal.aborted,false);assert.deepEqual(await response.json(),{total:12});
});

test('errors, malformed JSON, oversized data and non-allowlisted reads are never cached',async()=>{
  const cache=createWorkspaceCache({storage});cache.activate('scope');
  for(const create of [()=>new Response(null,{status:503}),()=>new Response('{',{headers:{'Content-Type':'application/json'}}),()=>Response.json({text:'x'.repeat(128_000)})]) {
    let calls=0;const fetcher=async()=>{calls++;return create();};
    await cache.fetch('/api/overview',{},fetcher);await cache.fetch('/api/overview',{},fetcher);assert.equal(calls,2);
  }
  for(const path of ['/api/auth/me','/api/tenants','/api/provisioning','/api/voice/calls','/api/web-forms/id/submissions','/api/platform/accounts?id=someone','/api/directory?page=2&pageSize=50','/api/messages?q=private','https://other.invalid/api/overview']) assert.equal(cacheableRead(path),false,path);
  assert.equal(cacheableRead('/api/overview',{method:'POST'}),false);
  assert.equal(cacheableRead('/api/overview',{cache:'no-store'}),false);
});

test('authorization failures purge earlier responses and storage failure never breaks a page',async()=>{
  const store=storage(),cache=createWorkspaceCache({storage:()=>store});cache.activate('scope');
  await cache.fetch('/api/overview',{},async()=>Response.json({}));
  await cache.fetch('/api/web-forms',{},async()=>new Response(null,{status:403}));assert.equal(store.getItem(CACHE_KEY),undefined);
  const denied=createWorkspaceCache({storage:()=>{throw new Error('blocked');}});denied.activate('scope');
  assert.equal((await denied.fetch('/api/overview',{},async()=>Response.json({}))).status,200);
});

test('storage is bounded and corrupted saved state falls back to network',async()=>{
  const store=storage(),cache=createWorkspaceCache({storage:()=>store,maxEntries:1,maxBytes:500});cache.activate('scope');
  for(const path of ['/api/overview','/api/web-forms'])await cache.fetch(path,{},async()=>Response.json({}));
  assert.equal(JSON.parse(store.getItem(CACHE_KEY)).entries.length,1);assert.ok(store.getItem(CACHE_KEY).length*2<=500);
  store.setItem(CACHE_KEY,'broken');const reload=createWorkspaceCache({storage:()=>store});reload.activate('scope');
  assert.equal((await reload.fetch('/api/overview',{},async()=>Response.json({}))).status,200);
});

test('warming uses permitted supplied tabs, deduplicates requests and stays read-only',async()=>{
  const paths=[],code=[];
  const tasks=workspaceWarmupTasks(['web-forms','contacts','messaging','platform-accounts','platform-websites'],async(path,options)=>{paths.push([path,options]);},async module=>code.push(module));
  await warmWorkspace(tasks,{signal:new AbortController().signal,idle:async()=>{}});
  assert.deepEqual(code,['web-forms','platform']);
  assert.equal(paths.filter(([path])=>path==='/api/categories').length,1);
  assert.ok(!paths.some(([path])=>path.includes('bookings')));
  assert.ok(paths.every(([,options])=>!options.method));
  assert.equal(paths.find(([path])=>path.includes('platform/accounts'))[1].tenant,false);
  const restricted=[];await warmWorkspace(workspaceWarmupTasks(['web-forms'],async path=>restricted.push(path),async()=>{}),{signal:new AbortController().signal,idle:async()=>{}});
  assert.deepEqual(restricted,['/api/web-forms']);
});

test('warmup is sequential, tolerates errors and yields to navigation cancellation',async()=>{
  const slow=deferred(),controller=new AbortController(),events=[];
  const pending=warmWorkspace([async()=>{events.push('first');await slow.promise;},async()=>events.push('second')],{signal:controller.signal,idle:async()=>{}});
  await turn();assert.deepEqual(events,['first']);controller.abort();slow.resolve();await pending;assert.deepEqual(events,['first']);
  await warmWorkspace([async()=>{throw new Error('unavailable');},async()=>events.push('retry')],{signal:new AbortController().signal,idle:async()=>{}});
  assert.deepEqual(events,['first','retry']);
  await warmWorkspace([async()=>new Response(null,{status:403}),async()=>events.push('unauthorized')],{signal:new AbortController().signal,idle:async()=>{}});
  assert.deepEqual(events,['first','retry']);
});

test('idle warmup pauses in a hidden browser tab and cancels cleanly',async t=>{
  const original=Object.getOwnPropertyDescriptor(globalThis,'document');
  t.after(()=>{if(original)Object.defineProperty(globalThis,'document',original);else delete globalThis.document;});
  const document=new EventTarget();document.hidden=true;globalThis.document=document;
  const controller=new AbortController();let finished=false;
  const waiting=workspaceIdle(controller.signal).then(()=>{finished=true;});
  await new Promise(resolve=>setTimeout(resolve,230));assert.equal(finished,false);
  document.hidden=false;document.dispatchEvent(new Event('visibilitychange'));await waiting;assert.equal(finished,true);
  document.hidden=true;const cancelled=new AbortController();const pending=workspaceIdle(cancelled.signal);cancelled.abort();await pending;
});
