import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {testDatabase,call} from './helpers/database.js';
import {newMessage,emptySequence} from '../public/formAutomation.js';
import {createCrmHandler} from '../supabase/functions/crm-api/handler.js';
import {processSms} from '../src/workers/sms.js';

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

const sequence=()=>({...emptySequence(),startHour:0,endHour:24,steps:[{...newMessage('Hello {{first_name}}'),sendCount:2},newMessage('Next')]});
const input=()=>({requestId:crypto.randomUUID(),confirmed:true,sequence:sequence(),sample:{name:'Alex Example',phone:'+13035552060',email:'alex@example.test',smsOptIn:true,details:{}}});
async function activate(db,tenant){
 await db.query("update public.sms_businesses set sending_enabled=true,status='active' where tenant_id=$1",[tenant]);
 await db.query("update sms_private.providers set provisioning_state='configured',account_sid='AC'||repeat('1',32),from_number='+18775552060',auth_secret_id=vault.create_secret('test-secret') where tenant_id=$1",[tenant]);
}
async function prepareNext(db){
 await call(db,'enqueue_due_automations');
 const job=(await db.query("select * from sms_private.jobs where queue='automation_jobs' and status='queued' order by created_at desc limit 1")).rows[0];
 assert.ok(job,JSON.stringify({runs:(await db.query('select status,reason,send_index from sms_private.form_runs')).rows,jobs:(await db.query('select queue,status,error_code from sms_private.jobs')).rows}));const token=crypto.randomUUID();
 await db.query("update sms_private.jobs set status='processing',lease_token=$2,leased_until=now()+interval '5 minutes' where id=$1",[job.id,token]);
 const out=await call(db,'process_form_automation',job.id,token);
 await db.query("update sms_private.jobs set status='processing',lease_token=$2,leased_until=now()+interval '5 minutes' where id=$1",[out.jobId,token]);
 return {...out,token};
}

test('live test snapshots unsaved rules, sends through Twilio worker, advances repeats and saves no submission',async()=>{
 const {db,tenant,create,act,accounts}=await fixture();try{
  const form=await create({fields:[{key:'service',label:'Service',type:'select',required:true,options:['Cleanup','Removal']}]});await activate(db,tenant);const payload=input();payload.sample.details={service:'Cleanup'};
  const start=await call(db,'start_form_test_run','admin',tenant,form.public_id,payload);
  assert.equal(start.runs[0].totalSends,3);assert.equal(start.runs[0].status,'active');
  assert.equal((await act('submissions',form.public_id)).total,0);assert.equal((await act('read',form.public_id)).publishedVersion,null);
  await db.query("update public.platform_business_services set visibility='live' where tenant_id=$1 and kind='sms'",[tenant]);
  const leads=(await db.query('select public.read_customer_leads($1) result',[accounts.owner])).rows[0].result;assert.equal(leads.total,0);assert.equal(leads.forms.length,1);
  assert.equal((await call(db,'start_form_test_run','admin',tenant,form.public_id,payload)).duplicate,true);
  assert.equal((await db.query('select count(*) n from sms_private.form_runs')).rows[0].n,1);
  const sent=[];
  for(let i=0;i<3;i++){
   await db.query('update sms_private.form_runs set next_run_at=now() where id=$1',[start.runId]);
   const out=await prepareNext(db);
   await db.query("update sms_private.providers set next_send_at=now()-interval '1 second' where tenant_id=$1",[tenant]);
   await processSms({id:out.jobId,lease_token:out.token,attempts:1},{call:(name,...args)=>call(db,name,...args)},{callbackBase:'https://callbacks.example.test/sms',clientFactory:()=>({messages:{create:async message=>{sent.push(message);return {sid:'SM'+String(i+1).padStart(32,'0')};}}})});
  }
  assert.deepEqual(sent.map(x=>x.body),['Hello Alex','Hello Alex','Next']);assert.equal(sent[0].to,payload.sample.phone);assert.equal(sent[0].from,'+18775552060');
  const final=await call(db,'list_form_test_runs','reader',tenant,form.public_id);
  assert.equal(final.runs[0].accepted,3);assert.equal(final.runs[0].status,'completed');assert.equal(final.runs[0].messages.length,3);
  assert.equal(final.runs[0].messages[0].status,'accepted');
  await db.query("update public.sms_messages set status='delivered' where tenant_id=$1 and sid=$2",[tenant,'SM'+String(1).padStart(32,'0')]);
  assert.equal((await call(db,'list_form_test_runs','reader',tenant,form.public_id)).runs[0].delivered,1);
  assert.equal((await act('submissions',form.public_id)).total,0);
  assert.doesNotMatch(JSON.stringify(final),/test-secret|account_sid|auth_secret|test_actor|test_request|error_code/);
 }finally{await db.close();}
});

