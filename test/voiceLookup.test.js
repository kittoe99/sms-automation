import test from 'node:test';
import assert from 'node:assert/strict';
import {testDatabase,call} from './helpers/database.js';
import {createLookupHandler} from '../supabase/functions/voice-lookup/handler.js';
import {hmac} from '../supabase/functions/voice-agent/handler.js';

const tenant='biz-1c0c09ce-819e-4795-86b9-0e457ab92f58',phone='+13035550122',callId='lookup-test-call';

test('lookup gateway signs exact bodies, pins tenant, rejects writes and invalid payloads',async()=>{
  const calls=[],secret='s'.repeat(64),handler=createLookupHandler({call:async(...args)=>{calls.push(args);return {hasApprovedProfile:true};}},
    {secret,otpSecret:'o'.repeat(64)});
  async function send(input,{signature,stamp=String(Math.floor(Date.now()/1000))}={}){
    const body=JSON.stringify(input);
    return handler(new Request('https://example.com/functions/v1/voice-lookup',{method:'POST',body,
      headers:{'X-Voice-Timestamp':stamp,'X-Voice-Signature':signature??await hmac(secret,`${stamp}.${body}`)}}));
  }
  const request={action:'business.lookup',callId,payload:{query:'pricing'}};
  assert.equal((await send(request)).status,200);
  assert.deepEqual(calls[0],['voice_read_business',tenant,'pricing']);
  for(const input of [{...request,tenant:'other'},{...request,action:'booking.confirm'},
    {...request,payload:{query:'pricing',table:'sms_contacts'}},{...request,payload:{query:'x'.repeat(501)}},null]){
    assert.equal((await send(input)).status,400);
  }
  assert.equal((await send(request,{signature:'0'.repeat(64)})).status,401);
  assert.equal((await send(request,{stamp:'1'})).status,401);
  assert.equal(calls.length,1);
  const queued=createLookupHandler({call:async(name,...args)=>{
    assert.equal(name,'voice_read_start_otp');assert.equal(args[0],tenant);
    assert.match(args[3],/^[a-f0-9]{64}$/);assert.match(args[4],/\d{6}/);
    return {status:'queued',phoneLastFour:'0122'};
  }},{secret,otpSecret:'o'.repeat(64)});
  const body=JSON.stringify({action:'verify.start',callId,payload:{phone}}),stamp=String(Math.floor(Date.now()/1000));
  const result=await queued(new Request('https://example.com',{method:'POST',body,
    headers:{'X-Voice-Timestamp':stamp,'X-Voice-Signature':await hmac(secret,`${stamp}.${body}`)}}));
  const data=await result.json();assert.equal(data.result.status,'queued');
  assert.equal(data.result.code,undefined);
});

test('database lookup is approved-only, tenant-bound, verified per call, and RPC-only',async()=>{
  const db=await testDatabase();
  try{
    await db.query("insert into public.sms_businesses(tenant_id,name,time_zone,status,sending_enabled) values($1,'Lookup test','UTC','active',true)",[tenant]);
    await db.query("insert into sms_private.providers(tenant_id,from_number) values($1,'+18777574365')",[tenant]);
    const profile=await db.query(`insert into public.sms_business_profile_versions(tenant_id,version,facts,status,content_hash,created_by,approved_by,approved_at)
      values($1,1,'{"businessName":"Test business","pricing":["Approved rate"],"internalSecret":"hidden"}','approved','test-hash','admin','admin',now()) returning id`,[tenant]);
    await db.query('update public.sms_businesses set active_profile_version_id=$2 where tenant_id=$1',[tenant,profile.rows[0].id]);
    let info=await call(db,'voice_read_business',tenant,'pricing');
    assert.equal(info.hasApprovedProfile,true);assert.equal(info.approvedFacts.internalSecret,undefined);
    assert.deepEqual(info.approvedFacts.pricing,['Approved rate']);
    await assert.rejects(()=>call(db,'voice_read_business','other',''),/scope denied/);
    await assert.rejects(()=>call(db,'voice_read_customer',tenant,callId,phone),/verification required/);
    await db.query("insert into public.sms_contacts(tenant_id,phone,name) values($1,$2,'Verified customer')",[tenant,phone]);
    await db.query("insert into public.sms_bookings(tenant_id,id,contact_id,appointment_at,customer_phone,customer_name,service_address,time_zone,status) values($1,'booking-test',(select id from public.sms_contacts where tenant_id=$1 and phone=$2),now()+interval '1 day',$2,'Verified customer','Test address','UTC','confirmed')",[tenant,phone]);
    const queued=await call(db,'voice_read_start_otp',tenant,callId,phone,'a'.repeat(64),'Your business verification code is 123456. It expires in five minutes.');
    assert.equal(queued.status,'queued');assert.equal(queued.code,undefined);
    await assert.rejects(()=>call(db,'voice_read_start_otp',tenant,callId,phone,'a'.repeat(64),'Your business verification code is 123456. It expires in five minutes.'),/Wait before/);
    assert.equal((await db.query("select count(*)::integer as n from sms_private.jobs where queue='sms_send_jobs' and tenant_id=$1",[tenant])).rows[0].n,1);
    assert.equal((await call(db,'voice_read_verify_otp',tenant,callId,phone,'b'.repeat(64))).verified,false);
    assert.equal((await call(db,'voice_read_verify_otp',tenant,callId,phone,'a'.repeat(64))).verified,true);
    const customer=await call(db,'voice_read_customer',tenant,callId,phone);
    assert.equal(customer.bookings.length,1);assert.equal(customer.bookings[0].id,'booking-test');
    await assert.rejects(()=>call(db,'voice_read_customer',tenant,'other-test-call',phone),/verification required/);
    await assert.rejects(()=>call(db,'voice_read_customer',tenant,callId,'+13035550123'),/verification required/);
    await db.query("update sms_private.voice_otps set verified_at=now()-interval '31 minutes' where tenant_id=$1",[tenant]);
    await assert.rejects(()=>call(db,'voice_read_customer',tenant,callId,phone),/verification required/);
    await db.query("update public.sms_business_profile_versions set status='superseded' where tenant_id=$1",[tenant]);
    info=await call(db,'voice_read_business',tenant,'pricing');assert.deepEqual(info.approvedFacts,{});
    await db.exec('set role sms_voice_lookup');
    assert.equal((await db.query('select voice_lookup_api.voice_read_business($1,$2) as result',[tenant,''])).rows[0].result.hasApprovedProfile,false);
    await assert.rejects(()=>db.query('select * from public.sms_contacts'),/permission denied/);
    await assert.rejects(()=>db.query('select * from public.sms_bookings'),/permission denied/);
    await assert.rejects(()=>call(db,'voice_create_intake',tenant,callId,'contacts',{},'request-id'),/permission denied/);
    await assert.rejects(()=>db.query('select sms_private.enqueue_due_automations()'),/permission denied/);
    assert.equal((await db.query("select has_schema_privilege(current_user,'sms_private','USAGE') as allowed")).rows[0].allowed,false);
    await db.exec('reset role');
    await db.query("update sms_private.providers set from_number='+13035550123' where tenant_id=$1",[tenant]);
    await assert.rejects(()=>call(db,'voice_read_business',tenant,''),/scope denied/);
  }finally{await db.exec('reset role');await db.close();}
});
