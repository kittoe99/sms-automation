import test from 'node:test';
import assert from 'node:assert/strict';
import { testDatabase,call } from './helpers/database.js';
import { processSms,classifySubmissionError } from '../src/workers/sms.js';
import { calendarDelay } from '../src/workers/automation.js';
import {createCrmHandler} from '../supabase/functions/crm-api/handler.js';
import {createTwilioHandler,twilioSignature} from '../supabase/functions/twilio-webhook/handler.js';
import {readFile,readdir} from 'node:fs/promises';

test('migration preserves website data and isolates queue submissions',async()=>{
 const db=await testDatabase();
 try {
  assert.equal((await db.query('select count(*) from public.contacts')).rows[0].count,1);
  for(const t of ['alpha','beta']) {
   await call(db,'api_action','admin',null,'create_business',{id:t,name:t,timeZone:'America/Denver'});
   await call(db,'api_action','admin',t,'contact',{phone:'+13035551234',name:t});
  }
  const bootstrap=(await db.query("select tenant_id,dedupe_key,status from sms_private.jobs where queue='provisioning_jobs' order by tenant_id")).rows;
  assert.deepEqual(bootstrap.map(job=>[job.tenant_id,job.dedupe_key,job.status]),[
    ['alpha','twilio-bootstrap:v1','queued'],['beta','twilio-bootstrap:v1','queued']
  ]);
  const setup=await call(db,'save_provider_setup','admin','alpha',{
   senderType:'local_a2p',brandType:'standard',areaCode:'720',legalBusinessName:'Alpha LLC',notificationEmail:'owner@example.com',
   websiteUrl:'https://example.com',campaignDescription:'We send requested appointment confirmations and customer service follow-ups.',
   optInDescription:'Customers opt in through a clearly labeled website form before receiving any messages.',
   sampleMessages:['Thanks for contacting Alpha LLC. Reply STOP to opt out.','Your appointment is confirmed for tomorrow. Reply HELP for help.']
  });
  assert.equal(setup.detailsComplete,true);assert.equal(setup.details.areaCode,'720');
  await assert.rejects(()=>call(db,'save_provider_setup','admin','alpha',{senderType:'local_a2p'}),/brand type|business name/i);
  await assert.rejects(()=>call(db,'api_read','stranger','alpha','contacts',{}),/Admin access required/);
  const alpha=await call(db,'api_read','admin','alpha','contacts',{});
  assert.equal(alpha.rows.length,1); assert.equal(alpha.rows[0].name,'alpha');
  await db.exec(`update public.sms_businesses set sending_enabled=true,status='active' where tenant_id='alpha';`);
  const payload={phone:'+13035551234',body:'Test',purpose:'transactional',idempotencyKey:'one'};
  const one=await call(db,'api_action','admin','alpha','send',payload);
  const two=await call(db,'api_action','admin','alpha','send',payload);
  assert.equal(one.jobId,two.jobId);
  await assert.rejects(()=>call(db,'api_action','admin','alpha','send',{...payload,body:'different'}),/conflicts/);
  const job=await call(db,'claim','sms_send_jobs','worker');
  assert.equal(job.id,one.jobId);
  await assert.rejects(()=>call(db,'begin_submission',job.id,'00000000-0000-0000-0000-000000000000'),/Lease lost/);
  await call(db,'api_action','admin','alpha','consent',{phone:payload.phone,consent:false,evidence:'User requested STOP'});
  assert.equal((await db.query('select status from sms_private.jobs where id=$1',[one.jobId])).rows[0].status,'cancelled');
 } finally {await db.close();}
});

