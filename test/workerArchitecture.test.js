import test from 'node:test';
import assert from 'node:assert/strict';
import { testDatabase,call } from './helpers/database.js';
import { processSms,classifySubmissionError,estimateSmsSegments } from '../src/workers/sms.js';
import { calendarDelay } from '../src/workers/automation.js';
import {createCrmHandler} from '../supabase/functions/crm-api/handler.js';
import {createTwilioHandler,twilioSignature} from '../supabase/functions/twilio-webhook/handler.js';
import {readFile,readdir} from 'node:fs/promises';

const simpleRule={anchor:'enrollment',firstDelayCount:0,firstDelayUnit:'day',intervalCount:1,
 intervalUnit:'day',repeatCount:1,leadHours:null,startHour:0,endHour:24};
const groupInput=(id,intent,overrides={})=>({id,name:id,intent,
 systemPrompt:'Write one clear, relevant SMS that advances this group purpose.',
 businessContext:'Alpha provides customer services and answers questions by text.',
 rule:{...simpleRule,...overrides}});

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
 assert.equal(sends,1); assert.deepEqual(calls,['begin_submission','record_sms_estimate','accept_submission']);
 assert.equal(classifySubmissionError({status:429}),'retry'); assert.equal(classifySubmissionError({status:400}),'failed');
 assert.equal(classifySubmissionError({status:500}),'submission_unknown'); assert.equal(classifySubmissionError({code:'ETIMEDOUT'}),'submission_unknown');
});
test('SMS segment accounting handles GSM extensions and Unicode',()=>{
 assert.equal(estimateSmsSegments('Hello'),1);
 assert.equal(estimateSmsSegments('^'.repeat(81)),2);
 assert.equal(estimateSmsSegments('🙂'.repeat(36)),2);
});
test('calendar schedules preserve local time through DST and clamp month ends',()=>{
 assert.equal(calendarDelay('2026-03-07T16:00:00Z',1,'day','America/Denver').toISOString(),'2026-03-08T15:00:00.000Z');
 assert.equal(calendarDelay('2026-01-31T16:00:00Z',1,'month','America/Denver').toISOString(),'2026-02-28T16:00:00.000Z');
});

test('database reminder scheduling supports configurable sends before the appointment',async()=>{
 const db=await testDatabase();try{
  const rule={anchor:'appointment',firstDelayCount:0,firstDelayUnit:'day',intervalCount:6,
   intervalUnit:'hour',repeatCount:3,leadHours:24,startHour:0,endHour:24};
  await db.exec("insert into public.sms_businesses(tenant_id,name,time_zone) values('alpha','Alpha','UTC')");
  await db.query("insert into public.sms_automation_groups(tenant_id,id,name,kind,rule) values('alpha','reminders','Reminders','reminder',$1::jsonb)",[JSON.stringify(rule)]);
  const first=(await db.query("select sms_private.automation_due('2026-09-25T18:00:00Z'::timestamptz,$1::jsonb,'UTC',true) as due",[JSON.stringify(rule)])).rows[0].due;
  const next=(await db.query("select sms_private.automation_due('2026-09-24T18:00:00Z'::timestamptz,$1::jsonb,'UTC',false) as due",[JSON.stringify(rule)])).rows[0].due;
  assert.equal(new Date(first).toISOString(),'2026-09-24T18:00:00.000Z');
  assert.equal(new Date(next).toISOString(),'2026-09-25T00:00:00.000Z');
  await assert.rejects(()=>db.query("update public.sms_automation_groups set rule=$1::jsonb where tenant_id='alpha' and id='reminders'",[JSON.stringify({...rule,repeatCount:5})]),/Invalid automation schedule/);
 }finally{await db.close();}
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
  await call(db,'api_action','admin','alpha','group',groupInput('followup','Offer a useful follow-up.'));
  const enrollment=await call(db,'api_action','admin','alpha','enroll',{phone:'+13035551234',categoryId:'followup'});
  await db.exec('update sms_private.runtime set scheduler_enabled=true');
  assert.equal(await call(db,'tick'),1);assert.equal(await call(db,'tick'),0);
  const job=await call(db,'claim','automation_jobs','automation');
  const context=await call(db,'job_context',job.id,job.lease_token);
  const {evaluateAutomation,processAutomation}=await import('../src/workers/automation.js');
  await assert.rejects(()=>call(db,'complete_automation',job.id,job.lease_token,evaluateAutomation(context)),/Fresh AI draft/);
  const send=await processAutomation(job,{call:(name,...args)=>call(db,name,...args)},{
   apiKey:'test',fetchImpl:async()=>Response.json({status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify({message:'Alpha checking in. How can we help?'})}]}]})
  });
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

