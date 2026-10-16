import test from 'node:test';
import assert from 'node:assert/strict';
import {z} from 'zod';
import {zodToJsonSchema} from 'zod-to-json-schema';
import {fixture} from './helpers/twilioConnections.js';
import {call} from './helpers/database.js';
import {addRun} from './helpers/coordination.js';
import {toolOutputs} from '../src/mcp/tools.js';
import {activityTools,activityPermissions,activityToolPermissions} from '../src/mcp/activitySchemas.js';

test('MCP conversation controls and activity management preserve scope, revisions and retry safety',async t=>{
 const {db,business,admin}=await fixture();
 try{
  const a=(await business('activity-a')).tenant,b=(await business('activity-b')).tenant,phone='+17208429167';
  for(const tenant of [a,b]){await call(db,'platform_action','staff','service_add',{tenantId:tenant,kind:'sms'});await db.query("insert into public.sms_contacts(tenant_id,phone,name) values($1,$2,'Synthetic')",[tenant,phone]);}
  const cid=await call(db,'ensure_conversation',a,phone,null),foreign=await call(db,'ensure_conversation',b,phone,null);
  const group=(await db.query('select id from public.sms_automation_groups where tenant_id=$1 limit 1',[a])).rows[0].id;
  const dest=await call(db,'ensure_conversation',a,phone,group);
  const mid=(await db.query("insert into public.sms_messages(tenant_id,contact_phone,conversation_id,direction,body,status) values($1,$2,$3,'inbound','PRIVATE UNREAD','received') returning id",[a,phone,cid])).rows[0].id;
  const run=await addRun(db,{business:a,customer:phone}),otherRun=await addRun(db,{business:b,customer:phone});
  const row=async id=>(await db.query('select * from public.sms_conversations where id=$1',[id])).rows[0];
  const runrow=async()=>(await db.query('select * from sms_private.form_runs where id=$1',[run.id])).rows[0];
  const invoke=async(tool,p,user='staff')=>{const requestId=crypto.randomUUID();const r=(await db.query('select crm_mcp.invoke($1,$2,$3,$4,$5) r',[user,'https://activity.example',tool,JSON.stringify(p),requestId])).rows[0].r;if(r.ok)toolOutputs[tool].parse(r.data);return {...r,requestId};};
  const id=(await invoke('crm_get_access',{})).data.connectionId;let gr=0;
  const grant=async(permissions=activityPermissions.map(x=>x[0]),businessIds=[a],status='active')=>{gr=(await call(db,'mcp_admin','staff','save',{connectionId:id,revision:gr,status,permissions,businessIds,allBusinesses:false})).connection.revision;};
  const conv=async extra=>({businessId:a,conversationId:cid,revision:(await row(cid)).revision,idempotencyKey:crypto.randomUUID(),...extra});
  const activity=async extra=>{const r=await runrow();return {businessId:a,runId:r.id,generation:r.generation,activityRevision:r.activity_revision,idempotencyKey:crypto.randomUUID(),...extra};};
  const snapshot=async()=>{const result={};for(const table of ['public.sms_messages','public.sms_contacts','public.sms_conversations','sms_private.jobs','sms_private.form_runs','sms_private.activity_tags','sms_private.activity_run_tags','sms_private.activity_responses','sms_private.activity_bookings','sms_private.mcp_requests'])result[table]=(await db.query(`select to_jsonb(x) v from ${table} x order by to_jsonb(x)::text`)).rows;return result;};
  await grant();
  await t.test('database validates the exact generated schemas, rejecting unknown fields/types and bounds',async()=>{
   for(const [name,,shape] of activityTools){const schema=(await db.query('select schema from sms_private.mcp_input_schemas where tool=$1',[name])).rows[0].schema;assert.deepEqual(schema,zodToJsonSchema(z.object(shape).strict(),{$refStrategy:'none'}));assert.equal((await invoke(name,{businessId:a,forged:true})).error.code,'VALIDATION_ERROR',name);}
   for(const p of [{page:0},{pageSize:101},{page:'1'},{includeArchived:'true'}])assert.equal((await invoke('crm_list_activity_tags',{businessId:a,...p})).error.code,'VALIDATION_ERROR');
   assert.equal((await invoke('crm_get_activity_report',{businessId:a,from:'2026-02-30',to:'2026-03-01'})).error.code,'VALIDATION_ERROR');
  });
  await t.test('each write grant is independent; scoped reads and counts never expose foreign rows',async()=>{
   for(const [name,,,writing] of activityTools){if(!writing)continue;await grant(activityPermissions.map(x=>x[0]).filter(x=>x!==activityToolPermissions[name]));const before=await snapshot();assert.equal((await invoke(name,{businessId:a})).error.code,'PERMISSION_DENIED');assert.deepEqual(await snapshot(),before);}
   await grant();await call(db,'automation_activity','staff',b,'tag',{name:'Foreign secret'});
   const tags=await invoke('crm_list_activity_tags',{businessId:a});assert.equal(tags.data.total,0);
   assert.equal((await invoke('crm_get_enquiry_attribution_context',{businessId:a,runId:otherRun.id,kind:'tags'})).error.code,'PERMISSION_DENIED');
   assert.equal((await invoke('crm_pause_conversation_ai',{...await conv(),conversationId:foreign})).error.code,'PERMISSION_DENIED');
   const report=await invoke('crm_get_activity_report',{businessId:a,from:'2026-01-01',to:'2026-12-31',scope:'enquiry'});assert.equal(report.ok,true,JSON.stringify(report));assert.ok(!JSON.stringify(report.data).includes('Foreign secret'));
  });
  await t.test('AI controls compare shared revisions, preserve unread and automation state, and recheck opt-out',async()=>{
   const before=await runrow(),p=await conv();const paused=await invoke('crm_pause_conversation_ai',p);assert.equal(paused.ok,true,JSON.stringify(paused));assert.equal(paused.data.aiPaused,true);assert.deepEqual((await invoke('crm_pause_conversation_ai',p)).data,paused.data);
   assert.equal((await invoke('crm_resume_conversation_ai',{...p,idempotencyKey:crypto.randomUUID()})).error.code,'CONFLICT');assert.deepEqual(await runrow(),before);
   await db.query('update public.sms_contacts set opted_out=true where tenant_id=$1',[a]);assert.equal((await invoke('crm_resume_conversation_ai',await conv())).error.code,'PERMISSION_DENIED');
   await db.query('update public.sms_contacts set opted_out=false where tenant_id=$1',[a]);const suppressed=await runrow();assert.equal((await invoke('crm_resume_conversation_ai',await conv())).data.aiPaused,false);
   assert.deepEqual(await runrow(),suppressed);assert.equal((await db.query('select read_at from public.sms_messages where id=$1',[mid])).rows[0].read_at,null);
  });
  await t.test('message reassignment checks both thread revisions and same-customer target',async()=>{
   const p=await conv({messageId:mid,targetConversationId:dest,targetRevision:(await row(dest)).revision});
   assert.equal((await invoke('crm_reassign_conversation_message',{...p,targetConversationId:foreign})).error.code,'PERMISSION_DENIED');
   assert.equal((await invoke('crm_reassign_conversation_message',{...p,targetRevision:p.targetRevision+1})).error.code,'CONFLICT');
   const r=await invoke('crm_reassign_conversation_message',p);assert.equal(r.ok,true,JSON.stringify(r));assert.equal(r.data.changed,true);assert.deepEqual((await invoke('crm_reassign_conversation_message',p)).data,r.data);
   const m=(await db.query('select conversation_id,read_at from public.sms_messages where id=$1',[mid])).rows[0];assert.equal(m.conversation_id,dest);assert.equal(m.read_at,null);
   assert.equal((await db.query('select count(*) n from sms_private.mcp_activity where request_id=$1',[r.requestId])).rows[0].n,2);
  });
  let tagId;
  await t.test('tag creation/edit/assignment use independent activity revisions without changing SMS generation',async()=>{
   const create={businessId:a,name:'Needs quote',idempotencyKey:crypto.randomUUID()},r=await invoke('crm_create_activity_tag',create);assert.equal(r.ok,true,JSON.stringify(r));tagId=r.data.tagId;assert.deepEqual((await invoke('crm_create_activity_tag',create)).data,r.data);
   const ctx=await invoke('crm_get_enquiry_attribution_context',{businessId:a,runId:run.id,kind:'tags',page:1,pageSize:1});assert.equal(ctx.data.rows[0].id,tagId);assert.equal(ctx.data.rows[0].present,false);
   const p=await activity({tagId,tagRevision:1,present:true}),before=await runrow();const assigned=await invoke('crm_set_enquiry_tag',p);assert.equal(assigned.ok,true,JSON.stringify(assigned));assert.ok(assigned.data.revision>p.activityRevision);assert.equal((await runrow()).generation,before.generation);
   assert.equal((await invoke('crm_set_enquiry_tag',{...p,present:false,idempotencyKey:crypto.randomUUID()})).error.code,'CONFLICT');assert.deepEqual((await invoke('crm_set_enquiry_tag',p)).data,assigned.data);
   const update={businessId:a,tagId,revision:1,name:'Renamed',archived:false,idempotencyKey:crypto.randomUUID()};assert.equal((await invoke('crm_update_activity_tag',update)).ok,true);assert.equal((await invoke('crm_set_enquiry_tag',await activity({tagId,tagRevision:1,present:false}))).error.code,'CONFLICT');
  });
  await t.test('booking/response/AI attribution requires same customer and returns both revisions',async()=>{
   await db.query("insert into public.sms_bookings(tenant_id,id,contact_id,customer_phone,appointment_at,status) select tenant_id,case when tenant_id=$1 then 'same-booking' else 'foreign-booking' end,id,phone,now()+interval '1 day','confirmed' from public.sms_contacts where tenant_id in ($1,$3) and phone=$2",[a,phone,b]);
   let p=await activity({bookingId:'foreign-booking',revision:0});assert.equal((await invoke('crm_link_enquiry_booking',p)).error.code,'PERMISSION_DENIED');
   p=await activity({bookingId:'same-booking',revision:0});let r=await invoke('crm_link_enquiry_booking',p);assert.equal(r.ok,true,JSON.stringify(r));assert.equal(r.data.relatedRecord.revision,1);assert.deepEqual((await invoke('crm_link_enquiry_booking',p)).data,r.data);
   r=await invoke('crm_link_enquiry_response',await activity({messageId:mid,revision:0}));assert.equal(r.ok,true,JSON.stringify(r));assert.equal(r.data.relatedRecord.id,mid);
   const event=(await db.query("insert into sms_private.activity_events(tenant_id,event_key,kind,details) values($1,'synthetic-ai','ai_action',jsonb_build_object('conversationId',$2::text)) returning id",[a,dest])).rows[0].id;
   r=await invoke('crm_link_enquiry_activity',await activity({eventId:event,revision:1}));assert.equal(r.ok,true,JSON.stringify(r));assert.equal(r.data.relatedRecord.revision,2);
   const before=await runrow();await db.query("insert into sms_private.activity_events(tenant_id,run_id,event_key,kind) values($1,$2,'worker-change','test')",[a,run.id]);assert.ok((await runrow()).activity_revision>before.activity_revision);assert.equal((await runrow()).generation,before.generation);
  });
  await t.test('handoff retry accepts only definite failure, never submitted/uncertain work',async()=>{
   const job=(await db.query("insert into sms_private.jobs(tenant_id,queue,dedupe_key,payload) values($1,'ai_reply_jobs','synthetic-handoff','{}') returning id",[a])).rows[0].id;
   const hid=(await db.query("insert into public.sms_handoffs(tenant_id,contact_id,ai_job_id,reason,alert_status) select $1,id,$2,'Synthetic','failed' from public.sms_contacts where tenant_id=$1 and phone=$3 returning id",[a,job,phone])).rows[0].id;
   await db.query('insert into public.sms_ai_settings(tenant_id,group_id,alert_phone) values($1,$2,$3) on conflict(tenant_id,group_id) do update set alert_phone=excluded.alert_phone',[a,group,phone]);
   const p={businessId:a,handoffId:hid,revision:1,idempotencyKey:crypto.randomUUID()};let r=await invoke('crm_retry_handoff_alert',p);assert.equal(r.ok,true,JSON.stringify(r));assert.equal(r.data.deliveryStatus,'queued');assert.deepEqual((await invoke('crm_retry_handoff_alert',p)).data,r.data);
   assert.equal((await invoke('crm_retry_handoff_alert',{...p,revision:r.data.revision,idempotencyKey:crypto.randomUUID()})).error.code,'CONFLICT');
   await db.query("update public.sms_handoffs set alert_status='failed' where tenant_id=$1 and id=$2",[a,hid]);await db.query("update sms_private.jobs set status='submission_unknown' where id=$1",[r.data.jobId]);
   const revision=(await db.query('select revision from public.sms_handoffs where id=$1',[hid])).rows[0].revision;
   assert.equal((await invoke('crm_retry_handoff_alert',{...p,revision,idempotencyKey:crypto.randomUUID()})).error.code,'CONFLICT');
  });
  await t.test('audit failure rolls back mutations and scope/revocation block retries',async()=>{
   const p=await activity({tagId,tagRevision:2,present:false}),before=await snapshot();
   await db.exec("create function sms_private.activity_test_fail() returns trigger language plpgsql as $$begin raise exception 'fail' using errcode='XX000';end$$;create trigger activity_test_fail before insert on sms_private.mcp_activity for each row execute function sms_private.activity_test_fail();");
   await assert.rejects(()=>invoke('crm_set_enquiry_tag',p));assert.deepEqual(await snapshot(),before);await db.exec('drop trigger activity_test_fail on sms_private.mcp_activity;drop function sms_private.activity_test_fail();');
   const r=await invoke('crm_set_enquiry_tag',p);assert.equal(r.ok,true,JSON.stringify(r));const audit=(await db.query('select * from sms_private.mcp_activity where request_id=$1 order by id',[r.requestId])).rows;assert.equal(audit.length,2);assert.ok(audit.every(x=>x.actor_id===admin));assert.ok(!JSON.stringify(audit).includes('PRIVATE UNREAD'));
   await grant(undefined,[b]);assert.equal((await invoke('crm_set_enquiry_tag',p)).error.code,'PERMISSION_DENIED');await grant(undefined,[a],'revoked');assert.equal((await invoke('crm_set_enquiry_tag',p)).error.code,'PERMISSION_DENIED');
   assert.equal(Number((await db.query("select count(*) n from public.sms_messages where direction='outbound' or read_at is not null")).rows[0].n),0);
  });
 }finally{await db.close();}
});