test('Twilio acceptance followed by database failure is never submitted again',async()=>{
 let sends=0; const calls=[];
 const db={call:async(name,...args)=>{calls.push(name); if(name==='begin_submission') return {attempt_id:'attempt',account_sid:'sid',auth_token:'secret',from_number:'+13035550000',phone:'+13035551234',body:'Hello'}; if(name==='accept_submission') throw Object.assign(new Error('offline'),{code:'DB_OFFLINE'});}};
 await processSms({id:'job',lease_token:'token'},db,{callbackBase:'https://example.com/status',clientFactory:()=>({messages:{create:async()=>{sends++;return {sid:'SM123'};}}})});
 assert.equal(sends,1); assert.deepEqual(calls,['begin_submission','accept_submission']);
 assert.equal(classifySubmissionError({status:429}),'retry'); assert.equal(classifySubmissionError({status:400}),'failed');
 assert.equal(classifySubmissionError({status:500}),'submission_unknown'); assert.equal(classifySubmissionError({code:'ETIMEDOUT'}),'submission_unknown');
});
test('calendar schedules preserve local time through DST and clamp month ends',()=>{
 assert.equal(calendarDelay('2026-03-07T16:00:00Z',1,'day','America/Denver').toISOString(),'2026-03-08T15:00:00.000Z');
 assert.equal(calendarDelay('2026-01-31T16:00:00Z',1,'month','America/Denver').toISOString(),'2026-02-28T16:00:00.000Z');
});

async function activeBusiness(db,t='alpha') {
 const accountSid=`AC${(t==='alpha'?'a':'b').repeat(32)}`;
 await call(db,'api_action','admin',null,'create_business',{id:t,name:t,timeZone:'UTC'});
 await call(db,'api_action','admin',t,'contact',{phone:'+13035551234',name:'Alex'});
 await db.exec(`update public.sms_businesses set sending_enabled=true,status='active' where tenant_id='${t}';
 update sms_private.providers set account_sid='${accountSid}',from_number='+13035550000',auth_secret_id=vault.create_secret('test-secret') where tenant_id='${t}';`);
}
test('expired submissions are held and a signed callback reconciles the exact attempt',async()=>{
 const db=await testDatabase();try {
  await activeBusiness(db);
  const sent=await call(db,'api_action','admin','alpha','send',{phone:'+13035551234',body:'Hello',purpose:'transactional',idempotencyKey:'crash'});
  const job=await call(db,'claim','sms_send_jobs','sms');
  const submission=await call(db,'begin_submission',job.id,job.lease_token);
  await db.query("update sms_private.jobs set leased_until=now()-interval '1 second' where id=$1",[job.id]);
  await call(db,'tick');
  assert.equal((await db.query('select status from sms_private.jobs where id=$1',[job.id])).rows[0].status,'submission_unknown');
  assert.equal(await call(db,'claim','sms_send_jobs','another'),null);
  await call(db,'record_webhook','alpha','status',{MessageSid:'SM_exact',MessageStatus:'delivered',attempt_id:submission.attempt_id});
  await call(db,'record_webhook','alpha','status',{MessageSid:'SM_exact',MessageStatus:'sent',attempt_id:submission.attempt_id});
  const message=(await db.query('select * from public.sms_messages where id=$1',[sent.messageId])).rows[0];
  assert.equal(message.status,'delivered');assert.equal(message.sid,'SM_exact');
  assert.equal((await db.query('select status from sms_private.jobs where id=$1',[job.id])).rows[0].status,'completed');
  await assert.rejects(()=>call(db,'api_action','admin','alpha','retry_job',{id:job.id}));
 }finally{await db.close();}
});

