import test from 'node:test';
import assert from 'node:assert/strict';
import {z} from 'zod';
import {fixture} from './helpers/twilioConnections.js';
import {call} from './helpers/database.js';
import {toolOutputs,toolDefinitions} from '../src/mcp/tools.js';
import {mountBusinessSetup} from '../public/businessSetup.js';

const managed=[['search_ads','Google Search Ads'],['seo','SEO'],['facebook_ads','Facebook Ads']];

test('MCP adds staff-managed marketing services as draft rows that need explicit release',async()=>{
 const {db,business}=await fixture();
 try {
  const a=(await business('marketing-owner')).tenant;
  const invoke=async(tool,p={})=>{const r=(await db.query('select crm_mcp.invoke($1,$2,$3,$4,$5) r',['staff','marketing-client',tool,JSON.stringify(p),crypto.randomUUID()])).rows[0].r;if(r.ok)toolOutputs[tool].parse(r.data);return r;};
  const cid=(await invoke('crm_get_access')).data.connectionId;
  await call(db,'mcp_admin','staff','save',{connectionId:cid,revision:0,status:'active',permissions:['service_add','visibility','read'],businessIds:[a],allBusinesses:false});
  for(const [kind] of managed){
   const added=await invoke('crm_add_business_service',{businessId:a,kind,idempotencyKey:crypto.randomUUID()});
   assert.equal(added.ok,true,JSON.stringify(added));
   assert.equal(added.data.record.kind,kind);assert.equal(added.data.record.visibility,'draft');assert.equal(added.data.providerSetup,null);
   const live=await invoke('crm_set_service_visibility',{businessId:a,serviceId:added.data.record.id,revision:0,visibility:'live',idempotencyKey:crypto.randomUUID()});
   assert.equal(live.ok,true,JSON.stringify(live));assert.equal(live.data.record.visibility,'live');
  }
  const services=(await invoke('crm_get_business',{businessId:a})).data.business.services;
  for(const [kind] of managed)assert.equal(services.some(s=>s.kind===kind&&s.visibility==='live'),true);
  assert.equal((await invoke('crm_add_business_service',{businessId:a,kind:'tiktok_ads',idempotencyKey:crypto.randomUUID()})).ok,false);
 } finally {await db.close();}
});

test('MCP schema accepts only the known managed marketing kinds',()=>{
 const input=z.object(toolDefinitions.find(t=>t[0]==='crm_add_business_service')[2]).strict();
 for(const [kind] of managed)assert.equal(input.safeParse({businessId:'test',kind,idempotencyKey:crypto.randomUUID()}).success,true);
 assert.equal(input.safeParse({businessId:'test',kind:'google_ads',idempotencyKey:crypto.randomUUID()}).success,false);
});

function element(){
 const events=new Map();
 return {events,dataset:{},elements:{businessInfo:{value:''}},disabled:false,textContent:'',innerHTML:'',addEventListener(type,fn){events.set(type,fn);},querySelector:()=>element(),querySelectorAll:()=>[],scrollIntoView(){}};
}
function render(services){
 const writes=[];let html='';
 const buttons=new Map();
 const container={set innerHTML(value){html=value;},get innerHTML(){return html;},
  querySelector:()=>element(),
  querySelectorAll(selector){
   if(selector!=='[data-add]')return [];
   return [...html.matchAll(/data-add="([^"]+)"/g)].map(([,kind])=>{const b=element();b.dataset.add=kind;buttons.set(kind,b);return b;});
  }};
 const row={tenant_id:'tenant-1',setup:{revision:1,reviewed_profile_id:'profile',reviewed_at:'2026-11-07T00:00:00Z',draft:{}},services};
 const noop=async()=>{};
 mountBusinessSetup(container,row,{read:async()=>({}),write:async(path,body)=>{writes.push([path,body]);},reload:noop,onCreateWebsite:noop,onWebsite:noop,onWorkspace:noop,lookup:noop});
 return {html,buttons,writes};
}

test('staff business setup offers managed marketing services and labels them without a workspace link',async()=>{
 const empty=render([]);
 for(const [kind,label] of managed)assert.match(empty.html,new RegExp(`data-add="${kind}"[^>]*>Add ${label}</button>`));
 empty.buttons.get('seo').events.get('click')();
 await new Promise(r=>setTimeout(r,0));
 assert.deepEqual(empty.writes,[['services',{tenantId:'tenant-1',kind:'seo'}]]);
 const added=render([{id:'s1',kind:'search_ads',visibility:'draft',revision:0}]);
 assert.match(added.html,/<h4>Google Search Ads<\/h4>/);
 assert.match(added.html,/Managed by E2 Local staff/);
 assert.doesNotMatch(added.html,/data-configure="search_ads"|data-add="search_ads"/);
});
