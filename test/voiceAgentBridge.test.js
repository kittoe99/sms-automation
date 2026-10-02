import test from 'node:test';
import assert from 'node:assert/strict';
import {testDatabase,call} from './helpers/database.js';
import {createVoiceHandler,hmac} from '../supabase/functions/voice-agent/handler.js';

const phone='+13035550122';
const hours=Object.fromEntries(Array.from({length:7},(_,day)=>[day,[{start:'00:00',end:'23:59'}]]));

test('voice intake, verification, booking, cancellation, and SMS use one tenant',async()=>{
  const db=await testDatabase();
  try{
    await call(db,'api_action','admin',null,'create_business',{id:'opek',name:'Opek',timeZone:'UTC'});
    await db.exec("update public.sms_businesses set status='active',sending_enabled=true where tenant_id='opek'");
    const quote=await call(db,'voice_create_intake','opek','test-call-123','quote_requests',
      {name:'Alex',phone,details:{service:'local_moving',summary:'one bedroom'}},'voice-quote-1');
    assert.ok(quote.id);
    assert.equal((await db.query("select skip_reason from public.sms_automation_quote_requests where id=$1",[quote.id])).rows[0].skip_reason,'VOICE_EXPLICIT_SMS_ONLY');
    assert.equal((await call(db,'voice_create_intake','opek','test-call-123','quote_requests',
      {name:'Alex',phone,details:{}},'voice-quote-1')).duplicate,true);
    await assert.rejects(()=>call(db,'voice_lookup','opek','test-call-123',phone),/Verification required/);
    const sent=await call(db,'voice_start_otp','opek','test-call-123',phone,'a'.repeat(64),
      'Your Opek verification code is 123456. It expires in five minutes.');
    assert.equal(sent.status,'queued');
    assert.equal((await call(db,'voice_verify_otp','opek','test-call-123',phone,'b'.repeat(64))).verified,false);
    assert.equal((await call(db,'voice_verify_otp','opek','test-call-123',phone,'a'.repeat(64))).verified,true);
    const found=await call(db,'voice_lookup','opek','test-call-123',phone);
    assert.equal(found.quotes.length,1);
    const updated=await call(db,'voice_update_record','opek','test-call-123',phone,
      'quote',quote.id,{details:{summary:'two bedrooms'}});
    assert.equal(updated.details.summary,'two bedrooms');
    await call(db,'voice_update_record','opek','test-call-123',phone,
      'contact','',{name:'Alex Corrected'});
    assert.equal((await call(db,'voice_lookup','opek','test-call-123',phone)).contact.name,'Alex Corrected');
    const day=new Date(Date.now()+3*86400000).toISOString().slice(0,10);
    await call(db,'voice_save_rule','admin','opek',{
      service:'local_moving',market:'Denver test',zipCodes:['80231'],timeZone:'UTC',
      resourcePool:'crew-a',enabled:true,durationMinutes:120,capacity:1,
      minimumNoticeMinutes:0,maximumAdvanceDays:90,weeklyAvailability:hours,
    });
    const booking={service:'local_moving',name:'Alex',phone,zip:'80231',
      address:'123 Test Avenue, Denver CO 80231',localDate:day,localTime:'12:00',details:{bedrooms:1}};
    const prepared=await call(db,'voice_prepare_booking','opek','test-call-123',booking);
    assert.equal(prepared.available,true);
    const confirmed=await call(db,'voice_confirm_booking','opek','test-call-123',prepared.holdId,phone);
    assert.equal(confirmed.status,'confirmed');
    assert.equal((await call(db,'voice_confirm_booking','opek','test-call-123',prepared.holdId,phone)).duplicate,true);
    assert.equal((await call(db,'voice_prepare_booking','opek','second-call-123',{...booking,phone:'+13035550123'})).available,false);
    const intake=(await db.query("select status,source_record_id from public.sms_automation_bookings where tenant_id='opek'")).rows[0];
    assert.equal(intake.source_record_id,confirmed.bookingId);
    assert.equal(intake.status,'confirmed');
    assert.equal((await db.query("select count(*)::int as count from public.sms_automation_bookings where tenant_id='opek'")).rows[0].count,1);
    assert.equal((await db.query("select skip_reason from public.sms_automation_bookings where tenant_id='opek'")).rows[0].skip_reason,'VOICE_EXPLICIT_SMS_ONLY');
    const nextDay=new Date(Date.now()+4*86400000).toISOString().slice(0,10);
    const moved=await call(db,'voice_prepare_booking','opek','test-call-123',
      {...booking,localDate:nextDay,existingBookingId:confirmed.bookingId});
    assert.equal(moved.available,true);
    assert.equal((await call(db,'voice_confirm_booking','opek','test-call-123',moved.holdId,phone)).status,'confirmed');
    assert.equal((await db.query("select count(*)::int as count from public.sms_automation_bookings where tenant_id='opek'")).rows[0].count,1);
    assert.equal((await db.query("select appointment_at::date::text as day from public.sms_automation_bookings where tenant_id='opek'")).rows[0].day,nextDay);
    const sms=await call(db,'voice_send_sms','opek','test-call-123',phone,phone,'Your Opek booking is confirmed.','test-text-1');
    assert.equal(sms.status,'queued');
    const cancelled=await call(db,'voice_cancel_booking','opek','test-call-123',phone,confirmed.bookingId,'test-cancel-1');
    assert.equal(cancelled.status,'cancelled');
    assert.equal((await call(db,'voice_cancel_booking','opek','test-call-123',phone,confirmed.bookingId,'test-cancel-1')).duplicate,true);
    assert.equal((await db.query("select status from public.sms_automation_bookings where source_record_id=$1",[confirmed.bookingId])).rows[0].status,'cancelled');
    await assert.rejects(()=>call(db,'voice_create_intake','other','test-call-123','contacts',
      {name:'Alex',phone},'other-intake-1'),/Invalid intake/);
  }finally{await db.close();}
});

