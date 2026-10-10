import test from 'node:test';
import assert from 'node:assert/strict';
import {testDatabase,call} from './helpers/database.js';
const tenant='biz-1c0c09ce-819e-4795-86b9-0e457ab92f58',phone='+13035550122';
const day=new Date(Date.now()+3*86400000).toISOString().slice(0,10);
async function setup(mode='live') {
 const db=await testDatabase();
 await call(db,'api_action','admin',null,'create_business',{id:tenant,name:'Pilot',timeZone:'UTC'});
 await db.query("update public.sms_businesses set status='active',sending_enabled=true where tenant_id=$1",[tenant]);
 await db.query("insert into sms_private.inbound_ai_settings(tenant_id,mode,system_prompt,booking_enabled,live_validated_at) values($1,$2,'Help customers',true,now())",[tenant,mode]);
 const hours=Object.fromEntries(Array.from({length:7},(_,i)=>[i,[{start:'09:00',end:'17:00'}]]));
 await call(db,'voice_save_rule','admin',tenant,{service:'junk_removal',market:'Pilot',resourcePool:'crew',timeZone:'UTC',enabled:true,durationMinutes:60,capacity:1,minimumNoticeMinutes:0,maximumAdvanceDays:90,weeklyAvailability:hours,dateExceptions:[]});
 return db;
}
async function incoming(db,body='Hello',sid=crypto.randomUUID()) {
 await call(db,'record_webhook',tenant,'inbound',{From:phone,To:'+18005550100',Body:body,MessageSid:sid});
 await db.query("update sms_private.jobs set available_at=now() where queue='ai_reply_jobs'");
 await db.query("update pgmq.test_messages set vt=now() where q='ai_reply_jobs'");
 return call(db,'claim','ai_reply_jobs','test-ai');
}
const invoke=(db,job,name,args={})=>call(db,'inbound_ai_tool',job.id,job.lease_token,name,args);
const details=()=>({service:'junk_removal',name:'Test Person',address:'123 Test Street',localDate:day,localTime:'10:00',details:{notes:null}});

