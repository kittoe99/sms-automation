import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './helpers/twilioConnections.js';
import {call} from './helpers/database.js';
import {toolOutputs} from '../src/mcp/tools.js';
import {knowledgePermissions,knowledgeTools} from '../src/mcp/knowledgeSchemas.js';
import {withKnowledgeUpload} from '../src/mcp/knowledgeUpload.js';
import {signMcpKnowledgeUpload} from '../supabase/functions/crm-api/mcp-upload.js';

test('MCP knowledge isolation, independent grants, shared revisions, retries, audits and upload credentials',async t=>{
 const {db,business,admin}=await fixture();
 try{
  const a=(await business('knowledge-a')).tenant,b=(await business('knowledge-b')).tenant;
  const invoke=async(tool,p={},client='knowledge-client')=>{const requestId=crypto.randomUUID();const r=(await db.query('select crm_mcp.invoke($1,$2,$3,$4,$5) r',['staff',client,tool,JSON.stringify(p),requestId])).rows[0].r;if(r.ok)toolOutputs[tool].parse(r.data);return r;};
  const cid=(await invoke('crm_get_access')).data.connectionId;let gr=0;
  const grant=async(permissions=knowledgePermissions.map(x=>x[0]),status='active')=>{gr=(await call(db,'mcp_admin','staff','save',{connectionId:cid,revision:gr,status,permissions,businessIds:[a],allBusinesses:false})).connection.revision;};
  const snapshot=async()=> (await db.query("select (select count(*) from public.sms_messages) messages,(select count(*) from sms_private.jobs where queue in ('sms_send_jobs','ai_reply_jobs')) sends,(select count(*) from sms_private.inbound_ai_settings) settings")).rows[0];
  const before=await snapshot();await grant();
  let sid,rev,vid,vrev,upload;
  await t.test('strict schemas and grants precede all effects',async()=>{
   await grant([]);
   for(const [name] of knowledgeTools){const r=await invoke(name,{businessId:a});assert.equal(r.ok,false);}
   await grant();assert.equal((await invoke('crm_create_knowledge_source',{businessId:a,type:'manual',title:'Test',text:'private manual content here',enabled:true,idempotencyKey:crypto.randomUUID()})).error.code,'VALIDATION_ERROR');
   assert.equal((await invoke('crm_create_knowledge_source',{businessId:a,type:'website',title:'Test',websiteUrl:'https://secret@example.com/',idempotencyKey:crypto.randomUUID()})).error.code,'VALIDATION_ERROR');
   assert.equal((await invoke('crm_create_knowledge_source',{businessId:a,type:'manual',title:'Test',text:'private manual content here',websiteUrl:'https://example.com/',idempotencyKey:crypto.randomUUID()})).error.code,'VALIDATION_ERROR');
   assert.deepEqual(await snapshot(),before);
  });
  await t.test('creation is retry-safe and never overwrites duplicate content',async()=>{
   const p={businessId:a,type:'manual',title:'Knowledge test',text:'PRIVATE KNOWLEDGE CONTENT '.repeat(5),idempotencyKey:crypto.randomUUID()};
   const r=await invoke('crm_create_knowledge_source',p);assert.equal(r.ok,true,JSON.stringify(r));sid=r.data.sourceId;rev=r.data.revision;assert.equal(r.data.providerWork,'queued');
   assert.deepEqual((await invoke('crm_create_knowledge_source',p)).data,r.data);
   assert.equal((await invoke('crm_create_knowledge_source',{...p,title:'Changed'})).error.code,'CONFLICT');
   assert.equal((await invoke('crm_create_knowledge_source',{...p,idempotencyKey:crypto.randomUUID()})).error.code,'CONFLICT');
   const foreign=await call(db,'create_knowledge_source','staff',b,{type:'manual',title:'FOREIGN TITLE',origin:'FOREIGN SECRET CONTENT '.repeat(3)});
   assert.equal((await invoke('crm_get_knowledge_source',{businessId:a,sourceId:foreign.id})).error.code,'PERMISSION_DENIED');
   assert.equal((await invoke('crm_list_knowledge_sources',{businessId:b})).error.code,'PERMISSION_DENIED');
   const list=await invoke('crm_list_knowledge_sources',{businessId:a,page:1,pageSize:1});assert.equal(list.data.sources.length,1);assert.ok(!JSON.stringify(list).includes('FOREIGN'));
  });
  await t.test('bounded version text and nested IDs cannot escape source/business scope',async()=>{
   vid=(await db.query("insert into public.sms_knowledge_source_versions(tenant_id,source_id,version,status,extracted_text,created_by) values($1,$2,1,'ready',$3,'staff') returning id",[a,sid,'PRIVATE VERSION TEXT '.repeat(100)])).rows[0].id;
   const foreignSid=(await db.query('select id from public.sms_knowledge_sources where tenant_id=$1 limit 1',[b])).rows[0].id;
   const foreignVid=(await db.query("insert into public.sms_knowledge_source_versions(tenant_id,source_id,version,status,extracted_text,created_by) values($1,$2,99,'ready','FOREIGN VERSION TEXT','staff') returning id",[b,foreignSid])).rows[0].id;
   const versions=await invoke('crm_list_knowledge_versions',{businessId:a,sourceId:sid});assert.equal(versions.data.total,1);
   const detail=await invoke('crm_get_knowledge_version',{businessId:a,sourceId:sid,versionId:vid,textOffset:10,textLimit:20});assert.equal(detail.data.text.length,20);assert.equal(detail.data.nextTextOffset,30);vrev=detail.data.version.revision;
   assert.equal((await invoke('crm_get_knowledge_version',{businessId:a,sourceId:sid,versionId:foreignVid})).error.code,'PERMISSION_DENIED');
  });
  await t.test('approval, refresh and archive have independent permissions and worker conflicts',async()=>{
   const p={businessId:a,sourceId:sid,revision:rev,versionId:vid,versionRevision:vrev,idempotencyKey:crypto.randomUUID()};
   await grant(['knowledge_read']);assert.equal((await invoke('crm_approve_knowledge_version',p)).error.code,'PERMISSION_DENIED');await grant();
   await db.query("update public.sms_knowledge_sources set title=title where tenant_id=$1 and id=$2",[a,sid]);
   assert.equal((await invoke('crm_approve_knowledge_version',p)).error.code,'CONFLICT');
   rev=(await invoke('crm_get_knowledge_source',{businessId:a,sourceId:sid})).data.source.revision;
   const r=await invoke('crm_approve_knowledge_version',{...p,revision:rev});assert.equal(r.ok,true,JSON.stringify(r));assert.equal(r.data.versionRevision,vrev+1);rev=r.data.revision;
   const refresh=await invoke('crm_refresh_knowledge_source',{businessId:a,sourceId:sid,revision:rev,idempotencyKey:crypto.randomUUID()});assert.equal(refresh.ok,true,JSON.stringify(refresh));rev=refresh.data.revision;
   await db.query("update sms_private.jobs set status='processing',lease_token=gen_random_uuid(),leased_until=now()+interval '1 minute' where tenant_id=$1 and queue='knowledge_ingest_jobs'",[a]);
   const archive={businessId:a,sourceId:sid,revision:rev,idempotencyKey:crypto.randomUUID()};assert.equal((await invoke('crm_archive_knowledge_source',archive)).error.code,'TEMPORARY_FAILURE');
   await db.query("update sms_private.jobs set status='queued',lease_token=null,leased_until=null where tenant_id=$1 and queue='knowledge_ingest_jobs'",[a]);
   const archived=await invoke('crm_archive_knowledge_source',archive);assert.equal(archived.ok,true,JSON.stringify(archived));assert.equal(archived.data.status,'archived');assert.deepEqual((await invoke('crm_archive_knowledge_source',archive)).data,archived.data);
   await assert.rejects(()=>db.query("update public.sms_knowledge_sources set status='ready' where tenant_id=$1 and id=$2",[a,sid]),/Archived/);
  });
  await t.test('pure AI reads, revision-protected edits, mode grant and canonical readiness',async()=>{
   const beforeRead=await snapshot();const c=await invoke('crm_get_ai_configuration',{businessId:a});assert.equal(c.data.configuration.mode,'off');assert.deepEqual(await snapshot(),beforeRead);
   await grant(['ai_config_edit']);
   const p={businessId:a,revision:c.data.configuration.revision,systemPrompt:'PRIVATE AI INSTRUCTIONS',idempotencyKey:crypto.randomUUID()};
   const edited=await invoke('crm_save_ai_configuration',p);assert.equal(edited.ok,true,JSON.stringify(edited));assert.equal(edited.data.configuration.mode,'off');assert.deepEqual((await invoke('crm_save_ai_configuration',p)).data,edited.data);
   assert.equal((await invoke('crm_set_ai_mode',{businessId:a,revision:edited.data.revision,mode:'live',bookingEnabled:true,idempotencyKey:crypto.randomUUID()})).error.code,'PERMISSION_DENIED');
   await grant();assert.equal((await invoke('crm_set_ai_mode',{businessId:a,revision:edited.data.revision,mode:'live',bookingEnabled:true,idempotencyKey:crypto.randomUUID()})).ok,false);
   await db.query("update sms_private.inbound_ai_settings set system_prompt='BROWSER CHANGE' where tenant_id=$1",[a]);
   assert.equal((await invoke('crm_save_ai_configuration',{...p,revision:edited.data.revision,idempotencyKey:crypto.randomUUID()})).error.code,'CONFLICT');
  });
  await t.test('audit failure rolls back source, indexing job and retry receipt together',async()=>{
   const counts=async()=> (await db.query("select (select count(*) from public.sms_knowledge_sources) sources,(select count(*) from sms_private.jobs) jobs,(select count(*) from sms_private.mcp_requests) receipts")).rows[0];
   const before=await counts();
   await db.exec("create function sms_private.knowledge_test_audit_fail() returns trigger language plpgsql as $$begin raise exception 'audit failure' using errcode='XX000';end$$;create trigger knowledge_test_audit_fail before insert on sms_private.mcp_activity for each row execute function sms_private.knowledge_test_audit_fail();");
   const p={businessId:a,type:'manual',title:'Audit rollback',text:'Synthetic text that must roll back atomically.',idempotencyKey:crypto.randomUUID()};
   await assert.rejects(()=>invoke('crm_create_knowledge_source',p));assert.deepEqual(await counts(),before);
   await db.exec('drop trigger knowledge_test_audit_fail on sms_private.mcp_activity;drop function sms_private.knowledge_test_audit_fail();');
   const r=await invoke('crm_create_knowledge_source',p);assert.equal(r.ok,true);assert.deepEqual((await invoke('crm_create_knowledge_source',p)).data,r.data);
  });
  await t.test('upload tickets are scoped, one-use, expire, recheck grants and never enter receipts',async()=>{
   const p={businessId:a,fileName:'knowledge.txt',contentType:'text/plain',size:100,idempotencyKey:crypto.randomUUID()};
   const r=await invoke('crm_prepare_knowledge_upload',p);assert.equal(r.ok,true,JSON.stringify(r));upload=r.data.uploadId;assert.deepEqual((await invoke('crm_prepare_knowledge_upload',p)).data,r.data);
   const ticket=async(client='knowledge-client')=>(await db.query('select crm_mcp.knowledge_upload_ticket($1,$2,$3) t',['staff',client,upload])).rows[0].t;
   await assert.rejects(()=>ticket('other-client'));
   await db.exec('set role crm_mcp');const token=await ticket();await assert.rejects(()=>call(db,'mcp_consume_upload_ticket',token));await db.exec('reset role');
   const intent=await call(db,'mcp_consume_upload_ticket',token);assert.ok(intent.path.startsWith(a+'/'));await assert.rejects(()=>call(db,'mcp_consume_upload_ticket',token));
   const token2=await ticket();await grant(['knowledge_create']);await assert.rejects(()=>call(db,'mcp_consume_upload_ticket',token2));await assert.rejects(()=>ticket());await grant();
   const token3=await ticket();await db.exec("update sms_private.mcp_upload_tickets set expires_at=now()-interval '1 second'");await assert.rejects(()=>call(db,'mcp_consume_upload_ticket',token3));
   await db.exec('create schema storage;create table storage.objects(bucket_id text,name text,metadata jsonb);');
   await db.query("insert into storage.objects select 'business-knowledge',storage_path,jsonb_build_object('mimetype',content_type,'size',byte_size) from sms_private.mcp_knowledge_uploads where id=$1",[upload]);
   const file=await invoke('crm_create_knowledge_source',{businessId:a,type:'file',title:'Uploaded test',uploadId:upload,idempotencyKey:crypto.randomUUID()});assert.equal(file.ok,true,JSON.stringify(file));await assert.rejects(()=>ticket());
   const stored=JSON.stringify((await db.query('select result from sms_private.mcp_requests')).rows)+JSON.stringify((await db.query('select * from sms_private.mcp_activity')).rows);
   for(const secret of [token,token2,token3,'PRIVATE KNOWLEDGE CONTENT','PRIVATE VERSION TEXT','PRIVATE AI INSTRUCTIONS'])assert.ok(!stored.includes(secret));
   await grant([], 'revoked');assert.equal((await invoke('crm_prepare_knowledge_upload',p)).error.code,'PERMISSION_DENIED');
  });
  const after=await snapshot();assert.equal(after.messages,before.messages);assert.equal(after.sends,before.sends);
  assert.equal((await db.query("select count(*) n from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='sms_private' and p.proname in ('mcp_knowledge_action','mcp_knowledge_source','mcp_knowledge_version','mcp_ai_configuration') and has_function_privilege('crm_mcp',p.oid,'execute')")).rows[0].n,0);
 }finally{await db.close();}
});

