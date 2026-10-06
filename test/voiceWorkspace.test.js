import test from 'node:test';
import assert from 'node:assert/strict';
import {testDatabase,call} from './helpers/database.js';
import {createRuntimeHandler,RUNTIME_TENANT as tenant} from '../supabase/functions/voice-runtime/handler.js';
import {createVoiceMaintenance} from '../supabase/functions/voice-maintenance/handler.js';
import {createCrmHandler} from '../supabase/functions/crm-api/handler.js';
import {hmac} from '../supabase/functions/voice-agent/handler.js';
import {validateConfiguration} from '../public/voiceWorkspace.js';
import {voiceStorage} from '../supabase/functions/_shared/voice-storage.js';
const configuration={name:'Opek phone',persona:'',voice:'Speak clearly',brain:'Use approved facts',voiceName:'vesper'};
const phone='+13035550122',cid='phone-job-one';
const workspace=(db,action,p={})=>call(db,'voice_workspace','admin',tenant,action,p);
const runtime=async(db,action,p={},id=cid)=>(await db.query('select voice_runtime_api.dispatch($1,$2,$3,$4) result',[tenant,id,action,JSON.stringify(p)])).rows[0].result;
async function setup(){const db=await testDatabase();await call(db,'api_action','admin',null,'create_business',{id:tenant,name:'Voice CRM',timeZone:'UTC'});await db.query("update sms_private.providers set from_number='+18777574365' where tenant_id=$1",[tenant]);await workspace(db,'initialize',{configuration});return db;}
async function start(db,id=cid){const snapshot=await runtime(db,'configuration',{},id);return runtime(db,'start',{room:'phone-test',phone,source:'crm',revision:snapshot.revision},id);}

test('configuration drafts, optimistic publishing, immutable history and tenant boundaries',async()=>{
 const db=await setup();try{
  let a=(await workspace(db,'overview')).agents[0];const original=a.published_revision;
  await workspace(db,'save',{agentId:a.id,version:a.draft_version,configuration:{...configuration,voiceName:'marin'}});
  assert.equal((await runtime(db,'configuration')).configuration.voiceName,'vesper');
  await assert.rejects(()=>workspace(db,'publish',{agentId:a.id,version:a.draft_version}),/changed/);
  a=(await workspace(db,'overview')).agents[0];await workspace(db,'publish',{agentId:a.id,version:a.draft_version});
  assert.equal((await runtime(db,'configuration')).configuration.voiceName,'marin');
  a=(await workspace(db,'overview')).agents[0];await workspace(db,'rollback',{agentId:a.id,version:a.draft_version,revision:original});
  assert.equal((await runtime(db,'configuration')).configuration.voiceName,'vesper');
  assert.equal((await workspace(db,'overview')).agents[0].draft.voiceName,'marin');
  await assert.rejects(()=>call(db,'voice_workspace','stranger',tenant,'overview',{}));
  await assert.rejects(()=>call(db,'voice_workspace','admin','opek','initialize',{configuration}),/scope denied/);
  await db.exec('set role sms_voice_runtime');
  await runtime(db,'configuration');
  await assert.rejects(()=>workspace(db,'overview'),/permission denied/);
  await assert.rejects(()=>db.query('select * from sms_private.voice_calls'),/permission denied/);
  await assert.rejects(()=>db.query("select voice_booking_api.confirm($1,$2,gen_random_uuid())",[tenant,cid]),/permission denied/);
  await db.exec('reset role; set role sms_voice_lookup');
  await assert.rejects(()=>runtime(db,'configuration'),/permission denied/);
 }finally{await db.close();}
});

