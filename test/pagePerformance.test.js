import test from 'node:test';
import assert from 'node:assert/strict';
import {createPageReads,readWorkspaceContext} from '../public/pageReads.js';
import {readDashboard} from '../public/dashboardData.js';
import {createFormData} from '../public/formData.js';
import {createRenderQueue} from '../public/tabWorkspace.js';

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes,no) => {resolve=yes;reject=no;});
  return {promise,resolve,reject};
};

test('startup reuses even an empty authorized workspace list, but supports older servers', async () => {
  let calls=0;
  const fetcher=async(path,options)=>{calls++;assert.equal(path,'/api/tenants');assert.equal(options.tenant,false);return Response.json({tenants:[{id:'legacy'}]});};
  for(const tenants of [[],[{id:'alpha',smsRead:false,formsManage:true}]]) {
    const session={tenants,capabilities:{platformStaff:false}};
    assert.equal(await readWorkspaceContext(fetcher,session),session);
  }
  assert.equal(calls,0);
  assert.equal((await readWorkspaceContext(fetcher,{})).tenants[0].id,'legacy');
  assert.equal(calls,1);
  await assert.rejects(readWorkspaceContext(async()=>new Response(null,{status:403})),/business accounts/);
});

test('dashboard launches independent reads together and paints totals before secondary data', async () => {
  const totals=deferred(),connection=deferred(),categories=deferred(),started=[];
  let painted;
  const pending=readDashboard(path=>{started.push(path);return path==='/api/overview'?totals.promise:connection.promise;},
    ()=>{started.push('categories');return categories.promise;},data=>{painted=data;});
  assert.deepEqual(started,['/api/overview','/api/sms/connection','categories','/api/web-forms']);
  totals.resolve(Response.json({total:17}));
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(painted.total,17);
  connection.resolve(Response.json({phoneNumber:'synthetic'}));categories.resolve();
  assert.equal((await pending).data.total,17);
  assert.ok(!started.includes('/api/provisioning'));
});

test('dashboard distinguishes unavailable totals from zero and preserves access/cancellation failures', async () => {
  const failed=await readDashboard(async()=>new Response(null,{status:503}),async()=>{});
  assert.equal(failed.totalsAvailable,false);assert.equal(failed.smsConnection,null);
  await assert.rejects(readDashboard(async()=>new Response(null,{status:403}),async()=>{}),{status:403});
  await assert.rejects(readDashboard(async()=>{throw new DOMException('Navigation','AbortError');},async()=>{}),{name:'AbortError'});
});

test('navigation cancels a slow read and frees the render queue without stale painting', async () => {
  const started=deferred(),events=[];
  const reads=createPageReads((_path,{signal})=>new Promise((_resolve,reject)=>{
    started.resolve();signal.addEventListener('abort',()=>reject(signal.reason),{once:true});
  }));
  const queue=createRenderQueue();
  const old=queue.run(async()=>{
    const scope=reads.begin();
    try {await reads.fetch('/slow');events.push('paint old');} finally {reads.end(scope);}
  });
  const rejected=assert.rejects(old,{name:'AbortError'});
  await started.promise;reads.cancel();
  await queue.run(()=>events.push('paint new'));await rejected;
  assert.deepEqual(events,['paint new']);
});

test('navigation never cancels writes and the next page gets a fresh signal', async () => {
  const calls=[],write=deferred();
  const reads=createPageReads((path,options)=>{calls.push(options);return path==='/save'?write.promise:Promise.resolve(Response.json({}));});
  const first=reads.begin(),pending=reads.fetch('/save',{method:'PUT'});
  reads.cancel();assert.equal(calls[0].signal,undefined);
  await assert.rejects(reads.fetch('/obsolete'),{name:'AbortError'});
  write.resolve(Response.json({saved:true}));assert.equal((await (await pending).json()).saved,true);
  reads.end(first);const next=reads.begin();await reads.fetch('/next');
  assert.equal(calls.at(-1).signal.aborted,false);reads.end(next);
});

test('Forms coalesces reads, invalidates after writes and isolates tenant changes', async () => {
  let tenant='alpha',count=0;
  const cache=createFormData(async()=>Response.json({tenant,version:++count}),()=>tenant);
  const [one,two]=await Promise.all([cache.read('/api/web-forms'),cache.read('/api/web-forms')]);
  assert.equal(one,two);assert.equal(count,1);
  await cache.read('/api/automation-presets');assert.equal(count,2);
  await cache.fetch('/api/web-forms/id',{method:'PUT'});
  assert.equal((await cache.read('/api/web-forms')).version,4);
  assert.equal((await cache.read('/api/automation-presets')).version,5);
  tenant='beta';assert.equal((await cache.read('/api/web-forms')).tenant,'beta');
  cache.clear();assert.equal((await cache.read('/api/web-forms')).version,7);
});

test('Forms retries failed reads and an old in-flight tenant read cannot refill its cache', async () => {
  let tenant='alpha',count=0;
  const old=deferred();
  const cache=createFormData(async()=>{
    count++;if(count===1)return new Response(null,{status:503});
    if(count===2)return old.promise;
    return Response.json({tenant});
  },()=>tenant);
  await assert.rejects(cache.read('/forms'));
  const pending=cache.read('/forms');tenant='beta';
  assert.equal((await cache.read('/forms')).tenant,'beta');
  old.resolve(Response.json({tenant:'alpha'}));await pending;
  assert.equal((await cache.read('/forms')).tenant,'beta');assert.equal(count,3);
});
