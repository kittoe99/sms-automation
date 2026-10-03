import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {testDatabase,call} from './helpers/database.js';
import {BUILTIN_PRESETS,validateSequence,newMessage,emptySequence} from '../public/formAutomation.js';
import {processAutomation} from '../src/workers/automation.js';
import {processAi} from '../src/workers/ai.js';

async function fixture(){
 const db=await testDatabase();
 const dir=new URL('../../E2local-main/supabase/migrations/',import.meta.url);
 for(const file of (await readdir(dir)).filter(f=>f.endsWith('.sql')).sort())await db.exec(await readFile(new URL(file,dir),'utf8'));
 const crm='https://staff.example.test',customer='https://customer.example.test';
 await db.query('select public.configure_platform_login_realms($1,$2)',[customer,crm]);
 const accounts={};for(const subject of ['admin','reader','forms','owner']){
  accounts[subject]=(await db.query('select public.sync_platform_account($1,$2,$2,null,1) id',[subject==='owner'?customer:crm,subject])).rows[0].id;
  await db.query('update public.dashboard_accounts set personal_info=$2 where id=$1',[accounts[subject],JSON.stringify({firstName:'Test',lastName:'Owner',phone:'+13035550123',role:'Owner'})]);
 }
 await db.query('insert into public.platform_staff_grants(account_id) values($1)',[accounts.admin]);
 await db.query("select set_config('platform.actor_issuer',$1,false)",[crm]);
 const profile={businessName:'Example Services',contactEmail:'owner@example.test',contactPhone:'+13035550123',summary:'Home repairs and maintenance services.',services:['Repairs'],locations:['Denver'],timeZone:'America/Denver'};
 await db.query('select public.complete_platform_onboarding($1,$2)',[accounts.owner,JSON.stringify(profile)]);
 const tenant=(await db.query('select tenant_id from public.dashboard_business_profiles where account_id=$1',[accounts.owner])).rows[0].tenant_id;
 await call(db,'platform_action','admin','business_profile_review',{tenantId:tenant,revision:0,profile});
 await call(db,'platform_action','admin','service_add',{tenantId:tenant,kind:'sms'});
 for(const [user,smsRead,formsManage] of [['reader',true,false],['forms',false,true]])await call(db,'platform_action','admin','membership',{tenantId:tenant,accountId:accounts[user],role:'operator',revision:-1,smsRead,formsManage});
 const act=(action,fid,p={},user='admin')=>call(db,'form_workspace',user,tenant,action,fid,p);
 const create=async(p={})=>(await act('create',null,{title:'Estimate request',preset:'contacts',description:'',buttonLabel:'Send',fields:[],enabled:false,...p})).form;
 const submit=(form,p={})=>call(db,'submit_web_form',form.public_id,{submissionId:crypto.randomUUID(),name:'Alex Example',phone:'+13035550160',email:'alex@example.com',smsOptIn:true,details:{},...p});
 const enable=async(form,sequence)=>{
  await act('save',form.public_id,{title:form.title,description:'',buttonLabel:'Submit',fields:form.fields,enabled:true});
  const state=await act('read',form.public_id);
  await act('publish',form.public_id,{sequence,revision:state.revision});await act('state',form.public_id,{enabled:true});
 };
 return {db,tenant,accounts,act,create,submit,enable};
}

test('template validation supports ordered repeat counts and rejects malformed fields',()=>{
 const sequence={...emptySequence(),steps:[{...newMessage('Hello {{first_name}}'),sendCount:2},newMessage('B'),{...newMessage('C'),sendCount:100}]};
 assert.deepEqual(validateSequence(sequence).steps.map(s=>s.sendCount),[2,1,100]);
 assert.throws(()=>validateSequence({...sequence,steps:[newMessage('{{unknown}}')]}),/Unknown field/);
 assert.throws(()=>validateSequence({...sequence,steps:[{...newMessage('Hi'),sendCount:1.5}]}),/whole number/);
 assert.throws(()=>validateSequence(BUILTIN_PRESETS[2].sequence,[],{appointmentAllowed:false}),/Appointment/);
});

test('current workers never invoke SMS AI',async()=>{
 const calls=[];const db={call:async(...args)=>calls.push(args)};
 await processAutomation({id:'job',lease_token:'lease'},db,{fetchImpl:()=>{throw Error('Unexpected AI');}});
 await processAi({id:'ai',lease_token:'lease'},db,{fetchImpl:()=>{throw Error('Unexpected AI');}});
 assert.equal(calls[0][0],'process_form_automation');assert.equal(calls[1][4],'SMS_AI_DISABLED');
});