test('call retry, qualified leads and repeated callers preserve staff work and consent',async()=>{
 const db=await setup();try{
  const c=await start(db);assert.equal((await start(db)).callId,c.callId);
  await runtime(db,'outcome',{outcome:'general_inquiry',summary:'Asked about services'});
  assert.equal((await workspace(db,'leads')).total,0);
  const request={outcome:'quote_request',summary:'Requested removal quote',name:'Caller',phone,service:'junk_removal',location:'Denver',request:'Remove sofa'};
  const lead=await runtime(db,'outcome',request);assert.ok(lead.leadId);
  await call(db,'update_lead_handoff','admin',tenant,'lead',lead.leadId,{status:'assigned',owner:'Staff'});
  await start(db,'phone-job-two');assert.equal((await runtime(db,'outcome',request,'phone-job-two')).leadId,lead.leadId);
  let leads=(await workspace(db,'leads')).leads;assert.equal(leads.length,1);assert.equal(leads[0].status,'assigned');assert.equal(leads[0].owner,'Staff');assert.equal(leads[0].calls.length,2);
  await runtime(db,'finish',{status:'completed',duration:90,transcript:[{role:'user',text:'Hello'}],audio:true});
  await start(db);await runtime(db,'heartbeat');
  assert.equal((await workspace(db,'call',{id:c.callId})).call.status,'completed');
  assert.equal((await workspace(db,'calls')).calls[0].transcript,undefined);
  await assert.rejects(()=>runtime(db,'outcome',request),/ended/);
  assert.equal((await db.query('select count(*)::int n from public.sms_automation_enrollments')).rows[0].n,0);
  assert.equal((await db.query('select count(*)::int n from public.sms_messages')).rows[0].n,0);
  await db.query("update sms_private.voice_calls set seen_at=now()-interval '11 minutes' where job_id='phone-job-two'");
  await call(db,'voice_cleanup',{});
  assert.equal((await db.query("select status from sms_private.voice_calls where job_id='phone-job-two'")).rows[0].status,'interrupted');
 }finally{await db.close();}
});

test('recording expiry blocks access immediately and cleanup retains relationships',async()=>{
 const db=await setup();try{
  const c=await start(db);const upload=await runtime(db,'upload',{bytes:300});assert.match(upload.path,/audio\.ogg$/);
  await runtime(db,'uploaded',{bytes:300});assert.equal((await workspace(db,'media',{id:c.callId})).path,upload.path);
  await db.query("update sms_private.voice_calls set expires_at=now()-interval '1 day',transcript='[{\"role\":\"user\",\"text\":\"Hello\"}]' where id=$1",[c.callId]);
  await assert.rejects(()=>workspace(db,'media',{id:c.callId}),/expired/);
  assert.equal((await workspace(db,'call',{id:c.callId})).call.transcript,null);
  assert.deepEqual((await call(db,'voice_cleanup',{})).paths,[upload.path]);
  assert.equal((await workspace(db,'call',{id:c.callId})).call.media_state,'expired');
  assert.deepEqual((await call(db,'voice_cleanup',{deleted:[upload.path]})).paths,[]);
  await assert.rejects(()=>runtime(db,'upload',{bytes:300}),/expired/);
  assert.equal((await workspace(db,'calls')).total,1);
 }finally{await db.close();}
});

test('booking confirmation attributes a single booking atomically to the runtime call',async()=>{
 const db=await setup();try{
  const c=await start(db);const day=new Date(Date.now()+3*86400000).toISOString().slice(0,10);
  await call(db,'voice_save_rule','admin',tenant,{service:'junk_removal',variant:'',market:'Test',zipCodes:['80231'],timeZone:'UTC',resourcePool:'crew',enabled:true,durationMinutes:60,capacity:1,minimumNoticeMinutes:0,maximumAdvanceDays:90,weeklyAvailability:Object.fromEntries(Array.from({length:7},(_,i)=>[i,[{start:'09:00',end:'17:00'}]])),dateExceptions:[]});
  await db.query("insert into sms_private.voice_otps(tenant_id,call_id,phone,code_hash,expires_at,verified_at) values($1,$2,$3,$4,now()+interval '5 minutes',now())",[tenant,cid,phone,'a'.repeat(64)]);
  const prep=(await db.query('select voice_booking_api.prepare($1,$2,$3) result',[tenant,cid,JSON.stringify({service:'junk_removal',variant:'',zip:'80231',localDate:day,localTime:'10:00',phone,name:'Caller',address:'123 Test Street',details:{}})])).rows[0].result;
  const confirm=async()=>(await db.query('select voice_booking_api.confirm($1,$2,$3) result',[tenant,cid,prep.holdId])).rows[0].result;
  const first=await confirm();assert.equal((await confirm()).bookingId,first.bookingId);
  const booking=(await db.query('select * from public.sms_bookings where id=$1',[first.bookingId])).rows[0];assert.equal(booking.voice_call_id,c.callId);assert.equal(booking.voice_agent_id,'opek-phone');assert.ok(booking.voice_configuration_revision);
  assert.equal((await workspace(db,'call',{id:c.callId})).bookings.length,1);
  assert.equal((await workspace(db,'overview')).totals.bookings,1);
  assert.equal((await db.query('select count(*)::int n from public.sms_automation_bookings')).rows[0].n,1);
 }finally{await db.close();}
});