test('new jobs are versioned; default off and legacy enqueue stay disabled',async()=>{
 const db=await setup('off');try {
  assert.equal(await incoming(db),null);
  assert.equal(await call(db,'enqueue',tenant,'ai_reply_jobs','old',{phone}),null);
  await db.query("update sms_private.inbound_ai_settings set mode='live'");
  const job=await incoming(db);assert.equal(job.payload.agent_version,'sms-agent-v1');
  const ctx=await call(db,'inbound_ai_context',job.id,job.lease_token);assert.equal(ctx.latestMessage,'Hello');
  assert.equal(ctx.services[0].service,'junk_removal');
 }finally{await db.close();}
});
test('booking requires a sent proposal and confirmation; retries return one appointment',async()=>{
 const db=await setup();try {
  let job=await incoming(db,'Book junk removal');
  const prepared=await invoke(db,job,'prepare_booking',details());assert.equal(prepared.available,true);
  assert.match(prepared.customerReply,/Reply YES/);
  assert.equal((await invoke(db,job,'confirm_booking')).needsPreparation,true);
  const out=await call(db,'complete_inbound_ai',job.id,job.lease_token,{reply:'ignored'});
  await db.query("update public.sms_messages set provider_accepted_at=now(),status='accepted' where id=$1",[out.messageId]);
  job=await incoming(db,'YES');
  const confirmed=await invoke(db,job,'confirm_booking');assert.equal(confirmed.status,'confirmed');
  assert.equal((await invoke(db,job,'confirm_booking')).bookingId,confirmed.bookingId);
  const rows=await db.query("select source,voice_resource_pool from public.sms_bookings where tenant_id=$1",[tenant]);
  assert.equal(rows.rows.length,1);assert.equal(rows.rows[0].source,'sms');assert.equal(rows.rows[0].voice_resource_pool,'crew');
  const context=await call(db,'inbound_ai_context',job.id,job.lease_token);assert.match(context.recoveredReply,/confirmed/);
  const availability=await invoke(db,job,'check_availability',{service:'junk_removal',localDate:day});
  assert.equal(availability.slots.find(s=>s.localTime==='10:00').available,false);
  await call(db,'complete_inbound_ai',job.id,job.lease_token,{reply:'unused'});
  job=await incoming(db,'YES');
  const repeated=await invoke(db,job,'confirm_booking');
  assert.equal(repeated.bookingId,confirmed.bookingId);assert.equal(repeated.duplicate,true);
  assert.match(repeated.customerReply,/confirmed for/);
  assert.equal((await db.query('select count(*) n from public.sms_bookings')).rows[0].n,1);
 }finally{await db.close();}
});
test('shadow proposes tools without writing booking, session, staff task or outbox',async()=>{
 const db=await setup('shadow');try {
  const job=await incoming(db,'Book it');
  assert.equal((await invoke(db,job,'prepare_booking',details())).simulated,true);
  assert.equal((await invoke(db,job,'request_staff_help',{reason:'Requested human'})).simulated,true);
  await call(db,'complete_inbound_ai',job.id,job.lease_token,{reply:'Hello'});
  for(const table of ['public.sms_bookings','sms_private.inbound_ai_sessions','public.sms_handoffs']) assert.equal((await db.query(`select count(*) n from ${table}`)).rows[0].n,0);
  assert.equal((await db.query("select count(*) n from public.sms_messages where direction='outbound'")).rows[0].n,0);
 }finally{await db.close();}
});
test('new texts and staff takeover fence tool execution; identity cannot be selected',async()=>{
 const db=await setup();try {
  let job=await incoming(db);
  await assert.rejects(()=>invoke(db,job,'lookup_bookings',{phone:'+13035550000'}),/server-owned/);
  await incoming(db,'Actually something else');
  assert.equal((await invoke(db,job,'prepare_booking',details())).stale,true);
  await call(db,'finish',job.id,job.lease_token,'cancelled','STALE',0);
  job=await call(db,'claim','ai_reply_jobs','test-ai');
  await call(db,'conversation_action','admin',tenant,job.payload.conversation_id,'reply',{body:'I can help',idempotencyKey:'test-manual'});
  assert.equal(await call(db,'inbound_ai_context',job.id,job.lease_token),null);
 }finally{await db.close();}
});
test('terminal failures create one staff task and transient failures stop after three attempts',async()=>{
 const db=await setup();try {
  const job=await incoming(db);
  await db.query('update sms_private.jobs set attempts=3 where id=$1',[job.id]);
  await call(db,'fail_inbound_ai',job.id,job.lease_token,{code:'OPENAI_429',transient:true});
  assert.equal((await db.query('select count(*) n from public.sms_handoffs')).rows[0].n,1);
  assert.equal((await db.query('select ai_paused from public.sms_conversations')).rows[0].ai_paused,true);
 }finally{await db.close();}
});

test('staff handoff pauses atomically and recovers its reply after a worker crash',async()=>{
 const db=await setup();try {
  const job=await incoming(db,'Please let me talk to a person');
  const help=await invoke(db,job,'request_staff_help',{reason:'Customer requested staff'});
  assert.equal((await db.query('select ai_paused from public.sms_conversations')).rows[0].ai_paused,true);
  const ctx=await call(db,'inbound_ai_context',job.id,job.lease_token);
  assert.equal(ctx.recoveredReply,help.customerReply);
  assert.equal((await invoke(db,job,'prepare_booking',details())).stale,true);
  const out=await call(db,'complete_inbound_ai',job.id,job.lease_token,{reply:ctx.recoveredReply});
  assert.ok(out.messageId);
  assert.equal((await db.query('select count(*) n from public.sms_handoffs')).rows[0].n,1);
 }finally{await db.close();}
});

