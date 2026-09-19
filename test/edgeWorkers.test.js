import test from 'node:test';
import assert from 'node:assert/strict';
import {createWorkerHandler} from '../supabase/functions/_shared/worker.js';
import {processAi} from '../src/workers/ai.js';
import {processProvisioning} from '../src/workers/provisioning.js';
import {providerPost} from '../src/workers/providerHttp.js';
import {testDatabase,call} from './helpers/database.js';
const secret='test-worker-secret-'.repeat(4);
const request=(token=secret)=>new Request('https://example.com/worker',{method:'POST',headers:{Authorization:`Bearer ${token}`}});

test('Edge worker authenticates before database access and stops at its batch limit',async()=>{
 const calls=[];let runs=0;
 const db={call:async(name)=>{calls.push(name);if(name==='edge_enter')return 'slot';if(name==='claim')return {id:'job',lease_token:'token'};}};
 const handler=createWorkerHandler({queue:'automation_jobs',secret,db,processJob:async()=>{runs++;},maxJobs:3});
 assert.equal((await handler(request('wrong'))).status,401);assert.equal(calls.length,0);
 assert.equal((await handler(request())).status,200);assert.equal(runs,3);assert.equal(calls.at(-1),'edge_exit');
});
test('Edge worker obeys the deadline and never retries an ambiguous SMS in the runner',async()=>{
 const calls=[];let clock=0;
 const db={call:async(name)=>{calls.push(name);if(name==='edge_enter')return 'slot';if(name==='claim')return {id:'job',lease_token:'token'};}};
 const handler=createWorkerHandler({queue:'sms_send_jobs',secret,db,now:()=>clock,budgetMs:10,processJob:async()=>{clock=20;throw new Error('Disconnected');}});
 await handler(request());assert.equal(calls.filter(x=>x==='claim').length,1);assert.ok(!calls.includes('finish'));assert.equal(calls.at(-1),'edge_exit');
});
test('AI refuses the legacy ungrounded drafting path',async()=>{
 let requests=0;const completed=[];
 const db={call:async(name,...args)=>{
  if(name==='job_context')return {settings:{enabled:true,grounded_enabled:false},thread:{generation:7},contact:{},business:{name:'General business'},history:[{direction:'inbound',body:'Hello'}]};
  completed.push([name,...args]);return {status:'cancelled'};
 }};
 await processAi({id:'ai-job',lease_token:'token',payload:{generation:7}},db,{apiKey:'test',fetchImpl:async()=>{requests++;}});
 assert.equal(requests,0);assert.deepEqual(completed[0].slice(0,5),['finish','ai-job','token','cancelled','GROUNDED_AI_DISABLED']);
});
test('grounded AI supplies a valid input when a conversation has no history',async()=>{
 const db={call:async name=>name==='job_context'?{settings:{enabled:true,grounded_enabled:true},thread:{generation:0},contact:{},business:{name:'Test'},profile:{id:'profile',facts:{}},history:[]}:name==='search_job_knowledge'?[]:null};let requests=0;
 await processAi({id:'job',lease_token:'token',payload:{generation:0}},db,{apiKey:'test',fetchImpl:async(url,options)=>{
  requests++;const body=JSON.parse(options.body);if(url.endsWith('/embeddings'))return Response.json({data:[{embedding:Array(1536).fill(0)}]});assert.ok(body.input[0].content.length>0);
  return Response.json({status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify({reply:'How can we help?',disposition:'answered',grounded:true,citationIds:[],lead:{name:null,email:null,service:null,location:null,preferredDate:null,preferredTime:null,notes:null,intent:null},leadSummary:null,handoffReason:null,priority:'normal'})}]}]});
 }});
 assert.equal(requests,2);
});
test('Twilio transport has no hidden retries and malformed success remains uncertain',async()=>{
 let attempts=0;
 await assert.rejects(()=>providerPost('https://api.twilio.com/test','sid','token',{Body:'Hello'},async()=>{attempts++;return new Response('invalid',{status:201});}),{code:'PROVIDER_RESPONSE_UNKNOWN'});
 assert.equal(attempts,1);
});
test('provisioning creates an isolated child account and configures its Messaging Service callbacks',async()=>{
 const calls=[];let accountOptions;let serviceOptions;
 const db={call:async(name,...args)=>{
  calls.push([name,...args]);
  if(name==='provision_credentials') return {state:'pending'};
 }};
 const parentSid='AC'+'1'.repeat(32),childSid='AC'+'2'.repeat(32),serviceSid='MG'+'3'.repeat(32);
 const clientFactory=(sid,token)=>{
  if(sid===childSid) {assert.equal(token,'child-secret');return {messaging:{v1:{services:{create:async input=>{serviceOptions=input;return {sid:serviceSid,accountSid:childSid};}}}}};}
  assert.equal(sid,parentSid);assert.equal(token,'parent-secret');
  return {api:{v2010:{accounts:{create:async input=>{accountOptions=input;return {sid:childSid,authToken:'child-secret',ownerAccountSid:parentSid,friendlyName:input.friendlyName};}}}}};
 };
 await processProvisioning({id:'job',tenant_id:'acme',lease_token:'lease',payload:{name:'Acme Services'}},db,{clientFactory,
  env:{TWILIO_MASTER_ACCOUNT_SID:parentSid,TWILIO_MASTER_AUTH_TOKEN:'parent-secret',SUPABASE_URL:'https://project.supabase.co'}});
 assert.equal(accountOptions.friendlyName,'Acme Services [acme]');
 assert.deepEqual(serviceOptions,{friendlyName:'Acme Services — SMS',inboundRequestUrl:'https://project.supabase.co/functions/v1/twilio-webhook/inbound',
  inboundMethod:'POST',statusCallback:'https://project.supabase.co/functions/v1/twilio-webhook/status',useInboundWebhookOnNumber:false});
 const checkpoints=calls.filter(([name])=>name==='provision_checkpoint').map(([, , ,value])=>value.state);
 assert.deepEqual(checkpoints,['creating_account','account_created','creating_service','awaiting_number']);
 assert.equal(calls.at(-1)[0],'finish');assert.equal(calls.at(-1)[3],'completed');
});
test('provisioning never replays an ambiguous remote creation',async()=>{
 const calls=[];let providerCalls=0;
 const db={call:async(name,...args)=>{calls.push([name,...args]);if(name==='provision_credentials')return {state:'creating_account'};}};
 await processProvisioning({id:'job',tenant_id:'acme',lease_token:'lease',payload:{}},db,{clientFactory:()=>{providerCalls++;},env:{}});
 assert.equal(providerCalls,0);
 assert.equal(calls.at(-1)[3],'submission_unknown');
});
test('database gates Edge concurrency, pauses dispatch and restricts AI tools',async()=>{
 const db=await testDatabase();try {
  assert.equal(await call(db,'edge_enter','sms_send_jobs','one'),null);
  await db.exec("update sms_private.runtime set edge_enabled=true; update sms_private.edge_config set enabled=true,max_concurrency=1 where queue='sms_send_jobs';");
  const slot=await call(db,'edge_enter','sms_send_jobs','one');assert.ok(slot);
  assert.equal(await call(db,'edge_enter','sms_send_jobs','two'),null);
  await call(db,'edge_exit','sms_send_jobs',slot);
  assert.ok(await call(db,'edge_enter','sms_send_jobs','two'));
  assert.equal(await call(db,'dispatch_edge'),0); // Empty queues never invoke a worker.
  await call(db,'api_action','admin',null,'create_business',{id:'dispatch-test',name:'Dispatch test',timeZone:'UTC'});
  for(let i=0;i<3;i++) await call(db,'enqueue','dispatch-test','automation_jobs',`test:${i}`,{});
  await db.exec(`update sms_private.edge_config set enabled=false where queue='provisioning_jobs';
   insert into vault.secrets(id) values('00000000-0000-0000-0000-000000000001');
   insert into vault.decrypted_secrets(id,decrypted_secret) values('00000000-0000-0000-0000-000000000001','test-bearer');
   update sms_private.edge_config set enabled=true,max_concurrency=2,secret_id='00000000-0000-0000-0000-000000000001' where queue='automation_jobs';`);
  assert.equal(await call(db,'dispatch_edge'),2);
  assert.equal(await call(db,'dispatch_edge'),0); // Suppress repeated wakes in the same tick.
  assert.equal((await db.query('select count(*) from net.test_requests')).rows[0].count,2);
  await db.exec('update sms_private.runtime set edge_enabled=false');
  assert.equal(await call(db,'edge_enter','automation_jobs','paused'),null);
  await db.exec("create role scoped_ai login in role sms_ai; set session authorization scoped_ai;");
  await assert.rejects(()=>call(db,'edge_enter','sms_send_jobs','bad'),/Worker role denied/);
  assert.equal((await db.query("select has_function_privilege(current_user,'sms_private.ai_tool(uuid,uuid,text,jsonb,text)','execute') as allowed")).rows[0].allowed,false);
  await db.exec('reset session authorization');
 }finally {await db.close();}
});
test('provisioning recovery uses Vault credentials and rejects foreign account/service ownership',async()=>{
 const parentSid='AC'+'1'.repeat(32),childSid='AC'+'2'.repeat(32);
 const env={TWILIO_MASTER_ACCOUNT_SID:parentSid,TWILIO_MASTER_AUTH_TOKEN:'parent-secret',SUPABASE_URL:'https://project.supabase.co'};
 for(const scenario of ['valid','wrong-account','wrong-service']) {
  const checkpoints=[];let creates=0;
  const db={call:async(name,...args)=>{
   if(name==='provision_credentials')return {state:'account_created',account_sid:childSid,auth_token:'vault-child-token'};
   if(name==='provision_checkpoint')checkpoints.push(args[2]);
  }};
  const clientFactory=(sid,token)=>{
   if(sid===parentSid)return {}; // No new account should be created on recovery.
   assert.equal(sid,childSid);assert.equal(token,'vault-child-token');
   return {
    api:{v2010:{accounts:requested=>({fetch:async()=>{assert.equal(requested,childSid);return {sid:childSid,ownerAccountSid:scenario==='wrong-account'?childSid:parentSid,status:'active'};}})}},
    messaging:{v1:{services:{create:async()=>{creates++;return {sid:'MG'+'3'.repeat(32),accountSid:scenario==='wrong-service'?parentSid:childSid};}}}}
   };
  };
  const run=()=>processProvisioning({id:'job',tenant_id:'acme',lease_token:'lease',payload:{}},db,{clientFactory,env});
  if(scenario==='valid') {
   await run();assert.equal(creates,1);assert.equal(checkpoints.at(-1).state,'awaiting_number');
  }else{
   await assert.rejects(run,{code:scenario==='wrong-account'?'INVALID_SUBACCOUNT_OWNERSHIP':'INVALID_MESSAGING_SERVICE_RESPONSE'});
   assert.equal(creates,scenario==='wrong-account'?0:1);
   assert.ok(checkpoints.every(p=>!p.messaging_service_sid));
  }
 }
});
test('missing provider state fails closed and configured businesses are not reprovisioned',async()=>{
 let providerCalls=0;
 const options={clientFactory:()=>{providerCalls++;},env:{}};
 await assert.rejects(()=>processProvisioning({id:'job',lease_token:'lease'},{call:async()=>null},options),{code:'PROVIDER_RECORD_MISSING'});
 const calls=[];
 await processProvisioning({id:'job',lease_token:'lease'},{call:async(name,...args)=>{calls.push([name,...args]);if(name==='provision_credentials')return {state:'configured'};}},options);
 assert.equal(providerCalls,0);assert.equal(calls.at(-1)[3],'completed');
});