test('automation, AI replies and enrollment cancellation share fenced outbox behavior',async()=>{
 const db=await testDatabase();try {
  await activeBusiness(db);
  await call(db,'api_action','admin','alpha','consent',{phone:'+13035551234',consent:true,evidence:'Test opt-in'});
  await call(db,'api_action','admin','alpha','group',{id:'followup',name:'Follow-up',rule:{startHour:0,endHour:24,steps:[{template:'Hello',delayCount:0,delayUnit:'day'}]}});
  const enrollment=await call(db,'api_action','admin','alpha','enroll',{phone:'+13035551234',categoryId:'followup'});
  await db.exec('update sms_private.runtime set scheduler_enabled=true');
  assert.equal(await call(db,'tick'),1);assert.equal(await call(db,'tick'),0);
  const job=await call(db,'claim','automation_jobs','automation');
  const context=await call(db,'job_context',job.id,job.lease_token);
  const {evaluateAutomation}=await import('../src/workers/automation.js');
  const send=await call(db,'complete_automation',job.id,job.lease_token,evaluateAutomation(context));
  assert.ok(send.messageId);
  const sms=await call(db,'claim','sms_send_jobs','sms');
  await call(db,'api_action','admin','alpha','unenroll',{phone:'+13035551234',categoryId:'followup'});
  assert.equal(await call(db,'begin_submission',sms.id,sms.lease_token),null);
  assert.equal((await db.query('select status from sms_private.jobs where id=$1',[sms.id])).rows[0].status,'cancelled');
  await call(db,'api_action','admin','alpha','enroll',{phone:'+13035551234',categoryId:'followup'});
  await call(db,'api_action','admin','alpha','ai_settings',{id:'followup',enabled:true,instructions:'Be helpful'});
  await call(db,'record_webhook','alpha','inbound',{From:'+13035551234',MessageSid:'SM_in1',Body:'Question'});
  const ai=await call(db,'claim','ai_reply_jobs','ai');assert.ok(ai);
  await call(db,'record_webhook','alpha','inbound',{From:'+13035551234',MessageSid:'SM_in2',Body:'Updated question'});
  assert.equal(await call(db,'complete_ai',ai.id,ai.lease_token,'Stale answer'),null);
  const next=await call(db,'claim','ai_reply_jobs','ai');
  const answer=await call(db,'complete_ai',next.id,next.lease_token,'Current answer');assert.ok(answer.messageId);
  const duplicate=await call(db,'record_webhook','alpha','inbound',{From:'+13035551234',MessageSid:'SM_in2',Body:'Updated question'});
  assert.equal(duplicate.duplicate,true);
  await call(db,'record_webhook','alpha','inbound',{From:'+13035551234',MessageSid:'SM_stop',Body:'STOP'});
  assert.equal((await db.query('select status from sms_private.jobs where id=$1',[answer.jobId])).rows[0].status,'cancelled');
 }finally{await db.close();}
});

test('default inbound AI replies do not require an automation enrollment',async()=>{
 const db=await testDatabase();try {
  await activeBusiness(db);
  await call(db,'api_action','admin','alpha','group',{id:'inbound',name:'Inbound AI',rule:{startHour:0,endHour:24,steps:[{template:'Unused',delayCount:1,delayUnit:'day'}]}});
  const setting=await call(db,'configure_ai','admin','alpha','inbound',true,'Reply briefly',true);
  assert.equal(setting.default_for_inbound,true);
  await call(db,'record_webhook','alpha','inbound',{From:'+13035551234',MessageSid:'SM_default_ai',Body:'Can you help?'});
  const ai=await call(db,'claim','ai_reply_jobs','ai');
  assert.equal(ai.payload.group_id,'inbound');
  await call(db,'finish',ai.id,ai.lease_token,'completed',null,0);
  await call(db,'api_action','admin','alpha','pause',{phone:'+13035551234'});
  await call(db,'record_webhook','alpha','inbound',{From:'+13035551234',MessageSid:'SM_paused_ai',Body:'Anyone there?'});
  assert.equal(await call(db,'claim','ai_reply_jobs','ai'),null);
 }finally{await db.close();}
});

test('late failure callbacks preserve delivered status and the active next step',async()=>{
 const db=await testDatabase();try {
  await activeBusiness(db);
  await call(db,'api_action','admin','alpha','consent',{phone:'+13035551234',consent:true,evidence:'Test opt-in'});
  await call(db,'api_action','admin','alpha','group',{id:'sequence',name:'Sequence',rule:{startHour:0,endHour:24,steps:[{template:'First',delayCount:0,delayUnit:'day'},{template:'Second',delayCount:1,delayUnit:'day'}]}});
  await call(db,'api_action','admin','alpha','enroll',{phone:'+13035551234',categoryId:'sequence'});
  await db.exec('update sms_private.runtime set scheduler_enabled=true');
  await call(db,'tick');
  const automation=await call(db,'claim','automation_jobs','automation');
  const context=await call(db,'job_context',automation.id,automation.lease_token);
  const {evaluateAutomation}=await import('../src/workers/automation.js');
  const outbox=await call(db,'complete_automation',automation.id,automation.lease_token,evaluateAutomation(context));
  const sms=await call(db,'claim','sms_send_jobs','sms');
  const submission=await call(db,'begin_submission',sms.id,sms.lease_token);
  for(const status of ['delivered','failed']) await call(db,'record_webhook','alpha','status',{MessageSid:'SM_ordered',MessageStatus:status,attempt_id:submission.attempt_id});
  assert.equal((await db.query('select status from public.sms_messages where id=$1',[outbox.messageId])).rows[0].status,'delivered');
  const enrollment=(await db.query("select status,step_index from public.sms_automation_enrollments where category_id='sequence'")).rows[0];
  assert.equal(enrollment.status,'active');assert.equal(enrollment.step_index,1);
  assert.equal((await db.query('select count(*) from public.sms_message_events where message_id=$1',[outbox.messageId])).rows[0].count,2);
 }finally{await db.close();}
});