test('paired forms have independent sequences, immutable runs and restricted writers',async()=>{
 const {db,tenant,act,create,submit,enable}=await fixture();try{
  assert.equal((await call(db,'list_form_workspace','admin',tenant)).forms.length,0);
  const a=await create(),b=await create({title:'Another estimate'});
  assert.notEqual(a.public_id,b.public_id);assert.equal(a.preset,b.preset);
  const sequence={...emptySequence(),startHour:0,endHour:24,steps:[{...newMessage('Hi {{first_name}}'),sendCount:2},newMessage('B'),{...newMessage('C'),sendCount:100}]};
  await enable(a,sequence);await submit(a);
  let runs=(await db.query('select * from sms_private.form_runs')).rows;assert.equal(runs.length,1);assert.equal(runs[0].version,1);
  await submit(a);assert.equal((await db.query('select count(*) n from sms_private.form_runs')).rows[0].n,1);
  await act('save',b.public_id,{title:b.title,description:'',buttonLabel:'Submit',fields:[],enabled:true});
  await submit(b);assert.equal((await db.query('select count(*) n from sms_private.form_runs')).rows[0].n,1);
  const s=await act('read',a.public_id);await act('publish',a.public_id,{sequence:{...sequence,steps:[newMessage('Changed')]},revision:s.revision});
  assert.equal((await db.query('select version from sms_private.form_runs')).rows[0].version,1);
  await assert.rejects(()=>act('state',a.public_id,{enabled:false},'reader'),/Staff/);
  await assert.rejects(()=>act('read',a.public_id,{},'forms'),/access/);
  await assert.rejects(()=>act('state',a.public_id,{enabled:false},'forms'),/Staff/);
  assert.equal((await call(db,'list_form_workspace','forms',tenant)).canManageAutomation,false);
  assert.equal((await act('read',a.public_id,{},'reader')).publishedVersion,2);
  await assert.rejects(()=>call(db,'form_workspace','reader','unrelated','read',a.public_id,{}),/access/);
  assert.equal(await call(db,'enqueue',tenant,'ai_reply_jobs','test',{}),null);
  assert.equal((await db.query("select count(*) n from sms_private.jobs where queue='ai_reply_jobs'")).rows[0].n,0);
  await act('archive',a.public_id);assert.equal(await call(db,'public_web_form',a.public_id),null);
  assert.equal((await db.query('select status from sms_private.form_runs')).rows[0].status,'stopped');
  await act('restore',a.public_id);assert.equal(await call(db,'public_web_form',a.public_id),null,'Restore requires explicit re-enabling');
 }finally{await db.close();}
});

test('provider acceptance advances repeated steps once, replies pause and opt-outs stop',async()=>{
 const {db,tenant,act,create,submit,enable}=await fixture();try{
  const form=await create();await enable(form,{...emptySequence(),startHour:0,endHour:24,steps:[{...newMessage('Hi {{first_name}} from {{business_name}}'),sendCount:2},newMessage('Next')]});await submit(form);
  await db.query("update public.sms_businesses set sending_enabled=true,status='active' where tenant_id=$1",[tenant]);
  const run=(await db.query('select * from sms_private.form_runs')).rows[0];
  await call(db,'enqueue_due_automations');
  const job=(await db.query("select * from sms_private.jobs where queue='automation_jobs' and payload ? 'form_run_id'")).rows[0];
  const token=crypto.randomUUID();await db.query("update sms_private.jobs set status='processing',lease_token=$2,leased_until=now()+interval '5 minutes' where id=$1",[job.id,token]);
  const out=await call(db,'process_form_automation',job.id,token);assert.ok(out.messageId);
  const message=(await db.query('select * from public.sms_messages where id=$1',[out.messageId])).rows[0];assert.equal(message.body,'Hi Alex from Example Services');
  const send=(await db.query("select * from sms_private.jobs where queue='sms_send_jobs' and payload->'request'->>'form_run_id'=$1",[run.id])).rows[0];
  await db.query("update sms_private.jobs set status='submitting',lease_token=$2,leased_until=now()+interval '5 minutes' where id=$1",[send.id,token]);
  const attempt=(await db.query('insert into sms_private.attempts(job_id,lease_token) values($1,$2) returning id',[send.id,token])).rows[0].id;
  await call(db,'accept_attempt',attempt,'SM'+'1'.repeat(32));await call(db,'accept_attempt',attempt,'SM'+'1'.repeat(32));
  const progressed=(await db.query('select * from sms_private.form_runs')).rows[0];assert.equal(progressed.send_index,1);assert.equal(progressed.repeat_index,1);assert.equal(progressed.message_index,0);
  for(const status of ['delivered','failed'])await call(db,'record_webhook',tenant,'status',{MessageSid:'SM'+'1'.repeat(32),MessageStatus:status,attempt_id:attempt});
  assert.equal((await db.query('select status from public.sms_messages where id=$1',[out.messageId])).rows[0].status,'delivered');
  assert.equal((await db.query('select send_index from sms_private.form_runs')).rows[0].send_index,1);
  await db.query("insert into public.sms_messages(tenant_id,contact_phone,direction,body,status,sid) values($1,'+13035550160','inbound','Interested','received',$2)",[tenant,'SM'+'2'.repeat(32)]);
  assert.equal((await db.query('select status from sms_private.form_runs')).rows[0].status,'paused');
  await act('resume',form.public_id,{runId:run.id});
  await db.query("update public.sms_contacts set opted_out=true where tenant_id=$1",[tenant]);
  assert.equal((await db.query('select status from sms_private.form_runs')).rows[0].status,'stopped');
 }finally{await db.close();}
});