test('HMAC ingestion rejects model tenants and broad actions; upload verification precedes completion',async()=>{
 const secret='r'.repeat(64),calls=[],storage={upload:async()=>({signedUrl:'test'}),verify:async()=>{throw Error('incomplete');}};
 const db={call:async(...args)=>{calls.push(args);return {path:'server/path'};}};const handler=createRuntimeHandler(db,{secret,enabled:true,storage});
 const send=async input=>{const body=JSON.stringify(input),stamp=String(Math.floor(Date.now()/1000));return handler(new Request('https://test/voice-runtime',{method:'POST',headers:{'X-Voice-Timestamp':stamp,'X-Voice-Signature':await hmac(secret,`${stamp}.${body}`)},body}));};
 assert.equal((await send({action:'configuration',callId:cid,payload:{}})).status,200);assert.equal(calls[0][1],tenant);
 assert.equal((await send({action:'configuration',callId:cid,tenant:'other',payload:{}})).status,400);
 assert.equal((await send({action:'confirm',callId:cid,payload:{}})).status,400);
 assert.equal((await send({action:'uploaded',callId:cid,payload:{bytes:300}})).status,500);
 assert.equal(calls.some(x=>x[3]==='uploaded'),false);
 assert.equal((await handler(new Request('https://test',{method:'POST',body:'{}'}))).status,401);
 const staffCalls=[];const crm=createCrmHandler({call:async(...a)=>{staffCalls.push(a);return {agents:[]};}},async()=> 'admin');
 assert.equal((await crm(new Request('https://test/api/voice',{headers:{'X-Tenant-ID':tenant}}))).status,200);
 assert.deepEqual(staffCalls[0].slice(0,4),['voice_workspace','admin',tenant,'overview']);
});

test('cleanup retries storage failures without acknowledging deletion; client validates drafts',async()=>{
 validateConfiguration(configuration);assert.throws(()=>validateConfiguration({...configuration,voice:''}),/voice/);
 const calls=[];const db={call:async(...a)=>{calls.push(a);return {paths:['one']};}};
 const handler=createVoiceMaintenance(db,{secret:'x'.repeat(32),storage:{remove:async()=>{throw Error('offline');}}});
 assert.equal((await handler(new Request('https://test',{method:'POST',headers:{Authorization:`Bearer ${'x'.repeat(32)}`}}))).status,500);
 assert.equal(calls.length,1);assert.equal((await handler(new Request('https://test',{method:'POST'}))).status,401);
});

test('private Storage wire formats produce signed URLs and verify actual uploaded objects',async()=>{
 const oldUrl=process.env.SUPABASE_URL,oldKey=process.env.SUPABASE_SERVICE_ROLE_KEY;
 process.env.SUPABASE_URL='https://project.supabase.co';process.env.SUPABASE_SERVICE_ROLE_KEY='test-only';
 try{
  let size=300;const storage=voiceStorage(async url=>new Response(JSON.stringify(url.includes('/object/info/')?{size,content_type:'audio/ogg'}:url.includes('/upload/sign/')?{url:'/object/upload/sign/voice-recordings/business/call/audio.ogg?token=test'}:{signedURL:'/object/sign/voice-recordings/business/call/audio.ogg?token=read'})));
  assert.match((await storage.upload('business/call/audio.ogg')).signedUrl,/^https:\/\/project.supabase.co\/storage\/v1\/object\/upload\/sign\//);
  assert.equal((await storage.playback('business/call/audio.ogg')).expiresIn,300);
  await storage.verify('business/call/audio.ogg',300);size=200;
  await assert.rejects(()=>storage.verify('business/call/audio.ogg',300),/incomplete/);
 }finally{if(oldUrl===undefined)delete process.env.SUPABASE_URL;else process.env.SUPABASE_URL=oldUrl;if(oldKey===undefined)delete process.env.SUPABASE_SERVICE_ROLE_KEY;else process.env.SUPABASE_SERVICE_ROLE_KEY=oldKey;}
});
