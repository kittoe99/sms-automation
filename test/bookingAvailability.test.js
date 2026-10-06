import test from 'node:test';
import assert from 'node:assert/strict';
import {testDatabase,call} from './helpers/database.js';
import {createBookingHandler} from '../supabase/functions/voice-booking/handler.js';
import {createCrmHandler} from '../supabase/functions/crm-api/handler.js';
import {hmac} from '../supabase/functions/voice-agent/handler.js';
import {validateSchedule,voiceDraft} from '../public/bookingSetup.js';
const tenant='biz-1c0c09ce-819e-4795-86b9-0e457ab92f58',phone='+13035550122',cid='booking-call-123';
const hours=Object.fromEntries(Array.from({length:7},(_,i)=>[i,[{start:'09:00',end:'12:00'},{start:'13:00',end:'17:00'}]]));
const day=new Date(Date.now()+3*86400000).toISOString().slice(0,10);
const rule=()=>({service:'junk_removal',variant:'',market:'Test',zipCodes:['80231'],timeZone:'UTC',resourcePool:'crew',enabled:true,durationMinutes:60,capacity:1,minimumNoticeMinutes:0,maximumAdvanceDays:90,weeklyAvailability:structuredClone(hours),dateExceptions:[]});
async function setup(){const db=await testDatabase();await call(db,'api_action','admin',null,'create_business',{id:tenant,name:'Booking test',timeZone:'UTC'});await db.query("update sms_private.providers set from_number='+18777574365' where tenant_id=$1",[tenant]);return db;}
async function rpc(db,name,...args){return (await db.query(`select voice_booking_api.${name}(${args.map((_,i)=>'$'+(i+1)).join(',')}) as result`,args.map(x=>typeof x==='object'?JSON.stringify(x):x))).rows[0].result;}
async function verify(db,callId=cid){await db.query("insert into sms_private.voice_otps(tenant_id,call_id,phone,code_hash,expires_at,verified_at) values($1,$2,$3,$4,now()+interval '5 minutes',now())",[tenant,callId,phone,'a'.repeat(64)]);}
const details=()=>({service:'junk_removal',variant:'',zip:'80231',localDate:day,localTime:'10:00',phone,name:'Test customer',address:'123 Test Street',details:{}});

test('agent schedules and dumpster bookings need neither ZIP coverage nor size',async()=>{
 const db=await setup();try{
  const draft={...rule(),service:'dumpster_rental',durationMinutes:1440};delete draft.variant;delete draft.zipCodes;
  const saved=await call(db,'voice_save_rule','admin',tenant,draft);
  assert.equal(saved.variant,'');assert.deepEqual(saved.zip_codes,[]);
  await assert.rejects(()=>call(db,'voice_save_rule','admin',tenant,{...draft,market:'Other'}),/one schedule/);
  await call(db,'voice_save_rule','admin',tenant,{...draft,market:'Other',enabled:false});
  const availability=await rpc(db,'availability',tenant,cid,{service:'dumpster_rental',localDate:day});
  assert.equal(availability.configured,true);assert.ok(availability.slots.some(s=>s.localTime==='10:00'));
  const preview=await call(db,'preview_booking_availability','admin',tenant,{channel:'voice',localDate:day,rule:draft});
  assert.equal(preview.slots.find(s=>s.localTime==='10:00').available,true);
  await verify(db);const input={...details(),service:'dumpster_rental'};delete input.zip;delete input.variant;
  const prepared=await rpc(db,'prepare',tenant,cid,input);assert.equal(prepared.available,true);
  const confirmed=await rpc(db,'confirm',tenant,cid,prepared.holdId);assert.equal(confirmed.status,'confirmed');
  assert.equal((await rpc(db,'confirm',tenant,cid,prepared.holdId)).bookingId,confirmed.bookingId);
  const booking=(await db.query('select extract(epoch from voice_end_at-appointment_at)/3600 as hours,service_address from public.sms_bookings where id=$1',[confirmed.bookingId])).rows[0];
  assert.equal(Number(booking.hours),24);assert.equal(booking.service_address,'123 Test Street');
  assert.equal((await rpc(db,'availability',tenant,cid,{service:'dumpster_rental',localDate:day})).slots.some(s=>s.localTime==='10:00'),false);
 }finally{await db.close();}
});

