import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {testDatabase,call} from './helpers/database.js';
import {newMessage,emptySequence} from '../public/formAutomation.js';
import {createCrmHandler} from '../supabase/functions/crm-api/handler.js';

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

test('preview simulates draft rules without creating leads, messages, runs or jobs',async()=>{
 const {db,tenant,create}=await fixture();try{
  const form=await create();
  const sequence={...emptySequence(),startHour:0,endHour:24,steps:[{...newMessage('Hi {{first_name}}: {{field.service}}'),sendCount:2},newMessage('B'),{...newMessage('C'),sendCount:100}]};
  const input={fields:[{key:'service',label:'Service',type:'text',required:true}],sequence,submittedLocal:'2026-03-07T10:00',sample:{name:'Alex Example',phone:'+13035550160',email:'alex@example.test',smsOptIn:true,details:{service:'Repairs'}}};
  const snapshot=async()=>JSON.stringify((await db.query("select (select count(*) from public.sms_contacts) contacts,(select count(*) from public.sms_messages) messages,(select count(*) from sms_private.form_runs) runs,(select count(*) from sms_private.jobs) jobs,(select count(*) from public.sms_web_form_contact_submissions) submissions")).rows);
  const before=await snapshot();
  await db.exec('begin read only');
  const result=await call(db,'preview_form_automation','reader',tenant,form.public_id,input);
  await db.exec('commit');
  assert.equal(result.simulation,true);assert.equal(result.totalSends,103);assert.equal(result.rows.length,103);
  assert.equal(result.rows[0].body,'Hi Alex: Repairs');assert.deepEqual(result.rows.slice(0,4).map(r=>[r.message,r.repeat]),[[1,1],[1,2],[2,1],[3,1]]);
  assert.equal(new Date(result.rows[0].at).toISOString(),'2026-03-07T17:00:00.000Z');assert.equal(new Date(result.rows[1].at).toISOString(),'2026-03-08T16:00:00.000Z');
  assert.equal(await snapshot(),before);assert.ok(result.warnings.length>=2);
  assert.match((await call(db,'preview_form_automation','reader',tenant,form.public_id,{...input,sequence:null})).outcome,/Add messages/);
  const preview=p=>call(db,'preview_form_automation','reader',tenant,form.public_id,{...input,...p});
  assert.equal((await preview({scenario:'reply'})).rows.length,1);
  assert.match((await preview({scenario:'opt_out'})).outcome,/Stopped/);
  assert.equal((await preview({scenario:'reply',sequence:{...sequence,replyPolicy:'continue'}})).rows.length,103);
  assert.equal((await preview({sample:{...input.sample,smsOptIn:false}})).rows.length,0);
  assert.match((await preview({sequence:{...sequence,steps:[]}})).outcome,/Add messages/);
  const large=await preview({sequence:{...sequence,steps:[{...newMessage('Hi'),sendCount:1000}]}});assert.equal(large.rows.length,200);assert.equal(large.totalSends,1000);assert.equal(large.truncated,true);
  await assert.rejects(()=>preview({sample:{...input.sample,details:{}}}),/Required custom field/);
  await assert.rejects(()=>preview({sample:{...input.sample,smsOptIn:null}}),/Invalid required/);
  await assert.rejects(()=>preview({sequence:{steps:'bad'}}),/Invalid automation/);
  await assert.rejects(()=>call(db,'preview_form_automation','forms',tenant,form.public_id,input),/access/);
  await assert.rejects(()=>call(db,'preview_form_automation','reader','other',form.public_id,input),/access/);
  await assert.rejects(()=>call(db,'preview_form_automation','reader',tenant,crypto.randomUUID(),input),/not found/);
  assert.equal(await snapshot(),before);
 }finally{await db.close();}
});

test('booking simulation stops at appointment and reports missing personalized values',async()=>{
 const {db,tenant,create}=await fixture();try{
  const form=await create({preset:'bookings'});
  const input={submittedLocal:'2026-10-03T10:00',sample:{name:'Alex',phone:'+13035550160',email:'alex@example.test',smsOptIn:true,appointmentLocal:'2026-10-05T10:00',details:{}},sequence:{...emptySequence(),trigger:'appointment',leadHours:24,startHour:0,endHour:24,steps:[{...newMessage('Appointment {{appointment_at}}'),sendCount:100}]}};
  const result=await call(db,'preview_form_automation','admin',tenant,form.public_id,input);
  assert.equal(result.rows.length,1);assert.match(result.rows[0].body,/Oct 05, 2026 10:00/);assert.match(result.outcome,/appointment time/);
  const missing=await call(db,'preview_form_automation','admin',tenant,form.public_id,{...input,fields:[{key:'optional',label:'Optional',type:'text',required:false}],sequence:{...input.sequence,steps:[newMessage('{{field.optional}}')]}});
  assert.equal(missing.rows.length,0);assert.match(missing.outcome,/missing message field/);
  const grants=(await db.query("select has_function_privilege('authenticated','sms_private.preview_form_automation(text,text,uuid,jsonb)','execute') browser,has_function_privilege('sms_api','sms_private.preview_form_automation(text,text,uuid,jsonb)','execute') api")).rows[0];
  assert.equal(grants.browser,false);assert.equal(grants.api,true);
 }finally{await db.close();}
});

test('preview API normalizes the phone and invokes only the authorized read function',async()=>{
 const calls=[];const handler=createCrmHandler({call:async(...args)=>{calls.push(args);return {simulation:true,rows:[]};}},async()=> 'verified');
 const id=crypto.randomUUID(),url=`https://api.example.test/crm-api/web-forms/${id}/preview`;
 const response=await handler(new Request(url,{method:'POST',headers:{'X-Tenant-ID':'business'},body:JSON.stringify({user:'forged',sample:{phone:'(303) 555-0160'}})}));
 assert.equal(response.status,200);assert.equal(calls.length,1);assert.deepEqual(calls[0].slice(0,4),['preview_form_automation','verified','business',id]);assert.equal(calls[0][4].sample.phone,'+13035550160');
 assert.equal((await handler(new Request(url,{method:'POST',body:'{}'}))).status,400);
});
