import test from 'node:test';
import assert from 'node:assert/strict';
import {mountBusinessSetup} from '../public/businessSetup.js';

// Customer service requests come from the E2 dashboard (E2-owned migration
// 20261109200000_customer_service_requests.sql); staff review them here.
function element(){
 const events=new Map();
 return {events,dataset:{},elements:{businessInfo:{value:''}},disabled:false,textContent:'',innerHTML:'',addEventListener(type,fn){events.set(type,fn);},querySelector:()=>element(),querySelectorAll:()=>[],scrollIntoView(){}};
}
function render(services,serviceRequests){
 const writes=[];let html='';
 const buttons=new Map();
 const container={set innerHTML(value){html=value;},get innerHTML(){return html;},
  querySelector:()=>element(),
  querySelectorAll(selector){
   if(selector!=='[data-decline-request]')return [];
   return [...html.matchAll(/data-decline-request="([^"]+)"/g)].map(([,id])=>{const b=element();b.dataset.declineRequest=id;buttons.set(id,b);return b;});
  }};
 const row={tenant_id:'tenant-1',setup:{revision:1,reviewed_profile_id:'profile',reviewed_at:'2026-11-07T00:00:00Z',draft:{}},services,serviceRequests};
 const noop=async()=>{};
 mountBusinessSetup(container,row,{read:async()=>({}),write:async(path,body)=>{writes.push([path,body]);},reload:noop,onCreateWebsite:noop,onWebsite:noop,onWorkspace:noop,lookup:noop});
 return {html,buttons,writes};
}

test('staff business setup lists customer service requests and marks the matching Add button',async()=>{
 const view=render([],[{id:'r1',kind:'seo',requestedAt:'2026-11-09T10:00:00Z',requestedBy:'owner@example.test'},{id:'r2',kind:'website',requestedAt:'2026-11-09T11:00:00Z',requestedBy:'<b>x</b>'}]);
 assert.match(view.html,/<h4>Customer requests<\/h4>/);
 assert.match(view.html,/<strong>SEO<\/strong> · requested [^<]* by owner@example\.test/);
 assert.match(view.html,/<strong>Website<\/strong>/);
 assert.match(view.html,/by &lt;b&gt;x&lt;\/b&gt;/,'requester text is escaped');
 assert.match(view.html,/data-add="seo"[^>]*>Add SEO · requested<\/button>/);
 assert.match(view.html,/data-add="facebook_ads"[^>]*>Add Facebook Ads<\/button>/);
 view.buttons.get('r1').events.get('click')();
 await new Promise(r=>setTimeout(r,0));
 assert.deepEqual(view.writes,[['service-requests/decline',{tenantId:'tenant-1',requestId:'r1'}]]);
});

test('a request for an already-added service explains that setting it live completes it',()=>{
 const view=render([{id:'s1',kind:'seo',visibility:'draft',revision:0}],[{id:'r1',kind:'seo',requestedAt:'2026-11-09T10:00:00Z'}]);
 assert.match(view.html,/Setting it live below completes this request/);
});

test('no requests panel when there are none',()=>{
 assert.doesNotMatch(render([],[]).html,/Customer requests/);
 assert.doesNotMatch(render([],undefined).html,/Customer requests|· requested/);
});