test('a new thread message during drafting prevents the scheduled SMS from being queued',async()=>{
 const db=await testDatabase();try {
  await activeBusiness(db);
  await call(db,'api_action','admin','alpha','consent',{phone:'+13035551234',consent:true,evidence:'Test opt-in'});
  await call(db,'api_action','admin','alpha','group',groupInput('followup','Ask whether the quote is clear.'));
  await call(db,'api_action','admin','alpha','enroll',{phone:'+13035551234',categoryId:'followup'});
  await db.exec('update sms_private.runtime set scheduler_enabled=true');
  await call(db,'tick');
  const job=await call(db,'claim','automation_jobs','automation');
  const context=await call(db,'job_context',job.id,job.lease_token);
  const {evaluateAutomation}=await import('../src/workers/automation.js');
  await db.exec("insert into public.sms_thread_contacts(tenant_id,phone,generation) values('alpha','+13035551234',1) on conflict(tenant_id,phone) do update set generation=sms_thread_contacts.generation+1");
  const draft={...evaluateAutomation(context),body:'Alpha checking in about your quote. Reply STOP to opt out.',ai_drafted:true,thread_generation:context.thread?.generation??0};
  delete draft.step_intent;
  await assert.rejects(()=>call(db,'complete_automation',job.id,job.lease_token,draft),/Conversation changed during AI draft/);
  assert.equal((await db.query("select count(*) from public.sms_messages where tenant_id='alpha' and direction='outbound'")).rows[0].count,0);
 }finally{await db.close();}
});

test('unmatched inbound AI uses the business prompt without borrowing a group',async()=>{
 const db=await testDatabase();try {
  await activeBusiness(db);
  await call(db,'api_action','admin','alpha','group',groupInput('inbound','Follow up if enrolled.',{firstDelayCount:1}));
  const setting=await call(db,'configure_ai','admin','alpha','inbound',true,'Reply briefly',true);
  assert.equal(setting.default_for_inbound,true);
  await call(db,'record_webhook','alpha','inbound',{From:'+13035551234',MessageSid:'SM_before_business_ai',Body:'Hello'});
  assert.equal(await call(db,'claim','ai_reply_jobs','ai'),null);
  await call(db,'save_business_ai_settings','admin','alpha',{enabled:true,systemPrompt:'Ask what the texter needs before suggesting a service.'});
  await call(db,'record_webhook','alpha','inbound',{From:'+13035551234',MessageSid:'SM_default_ai',Body:'Can you help?'});
  const ai=await call(db,'claim','ai_reply_jobs','ai');
  assert.equal(ai.payload.group_id,'');
  const context=await call(db,'job_context',ai.id,ai.lease_token);
  assert.equal(context.inboundAi.scope,'business');
  assert.match(context.inboundAi.systemPrompt,/what the texter needs/);
  assert.equal(context.active_request,undefined);
  const reply=await call(db,'complete_grounded_ai',ai.id,ai.lease_token,{
    reply:'Hi! What can we help you with?',disposition:'collect_lead',grounded:false,
    citationIds:[],lead:{},bookingIntent:'none',leadSummary:'New inbound text',mode:'live',model:'test'
  });
  assert.ok(reply.messageId);
  assert.equal((await db.query('select category_id from public.sms_messages where id=$1',[reply.messageId])).rows[0].category_id,null);
  await call(db,'api_action','admin','alpha','pause',{phone:'+13035551234'});
  await call(db,'record_webhook','alpha','inbound',{From:'+13035551234',MessageSid:'SM_paused_ai',Body:'Anyone there?'});
  assert.equal(await call(db,'claim','ai_reply_jobs','ai'),null);
 }finally{await db.close();}
});

