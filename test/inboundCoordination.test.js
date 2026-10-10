import test from 'node:test';
import assert from 'node:assert/strict';
import {call} from './helpers/database.js';
import {setupCoordination,addRun,incoming,invoke,details,runState,accepted,queuedForm,tenant,phone} from './helpers/coordination.js';

test('context associates accepted automation metadata; competing unseen forms require clarification',async()=>{
 const db=await setupCoordination();try {
  const a=await addRun(db),b=await addRun(db,{title:'Moving quote'});
  let j=await incoming(db,'Hello');let ctx=await call(db,'inbound_ai_context',j.id,j.lease_token);
  assert.equal(ctx.automation.needsClarification,true);assert.equal(ctx.automation.associatedRequestRef,null);
  assert.equal(ctx.automation.candidates.length,2);assert.equal(ctx.automation.candidates[0].version,1);
  await call(db,'finish',j.id,j.lease_token,'completed');
  const out=await call(db,'outbox',tenant,'context-message',{phone,body:'Do you still need moving help?',purpose:'marketing'});
  await db.query("update public.sms_messages set meta=meta||jsonb_build_object('form_run_id',$2::text) where id=$1",[out.messageId,b.id]);await accepted(db,out.messageId);
  j=await incoming(db,'Yes please');ctx=await call(db,'inbound_ai_context',j.id,j.lease_token);
  assert.equal(ctx.automation.associatedRequestRef,b.id);assert.match(ctx.automation.lastAcceptedOutbound.body,/moving/);
  await invoke(db,j,'prepare_booking',{...details(),requestRef:b.id});
  assert.equal((await db.query('select enquiry_run_id from sms_private.inbound_ai_sessions')).rows[0].enquiry_run_id,b.id);
  assert.equal((await runState(db,a)).status,'active');
 }finally{await db.close();}
});

test('explicit decline stops only the scoped enquiry; retries recover its durable reply',async()=>{
 const db=await setupCoordination();try {
  const a=await addRun(db),b=await addRun(db,{title:'Moving quote'}),appt=await addRun(db,{appointment:true});
  const j=await incoming(db,'No thanks, I am not interested in the Junk enquiry.');
  const args={requestRef:a.id,declineQuote:'not interested'};
  const result=await invoke(db,j,'close_enquiry',args);
  assert.equal(result.coordination.reason,'AI_DECLINED');assert.equal((await runState(db,a)).status,'stopped');
  assert.equal((await runState(db,b)).status,'active');assert.equal((await runState(db,appt)).status,'active');
  assert.deepEqual(await invoke(db,j,'close_enquiry',args),result);
  assert.equal((await call(db,'inbound_ai_context',j.id,j.lease_token)).recoveredReply,result.customerReply);
  await call(db,'fail_inbound_ai',j.id,j.lease_token,{code:'AFTER_COMMIT',transient:false});
  assert.equal((await db.query('select count(*) n from public.sms_handoffs')).rows[0].n,0);
  assert.equal((await db.query('select opted_out from public.sms_contacts where phone=$1',[phone])).rows[0].opted_out,false);
 }finally{await db.close();}
});

test('ambiguous declines, forged evidence, foreign references and appointments cannot be closed',async()=>{
 const db=await setupCoordination();try {
  const a=await addRun(db),b=await addRun(db,{title:'Moving quote'}),foreign=await addRun(db,{customer:'+13035550999'}),appt=await addRun(db,{appointment:true});
  for(const body of ['No','No thanks, but another time?','I am not interested']) {
   const j=await incoming(db,body);
   const r=await invoke(db,j,'close_enquiry',{requestRef:a.id,declineQuote:'not interested'});
   assert.equal(r.needsClarification,true);
   await assert.rejects(()=>invoke(db,j,'close_enquiry',{requestRef:foreign.id,declineQuote:'not interested'}),/outside job scope/);
   await assert.rejects(()=>invoke(db,j,'close_enquiry',{requestRef:appt.id,declineQuote:'not interested'}),/outside job scope/);
   await call(db,'finish',j.id,j.lease_token,'completed');
  }
  assert.equal((await runState(db,a)).status,'active');assert.equal((await runState(db,b)).status,'active');
 }finally{await db.close();}
});

