import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {testDatabase,call} from './helpers/database.js';
import {createCrmHandler} from '../supabase/functions/crm-api/handler.js';
import {smsConnectionSummary} from '../public/smsConnectionSummary.js';

test('summary HTTP route uses selected tenant and never invokes provisioning or Twilio',async()=>{
 const calls=[],summary={businessName:'Example',phoneNumber:'+18775550180',profileName:'Example LLC',senderType:'toll_free',connectionStatus:'connected',approvalStatus:'approved',messagingStatus:'disabled'};
 const handler=createCrmHandler({call:async(...args)=>{calls.push(args);return summary;}},async()=> 'reader');
 const result=await handler(new Request('https://crm.example/api/sms/connection',{headers:{'X-Tenant-ID':'alpha'}}));
 assert.equal(result.status,200);assert.deepEqual(await result.json(),summary);assert.deepEqual(calls,[['read_sms_connection','reader','alpha']]);
 assert.equal((await handler(new Request('https://crm.example/api/sms/connection'))).status,400);
 const html=smsConnectionSummary({...summary,profileName:'<script>unsafe</script>',accountSid:'private-SID',authToken:'private-token'});
 assert.match(html,/Sending disabled/);assert.match(html,/Approved/);assert.match(html,/&lt;script&gt;/);
 assert.doesNotMatch(html,/<script>|private-SID|private-token|<button|<form|<input/);
});

