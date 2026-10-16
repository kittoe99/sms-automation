import test from 'node:test';
import assert from 'node:assert/strict';
import {z} from 'zod';
import {fixture} from './helpers/twilioConnections.js';
import {call} from './helpers/database.js';
import {aiDiagnosticsTools,aiDiagnosticsPermissions} from '../src/mcp/aiDiagnosticsSchemas.js';
import {toolOutputs} from '../src/mcp/tools.js';
const migration='20261016222634_crm_mcp_ai_reply_diagnostics.sql',legacy=crypto.randomUUID();

test('AI diagnostic strict inputs require explicit scope and reject write/credential options',()=>{
 for(const [name,,shape,write] of aiDiagnosticsTools){
  assert.equal(write,undefined);const schema=z.object(shape).strict(),detail=name==='crm_get_ai_reply_run',p={businessId:'a',...(detail?{runId:crypto.randomUUID()}: {})};
  assert.equal(schema.safeParse(p).success,true);
  for(const patch of [{businessId:''},{businessId:' '},{businessId:2},{businessId:'a'.repeat(256)},{actor:'staff'},{includeCredentials:true},{markRead:true},{retry:true},{idempotencyKey:'anything'},...(detail?[{runId:'bad'},{includeContent:'true'},{includeContent:null},{page:1}]:[{page:0},{page:100001},{pageSize:101},{pageSize:1.5},{pageSize:'1'},{status:'sent'},{conversationId:'bad'},{includeContent:true}])])assert.equal(schema.safeParse({...p,...patch}).success,false,JSON.stringify(patch));
 }
});

