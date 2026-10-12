import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './helpers/twilioConnections.js';
import {call} from './helpers/database.js';
import {recordingAvailable,recordingLabel,voiceTime} from '../public/voiceWorkspace.js';
import {voiceStorage} from '../supabase/functions/_shared/voice-storage.js';
import {createCrmHandler} from '../supabase/functions/crm-api/handler.js';
const workspace=(db,t,action,p={},user='staff')=>call(db,'voice_workspace',user,t,action,p);
async function agent(db,t,id){
 await db.query(`insert into sms_private.voice_agents(tenant_id,id,deployment_id,agent_name,phone,draft)
 values($1,$2,$2,'deployment','+18775550180','{}')`,[t,id]);
}
async function record(db,t,id){return (await db.query(`insert into sms_private.voice_calls(tenant_id,agent_id,job_id,room_id,phone,summary,status,started_at,media_state,media_path,transcript,expires_at)
 values($1,$2,gen_random_uuid()::text,'fixture-room','+13035550123','Door repair','completed','2026-01-02T03:00:00Z','ready','private/test.ogg','[{"role":"user","text":"Hello"}]','2099-01-01') returning id`,[t,id])).rows[0].id;}

test('staff overview uses reviewed facts, separate customer release status and only selected business agents',async()=>{
 const {db,business}=await fixture();try{
  const a=await business('staff-voice-a'),b=await business('staff-voice-b');
  await agent(db,a.tenant,'one');await agent(db,a.tenant,'two');await agent(db,b.tenant,'foreign');
  await db.query(`update public.platform_business_setup set draft=jsonb_build_object('businessName','Unreviewed change') where tenant_id=$1`,[a.tenant]);
  const result=await workspace(db,a.tenant,'overview');
  assert.equal(result.business.name,'Example Services');assert.equal(result.business.reviewed,true);
  assert.deepEqual(result.business.services,['Home repairs']);assert.deepEqual(result.business.serviceAreas,['Denver']);
  assert.equal(result.business.timeZone,'America/Denver');assert.equal(result.customerService,null);
  assert.deepEqual(result.agents.map(a=>a.id).sort(),['one','two']);
  await db.query(`insert into public.platform_business_services(tenant_id,kind) values($1,'voice')`,[a.tenant]);
  assert.equal((await workspace(db,a.tenant,'overview')).customerService.visibility,'draft');
  await assert.rejects(()=>workspace(db,a.tenant,'overview',{},'reader'),/denied|Staff|Admin|admin/);
  for(const role of ['anon','authenticated','service_role','sms_voice_runtime']){
   assert.equal((await db.query("select has_function_privilege($1,'sms_private.voice_workspace(text,text,text,jsonb)','execute') allowed",[role])).rows[0].allowed,false);
  }
  assert.equal((await db.query("select has_function_privilege('sms_api','sms_private.voice_workspace_before_staff_overview(text,text,text,jsonb)','execute') allowed")).rows[0].allowed,false);
 }finally{await db.close();}
});

test('staff filters combine agent, business-local dates, caller, status and pagination without leaking detail or other businesses',async()=>{
 const {db,business}=await fixture();try{
  const a=await business('staff-calls-a'),b=await business('staff-calls-b');
  await agent(db,a.tenant,'one');await agent(db,a.tenant,'two');await agent(db,b.tenant,'one');
  const id=await record(db,a.tenant,'one');await record(db,a.tenant,'two');const foreign=await record(db,b.tenant,'one');
  const page=await workspace(db,a.tenant,'calls',{agent:'one',from:'2026-01-01',to:'2026-01-01',q:'repair',phone:'+13035550123',status:'completed'});
  assert.equal(page.total,1);assert.equal(page.calls[0].id,id);assert.equal(page.timeZone,'America/Denver');
  for(const k of ['transcript','media_path','request'])assert.equal(k in page.calls[0],false);
  assert.equal((await workspace(db,a.tenant,'calls',{from:'2026-01-02'})).total,0);
  assert.equal((await workspace(db,a.tenant,'calls',{agent:'foreign'})).total,0);
  await assert.rejects(()=>workspace(db,a.tenant,'call',{id:foreign}),/no rows/);
  await assert.rejects(()=>workspace(db,a.tenant,'media',{id:foreign}),/no rows/);
  for(let i=0;i<25;i++)await record(db,a.tenant,'one');
  assert.equal((await workspace(db,a.tenant,'calls',{agent:'one'})).calls.length,25);
  assert.equal((await workspace(db,a.tenant,'calls',{agent:'one',page:2})).calls.length,1);
  await db.query(`update sms_private.voice_calls set deleted_at=now() where tenant_id=$1 and id=$2`,[a.tenant,id]);
  assert.equal((await workspace(db,a.tenant,'call',{id})).call.transcript,null);
  assert.equal((await workspace(db,a.tenant,'call',{id})).call.media_state,'expired');
  await assert.rejects(()=>workspace(db,a.tenant,'media',{id}),/unavailable/);
 }finally{await db.close();}
});

