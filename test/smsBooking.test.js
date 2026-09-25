import test from 'node:test';
import assert from 'node:assert/strict';
import {testDatabase,call} from './helpers/database.js';

const weekly=Object.fromEntries(Array.from({length:7},(_,i)=>[String(i),[{start:'00:00',end:'23:59'}]]));
const settings={enabled:true,slotDurationMinutes:60,capacityPerSlot:1,minimumNoticeMinutes:0,maximumAdvanceDays:90,weeklyAvailability:weekly,dateExceptions:[],extraFields:[{key:'service_type',question:'What service do you need?',type:'single_select',required:true,options:['Repair','Install']}]};
const reminderRule='{"anchor":"appointment","firstDelayCount":0,"firstDelayUnit":"day","intervalCount":6,"intervalUnit":"hour","repeatCount":1,"leadHours":24,"startHour":0,"endHour":24}';
const inboundRule='{"anchor":"enrollment","firstDelayCount":1,"firstDelayUnit":"day","intervalCount":1,"intervalUnit":"day","repeatCount":1,"leadHours":null,"startHour":0,"endHour":24}';

test('booking configuration is versioned, validated, and tenant scoped',async()=>{
 const db=await testDatabase();try{
  await db.exec("insert into public.sms_businesses(tenant_id,name,time_zone) values('alpha','Alpha','UTC'),('beta','Beta','UTC')");
  const saved=await call(db,'save_booking_settings','admin','alpha',settings);
  assert.equal(saved.enabled,true);assert.equal(saved.version,1);assert.equal(saved.extraFields[0].key,'service_type');
  const lateSlot=(await db.query(`select sms_private.booking_slot_open(
    'alpha', (now() at time zone 'UTC')::date+10, '23:30'::time,
    s, 'UTC') as open from public.sms_booking_settings s where tenant_id='alpha'`)).rows[0];
  assert.equal(lateSlot.open,false,'a slot must fit before the daily closing time');
  const beta=await call(db,'booking_settings','admin','beta');assert.equal(beta.enabled,false);assert.deepEqual(beta.extraFields,[]);
  const updated=await call(db,'save_booking_settings','admin','alpha',{...settings,capacityPerSlot:2});assert.equal(updated.version,2);assert.equal(updated.capacityPerSlot,2);
  await assert.rejects(call(db,'save_booking_settings','admin','alpha',{...settings,extraFields:[{key:'bad key',question:'Bad?',type:'short_text'}]}),/Invalid extra booking field/);
  const lateOnly=Object.fromEntries(Array.from({length:7},(_,i)=>[String(i),[{start:'23:00',end:'23:59'}]]));
  await call(db,'save_booking_settings','admin','alpha',{...settings,weeklyAvailability:lateOnly});
  const alternatives=(await db.query("select sms_private.booking_alternatives('alpha',s,'UTC') as times from public.sms_booking_settings s where tenant_id='alpha'")).rows[0];
  assert.equal(alternatives.times,'','a window shorter than a slot must yield no alternatives');
 }finally{await db.close();}
});

test('SMS booking waits for confirmation, books once, enforces capacity, and enrolls a reminder',async()=>{
 const db=await testDatabase();try{
  await db.exec(`insert into public.sms_businesses(tenant_id,name,time_zone) values('alpha','Alpha','UTC'); insert into public.sms_contacts(tenant_id,phone,name) values('alpha','+15550000001','Alex'),('alpha','+15550000002','Blair'); insert into public.sms_automation_groups(tenant_id,id,name,kind,rule) values('alpha','reminders','Appointment reminder','reminder','${reminderRule}'::jsonb)`);
  await call(db,'save_booking_settings','admin','alpha',settings);
  const day=(await db.query("select ((now() at time zone 'UTC')+interval '10 days')::date as booking_day")).rows[0].booking_day.toISOString().slice(0,10);
  const contacts=(await db.query("select id,phone from public.sms_contacts where tenant_id='alpha' order by phone")).rows;
  const makeJob=async(contact,generation,key)=>{
   const payload={phone:contact.phone,generation,group_id:'inbound'};
   return (await db.query("insert into sms_private.jobs(tenant_id,queue,dedupe_key,payload,status,lease_token,leased_until) values('alpha','ai_reply_jobs',$1,$2,'leased',gen_random_uuid(),now()+interval '1 minute') returning *",[key,JSON.stringify(payload)])).rows[0];
  };
  const patch={name:'Alex',address:'1 Main St',localDate:day,localTime:'12:00',dateTimeAmbiguous:false,extraAnswers:[{fieldKey:'service_type',value:'Repair'}]};
  const job=await makeJob(contacts[0],1,'collect');
  const staged=(await db.query("select sms_private.apply_booking_ai(j,$2::jsonb,$3::uuid) value from sms_private.jobs j where id=$1",[job.id,JSON.stringify({bookingIntent:'start',bookingPatch:patch}),contacts[0].id])).rows[0].value;
  assert.equal(staged.state,'awaiting_confirmation');assert.match(staged.reply,/Reply YES/);
  assert.equal((await db.query("select count(*) n from public.sms_bookings where tenant_id='alpha'")).rows[0].n,0);
  const confirmJob=await makeJob(contacts[0],2,'confirm');
  const confirmed=(await db.query("select sms_private.apply_booking_ai(j,$2::jsonb,$3::uuid) value from sms_private.jobs j where id=$1",[confirmJob.id,JSON.stringify({bookingIntent:'confirm',bookingPatch:{name:null,address:null,localDate:null,localTime:null,dateTimeAmbiguous:false,extraAnswers:[]}}),contacts[0].id])).rows[0].value;
  assert.equal(confirmed.state,'confirmed');assert.match(confirmed.reply,/Booked!/);
  const booking=(await db.query("select * from public.sms_bookings where tenant_id='alpha'")).rows[0];assert.equal(booking.customer_phone,'+15550000001');assert.equal(booking.extra_answers.service_type,'Repair');assert.equal(booking.status,'confirmed');
  assert.equal((await db.query("select count(*) n from public.sms_automation_enrollments where tenant_id='alpha' and metadata->>'booking_id'=$1",[booking.id])).rows[0].n,1);
  const competing=await makeJob(contacts[1],1,'competing');
  const unavailable=(await db.query("select sms_private.apply_booking_ai(j,$2::jsonb,$3::uuid) value from sms_private.jobs j where id=$1",[competing.id,JSON.stringify({bookingIntent:'start',bookingPatch:{...patch,name:'Blair'}}),contacts[1].id])).rows[0].value;
  assert.equal(unavailable.state,'unavailable');
 }finally{await db.close();}
});

