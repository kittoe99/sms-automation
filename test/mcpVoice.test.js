import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './helpers/twilioConnections.js';
import {call} from './helpers/database.js';
import {toolOutputs} from '../src/mcp/tools.js';
import {voicePermissions,voiceToolPermissions} from '../src/mcp/voiceSchemas.js';
import {withVoiceMedia} from '../src/mcp/voiceMedia.js';
import {signMcpVoiceMedia} from '../supabase/functions/crm-api/mcp-voice-media.js';
const configuration={name:'Synthetic reception',persona:'PRIVATE persona',voice:'PRIVATE voice prompt',brain:'PRIVATE brain prompt',voiceName:'marin'};
test('Voice MCP preserves scoped drafts, publication, retention and separate content permissions',async t=>{
 const {db,business}=await fixture();try{
 const a=(await business('voice-a')).tenant,b=(await business('voice-b')).tenant;
 const invoke=async(tool,p={})=>{const r=(await db.query('select crm_mcp.invoke($1,$2,$3,$4,$5) r',['staff','voice-client',tool,JSON.stringify(p),crypto.randomUUID()])).rows[0].r;if(r.ok)toolOutputs[tool].parse(r.data);return r;};
 const cid=(await invoke('crm_get_access')).data.connectionId;let gr=0;
 const grant=async(perms=voicePermissions.map(x=>x[0]),status='active')=>{gr=(await call(db,'mcp_admin','staff','save',{connectionId:cid,revision:gr,status,permissions:perms,businessIds:[a],allBusinesses:false})).connection.revision;};await grant();
 const foreign=await call(db,'voice_workspace','staff',b,'create',{requestId:crypto.randomUUID(),configuration});
 const create={businessId:a,configuration,idempotencyKey:crypto.randomUUID()};let agent,rev,first,second,callId,foreignCall;
 await t.test('each grant is independently required before any domain change',async()=>{
  for(const [tool,permission] of Object.entries(voiceToolPermissions)){
   await grant(voicePermissions.map(x=>x[0]).filter(x=>x!==permission));
   assert.equal((await invoke(tool,{businessId:a})).error.code,'PERMISSION_DENIED',tool);
  }await grant();
  assert.equal((await db.query('select count(*) n from sms_private.voice_agents where tenant_id=$1',[a])).rows[0].n,0);
 });
 await t.test('draft creation is private, retry stable and payload conflicts fail',async()=>{
  const r=await invoke('crm_create_voice_agent',create);assert.equal(r.ok,true,JSON.stringify(r));agent=r.data.agentId;rev=r.data.revision;assert.equal(r.data.publishedVersionId,null);assert.equal(r.data.affectsNewCalls,false);
  assert.deepEqual((await invoke('crm_create_voice_agent',create)).data,r.data);
  assert.equal((await invoke('crm_create_voice_agent',{...create,configuration:{...configuration,name:'changed'}})).error.code,'CONFLICT');
  const row=(await db.query('select * from sms_private.voice_agents where tenant_id=$1 and id=$2',[a,agent])).rows[0];assert.equal(row.deployment_id,null);assert.equal(row.phone,null);
 });
 await t.test('every read is scoped and bounded before counts and nested data',async()=>{
  const r=await invoke('crm_list_voice_agents',{businessId:a,page:1,pageSize:1});assert.equal(r.data.total,1);assert.equal(r.data.agents[0].id,agent);
  assert.equal((await invoke('crm_list_voice_agents',{businessId:b})).error.code,'PERMISSION_DENIED');
  assert.equal((await invoke('crm_get_voice_agent',{businessId:a,agentId:foreign.agentId})).error.code,'PERMISSION_DENIED');
  assert.equal((await invoke('crm_list_voice_agents',{businessId:a,pageSize:101})).error.code,'VALIDATION_ERROR');
  assert.equal((await invoke('crm_get_voice_agent',{businessId:a,agentId:agent,extra:true})).error.code,'VALIDATION_ERROR');
 });
 await t.test('save, publish and rollback are independent and retain canonical prerequisites',async()=>{
  const publish={businessId:a,agentId:agent,revision:rev,idempotencyKey:crypto.randomUUID()};assert.equal((await invoke('crm_publish_voice_draft',publish)).error.code,'VALIDATION_ERROR');
  await db.query("update sms_private.voice_agents set deployment_id='synthetic-connected',phone='+13035550101' where tenant_id=$1 and id=$2",[a,agent]);
  for(const tool of ['crm_save_voice_draft','crm_publish_voice_draft']){
   await grant(voicePermissions.map(x=>x[0]).filter(p=>p!==voiceToolPermissions[tool]));assert.equal((await invoke(tool,{...publish,...(tool==='crm_save_voice_draft'?{configuration}: {})})).error.code,'PERMISSION_DENIED');
  }await grant();
  const r=await invoke('crm_publish_voice_draft',publish);assert.equal(r.ok,true,JSON.stringify(r));first=r.data.publishedVersionId;rev=r.data.revision;assert.deepEqual((await invoke('crm_publish_voice_draft',publish)).data,r.data);
  const edit={businessId:a,agentId:agent,revision:rev,configuration:{...configuration,name:'New draft'},idempotencyKey:crypto.randomUUID()};const saved=await invoke('crm_save_voice_draft',edit);assert.equal(saved.ok,true);rev=saved.data.revision;
  assert.equal((await invoke('crm_publish_voice_draft',{...publish,idempotencyKey:crypto.randomUUID()})).error.code,'CONFLICT');
  await assert.rejects(()=>call(db,'voice_workspace','staff',a,'save',{agentId:agent,version:rev-1,configuration}),/changed/);
  const published=await invoke('crm_publish_voice_draft',{...publish,revision:rev,idempotencyKey:crypto.randomUUID()});second=published.data.publishedVersionId;rev=published.data.revision;
  const rollback={businessId:a,agentId:agent,revision:rev,versionId:first,idempotencyKey:crypto.randomUUID()};await grant(['voice_publish']);assert.equal((await invoke('crm_rollback_voice_configuration',rollback)).error.code,'PERMISSION_DENIED');await grant();
  const back=await invoke('crm_rollback_voice_configuration',rollback);assert.equal(back.ok,true);rev=back.data.revision;assert.notEqual(back.data.publishedVersionId,first);assert.deepEqual((await invoke('crm_rollback_voice_configuration',rollback)).data,back.data);
  const view=(await invoke('crm_get_voice_agent',{businessId:a,agentId:agent})).data;assert.equal(view.draft.name,'New draft');assert.equal(view.published.name,configuration.name);
  assert.equal((await invoke('crm_list_voice_versions',{businessId:a,agentId:agent})).data.total,3);
  assert.equal((await invoke('crm_get_voice_version',{businessId:a,agentId:agent,versionId:second})).data.configuration.name,'New draft');
 });
 await t.test('call metadata omits private content; transcripts require separate grant and retention',async()=>{
  for(const [tenant,id] of [[a,agent],[b,foreign.agentId]]){
   const row=(await db.query("insert into sms_private.voice_calls(tenant_id,agent_id,job_id,room_id,status,transcript,media_state,media_path,request) values($1,$2,$3,'synthetic-room','completed',$4,'ready','private/path.ogg','{\"secret\":\"PRIVATE raw request\"}') returning id",[tenant,id,crypto.randomUUID(),JSON.stringify([{role:'user',text:'PRIVATE retained text',secret:'not projected'}])])).rows[0];if(tenant===a)callId=row.id;else foreignCall=row.id;
  }
  const calls=(await invoke('crm_list_voice_calls',{businessId:a})).data;assert.equal(calls.total,1);assert.equal(calls.calls[0].id,callId);assert.ok(!JSON.stringify(calls).includes('PRIVATE'));
  const metadata=await invoke('crm_get_voice_call',{businessId:a,callId});assert.equal(metadata.ok,true);assert.ok(!JSON.stringify(metadata).includes('private/path'));
  for(const tool of ['crm_get_voice_call','crm_get_voice_transcript','crm_get_voice_recording'])assert.equal((await invoke(tool,{businessId:a,callId:foreignCall})).error.code,'PERMISSION_DENIED');
  await grant(['voice_call_read']);assert.equal((await invoke('crm_get_voice_transcript',{businessId:a,callId})).error.code,'PERMISSION_DENIED');assert.equal((await invoke('crm_get_voice_recording',{businessId:a,callId})).error.code,'PERMISSION_DENIED');await grant();
  const tx=(await invoke('crm_get_voice_transcript',{businessId:a,callId})).data;assert.equal(tx.turns[0].text,'PRIVATE retained text');assert.equal(Object.keys(tx.turns[0]).length,2);
  await db.query("update sms_private.voice_calls set expires_at=now()-interval '1 second' where tenant_id=$1 and id=$2",[a,callId]);assert.equal((await invoke('crm_get_voice_transcript',{businessId:a,callId})).data.available,false);assert.equal((await invoke('crm_get_voice_recording',{businessId:a,callId})).error.code,'VALIDATION_ERROR');
  await db.query("update sms_private.voice_calls set expires_at=now()+interval '1 hour' where tenant_id=$1 and id=$2",[a,callId]);
 });
 await t.test('one-use media tickets recheck staff, grants, tenant and retention',async()=>{
  const ticket=async(id=callId)=>(await db.query('select crm_mcp.voice_media_ticket($1,$2,$3,$4) token',['staff','voice-client',a,id])).rows[0].token;
  await assert.rejects(()=>ticket(foreignCall),/denied/);
  const token=await ticket();await grant(['voice_call_read']);await assert.rejects(()=>call(db,'mcp_consume_voice_media_ticket',token),/denied/);await grant();
  const access=await call(db,'mcp_consume_voice_media_ticket',token);assert.equal(access.path,'private/path.ogg');assert.ok(access.expiresIn<=300);await assert.rejects(()=>call(db,'mcp_consume_voice_media_ticket',token),/denied/);
  const expired=await ticket();await db.query("update sms_private.voice_calls set deleted_at=now() where tenant_id=$1 and id=$2",[a,callId]);await assert.rejects(()=>call(db,'mcp_consume_voice_media_ticket',expired),/unavailable/);
  assert.equal((await invoke('crm_get_voice_transcript',{businessId:a,callId})).data.available,false);
 });
 await t.test('audit failure rolls back writes; receipts omit prompts; revocation blocks replay',async()=>{
  const p={businessId:a,agentId:agent,revision:rev,configuration:{...configuration,name:'Rollback test'},idempotencyKey:crypto.randomUUID()};
  await db.exec("create function public.fail_voice_audit() returns trigger language plpgsql as $$ begin if new.tool='crm_save_voice_draft' then raise exception 'synthetic audit failure';end if;return new;end $$;create trigger fail_voice_audit before insert on sms_private.mcp_activity for each row execute function public.fail_voice_audit();");await assert.rejects(()=>invoke('crm_save_voice_draft',p),/audit failure/);await db.exec('drop trigger fail_voice_audit on sms_private.mcp_activity;drop function public.fail_voice_audit();');
  assert.equal((await invoke('crm_get_voice_agent',{businessId:a,agentId:agent})).data.agent.revision,rev);
  const receipts=(await db.query('select result from sms_private.mcp_requests where connection_id=$1',[cid])).rows;assert.ok(!JSON.stringify(receipts).includes('PRIVATE'));
  const audit=(await db.query('select * from sms_private.mcp_activity where connection_id=$1',[cid])).rows;assert.ok(!JSON.stringify(audit).includes('PRIVATE'));assert.ok(audit.some(x=>x.target===agent));
  await grant([], 'disabled');assert.equal((await invoke('crm_create_voice_agent',create)).error.code,'PERMISSION_DENIED');
  assert.equal((await db.query('select count(*) n from public.sms_messages')).rows[0].n,0);
 });
 }finally{await db.close();}
});
test('media signing adapter uses operation tickets only and handles unavailable signing',async()=>{
 let minted=0;const invoke=async()=>({ok:true,data:{businessId:'b',callId:'c',status:'temporarily_unavailable',expiresIn:300}});
 const opts={adapterUrl:'https://test.supabase.co/functions/v1/crm-api/mcp/knowledge-upload',fetchImpl:async(url,options)=>{assert.equal(new URL(url).pathname,'/functions/v1/crm-api/mcp/voice-media');assert.equal(options.headers.Authorization,undefined);assert.deepEqual(JSON.parse(options.body),{ticket:'one-use'});return Response.json({signedUrl:'https://test.supabase.co/storage/v1/object/sign/voice-recordings/private.ogg?token=secret',expiresIn:300});}};
 const result=await withVoiceMedia(invoke,async()=>{minted++;return 'one-use';},opts)({},'crm_get_voice_recording',{businessId:'b',callId:'c'},'r');assert.equal(result.data.status,'available');assert.equal(minted,1);
 const fail=await withVoiceMedia(invoke,async()=>{throw Error('unavailable');},opts)({},'crm_get_voice_recording',{businessId:'b',callId:'c'},'r');assert.equal(fail.data.status,'temporarily_unavailable');
 const db={call:async(...args)=>{assert.equal(args[0],'mcp_consume_voice_media_ticket');return {path:'private.ogg',expiresIn:4};}};let signed=false;
 await assert.rejects(()=>signMcpVoiceMedia(db,{ticket:'invalid'}),/denied/);
 await signMcpVoiceMedia(db,{ticket:'a'.repeat(72)},{storage:{playback:async(p,ttl)=>{assert.equal(p,'private.ogg');assert.equal(ttl,4);signed=true;return {};}}});assert.equal(signed,true);
});
