import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {testDatabase,call} from './helpers/database.js';
import {createSmsHandler} from '../supabase/functions/voice-sms/handler.js';
import {smsDatabase} from '../supabase/functions/voice-sms/database.js';
import {hmac} from '../supabase/functions/voice-agent/handler.js';
const tenant='biz-1c0c09ce-819e-4795-86b9-0e457ab92f58',phone='+13035550122',cid='sms-call-test-123';
const rpc=async(db,name,...args)=>(await db.query(`select voice_sms_api.${name}(${args.map((_,i)=>'$'+(i+1)).join(',')}) result`,args.map(x=>typeof x==='object'?JSON.stringify(x):x))).rows[0].result;
async function setup(){
 const db=await testDatabase();
 await call(db,'api_action','admin',null,'create_business',{id:tenant,name:'SMS test',timeZone:'America/Denver'});
 const profile=(await db.query(`insert into public.sms_business_profile_versions(tenant_id,version,facts,status,content_hash,created_by,approved_by,approved_at)
 values($1,1,'{}','approved','sms-test','admin','admin',now()) returning id`,[tenant])).rows[0];
 await db.query("update public.sms_businesses set active_profile_version_id=$2,status='active',sending_enabled=true where tenant_id=$1",[tenant,profile.id]);
 await db.query("update sms_private.providers set from_number='+18777574365',phone_number_sid='PN33333333333333333333333333333333',account_sid='AC11111111111111111111111111111111',messaging_service_sid='MG22222222222222222222222222222222',auth_secret_id=gen_random_uuid() where tenant_id=$1",[tenant]);
 await db.query("insert into public.sms_twilio_registrations(tenant_id,sender_type,state,messaging_service_sid) values($1,'toll_free','ready','MG22222222222222222222222222222222') on conflict(tenant_id) do update set state='ready',messaging_service_sid='MG22222222222222222222222222222222'",[tenant]);
 await db.query("insert into sms_private.voice_otps(tenant_id,call_id,phone,code_hash,expires_at,verified_at) values($1,$2,$3,$4,now()+interval '5 minutes',now())",[tenant,cid,phone,'a'.repeat(64)]);
 return db;
}
const payload=(body='Your requested service link: https://opekjunkremoval.com/booking')=>({phone,body,requestId:randomUUID()});

test('in-call SMS queues one transactional message, preserves consent, retries once and stays RPC-only',async()=>{
 const db=await setup();try{
  assert.equal((await rpc(db,'readiness',tenant,cid)).ready,true);
  const p=payload(),a=await rpc(db,'send',tenant,cid,p),b=await rpc(db,'send',tenant,cid,p);
  assert.equal(a.status,'queued');assert.equal(a.messageId,b.messageId);assert.equal(b.duplicate,true);
  assert.equal((await db.query('select count(*)::int n from public.sms_messages where tenant_id=$1',[tenant])).rows[0].n,1);
  const contact=(await db.query('select marketing_consent,opted_out from public.sms_contacts where tenant_id=$1 and phone=$2',[tenant,phone])).rows[0];
  assert.equal(contact.marketing_consent,false);assert.equal(contact.opted_out,false);
  assert.equal((await db.query("select payload->'request'->>'purpose' purpose from sms_private.jobs where queue='sms_send_jobs'")).rows[0].purpose,'transactional');
  await assert.rejects(()=>rpc(db,'send',tenant,cid,{...p,body:'Changed message'}),/changed/);
  await assert.rejects(()=>rpc(db,'send','other-business',cid,p),/scope denied/);
  await assert.rejects(()=>rpc(db,'send',tenant,'another-call',payload()),/verify|caller/i);
  await db.exec('set role sms_voice_sms');
  assert.equal((await rpc(db,'readiness',tenant,cid)).ready,true);
  await assert.rejects(()=>db.query('select * from public.sms_contacts'),/permission denied/);
  await assert.rejects(()=>db.query('select * from sms_private.voice_sms_requests'),/permission denied/);
  await assert.rejects(()=>db.query("select voice_booking_api.confirm($1,$2,$3)",[tenant,cid,randomUUID()]),/permission denied/);
  await db.exec('reset role;set role sms_voice_lookup');
  await assert.rejects(()=>rpc(db,'send',tenant,cid,p),/permission denied/);
 }finally{await db.exec('reset role');await db.close();}
});