test('AI diagnostics isolate runs, content, nested relations, lifecycle and audit',async t=>{
 const {db,business,admin}=await fixture({beforeMigration:async(db,file)=>{if(file===migration)await db.query("insert into sms_private.mcp_connections(id,issuer,subject,account_id,client_id,status,permissions,all_businesses) values($1,'legacy','legacy',$1,'legacy','active',array['read'],true)",[legacy]);}});
 try{
  assert.deepEqual((await db.query('select permissions from sms_private.mcp_connections where id=$1',[legacy])).rows[0].permissions,['read']);
  const a=(await business('ai-diag-a')).tenant,b=(await business('ai-diag-b')).tenant;
  const make=async(tenant,label)=>{
   await db.query("insert into public.sms_contacts(tenant_id,phone,name) values($1,'+17208429167',$2)",[tenant,label]);
   const conversation=await call(db,'ensure_conversation',tenant,'+17208429167',null);
   const incoming=(await db.query("insert into public.sms_messages(tenant_id,contact_phone,conversation_id,direction,body,status) values($1,'+17208429167',$2,'inbound',$3,'received') returning id",[tenant,conversation,label+' INBOUND CONTENT'])).rows[0].id;
   const job=(await db.query("insert into sms_private.jobs(tenant_id,queue,dedupe_key,payload,status,attempts,error_code) values($1,'ai_reply_jobs',gen_random_uuid()::text,$2,'completed',1,'PRIVATE ERROR') returning id",[tenant,JSON.stringify({agent_version:'sms-agent-v1',phone:'+17208429167',conversation_id:conversation,message_id:incoming,settings_revision:7,secret:'PRIVATE PAYLOAD'})])).rows[0].id;
   await db.query("insert into sms_private.inbound_ai_runs(job_id,tenant_id,mode,result) values($1,$2,'live',$3)",[job,tenant,JSON.stringify({reply:label+' REPLY CONTENT',model:'gpt-6.1-sol',promptVersion:'business-info-v1',inputTokens:100,outputTokens:20,latencyMs:500,toolCount:1,estimatedCostMicros:3,profileVersionId:crypto.randomUUID(),secret:'PRIVATE RESULT'})]);
   await db.query("insert into sms_private.inbound_ai_actions(job_id,action_key,name,arguments,result) values($1,'first','check_availability','{\"secret\":\"PRIVATE ARGUMENTS\"}','{\"status\":\"unavailable\",\"secret\":\"PRIVATE ACTION\"}')",[job]);
   const outgoing=(await db.query("insert into public.sms_messages(tenant_id,contact_phone,conversation_id,direction,body,status,provider_accepted_at,meta) values($1,'+17208429167',$2,'outbound',$3,'accepted',now(),$4) returning id",[tenant,conversation,label+' SENT CONTENT',JSON.stringify({agent_version:'sms-agent-v1',agent_job_id:job,secret:'PRIVATE PROVIDER'})])).rows[0].id;
   return {job,conversation,incoming,outgoing};
  };
  const own=await make(a,'OWN'),foreign=await make(b,'FOREIGN');
  const invoke=async(tool,p={},user='staff')=>{const r=(await db.query('select crm_mcp.invoke($1,$2,$3,$4,$5) r',[user,'ai-diagnostics-client',tool,JSON.stringify(p),crypto.randomUUID()])).rows[0].r;if(r.ok)toolOutputs[tool].parse(r.data);return r;};
  const cid=(await invoke('crm_get_access')).data.connectionId;let rev=0;
  const grant=async(permissions=aiDiagnosticsPermissions.map(x=>x[0]),status='active',allBusinesses=false)=>{rev=(await call(db,'mcp_admin','staff','save',{connectionId:cid,revision:rev,status,permissions,businessIds:[a],allBusinesses})).connection.revision;};
  const list=(p={})=>invoke('crm_list_ai_reply_runs',{businessId:a,...p}),detail=(p={})=>invoke('crm_get_ai_reply_run',{businessId:a,runId:own.job,...p});
  const snapshot=async()=>{const s={};for(const table of ['sms_private.jobs','sms_private.inbound_ai_runs','sms_private.inbound_ai_actions','sms_private.inbound_ai_settings','public.sms_messages','public.sms_conversations','public.sms_thread_contacts','public.sms_contacts','public.sms_handoffs','public.sms_bookings','sms_private.form_runs','sms_private.mcp_requests','public.dashboard_cache_versions','pgmq.test_messages','net.test_requests'])s[table]=(await db.query(`select coalesce(jsonb_agg(to_jsonb(x) order by to_jsonb(x)::text),'[]') v from ${table} x`)).rows[0].v;return s;};
  await t.test('pending and unrelated grants never confer metadata or content access',async()=>{
   assert.equal((await list()).error.code,'PERMISSION_DENIED');
   await grant(['ai_config_read','conversation_read','conversation_messages_read','operations_read']);assert.equal((await list()).error.code,'PERMISSION_DENIED');
   await grant(['ai_reply_content_read']);assert.equal((await detail({includeContent:true})).error.code,'PERMISSION_DENIED');
   await grant(['ai_reply_read']);const before=await snapshot();const r=(await detail()).data;assert.equal(r.content,null);assert.equal(r.run.mode,'live');assert.equal(r.run.errorCode,'OTHER_ERROR');assert.equal(r.profileVersionId,null);assert.equal(r.profileVersionAvailability,'not_recorded');assert.equal(r.metrics.latencyMs,500);assert.equal(r.delivery.messages[0].status,'accepted');assert.equal(r.actions.rows[0].outcome,'unavailable');assert.ok(!JSON.stringify(r).match(/CONTENT|PRIVATE|FOREIGN|17208429167/));
   assert.equal((await detail({includeContent:true})).error.code,'PERMISSION_DENIED');assert.deepEqual(await snapshot(),before);
  });
  await t.test('same phone across businesses, substituted IDs, nested counts and pages remain scoped',async()=>{
   await grant();const before=await snapshot();const d=(await detail({includeContent:true})).data;assert.equal(d.content.inbound.body,'OWN INBOUND CONTENT');assert.equal(d.content.recordedReply,'OWN REPLY CONTENT');assert.equal(d.content.outbound[0].body,'OWN SENT CONTENT');assert.ok(!JSON.stringify(d).match(/PRIVATE|FOREIGN/));
   assert.equal((await list()).data.total,1);assert.equal((await list({page:2,pageSize:1})).data.runs.length,0);
   assert.equal((await list({conversationId:own.conversation})).data.total,1);
   for(const p of [{businessId:b},{conversationId:foreign.conversation},{conversationId:crypto.randomUUID()}])assert.equal((await list(p)).error.code,'PERMISSION_DENIED');
   for(const p of [{businessId:b},{runId:foreign.job},{runId:crypto.randomUUID()}])assert.equal((await detail(p)).error.code,'PERMISSION_DENIED');
   await grant(undefined,'active',true);assert.equal((await list({businessId:b})).data.total,1);assert.equal((await detail({runId:foreign.job})).error.code,'PERMISSION_DENIED');await grant();
   assert.deepEqual(await snapshot(),before);
  });
  await t.test('raw gateway schemas reject malformed requests and unexpected side effects',async()=>{
   const before=await snapshot();for(const p of [{includeContent:'true'},{includeContent:null},{runId:'bad'},{markRead:true},{retry:true},{includeCredentials:true},{idempotencyKey:'unused'}])assert.equal((await detail(p)).error.code,'VALIDATION_ERROR',JSON.stringify(p));
   for(const p of [{page:0},{pageSize:101},{pageSize:'2'},{pageSize:1.2},{status:'invalid'},{conversationId:'bad'},{includeContent:true}])assert.equal((await list(p)).error.code,'VALIDATION_ERROR',JSON.stringify(p));
   assert.deepEqual(await snapshot(),before);
  });
  await t.test('corrupt cross-business links never expose related text, identifiers or counts',async()=>{
   await db.query('update sms_private.jobs set payload=payload||$2 where id=$1',[own.job,JSON.stringify({conversation_id:foreign.conversation,message_id:foreign.incoming})]);
   const d=(await detail({includeContent:true})).data;assert.equal(d.run.conversationId,null);assert.equal(d.content.inbound,null);assert.equal(d.delivery.total,0);assert.deepEqual(d.content.outbound,[]);assert.ok(!JSON.stringify(d).includes('FOREIGN'));
   await db.query('update sms_private.jobs set payload=payload||$2 where id=$1',[own.job,JSON.stringify({conversation_id:own.conversation,message_id:own.incoming})]);
   await db.query("update public.sms_messages set meta=jsonb_set(meta,'{agent_job_id}',to_jsonb($2::text)) where id=$1",[foreign.outgoing,own.job]);
   assert.equal((await detail()).data.delivery.total,1);
   await db.query('update sms_private.inbound_ai_runs set tenant_id=$2 where job_id=$1',[own.job,b]);const r=(await detail({includeContent:true})).data;assert.equal(r.run.resultRecorded,false);assert.equal(r.content.recordedReply,null);await db.query('update sms_private.inbound_ai_runs set tenant_id=$2 where job_id=$1',[own.job,a]);
  });
  await t.test('unfinished, failed, cancelled, shadow and archived attempts are distinguished from delivery',async()=>{
   for(const status of ['queued','failed','cancelled'])await db.query("insert into sms_private.jobs(tenant_id,queue,dedupe_key,payload,status,error_code) values($1,'ai_reply_jobs',gen_random_uuid()::text,'{\"agent_version\":\"sms-agent-v1\"}',$2,'AI_TIMEOUT')",[a,status]);
   const failed=(await list({status:'failed'})).data;assert.equal(failed.total,1);const r=(await detail({runId:failed.runs[0].id})).data;assert.equal(r.run.resultRecorded,false);assert.equal(r.run.mode,null);assert.equal(r.delivery.total,0);assert.equal(r.run.errorCode,'AI_TIMEOUT');
   await db.query("update sms_private.inbound_ai_runs set mode='shadow' where job_id=$1",[own.job]);assert.equal((await detail()).data.actions.rows[0].simulated,true);await db.query("update sms_private.inbound_ai_runs set mode='live' where job_id=$1",[own.job]);
   await db.query("update public.sms_messages set status='delivered' where id=$1",[own.outgoing]);assert.equal((await detail()).data.delivery.messages[0].status,'delivered');
   await db.query("update sms_private.jobs set status='failed',archived_at=now() where id=$1",[own.job]);assert.equal((await list()).data.total,3);assert.equal((await detail()).data.run.archived,true);
  });
  await t.test('oversized nested output and malformed metrics are bounded and explicitly truncated',async()=>{
   await db.query("update sms_private.inbound_ai_runs set result=result||$2 where job_id=$1",[own.job,JSON.stringify({reply:'x'.repeat(5000),inputTokens:'PRIVATE',outputTokens:-1,latencyMs:1.5,model:'PRIVATE MODEL',promptVersion:'PRIVATE PROMPT'})]);
   for(let i=0;i<22;i++)await db.query("insert into sms_private.inbound_ai_actions(job_id,action_key,name,arguments,result) values($1,$2,'PRIVATE TOOL','{}','{\"status\":\"PRIVATE STATUS\"}')",[own.job,'extra-'+i]);
   for(let i=0;i<21;i++)await db.query("insert into public.sms_messages(tenant_id,contact_phone,conversation_id,direction,body,status,meta) values($1,'+17208429167',$2,'outbound','OWN EXTRA CONTENT','queued',$3)",[a,own.conversation,JSON.stringify({agent_version:'sms-agent-v1',agent_job_id:own.job})]);
   const r=(await detail({includeContent:true})).data;assert.equal(r.delivery.total,22);assert.equal(r.delivery.messages.length,20);assert.equal(r.delivery.truncated,true);assert.equal(r.content.outbound.length,20);assert.equal(r.content.recordedReply.length,4000);assert.equal(r.content.replyTruncated,true);assert.equal(r.actions.rows.length,20);assert.equal(r.actions.total,23);assert.equal(r.actions.truncated,true);assert.equal(r.metrics.inputTokens,null);assert.equal(r.metrics.outputTokens,null);assert.equal(r.metrics.latencyMs,null);assert.equal(r.metrics.model,null);assert.equal(r.metrics.promptVersion,null);assert.ok(!JSON.stringify(r).includes('PRIVATE'));
  });
  await t.test('private helpers cannot bypass the gateway; staff and connection revocation take effect',async()=>{
   for(const role of ['anon','authenticated','service_role','sms_api','crm_mcp','sms_ai','sms_automation'])for(const signature of ['sms_private.mcp_ai_metric(jsonb)','sms_private.mcp_ai_error(text)','sms_private.mcp_ai_run_projection(sms_private.jobs)','sms_private.mcp_ai_reply_read(text,text,text,jsonb,uuid)'])assert.equal((await db.query('select has_function_privilege($1,$2,\'execute\') allowed',[role,signature])).rows[0].allowed,false);
   assert.equal((await invoke('crm_list_ai_reply_runs',{businessId:a},'reader')).error.code,'PERMISSION_DENIED');
   await db.query("update public.dashboard_accounts set status='suspended' where id=$1",[admin]);assert.equal((await list()).error.code,'PERMISSION_DENIED');await db.query("update public.dashboard_accounts set status='active' where id=$1",[admin]);
   await grant(['ai_reply_read']);assert.equal((await detail({includeContent:true})).error.code,'PERMISSION_DENIED');await grant(undefined,'disabled');assert.equal((await list()).error.code,'PERMISSION_DENIED');await grant(undefined,'revoked');assert.equal((await detail()).error.code,'PERMISSION_DENIED');
   const audits=(await db.query("select * from sms_private.mcp_activity where tool in ('crm_list_ai_reply_runs','crm_get_ai_reply_run')")).rows;assert.ok(audits.some(x=>x.outcome==='success'&&x.actor_id===admin&&x.connection_id===cid));assert.ok(audits.some(x=>x.outcome==='denied'));assert.ok(!JSON.stringify(audits).match(/PRIVATE|CONTENT|17208429167/));assert.equal((await db.query('select count(*) n from sms_private.mcp_requests')).rows[0].n,0);
  });
 }finally{await db.close();}
});
