import test from 'node:test';
import assert from 'node:assert/strict';
import {testDatabase,call} from './helpers/database.js';
import {createSoniInboundHandler} from '../supabase/functions/soni-voice-inbound/handler.js';
import {twilioSignature} from '../supabase/functions/twilio-webhook/handler.js';
import {bookingSchedule} from '../src/mcp/bookingSchemas.js';

const opek='biz-1c0c09ce-819e-4795-86b9-0e457ab92f58',plumber='biz-mile-high-test';
const opekNumber='+18777574365',plumberNumber='+18777524664',caller='+13035550122';
const base={name:'Phone',persona:'',voice:'Speak clearly',brain:'Use approved facts',voiceName:'marin'};
const day=new Date(Date.now()+3*86400000).toISOString().slice(0,10);
const windows=Object.fromEntries(Array.from({length:7},(_,i)=>[i,[{start:'08:00',end:'12:00'},{start:'12:00',end:'16:00'}]]));
const json=x=>typeof x==='object'?JSON.stringify(x):x;
const sql=async(db,fn,...args)=>(await db.query(`select ${fn}(${args.map((_,i)=>'$'+(i+1)).join(',')}) as result`,args.map(json))).rows[0].result;
const runtime=(db,cid,action,p={})=>sql(db,'voice_runtime_api.dispatch',opek,cid,action,p);
const booking=(db,name,cid,p)=>sql(db,`voice_booking_api.${name}`,opek,cid,p);

async function setup(){
 const db=await testDatabase();
 for(const [id,name] of [[opek,'Opek'],[plumber,'Mile High Plumbing']])
  await call(db,'api_action','admin',null,'create_business',{id,name,timeZone:'UTC'});
 await db.query("update sms_private.providers set from_number=$2 where tenant_id=$1",[opek,opekNumber]);
 await db.query("delete from sms_private.providers where tenant_id=$1",[plumber]);
 const opekWs=(action,p={})=>call(db,'voice_workspace','admin',opek,action,p);
 await opekWs('initialize',{configuration:{...base,name:'Opek phone'}});
 const o=(await opekWs('overview')).agents[0];
 await opekWs('publish',{agentId:o.id,version:o.draft_version});
 // Opek's agent id is the fixed 'opek-phone' the runtime falls back to.
 assert.equal(o.id,'opek-phone');
 const created=await call(db,'voice_workspace','admin',plumber,'create',{requestId:'5eabfb8e-047a-4c37-8c47-45863f8afe3b',configuration:{...base,name:'Plumbing phone',voice:'Plumbing voice'}});
 await db.query("update sms_private.voice_agents set deployment_id='CA_test',agent_name='voice-agent-phone',phone=$2 where tenant_id=$1",[plumber,plumberNumber]);
 const ws=(action,p={})=>call(db,'voice_workspace','admin',plumber,action,p);
 const a=(await ws('overview')).agents.find(x=>x.id===created.agentId);
 await ws('publish',{agentId:a.id,version:a.draft_version});
 return {db,agentId:created.agentId};
}

test('the dialed number picks the business; calls without one stay on Opek',async()=>{
 const {db,agentId}=await setup();try{
  const opekCfg=await runtime(db,'phone-job-opek-1','configuration');
  assert.equal(opekCfg.agentId,'opek-phone');assert.equal(opekCfg.configuration.name,'Opek phone');
  const cfg=await runtime(db,'phone-job-plumb-1','configuration',{dialed:plumberNumber});
  assert.equal(cfg.agentId,agentId);assert.equal(cfg.configuration.voice,'Plumbing voice');
  await runtime(db,'phone-job-plumb-1','start',{room:'phone-plumb-1',phone:caller,revision:cfg.revision,source:'crm',dialed:plumberNumber});
  await runtime(db,'phone-job-opek-1','start',{room:'phone-opek-1',phone:caller,revision:opekCfg.revision,source:'crm'});
  const calls=(await db.query('select tenant_id,agent_id,job_id from sms_private.voice_calls order by job_id')).rows;
  assert.deepEqual(calls.map(c=>[c.job_id,c.tenant_id,c.agent_id]),[['phone-job-opek-1',opek,'opek-phone'],['phone-job-plumb-1',plumber,agentId]]);
  // Later actions keep the business the call started with, even without the dialed number.
  const saved=await runtime(db,'phone-job-plumb-1','outcome',{outcome:'service_request',summary:'Leaking water heater',phone:caller,name:'Pat'});
  assert.equal(saved.saved,true);
  assert.equal((await db.query('select tenant_id from public.sms_leads where id=$1',[saved.leadId])).rows[0].tenant_id,plumber);
  await assert.rejects(()=>runtime(db,'phone-job-x','configuration',{dialed:'+18005550100'}),/No voice agent answers/);
  await assert.rejects(()=>runtime(db,'phone-job-x','configuration',{dialed:'not-a-number'}),/Invalid dialed/);
 }finally{await db.close();}
});