test('late failure callbacks preserve delivered status and the active next step',async()=>{
 const db=await testDatabase();try {
  await activeBusiness(db);
  await call(db,'api_action','admin','alpha','consent',{phone:'+13035551234',consent:true,evidence:'Test opt-in'});
  await call(db,'api_action','admin','alpha','group',groupInput('sequence','Follow up on the request.',{repeatCount:2}));
  await call(db,'api_action','admin','alpha','enroll',{phone:'+13035551234',categoryId:'sequence'});
  await db.exec('update sms_private.runtime set scheduler_enabled=true');
  await call(db,'tick');
  const automation=await call(db,'claim','automation_jobs','automation');
  const context=await call(db,'job_context',automation.id,automation.lease_token);
  const {processAutomation}=await import('../src/workers/automation.js');
  const outbox=await processAutomation(automation,{call:(name,...args)=>call(db,name,...args)},{
   apiKey:'test',fetchImpl:async()=>Response.json({status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify({message:'Alpha here. Is there anything else we can clarify?'})}]}]})
  });
  const sms=await call(db,'claim','sms_send_jobs','sms');
  const submission=await call(db,'begin_submission',sms.id,sms.lease_token);
  assert.ok(submission, JSON.stringify((await db.query('select status,error_code,payload from sms_private.jobs where id=$1',[sms.id])).rows[0]));
  for(const status of ['delivered','failed']) await call(db,'record_webhook','alpha','status',{MessageSid:'SM_ordered',MessageStatus:status,attempt_id:submission.attempt_id});
  assert.equal((await db.query('select status from public.sms_messages where id=$1',[outbox.messageId])).rows[0].status,'delivered');
  const enrollment=(await db.query("select status,step_index from public.sms_automation_enrollments where category_id='sequence'")).rows[0];
  assert.equal(enrollment.status,'active');assert.equal(enrollment.step_index,1);
  assert.equal((await db.query('select count(*) from public.sms_message_events where message_id=$1',[outbox.messageId])).rows[0].count,2);
 }finally{await db.close();}
});

test('migration removes reusable copy and pauses unreviewed custom groups',async()=>{
 const db=await testDatabase({beforeMigration:async(db,file)=>{
  if(file!=='20260923033605_simple_automation_schedule.sql')return;
  await db.exec("insert into sms_private.admins values('admin') on conflict do nothing");
  await call(db,'api_action','admin',null,'create_business',{id:'alpha',name:'Alpha',timeZone:'UTC'});
  await call(db,'api_action','admin','alpha','contact',{phone:'+13035551234',name:'Alex'});
  await call(db,'api_action','admin','alpha','consent',{phone:'+13035551234',consent:true,evidence:'Test opt-in'});
  await call(db,'api_action','admin','alpha','group',{id:'custom-old',name:'Old custom',kind:'custom',
    rule:{steps:[{template:'Hi Alex, checking in. Reply STOP to opt out.',delayCount:1,delayUnit:'day'}]}});
  await call(db,'api_action','admin','alpha','enroll',{phone:'+13035551234',categoryId:'custom-old'});
 }});
 try{
  const exists=(await db.query("select to_regclass('public.sms_automation_steps') as table_name")).rows[0].table_name;
  assert.equal(exists,null);
  const group=(await db.query("select active,rule from public.sms_automation_groups where id='custom-old'")).rows[0];
  assert.equal(group.active,false);
  assert.equal(group.rule.steps,undefined);
  assert.equal(group.rule.template,undefined);
  const intents=(await db.query("select count(*) from public.sms_automation_intents where group_id='custom-old'")).rows[0].count;
  assert.equal(intents,0);
  const enrollment=(await db.query("select status,pause_reason from public.sms_automation_enrollments where category_id='custom-old'")).rows[0];
  assert.equal(enrollment.status,'paused');
  assert.equal(enrollment.pause_reason,'LEGACY_GROUP_RETIRED');
  await assert.rejects(()=>call(db,'api_action','admin','alpha','group',{id:'bad',name:'Bad',intent:'Ask a question.',
    systemPrompt:'Ask one relevant question.',businessContext:'Alpha provides customer services.',
    rule:{steps:[{template:'Hello',delayCount:1,delayUnit:'day'}]}}),/intent|schedule/i);
 }finally{await db.close();}
});