test('knowledge upload adapter keeps storage credentials server-side and recovers signing after committed intent',async()=>{
 const base='https://project.supabase.co',path='biz-test/object-file.txt',ticket='a'.repeat(72),signed=`${base}/storage/v1/object/upload/sign/business-knowledge/${path}?token=private-token`;
 let consumes=0,requests=0;const db={call:async(name,t)=>{assert.equal(name,'mcp_consume_upload_ticket');assert.equal(t,ticket);consumes++;return {path,contentType:'text/plain',maxBytes:100};}};
 const fetchImpl=async(url,options)=>{requests++;assert.equal(options.redirect,'error');assert.equal(options.headers.apikey,'storage-secret');assert.equal(options.body,'{}');return Response.json({url:signed.replace(base+'/storage/v1','')});};
 assert.deepEqual(await signMcpKnowledgeUpload(db,{ticket},{base,key:'storage-secret',fetchImpl}),{signedUrl:signed});
 await assert.rejects(()=>signMcpKnowledgeUpload(db,{ticket,path:'other-business'},{base,key:'storage-secret',fetchImpl}));assert.equal(consumes,1);assert.equal(requests,1);
 const committed={ok:true,data:{uploadId:crypto.randomUUID(),uploadStatus:'prepared'}};const invoke=async()=>structuredClone(committed);let minted=0;
 const wrapped=withKnowledgeUpload(invoke,async()=>{minted++;return ticket;},{adapterUrl:base+'/functions/v1/crm-api/mcp/knowledge-upload',fetchImpl:async(url,o)=>{assert.equal(o.headers.Authorization,undefined);assert.deepEqual(JSON.parse(o.body),{ticket});return Response.json({signedUrl:signed});}});
 const result=await wrapped({},'crm_prepare_knowledge_upload',{},crypto.randomUUID());assert.equal(result.data.uploadStatus,'ready');assert.equal(committed.data.uploadStatus,'prepared');assert.equal(minted,1);
 const failed=withKnowledgeUpload(invoke,async()=>ticket,{adapterUrl:base+'/functions/v1/crm-api/mcp/knowledge-upload',fetchImpl:async()=>{throw new Error('private credentials');}});
 const recovery=await failed({},'crm_prepare_knowledge_upload',{},crypto.randomUUID());assert.equal(recovery.ok,true);assert.equal(recovery.data.uploadStatus,'temporarily_unavailable');assert.ok(!JSON.stringify(recovery).includes('credentials'));
});
