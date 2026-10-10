import test from 'node:test';import assert from 'node:assert/strict';
import {call} from './helpers/database.js';
import {setupCoordination,addRun,incoming,tenant,phone,queuedForm,invoke} from './helpers/coordination.js';
import {canonicalPhone} from '../public/phoneNormalization.js';
export const sequence=(policy='pause')=>({trigger:'submission',replyPolicy:policy,startHour:0,endHour:24,leadHours:24,steps:[{body:'Hi {{name}}, do you need help?',delayCount:0,delayUnit:'minute',sendCount:2,intervalCount:1,intervalUnit:'day'}]});
const api=(db,a,p={})=>call(db,'contact_automations','admin',tenant,a,{idempotencyKey:crypto.randomUUID(),...p});
export async function directSetup(db,policy='pause'){
 const contact=(await db.query('select * from public.sms_contacts where tenant_id=$1 and phone=$2',[tenant,phone])).rows[0];
 const tpl=(await api(db,'publish',{name:'Direct request',sequence:sequence(policy)})).template;
 const p={contactId:contact.id,templateId:tpl.id,templateRevision:tpl.revision,contactRevision:contact.revision,overlaps:[],context:'Junk removal',idempotencyKey:crypto.randomUUID()};
 return {contact,tpl,p};
}
test('normalization accepts local/explicit international and rejects guessed international and letters',()=>{
 for(const x of ['3035550122','(303) 555-0122','1-303-555-0122','+1 303 555 0122','0013035550122'])assert.equal(canonicalPhone(x),phone);
 assert.equal(canonicalPhone('0044 20 7946 0958'),'+442079460958');for(const x of ['442079460958','call3035550122','+03035550122','++13035550122'])assert.throws(()=>canonicalPhone(x));
});
test('contact upserts preserve details and consent, explicit revisions allow clearing, sources retained',async()=>{
 const db=await setupCoordination();try{
 await call(db,'api_action','admin',tenant,'contact',{phone,name:'Jane',email:'jane@example.test',source:'manual',metadata:{known:true}});
 await call(db,'api_action','admin',tenant,'contact',{phone,source:'integration',metadata:{new:true}});
 let c=(await db.query('select * from public.sms_contacts where tenant_id=$1 and phone=$2',[tenant,phone])).rows[0];assert.equal(c.name,'Jane');assert.equal(c.email,'jane@example.test');assert.deepEqual(c.metadata,{known:true,new:true});assert.equal(c.marketing_consent,true);
 await api(db,'edit',{contactId:c.id,revision:c.revision,name:'',email:''});await assert.rejects(api(db,'edit',{contactId:c.id,revision:c.revision,name:'stale'}),/changed/);
 assert.equal((await db.query('select name from public.sms_contacts where id=$1',[c.id])).rows[0].name,'');
 const read=await api(db,'read',{contactId:c.id});assert.ok(read.sources.includes('manual'));assert.ok(read.sources.includes('integration'));
 }finally{await db.close();}
});
test('direct snapshot, overlap choice, idempotency and scoped permissions',async()=>{
 const db=await setupCoordination();try{const {contact,tpl,p}=await directSetup(db);const existing=await addRun(db);
 await assert.rejects(api(db,'enroll',p),/overlaps/);const overview=await api(db,'read',{contactId:contact.id});p.overlaps=overview.overlaps;
 await assert.rejects(api(db,'enroll',p),/Choose/);p.overlapChoice='keep';const first=await api(db,'enroll',p);const second=await api(db,'enroll',p);assert.equal(first.run.id,second.run.id);assert.equal(first.run.form_id,null);
 await api(db,'publish',{id:tpl.id,revision:tpl.revision,name:'Changed template',sequence:{...sequence(),steps:[{...sequence().steps[0],body:'New copy'}]}});
 assert.equal((await db.query('select direct_sequence from sms_private.form_runs where id=$1',[first.run.id])).rows[0].direct_sequence.steps[0].body,sequence().steps[0].body);
 await assert.rejects(call(db,'contact_automations','outsider',tenant,'read',{contactId:contact.id}),/access|reader|permission/i);
 await assert.rejects(api(db,'enroll',{...p,context:'changed'}),/Idempotency/);
 assert.equal((await db.query('select status from sms_private.form_runs where id=$1',[existing.id])).rows[0].status,'active');
 }finally{await db.close();}
});
test('direct runs schedule and send, block cancels queued send and forbids new enrollment',async()=>{
 const db=await setupCoordination();try{const {contact,p}=await directSetup(db);const r=(await api(db,'enroll',p)).run;const {out}=await queuedForm(db);assert.ok(out.messageId);
 let c=(await api(db,'read',{contactId:contact.id})).contact;await api(db,'block',{contactId:c.id,revision:c.revision,blocked:true});
 const send=await call(db,'claim','sms_send_jobs','test-sender');assert.equal(await call(db,'begin_submission',send.id,send.lease_token),null);
 await assert.rejects(api(db,'enroll',{...p,idempotencyKey:crypto.randomUUID()}),/blocked/);
 c=(await api(db,'read',{contactId:contact.id})).contact;await api(db,'block',{contactId:c.id,revision:c.revision,blocked:false});assert.equal((await db.query('select status from sms_private.form_runs where id=$1',[r.id])).rows[0].status,'stopped');
 }finally{await db.close();}
});
test('any reply applies direct Pause/Stop without attributing an ambiguous response to every run',async()=>{
 const db=await setupCoordination();try{let x=await directSetup(db,'pause');const a=(await api(db,'enroll',x.p)).run;x=await directSetup(db,'stop');x.p.overlaps=(await api(db,'read',{contactId:x.contact.id})).overlaps;x.p.overlapChoice='keep';const b=(await api(db,'enroll',x.p)).run;
 for(const r of [a,b]){const out=await call(db,'outbox',tenant,crypto.randomUUID(),{phone,body:'Still interested?',purpose:'marketing'});await db.query("update public.sms_messages set meta=meta||jsonb_build_object('form_run_id',$2::text),provider_accepted_at=now() where id=$1",[out.messageId,r.id]);}
 await incoming(db,'yes','same-inbound');await incoming(db,'yes','same-inbound');const states=(await db.query('select status,generation from sms_private.form_runs order by created_at')).rows;assert.deepEqual(states.map(x=>x.status),['paused','stopped']);assert.ok(states.every(x=>x.generation===2));
 assert.equal((await db.query('select count(*) n from sms_private.activity_responses')).rows[0].n,0);
 const report=await call(db,'automation_activity','admin',tenant,'report',{});assert.equal(report.funnel.contacted,0);assert.equal(report.directFunnel.contacted,2);assert.equal(report.total,2);
 }finally{await db.close();}
});
test('Continue quiet window, direct AI context, appointment independence and shadow actions',async()=>{
 const db=await setupCoordination({mode:'shadow'});try{const {contact,p}=await directSetup(db,'continue');const r=(await api(db,'enroll',p)).run;const j=await incoming(db,'No thanks, not interested');
 const ctx=await call(db,'inbound_ai_context',j.id,j.lease_token);assert.ok(JSON.stringify(ctx).includes('Direct request'));
 await invoke(db,j,'close_enquiry',{requestRef:r.id,declineQuote:'not interested'});assert.equal((await db.query('select status from sms_private.form_runs where id=$1',[r.id])).rows[0].status,'active');
 assert.equal((await queuedForm(db)).out,null);const appt=await addRun(db,{appointment:true});let c=(await api(db,'read',{contactId:contact.id})).contact;await api(db,'block',{contactId:c.id,revision:c.revision,blocked:true});assert.equal((await db.query('select status from sms_private.form_runs where id=$1',[appt.id])).rows[0].status,'active');
 }finally{await db.close();}
});

