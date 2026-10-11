import test from 'node:test';
import assert from 'node:assert/strict';
import {call} from './helpers/database.js';
import {fixture,selection} from './helpers/twilioConnections.js';
const customer='https://customer.example.test';
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