test('booking commit stops its associated enquiry once and preserves other follow-ups',async()=>{
 const db=await setupCoordination();try {
  const a=await addRun(db),b=await addRun(db,{title:'Moving quote'});
  let j=await incoming(db,'Please book the Junk enquiry');
  await invoke(db,j,'prepare_booking',{...details(),requestRef:a.id});
  const out=await call(db,'complete_inbound_ai',j.id,j.lease_token,{reply:'unused'});await accepted(db,out.messageId);
  j=await incoming(db,'YES');const booked=await invoke(db,j,'confirm_booking');
  assert.equal(booked.status,'confirmed');assert.equal(booked.coordination.requestRef,a.id);
  assert.equal((await runState(db,a)).reason,'AI_BOOKED');assert.equal((await runState(db,b)).status,'active');
  const generation=(await runState(db,a)).generation;
  assert.equal((await invoke(db,j,'confirm_booking')).bookingId,booked.bookingId);
  assert.equal((await runState(db,a)).generation,generation);
  await call(db,'fail_inbound_ai',j.id,j.lease_token,{code:'CRASH',transient:false});
  assert.equal((await db.query('select count(*) n from public.sms_bookings')).rows[0].n,1);
 }finally{await db.close();}
});

test('a newer accepted outbound question invalidates an uncommitted confirmation',async()=>{
 const db=await setupCoordination();try {
  let j=await incoming(db,'Book junk removal');await invoke(db,j,'prepare_booking',details());
  const summary=await call(db,'complete_inbound_ai',j.id,j.lease_token,{reply:'unused'});await accepted(db,summary.messageId);
  const reminder=await call(db,'outbox',tenant,'other-question',{phone,body:'Do you need a quote?',purpose:'marketing'});await accepted(db,reminder.messageId);
  j=await incoming(db,'YES');assert.equal((await invoke(db,j,'confirm_booking')).needsPreparation,true);
  assert.equal((await db.query('select count(*) n from public.sms_bookings')).rows[0].n,0);
 }finally{await db.close();}
});

test('quiet window prevents scheduling; appointment reminders and shadow schedules are unchanged',async()=>{
 for(const mode of ['live','shadow']) {
  const db=await setupCoordination({mode});try {
   const enquiry=await addRun(db),appt=await addRun(db,{appointment:true});
   const j=await incoming(db);
   const context=await call(db,'inbound_ai_context',j.id,j.lease_token);
   assert.ok(new Date(context.automation.quietUntil)>new Date());
   await call(db,'enqueue_due_automations');
   const jobs=(await db.query("select payload->>'form_run_id' id from sms_private.jobs where queue='automation_jobs'")).rows.map(x=>x.id);
   assert.ok(jobs.includes(appt.id));assert.equal(jobs.includes(enquiry.id),mode==='shadow');
   assert.equal((await runState(db,enquiry)).status,'active');
  }finally{await db.close();}
 }
});

test('processing and queued sends defer without attempts, cursor advancement or failure pauses',async()=>{
 for(const boundary of ['processing','sending']) {
  const db=await setupCoordination();try {
   const r=await addRun(db);await call(db,'enqueue_due_automations');
   let job=await call(db,'claim','automation_jobs','automation');
   if(boundary==='sending') {await call(db,'process_form_automation',job.id,job.lease_token);job=await call(db,'claim','sms_send_jobs','sender');}
   await incoming(db,'I have a question');
   const fn=boundary==='sending'?'begin_submission':'process_form_automation';
   assert.equal(await call(db,fn,job.id,job.lease_token),null);
   const saved=(await db.query('select status,attempts,error_code from sms_private.jobs where id=$1',[job.id])).rows[0];
   assert.deepEqual(saved,{status:'retry',attempts:0,error_code:'AI_QUIET_WINDOW'});
   const state=await runState(db,r);assert.equal(state.status,'active');assert.equal(state.send_index,0);assert.equal(state.generation,1);
   assert.equal((await db.query('select count(*) n from sms_private.attempts')).rows[0].n,0);
   // Finish the AI turn, then expire only synthetic activity. Reclaim the SAME job.
   await db.query("update sms_private.jobs set status='completed',leased_until=null where queue='ai_reply_jobs'");
   await db.query("update public.sms_messages set created_at=now()-interval '31 minutes' where direction='inbound'");
   await db.query('update sms_private.jobs set available_at=now() where id=$1',[job.id]);
   await db.query('update pgmq.test_messages set vt=now() where id=$1',[job.queue_msg_id]);
   job=await call(db,'claim',job.queue,'retry');const next=await call(db,fn,job.id,job.lease_token);assert.ok(next);
   assert.equal((await runState(db,r)).send_index,0,'Only provider acceptance advances the cursor');
   if(boundary==='sending') {
    await call(db,'accept_submission',job.id,job.lease_token,next.attempt_id,'SM'+crypto.randomUUID().replaceAll('-',''));
    assert.equal((await runState(db,r)).send_index,1);
    assert.ok(new Date((await runState(db,r)).next_run_at)>new Date());
   }
  }finally{await db.close();}
 }
});