test('Edge voice endpoint checks its signature and never returns the verification code',async()=>{
  const secret='s'.repeat(64),otpSecret='o'.repeat(64),calls=[];
  const handler=createVoiceHandler({call:async(...args)=>{calls.push(args);return {status:'queued'};}},{secret,otpSecret});
  const input={action:'verify.start',callId:'test-call-123',callerNumber:null,payload:{phone},requestId:null};
  const body=JSON.stringify(input),stamp=String(Math.floor(Date.now()/1000));
  const signed=new Request('https://example.com/functions/v1/voice-agent',{method:'POST',
    headers:{'X-Voice-Timestamp':stamp,'X-Voice-Signature':await hmac(secret,`${stamp}.${body}`)},body});
  const response=await handler(signed);
  assert.equal(response.status,200);
  assert.equal((await response.json()).result.status,'queued');
  assert.equal(calls[0][0],'voice_start_otp');
  assert.ok(calls[0][5].includes('verification code'));
  const bad=await handler(new Request('https://example.com/functions/v1/voice-agent',{method:'POST',
    headers:{'X-Voice-Timestamp':stamp,'X-Voice-Signature':'0'.repeat(64)},body}));
  assert.equal(bad.status,401);
  assert.equal(calls.length,1);
});

test('voice database role has RPC access without direct customer-table access',async()=>{
  const db=await testDatabase();
  try{
    await db.exec('set role sms_voice');
    await assert.rejects(()=>db.query('select * from public.sms_contacts'),/permission denied/);
    await assert.rejects(()=>db.query('select * from sms_private.voice_otps'),/permission denied/);
    await assert.rejects(()=>call(db,'voice_save_rule','admin','opek',{}),/permission denied/);
    assert.equal((await call(db,'voice_verify_otp','opek','test-call-123',phone,'a'.repeat(64))).verified,false);
  }finally{await db.exec('reset role');await db.close();}
});
