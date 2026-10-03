import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {testDatabase,call} from './helpers/database.js';
const crm='https://staff.example.test',customer='https://customer.example.test';
const profile={businessName:'Example Services',contactEmail:'owner@example.test',contactPhone:'+13035550123',summary:'Home repairs and maintenance.',services:['Home repairs'],locations:['Denver'],timeZone:'America/Denver'};
const selection={accountSid:'AC'+'1'.repeat(32),messagingServiceSid:'MG'+'2'.repeat(32),phoneNumberSid:'PN'+'3'.repeat(32),phoneNumber:'+18775550180',
 profileSid:'BU'+'4'.repeat(32),profileName:'Example Services LLC',legalBusinessName:'Example Services LLC',accountName:'Platform',serviceName:'Example SMS',senderType:'toll_free',registrationSid:'HH'+'5'.repeat(32),revision:0};
async function fixture() {
 const db=await testDatabase();
 try {
  const directory=new URL('../../E2local-main/supabase/migrations/',import.meta.url);
  for(const file of (await readdir(directory)).filter(f=>f.endsWith('.sql')).sort())await db.exec(await readFile(new URL(file,directory),'utf8'));
  await db.query('select public.configure_platform_login_realms($1,$2)',[customer,crm]);
  const account=async(subject,issuer)=>{
   const id=(await db.query('select public.sync_platform_account($1,$2,$2,null,1) id',[issuer,subject])).rows[0].id;
   await db.query('update public.dashboard_accounts set personal_info=$2 where id=$1',[id,JSON.stringify({firstName:'Example',lastName:'Owner',phone:'+13035550123',role:'Owner'})]);return id;
  };
  const admin=await account('staff',crm),reader=await account('reader',crm);
  await db.query('insert into public.platform_staff_grants(account_id) values($1)',[admin]);
  await db.query("select set_config('platform.actor_issuer',$1,false)",[crm]);
  const business=async(subject)=>{
   const owner=await account(subject,customer);await db.query('select public.complete_platform_onboarding($1,$2)',[owner,JSON.stringify(profile)]);
   const tenant=(await db.query('select tenant_id from public.dashboard_business_profiles where account_id=$1',[owner])).rows[0].tenant_id;
   await call(db,'platform_action','staff','business_profile_review',{tenantId:tenant,revision:0,profile});return {owner,tenant};
  };
  return {db,admin,reader,business};
 }catch(error){await db.close();throw error;}
}
test('approved sender connection is isolated, atomic, private and visible only after per-service release',async()=>{
 const x=await fixture();try {
  const {tenant,owner}=await x.business('owner'),other=await x.business('other');
  await assert.rejects(()=>call(x.db,'twilio_connection_access','reader',tenant),/staff|Staff/);
  const first=await call(x.db,'reserve_twilio_connection','staff',tenant,selection);
  assert.equal((await x.db.query("select count(*) n from sms_private.jobs where queue='provisioning_jobs'")).rows[0].n,0);
  await assert.rejects(()=>call(x.db,'reserve_twilio_connection','staff',tenant,selection),/already being verified/);
  await assert.rejects(()=>call(x.db,'reserve_twilio_connection','staff',other.tenant,selection),/already assigned/);
  await assert.rejects(()=>call(x.db,'complete_twilio_connection','staff',other.tenant,first.id,{...selection,authToken:'private-secret-token'}));
  await call(x.db,'fail_twilio_connection','staff',tenant,first.id);
  const retry=await call(x.db,'reserve_twilio_connection','staff',tenant,selection);assert.equal(retry.id,first.id);
  const result=await call(x.db,'complete_twilio_connection','staff',tenant,first.id,{...selection,parentAccountSid:selection.accountSid,authToken:'private-secret-token'});
  assert.equal(result.connected,true);assert.equal(result.sendingEnabled,false);
  const provider=(await x.db.query('select * from sms_private.providers where tenant_id=$1',[tenant])).rows[0];
  assert.equal(provider.account_sid,selection.accountSid);assert.equal(provider.from_number,selection.phoneNumber);assert.equal(provider.connection_revision,1);
  const access=await call(x.db,'twilio_connection_access','staff',tenant);assert.equal(JSON.stringify(access).includes('private-secret'),false);
  const audit=(await x.db.query('select detail from sms_private.audit')).rows;assert.equal(JSON.stringify(audit).includes('private-secret'),false);
  const hidden=(await x.db.query('select public.read_customer_business_services($1) r',[owner])).rows[0].r;assert.deepEqual(hidden.services,[]);
  const service=(await x.db.query("select * from public.platform_business_services where tenant_id=$1 and kind='sms'",[tenant])).rows[0];
  await call(x.db,'platform_action','staff','service_visibility',{tenantId:tenant,serviceId:service.id,revision:service.revision,visibility:'live'});
  const visible=(await x.db.query('select public.read_customer_business_services($1) r',[owner])).rows[0].r;assert.equal(visible.services[0].phoneNumber,selection.phoneNumber);assert.equal(JSON.stringify(visible).includes(selection.accountSid),false);
  await assert.rejects(()=>call(x.db,'activate_twilio','staff',tenant),/canary/);
  assert.equal((await call(x.db,'reserve_twilio_connection','staff',tenant,{...selection,revision:1})).alreadyConnected,true);
  await assert.rejects(()=>call(x.db,'reserve_twilio_connection','staff',tenant,{...selection,accountSid:'AC'+'9'.repeat(32),revision:1}),/transfer/);
  await x.db.query("select set_config('platform.actor_issuer',$1,false)",[customer]);
  await assert.rejects(()=>call(x.db,'twilio_connection_access','staff',tenant),/CRM staff session/);
  assert.equal((await x.db.query("select has_table_privilege('sms_api','sms_private.twilio_connection_requests','select') allowed")).rows[0].allowed,false);
 }finally{await x.db.close();}
});
test('running bootstrap cannot be replaced; held uncertain bootstrap is cancelled without replay',async()=>{
 const x=await fixture();try {
  const {tenant}=await x.business('owner');await call(x.db,'platform_action','staff','service_add',{tenantId:tenant,kind:'sms'});
  await x.db.query("update sms_private.jobs set status='leased',lease_token=gen_random_uuid(),leased_until=now()+interval '1 minute' where tenant_id=$1",[tenant]);
  await assert.rejects(()=>call(x.db,'reserve_twilio_connection','staff',tenant,selection),/setup is running/);
  await x.db.query("update sms_private.jobs set status='submission_unknown',leased_until=null where tenant_id=$1",[tenant]);
  await x.db.query("update sms_private.providers set provisioning_state='creating_account' where tenant_id=$1",[tenant]);
  await call(x.db,'reserve_twilio_connection','staff',tenant,selection);
  const job=(await x.db.query('select status,lease_token from sms_private.jobs where tenant_id=$1',[tenant])).rows[0];assert.equal(job.status,'cancelled');assert.equal(job.lease_token,null);
  assert.equal((await x.db.query('select provisioning_state from sms_private.providers where tenant_id=$1',[tenant])).rows[0].provisioning_state,'connecting_existing');
 }finally{await x.db.close();}
});