test('confirmed direct booking and crash recovery link one booking and stop only that request',async()=>{
 const {details,accepted,runState}=await import('./helpers/coordination.js');const db=await setupCoordination();try{
 const {p}=await directSetup(db,'continue');const a=(await api(db,'enroll',p)).run;const other=await addRun(db,{title:'Other enquiry'});
 let j=await incoming(db,'Please book the Direct request');await invoke(db,j,'prepare_booking',{...details(),requestRef:a.id});const out=await call(db,'complete_inbound_ai',j.id,j.lease_token,{reply:'unused'});await accepted(db,out.messageId);
 j=await incoming(db,'YES');const booked=await invoke(db,j,'confirm_booking');assert.equal(booked.status,'confirmed');assert.equal((await runState(db,a)).status,'stopped');assert.equal((await runState(db,other)).status,'active');
 await call(db,'fail_inbound_ai',j.id,j.lease_token,{code:'CRASH',transient:false});assert.equal((await db.query('select count(*) n from public.sms_bookings')).rows[0].n,1);assert.equal((await db.query('select count(*) n from sms_private.activity_bookings where run_id=$1',[a.id])).rows[0].n,1);
 }finally{await db.close();}
});
test('explicit staff booking attribution stops direct run; cancelled booking removes conversion',async()=>{
 const db=await setupCoordination();try{const {p,contact}=await directSetup(db);const r=(await api(db,'enroll',p)).run;
 await db.query("insert into public.sms_bookings(tenant_id,id,contact_id,customer_phone,status,appointment_at,source) values($1,'staff-booking',$2,$3,'confirmed',now()+interval '1 day','staff')",[tenant,contact.id,phone]);
 await call(db,'automation_activity','admin',tenant,'booking_link',{runId:r.id,bookingId:'staff-booking',revision:0});assert.equal((await db.query('select status from sms_private.form_runs where id=$1',[r.id])).rows[0].status,'stopped');
 await db.query("update public.sms_bookings set status='cancelled' where id='staff-booking'");assert.equal((await db.query("select source from public.sms_bookings where id='staff-booking'")).rows[0].source,'staff');
 }finally{await db.close();}
});

test('late provider acceptance after staff stop preserves reconciliation without scheduling another send',async()=>{
 const db=await setupCoordination();try{const {p,contact}=await directSetup(db);const r=(await api(db,'enroll',p)).run;await queuedForm(db);const send=await call(db,'claim','sms_send_jobs','sender');const attempt=await call(db,'begin_submission',send.id,send.lease_token);assert.ok(attempt.attempt_id);
 await api(db,'run',{contactId:contact.id,runId:r.id,generation:r.generation,operation:'stop'});await call(db,'accept_submission',send.id,send.lease_token,attempt.attempt_id,'SM'+'f'.repeat(32));
 const after=(await db.query('select status,next_run_at,send_index from sms_private.form_runs where id=$1',[r.id])).rows[0];assert.equal(after.status,'stopped');assert.equal(after.next_run_at,null);assert.equal(after.send_index,1);
 }finally{await db.close();}
});
