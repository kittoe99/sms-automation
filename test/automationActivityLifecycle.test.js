import test from 'node:test';
import assert from 'node:assert/strict';
import {mountAutomationActivity} from '../public/automationActivity.js';
// A minimal host for testing async lifetime, not layout. Browser checks cover DOM/UI.
class Host {
 nodes=new Map();html='';textContent='';
 set innerHTML(value){this.html=value;this.nodes.clear();}get innerHTML(){return this.html;}
 querySelector(key){if(!this.nodes.has(key))this.nodes.set(key,new Host());return this.nodes.get(key);}
 querySelectorAll(){return [];}setAttribute(){}removeAttribute(){}contains(){return false;}
}
const fixture=()=>({reportingAt:new Date().toISOString(),timeZone:'UTC',from:'2026-09-11',to:'2026-10-10',forms:[],tags:[],rows:[],total:0,pageSize:25,canManage:false,
 activity:{accepted:0,delivered:0,responses:0,aiSent:0},outcomes:{linkedBookings:0,handoffs:0},funnel:{contacted:0,responded:0,booked:0,cancelled:0,responseRate:null,conversionRate:null},workload:{active:0,quiet:0,paused:0,aiPaused:0,unresolvedHandoffs:0},definitions:{cohort:'cohort',conversion:'conversion',activity:'activity',workload:'workload'}});
test('late business/user reads cannot repaint; refresh cancels its predecessor and failures stay visible',async()=>{
 const originalDocument=globalThis.document,originalStorage=globalThis.sessionStorage;
 globalThis.document={hidden:false,activeElement:null};globalThis.sessionStorage={getItem:()=>null,setItem(){}};
 const root=new Host();let resolveOld,oldActive=true;
 const oldMount=mountAutomationActivity(root,{identity:'user-a:business-a',isCurrent:()=>oldActive,apiFetch:()=>new Promise(r=>resolveOld=r)});
 oldActive=false;
 let count=0,resolveSlow,slowSignal;
 const disposeNew=await mountAutomationActivity(root,{identity:'user-b:business-b',isCurrent:()=>true,apiFetch:async(path,options)=>{
  count++;if(count===2){slowSignal=options.signal;return new Promise(r=>resolveSlow=r);}
  if(count===4)return new Response(JSON.stringify({error:'Temporary reporting failure'}),{status:503});
  return new Response(JSON.stringify({...fixture(),definitions:{...fixture().definitions,cohort:'CURRENT BUSINESS'}}));
 }});
 try{
  resolveOld(new Response(JSON.stringify({...fixture(),definitions:{...fixture().definitions,cohort:'WRONG BUSINESS'}})));
  const disposeOld=await oldMount;disposeOld();assert.match(root.querySelector('[data-content]').innerHTML,/CURRENT BUSINESS/);assert.doesNotMatch(root.querySelector('[data-content]').innerHTML,/WRONG BUSINESS/);
  const slow=root.querySelector('[data-refresh]').onclick();await root.querySelector('[data-refresh]').onclick();assert.equal(slowSignal.aborted,true);
  resolveSlow(new Response(JSON.stringify({...fixture(),definitions:{...fixture().definitions,cohort:'STALE REFRESH'}})));await slow;
  assert.doesNotMatch(root.querySelector('[data-content]').innerHTML,/STALE REFRESH/);
  await root.querySelector('[data-refresh]').onclick();assert.equal(root.querySelector('[data-error]').textContent,'Temporary reporting failure');
 }finally{disposeNew();globalThis.document=originalDocument;globalThis.sessionStorage=originalStorage;}
});
