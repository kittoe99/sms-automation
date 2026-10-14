import test from 'node:test';
import assert from 'node:assert/strict';
import {createPageLifecycle,uploadFiles} from '../public/pageLifecycle.js';
import {createPlatform} from '../public/platform.js';
import {createLiveConnection} from '../public/live.js';
import {mountVoiceWorkspace} from '../public/voiceWorkspace.js';
import {retainsMountedTab} from '../public/tabWorkspace.js';

const deferred=()=>{let resolve;return {promise:new Promise(r=>resolve=r),resolve:v=>resolve(v)};};
const turn=()=>new Promise(resolve=>setImmediate(resolve));
// Models mount/dispose/request ownership. Layout is checked in a browser.
class Host {
 isConnected=true;nodes=new Map();children=[];audios=[];html='';classList={add(){}};
 set innerHTML(value){this.html=value;this.nodes.clear();}get innerHTML(){return this.html;}
 replaceChildren(...children){this.children=children;}
 querySelector(key){if(!this.nodes.has(key))this.nodes.set(key,new Host());return this.nodes.get(key);}
 querySelectorAll(key){return key==='audio'?this.audios:[];}
 insertAdjacentHTML(_position,value){this.html+=value;}
}

test('a retired platform read cannot hold navigation or paint another page, even when transport ignores abort',async()=>{
 const old=deferred(),title={},subtitle={},pager={};let selected='old',signal;
 const oldHost=new Host(),newHost=new Host();
 const first=createPlatform({root:oldHost,title,subtitle,pager,isCurrent:()=>selected==='old',fetcher:(_path,options)=>{signal=options.signal;return old.promise;}});
 const pending=first.render('platform-accounts');const cancelled=assert.rejects(pending,{name:'AbortError'});
 first.suspend();selected='new';
 const second=createPlatform({root:newHost,title,subtitle,pager,isCurrent:()=>selected==='new',fetcher:async()=>Response.json({rows:[{id:'new',name:'Current business'}],total:1,totalPages:1})});
 await second.render('platform-businesses');await cancelled;
 assert.equal(signal.aborted,true);assert.equal(title.textContent,'Businesses');assert.match(newHost.innerHTML,/Current business/);
 old.resolve(Response.json({rows:[{id:'old',name:'Retired account'}],total:1,totalPages:1}));await turn();
 assert.doesNotMatch(oldHost.innerHTML,/Retired account/);assert.equal(title.textContent,'Businesses');
 first.dispose();second.dispose();
});

test('page generations reject older results and retain independent writes',async()=>{
 const lifecycle=createPageLifecycle(),old=deferred(),write=deferred();
 const pending=lifecycle.read(()=>old.promise);const cancelled=assert.rejects(pending,{name:'AbortError'});
 lifecycle.suspend();lifecycle.resume();await cancelled;
 assert.equal(await lifecycle.read(async()=> 'new page'),'new page');
 write.resolve('saved');assert.equal(await write.promise,'saved');
 old.resolve('old page');lifecycle.suspend();
});

test('Voice pages remount live handlers with retained drafts and dispose audio before cached navigation',async t=>{
 const original=globalThis.document;t.after(()=>{globalThis.document=original;});
 globalThis.document={createElement:()=>new Host()};
 const root=new Host(),drafts={agent:{configuration:{name:'Unsaved draft'},dirty:true}},model={drafts,page:3,filters:{q:'customer'}};
 let reads=0,paused=0,removed=0;
 const apiFetch=async path=>{reads++;return Response.json(path.includes('/calls?')?{calls:[],total:0,totalPages:1}:{agents:[],business:{timeZone:'UTC'}});};
 const dispose=await mountVoiceWorkspace(root,{apiFetch,model,callsOnly:true});
 const oldHost=root.children[0];oldHost.audios=[{pause(){paused++;},removeAttribute(name){assert.equal(name,'src');removed++;},load(){}}];
 assert.equal(retainsMountedTab('voice-agent'),false);assert.equal(retainsMountedTab('call'),false);assert.equal(retainsMountedTab('contacts'),true);
 dispose();assert.equal(paused,1);assert.equal(removed,1);
 const retiredReads=reads;await oldHost.querySelector('[data-refresh]').onclick();assert.equal(reads,retiredReads);
 const disposeNew=await mountVoiceWorkspace(root,{apiFetch,model,callsOnly:true});
 assert.equal(model.drafts,drafts);assert.equal(model.page,3);assert.equal(model.filters.q,'customer');
 const before=reads;await root.children[0].querySelector('[data-refresh]').onclick();assert.equal(reads,before+2);
 disposeNew();
});

