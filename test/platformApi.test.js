import test from 'node:test';
import assert from 'node:assert/strict';
import {createCrmHandler} from '../supabase/functions/crm-api/handler.js';
process.env.CRM_ALLOWED_ORIGINS='https://crm.example.test';
function setup(){const calls=[];const handler=createCrmHandler({call:async(...args)=>{calls.push(args);return {rows:[],total:0};}},async()=> 'verified-subject');return {calls,handler};}
test('global directories need no tenant and preserve the verified actor',async()=>{
 const x=setup();for(const resource of ['accounts','businesses','websites']){
  const result=await x.handler(new Request(`https://api.example.test/crm-api/platform/${resource}?page=2&pageSize=25&q=test`,{headers:{Origin:'https://crm.example.test'}}));
  assert.equal(result.status,200);assert.deepEqual(x.calls.at(-1),['platform_read','verified-subject',resource,{page:'2',pageSize:'25',q:'test'}]);
 }
});
test('staff mutations cannot override the authenticated actor with submitted identity',async()=>{
 const x=setup();const result=await x.handler(new Request('https://api.example.test/crm-api/platform/ownership',{method:'POST',headers:{Origin:'https://crm.example.test','Content-Type':'application/json','X-Tenant-ID':'irrelevant'},body:JSON.stringify({user:'forged',tenantId:'alpha',accountId:'target',revision:-1,previousOwnerId:null})}));
 assert.equal(result.status,200);assert.equal(x.calls[0][0],'platform_action');assert.equal(x.calls[0][1],'verified-subject');assert.equal(x.calls[0][2],'owner');
});
test('global routes reject unauthenticated requests and unknown actions',async()=>{
 const x=setup();assert.equal((await x.handler(new Request('https://api.example.test/crm-api/platform/unknown'))).status,404);
 const denied=createCrmHandler({call(){throw new Error('Database must not run');}},async()=>{throw Object.assign(new Error('Sign in'),{status:401});});
 assert.equal((await denied(new Request('https://api.example.test/crm-api/platform/accounts'))).status,401);
});

test('forms-only operators receive an authorized selector without an SMS-read grant',async()=>{
 const db={call:async(name)=>{assert.equal(name,'platform_session');return {platformStaff:false,workspaces:[{tenant_id:'alpha',name:'Alpha',time_zone:'America/Denver',smsRead:false,formsManage:true}]};}};
 const handler=createCrmHandler(db,async()=> 'verified-subject',{platform:true,provision:async()=>{}});
 const response=await handler(new Request('https://api.example.test/crm-api/auth/me'));
 assert.equal(response.status,200);const data=await response.json();
 assert.equal(data.tenants.length,1);assert.equal(data.tenants[0].id,'alpha');
 assert.equal(data.tenants[0].smsRead,false);assert.equal(data.tenants[0].formsManage,true);
});

test('business setup actions preserve verified actor and reject ownerless creation',async()=>{
 const x=setup();
 const old=await x.handler(new Request('https://api.example.test/crm-api/businesses',{method:'POST',body:JSON.stringify({name:'Ownerless'})}));
 assert.equal(old.status,400);assert.equal(x.calls.length,0);
 for(const [path,action] of [['business-register','business_register'],['business-profile/draft','business_profile_draft'],['business-profile/review','business_profile_review'],['services','service_add'],['services/visibility','service_visibility']]){
   const payload={accountId:'customer',tenantId:'registered',revision:2,user:'forged'};
   const response=await x.handler(new Request(`https://api.example.test/crm-api/platform/${path}`,{method:'POST',body:JSON.stringify(payload)}));
   assert.equal(response.status,200);assert.deepEqual(x.calls.at(-1),['platform_action','verified-subject',action,payload]);
 }
});
