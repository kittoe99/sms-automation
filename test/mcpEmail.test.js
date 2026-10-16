import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './helpers/twilioConnections.js';
import {call} from './helpers/database.js';
import {toolOutputs} from '../src/mcp/tools.js';
import {emailPermissions} from '../src/mcp/emailSchemas.js';
import {withEmailAdapter} from '../src/mcp/emailAdapter.js';
import {executeMcpEmailAction} from '../supabase/functions/crm-api/mcp-email.js';
import {saveEmailGroup} from '../supabase/functions/crm-api/email.js';

test('MCP email workflows are scoped, separately granted, revision/retry protected and provider fenced',async t=>{
 const {db,business}=await fixture();
 try{
  const a=(await business('email-a')).tenant,b=(await business('email-b')).tenant;
  for(const tenant of [a,b])await call(db,'seed_fixed_automation_groups',tenant);
  const invoke=async(tool,p={},requestId=crypto.randomUUID())=>{const r=(await db.query('select crm_mcp.invoke($1,$2,$3,$4,$5) r',['staff','email-client',tool,JSON.stringify(p),requestId])).rows[0].r;if(r.ok)toolOutputs[tool].parse(r.data);return r;};
  const cid=(await invoke('crm_get_access')).data.connectionId;let gr=0;
  const grant=async(permissions=emailPermissions.map(x=>x[0]),status='active')=>{gr=(await call(db,'mcp_admin','staff','save',{connectionId:cid,revision:gr,status,permissions,businessIds:[a],allBusinesses:false})).connection.revision;};await grant();
  const ticket=async(tool,p,rid=crypto.randomUUID())=>(await db.query('select crm_mcp.email_action_ticket($1,$2,$3,$4,$5) r',['staff','email-client',tool,JSON.stringify(p),rid])).rows[0].r;
  const viaEdge=async(tool,p,ready=true)=>{const auth=await ticket(tool,p);if(!auth.ok)return auth;const r=await call(db,'mcp_execute_email_action',auth.ticket,p,ready);if(r.ok)toolOutputs[tool].parse(r.data);return r;};
  const secret=(await db.query("select vault.create_secret('synthetic-secret') id")).rows[0].id;await db.query('insert into vault.secrets(id) values($1)',[secret]);
  await db.query("update sms_private.edge_config set enabled=true,secret_id=$1 where queue='automation_jobs'",[secret]);
  await db.query("insert into sms_private.email_provider_secrets(kind,secret_id) values('resend_api',$1),('resend_webhook',$1)",[secret]);
  const groups=(await invoke('crm_list_email_groups',{businessId:a})).data.groups;assert.equal(groups.length,4);const group=groups.find(x=>x.kind==='contacts'),gid=group.id;
  const configuration={...group.configuration,rule:{...group.configuration.rule,firstDelayCount:0,firstDelayUnit:'hour',repeatCount:3},intent:'PRIVATE EMAIL PURPOSE',systemPrompt:'PRIVATE EMAIL INSTRUCTIONS',businessContext:'PRIVATE EMAIL CONTEXT',mailingAddress:'Synthetic address'};
  let rev=group.revision,eid,jid;
  await t.test('bounded read scope, pure schedule preview and strict inputs',async()=>{
   assert.equal((await invoke('crm_list_email_groups',{businessId:b})).error.code,'PERMISSION_DENIED');
   assert.equal((await invoke('crm_list_email_groups',{businessId:a,pageSize:101})).error.code,'VALIDATION_ERROR');
   assert.equal((await invoke('crm_list_email_enrollments',{businessId:a,groupId:'foreign-or-missing'})).error.code,'PERMISSION_DENIED');
   const before=(await db.query('select (select count(*) from sms_private.email_jobs) jobs,(select count(*) from sms_private.email_enrollments) enrollments')).rows;
   const preview=await invoke('crm_preview_email_schedule',{businessId:a,groupId:gid,revision:rev,startAt:'2026-11-01T06:00:00-07:00',appointmentAt:null});assert.equal(preview.ok,true,JSON.stringify(preview));assert.equal(preview.data.messageTextAvailable,false);assert.ok(preview.data.times.length<=30);
   assert.deepEqual((await db.query('select (select count(*) from sms_private.email_jobs) jobs,(select count(*) from sms_private.email_enrollments) enrollments')).rows,before);
   assert.equal((await invoke('crm_save_email_group',{businessId:a,groupId:gid,revision:rev,configuration:{...configuration,enabled:true},idempotencyKey:crypto.randomUUID()})).error.code,'VALIDATION_ERROR');
  });
  await t.test('configuration preserves activation; Edge readiness cannot be forged; retries are atomic',async()=>{
   const p={businessId:a,groupId:gid,revision:rev,configuration,idempotencyKey:crypto.randomUUID()};const saved=await viaEdge('crm_save_email_group',p,false);assert.equal(saved.ok,true,JSON.stringify(saved));assert.equal(saved.data.enabled,false);rev=saved.data.revision;
   assert.deepEqual((await viaEdge('crm_save_email_group',p,false)).data,saved.data);
   assert.equal((await viaEdge('crm_save_email_group',{...p,configuration:{...configuration,intent:'different'}})).error.code,'CONFLICT');
   const enable={businessId:a,groupId:gid,revision:rev,enabled:true,idempotencyKey:crypto.randomUUID()};
   await grant(['email_config_edit']);assert.equal((await viaEdge('crm_set_email_group_enabled',enable)).error.code,'PERMISSION_DENIED');await grant();
   assert.equal((await invoke('crm_set_email_group_enabled',enable)).error.code,'VALIDATION_ERROR');
   assert.equal((await viaEdge('crm_set_email_group_enabled',enable,false)).error.code,'VALIDATION_ERROR');
   const authorized=await ticket('crm_set_email_group_enabled',enable);await assert.rejects(()=>call(db,'mcp_execute_email_action',authorized.ticket,{...enable,enabled:false},true));
   const enabled=await call(db,'mcp_execute_email_action',authorized.ticket,enable,true);assert.equal(enabled.ok,true,JSON.stringify(enabled));rev=enabled.data.revision;
   await assert.rejects(()=>call(db,'mcp_execute_email_action',authorized.ticket,enable,true));
   assert.deepEqual((await viaEdge('crm_set_email_group_enabled',enable,false)).data,enabled.data);
   await assert.rejects(()=>call(db,'email_save_group','staff',a,gid,{...configuration,revision:rev-1,enabled:false}),/changed/);
   assert.equal((await db.query('select count(*) n from sms_private.email_enrollments')).rows[0].n,0);
  });
  await t.test('legacy form email consent changes preserve SMS and collection, with form/draft revisions',async()=>{
   const f=(await db.query("insert into public.sms_web_form_definitions(tenant_id,preset,title,enabled,legacy_form) values($1,'contacts','Synthetic legacy form',true,true) returning *",[a])).rows[0];
   await db.query("insert into sms_private.form_sequences(tenant_id,form_id,enabled) values($1,$2,true)",[a,f.public_id]);
   await db.query("insert into sms_private.mcp_form_drafts(tenant_id,form_id,definition,base_revision,updated_by,connection_id) values($1,$2,'{\"title\":\"Separate saved draft\",\"description\":\"\",\"buttonLabel\":\"Submit\",\"fields\":[]}', $3,sms_private.platform_actor('staff'),$4)",[a,f.public_id,f.version,cid]);
   const before=(await db.query('select * from sms_private.form_sequences where tenant_id=$1 and form_id=$2',[a,f.public_id])).rows;
   const p={businessId:a,formId:f.public_id,revision:f.version,draftRevision:1,enabled:true,idempotencyKey:crypto.randomUUID()};
   await grant(['email_enable']);assert.equal((await invoke('crm_set_form_email_enabled',p)).error.code,'PERMISSION_DENIED');await grant();
   const enabled=await invoke('crm_set_form_email_enabled',p);assert.equal(enabled.ok,true,JSON.stringify(enabled));assert.equal(enabled.data.collectionEnabled,true);assert.equal(enabled.data.draftRevision,2);assert.deepEqual((await invoke('crm_set_form_email_enabled',p)).data,enabled.data);
   assert.deepEqual((await db.query('select * from sms_private.form_sequences where tenant_id=$1 and form_id=$2',[a,f.public_id])).rows,before);
   assert.equal((await invoke('crm_set_form_email_enabled',{...p,idempotencyKey:crypto.randomUUID()})).error.code,'CONFLICT');
   const modern=(await db.query("insert into public.sms_web_form_definitions(tenant_id,preset,title,enabled) values($1,'contacts','Modern form',false) returning *",[a])).rows[0];
   assert.equal((await invoke('crm_set_form_email_enabled',{...p,formId:modern.public_id,revision:modern.version,draftRevision:0,idempotencyKey:crypto.randomUUID()})).error.code,'VALIDATION_ERROR');
  });
  await t.test('consented enrollments/jobs stay scoped and content has a separate permission',async()=>{
   await call(db,'create_intake','staff',a,'contacts',{name:'Synthetic',phone:'+17208429167',email:'synthetic@example.test',emailOptIn:true,emailConsentEvidence:'SYNTHETIC consent evidence',details:{}});
   const enrollments=await invoke('crm_list_email_enrollments',{businessId:a,groupId:gid});assert.equal(enrollments.data.total,1);eid=enrollments.data.enrollments[0].id;
   const e=(await invoke('crm_get_email_enrollment',{businessId:a,enrollmentId:eid})).data.enrollment;
   jid=(await db.query("insert into sms_private.email_jobs(enrollment_id,step_index,generation,status,subject,body,provider_payload,error_code) values($1,0,$2,'failed','PRIVATE SUBJECT','PRIVATE BODY','{\"headers\":{\"secret\":\"UNSUBSCRIBE TOKEN\"}}','SYNTHETIC_FAILURE') returning id",[eid,e.generation])).rows[0].id;
   const foreignGroup=(await db.query("select group_id from sms_private.email_group_settings where tenant_id=$1 limit 1",[b])).rows[0].group_id;
   const foreign=(await db.query("insert into sms_private.email_enrollments(tenant_id,group_id,source_type,source_id,email,name,rule_snapshot) values($1,$2,'contacts',gen_random_uuid(),'foreign@example.test','FOREIGN PERSON','{}') returning id",[b,foreignGroup])).rows[0].id;
   const foreignJob=(await db.query("insert into sms_private.email_jobs(enrollment_id,step_index,generation) values($1,0,1) returning id",[foreign])).rows[0].id;
   for(const [name,args] of [['crm_get_email_enrollment',{enrollmentId:foreign}],['crm_get_email_job',{jobId:foreignJob}],['crm_list_email_jobs',{enrollmentId:foreign}]])assert.equal((await invoke(name,{businessId:a,...args})).error.code,'PERMISSION_DENIED');
   const jobs=await invoke('crm_list_email_jobs',{businessId:a});assert.equal(jobs.data.total,1);assert.ok(!JSON.stringify(jobs).includes('PRIVATE'));
   await grant(['email_read']);assert.equal((await invoke('crm_get_email_job',{businessId:a,jobId:jid,includeContent:true})).error.code,'PERMISSION_DENIED');assert.equal((await invoke('crm_get_email_job',{businessId:a,jobId:jid})).data.content,null);await grant();
   const detail=await invoke('crm_get_email_job',{businessId:a,jobId:jid,includeContent:true});assert.equal(detail.data.content.body,'PRIVATE BODY');assert.ok(!JSON.stringify(detail).includes('UNSUBSCRIBE TOKEN'));
  });
  await t.test('retry rechecks revisions, consent, overlaps, provider horizon and reuses the same job',async()=>{
   const read=async()=>({e:(await invoke('crm_get_email_enrollment',{businessId:a,enrollmentId:eid})).data.enrollment,j:(await invoke('crm_get_email_job',{businessId:a,jobId:jid})).data.job});
   let {e,j}=await read();const base={businessId:a,enrollmentId:eid,enrollmentRevision:e.revision,generation:e.generation,jobId:jid,revision:j.revision,idempotencyKey:crypto.randomUUID()};
   await grant(['email_read']);assert.equal((await invoke('crm_retry_email_job',base)).error.code,'PERMISSION_DENIED');await grant();
   const consent=(await db.query('select * from sms_private.email_consent_events where tenant_id=$1',[a])).rows[0];
   await db.query('delete from sms_private.email_consent_events where id=$1',[consent.id]);assert.equal((await invoke('crm_retry_email_job',base)).error.code,'VALIDATION_ERROR');
   await db.query('insert into sms_private.email_consent_events(id,tenant_id,group_id,source_type,source_id,email,evidence) values($1,$2,$3,$4,$5,$6,$7)',[consent.id,a,consent.group_id,consent.source_type,consent.source_id,consent.email,consent.evidence]);
   const overlap=(await db.query("insert into sms_private.email_enrollments(tenant_id,group_id,source_type,source_id,email,name,rule_snapshot) select tenant_id,group_id,source_type,gen_random_uuid(),email,name,rule_snapshot from sms_private.email_enrollments where id=$1 returning id",[eid])).rows[0].id;
   assert.equal((await invoke('crm_retry_email_job',base)).ok,false);await db.query('delete from sms_private.email_enrollments where id=$1',[overlap]);
   await db.query("insert into sms_private.email_suppressions(tenant_id,email,reason) values($1,'synthetic@example.test','test')",[a]);assert.equal((await invoke('crm_retry_email_job',base)).ok,false);await db.query('delete from sms_private.email_suppressions where tenant_id=$1',[a]);
   await db.query("update sms_private.email_jobs set send_started_at=now()-interval '24 hours' where id=$1",[jid]);({e,j}=await read());assert.equal((await invoke('crm_retry_email_job',{...base,revision:j.revision})).ok,false);
   await db.query('update sms_private.email_jobs set send_started_at=null where id=$1',[jid]);({e,j}=await read());
   assert.equal((await invoke('crm_retry_email_job',base)).error.code,'CONFLICT');
   const p={...base,revision:j.revision,enrollmentRevision:e.revision};const result=await invoke('crm_retry_email_job',p);assert.equal(result.ok,true,JSON.stringify(result));assert.equal(result.data.status,'pending');assert.equal(result.data.jobId,jid);assert.deepEqual((await invoke('crm_retry_email_job',p)).data,result.data);
   assert.equal((await db.query('select provider_payload from sms_private.email_jobs where id=$1',[jid])).rows[0].provider_payload.headers.secret,'UNSUBSCRIBE TOKEN');
  });
  await t.test('resolution fences pending work and disabling cancels only permitted business enrollments',async()=>{
   const e=(await invoke('crm_get_email_enrollment',{businessId:a,enrollmentId:eid})).data.enrollment;
   const p={businessId:a,enrollmentId:eid,revision:e.revision,generation:e.generation,idempotencyKey:crypto.randomUUID()};
   const before=(await db.query('select to_jsonb(e) e from sms_private.email_enrollments e where id=$1',[eid])).rows;
   await db.exec("create function sms_private.email_test_audit_fail() returns trigger language plpgsql as $$begin raise exception 'audit failure' using errcode='XX000';end$$;create trigger email_test_audit_fail before insert on sms_private.mcp_activity for each row execute function sms_private.email_test_audit_fail();");
   await assert.rejects(()=>invoke('crm_resolve_email_enrollment',p));assert.deepEqual((await db.query('select to_jsonb(e) e from sms_private.email_enrollments e where id=$1',[eid])).rows,before);
   await db.exec('drop trigger email_test_audit_fail on sms_private.mcp_activity;drop function sms_private.email_test_audit_fail();');
   const r=await invoke('crm_resolve_email_enrollment',p);assert.equal(r.ok,true);assert.equal(r.data.generation,e.generation+1);assert.deepEqual((await invoke('crm_resolve_email_enrollment',p)).data,r.data);
   const disable={businessId:a,groupId:gid,revision:rev,enabled:false,idempotencyKey:crypto.randomUUID()};const result=await viaEdge('crm_set_email_group_enabled',disable,false);assert.equal(result.ok,true);assert.equal(result.data.enabled,false);
   assert.equal((await db.query('select status from sms_private.email_enrollments where tenant_id=$1',[b])).rows[0].status,'active');
   const saved=JSON.stringify((await db.query('select result from sms_private.mcp_requests')).rows)+JSON.stringify((await db.query('select * from sms_private.mcp_activity')).rows);
   for(const secret of ['PRIVATE SUBJECT','PRIVATE BODY','PRIVATE EMAIL INSTRUCTIONS','UNSUBSCRIBE TOKEN','SYNTHETIC consent evidence'])assert.ok(!saved.includes(secret));
   await grant([], 'revoked');assert.equal((await viaEdge('crm_set_email_group_enabled',disable)).error.code,'PERMISSION_DENIED');
  });
  assert.equal((await db.query('select count(*) n from public.sms_messages')).rows[0].n,0);
  assert.equal((await db.query("select count(*) n from sms_private.email_jobs where status='sent' or send_started_at is not null")).rows[0].n,0);
 }finally{await db.close();}
});