test('exhausted draft retries pause enrollment without sending copy; retry resumes fresh work',async()=>{
 const db=await testDatabase();try{
  await activeBusiness(db);
  await call(db,'api_action','admin','alpha','consent',{phone:'+13035551234',consent:true,evidence:'Test opt-in'});
  await call(db,'api_action','admin','alpha','group',groupInput('followup','Ask a useful question.'));
  await call(db,'api_action','admin','alpha','enroll',{phone:'+13035551234',categoryId:'followup'});
  await db.exec('update sms_private.runtime set scheduler_enabled=true');await call(db,'tick');
  const job=await call(db,'claim','automation_jobs','automation');
  await db.query("update sms_private.jobs set status='failed',error_code='AI_REQUEST_FAILED' where id=$1",[job.id]);
  const enrollment=(await db.query("select status,pause_reason from public.sms_automation_enrollments where category_id='followup'")).rows[0];
  assert.equal(enrollment.status,'paused');
  assert.equal(enrollment.pause_reason,'AI_REQUEST_FAILED');
  assert.equal((await db.query("select count(*) from public.sms_messages where contact_phone='+13035551234'")).rows[0].count,0);
  const resumed=await call(db,'api_action','admin','alpha','retry_job',{id:job.id});
  assert.equal(resumed.ok,true);
  assert.equal((await db.query("select status from public.sms_automation_enrollments where category_id='followup'")).rows[0].status,'active');
  assert.equal((await db.query("select status from sms_private.jobs where id=$1",[job.id])).rows[0].status,'queued');
 }finally{await db.close();}
});

test('a reply after drafting cancels the unsent body and requeues fresh context',async()=>{
 const db=await testDatabase();try{
  await activeBusiness(db);
  await call(db,'api_action','admin','alpha','consent',{phone:'+13035551234',consent:true,evidence:'Test opt-in'});
  await call(db,'api_action','admin','alpha','group',groupInput('followup','Ask a useful question.'));
  await call(db,'api_action','admin','alpha','enroll',{phone:'+13035551234',categoryId:'followup'});
  await db.exec('update sms_private.runtime set scheduler_enabled=true');await call(db,'tick');
  const job=await call(db,'claim','automation_jobs','automation');
  const {processAutomation}=await import('../src/workers/automation.js');
  const outbox=await processAutomation(job,{call:(name,...args)=>call(db,name,...args)},{apiKey:'test',fetchImpl:async()=>Response.json({status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify({message:'Alpha here. Can we help with your request?'})}]}]})});
  const sms=await call(db,'claim','sms_send_jobs','sms');
  await db.exec("update public.sms_thread_contacts set generation=generation+1 where tenant_id='alpha' and phone='+13035551234'");
  assert.equal(await call(db,'begin_submission',sms.id,sms.lease_token),null);
  assert.equal((await db.query('select status from public.sms_messages where id=$1',[outbox.messageId])).rows[0].status,'cancelled');
  assert.equal((await db.query('select generation from public.sms_automation_enrollments where category_id=$1',['followup'])).rows[0].generation,2);
  await call(db,'tick');
  assert.equal((await db.query("select count(*) from sms_private.jobs where queue='automation_jobs' and status='queued'")).rows[0].count,1);
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