test('SMS opt-outs, disabled sending, expired verification and per-call limits block new messages',async()=>{
 const db=await setup();try{
  await db.query("insert into public.sms_contacts(tenant_id,phone,opted_out) values($1,$2,true)",[tenant,phone]);
  await assert.rejects(()=>rpc(db,'send',tenant,cid,payload()),/consent/i);
  await db.query('update public.sms_contacts set opted_out=false where tenant_id=$1',[tenant]);
  await db.query('update public.sms_businesses set sending_enabled=false where tenant_id=$1',[tenant]);
  await assert.rejects(()=>rpc(db,'send',tenant,cid,payload()),/unavailable/i);
  await db.query('update public.sms_businesses set sending_enabled=true where tenant_id=$1',[tenant]);
  await db.query("update sms_private.voice_otps set verified_at=now()-interval '31 minutes' where tenant_id=$1",[tenant]);
  await assert.rejects(()=>rpc(db,'send',tenant,cid,payload()),/verify|caller/i);
  await db.query('update sms_private.voice_otps set verified_at=now() where tenant_id=$1',[tenant]);
  for(let i=0;i<5;i++)assert.equal((await rpc(db,'send',tenant,cid,payload(`Requested update ${i}`))).status,'queued');
  await assert.rejects(()=>rpc(db,'send',tenant,cid,payload()),/limit/);
  assert.equal((await db.query('select count(*)::int n from public.sms_messages where tenant_id=$1',[tenant])).rows[0].n,5);
 }finally{await db.close();}
});

test('active SIP caller can receive a requested text but caller ID cannot read customer data or target another phone',async()=>{
 const db=await setup();try{
  await db.query('delete from sms_private.voice_otps where tenant_id=$1',[tenant]);
  await db.query("insert into sms_private.voice_agents(tenant_id,id,deployment_id,agent_name,phone,draft) values($1,'opek-phone','test-deploy','voice-agent-phone','+18777574365','{}')",[tenant]);
  await db.query("insert into sms_private.voice_calls(tenant_id,agent_id,job_id,room_id,sip_call_id,phone) values($1,'opek-phone',$2,'phone-test','CA-test',$3)",[tenant,cid,phone]);
  assert.equal((await rpc(db,'send',tenant,cid,payload())).status,'queued');
  await assert.rejects(()=>rpc(db,'send',tenant,cid,{...payload(),phone:'+13035550123'}),/verify|caller/i);
  await assert.rejects(()=>call(db,'voice_read_customer',tenant,cid,phone),/verification/i);
  await db.query("update sms_private.voice_calls set seen_at=now()-interval '3 minutes' where tenant_id=$1",[tenant]);
  await assert.rejects(()=>rpc(db,'send',tenant,cid,payload()),/verify|caller/i);
 }finally{await db.close();}
});

test('SMS gateway pins scope, authenticates HMAC, defaults disabled and rejects broad actions',async()=>{
 const calls=[],secret='x'.repeat(64),db={call:async(...args)=>{calls.push(args);return {ready:true};}},handler=createSmsHandler(db,{secret,enabled:true});
 const send=async(input,target=handler,valid=true)=>{const body=JSON.stringify(input),stamp=String(Math.floor(Date.now()/1000));return target(new Request('https://example.test/voice-sms',{method:'POST',body,headers:{'X-Voice-Timestamp':stamp,'X-Voice-Signature':valid?await hmac(secret,`${stamp}.${body}`):'0'.repeat(64)}}));};
 const p={action:'readiness',callId:cid,payload:{}};
 assert.equal((await send(p)).status,200);assert.deepEqual(calls[0],['readiness',tenant,cid]);
 for(const bad of [{...p,tenantId:'other'},{...p,action:'booking.confirm'},{...p,payload:{sql:'select 1'}}])assert.equal((await send(bad)).status,400);
 assert.equal((await send(p,handler,false)).status,401);
 assert.equal((await send(p,createSmsHandler(db,{secret}))).status,503);
 assert.equal(calls.length,1);
 await assert.rejects(()=>smsDatabase('fake').call('booking.confirm'),/Unsupported/);
});
