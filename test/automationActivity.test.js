import test from 'node:test';
import assert from 'node:assert/strict';
import {call,testDatabase} from './helpers/database.js';
import {setupCoordination,addRun,incoming,accepted,tenant,phone,invoke} from './helpers/coordination.js';
import {activityQuery,activityRate} from '../public/automationActivity.js';
const report=(db,p={})=>call(db,'automation_activity','admin',tenant,'report',p);
async function send(db,r,key=crypto.randomUUID(),at=null){const o=await call(db,'outbox',tenant,key,{phone,body:'Still interested?',purpose:'marketing'});await db.query("update public.sms_messages set meta=meta||jsonb_build_object('form_run_id',$2::text),provider_accepted_at=coalesce($3::timestamptz,clock_timestamp()),status='accepted' where id=$1",[o.messageId,r.id,at]);return o.messageId;}
async function booking(db,id='existing'){await db.query("insert into public.sms_bookings(tenant_id,id,contact_id,customer_phone,appointment_at,status,source) select $1,$2,id,phone,now()+interval '1 day','confirmed','staff' from public.sms_contacts where tenant_id=$1 and phone=$3",[tenant,id,phone]);return id;}
test('accepted/delivered dedupe, distinct attributed funnel and current cancellation',async()=>{
 const db=await setupCoordination();try{const r=await addRun(db),id=await send(db,r);await accepted(db,id);await db.query("update public.sms_messages set status='delivered' where id=$1",[id]);await db.query("update public.sms_messages set status='delivered' where id=$1",[id]);
 await incoming(db,'Yes please');await incoming(db,'Can you help tomorrow?');await booking(db);
 await call(db,'automation_activity','admin',tenant,'booking_link',{runId:r.id,bookingId:'existing',revision:0});
 let x=await report(db);assert.equal(x.activity.accepted,1);assert.equal(x.activity.delivered,1);assert.equal(x.activity.responses,2);assert.equal(x.funnel.contacted,1);assert.equal(x.funnel.responded,1);assert.equal(x.funnel.booked,1);assert.equal(x.funnel.conversionRate,100);
 await db.query("update public.sms_bookings set status='cancelled' where id='existing'");x=await report(db);assert.equal(x.funnel.booked,0);assert.equal(x.funnel.cancelled,1);
 const timeline=await call(db,'automation_activity','admin',tenant,'timeline',{runId:r.id});assert.ok(timeline.events.some(e=>e.kind==='booking_state'));assert.equal(timeline.bookings[0].channel,'staff');
 }finally{await db.close();}
});
test('multiple contacted forms stay ambiguous; explicit response and booking corrections count once',async()=>{
 const db=await setupCoordination();try{const a=await addRun(db),b=await addRun(db,{title:'Moving'});await send(db,a);await send(db,b);await incoming(db,'yes');
 let x=await report(db);assert.equal(x.funnel.responded,0);const unlinked=await call(db,'automation_activity','admin',tenant,'unlinked',{});const reply=unlinked.rows.find(x=>x.kind==='customer_response');assert.equal(reply.candidates.length,2);
 await call(db,'automation_activity','admin',tenant,'response_link',{runId:a.id,messageId:reply.details.messageId,revision:0});await booking(db);
 await call(db,'automation_activity','admin',tenant,'booking_link',{runId:a.id,bookingId:'existing',revision:0});
 await call(db,'automation_activity','admin',tenant,'booking_link',{runId:b.id,bookingId:'existing',revision:1});
 await assert.rejects(call(db,'automation_activity','admin',tenant,'booking_link',{runId:a.id,bookingId:'existing',revision:1}),/changed/);
 x=await report(db);assert.equal(x.funnel.booked,1);assert.equal(x.funnel.responded,1);assert.equal(x.funnel.conversionRate,50);
 }finally{await db.close();}
});
test('business local DST boundaries, first-contact cohort and zero denominators',async()=>{
 const db=await setupCoordination();try{await db.query("update public.sms_businesses set time_zone='America/Denver' where tenant_id=$1",[tenant]);const a=await addRun(db),b=await addRun(db);await send(db,a,'a','2026-03-08T07:00:00Z');await send(db,b,'b','2026-03-09T06:00:00Z');await send(db,a,'a2','2026-03-09T12:00:00Z');
 const x=await report(db,{from:'2026-03-08',to:'2026-03-08'});assert.equal(x.funnel.contacted,1);assert.equal(x.activity.accepted,1);
 const y=await report(db,{from:'2026-03-09',to:'2026-03-09'});assert.equal(y.funnel.contacted,1);assert.equal(y.activity.accepted,2);
 const z=await report(db,{from:'2026-03-10',to:'2026-03-10'});assert.equal(z.funnel.responseRate,null);assert.equal(z.funnel.conversionRate,null);
 }finally{await db.close();}
});
test('tag filters combine OR within tags, AND across categories; archive and edit revisions',async()=>{
 const db=await setupCoordination();try{const a=await addRun(db),b=await addRun(db,{title:'Moving'});const tags=[];for(const name of ['Priority','West'])tags.push((await call(db,'automation_activity','admin',tenant,'tag',{name})).tag);
 for(let i=0;i<2;i++)await call(db,'automation_activity','admin',tenant,'tag_assignment',{runId:[a,b][i].id,tagId:tags[i].id,present:true});
 assert.equal((await report(db,{tags:tags.map(t=>t.id).join(',')})).total,2);assert.equal((await report(db,{tags:tags.map(t=>t.id).join(','),form:a.form_id})).total,1);
 await call(db,'automation_activity','admin',tenant,'tag',{id:tags[0].id,revision:1,name:'Important'});await assert.rejects(call(db,'automation_activity','admin',tenant,'tag',{id:tags[0].id,revision:1,archived:true}),/changed/);
 await assert.rejects(call(db,'automation_activity','outsider',tenant,'tag',{name:'No'}),/access|Access|reader|permission/i);
 }finally{await db.close();}
});
test('shadow, test and reminder isolation; STOP and independent pause controls',async()=>{
 const db=await setupCoordination({mode:'shadow'});try{const r=await addRun(db),appt=await addRun(db,{appointment:true}),tr=await addRun(db,{title:'Test'});await db.query("update sms_private.form_runs set test_sequence=sms_private.form_run_sequence(form_runs),version=null,test_actor='admin',test_request='{}' where id=$1",[tr.id]);for(const run of [r,appt,tr])await send(db,run);
 const j=await incoming(db,'No thanks, not interested in the Junk enquiry.');await invoke(db,j,'close_enquiry',{requestRef:r.id,declineQuote:'not interested'});
 assert.equal((await report(db)).funnel.contacted,1);assert.equal((await report(db,{scope:'appointment'})).funnel.contacted,0);assert.equal((await report(db,{scope:'test'})).total,1);
 const shadow=await call(db,'automation_activity','admin',tenant,'unlinked',{shadow:'true'});assert.ok(shadow.rows.every(e=>e.simulated));assert.ok(shadow.rows.length);
 await call(db,'automation_activity','admin',tenant,'sequence',{runId:r.id,generation:1,operation:'pause'});let x=await report(db);assert.equal(x.rows.find(x=>x.id===r.id).ai_paused,false);
 await db.query('update public.sms_contacts set opted_out=true where tenant_id=$1 and phone=$2',[tenant,phone]);await assert.rejects(call(db,'automation_activity','admin',tenant,'sequence',{runId:r.id,generation:(await db.query('select generation from sms_private.form_runs where id=$1',[r.id])).rows[0].generation,operation:'resume'}),/STOP/);
 }finally{await db.close();}
});
test('query encoding and null rates',()=>{assert.equal(activityRate(null),'—');assert.equal(activityRate(0),'0%');assert.match(activityQuery({search:'+1 & name',tags:'a,b',status:''}),/search=%2B1/);});

