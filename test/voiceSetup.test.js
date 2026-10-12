import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './helpers/twilioConnections.js';
import {call} from './helpers/database.js';
import {voiceReadiness} from '../public/voiceSetup.js';
import {createCrmHandler} from '../supabase/functions/crm-api/handler.js';
const configuration={name:'Reception',persona:'Friendly',voice:'Greet callers and clarify their request.',brain:'Use reviewed business facts. Escalate unknown questions.',voiceName:'marin'};
const workspace=(db,t,action,p={},user='staff')=>call(db,'voice_workspace',user,t,action,p);
const create=(db,t,id='00000000-0000-4000-8000-000000000001',user='staff')=>workspace(db,t,'create',{requestId:id,configuration},user);

test('create agent is staff-only, tenant scoped and idempotent; drafts cannot become a deployment or customer-visible service',async()=>{
 const {db,business}=await fixture();try{
  const a=await business('create-a'),b=await business('create-b');
  const created=await create(db,a.tenant);assert.equal(created.state,'draft');assert.deepEqual(await create(db,a.tenant),created);
  const data=await workspace(db,a.tenant,'overview'),agent=data.agents[0];
  assert.equal(data.agents.length,1);assert.equal(agent.deployment_id,null);assert.equal(agent.phone,null);assert.equal(agent.published_revision,null);
  assert.equal((await workspace(db,b.tenant,'overview')).agents.length,0);
  assert.equal((await db.query("select count(*)::int n from sms_private.audit where action='voice_agent_created'")).rows[0].n,1);
  await assert.rejects(()=>create(db,b.tenant,undefined,'reader'),/denied|staff|Staff|Admin|admin/);
  await assert.rejects(()=>workspace(db,a.tenant,'create',{requestId:'bad',configuration}),/uuid/);
  await assert.rejects(()=>workspace(db,a.tenant,'create',{requestId:crypto.randomUUID(),configuration:{...configuration,brain:''}}),/Configuration/);
  await workspace(db,a.tenant,'save',{agentId:agent.id,version:1,configuration:{...configuration,name:'New name'}});
  await assert.rejects(()=>workspace(db,a.tenant,'save',{agentId:agent.id,version:1,configuration}),/changed/);
  await assert.rejects(()=>workspace(db,a.tenant,'publish',{agentId:agent.id,version:2}),/Connect a verified deployment/);
  await assert.rejects(()=>call(db,'platform_action','staff','service_add',{tenantId:a.tenant,kind:'voice'}),/Register a voice agent/);
  assert.deepEqual((await db.query('select sms_private.customer_voice_agents($1) data',[a.tenant])).rows[0].data,[]);
  assert.equal((await db.query('select sms_private.customer_voice_ready($1) ready',[a.tenant])).rows[0].ready,false);
 }finally{await db.close();}
});

test('setup resumes an attached unpublished-to-customer agent and catalog names assignment without exposing foreign prompts',async()=>{
 const {db,business}=await fixture();try{
  const a=await business('flow-a'),b=await business('flow-b');
  for(const t of [a.tenant,b.tenant]){
   const created=await create(db,t);await db.query("update sms_private.voice_agents set deployment_id=$2,agent_name='deployed-name',phone='+18775550180' where tenant_id=$1",[t,t]);
   await workspace(db,t,'publish',{agentId:created.agentId,version:1});
  }
  await call(db,'platform_action','staff','service_add',{tenantId:a.tenant,kind:'voice'});
  const data=await call(db,'voice_setup','staff',a.tenant);
  assert.equal(data.service.visibility,'draft');assert.equal(voiceReadiness(data).ready,true);assert.equal(voiceReadiness(data).live,false);
  assert.equal(data.deployments.length,2);assert.equal(data.deployments.filter(d=>d.attached).length,1);
  assert.equal(data.agents.length,1);assert.equal(JSON.stringify(data.deployments).includes('Escalate'),false);
  await assert.rejects(()=>call(db,'voice_setup','reader',a.tenant),/Staff access/);
  for(const role of ['anon','authenticated','service_role']) assert.equal((await db.query("select has_function_privilege($1,'sms_private.voice_setup(text,text)','execute') allowed",[role])).rows[0].allowed,false);
  assert.equal((await db.query("select has_function_privilege('sms_api','sms_private.voice_workspace_before_creation(text,text,text,jsonb)','execute') allowed")).rows[0].allowed,false);
  await call(db,'platform_action','staff','service_visibility',{tenantId:a.tenant,serviceId:data.service.id,revision:data.service.revision,visibility:'live'});
  assert.equal(voiceReadiness(await call(db,'voice_setup','staff',a.tenant)).live,true);
  await create(db,a.tenant,'00000000-0000-4000-8000-000000000002');
  assert.equal((await workspace(db,a.tenant,'overview')).agents.length,2);
  assert.equal((await db.query('select sms_private.customer_voice_agents($1) data',[a.tenant])).rows[0].data.length,1);
  await assert.rejects(()=>call(db,'platform_action','staff','service_visibility',{tenantId:a.tenant,serviceId:data.service.id,revision:data.service.revision,visibility:'draft'}),/changed/);
 }finally{await db.close();}
});

test('release readiness requires all prerequisites; API pins the actor and supports create without trusting deployment fields',async()=>{
 const base={ownerReady:true,business:{reviewed:true},agents:[{deployment_id:'deployment',phone:'+18775550180',published_revision:'revision'}]};
 assert.equal(voiceReadiness(base).ready,true);
 for(const input of [{...base,ownerReady:false},{...base,business:{reviewed:false}},{...base,agents:[{phone:'+18775550180'}]}])assert.equal(voiceReadiness(input).ready,false);
 const calls=[],handler=createCrmHandler({call:async(...args)=>{calls.push(args);return {};}},async()=> 'verified-staff');
 assert.equal((await handler(new Request('https://test/api/platform/voice-setup?tenantId=business&user=forged'))).status,200);
 assert.deepEqual(calls[0],['voice_setup','verified-staff','business']);
 const payload={configuration,requestId:crypto.randomUUID(),user:'forged',deployment_id:'not-used'};
 assert.equal((await handler(new Request('https://test/api/voice/create',{method:'POST',headers:{'X-Tenant-ID':'business'},body:JSON.stringify(payload)}))).status,200);
 assert.deepEqual(calls[1],['voice_workspace','verified-staff','business','create',payload]);
 assert.equal((await handler(new Request('https://test/api/voice/create',{headers:{'X-Tenant-ID':'business'}}))).status,405);
});