test('RLS and scoped worker grants prevent cross-business and cross-queue access',async()=>{
 const db=await testDatabase();try {
  await activeBusiness(db);await activeBusiness(db,'beta');
  await db.exec(`insert into public.sms_business_memberships values('alpha','viewer','viewer'); set role authenticated; select set_config('request.jwt.claims','{"sub":"viewer"}',false);`);
  assert.equal((await db.query('select * from public.sms_contacts')).rows.length,1);
  await assert.rejects(()=>db.query('select * from sms_private.providers'),/permission denied/);
  await assert.rejects(()=>call(db,'claim','sms_send_jobs','bad'),/permission denied/);
  await assert.rejects(()=>db.query("select public.sms_crm_enroll_contact('beta','{}')"),/Admin access required/);
  await db.exec('reset role; create role test_ai login in role sms_ai; set session authorization test_ai;');
  await assert.rejects(()=>call(db,'claim','sms_send_jobs','bad'),/Worker role denied/);
  await db.exec('reset session authorization');
 }finally{await db.close();}
});

test('Edge routes authenticate and queue requests; Twilio signatures use the exact callback URL',async()=>{
 process.env.CRM_ALLOWED_ORIGINS='https://crm.example.com';
 const db=await testDatabase();try {
  await activeBusiness(db);
  const adapter={call:(name,...args)=>call(db,name,...args)};
  const handler=createCrmHandler(adapter,async()=> 'admin');
  const request=()=>new Request('https://example.com/functions/v1/crm-api/conversations/%2B13035551234/reply',{method:'POST',headers:{Origin:'https://crm.example.com','X-Tenant-ID':'alpha','Idempotency-Key':'browser-send','Content-Type':'application/json'},body:JSON.stringify({body:'Hello'})});
  const a=await handler(request()),b=await handler(request());
  assert.equal(a.status,202);assert.equal((await a.json()).jobId,(await b.json()).jobId);
  const denied=createCrmHandler(adapter,async()=>{throw Object.assign(new Error('Invalid session'),{status:401});});
  assert.equal((await denied(request())).status,401);
  const base='https://example.com/functions/v1/twilio-webhook',params={AccountSid:`AC${'a'.repeat(32)}`,From:'+13035551234',To:'+13035550000',MessageSid:'SM_webhook',Body:'Hi'};
  const hook=createTwilioHandler(adapter,base);
  const signature=await twilioSignature('test-secret',base+'/inbound',params);
  const make=signature=>new Request(base+'/inbound',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded','X-Twilio-Signature':signature},body:new URLSearchParams(params)});
  assert.equal((await hook(make('wrong'))).status,403);
  assert.equal((await hook(make(signature))).status,200);
  assert.equal((await hook(make(signature))).status,200);
  assert.equal((await db.query("select count(*) from public.sms_messages where sid='SM_webhook'")).rows[0].count,1);
 }finally{await db.close();delete process.env.CRM_ALLOWED_ORIGINS;}
});

test('only the SMS worker contains Twilio message submission code',async()=>{
 async function files(dir){const entries=await readdir(dir,{withFileTypes:true});return (await Promise.all(entries.map(e=>e.isDirectory()?files(`${dir}/${e.name}`):`${dir}/${e.name}`))).flat();}
 const root=new URL('../',import.meta.url).pathname.replace(/^\/([A-Za-z]:)/,'$1');
 const paths=[...await files(root+'src'),...await files(root+'supabase/functions')];
 const senders=[];
 for(const path of paths.filter(p=>/\.[jt]s$/.test(p))) if(/\.messages\.create\(/.test(await readFile(path,'utf8'))) senders.push(path.replace(root,''));
 assert.deepEqual(senders,['src/workers/sms.js']);
});
