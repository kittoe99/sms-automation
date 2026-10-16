import test from 'node:test';
import assert from 'node:assert/strict';
import {call} from './helpers/database.js';
import {setupCoordination,addRun,incoming,tenant,phone} from './helpers/coordination.js';

test('AI sees accepted SMS across conversation groups, but not queued, future or foreign messages',async()=>{
 const db=await setupCoordination({mode:'shadow'});try {
  await db.query("insert into public.sms_automation_groups(tenant_id,id,name,rule) values($1,'old','Old group',$2)",[tenant,JSON.stringify({anchor:'enrollment',firstDelayCount:0,firstDelayUnit:'day',intervalCount:1,intervalUnit:'day',repeatCount:1,leadHours:null,startHour:0,endHour:24})]);
  await db.query("insert into public.sms_contacts(tenant_id,phone) values($1,'+13035550999')",[tenant]);
  await call(db,'api_action','admin',null,'create_business',{id:'other-sms',name:'Other business',timeZone:'UTC'});
  await db.query("insert into public.sms_contacts(tenant_id,phone) values('other-sms',$1)",[phone]);
  await db.query(`insert into public.sms_messages(tenant_id,contact_phone,direction,body,category_id,status,provider_accepted_at,created_at) values
   ($1,$2,'outbound','Old automation question','old','accepted',now()-interval '5 minutes',now()-interval '6 minutes'),
   ($1,$2,'outbound','Current general question',null,'accepted',now()-interval '3 minutes',now()-interval '4 minutes'),
   ($1,$2,'outbound','Never sent',null,'queued',null,now()),
   ($1,$2,'outbound','Accepted after input',null,'accepted',now()+interval '1 day',now()),
   ($1,'+13035550999','outbound','Other contact',null,'accepted',now(),now()),
   ('other-sms',$2,'outbound','Other business',null,'accepted',now(),now())`,[tenant,phone]);
  const job=await incoming(db,'Yes, tell me more');
  const ctx=await call(db,'inbound_ai_context',job.id,job.lease_token);
  assert.deepEqual(ctx.history.map(x=>x.body),['Old automation question','Current general question','Yes, tell me more']);
  await call(db,'record_webhook',tenant,'inbound',{From:phone,To:'+18005550100',Body:'Yes, tell me more',MessageSid:(await db.query('select sid from public.sms_messages where id=$1',[job.payload.message_id])).rows[0].sid});
  assert.equal((await db.query("select count(*) n from sms_private.jobs where queue='ai_reply_jobs'")).rows[0].n,1);
 }finally{await db.close();}
});

test('form and direct Continue messages share the wait even with AI off; appointment schedules stay independent',async()=>{
 const db=await setupCoordination({mode:'off'});try {
  const form=await addRun(db),appointment=await addRun(db,{appointment:true});
  const sequence={trigger:'submission',replyPolicy:'continue',startHour:0,endHour:24,leadHours:24,steps:[{body:'Can we help?',delayCount:0,delayUnit:'minute',sendCount:2,intervalCount:1,intervalUnit:'day'}]};
  const contact=(await db.query('select * from public.sms_contacts where tenant_id=$1 and phone=$2',[tenant,phone])).rows[0];
  const template=(await call(db,'contact_automations','admin',tenant,'publish',{name:'Direct message',sequence,idempotencyKey:crypto.randomUUID()})).template;
  await call(db,'contact_automations','admin',tenant,'enroll',{contactId:contact.id,templateId:template.id,templateRevision:template.revision,contactRevision:contact.revision,overlaps:[{id:form.id,generation:form.generation}],overlapChoice:'keep',context:'Help request',idempotencyKey:crypto.randomUUID()});
  await incoming(db,'Please explain');
  const rows=(await db.query("select origin,sms_private.run_quiet_until(r) as until_at from sms_private.form_runs r where tenant_id=$1 and appointment_at is null",[tenant])).rows;
  assert.deepEqual(new Set(rows.map(x=>x.origin)),new Set(['form','direct']));
  assert.equal(new Date(rows[0].until_at).getTime(),new Date(rows[1].until_at).getTime());
  assert.ok(new Date(rows[0].until_at)>new Date());
  await call(db,'enqueue_due_automations');
  const queued=(await db.query("select payload->>'form_run_id' id from sms_private.jobs where queue='automation_jobs'")).rows;
  assert.deepEqual(queued.map(x=>x.id),[appointment.id]);
  assert.equal((await db.query("select count(*) n from sms_private.jobs where queue='ai_reply_jobs'")).rows[0].n,0);
 }finally{await db.close();}
});

test('one reply setting enables automation context without approving live mode or changing permissions',async()=>{
 const db=await setupCoordination({mode:'off'});try {
  await db.query('update sms_private.inbound_ai_settings set coordination_enabled=false where tenant_id=$1',[tenant]);
  const profile=(await db.query("insert into public.sms_business_profile_versions(tenant_id,version,facts,status,content_hash,created_by,approved_by,approved_at) values($1,1,'{}','approved','test','admin','admin',now()) returning id",[tenant])).rows[0].id;
  await db.query('update public.sms_businesses set active_profile_version_id=$2 where tenant_id=$1',[tenant,profile]);
  const revision=(await db.query('select revision from sms_private.inbound_ai_settings where tenant_id=$1',[tenant])).rows[0].revision;
  assert.equal(revision,1); // Direct fixture/worker updates now share the revision fence.
  const request={mode:'shadow',systemPrompt:'Help customers with approved facts',bookingEnabled:false,revision};
  const saved=await call(db,'inbound_ai_settings_api','admin',tenant,request);
  assert.equal(saved.mode,'shadow');assert.equal(saved.replyScope,'all_sms');assert.equal(saved.coordinationEnabled,true);
  assert.equal(saved.liveValidated,false);assert.equal(saved.revision,revision+2); // Mode and coordination are two canonical row updates.
  await assert.rejects(()=>call(db,'inbound_ai_settings_api','admin',tenant,{...request,mode:'live',revision:saved.revision}),/ready SMS connection/);
  await assert.rejects(()=>call(db,'inbound_ai_settings_api','admin',tenant,request),/stale revision/);
  await assert.rejects(()=>call(db,'inbound_ai_settings_api','stranger',tenant,request),/denied|admin|staff/i);
  const grants=(await db.query("select has_function_privilege('sms_api','sms_private.inbound_ai_settings_api(text,text,jsonb)','execute') api,has_function_privilege('sms_api','sms_private.inbound_ai_settings_api_before_unified_sms(text,text,jsonb)','execute') old,has_function_privilege('anon','sms_private.inbound_ai_settings_api(text,text,jsonb)','execute') anon")).rows[0];
  assert.deepEqual(grants,{api:true,old:false,anon:false});
 }finally{await db.close();}
});