test('realtime A to B removes A and ignores late callbacks, timers and session cleanup',async()=>{
 const intervals=new Map(),timeouts=new Map(),removed=[],channels=[];let id=0,changes=0;
 const client={realtime:{setAuth:async()=>{}},removeChannel:async channel=>{removed.push(channel);},channel:name=>{
  const channel={name,events:[],on(_kind,filter,callback){this.events.push({filter,callback});return this;},subscribe(callback){this.status=callback;return this;}};
  channels.push(channel);return channel;
 }};
 const live=createLiveConnection({loadClient:async()=>client,getToken:async()=> 'token',setIntervalFn:fn=>{intervals.set(++id,fn);return id;},clearIntervalFn:key=>intervals.delete(key),setTimeoutFn:fn=>{timeouts.set(++id,fn);return id;},clearTimeoutFn:key=>timeouts.delete(key)});
 const connect=tenant=>live.connect({tenant,onChange:()=>changes++,onStatus:()=>{}});
 await connect('alpha');channels[0].status('SUBSCRIBED');channels[0].events[0].callback();
 await connect('beta');assert.deepEqual(removed,[channels[0]]);assert.equal(timeouts.size,0);
 channels[0].status('CLOSED');channels[0].events[0].callback();assert.equal(intervals.size,1);assert.equal(timeouts.size,0);
 assert.ok(channels[1].events.every(event=>event.filter.filter==='tenant_id=eq.beta'));
 channels[1].status('SUBSCRIBED');channels[1].events[0].callback();[...timeouts.values()][0]();assert.equal(changes,1);
 live.disconnect();channels[1].status('CLOSED');assert.equal(intervals.size,0);assert.equal(timeouts.size,0);assert.equal(removed.length,2);
});

test('leaving while realtime SDK loads cannot create a subscription afterward',async()=>{
 const sdk=deferred();let opened=0;
 const live=createLiveConnection({loadClient:()=>sdk.promise,getToken:async()=>null});
 const pending=live.connect({tenant:'alpha',onChange(){},onStatus(){}});live.disconnect();
 sdk.resolve({channel(){opened++;}});assert.equal(await pending,false);assert.equal(opened,0);
});

test('upload batches use four concurrent requests and stop outstanding work on failure',async()=>{
 const uploads=Array.from({length:6},(_,i)=>({path:`file-${i}`,url:`https://upload.invalid/${i}`,contentType:'text/plain'}));
 const files=uploads.map(x=>({path:x.path,file:'contents'})),requests=[];let active=0,peak=0;
 const pending=uploadFiles(uploads,files,{fetcher:(_url,{signal})=>{active++;peak=Math.max(peak,active);const item=deferred();requests.push({...item,signal});return item.promise.finally(()=>active--);}});
 assert.equal(requests.length,4);requests[0].resolve(new Response());await turn();assert.equal(requests.length,5);
 requests[1].resolve(new Response(null,{status:500}));await assert.rejects(pending,/Upload failed/);
 assert.equal(peak,4);assert.equal(requests.length,5);assert.ok(requests.every(r=>r.signal.aborted));
 for(const request of requests)request.resolve(new Response());
});

test('an unresponsive upload is bounded by the batch deadline',async()=>{
 // Keep this test process alive while AbortSignal.timeout uses its unref timer.
 const keepAlive=setInterval(()=>{},1000);
 try{await assert.rejects(uploadFiles([{path:'index.html',url:'https://upload.invalid'}],[{path:'index.html',file:'site'}],{fetcher:()=>new Promise(()=>{}),timeoutMs:10}),{name:'TimeoutError'});}finally{clearInterval(keepAlive);}
});