test('historical delivery and status snapshots do not invent transition times or reply attribution',async()=>{
 let run;const db=await testDatabase({beforeMigration:async(db,file)=>{if(!file.endsWith('_automation_activity.sql'))return;
 await db.exec("insert into sms_private.admins values('admin') on conflict do nothing");
 await call(db,'api_action','admin',null,'create_business',{id:tenant,name:'Historic',timeZone:'UTC'});
 await db.query('insert into public.sms_contacts(tenant_id,phone,name) values($1,$2,$3)',[tenant,phone,'Historic Customer']);run=await addRun(db);
 await db.query("insert into public.sms_messages(tenant_id,contact_phone,direction,body,status,provider_accepted_at,meta) values($1,$2,'outbound','Historical message','delivered',now(),jsonb_build_object('form_run_id',$3::text))",[tenant,phone,run.id]);
 await db.query("insert into public.sms_messages(tenant_id,contact_phone,direction,body,status) values($1,$2,'inbound','Yes','received')",[tenant,phone]);
 }});try{const x=await report(db);assert.equal(x.funnel.contacted,1);assert.equal(x.funnel.responded,0);assert.equal(x.activity.delivered,0);
 const d=await call(db,'automation_activity','admin',tenant,'timeline',{runId:run.id});assert.equal(d.events.find(e=>e.kind==='message_delivered').occurred_at,null);assert.equal(d.events.find(e=>e.kind==='historical_status_snapshot').occurred_at,null);
 assert.equal((await call(db,'automation_activity','admin',tenant,'unlinked',{})).total,1);
 }finally{await db.close();}
});

test('cross-business and cross-customer attribution denied; private reporting storage inaccessible',async()=>{
 const db=await setupCoordination();try{const a=await addRun(db);await call(db,'api_action','admin',null,'create_business',{id:'other',name:'Other',timeZone:'UTC'});const foreign=await addRun(db,{business:'other'});
 await assert.rejects(call(db,'automation_activity','admin',tenant,'timeline',{runId:foreign.id}),/not found/);
 await booking(db);await db.query("update public.sms_bookings set customer_phone='+13035550999' where tenant_id=$1",[tenant]);await assert.rejects(call(db,'automation_activity','admin',tenant,'booking_link',{runId:a.id,bookingId:'existing',revision:0}),/Same-business/);
 for(const role of ['anon','authenticated','sms_api']){const q=await db.query("select has_table_privilege($1,'sms_private.activity_events','select') allowed",[role]);assert.equal(q.rows[0].allowed,false);}
 }finally{await db.close();}
});
