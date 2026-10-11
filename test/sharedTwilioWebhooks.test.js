import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,selection} from './helpers/twilioConnections.js';
import {call} from './helpers/database.js';
import {createTwilioHandler,twilioSignature} from '../supabase/functions/twilio-webhook/handler.js';
import {createSoniInboundHandler} from '../supabase/functions/soni-voice-inbound/handler.js';

test('shared account callbacks isolate inbound, STOP, calls, early delivery and duplicate events',async()=>{
 const x=await fixture();try {
  const a=await x.business('first'),b=await x.business('second');
  const second={...selection,phoneNumber:'+18777574365',phoneNumberSid:'PN'+'6'.repeat(32),messagingServiceSid:'MG'+'7'.repeat(32)};
  for(const [tenant,s] of [[a.tenant,selection],[b.tenant,second]]){
   const r=await call(x.db,'reserve_twilio_connection','staff',tenant,s);
   await call(x.db,'complete_twilio_connection','staff',tenant,r.id,{...s,authToken:'shared-private-token'});
  }
  const adapter={call:(name,...args)=>call(x.db,name,...args)},base='https://example.test/twilio',hook=createTwilioHandler(adapter,base),customer='+13035550999';
  const request=async(url,p,token='shared-private-token')=>new Request(url,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded','X-Twilio-Signature':await twilioSignature(token,url,p)},body:new URLSearchParams(p)});
  const send=async(event,p,query='',token)=>hook(await request(base+'/'+event+query,p,token));
  const incoming={AccountSid:selection.accountSid,From:customer,To:selection.phoneNumber,Body:'Hello',MessageSid:'SM_first'};
  assert.equal((await send('inbound',incoming,'','bad-token')).status,403);
  assert.equal((await send('inbound',{...incoming,To:'+18775550998'})).status,403);
  for(const p of [incoming,{...incoming,To:second.phoneNumber,MessageSid:'SM_second'}]){
   assert.equal((await send('inbound',p)).status,200);assert.equal((await send('inbound',p)).status,200);
  }
  let messages=(await x.db.query("select tenant_id,sid from public.sms_messages where direction='inbound'")).rows;
  assert.equal(messages.length,2);assert.equal(messages.find(m=>m.sid==='SM_second').tenant_id,b.tenant);
  assert.equal((await send('inbound',{...incoming,MessageSid:'SM_stop',Body:'STOP'})).status,200);
  const contacts=(await x.db.query('select tenant_id,opted_out from public.sms_contacts where phone=$1',[customer])).rows;
  assert.equal(contacts.find(c=>c.tenant_id===a.tenant).opted_out,true);assert.equal(contacts.find(c=>c.tenant_id===b.tenant).opted_out,false);
  const voice={AccountSid:selection.accountSid,To:second.phoneNumber,From:customer,CallSid:'CA_shared',CallStatus:'completed',CallDuration:'12',Direction:'inbound'};
  assert.equal((await send('call',voice)).status,200);
  assert.equal((await x.db.query('select tenant_id from public.sms_voice_conversations where conversation_id=$1',[voice.CallSid])).rows[0].tenant_id,b.tenant);
  const voiceUrl='https://example.test/soni';
  const soni=createSoniInboundHandler(adapter,{base:voiceUrl,tenantId:b.tenant,sipUsername:'test_sip_username',sipPassword:'S'.repeat(32)});
  assert.equal((await soni(await request(voiceUrl,voice))).status,200);
  assert.equal((await soni(await request(voiceUrl,{...voice,To:selection.phoneNumber}))).status,403);
  const mid=(await x.db.query("insert into public.sms_messages(tenant_id,contact_phone,direction,body,status) values($1,$2,'outbound','Test','submitting') returning id",[b.tenant,customer])).rows[0].id;
  const jid=await call(x.db,'enqueue',b.tenant,'sms_send_jobs','shared-status',{message_id:mid,request:{phone:customer,body:'Test'}});
  await x.db.query("update sms_private.jobs set status='submitting' where id=$1",[jid]);
  const aid=(await x.db.query('insert into sms_private.attempts(job_id,lease_token) values($1,gen_random_uuid()) returning id',[jid])).rows[0].id;
  // Early callbacks can omit From and precede the worker saving MessageSid.
  const status={AccountSid:selection.accountSid,MessageSid:'SM_outbound',MessageStatus:'delivered'},query='?attempt_id='+aid;
  assert.equal((await send('status',status,query,'invalid')).status,403);
  assert.equal((await send('status',{...status,From:selection.phoneNumber},query)).status,403);
  assert.equal((await send('status',{...status,MessagingServiceSid:selection.messagingServiceSid},query)).status,403);
  assert.equal((await send('status',{...status,AccountSid:'AC'+'9'.repeat(32)},query)).status,403);
  assert.equal((await send('status',{...status,To:'+13035550998'},query)).status,403);
  assert.equal((await send('status',status,query)).status,200);
  assert.equal((await send('status',status,query)).status,200);
  assert.equal((await send('status',status)).status,200);
  assert.equal((await send('status',{...status,MessageSid:'SM_wrong'},query)).status,403);
  assert.equal((await send('status',{...status,attempt_id:aid})).status,400);
  assert.equal((await send('status',status,query+'&attempt_id='+aid)).status,400);
  const events=(await x.db.query('select tenant_id from public.sms_message_events where message_id=$1',[mid])).rows;
  assert.equal(events.length,1);assert.equal(events[0].tenant_id,b.tenant);
  assert.equal((await x.db.query('select status,sid from public.sms_messages where id=$1',[mid])).rows[0].status,'delivered');
  for(const role of ['anon','authenticated','service_role','sms_api'])assert.equal((await x.db.query("select has_function_privilege($1,'sms_private.resolve_twilio_webhook(text,text,jsonb,text)','execute') allowed",[role])).rows[0].allowed,false);
 }finally{await x.db.close();}
});
