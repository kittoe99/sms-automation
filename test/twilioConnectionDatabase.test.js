import test from 'node:test';
import assert from 'node:assert/strict';
import {call} from './helpers/database.js';
import {fixture,selection} from './helpers/twilioConnections.js';
const customer='https://customer.example.test';
test('toll-free voice connects before SMS approval without bypassing SMS activation or ownership',async()=>{
 const x=await fixture();try {
  const other=await x.business('other');
  for(const [index,status,state] of [[0,null,'verification_pending'],[1,'IN_REVIEW','in_review'],[2,'TWILIO_REJECTED','rejected']]){
   const {tenant}=await x.business('voice-'+index);
   const s={...selection,phoneNumber:'+1877555018'+index,phoneNumberSid:'PN'+String(index+6).repeat(32),messagingServiceSid:'MG'+String(index+6).repeat(32),
    registrationSid:status?selection.registrationSid:null,smsApproved:false,voiceCapable:true,smsVerificationStatus:status||'NOT_SUBMITTED'};
   await assert.rejects(()=>call(x.db,'reserve_twilio_connection','staff',tenant,{...s,voiceCapable:false}),/Invalid Twilio sender/);
   const request=await call(x.db,'reserve_twilio_connection','staff',tenant,s);
   const result=await call(x.db,'complete_twilio_connection','staff',tenant,request.id,{...s,authToken:'voice-private-secret'});
   assert.equal(result.registrationState,state);assert.equal(result.sendingEnabled,false);
   const summary=await call(x.db,'sms_connection_summary',tenant);
   assert.equal(summary.connectionStatus,'connected');assert.equal(summary.messagingStatus,'disabled');
   assert.equal(summary.approvalStatus,state==='rejected'?'needs_attention':'in_progress');
   await assert.rejects(()=>call(x.db,'request_activation_canary','staff',tenant,{phone:'+13035550123',confirmed:true}),/no rows/);
   await assert.rejects(()=>call(x.db,'activate_twilio','staff',tenant),/Activation requirements|canary|approval/);
   await assert.rejects(()=>call(x.db,'reserve_twilio_connection','staff',other.tenant,s),/already assigned or reserved/);
   // A later verification identifier is not a sender transfer or an SMS activation.
   assert.equal((await call(x.db,'reserve_twilio_connection','staff',tenant,{...s,registrationSid:selection.registrationSid,smsApproved:true,revision:1})).alreadyConnected,true);
   assert.equal((await x.db.query('select state from public.sms_twilio_registrations where tenant_id=$1',[tenant])).rows[0].state,state);
  }
 }finally{await x.db.close();}
});
test('failed voice connection retries with fresh registration status without releasing its reservation',async()=>{
 const x=await fixture();try {
  const {tenant}=await x.business('pending');
  const pending={...selection,registrationSid:null,smsApproved:false,voiceCapable:true,smsVerificationStatus:'NOT_SUBMITTED'};
  const first=await call(x.db,'reserve_twilio_connection','staff',tenant,pending);
  await call(x.db,'fail_twilio_connection','staff',tenant,first.id);
  const approved={...selection,smsApproved:true,voiceCapable:true,smsVerificationStatus:'TWILIO_APPROVED'};
  const retry=await call(x.db,'reserve_twilio_connection','staff',tenant,approved);assert.equal(retry.id,first.id);
  const result=await call(x.db,'complete_twilio_connection','staff',tenant,retry.id,{...approved,authToken:'voice-private-secret'});
  assert.equal(result.registrationState,'webhook_verified');assert.equal(result.sendingEnabled,false);
 }finally{await x.db.close();}
});
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

test('shared accounts keep sender ownership exclusive across providers and reviewable reservations',async()=>{
 const x=await fixture();try {
  const a=await x.business('first'),b=await x.business('second'),c=await x.business('third');
  const second={...selection,phoneNumber:'+18775550181',phoneNumberSid:'PN'+'6'.repeat(32),messagingServiceSid:'MG'+'7'.repeat(32)};
  const connect=async(t,s)=>{const r=await call(x.db,'reserve_twilio_connection','staff',t,s);await call(x.db,'complete_twilio_connection','staff',t,r.id,{...s,authToken:'private-secret-token'});};
  await connect(a.tenant,selection);await connect(b.tenant,second);
  const access=await call(x.db,'twilio_connection_access','staff',a.tenant);
  assert.equal(access.bindings.length,2);assert.deepEqual(new Set(access.bindings.map(b=>b.phoneNumber)),new Set([selection.phoneNumber,second.phoneNumber]));
  assert.equal(await call(x.db,'webhook_credentials',selection.accountSid),null);
  const fresh={...selection,accountSid:'AC'+'8'.repeat(32),phoneNumber:'+18775550182',phoneNumberSid:'PN'+'8'.repeat(32),messagingServiceSid:'MG'+'8'.repeat(32)};
  for(const key of ['phoneNumber','phoneNumberSid','messagingServiceSid']){
   await assert.rejects(()=>call(x.db,'reserve_twilio_connection','staff',c.tenant,{...fresh,[key]:selection[key]}),/already assigned or reserved/);
  }
  const r=await call(x.db,'reserve_twilio_connection','staff',c.tenant,fresh);
  await call(x.db,'fail_twilio_connection','staff',c.tenant,r.id);
  const pending=await call(x.db,'twilio_connection_access','staff',null);
  assert.equal(pending.reservations[0].state,'needs_review');assert.equal(pending.reservations[0].tenantId,c.tenant);
  // Worker checkpoint/direct provider writes must respect reservations too.
  await assert.rejects(()=>x.db.query('update sms_private.providers set from_number=$1 where tenant_id=$2',[fresh.phoneNumber,b.tenant]),/already assigned or reserved/);
  assert.equal((await x.db.query('select from_number from sms_private.providers where tenant_id=$1',[b.tenant])).rows[0].from_number,second.phoneNumber);
  await assert.rejects(()=>call(x.db,'reserve_twilio_connection','staff',a.tenant,selection),/changed/);
  for(const role of ['anon','authenticated','service_role','sms_api','sms_webhook','sms_sender']){
   assert.equal((await x.db.query("select has_table_privilege($1,'sms_private.twilio_sender_claims','select') allowed",[role])).rows[0].allowed,false);
  }
 }finally{await x.db.close();}
});