test('staff playback is audited and retention bounded; deleted and missing recordings fail closed',async()=>{
 const {db,business}=await fixture();try{
  const a=await business('staff-media');await agent(db,a.tenant,'one');const id=await record(db,a.tenant,'one');
  await db.query("update sms_private.voice_calls set expires_at=now()+interval '30 seconds' where id=$1",[id]);
  const media=await workspace(db,a.tenant,'media',{id});assert.ok(media.expiresIn>0&&media.expiresIn<=30);
  assert.equal((await db.query("select count(*)::int n from sms_private.audit where action='voice_recording_access'")).rows[0].n,1);
  await db.query('update sms_private.voice_calls set media_path=null where id=$1',[id]);
  await assert.rejects(()=>workspace(db,a.tenant,'media',{id}),/unavailable/);
 }finally{await db.close();}
});

test('storage signs only the allowed lifetime and UI treats expired and deleted audio as unavailable',async()=>{
 const oldUrl=process.env.SUPABASE_URL,oldKey=process.env.SUPABASE_SERVICE_ROLE_KEY,oldFetch=globalThis.fetch;
 process.env.SUPABASE_URL='https://test.supabase.co';process.env.SUPABASE_SERVICE_ROLE_KEY='fixture';
 try{
  let payload;const storage=voiceStorage(async(url,options)=>{payload=JSON.parse(options.body);return Response.json({signedURL:'/object/sign/test'});});
  assert.equal((await storage.playback('private/test',29)).expiresIn,29);assert.equal(payload.expiresIn,29);
  assert.equal((await storage.playback('private/test',500)).expiresIn,300);
  await assert.rejects(()=>storage.playback('private/test',0),/expired/);
  globalThis.fetch=async(url,options)=>{payload=JSON.parse(options.body);return Response.json({signedURL:'/object/sign/test'});};
  const handler=createCrmHandler({call:async()=>({path:'private/test',expiresIn:17})},async()=> 'staff');
  const response=await handler(new Request('https://test/api/voice/media?id=fixture',{headers:{'X-Tenant-ID':'business'}}));
  assert.equal(response.status,200);assert.equal((await response.json()).expiresIn,17);assert.equal(payload.expiresIn,17);
  const c={media_state:'ready',expires_at:'2099-01-01'};assert.equal(recordingAvailable(c),true);
  assert.equal(recordingAvailable({...c,deleted_at:'2026-01-01'}),false);
  assert.equal(recordingAvailable({...c,expires_at:'2020-01-01'}),false);
  assert.equal(recordingLabel({...c,expires_at:'2020-01-01'}),'expired');
  assert.notEqual(voiceTime('2026-01-02T03:00:00Z','America/Denver'),voiceTime('2026-01-02T03:00:00Z','UTC'));
 }finally{globalThis.fetch=oldFetch;if(oldUrl===undefined)delete process.env.SUPABASE_URL;else process.env.SUPABASE_URL=oldUrl;if(oldKey===undefined)delete process.env.SUPABASE_SERVICE_ROLE_KEY;else process.env.SUPABASE_SERVICE_ROLE_KEY=oldKey;}
});
