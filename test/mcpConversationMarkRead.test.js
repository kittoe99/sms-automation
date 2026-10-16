import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './helpers/twilioConnections.js';
import {call} from './helpers/database.js';
import {toolOutputs} from '../src/mcp/tools.js';
const tool='crm_mark_conversation_messages_read';

test('selected-message mark-read is scoped, revision protected, atomic, replayable and audited',async t=>{
 const {db,business,admin}=await fixture();
 try{
  const a=(await business('mark-a')).tenant,b=(await business('mark-b')).tenant;
  for(const tenant of [a,b])await call(db,'platform_action','staff','service_add',{tenantId:tenant,kind:'sms'});
  const thread=async(tenant,phone)=>{await db.query('insert into public.sms_contacts(tenant_id,phone) values($1,$2)',[tenant,phone]);return call(db,'ensure_conversation',tenant,phone,null);};
  const cid=await thread(a,'+17208429167'),other=await thread(a,'+13035550123'),foreign=await thread(b,'+17208429167');
  const message=async(tenant,conversationId,phone='+17208429167',direction='inbound')=>(await db.query("insert into public.sms_messages(tenant_id,conversation_id,contact_phone,direction,body,status) values($1,$2,$3,$4,'PRIVATE CUSTOMER CONTENT',$5) returning id",[tenant,conversationId,phone,direction,direction==='inbound'?'received':'queued'])).rows[0].id;
  const ids=[await message(a,cid),await message(a,cid),await message(a,cid)],outbound=await message(a,cid,undefined,'outbound');
  const sameTenant=await message(a,other,'+13035550123'),foreignId=await message(b,foreign);
  // Deliberately inconsistent historical phone must not be marked or counted.
  const mismatched=await message(a,cid);await db.query('update public.sms_messages set contact_phone=$2 where id=$1',[mismatched,'+13035550123']);
  const row=async()=>(await db.query('select * from public.sms_conversations where id=$1',[cid])).rows[0];
  const snapshot=async()=>(await db.query('select to_jsonb(m) m from public.sms_messages m order by id')).rows;
  const invoke=async(p,name=tool,user='staff')=>{const requestId=crypto.randomUUID();return {...(await db.query('select crm_mcp.invoke($1,$2,$3,$4,$5) r',[user,'https://test.example/mark-read',name,JSON.stringify(p),requestId])).rows[0].r,requestId};};
  const connectionId=(await invoke({},'crm_get_access')).data.connectionId;let connectionRevision=0;
  const grant=async(permissions=['conversation_mark_read'],status='active',businessIds=[a])=>{const r=await call(db,'mcp_admin','staff','save',{connectionId,revision:connectionRevision,status,permissions,businessIds,allBusinesses:false});connectionRevision=r.connection.revision;};
  const payload=async(messageIds=ids.slice(0,1))=>({businessId:a,conversationId:cid,revision:(await row()).revision,messageIds,idempotencyKey:crypto.randomUUID()});
  const original=await snapshot(),originalConversation=await row();let committed,committedInput;
  await t.test('pending, missing permission, inactive and nonstaff calls cannot change messages',async()=>{
   assert.equal((await invoke(await payload())).error.code,'PERMISSION_DENIED');
   for(const permissions of [[],['conversation_read'],['conversation_messages_read'],['conversation_reply']]){await grant(permissions);assert.equal((await invoke(await payload())).error.code,'PERMISSION_DENIED');}
   await grant(undefined,'disabled');assert.equal((await invoke(await payload())).error.code,'PERMISSION_DENIED');await grant();
   assert.equal((await invoke(await payload(),tool,'reader')).error.code,'PERMISSION_DENIED');
   assert.deepEqual(await snapshot(),original);assert.deepEqual(await row(),originalConversation);
  });
  await t.test('SQL validates strict inputs and bounded distinct IDs before changing records',async()=>{
   const p=await payload();
   for(const patch of [{revision:0},{revision:'1'},{revision:1.5},{revision:null},{revision:Number.MAX_SAFE_INTEGER+1},{messageIds:[]},{messageIds:[ids[0],ids[0].toUpperCase()]},{messageIds:Array(101).fill(ids[0])},{messageIds:['bad']},{messageIds:[null]},{messageIds:'all'},{markAll:true},{body:'secret'},{idempotencyKey:'short'},{conversationId:'bad'}]){
    const r=await invoke({...p,...patch});assert.equal(r.error?.code,'VALIDATION_ERROR',JSON.stringify(patch));
   }
   assert.deepEqual(await snapshot(),original);
  });
  await t.test('business, thread, phone and direction substitution rejects the entire selection',async()=>{
   const p=await payload();
   for(const patch of [{businessId:b,conversationId:foreign,messageIds:[foreignId]},{conversationId:foreign},{conversationId:crypto.randomUUID()},{messageIds:[ids[0],sameTenant]},{messageIds:[ids[0],foreignId]},{messageIds:[ids[0],outbound]},{messageIds:[ids[0],mismatched]},{messageIds:[ids[0],crypto.randomUUID()]}])assert.equal((await invoke({...p,...patch})).error.code,'PERMISSION_DENIED');
   assert.deepEqual(await snapshot(),original);assert.deepEqual(await row(),originalConversation);
   assert.equal(Number((await db.query('select count(*) n from sms_private.mcp_requests')).rows[0].n),0);
  });
  await t.test('stale snapshot conflicts after worker update; selected messages only change read_at',async()=>{
   const stale=await payload();await db.query("update public.sms_messages set body='UPDATED PRIVATE CONTENT' where id=$1",[ids[2]]);
   assert.equal((await invoke(stale)).error.code,'CONFLICT');
   const before=await snapshot(),conversation=await row();committedInput=await payload([ids[0],ids[1]]);committed=await invoke(committedInput);
   assert.equal(committed.ok,true,JSON.stringify(committed));toolOutputs[tool].parse(committed.data);
   assert.deepEqual(committed.data.changedMessageIds,[ids[0],ids[1]].sort());assert.equal(committed.data.changedCount,2);assert.equal(committed.data.unreadCount,1);
   assert.equal(committed.data.previousRevision,conversation.revision);assert.ok(committed.data.revision>conversation.revision);
   const after=await row();assert.deepEqual({...after,revision:conversation.revision},conversation);
   const messages=await snapshot();for(let i=0;i<messages.length;i++){
    const old=before[i].m,current=messages[i].m;
    if([ids[0],ids[1]].includes(old.id)){assert.ok(current.read_at);assert.deepEqual({...current,read_at:old.read_at,updated_at:old.updated_at},old);}
    else assert.deepEqual(current,old);
   }
  });
  await t.test('same-key retries return original receipt, changed payload conflicts, current no-op preserves timestamps',async()=>{
   const before=await snapshot(),conversation=await row();
   const retry=await invoke(committedInput);assert.deepEqual(retry.data,committed.data);
   assert.equal((await invoke({...committedInput,messageIds:[ids[2]]})).error.code,'CONFLICT');
   assert.equal((await invoke({...committedInput,revision:conversation.revision})).error.code,'CONFLICT');
   const noop=await invoke(await payload([ids[0]]));assert.equal(noop.ok,true);assert.equal(noop.data.changedCount,0);assert.deepEqual(noop.data.changedMessageIds,[]);assert.equal(noop.data.revision,conversation.revision);
   assert.deepEqual(await snapshot(),before);assert.deepEqual(await row(),conversation);
   const audit=(await db.query('select * from sms_private.mcp_activity where request_id=$1',[retry.requestId])).rows[0];assert.equal(audit.outcome,'replayed');assert.equal(audit.revision,committed.data.revision);
  });
  await t.test('revocation and business/permission removal are checked before returning cached results',async()=>{
   await grant([]);assert.equal((await invoke(committedInput)).error.code,'PERMISSION_DENIED');
   await grant(undefined,'active',[b]);assert.equal((await invoke(committedInput)).error.code,'PERMISSION_DENIED');
   await grant(undefined,'disabled');assert.equal((await invoke(committedInput)).error.code,'PERMISSION_DENIED');await grant();
   await db.query("update public.dashboard_accounts set status='suspended' where id=$1",[admin]);assert.equal((await invoke(committedInput)).error.code,'PERMISSION_DENIED');
   await db.query("update public.dashboard_accounts set status='active' where id=$1",[admin]);
   assert.deepEqual((await invoke(committedInput)).data,committed.data);
  });
  await t.test('failed receipt insertion rolls back messages and revisions; same key can safely retry',async()=>{
   const p=await payload([ids[2]]),before=await snapshot(),conversation=await row();
   await db.exec("create function sms_private.test_receipt_failure() returns trigger language plpgsql as $$begin raise exception 'Synthetic receipt failure' using errcode='XX000'; end$$;create trigger test_receipt_failure before insert on sms_private.mcp_requests for each row execute function sms_private.test_receipt_failure();");
   const failed=await invoke(p);assert.equal(failed.error.code,'TEMPORARY_FAILURE');assert.equal(failed.error.retryable,true);assert.deepEqual(await snapshot(),before);assert.deepEqual(await row(),conversation);
   await db.exec('drop trigger test_receipt_failure on sms_private.mcp_requests;drop function sms_private.test_receipt_failure();');
   const retry=await invoke(p);assert.equal(retry.ok,true);assert.equal(retry.data.changedCount,1);assert.equal(retry.data.unreadCount,0);
  });
  await t.test('audit attributes actor, target, revisions and affected IDs without customer content; helpers are private',async()=>{
   const audit=(await db.query('select * from sms_private.mcp_activity where request_id=$1',[committed.requestId])).rows[0];
   assert.equal(audit.actor_id,admin);assert.equal(audit.connection_id,connectionId);assert.equal(audit.target,cid);assert.equal(audit.tool,tool);assert.equal(audit.outcome,'success');assert.ok(audit.created_at);
   assert.equal(audit.previous_revision,committed.data.previousRevision);assert.equal(audit.revision,committed.data.revision);assert.deepEqual(audit.affected_message_ids,committed.data.changedMessageIds);assert.equal(audit.affected_message_count,2);
   const privateRecords=JSON.stringify((await db.query('select to_jsonb(a) a from sms_private.mcp_activity a')).rows)+JSON.stringify((await db.query('select to_jsonb(r) r from sms_private.mcp_requests r')).rows);
   assert.doesNotMatch(privateRecords,/PRIVATE|17208429167|UPDATED|CUSTOMER CONTENT/);
   for(const role of ['anon','authenticated','service_role','crm_mcp','sms_api','sms_sender','sms_webhook','sms_ai','sms_automation']){
    await db.exec(`set role ${role}`);await assert.rejects(()=>db.query('select sms_private.mcp_conversation_mark_read($1,$2,$3)',['staff',a,JSON.stringify(committedInput)]),/permission denied/);await db.exec('reset role');
   }
   assert.equal(Number((await db.query("select count(*) n from sms_private.jobs where queue='sms_send_jobs'")).rows[0].n),0);
   assert.equal(Number((await db.query('select count(*) n from sms_private.form_runs')).rows[0].n),0);
   await grant(undefined,'revoked');assert.equal((await invoke(committedInput)).error.code,'PERMISSION_DENIED');
  });
 }finally{await db.close();}
});
