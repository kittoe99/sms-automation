import test from 'node:test';
import assert from 'node:assert/strict';
import {setupCoordination,incoming,tenant} from './helpers/coordination.js';
import {call} from './helpers/database.js';
import {fixture} from './helpers/twilioConnections.js';
import {processInboundAgent} from '../src/workers/inboundAgent.js';
import {toolOutputs} from '../src/mcp/tools.js';

async function profile(db,t,version) {
 const facts={businessInfo:`PRIVATE BUSINESS INFO version ${version}`,contactPhone:'+13035550123'};
 const row=(await db.query("insert into public.sms_business_profile_versions(tenant_id,version,facts,status,content_hash,created_by,approved_at) values($1,$2,$3,'approved',$4,'admin',now()) returning id",[t,version,JSON.stringify(facts),crypto.randomUUID()])).rows[0];
 await db.query('update public.sms_businesses set active_profile_version_id=$2 where tenant_id=$1',[t,row.id]);
 return {...row,version,facts};
}
const context=(db,j)=>call(db,'inbound_ai_context',j.id,j.lease_token);
const run=async(db,j)=>(await db.query('select * from sms_private.inbound_ai_runs where job_id=$1',[j.id])).rows[0];
async function retry(db,j) {
 await call(db,'finish',j.id,j.lease_token,'retry','AI_TIMEOUT',0);
 await db.query('update sms_private.jobs set available_at=now() where id=$1',[j.id]);
 await db.query("update pgmq.test_messages set vt=now() where q='ai_reply_jobs'");
 return call(db,'claim','ai_reply_jobs','retry-test');
}

test('database captures the actual prompt version across edits, retries, recovery and missing profiles',async t=>{
 const db=await setupCoordination({mode:'shadow'});
 try {
  let p=await profile(db,tenant,1);
  await t.test('one lease keeps its captured facts; result ignores supplied provenance',async()=>{
   const j=await incoming(db),first=await context(db,j);
   assert.equal(first.profileVersionId,p.id);assert.deepEqual(first.profile,p.facts);
   const old=p;p=await profile(db,tenant,2);
   assert.deepEqual(await context(db,j),first);
   let requests=0;
   await processInboundAgent(j,{call:(name,...args)=>call(db,name,...args)},{apiKey:'synthetic',fetchImpl:async(_url,options)=>{
    requests++;const request=JSON.parse(options.body);assert.ok(request.instructions.includes(old.facts.businessInfo));assert.ok(!request.instructions.includes(p.facts.businessInfo));
    return new Response(JSON.stringify({status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify({reply:'Hello!',citationIds:[]})}]}]}));
   }});
   assert.equal(requests,1);const saved=await run(db,j);assert.equal(saved.profile_version_id,old.id);assert.equal(saved.profile_version,1);assert.ok(saved.profile_captured_at);
   await assert.rejects(()=>context(db,j),/Lease lost/);
  });
  await t.test('new lease loads the latest version and rejects completion by a stale worker',async()=>{
   const old=await incoming(db);assert.equal((await context(db,old)).profileVersionId,p.id);
   const j=await retry(db,old);assert.equal(j.id,old.id);assert.notEqual(j.lease_token,old.lease_token);
   p=await profile(db,tenant,3);assert.equal((await context(db,j)).profileVersionId,p.id);
   await assert.rejects(()=>call(db,'complete_inbound_ai',old.id,old.lease_token,{reply:'Stale'}),/Lease lost/);
   await call(db,'complete_inbound_ai',j.id,j.lease_token,{reply:'Hello',profileVersionId:crypto.randomUUID(),profileVersion:900});
   assert.equal((await run(db,j)).profile_version_id,p.id);assert.equal((await run(db,j)).profile_version,3);
  });
  await t.test('recovered tool reply retains the original context across leases',async()=>{
   const old=await incoming(db),first=await context(db,old);
   await db.query("insert into sms_private.inbound_ai_actions(job_id,action_key,name,arguments,result) values($1,'recovery','request_staff_help','{}','{\"customerReply\":\"The team can help.\"}')",[old.id]);
   const j=await retry(db,old);p=await profile(db,tenant,4);
   const recovered=await context(db,j);assert.equal(recovered.profileVersionId,first.profileVersionId);assert.equal(recovered.profileCapturedAt,first.profileCapturedAt);assert.equal(recovered.recoveredReply,'The team can help.');
   await call(db,'complete_inbound_ai',j.id,j.lease_token,{reply:recovered.recoveredReply});
   assert.equal((await run(db,j)).profile_version_id,first.profileVersionId);
  });
  await t.test('old recovered actions and completion without context are never backfilled',async()=>{
   for(const recover of [true,false]) {
    const j=await incoming(db);
    if(recover){await db.query("insert into sms_private.inbound_ai_actions(job_id,action_key,name,arguments,result) values($1,'old','request_staff_help','{}','{\"customerReply\":\"Hello\"}')",[j.id]);assert.equal((await context(db,j)).profile,null);}
    await call(db,'complete_inbound_ai',j.id,j.lease_token,{reply:'Hello',profileVersionId:p.id});
    const saved=await run(db,j);assert.equal(saved.profile_version_id,null);assert.equal(saved.profile_captured_at,null);
   }
  });
  await t.test('no approved profile is recorded distinctly and terminal failure retains capture',async()=>{
   await db.query('update public.sms_businesses set active_profile_version_id=null where tenant_id=$1',[tenant]);
   const j=await incoming(db);assert.equal((await context(db,j)).profileVersionId,null);
   await db.query('update sms_private.jobs set attempts=3 where id=$1',[j.id]);
   await call(db,'fail_inbound_ai',j.id,j.lease_token,{code:'AI_TIMEOUT',transient:true});
   const saved=await run(db,j);assert.equal(saved.profile_version_id,null);assert.ok(saved.profile_captured_at);
   assert.equal((await db.query('select sms_private.mcp_ai_run_projection(j) p from sms_private.jobs j where id=$1',[j.id])).rows[0].p.profileVersionAvailability,'no_approved_profile');
  });
  assert.equal((await db.query("select count(*)::int n from public.sms_messages where direction='outbound'")).rows[0].n,0);
 }finally{await db.close();}
});