test('staff cancellation is idempotent and cancels pending reminders',async()=>{
 const db=await testDatabase();try{
  await db.exec(`insert into public.sms_businesses(tenant_id,name) values('alpha','Alpha'); insert into public.sms_contacts(tenant_id,phone) values('alpha','+15550000001'); insert into public.sms_automation_groups(tenant_id,id,name,kind,rule) values('alpha','reminders','Reminder','reminder','${reminderRule}'::jsonb); insert into public.sms_bookings(tenant_id,id,contact_id,appointment_at,status,customer_phone,source,confirmed_at) select 'alpha','book-1',id,now()+interval '2 days','confirmed',phone,'sms_ai',now() from public.sms_contacts where tenant_id='alpha'; insert into public.sms_automation_enrollments(tenant_id,contact_id,category_id,appointment_at,next_run_at,metadata) select 'alpha',id,'reminders',now()+interval '2 days',now(),'{\"booking_id\":\"book-1\"}' from public.sms_contacts where tenant_id='alpha'`);
  const first=await call(db,'cancel_booking','admin','alpha','book-1','cancel-key-123');assert.equal(first.status,'cancelled');
  const second=await call(db,'cancel_booking','admin','alpha','book-1','cancel-key-123');assert.equal(second.status,'cancelled');
  assert.equal((await db.query("select status from public.sms_automation_enrollments where tenant_id='alpha'")).rows[0].status,'cancelled');
 }finally{await db.close();}
});

test('unfinished bookings enqueue bounded deduplicated AI follow-ups',async()=>{
 const db=await testDatabase();try{
  await db.exec(`insert into public.sms_businesses(tenant_id,name,time_zone,status,sending_enabled) values('alpha','Alpha','UTC','active',true); insert into public.sms_contacts(tenant_id,phone) values('alpha','+15550000001'); insert into public.sms_thread_contacts(tenant_id,phone,generation) values('alpha','+15550000001',7); insert into public.sms_automation_groups(tenant_id,id,name,rule) values('alpha','inbound','Inbound','${inboundRule}'::jsonb); insert into public.sms_ai_settings(tenant_id,group_id,enabled,default_for_inbound) values('alpha','inbound',true,true); insert into public.sms_business_ai_settings(tenant_id,enabled,system_prompt) values('alpha',true,'Follow up on unfinished bookings.'); update sms_private.runtime set scheduler_enabled=true`);
  const saved=await call(db,'save_booking_settings','admin','alpha',{...settings,followUpEnabled:true,followUpDelayHours:1,followUpIntervalHours:2,followUpMaxAttempts:2});
  assert.equal(saved.followUpEnabled,true);assert.equal(saved.followUpMaxAttempts,2);
  await db.exec("insert into public.sms_booking_sessions(tenant_id,contact_id,customer_phone,settings_version,conversation_generation) select 'alpha',id,phone,1,7 from public.sms_contacts where tenant_id='alpha'; update public.sms_booking_sessions set next_follow_up_at=now()-interval '1 minute' where tenant_id='alpha'");
  assert.equal((await db.query('select sms_private.queue_booking_followups() n')).rows[0].n,1);
  const job=(await db.query("select * from sms_private.jobs where tenant_id='alpha' and queue='ai_reply_jobs'")).rows[0];
  assert.equal(job.payload.booking_follow_up,true);assert.equal(job.payload.generation,7);assert.equal(job.payload.follow_up_number,1);assert.equal(job.payload.group_id,'');
  assert.equal((await db.query('select sms_private.queue_booking_followups() n')).rows[0].n,0);
  const session=(await db.query("select * from public.sms_booking_sessions where tenant_id='alpha'")).rows[0];assert.equal(session.follow_up_count,1);assert.ok(session.next_follow_up_at);
 }finally{await db.close();}
});

