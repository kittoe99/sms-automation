import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './helpers/twilioConnections.js';
import {call} from './helpers/database.js';
import {toolOutputs} from '../src/mcp/tools.js';
const tool='crm_reply_to_conversation';

test('conversation replies queue once with scope, consent, revision, retry and redacted audits',async t=>{
 const {db,business,admin}=await fixture();
 try{
  const a=(await business('reply-a')).tenant,b=(await business('reply-b')).tenant;
  for(const tenant of [a,b]){
   await call(db,'platform_action','staff','service_add',{tenantId:tenant,kind:'sms'});
   await db.query("insert into public.sms_contacts(tenant_id,phone,name,marketing_consent) values($1,'+17208429167','Synthetic',false)",[tenant]);
   if(tenant===b)continue;
   await db.query("update public.sms_businesses set status='active',sending_enabled=true where tenant_id=$1",[tenant]);
   await db.query("update sms_private.providers set provisioning_state='configured',account_sid='AC'||repeat('1',32),from_number='+18775550180',auth_secret_id=vault.create_secret('SYNTHETIC SECRET') where tenant_id=$1",[tenant]);
   await db.query('insert into vault.secrets(id) select auth_secret_id from sms_private.providers where tenant_id=$1',[tenant]);
  }
  const cid=await call(db,'ensure_conversation',a,'+17208429167',null),foreign=await call(db,'ensure_conversation',b,'+17208429167',null);
  const inbound=(await db.query("insert into public.sms_messages(tenant_id,contact_phone,conversation_id,direction,body,status) values($1,'+17208429167',$2,'inbound','PRIVATE INBOUND','received') returning id",[a,cid])).rows[0].id;
  const row=async()=>(await db.query('select * from public.sms_conversations where id=$1',[cid])).rows[0];
  const payload=async()=>({businessId:a,conversationId:cid,revision:(await row()).revision,body:'  PRIVATE OUTBOUND REPLY  ',idempotencyKey:crypto.randomUUID()});
  const client='https://test.example/reply';
  const invoke=async(p,name=tool,user='staff',clientId=client)=>{const requestId=crypto.randomUUID();return {...(await db.query('select crm_mcp.invoke($1,$2,$3,$4,$5) r',[user,clientId,name,JSON.stringify(p),requestId])).rows[0].r,requestId};};
  const connectionId=(await invoke({},'crm_get_access')).data.connectionId;let grantRevision=0;
  const grant=async(permissions=['conversation_reply'],businessIds=[a],status='active')=>{const r=await call(db,'mcp_admin','staff','save',{connectionId,revision:grantRevision,status,permissions,businessIds,allBusinesses:false});grantRevision=r.connection.revision;};
  const snapshot=async()=>{const result={};for(const table of ['public.sms_messages','public.sms_conversations','public.sms_contacts','public.sms_consent_events','sms_private.jobs','sms_private.mcp_requests','sms_private.form_runs','sms_private.attempts'])result[table]=(await db.query(`select to_jsonb(x) value from ${table} x order by to_jsonb(x)::text`)).rows;return result;};
  let committed,input;
  await t.test('pending/read/mark-read permissions, nonstaff and cross-business targets cannot queue',async()=>{
   const before=await snapshot(),p=await payload();assert.equal((await invoke(p)).error.code,'PERMISSION_DENIED');
   for(const permissions of [[],['conversation_read','conversation_messages_read'],['conversation_mark_read']]){await grant(permissions);assert.equal((await invoke(p)).error.code,'PERMISSION_DENIED');}
   await grant();assert.equal((await invoke(p,tool,'reader')).error.code,'PERMISSION_DENIED');
   for(const patch of [{businessId:b,conversationId:foreign},{conversationId:foreign},{conversationId:crypto.randomUUID()}])assert.equal((await invoke({...p,...patch})).error.code,'PERMISSION_DENIED');
   assert.deepEqual(await snapshot(),before);
  });
  await t.test('strict input rejects caller recipient/purpose, missing revisions and invalid bodies',async()=>{
   const before=await snapshot(),p=await payload();
   for(const patch of [{phone:'+13035550123'},{purpose:'marketing'},{actor:'forged'},{revision:null},{revision:'1'},{revision:0},{body:''},{body:' \n\t '},{body:null},{body:'x'.repeat(1601)},{idempotencyKey:'short'},{scheduledAt:'now'}])assert.equal((await invoke({...p,...patch})).error?.code,'VALIDATION_ERROR',JSON.stringify(patch));
   assert.deepEqual(await snapshot(),before);
  });
  await t.test('stale and ineligible calls have no message, queue, pause or receipt side effects',async()=>{
   const p=await payload();await db.query('update public.sms_contacts set opted_out=true where tenant_id=$1',[a]);let before=await snapshot();assert.equal((await invoke(p)).error.code,'CONFLICT');
   assert.match((await invoke(await payload())).error.message,/CONTACT_OPTED_OUT/);assert.deepEqual(await snapshot(),before);
   await db.query('update public.sms_contacts set opted_out=false where tenant_id=$1',[a]);
   for(const change of ["update public.sms_businesses set sending_enabled=false where tenant_id=$1","update public.sms_businesses set status='paused' where tenant_id=$1","update sms_private.providers set provisioning_state='connection_needs_review' where tenant_id=$1"]){
    await db.exec('begin');await db.query(change,[a]);before=await snapshot();assert.equal((await invoke(await payload())).error.code,'PERMISSION_DENIED');assert.deepEqual(await snapshot(),before);await db.exec('rollback');
   }
  });
  await t.test('canonical transactional reply queues one message, pauses exact thread and preserves unread/consent',async()=>{
   input=await payload();const before=await row();committed=await invoke(input);assert.equal(committed.ok,true,JSON.stringify(committed));toolOutputs[tool].parse(committed.data);
   assert.equal(committed.data.deliveryStatus,'queued');assert.equal(committed.data.previousRevision,before.revision);assert.ok(committed.data.revision>before.revision);
   const message=(await db.query('select * from public.sms_messages where id=$1',[committed.data.messageId])).rows[0];assert.equal(message.conversation_id,cid);assert.equal(message.tenant_id,a);assert.equal(message.contact_phone,'+17208429167');assert.equal(message.body,'PRIVATE OUTBOUND REPLY');assert.equal(message.meta.purpose,'transactional');assert.equal(message.status,'queued');assert.equal(message.provider_accepted_at,null);
   const job=(await db.query('select * from sms_private.jobs where id=$1',[committed.data.jobId])).rows[0];assert.equal(job.status,'queued');assert.equal(job.queue,'sms_send_jobs');assert.match(job.dedupe_key,/^mcp-reply:/);assert.equal(job.payload.request.purpose,'transactional');
   assert.equal((await row()).ai_paused,true);assert.equal((await db.query('select ai_paused from public.sms_conversations where id=$1',[foreign])).rows[0].ai_paused,false);
   assert.equal((await db.query('select read_at from public.sms_messages where id=$1',[inbound])).rows[0].read_at,null);
   const contact=(await db.query('select opted_out,marketing_consent from public.sms_contacts where tenant_id=$1',[a])).rows[0];assert.deepEqual(contact,{opted_out:false,marketing_consent:false});
  });
  await t.test('lost-response retries replay original receipt; changed body or revision conflicts',async()=>{
   const before=await snapshot(),retry=await invoke(input);assert.deepEqual(retry.data,committed.data);
   for(const patch of [{body:'Different reply'},{revision:(await row()).revision}])assert.equal((await invoke({...input,...patch})).error.code,'CONFLICT');assert.deepEqual(await snapshot(),before);
   await db.query('update public.sms_contacts set opted_out=true where tenant_id=$1',[a]);const opted=await snapshot();assert.deepEqual((await invoke(input)).data,committed.data);assert.deepEqual(await snapshot(),opted);
   await db.query('update public.sms_contacts set opted_out=false where tenant_id=$1',[a]);
  });
  await t.test('receipt failure and audit failure roll back message, job, AI and revision together',async()=>{
   for(const table of ['mcp_requests','mcp_activity']){
    await db.query('update public.sms_conversations set ai_paused=false where id=$1',[cid]);const p=await payload(),before=await snapshot();
    await db.exec(`create function sms_private.test_reply_failure() returns trigger language plpgsql as $$begin raise exception 'Synthetic failure' using errcode='XX000';end$$;create trigger test_reply_failure before insert on sms_private.${table} for each row execute function sms_private.test_reply_failure();`);
    if(table==='mcp_requests')assert.equal((await invoke(p)).error.code,'TEMPORARY_FAILURE');else await assert.rejects(()=>invoke(p),e=>e.code==='XX000');
    assert.deepEqual(await snapshot(),before);await db.exec(`drop trigger test_reply_failure on sms_private.${table};drop function sms_private.test_reply_failure();`);
    assert.equal((await invoke(p)).ok,true);
   }
  });
  await t.test('independent OAuth connections cannot collide in the canonical outbox retry namespace',async()=>{
   const client2=client+'/other',id=(await invoke({},'crm_get_access','staff',client2)).data.connectionId;
   await call(db,'mcp_admin','staff','save',{connectionId:id,revision:0,status:'active',permissions:['conversation_reply'],businessIds:[a],allBusinesses:false});
   const p={...await payload(),idempotencyKey:input.idempotencyKey};const other=await invoke(p,tool,'staff',client2);assert.equal(other.ok,true);assert.notEqual(other.data.messageId,committed.data.messageId);
  });
  await t.test('group reply targets the explicit thread and leaves the same contact general thread alone',async()=>{
   await db.query("insert into public.sms_automation_groups(tenant_id,id,name,rule) values($1,'reply-group','Synthetic group','{\"anchor\":\"enrollment\",\"firstDelayCount\":0,\"firstDelayUnit\":\"day\",\"intervalCount\":1,\"intervalUnit\":\"day\",\"repeatCount\":1,\"leadHours\":null,\"startHour\":0,\"endHour\":24}')",[a]);
   const group=await call(db,'ensure_conversation',a,'+17208429167','reply-group');await db.query('update public.sms_conversations set ai_paused=false where id=$1',[cid]);const before=await row();
   const r=await invoke({...await payload(),conversationId:group,revision:1});assert.equal(r.ok,true,JSON.stringify(r));
   const message=(await db.query('select conversation_id,category_id from public.sms_messages where id=$1',[r.data.messageId])).rows[0];assert.deepEqual(message,{conversation_id:group,category_id:'reply-group'});assert.deepEqual(await row(),before);
  });
  await t.test('audits and retry receipts contain IDs/revisions, not text, phone or credentials; helper stays private',async()=>{
   const audit=(await db.query('select * from sms_private.mcp_activity where request_id=$1',[committed.requestId])).rows[0];assert.equal(audit.actor_id,admin);assert.equal(audit.target,cid);assert.equal(audit.previous_revision,input.revision);assert.equal(audit.revision,committed.data.revision);assert.deepEqual(audit.affected_message_ids,[committed.data.messageId]);assert.equal(audit.affected_message_count,1);
   const records=JSON.stringify((await db.query('select to_jsonb(a) value from sms_private.mcp_activity a')).rows)+JSON.stringify((await db.query('select to_jsonb(r) value from sms_private.mcp_requests r')).rows);assert.doesNotMatch(records,/PRIVATE OUTBOUND|PRIVATE INBOUND|17208429167|SYNTHETIC SECRET/);
   for(const role of ['anon','authenticated','service_role','crm_mcp','sms_api','sms_sender','sms_webhook','sms_ai','sms_automation']){await db.exec(`set role ${role}`);await assert.rejects(()=>db.query('select sms_private.mcp_conversation_reply($1,$2,$3,$4)',['staff',a,JSON.stringify(input),connectionId]),/permission denied/);await db.exec('reset role');}
   assert.equal(Number((await db.query('select count(*) n from sms_private.attempts')).rows[0].n),0);assert.equal(Number((await db.query('select count(*) n from sms_private.form_runs')).rows[0].n),0);
  });
  await t.test('scope, permission, staff suspension and revocation gate even receipt replays',async()=>{
   await grant([]);assert.equal((await invoke(input)).error.code,'PERMISSION_DENIED');await grant(undefined,[b]);assert.equal((await invoke(input)).error.code,'PERMISSION_DENIED');await grant();
   await db.query("update public.dashboard_accounts set status='suspended' where id=$1",[admin]);assert.equal((await invoke(input)).error.code,'PERMISSION_DENIED');await db.query("update public.dashboard_accounts set status='active' where id=$1",[admin]);
   await grant(undefined,[a],'revoked');assert.equal((await invoke(input)).error.code,'PERMISSION_DENIED');
  });
 }finally{await db.close();}
});