test('MCP provenance is scoped, historical-safe, private and read-only',async()=>{
 const historical=crypto.randomUUID();
 const {db,business}=await fixture({beforeMigration:async(db,file)=>{
  if(file==='20261016235631_inbound_ai_profile_provenance.sql') {
   await db.query("insert into public.sms_businesses(tenant_id,name) values('historical-provenance','Historical')");
   await db.query("insert into sms_private.jobs(id,tenant_id,queue,dedupe_key,payload,status) values($1,'historical-provenance','ai_reply_jobs','historical','{\"agent_version\":\"sms-agent-v1\"}','completed')",[historical]);
   await db.query("insert into sms_private.inbound_ai_runs(job_id,tenant_id,mode,result) values($1,'historical-provenance','live',$2)",[historical,JSON.stringify({profileVersionId:crypto.randomUUID()})]);
  }
 }});
 try {
  assert.equal((await run(db,{id:historical})).profile_captured_at,null);
  const a=(await business('profile-own')).tenant,b=(await business('profile-foreign')).tenant;
  const p=await profile(db,a,2),foreign=await profile(db,b,2);
  const job=crypto.randomUUID(),token=crypto.randomUUID();
  await db.query("insert into sms_private.jobs(id,tenant_id,queue,dedupe_key,payload,status,lease_token) values($1,$2,'ai_reply_jobs','provenance','{\"agent_version\":\"sms-agent-v1\"}','processing',$3)",[job,a,token]);
  await db.query('insert into sms_private.inbound_ai_profile_contexts(job_id,tenant_id,lease_token,profile_version_id,profile_version,profile_facts) values($1,$2,$3,$4,2,$5)',[job,a,token,p.id,JSON.stringify(p.facts)]);
  await db.query("insert into sms_private.inbound_ai_runs(job_id,tenant_id,mode,result) values($1,$2,'shadow',$3)",[job,a,JSON.stringify({profileVersionId:foreign.id,reply:'PRIVATE REPLY'})]);
  const invoke=async(tool,p={})=>{const r=(await db.query('select crm_mcp.invoke($1,$2,$3,$4,$5) r',['staff','provenance-client',tool,JSON.stringify(p),crypto.randomUUID()])).rows[0].r;if(r.ok)toolOutputs[tool].parse(r.data);return r;};
  const connectionId=(await invoke('crm_get_access')).data.connectionId;
  await call(db,'mcp_admin','staff','save',{connectionId,revision:0,status:'active',permissions:['ai_reply_read'],businessIds:[a],allBusinesses:false});
  const args={businessId:a,runId:job};
  const before=(await db.query('select to_jsonb(r) r from sms_private.inbound_ai_runs r where job_id=$1',[job])).rows[0].r;
  const capturedBefore=(await db.query('select to_jsonb(c) c from sms_private.inbound_ai_profile_contexts c where job_id=$1',[job])).rows[0].c;
  const detail=(await invoke('crm_get_ai_reply_run',args)).data;
  assert.equal(detail.profileVersionId,p.id);assert.equal(detail.profileVersion,2);assert.equal(detail.profileVersionAvailability,'recorded');assert.ok(detail.profileCapturedAt);assert.equal(detail.content,null);
  assert.equal(detail.run.profileVersionId,p.id);
  const legacy=structuredClone(detail);
  for(const key of ['profileVersionId','profileVersion','profileCapturedAt','profileVersionAvailability'])delete legacy.run[key];
  delete legacy.profileVersion;delete legacy.profileCapturedAt;legacy.profileVersionId=null;legacy.profileVersionAvailability='not_recorded';
  const compatible=toolOutputs.crm_get_ai_reply_run.parse(legacy);
  assert.equal(compatible.run.profileVersionAvailability,'not_recorded');assert.equal(compatible.profileCapturedAt,null);
  for(const patch of [{profileVersionId:'bad'},{profileVersion:-1},{profileVersion:'2'},{profileCapturedAt:'bad'},{profileVersionAvailability:'inferred'},{profileFacts:{secret:'PRIVATE'}}])assert.equal(toolOutputs.crm_get_ai_reply_run.safeParse({...detail,...patch}).success,false);

  assert.ok(!JSON.stringify(detail).includes('PRIVATE'));assert.ok(!JSON.stringify(detail).includes(foreign.id));
  assert.equal((await invoke('crm_list_ai_reply_runs',{businessId:a})).data.runs[0].profileVersionId,p.id);
  assert.equal((await invoke('crm_get_ai_reply_run',{...args,businessId:b})).error.code,'PERMISSION_DENIED');
  assert.equal((await invoke('crm_get_ai_reply_run',{...args,includeContent:true})).error.code,'PERMISSION_DENIED');
  assert.deepEqual((await db.query('select to_jsonb(r) r from sms_private.inbound_ai_runs r where job_id=$1',[job])).rows[0].r,before);
  assert.deepEqual((await db.query('select to_jsonb(c) c from sms_private.inbound_ai_profile_contexts c where job_id=$1',[job])).rows[0].c,capturedBefore);
  assert.equal((await db.query("select relrowsecurity v from pg_class where oid='sms_private.inbound_ai_profile_contexts'::regclass")).rows[0].v,true);
  await profile(db,a,3);await db.query("update public.sms_business_profile_versions set status='superseded' where tenant_id=$1 and id=$2",[a,p.id]);
  assert.equal((await invoke('crm_get_ai_reply_run',args)).data.profileVersionId,p.id);
  await assert.rejects(()=>db.query('update sms_private.inbound_ai_runs set profile_version_id=$2 where job_id=$1',[job,foreign.id]),/foreign key/);
  for(const role of ['anon','authenticated','service_role','sms_api','sms_ai','sms_automation','crm_mcp']) {
   assert.equal((await db.query("select has_table_privilege($1,'sms_private.inbound_ai_profile_contexts','select') v",[role])).rows[0].v,false);
   for(const fn of ['sms_private.attach_inbound_ai_profile()','sms_private.mcp_ai_profile_projection(text,uuid,integer,timestamptz)'])assert.equal((await db.query("select has_function_privilege($1,$2,'execute') v",[role,fn])).rows[0].v,false);
  }
  const audits=(await db.query("select to_jsonb(a) v from sms_private.mcp_activity a where tool in ('crm_get_ai_reply_run','crm_list_ai_reply_runs')")).rows;
  assert.ok(!JSON.stringify(audits).includes('PRIVATE'));assert.equal((await db.query('select count(*)::int n from sms_private.mcp_requests')).rows[0].n,0);
 }finally{await db.close();}
});