test('calendar scheduling follows local days, month ends and sending windows',async()=>{
 const {db}=await fixture();try{
  const due=async(base,n,unit,start=0,end=24)=>(await db.query('select sms_private.form_due($1,$2,$3,$4,$5,$6) d',[base,n,unit,'America/Denver',start,end])).rows[0].d.toISOString();
  assert.equal(await due('2026-03-07T17:00:00Z',1,'day'),'2026-03-08T16:00:00.000Z');
  assert.equal(await due('2026-01-31T17:00:00Z',1,'month'),'2026-02-28T17:00:00.000Z');
  assert.equal(await due('2026-03-08T02:00:00Z',0,'minute',9,19),'2026-03-08T15:00:00.000Z');
 }finally{await db.close();}
});

test('103 accepted sends finish A twice, B once and C 100 times without pre-queuing the sequence',async()=>{
 const {db,tenant,create,submit,enable}=await fixture();try{
  const form=await create();await enable(form,{...emptySequence(),startHour:0,endHour:24,steps:[{...newMessage('A'),sendCount:2},newMessage('B'),{...newMessage('C'),sendCount:100}]});await submit(form);
  await db.query("update public.sms_businesses set sending_enabled=true,status='active' where tenant_id=$1",[tenant]);
  const texts=[];
  for(let index=0;index<103;index++){
   await db.exec("update sms_private.form_runs set next_run_at=now() where status='active'");
   assert.equal(await call(db,'enqueue_due_automations'),1);assert.equal(await call(db,'enqueue_due_automations'),0);
   const job=(await db.query("select * from sms_private.jobs where queue='automation_jobs' and status='queued' order by created_at desc limit 1")).rows[0];
   const token=crypto.randomUUID();await db.query("update sms_private.jobs set status='processing',lease_token=$2,leased_until=now()+interval '5 minutes' where id=$1",[job.id,token]);
   const result=await call(db,'process_form_automation',job.id,token);
   texts.push((await db.query('select body from public.sms_messages where id=$1',[result.messageId])).rows[0].body);
   const send=(await db.query("select * from sms_private.jobs where queue='sms_send_jobs' and status='queued'")).rows;
   assert.equal(send.length,1);
   await db.query("update sms_private.jobs set status='submitting' where id=$1",[send[0].id]);
   const aid=(await db.query('insert into sms_private.attempts(job_id,lease_token) values($1,$2) returning id',[send[0].id,token])).rows[0].id;
   await call(db,'accept_attempt',aid,'SM'+String(index).padStart(32,'0'));
  }
  assert.deepEqual(texts.slice(0,3),['A','A','B']);assert.equal(texts.slice(3).every(t=>t==='C'),true);
  const run=(await db.query('select * from sms_private.form_runs')).rows[0];assert.equal(run.status,'completed');assert.equal(run.send_index,103);assert.equal(run.next_run_at,null);
 }finally{await db.close();}
});