test('schedule validation and draft mapping preserve split days and reject invalid hours',()=>{
 const draft=voiceDraft({weekly_availability:hours,date_exceptions:[{date:day,closed:false,windows:hours[0]}]});
 assert.equal(draft.weeklyAvailability[0].length,2);validateSchedule(draft.weeklyAvailability,draft.dateExceptions);
 assert.throws(()=>validateSchedule({0:[{start:'10:00',end:'12:00'},{start:'11:00',end:'13:00'}]},[]),/overlap/);
 assert.throws(()=>validateSchedule({},[{date:'2026-02-30',closed:true,windows:[]}]),/calendar/);
});

test('preview, strict validation, exceptions and DST use database scheduling without writes',async()=>{
 const db=await setup();try{
  const r=rule();
  let preview=await call(db,'preview_booking_availability','admin',tenant,{channel:'voice',localDate:day,rule:r});
  assert.equal(preview.slots.find(x=>x.localTime==='11:15').available,false);
  assert.equal(preview.slots.some(x=>x.localTime==='12:00'),false);
  assert.equal(preview.slots.find(x=>x.localTime==='13:00').remainingCapacity,1);
  const sms={slotDurationMinutes:60,capacityPerSlot:1,minimumNoticeMinutes:0,maximumAdvanceDays:90,weeklyAvailability:hours,dateExceptions:[]};
  preview=await call(db,'preview_booking_availability','admin',tenant,{channel:'sms',localDate:day,settings:sms});
  assert.equal(preview.hypothetical,true);assert.equal(preview.slots.length,7);
  for(const bad of [{slotDurationMinutes:14},{capacityPerSlot:1.5},{maximumAdvanceDays:731}])await assert.rejects(()=>call(db,'save_booking_settings','admin',tenant,{...sms,...bad}),/must be|whole number/);
  await assert.rejects(()=>call(db,'preview_booking_availability','stranger',tenant,{channel:'sms',localDate:day,settings:sms}));
  r.weeklyAvailability[0]=[{start:'09:00',end:'12:00'},{start:'11:00',end:'13:00'}];
  await assert.rejects(()=>call(db,'voice_save_rule','admin',tenant,r),/overlap/);
  r.weeklyAvailability=hours;r.dateExceptions=[{date:day,closed:true,windows:[]}];
  assert.equal((await call(db,'preview_booking_availability','admin',tenant,{channel:'voice',localDate:day,rule:r})).slots.length,0);
  r.dateExceptions=[{date:day,closed:false,windows:[{start:'14:00',end:'16:00'}]}];
  preview=await call(db,'preview_booking_availability','admin',tenant,{channel:'voice',localDate:day,rule:r});assert.equal(preview.slots[0].localTime,'14:00');
  r.dateExceptions.push(r.dateExceptions[0]);await assert.rejects(()=>call(db,'voice_save_rule','admin',tenant,r),/duplicate date/);
  const nextYear=new Date().getUTCFullYear()+1;let march=new Date(Date.UTC(nextYear,2,1));while(march.getUTCDay()!==0)march.setUTCDate(march.getUTCDate()+1);march.setUTCDate(march.getUTCDate()+7);
  const dstDay=march.toISOString().slice(0,10);
  const dst={...sms,maximumAdvanceDays:730,dateExceptions:[{date:dstDay,closed:false,windows:[{start:'01:00',end:'04:00'}]}]};
  await db.query("update public.sms_businesses set time_zone='America/Denver' where tenant_id=$1",[tenant]);
  preview=await call(db,'preview_booking_availability','admin',tenant,{channel:'sms',localDate:dstDay,settings:dst});assert.equal(preview.slots.find(s=>s.localTime==='02:00').available,false);
  assert.equal((await db.query('select count(*)::int n from public.sms_bookings')).rows[0].n,0);
  assert.equal((await db.query('select count(*)::int n from public.sms_booking_settings')).rows[0].n,0);
 }finally{await db.close();}
});