test('a plumbing call books arrival windows in its own business with no Opek late fee',async()=>{
 const {db}=await setup();try{
  const rule={service:'plumbing_service',market:'Denver metro',resourcePool:'plumbers',timeZone:'UTC',enabled:true,
   durationMinutes:240,capacity:2,minimumNoticeMinutes:0,maximumAdvanceDays:90,weeklyAvailability:structuredClone(windows),dateExceptions:[]};
  const {enabled,...schedule}=rule;bookingSchedule.parse(schedule);
  await call(db,'voice_save_rule','admin',plumber,rule);
  const cfg=await runtime(db,'phone-job-plumb-2','configuration',{dialed:plumberNumber});
  await runtime(db,'phone-job-plumb-2','start',{room:'phone-plumb-2',phone:caller,revision:cfg.revision,source:'crm',dialed:plumberNumber});
  const open=await booking(db,'availability','phone-job-plumb-2',{service:'plumbing_service',localDate:day});
  assert.equal(open.configured,true);
  assert.deepEqual(open.slots.map(s=>s.localTime),['08:00','12:00'],'one slot per arrival window');
  // Opek has no plumbing rule, so the same request on an Opek call is not configured.
  assert.equal((await booking(db,'availability','phone-job-opek-none',{service:'plumbing_service',localDate:day})).configured,false);
  const held=await booking(db,'prepare','phone-job-plumb-2',{service:'plumbing_service',localDate:day,localTime:'08:00',phone:caller,name:'Pat Plumb',address:'123 Test Street, Denver',details:{}});
  assert.equal(held.available,true);
  const done=await sql(db,'voice_booking_api.confirm',opek,'phone-job-plumb-2',held.holdId);
  assert.equal(done.status,'confirmed');
  const row=(await db.query('select tenant_id,voice_service,voice_call_id is not null linked from public.sms_bookings where id=$1',[done.bookingId])).rows[0];
  assert.deepEqual([row.tenant_id,row.voice_service,row.linked],[plumber,'plumbing_service',true]);
  assert.equal((await db.query('select count(*)::int n from public.sms_bookings where tenant_id=$1',[opek])).rows[0].n,0);
  // Rescheduling a plumbing booking inside 72 hours carries no fee.
  await db.query("update public.sms_bookings set appointment_at=now()+interval '5 hours',voice_end_at=now()+interval '9 hours' where id=$1",[done.bookingId]);
  await sql(db,'voice_lookup_api.voice_identify',opek,'phone-job-plumb-2',caller,'Pat Plumb');
  const change=await booking(db,'check_change','phone-job-plumb-2',{kind:'cancel',bookingId:done.bookingId,phone:caller});
  assert.equal(change.lateFee,0);
 }finally{await db.close();}
});

test('a business without a bound phone stays out of voice scope',async()=>{
 const db=await testDatabase();try{
  await call(db,'api_action','admin',null,'create_business',{id:'biz-unbound',name:'Unbound',timeZone:'UTC'});
  await assert.rejects(()=>sql(db,'voice_booking_api.availability','biz-unbound','phone-job-u',{service:'plumbing_service',localDate:day}),/scope denied/);
 }finally{await db.close();}
});

test('the Mile High number is forwarded to LiveKit and signed by the shared Twilio account',async()=>{
 const url='https://wxamwhfmelxqahkdtcci.supabase.co/functions/v1/soni-voice-inbound',account='AC'+'0'.repeat(32),token='test-token';
 const lookups=[];
 const db={call:async(name,acct,event,params)=>{lookups.push(params.To);return {tenant_id:'opek',from_number:opekNumber,auth_token:token};}};
 const handler=createSoniInboundHandler(db,{base:url,sipUsername:'opek_soni_inbound',sipPassword:'S'.repeat(32)});
 const params={AccountSid:account,To:plumberNumber,From:caller,CallSid:'CA456'};
 const response=await handler(new Request(url,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded','X-Twilio-Signature':await twilioSignature(token,url,params)},body:new URLSearchParams(params)}));
 assert.equal(response.status,200);
 assert.match(await response.text(),/sip:\+18777524664@65qezov0v3b\.sip\.livekit\.cloud;transport=tcp/);
 assert.deepEqual(lookups,[opekNumber]);
 const forged=await handler(new Request(url,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded','X-Twilio-Signature':'bad'},body:new URLSearchParams(params)}));
 assert.equal(forged.status,403);
});