test('sent AI replies extend quiet time; paused runs remain paused after expiry and handoff',async()=>{
 const db=await setupCoordination();try {
  const r=await addRun(db),paused=await addRun(db,{policy:'pause',title:'Pause enquiry'});
  const j=await incoming(db,'I need a person for the Junk enquiry');
  assert.equal((await runState(db,paused)).status,'paused');
  await invoke(db,j,'request_staff_help',{reason:'Customer requested staff',requestRef:r.id});
  const out=await call(db,'complete_inbound_ai',j.id,j.lease_token,{reply:'unused'});await accepted(db,out.messageId);
  await db.query("update public.sms_messages set created_at=now()-interval '31 minutes' where direction='inbound'");
  const until=await call(db,'enquiry_quiet_until',tenant,phone,false);assert.ok(new Date(until)>new Date());
  assert.equal((await runState(db,r)).reason,'AI_STAFF_HANDOFF');
  await db.query("update public.sms_messages set provider_accepted_at=now()-interval '31 minutes' where direction='outbound'");
  await call(db,'enqueue_due_automations');assert.equal((await runState(db,r)).status,'paused');assert.equal((await runState(db,paused)).status,'paused');
 }finally{await db.close();}
});

test('shadow records proposed closure, association and quiet time without changing run or session',async()=>{
 const db=await setupCoordination({mode:'shadow'});try {
  const r=await addRun(db);const j=await incoming(db,'No thanks, not interested');
  const before=await runState(db,r);
  const result=await invoke(db,j,'close_enquiry',{requestRef:r.id,declineQuote:'not interested'});assert.equal(result.coordination.simulated,true);
  await call(db,'complete_inbound_ai',j.id,j.lease_token,{reply:'unused'});
  assert.deepEqual(await runState(db,r),before);
  assert.equal((await db.query('select count(*) n from sms_private.inbound_ai_sessions')).rows[0].n,0);
  const record=(await db.query('select result from sms_private.inbound_ai_runs')).rows[0].result;
  assert.equal(record.coordination.reason,'AI_DECLINED');assert.ok(record.coordination.quietUntil);
  assert.equal((await db.query("select count(*) n from public.sms_messages where direction='outbound'")).rows[0].n,0);
 }finally{await db.close();}
});

test('staff requests without an enquiry association leave unrelated follow-ups active',async()=>{
 const db=await setupCoordination();try {
  const r=await addRun(db);const j=await incoming(db,'Cancel my appointment');
  await invoke(db,j,'request_staff_help',{reason:'Appointment cancellation',requestRef:null});
  const out=await call(db,'complete_inbound_ai',j.id,j.lease_token,{reply:'unused'});
  assert.equal((await runState(db,r)).status,'active');
  assert.equal((await db.query('select meta from public.sms_messages where id=$1',[out.messageId])).rows[0].meta.enquiry_run_id,null);
 }finally{await db.close();}
});

test('staff takeover, STOP and a newer message fence enquiry closure; foreign businesses are denied',async()=>{
 const db=await setupCoordination();try {
  const r=await addRun(db);
  await call(db,'api_action','admin',null,'create_business',{id:'other',name:'Other',timeZone:'UTC'});
  const foreign=await addRun(db,{business:'other'});
  let j=await incoming(db,'Not interested');
  await assert.rejects(()=>invoke(db,j,'close_enquiry',{requestRef:foreign.id,declineQuote:'Not interested'}),/outside job scope/);
  await incoming(db,'Actually I am interested');
  assert.equal((await invoke(db,j,'close_enquiry',{requestRef:r.id,declineQuote:'Not interested'})).stale,true);
  await call(db,'finish',j.id,j.lease_token,'cancelled');
  j=await call(db,'claim','ai_reply_jobs','next');
  await call(db,'conversation_action','admin',tenant,j.payload.conversation_id,'reply',{body:'I can help',idempotencyKey:'takeover'});
  assert.equal((await invoke(db,j,'close_enquiry',{requestRef:r.id,declineQuote:'Not interested'})).stale,true);
  assert.equal((await runState(db,r)).status,'active');
  await call(db,'record_webhook',tenant,'inbound',{From:phone,To:'+18005550100',Body:'STOP',MessageSid:crypto.randomUUID()});
  assert.equal((await runState(db,r)).reason,'OPTED_OUT');
 }finally{await db.close();}
});