test('unaccepted summaries, changed drafts, expiry and schedule edits cannot confirm',async()=>{
 const db=await setup();try {
  let job=await incoming(db,'Book');
  await invoke(db,job,'prepare_booking',details());
  const out=await call(db,'complete_inbound_ai',job.id,job.lease_token,{reply:'unused'});
  job=await incoming(db,'YES');assert.equal((await invoke(db,job,'confirm_booking')).needsPreparation,true);
  await call(db,'finish',job.id,job.lease_token,'completed',null,0);
  await db.query("update public.sms_messages set provider_accepted_at=now(),status='accepted' where id=$1",[out.messageId]);
  job=await incoming(db,'Actually make it 11');assert.equal((await invoke(db,job,'confirm_booking')).needsPreparation,true);
  await invoke(db,job,'prepare_booking',{...details(),localTime:'11:00'});
  const updated=await call(db,'complete_inbound_ai',job.id,job.lease_token,{reply:'unused'});
  await db.query("update public.sms_messages set provider_accepted_at=now(),status='accepted' where id=$1",[updated.messageId]);
  job=await incoming(db,'YES');
  await db.query("update sms_private.voice_booking_holds set expires_at=now()-interval '1 minute'");
  assert.equal((await invoke(db,job,'confirm_booking')).needsPreparation,true);
  await call(db,'complete_inbound_ai',job.id,job.lease_token,{reply:'unused'});
  job=await incoming(db,'Check 11 again');
  await invoke(db,job,'prepare_booking',{...details(),localTime:'11:00'});
  const fresh=await call(db,'complete_inbound_ai',job.id,job.lease_token,{reply:'unused'});
  await db.query("update public.sms_messages set provider_accepted_at=now(),status='accepted' where id=$1",[fresh.messageId]);
  job=await incoming(db,'YES');
  await db.query('update public.sms_voice_service_rules set version=version+1');
  assert.equal((await invoke(db,job,'confirm_booking')).needsPreparation,true);
  assert.equal((await db.query('select count(*) n from public.sms_bookings')).rows[0].n,0);
 }finally{await db.close();}
});

test('STOP rejects a previously prepared outbound send',async()=>{
 const db=await setup();try {
  const job=await incoming(db);const out=await call(db,'complete_inbound_ai',job.id,job.lease_token,{reply:'Hello'});
  await call(db,'record_webhook',tenant,'inbound',{From:phone,To:'+18005550100',Body:'STOP',MessageSid:crypto.randomUUID()});
  assert.equal((await db.query('select opted_out from public.sms_contacts where phone=$1',[phone])).rows[0].opted_out,true);
  assert.equal((await db.query('select status from sms_private.jobs where id=$1',[out.jobId])).rows[0].status,'cancelled');
  assert.equal((await db.query('select count(*) n from sms_private.attempts')).rows[0].n,0);
 }finally{await db.close();}
});

test('only eligible versioned replies reach the provider submission boundary',async()=>{
 const db=await setup();try {
  await db.query("update sms_private.providers set account_sid=$2,from_number='+18005550100',auth_secret_id=vault.create_secret('synthetic-secret') where tenant_id=$1",[tenant,'AC'+'a'.repeat(32)]);
  let job=await incoming(db);
  await call(db,'complete_inbound_ai',job.id,job.lease_token,{reply:'Hello'});
  let sms=await call(db,'claim','sms_send_jobs','test-sender');
  const submission=await call(db,'begin_submission',sms.id,sms.lease_token);
  assert.equal(submission.body,'Hello');assert.equal(submission.phone,phone);
  await call(db,'accept_submission',sms.id,sms.lease_token,submission.attempt_id,'SM'+'a'.repeat(32));
  job=await incoming(db,'Another question');
  await call(db,'complete_inbound_ai',job.id,job.lease_token,{reply:'Another answer'});
  sms=await call(db,'claim','sms_send_jobs','test-sender');
  await db.query('update sms_private.inbound_ai_settings set revision=revision+1');
  assert.equal(await call(db,'begin_submission',sms.id,sms.lease_token),null);
  assert.equal((await db.query('select count(*) n from sms_private.attempts')).rows[0].n,1);
 }finally{await db.close();}
});

test('lookup cannot disclose another business or customer and private cores have no worker grant',async()=>{
 const db=await setup();try {
  const job=await incoming(db);
  await db.query("insert into public.sms_contacts(tenant_id,phone) values($1,'+13035550999')",[tenant]);
  await db.query("insert into public.sms_bookings(tenant_id,id,contact_id,status,appointment_at) select tenant_id,'other',id,'confirmed',now() from public.sms_contacts where phone='+13035550999'");
  assert.deepEqual((await invoke(db,job,'lookup_bookings')).bookings,[]);
  const grants=(await db.query("select has_function_privilege('sms_ai','sms_private.booking_confirm_shared(text,text,uuid,text)','execute') core,has_table_privilege('sms_ai','sms_private.inbound_ai_settings','select') raw")).rows[0];
  assert.equal(grants.core,false);assert.equal(grants.raw,false);
  await assert.rejects(()=>call(db,'inbound_ai_settings_api','stranger',tenant,null),/denied|admin|permission|staff/i);
 }finally{await db.close();}
});
