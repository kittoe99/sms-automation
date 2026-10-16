import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './helpers/twilioConnections.js';
import {call} from './helpers/database.js';
import {toolOutputs} from '../src/mcp/tools.js';
import {bookingPermissions,bookingTools,bookingToolPermissions} from '../src/mcp/bookingSchemas.js';
const configuration={service:'junk_removal',market:'Denver',resourcePool:'crew',timeZone:'America/Denver',durationMinutes:60,capacity:2,minimumNoticeMinutes:0,maximumAdvanceDays:90,weeklyAvailability:Object.fromEntries(Array.from({length:7},(_,n)=>[String(n),[{start:'09:00',end:'17:00'}]])),dateExceptions:[]};
test('MCP bookings preserve scoped identities, independent grants, revisions, retries and no-send boundaries',async t=>{
 const {db,business,admin}=await fixture();
 try{
  const a=(await business('booking-a')).tenant,b=(await business('booking-b')).tenant,phone='+17208429167';
  for(const tenant of [a,b]){await call(db,'platform_action','staff','service_add',{tenantId:tenant,kind:'sms'});await db.query('insert into public.sms_contacts(tenant_id,phone,name) values($1,$2,$3)',[tenant,phone,'Synthetic']);}
  const ids={};for(const [tenant,id] of [[a,'booking-a'],[b,'booking-b']]){
   await db.query("insert into public.sms_bookings(tenant_id,id,contact_id,customer_phone,customer_name,appointment_at,status,voice_resource_pool,voice_end_at) select tenant_id,$2,id,phone,'PRIVATE NAME',now()+interval '3 days','confirmed','crew',now()+interval '3 days 1 hour' from public.sms_contacts where tenant_id=$1",[tenant,id]);
   ids[tenant]=(await db.query("insert into public.sms_automation_bookings(tenant_id,name,phone,details,status) values($1,'PRIVATE INTAKE',$2,'{\"request\":\"PRIVATE ANSWER\"}','requested') returning id",[tenant,phone])).rows[0].id;
  }
  const foreignRule=(await call(db,'voice_save_rule','staff',b,{...configuration,enabled:false})).id;
  const invoke=async(tool,p={})=>{const requestId=crypto.randomUUID(),r=(await db.query('select crm_mcp.invoke($1,$2,$3,$4,$5) r',['staff','booking-client',tool,JSON.stringify(p),requestId])).rows[0].r;if(r.ok)toolOutputs[tool].parse(r.data);return {...r,requestId};};
  const cid=(await invoke('crm_get_access')).data.connectionId;let gr=0;
  const grant=async(permissions=bookingPermissions.map(x=>x[0]).concat('contact_edit'),status='active')=>{gr=(await call(db,'mcp_admin','staff','save',{connectionId:cid,revision:gr,status,permissions,businessIds:[a]})).connection.revision;};
  const snapshot=async()=>{const o={};for(const table of ['public.sms_bookings','public.sms_automation_bookings','public.sms_voice_service_rules','public.sms_contacts','public.sms_messages','sms_private.jobs','sms_private.form_runs','sms_private.mcp_requests'])o[table]=(await db.query(`select to_jsonb(x) v from ${table} x order by to_jsonb(x)::text`)).rows;return o;};
  await t.test('every grant is independent and malformed raw schemas cannot bypass validation',async()=>{
   for(const [name] of bookingTools){await grant(bookingPermissions.map(x=>x[0]).filter(x=>x!==bookingToolPermissions[name]));const before=await snapshot();assert.equal((await invoke(name,{businessId:a})).error.code,'PERMISSION_DENIED',name);assert.deepEqual(await snapshot(),before);}
   await grant();for(const [name] of bookingTools)assert.equal((await invoke(name,{businessId:a,unknown:true})).error.code,'VALIDATION_ERROR');
   for(const p of [{pageSize:101},{page:0},{status:'other'},{page:'1'}])assert.equal((await invoke('crm_list_bookings',{businessId:a,...p})).error.code,'VALIDATION_ERROR');
  });
  await t.test('list counts and details scope before joins; reads never change records',async()=>{
   const before=await snapshot();const list=await invoke('crm_list_bookings',{businessId:a,pageSize:1});assert.equal(list.ok,true,JSON.stringify(list));assert.equal(list.data.total,1);assert.equal(list.data.bookings[0].id,'booking-a');
   assert.equal((await invoke('crm_get_booking',{businessId:a,bookingId:'booking-b'})).error.code,'PERMISSION_DENIED');
   const intake=await invoke('crm_list_booking_intakes',{businessId:a});assert.equal(intake.data.total,2);assert.ok(intake.data.intakes.some(x=>x.id===ids[a]));assert.ok(intake.data.intakes.every(x=>x.id!==ids[b]));
   assert.equal((await invoke('crm_get_booking_intake',{businessId:a,intakeId:ids[b]})).error.code,'PERMISSION_DENIED');
   assert.equal((await invoke('crm_get_booking_schedule',{businessId:a,scheduleId:foreignRule})).error.code,'PERMISSION_DENIED');
   assert.deepEqual(await snapshot(),before);
  });
  let schedule;
  await t.test('schedule creation stays inactive and retry-safe; edit cannot enable; activation is separate',async()=>{
   await grant(['booking_schedule_edit']);const p={businessId:a,configuration,idempotencyKey:crypto.randomUUID()},r=await invoke('crm_create_booking_schedule',p);assert.equal(r.ok,true,JSON.stringify(r));schedule=r.data;assert.equal(schedule.enabled,false);assert.deepEqual((await invoke('crm_create_booking_schedule',p)).data,r.data);
   const update={businessId:a,scheduleId:schedule.scheduleId,revision:schedule.revision,configuration:{...configuration,capacity:3},idempotencyKey:crypto.randomUUID()};
   assert.equal((await invoke('crm_update_booking_schedule',{...update,enabled:true})).error.code,'VALIDATION_ERROR');
   assert.equal((await invoke('crm_set_booking_schedule_enabled',{...update,configuration:undefined,enabled:true})).error.code,'PERMISSION_DENIED');
   const edited=await invoke('crm_update_booking_schedule',update);assert.equal(edited.ok,true,JSON.stringify(edited));schedule=edited.data;assert.equal(schedule.enabled,false);
   assert.equal((await invoke('crm_update_booking_schedule',{...update,idempotencyKey:crypto.randomUUID()})).error.code,'CONFLICT');
   await grant();const enabled=await invoke('crm_set_booking_schedule_enabled',{businessId:a,scheduleId:schedule.scheduleId,revision:schedule.revision,enabled:true,idempotencyKey:crypto.randomUUID()});assert.equal(enabled.ok,true,JSON.stringify(enabled));schedule=enabled.data;assert.equal(schedule.enabled,true);
  });
  await t.test('availability is a bounded pure preview with scope and revision checks',async()=>{
   const before=await snapshot();const p={businessId:a,scheduleId:schedule.scheduleId,revision:schedule.revision,localDate:new Date(Date.now()+5*86400000).toISOString().slice(0,10)};
   const r=await invoke('crm_preview_booking_availability',p);assert.equal(r.ok,true,JSON.stringify(r));assert.ok(r.data.slots.length>0);assert.equal(r.data.smsActive,false);
   assert.equal((await invoke('crm_preview_booking_availability',{...p,revision:p.revision+1})).error.code,'CONFLICT');assert.equal((await invoke('crm_preview_booking_availability',{...p,scheduleId:foreignRule})).error.code,'PERMISSION_DENIED');
   assert.deepEqual(await snapshot(),before);assert.equal((await invoke('crm_list_booking_schedules',{businessId:a,pageSize:1})).data.total,1);
  });
  await t.test('intake edits use shared revisions, preserve identity and do not create operational appointments',async()=>{
   const r=await invoke('crm_get_booking_intake',{businessId:a,intakeId:ids[a]});const p={businessId:a,intakeId:ids[a],revision:r.data.intake.revision,contactRevision:r.data.intake.contactRevision,name:'Updated synthetic',answers:[{key:'request',value:'Updated request'}],appointmentAt:null,status:'requested',idempotencyKey:crypto.randomUUID()};
   await grant(bookingPermissions.map(x=>x[0]));const deniedBefore=await snapshot();assert.equal((await invoke('crm_update_booking_intake',p)).error.code,'PERMISSION_DENIED');assert.deepEqual(await snapshot(),deniedBefore);await grant();
   const before=(await snapshot())['public.sms_bookings'];let result=await invoke('crm_update_booking_intake',p);assert.equal(result.ok,true,JSON.stringify(result));assert.equal(result.data.operationalBookingChanged,false);assert.deepEqual((await invoke('crm_update_booking_intake',p)).data,result.data);
   assert.deepEqual((await snapshot())['public.sms_bookings'],before);
   await db.query("update public.sms_automation_bookings set name='Worker update' where tenant_id=$1 and id=$2",[a,ids[a]]);
   assert.equal((await invoke('crm_update_booking_intake',{...p,revision:result.data.revision,idempotencyKey:crypto.randomUUID()})).error.code,'CONFLICT');
   assert.equal((await invoke('crm_update_booking_intake',{...p,phone:'+13035550123',idempotencyKey:crypto.randomUUID()})).error.code,'VALIDATION_ERROR');
  });
  await t.test('cancellation is revision fenced, transactional, scoped, retry-safe and audited without customer content',async()=>{
   const p={businessId:a,bookingId:'booking-a',revision:1,contactRevision:(await invoke('crm_get_booking',{businessId:a,bookingId:'booking-a'})).data.booking.contactRevision,idempotencyKey:crypto.randomUUID()};const before=await snapshot();
   await db.exec("create function sms_private.booking_test_audit_fail() returns trigger language plpgsql as $$begin raise exception 'audit failure' using errcode='XX000';end$$;create trigger booking_test_audit_fail before insert on sms_private.mcp_activity for each row execute function sms_private.booking_test_audit_fail();");
   await assert.rejects(()=>invoke('crm_cancel_booking',p));assert.deepEqual(await snapshot(),before);await db.exec('drop trigger booking_test_audit_fail on sms_private.mcp_activity;drop function sms_private.booking_test_audit_fail();');
   const r=await invoke('crm_cancel_booking',p);assert.equal(r.ok,true,JSON.stringify(r));assert.equal(r.data.status,'cancelled');assert.equal(r.data.messageQueued,false);assert.deepEqual((await invoke('crm_cancel_booking',p)).data,r.data);
   assert.equal((await invoke('crm_cancel_booking',{...p,idempotencyKey:crypto.randomUUID()})).error.code,'CONFLICT');
   assert.equal((await db.query("select status from public.sms_bookings where tenant_id=$1 and id='booking-b'",[b])).rows[0].status,'confirmed');
   const audits=(await db.query('select * from sms_private.mcp_activity where request_id=$1',[r.requestId])).rows;assert.ok(audits.some(x=>x.target==='booking-a'&&x.actor_id===admin));assert.ok(!JSON.stringify(audits).includes('PRIVATE NAME'));
   await grant(undefined,'revoked');assert.equal((await invoke('crm_cancel_booking',p)).error.code,'PERMISSION_DENIED');
   assert.equal((await db.query("select count(*) n from public.sms_messages where direction='outbound' or read_at is not null")).rows[0].n,0);
  });
 }finally{await db.close();}
});