test('email adapter binds exact input and uses Edge configuration, never OAuth forwarding or provider sends',async()=>{
 const p={businessId:'test',groupId:'group',revision:1,enabled:true,idempotencyKey:'synthetic-key'},ticket='b'.repeat(72);let calls=0;
 const db={call:async(name,credential,input,ready)=>{calls++;assert.equal(name,'mcp_execute_email_action');assert.equal(credential,ticket);assert.deepEqual(input,p);assert.equal(ready,false);return {ok:false,error:{code:'VALIDATION_ERROR'}};}};
 assert.equal((await executeMcpEmailAction(db,{ticket,input:p},{openaiConfigured:false})).ok,false);
 await assert.rejects(()=>executeMcpEmailAction(db,{ticket,input:p,ready:true}));assert.equal(calls,1);
 const invoke=withEmailAdapter(async()=>{throw new Error('Must route via adapter');},async()=>({ok:true,ticket}),{adapterUrl:'https://project.supabase.co/functions/v1/crm-api/mcp/knowledge-upload',fetchImpl:async(url,o)=>{assert.equal(url.pathname,'/functions/v1/crm-api/mcp/email-action');assert.equal(o.redirect,'error');assert.equal(o.headers.Authorization,undefined);assert.deepEqual(JSON.parse(o.body),{ticket,input:p});return Response.json({ok:true,data:{revision:2}});}});
 assert.equal((await invoke({},'crm_set_email_group_enabled',p,crypto.randomUUID())).data.revision,2);
 await assert.rejects(()=>saveEmailGroup(db,'staff','test','group',{}),/Reload/);
});