test('current business can book once, capacity and verification are enforced, roles stay narrow',async()=>{
 const db=await setup();try{
  const saved=await call(db,'voice_save_rule','admin',tenant,rule());assert.ok(saved.id);
  await assert.rejects(()=>rpc(db,'prepare',tenant,cid,details()),/verification required/);
  await verify(db);await verify(db,'booking-call-456');
  const a=await rpc(db,'prepare',tenant,cid,details()),b=await rpc(db,'prepare',tenant,'booking-call-456',details());
  assert.equal(a.available,true);assert.equal(b.available,true);
  await assert.rejects(()=>rpc(db,'confirm',tenant,'other-call',a.holdId));
  await assert.rejects(()=>rpc(db,'prepare',tenant,cid,{...details(),existingBookingId:'other'}),/Only new/);
  const confirmed=await rpc(db,'confirm',tenant,cid,a.holdId);assert.equal(confirmed.status,'confirmed');
  assert.equal((await rpc(db,'confirm',tenant,cid,a.holdId)).bookingId,confirmed.bookingId);
  await assert.rejects(()=>rpc(db,'confirm',tenant,'booking-call-456',b.holdId),/no longer available/);
  const available=await rpc(db,'availability',tenant,cid,{service:'junk_removal',zip:'80231',localDate:day});assert.equal(available.slots.some(s=>s.localTime==='10:00'),false);
  const preview=await call(db,'preview_booking_availability','admin',tenant,{channel:'voice',localDate:day,rule:rule()});assert.equal(preview.slots.find(s=>s.localTime==='10:00').remainingCapacity,0);
  assert.equal((await db.query('select count(*)::int n from public.sms_automation_bookings')).rows[0].n,1);
  assert.equal((await db.query('select count(*)::int n from public.sms_automation_enrollments')).rows[0].n,0);
  await db.exec('set role sms_voice_booking');
  await rpc(db,'availability',tenant,cid,{service:'junk_removal',zip:'80231',localDate:day});
  await assert.rejects(()=>rpc(db,'availability','opek',cid,{service:'junk_removal',zip:'80231',localDate:day}),/scope denied/);
  await assert.rejects(()=>db.query('select * from public.sms_bookings'),/permission denied/);
  await assert.rejects(()=>call(db,'voice_cancel_booking',tenant,cid,phone,confirmed.bookingId,'cancel-test'),/permission denied/);
  await db.exec('reset role; set role sms_voice_lookup');await assert.rejects(()=>rpc(db,'confirm',tenant,cid,a.holdId),/permission denied/);
 }finally{await db.close();}
});

test('stale and expired preparations cannot create appointments',async()=>{
 const db=await setup();try{
  const r=await call(db,'voice_save_rule','admin',tenant,rule());await verify(db);
  const a=await rpc(db,'prepare',tenant,cid,details());await call(db,'voice_save_rule','admin',tenant,{...rule(),id:r.id});
  await assert.rejects(()=>rpc(db,'confirm',tenant,cid,a.holdId),/no longer available/);
  const b=await rpc(db,'prepare',tenant,cid,details());await db.query("update sms_private.voice_booking_holds set expires_at=now()-interval '1 minute' where id=$1",[b.holdId]);
  await assert.rejects(()=>rpc(db,'confirm',tenant,cid,b.holdId),/expired/);
  assert.equal((await db.query('select count(*)::int n from public.sms_bookings')).rows[0].n,0);
 }finally{await db.close();}
});

test('booking gateway pins tenant, rejects broad writes, verifies HMAC and defaults disabled',async()=>{
 const calls=[],secret='s'.repeat(64),db={call:async(...args)=>{calls.push(args);return {slots:[]};}};
 const handler=createBookingHandler(db,{secret,enabled:true});
 const send=async(input,signature=true,target=handler)=>{const body=JSON.stringify(input),stamp=String(Math.floor(Date.now()/1000));return target(new Request('https://example.test/voice-booking',{method:'POST',headers:{'X-Voice-Timestamp':stamp,'X-Voice-Signature':signature?await hmac(secret,`${stamp}.${body}`):'0'.repeat(64)},body}));};
 const input={action:'availability',callId:cid,payload:{service:'junk_removal',zip:'80231',localDate:day}};
 assert.equal((await send(input)).status,200);assert.equal(calls[0][1],tenant);
 assert.equal((await send({...input,tenant:'other'})).status,400);
 assert.equal((await send({...input,action:'booking.cancel'})).status,400);
 assert.equal((await send({...input,action:'prepare',payload:{...details(),existingBookingId:'x'}})).status,400);
 assert.equal((await send(input,false)).status,401);
 assert.equal((await send(input,true,createBookingHandler(db,{secret}))).status,503);
 assert.equal(calls.length,1);
});

test('CRM preview dispatches the verified staff and requested business to the guarded RPC',async()=>{
 const calls=[];const handler=createCrmHandler({call:async(...args)=>{calls.push(args);return {slots:[]};}},async()=> 'admin');
 const response=await handler(new Request('https://example.test/functions/v1/crm-api/booking-availability/preview',{method:'POST',headers:{'X-Tenant-ID':tenant,'Content-Type':'application/json'},body:JSON.stringify({channel:'voice',localDate:day,rule:rule()})}));
 assert.equal(response.status,200);assert.deepEqual(calls[0].slice(0,3),['preview_booking_availability','admin',tenant]);
});