test('paired readers share a private, read-only projection with isolation, approval and cache updates',async()=>{
 const db=await testDatabase();try {
  const dir=new URL('../../E2local-main/supabase/migrations/',import.meta.url);
  for(const file of (await readdir(dir)).filter(x=>x.endsWith('.sql')).sort())await db.exec(await readFile(new URL(file,dir),'utf8'));
  const crm='https://staff.example.test',customer='https://customer.example.test';
  await db.query('select public.configure_platform_login_realms($1,$2)',[customer,crm]);
  const account=async(subject,issuer)=>{
   const id=(await db.query('select public.sync_platform_account($1,$2,$2,null,1) id',[issuer,subject])).rows[0].id;
   await db.query('update public.dashboard_accounts set personal_info=$2 where id=$1',[id,JSON.stringify({firstName:'Test',lastName:'Owner',phone:'+13035550123',role:'Owner'})]);return id;
  };
  const admin=await account('admin',crm),reader=await account('reader',crm),forms=await account('forms',crm),owner=await account('owner',customer),other=await account('other',customer);
  await db.query('insert into public.platform_staff_grants(account_id) values($1)',[admin]);
  await db.query("select set_config('platform.actor_issuer',$1,false)",[crm]);
  const profile={businessName:'Example Services',contactEmail:'owner@example.test',contactPhone:'+13035550123',summary:'Home repairs and maintenance services.',services:['Repairs'],locations:['Denver'],timeZone:'America/Denver'};
  for(const id of [owner,other])await db.query('select public.complete_platform_onboarding($1,$2)',[id,JSON.stringify(profile)]);
  const tenant=(await db.query('select tenant_id from public.dashboard_business_profiles where account_id=$1',[owner])).rows[0].tenant_id;
  const action=(name,input)=>call(db,'platform_action','admin',name,input);
  await action('business_profile_review',{tenantId:tenant,revision:0,profile});
  for(const [id,smsRead,formsManage] of [[reader,true,false],[forms,false,true]])await action('membership',{tenantId:tenant,accountId:id,role:'operator',revision:-1,smsRead,formsManage});
  const missing=await call(db,'read_sms_connection','reader',tenant);assert.equal(missing.connectionStatus,'not_available');assert.equal(missing.profileName,null);
  await action('service_add',{tenantId:tenant,kind:'sms'});
  await db.query("update sms_private.providers set from_number='+18775550180',provisioning_state='configured',connection_details=$2 where tenant_id=$1",[tenant,JSON.stringify({profileName:'Example LLC',accountSid:'hidden-account',authToken:'hidden-token',approvalStatus:'Approved'})]);
  await db.query("insert into public.sms_twilio_registrations(tenant_id,sender_type,state,canary_phone,rejection_reason) values($1,'toll_free','webhook_verified','+13035550999','hidden-error')",[tenant]);
  const customerRead=async(id=owner)=>(await db.query('select public.read_customer_business_services($1) r',[id])).rows[0].r;
  assert.deepEqual((await customerRead()).services,[]);
  const service=(await db.query("select * from public.platform_business_services where tenant_id=$1 and kind='sms'",[tenant])).rows[0];
  await action('service_visibility',{tenantId:tenant,serviceId:service.id,revision:service.revision,visibility:'live'});
  const count=async()=>(await db.query('select count(*) n from sms_private.jobs')).rows[0].n,before=await count();
  const summary=await call(db,'read_sms_connection','reader',tenant);
  assert.deepEqual(Object.keys(summary).sort(),['businessName','profileName','phoneNumber','senderType','connectionStatus','approvalStatus','messagingStatus'].sort());
  assert.equal(summary.approvalStatus,'approved');assert.equal(summary.messagingStatus,'disabled');assert.equal(summary.connectionStatus,'connected');
  assert.deepEqual((await customerRead()).services[0].smsConnection,summary);assert.equal(await count(),before);
  assert.doesNotMatch(JSON.stringify(await customerRead()),/hidden-|13035550999|accountSid|authToken|verification_sid|rejection_reason/);
  assert.deepEqual((await customerRead(other)).services,[]);
  await assert.rejects(()=>call(db,'read_sms_connection','forms',tenant),/access/);
  await assert.rejects(()=>call(db,'twilio_registration','reader',tenant),/Staff/);
  assert.equal((await call(db,'twilio_registration','admin',tenant)).canary_phone,'+13035550999');
  await db.query("select set_config('request.jwt.claims',$1,false)",[JSON.stringify({sub:'reader',iss:crm})]);
  await db.exec('set role authenticated');assert.deepEqual((await db.query('select * from public.sms_twilio_registrations')).rows,[]);await db.exec('reset role');
  await db.query("select set_config('request.jwt.claims',$1,false)",[JSON.stringify({sub:'admin',iss:crm})]);
  await db.exec('set role authenticated');assert.equal((await db.query('select tenant_id from public.sms_twilio_registrations')).rows.length,1);await db.exec('reset role');
  await db.query("select set_config('request.jwt.claims','{}',false)");
  const rev=async()=>(await db.query('select revision from public.dashboard_cache_versions where scope=$1',['tenant:'+tenant])).rows[0].revision;
  const initial=await rev();
  for(const [state,status] of [['in_review','in_progress'],['campaign_pending','in_progress'],['rejected','needs_attention'],['submission_unknown','needs_attention'],['draft','not_available'],['ready','approved']]){
   await db.query('update public.sms_twilio_registrations set state=$2,sender_type=$3 where tenant_id=$1',[tenant,state,'local_a2p']);
   const result=await call(db,'read_sms_connection','reader',tenant);assert.equal(result.approvalStatus,status);assert.equal(result.senderType,'local_a2p');
   assert.deepEqual((await customerRead()).services[0].smsConnection,result);
  }
  assert.ok(await rev()>initial);
  await db.query("update public.sms_businesses set sending_enabled=true,status='active' where tenant_id=$1",[tenant]);assert.equal((await call(db,'read_sms_connection','reader',tenant)).messagingStatus,'active');
  await db.query("update public.sms_twilio_registrations set state='paused' where tenant_id=$1",[tenant]);assert.equal((await call(db,'read_sms_connection','reader',tenant)).messagingStatus,'paused');
  await action('membership',{tenantId:tenant,accountId:reader,role:'operator',revision:0,enabled:false,smsRead:false,formsManage:false});
  await assert.rejects(()=>call(db,'read_sms_connection','reader',tenant),/access/);
  await db.query("update public.dashboard_accounts set status='suspended' where id=$1",[owner]);await assert.rejects(()=>customerRead(),/active/);
  const grants=(await db.query("select has_function_privilege('sms_api','sms_private.sms_connection_summary(text)','execute') helper,has_function_privilege('sms_api','sms_private.read_sms_connection(text,text)','execute') reader,has_function_privilege('authenticated','public.read_customer_business_services(uuid)','execute') customer")).rows[0];
  assert.deepEqual(grants,{helper:false,reader:true,customer:false});
 }finally{await db.close();}
});