test('missing fields pause and appointment changes keep progress while cancelling stops reminders',async()=>{
 const {db,tenant,act,create,submit,enable}=await fixture();try{
  const form=await create({fields:[{key:'address',label:'Address',type:'text',required:false}]});
  await enable(form,{...emptySequence(),startHour:0,endHour:24,steps:[newMessage('Your address is {{field.address}}')]});await submit(form);
  await db.query("update public.sms_businesses set sending_enabled=true,status='active' where tenant_id=$1",[tenant]);
  await call(db,'enqueue_due_automations');const job=(await db.query("select * from sms_private.jobs where queue='automation_jobs' and status='queued'")).rows[0];
  const token=crypto.randomUUID();await db.query("update sms_private.jobs set status='processing',lease_token=$2,leased_until=now()+interval '5 minutes' where id=$1",[job.id,token]);
  await call(db,'process_form_automation',job.id,token);
  assert.equal((await db.query('select reason from sms_private.form_runs')).rows[0].reason,'MISSING_FIELD:field.address');
  assert.equal((await db.query('select count(*) n from public.sms_messages')).rows[0].n,0);
  const booking=await create({preset:'bookings'});await enable(booking,{...emptySequence(),trigger:'appointment',startHour:0,endHour:24,steps:[{...newMessage('Appointment {{appointment_at}}'),sendCount:100,intervalUnit:'hour'}]});
  const appt=new Date(Date.now()+3*86400000).toISOString();await submit(booking,{appointmentAt:appt});await submit(booking,{appointmentAt:new Date(Date.now()+4*86400000).toISOString()});
  const runs=(await db.query('select * from sms_private.form_runs where form_id=$1 order by created_at',[booking.public_id])).rows;assert.equal(runs.length,2);
  await db.query("update public.sms_automation_bookings set appointment_at=appointment_at+interval '1 day' where id=$1",[runs[0].intake_id]);
  const changed=(await db.query('select * from sms_private.form_runs where id=$1',[runs[0].id])).rows[0];assert.equal(changed.send_index,0);assert.ok(changed.generation>runs[0].generation);
  await db.query("update public.sms_automation_bookings set status='cancelled' where id=$1",[runs[0].intake_id]);
  assert.equal((await db.query('select status from sms_private.form_runs where id=$1',[runs[0].id])).rows[0].status,'stopped');
  assert.equal((await act('submissions',booking.public_id)).total,2);
 }finally{await db.close();}
});

test('reply policy fences prepared sends; continue keeps its run active',async()=>{
 const {db,tenant,act,create,submit,enable}=await fixture();try{
  const form=await create(),keep=await create({title:'Continue'});
  await enable(form,{...emptySequence(),startHour:0,endHour:24,steps:[newMessage('Hello')]});await enable(keep,{...emptySequence(),replyPolicy:'continue',startHour:0,endHour:24,steps:[newMessage('Continue')]});
  await submit(form);await submit(keep);await db.query("update public.sms_businesses set sending_enabled=true,status='active' where tenant_id=$1",[tenant]);
  await call(db,'enqueue_due_automations');const run=(await db.query('select * from sms_private.form_runs where form_id=$1',[form.public_id])).rows[0];
  const job=(await db.query("select * from sms_private.jobs where queue='automation_jobs' and payload->>'form_run_id'=$1",[run.id])).rows[0];
  const token=crypto.randomUUID();await db.query("update sms_private.jobs set status='processing',lease_token=$2,leased_until=now()+interval '5 minutes' where id=$1",[job.id,token]);
  const out=await call(db,'process_form_automation',job.id,token);
  await db.query("insert into public.sms_messages(tenant_id,contact_phone,direction,body,status,sid) values($1,'+13035550160','inbound','Hello','received',$2)",[tenant,'SM'+'4'.repeat(32)]);
  assert.equal((await db.query('select status from sms_private.form_runs where form_id=$1',[keep.public_id])).rows[0].status,'active');
  await db.query("update sms_private.jobs set status='processing',lease_token=$2,leased_until=now()+interval '5 minutes' where id=$1",[out.jobId,token]);
  assert.equal(await call(db,'begin_submission',out.jobId,token),null);
  await act('resume',form.public_id,{runId:run.id});assert.equal(await call(db,'enqueue_due_automations'),1);
 }finally{await db.close();}
});