test('test API preserves verified actor and separate list, start and stop actions',async()=>{
 const calls=[];const handler=createCrmHandler({call:async(...args)=>{calls.push(args);return {runs:[]};}},async()=> 'verified');
 const form=crypto.randomUUID(),run=crypto.randomUUID(),url=`https://api.example.test/crm-api/web-forms/${form}/test-runs`,headers={'X-Tenant-ID':'business'};
 assert.equal((await handler(new Request(url,{headers}))).status,200);
 assert.equal((await handler(new Request(url,{headers,method:'POST',body:JSON.stringify({sample:{phone:'3035552060'}})}))).status,202);
 assert.equal((await handler(new Request(`${url}/${run}/stop`,{headers,method:'POST',body:'{}'}))).status,200);
 assert.deepEqual(calls.map(c=>c.slice(0,4)),[['list_form_test_runs','verified','business',form],['start_form_test_run','verified','business',form],['stop_form_test_run','verified','business',form]]);
 assert.equal(calls[1][4].sample.phone,'+13035552060');assert.equal(calls[2][4],run);
});

test('real tests enforce staff, consent, sender, idempotency and stop queued sends',async()=>{
 const {db,tenant,create}=await fixture();try{
  const form=await create(),p=input();const start=(payload=p,user='admin',t=tenant)=>call(db,'start_form_test_run',user,t,form.public_id,payload);
  await assert.rejects(()=>start(),/Enable SMS/);await activate(db,tenant);
  await assert.rejects(()=>start(p,'reader'),/Staff/);await assert.rejects(()=>start(p,'forms'),/Staff/);
  await assert.rejects(()=>start(p,'admin','other'),/access/);
  await assert.rejects(()=>start({...p,confirmed:false}),/Confirm/);
  await assert.rejects(()=>start({...p,sample:{...p.sample,smsOptIn:false}}),/Confirm/);
  await assert.rejects(()=>start({...p,sample:{...p.sample,phone:'+13035550160'}}),/Replace the sample/);
  const run=await start();await assert.rejects(()=>start({...p,sequence:{...p.sequence,replyPolicy:'continue'}}),/conflicts/);
  await assert.rejects(()=>start({...p,requestId:crypto.randomUUID()}),/already active/);
  const out=await prepareNext(db);
  await call(db,'stop_form_test_run','admin',tenant,form.public_id,run.runId);
  assert.equal(await call(db,'begin_submission',out.jobId,out.token),null);
  assert.equal((await call(db,'list_form_test_runs','reader',tenant,form.public_id)).runs[0].status,'stopped');
  await assert.rejects(()=>call(db,'list_form_test_runs','forms',tenant,form.public_id),/access/);
  await assert.rejects(()=>call(db,'list_form_test_runs','reader','other',form.public_id),/access/);
  await db.query('update public.sms_contacts set opted_out=true where tenant_id=$1',[tenant]);
  await assert.rejects(()=>start({...p,requestId:crypto.randomUUID()}),/opted out/);
 }finally{await db.close();}
});

test('real replies and opt-outs stop subsequent test sends; normal published rules remain separate',async()=>{
 const {db,tenant,create,enable,submit}=await fixture();try{
  const form=await create();await activate(db,tenant);const p=input();const r=await call(db,'start_form_test_run','admin',tenant,form.public_id,p);
  await enable(form,sequence());await submit(form,{phone:p.sample.phone});
  assert.equal((await db.query('select count(*) n from sms_private.form_runs')).rows[0].n,2);
  await db.query("insert into public.sms_messages(tenant_id,contact_phone,direction,body,status,sid) values($1,$2,'inbound','Interested','received',$3)",[tenant,p.sample.phone,'SM'+'5'.repeat(32)]);
  assert.equal((await db.query('select status from sms_private.form_runs where id=$1',[r.runId])).rows[0].status,'paused');
  await db.query('update public.sms_contacts set opted_out=true where tenant_id=$1',[tenant]);
  assert.equal((await db.query('select status from sms_private.form_runs where id=$1',[r.runId])).rows[0].status,'stopped');
 }finally{await db.close();}
});
