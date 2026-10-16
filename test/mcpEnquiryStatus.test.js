import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {z} from 'zod';
import {testDatabase,call} from './helpers/database.js';
import {toolOutputs} from '../src/mcp/tools.js';
import {enquiryStatusTools} from '../src/mcp/enquiryStatusSchemas.js';
import {connectionPermissionNames} from '../public/mcpPermissions.js';
const crm='https://staff.example.test',customer='https://customer.example.test',client='https://client.example.test/codex.json';
const migration='20261016063330_crm_mcp_enquiry_status.sql',oldConnection='00000000-0000-4000-8000-000000000002';
const fields=[{key:'items',label:'Original items label',type:'textarea',required:true}];

test('enquiry status separates attributed outcomes and enforces scope',async t=>{
 const db=await testDatabase({beforeMigration:async(db,file)=>{
  if(file===migration)await db.query(`insert into sms_private.mcp_connections(id,issuer,subject,account_id,client_id,status,permissions,all_businesses)
   values($1,'legacy','legacy',$1,'legacy','active',array['read','automation_read'],true)`,[oldConnection]);
 }});
 try{
  assert.deepEqual((await db.query('select permissions from sms_private.mcp_connections where id=$1',[oldConnection])).rows[0].permissions,['read','automation_read']);
  const dir=new URL('../../E2local-main/supabase/migrations/',import.meta.url);
  for(const file of (await readdir(dir)).filter(x=>x.endsWith('.sql')).sort())await db.exec(await readFile(new URL(file,dir),'utf8'));
  await db.query('select public.configure_platform_login_realms($1,$2)',[customer,crm]);
  const account=async(subject,issuer)=>{
   const id=(await db.query('select public.sync_platform_account($1,$2,$2,null,1) id',[issuer,subject])).rows[0].id;
   await db.query('update public.dashboard_accounts set personal_info=$2 where id=$1',[id,JSON.stringify({firstName:'Test',lastName:'Owner',phone:'+17208429167',role:'Owner'})]);return id;
  };
  const staff=await account('staff',crm);await db.query('insert into public.platform_staff_grants(account_id) values($1)',[staff]);
  await account('nonstaff',crm);
  await db.query("select set_config('platform.actor_issuer',$1,false)",[crm]);
  const register=async(subject)=>{
   const owner=await account(subject,customer);
   await db.query('select public.complete_platform_onboarding($1,$2)',[owner,JSON.stringify({businessName:subject,contactEmail:'owner@example.test',contactPhone:'+17208429167',summary:'Local repair services for nearby residents.',services:['Repairs'],locations:['Denver'],timeZone:'America/Denver'})]);
   const business=(await db.query('select tenant_id from public.dashboard_business_profiles where account_id=$1',[owner])).rows[0].tenant_id;
   const profile=(await db.query('select draft from public.platform_business_setup where tenant_id=$1',[business])).rows[0].draft;
   await call(db,'platform_action','staff','business_profile_review',{tenantId:business,revision:0,profile});
   await call(db,'platform_action','staff','service_add',{tenantId:business,kind:'sms'});
   return business;
  };
  const a=await register('allowed'),b=await register('hidden');
  await db.query("select set_config('platform.actor_issuer',$1,false)",[crm]);
  const invoke=async(tool,p={},user='staff')=>{
   const r=(await db.query('select crm_mcp.invoke($1,$2,$3,$4,$5) r',[user,client,tool,JSON.stringify(p),crypto.randomUUID()])).rows[0].r;
   if(r.ok)toolOutputs[tool].parse(r.data);return r;
  };
  const connectionId=(await invoke('crm_get_access')).data.connectionId;let revision=0;
  const grant=async(permissions,{status='active',allBusinesses=false,businessIds=[a]}={})=>{
   const r=await call(db,'mcp_admin','staff','save',{connectionId,revision,status,permissions,businessIds,allBusinesses});revision=r.connection.revision;
  };
  const form=async(business,preset)=>{
   const f=(await call(db,'form_workspace','staff',business,'create',null,{title:'Shared form',preset,description:'',buttonLabel:'Send',fields})).form;
   await call(db,'form_workspace','staff',business,'save',f.public_id,{title:f.title,description:'',buttonLabel:'Send',fields,enabled:true});return f;
  };
  const fa=await form(a,'contacts'),fq=await form(a,'quote_requests'),fb=await form(b,'quote_requests'),booking=await form(a,'bookings');
  const submit=async(f)=>{
   const id=crypto.randomUUID();await call(db,'submit_web_form',f.public_id,{submissionId:id,name:'Test person',phone:'+17208429167',email:'test@example.test',smsOptIn:false,details:{items:'Saved answer'},...(f.preset==='bookings'?{appointmentAt:'2099-01-01T17:00:00Z'}:{})});return id;
  };
  const sa=await submit(fa),sq=await submit(fq),sb=await submit(fb),sk=await submit(booking);
  const detail={businessId:a,formId:fa.public_id,submissionId:sa};
  const status=async(p=detail)=>invoke('crm_get_enquiry_status',p);
  const data=async(p=detail)=>{const r=await status(p);assert.equal(r.ok,true,JSON.stringify(r));return r.data.enquiryStatus;};
  await t.test('independent status grant, strict schema and unavailable identity protection',async()=>{
   assert.equal((await status()).error.code,'PERMISSION_DENIED');
   await grant(connectionPermissionNames.filter(p=>p!=='enquiry_status_read'));assert.equal((await status()).error.code,'PERMISSION_DENIED');
   await grant(['enquiry_status_read']);
   assert.equal((await invoke('crm_get_enquiry',detail)).error.code,'PERMISSION_DENIED');
   assert.equal((await invoke('crm_list_enquiries',{businessId:a})).error.code,'PERMISSION_DENIED');
   assert.equal((await invoke('crm_get_sms_run_activity',{businessId:a,runId:crypto.randomUUID()})).error.code,'PERMISSION_DENIED');
   const schema=z.object(enquiryStatusTools[0][2]).strict();assert.ok(schema.safeParse(detail).success);
   for(const extra of [{formId:null},{submissionId:'bad'},{runId:crypto.randomUUID()},{includeAnswers:true},{idempotencyKey:'not-a-write'},{businessId:' '}]){
    assert.equal(schema.safeParse({...detail,...extra}).success,false);assert.equal((await status({...detail,...extra})).ok,false);
   }
   for(const p of [{...detail,businessId:b},{...detail,formId:fb.public_id,submissionId:sb},{...detail,submissionId:sb},{...detail,formId:fq.public_id}])assert.equal((await status(p)).error.code,'PERMISSION_DENIED');
   await grant(['enquiry_status_read'],{businessIds:[a,b]});
   assert.deepEqual((await status({...detail,submissionId:sb})).error,(await status({...detail,submissionId:crypto.randomUUID()})).error);
   assert.equal((await status({businessId:b,formId:fb.public_id,submissionId:sb})).ok,true);
   await grant(['enquiry_status_read']);
  });
  await t.test('no-consent intake and appointment request never imply run or confirmed booking',async()=>{
   const d=await data();assert.equal(d.intake.skipReason,'CONSENT_REQUIRED');assert.equal(d.sms.state,'skipped');assert.equal(d.sms.runId,null);
   assert.equal(d.bookings.confirmed,0);assert.equal(d.handoffs.linked,0);assert.equal(d.responses.linked,0);
   const bookingStatus=await data({businessId:a,formId:booking.public_id,submissionId:sk});
   assert.ok(bookingStatus.requestedAppointmentAt);assert.equal(bookingStatus.bookings.confirmed,0);
   assert.doesNotMatch(JSON.stringify(d),/Saved answer|Test person|test@example|7208429167|consent_evidence|payload_fingerprint/);
   assert.equal(toolOutputs.crm_get_enquiry_status.safeParse({...(await status()).data,enquiryStatus:{...d,answers:[]}}).success,false);
   assert.equal(toolOutputs.crm_get_enquiry_status.safeParse({...(await status()).data,enquiryStatus:{...d,sms:{...d.sms,reason:'secret'}}}).success,false);
  });
  const makeRun=async(business,f,submission)=>{
   await db.query('insert into sms_private.form_sequences(tenant_id,form_id) values($1,$2) on conflict do nothing',[business,f.public_id]);
   await db.query("insert into sms_private.form_sequence_versions(tenant_id,form_id,version,sequence) values($1,$2,1,'{}')",[business,f.public_id]);
   return (await db.query("insert into sms_private.form_runs(tenant_id,form_id,version,submission_id,phone,context,status,next_run_at,reason) values($1,$2,1,$3,'+17208429167','{}','active','2099-01-01T17:00:00Z','private-reason') returning id",[business,f.public_id,submission])).rows[0].id;
  };
  const ra=await makeRun(a,fa,sa),rq=await makeRun(a,fq,sq),rb=await makeRun(b,fb,sb);
  const contact=async(business)=>(await db.query("select id from public.sms_contacts where tenant_id=$1 and phone='+17208429167'",[business])).rows[0].id;
  const ca=await contact(a),cb=await contact(b);
  const makeBooking=async(business,c,id,rid)=>{
   await db.query("insert into public.sms_bookings(tenant_id,id,contact_id,appointment_at,status,metadata) values($1,$2,$3,'2099-01-01','confirmed','{\"private\":\"secret-booking\"}')",[business,id,c]);
   if(rid)await db.query("insert into sms_private.activity_bookings(tenant_id,booking_id,run_id,basis) values($1,$2,$3,'staff_explicit')",[business,id,rid]);
  };
  await makeBooking(a,ca,'linked-booking',ra);await makeBooking(a,ca,'unlinked-booking');await makeBooking(b,cb,'linked-booking',rb);
  // Deliberately corrupt cross-tenant links are possible with legacy single-column run FKs.
  await makeBooking(b,cb,'foreign-link',ra);
  const makeHandoff=async(business,c,rid)=>{
   const job=(await db.query("insert into sms_private.jobs(tenant_id,queue,dedupe_key,payload) values($1,'ai_reply_jobs',$2,'{}') returning id",[business,crypto.randomUUID()])).rows[0].id;
   const id=(await db.query("insert into public.sms_handoffs(tenant_id,contact_id,ai_job_id,reason,status) values($1,$2,$3,'secret-handoff',$4) returning id",[business,c,job,rid?'open':'closed'])).rows[0].id;
   if(rid)await db.query('insert into sms_private.activity_handoffs(tenant_id,handoff_id,run_id) values($1,$2,$3)',[business,id,rid]);return id;
  };
  const ha=await makeHandoff(a,ca,ra);await makeHandoff(a,ca);await makeHandoff(b,cb,ra);
  const makeResponse=async(business,rid)=>{
   const id=(await db.query("insert into public.sms_messages(tenant_id,contact_phone,direction,body,status) values($1,'+17208429167','inbound','secret-reply','received') returning id",[business])).rows[0].id;
   if(rid)await db.query("insert into sms_private.activity_responses(tenant_id,message_id,run_id,basis) values($1,$2,$3,'staff_explicit')",[business,id,rid]);return id;
  };
  await makeResponse(a,ra);await makeResponse(a);await makeResponse(b,ra);
  await t.test('exact tenant/run attribution isolates same-contact enquiries, unlinked and simulated outcomes',async()=>{
   await call(db,'activity_event',a,ra,'shadow-booking','booking_link',new Date().toISOString(),{bookingId:'shadow-only'},false,true);
   const d=await data();assert.equal(d.sms.runId,ra);assert.equal(d.sms.state,'active');assert.ok(d.sms.nextRunAt);
   assert.deepEqual(d.bookings,{linked:1,confirmed:1,cancelled:0,requested:0});assert.equal(d.handoffs.linked,1);assert.equal(d.responses.linked,1);
   const other=await data({businessId:a,formId:fq.public_id,submissionId:sq});assert.equal(other.bookings.linked,0);assert.equal(other.handoffs.linked,0);assert.equal(other.responses.linked,0);
   assert.doesNotMatch(JSON.stringify(d),/private-reason|secret-booking|secret-handoff|secret-reply|shadow-only/);
  });
  await t.test('SMS transitions, booking cancellation/reattribution and handoff resolution stay distinct',async()=>{
   for(const state of ['paused','stopped','completed']){
    await db.query('update sms_private.form_runs set status=$1,generation=generation+1 where id=$2',[state,ra]);
    const d=await data();assert.equal(d.sms.state,state);assert.equal(d.sms.nextRunAt,null);assert.equal(d.bookings.confirmed,1);assert.equal(d.handoffs.open,1);
   }
   await db.query("update public.sms_bookings set status='cancelled' where tenant_id=$1 and id='linked-booking'",[a]);
   assert.equal((await data()).bookings.cancelled,1);assert.equal((await data()).bookings.confirmed,0);
   await db.query("update sms_private.activity_bookings set run_id=$2,revision=revision+1 where tenant_id=$1 and booking_id='linked-booking'",[a,rq]);
   assert.equal((await data()).bookings.linked,0);assert.equal((await data({businessId:a,formId:fq.public_id,submissionId:sq})).bookings.cancelled,1);
   for(const state of ['assigned','resolved','closed']){
    await db.query('update public.sms_handoffs set status=$1 where tenant_id=$2 and id=$3',[state,a,ha]);
    const d=await data();assert.equal(d.handoffs[state],1);assert.equal(d.sms.state,'completed');
   }
  });
  await t.test('legacy fallback is scoped and test runs cannot become enquiry outcomes',async()=>{
   const group=(await db.query("select id from public.sms_automation_groups where tenant_id=$1 and fixed_type='bookings'",[a])).rows[0].id;
   const eid=(await db.query("insert into public.sms_automation_enrollments(tenant_id,contact_id,category_id,status,next_run_at) values($1,$2,$3,'paused','2099-01-01') returning id",[a,ca,group])).rows[0].id;
   const intake=(await db.query('select automation_intake_id from public.sms_web_form_booking_submissions where tenant_id=$1 and id=$2',[a,sk])).rows[0].automation_intake_id;
   // Local fixture only: prevent legacy intake mutation from re-enrolling while assigning its historical reference.
   await db.exec('alter table public.sms_automation_bookings disable trigger user');
   try{await db.query('update public.sms_automation_bookings set enrollment_id=$1 where tenant_id=$2 and id=$3',[eid,a,intake]);}finally{await db.exec('alter table public.sms_automation_bookings enable trigger user');}
   const p={businessId:a,formId:booking.public_id,submissionId:sk};const d=await data(p);
   assert.equal(d.sms.source,'legacy_enrollment');assert.equal(d.sms.state,'paused');assert.equal(d.sms.legacyEnrollmentId,eid);assert.equal(d.sms.nextRunAt,null);
   const rk=await makeRun(a,booking,sk);
   assert.equal((await data(p)).sms.source,'form_run');
   await db.query("update sms_private.form_runs set version=null,test_sequence='{}',test_actor='staff',test_request='{}' where id=$1",[rk]);
   await makeBooking(a,ca,'test-only-booking',rk);
   assert.equal((await data(p)).sms.source,'legacy_enrollment');assert.equal((await data(p)).bookings.linked,0);
   const foreignGroup=(await db.query("select id from public.sms_automation_groups where tenant_id=$1 and fixed_type='bookings'",[b])).rows[0].id;
   const foreignEnrollment=(await db.query("insert into public.sms_automation_enrollments(tenant_id,contact_id,category_id,status) values($1,$2,$3,'paused') returning id",[b,cb,foreignGroup])).rows[0].id;
   // A corrupt legacy reference must not disclose another business's enrollment.
   await db.exec('alter table public.sms_automation_bookings disable trigger user');
   try{await db.query('update public.sms_automation_bookings set enrollment_id=$1 where tenant_id=$2 and id=$3',[foreignEnrollment,a,intake]);}finally{await db.exec('alter table public.sms_automation_bookings enable trigger user');}
   const isolated=await data(p);assert.equal(isolated.sms.legacyEnrollmentId,null);assert.equal(isolated.sms.source,'intake');
  });
  await t.test('read-only snapshots, restricted role access and redacted audit',async()=>{
   await call(db,'form_workspace','staff',a,'archive',fa.public_id,{});
   const tables=['public.sms_web_form_contact_submissions','public.sms_contacts','public.sms_bookings','public.sms_handoffs','public.sms_messages','public.sms_web_form_definitions','sms_private.form_runs','sms_private.jobs','sms_private.activity_bookings','sms_private.activity_handoffs','sms_private.activity_responses','sms_private.mcp_requests','public.dashboard_cache_versions','pgmq.test_messages','net.test_requests'];
   const snapshot=async()=>{const out={};for(const table of tables)out[table]=(await db.query(`select coalesce(jsonb_agg(to_jsonb(x) order by to_jsonb(x)::text),'[]') v from ${table} x`)).rows[0].v;return out;};
   const before=await snapshot();await data();await data();assert.deepEqual(await snapshot(),before);
   await db.exec('set role crm_mcp');assert.equal((await status()).ok,true);await db.exec('reset role');
   for(const role of ['crm_mcp','anon','authenticated','sms_api','service_role']){
    await db.exec(`set role ${role}`);await assert.rejects(()=>call(db,'mcp_enquiry_status','staff',a,detail),/permission denied/);await db.exec('reset role');
   }
   const audits=(await db.query("select * from sms_private.mcp_activity where connection_id=$1 and tool='crm_get_enquiry_status'",[connectionId])).rows;
   assert.ok(audits.some(x=>x.target===sa&&x.revision!==null&&x.outcome==='success'));assert.ok(audits.some(x=>x.outcome==='denied'));
   assert.ok(audits.every(x=>x.actor_id===staff&&x.request_id));assert.doesNotMatch(JSON.stringify(audits),/secret-|Saved answer|test@example|7208429167/);
  });
  await t.test('scope/permission removal and staff/connection revocation are immediate',async()=>{
   await grant(['enquiry_status_read'],{allBusinesses:true});assert.equal((await status({businessId:b,formId:fb.public_id,submissionId:sb})).ok,true);
   await grant(['enquiry_status_read'],{businessIds:[]});assert.equal((await status()).error.code,'PERMISSION_DENIED');
   await grant([]);assert.equal((await status()).error.code,'PERMISSION_DENIED');await grant(['enquiry_status_read']);
   await db.query("update public.dashboard_accounts set status='suspended' where id=$1",[staff]);assert.equal((await status()).error.code,'PERMISSION_DENIED');
   await db.query("update public.dashboard_accounts set status='active' where id=$1",[staff]);
   assert.equal((await invoke('crm_get_enquiry_status',detail,'nonstaff')).error.code,'PERMISSION_DENIED');
   await db.query("select set_config('platform.actor_issuer',$1,false)",[customer]);assert.equal((await invoke('crm_get_enquiry_status',detail,'allowed')).error.code,'PERMISSION_DENIED');await db.query("select set_config('platform.actor_issuer',$1,false)",[crm]);
   await grant(['enquiry_status_read'],{status:'disabled'});assert.equal((await status()).error.code,'PERMISSION_DENIED');
   await grant(['enquiry_status_read'],{status:'revoked'});assert.equal((await status()).error.code,'PERMISSION_DENIED');
  });
 }finally{await db.close();}
});

