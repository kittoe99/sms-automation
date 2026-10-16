import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './helpers/twilioConnections.js';
import {call} from './helpers/database.js';
import {conversationActionInputs,conversationActionOutputs} from '../src/mcp/conversationSchemas.js';
import {toolDefinitions,toolOutputs} from '../src/mcp/tools.js';
const migration='20261016180739_crm_mcp_conversation_revisions.sql';

test('reserved conversation action contracts require explicit scope, revisions and bounded payloads',()=>{
 const base={businessId:'business-a',conversationId:crypto.randomUUID(),revision:1},ids=[crypto.randomUUID()];
 for(const [name,schema] of Object.entries(conversationActionInputs)){
  const p={...base,...(name.includes('mark_')?{messageIds:ids}:{body:' Reviewed reply '}),...(name.includes('preview')?{}:{idempotencyKey:'key-123456'})};
  assert.ok(schema.safeParse(p).success);
  assert.equal(toolDefinitions.some(t=>t[0]===name),true,'Action contracts expose implemented tools');
  for(const patch of [{businessId:''},{businessId:' '},{businessId:'x'.repeat(256)},{conversationId:'bad'},{revision:0},{revision:-1},{revision:1.5},{revision:'1'},{revision:null},{revision:Number.MAX_SAFE_INTEGER+1},{phone:'+17208429167'},{purpose:'transactional'},{markAll:true},{actor:'forged'},{generation:1},{scheduledAt:'now'}])assert.equal(schema.safeParse({...p,...patch}).success,false);
  if(name.includes('mark_'))for(const messageIds of [[],[ids[0],ids[0]],['bad'],Array.from({length:101},()=>crypto.randomUUID())])assert.equal(schema.safeParse({...p,messageIds}).success,false);
  else {for(const body of ['', '   ', 'x'.repeat(1601),null,123])assert.equal(schema.safeParse({...p,body}).success,false);assert.equal(schema.parse(p).body,'Reviewed reply');}
  if(!name.includes('preview'))for(const idempotencyKey of ['', 'short','x'.repeat(129),null])assert.equal(schema.safeParse({...p,idempotencyKey}).success,false);
 }
 const receipt={...base,previousRevision:1,revision:2,databaseStatus:'committed',messageId:ids[0],jobId:crypto.randomUUID(),deliveryStatus:'queued',aiPaused:true};
 assert.ok(conversationActionOutputs.crm_reply_to_conversation.safeParse(receipt).success);
 for(const patch of [{deliveryStatus:'delivered'},{token:'secret'},{body:'not a receipt'},{aiPaused:false},{revision:0}])assert.equal(conversationActionOutputs.crm_reply_to_conversation.safeParse({...receipt,...patch}).success,false);
 const read={...base,previousRevision:1,databaseStatus:'committed',changedMessageIds:ids,changedCount:1,unreadCount:0};
 assert.ok(conversationActionOutputs.crm_mark_conversation_messages_read.safeParse(read).success);assert.equal(conversationActionOutputs.crm_mark_conversation_messages_read.safeParse({...read,changedCount:2}).success,false);
 const preview={...base,recipientPhone:'+17208429167',body:'Test reply',estimatedSegments:1,eligible:true,blockers:[],aiWillPause:true,queued:false};
 assert.ok(conversationActionOutputs.crm_preview_conversation_reply.safeParse(preview).success);assert.equal(conversationActionOutputs.crm_preview_conversation_reply.safeParse({...preview,queued:true}).success,false);
});

test('shared conversation revisions cover CRM and worker changes without enabling MCP writes',async t=>{
 let legacy,legacyBefore;
 const {db,business}=await fixture({beforeMigration:async(db,file)=>{
  if(file!==migration)return;
  await db.exec("insert into public.sms_businesses(tenant_id,name,time_zone) values('revision-existing','Existing','UTC');insert into public.sms_contacts(tenant_id,phone) values('revision-existing','+17208429167');");
  legacy=await call(db,'ensure_conversation','revision-existing','+17208429167',null);
  legacyBefore=(await db.query('select to_jsonb(c) v from public.sms_conversations c where id=$1',[legacy])).rows[0].v;
 }});
 try{
  assert.deepEqual((await db.query("select to_jsonb(c)-'revision' v from public.sms_conversations c where id=$1",[legacy])).rows[0].v,legacyBefore);
  assert.equal((await db.query('select revision from public.sms_conversations where id=$1',[legacy])).rows[0].revision,1);
  const a=(await business('a')).tenant,b=(await business('b')).tenant;
  for(const t of [a,b])await call(db,'platform_action','staff','service_add',{tenantId:t,kind:'sms'});
  const make=async tenant=>{
   const contact=(await db.query("insert into public.sms_contacts(tenant_id,phone,name) values($1,'+17208429167','Synthetic') returning id",[tenant])).rows[0].id;
   await db.query("insert into public.sms_automation_groups(tenant_id,id,name,rule) values($1,'group-a','Group A','{\"anchor\":\"enrollment\",\"firstDelayCount\":0,\"firstDelayUnit\":\"day\",\"intervalCount\":1,\"intervalUnit\":\"day\",\"repeatCount\":1,\"leadHours\":null,\"startHour\":0,\"endHour\":24}')",[tenant]);
   return {contact,general:await call(db,'ensure_conversation',tenant,'+17208429167',null),group:await call(db,'ensure_conversation',tenant,'+17208429167','group-a')};
  };
  const ra=await make(a),rb=await make(b);
  const row=async id=>(await db.query('select * from public.sms_conversations where id=$1',[id])).rows[0];
  const message=async(cid,direction='outbound')=>(await db.query("insert into public.sms_messages(tenant_id,contact_phone,conversation_id,direction,body,status) values($1,'+17208429167',$2,$3,'Synthetic message',$4) returning id",[a,cid,direction,direction==='inbound'?'received':'queued'])).rows[0].id;
  const lock=(tenant,id,expected,user='staff')=>db.query('select sms_private.lock_conversation_revision($1,$2,$3,$4::jsonb) r',[user,tenant,id,JSON.stringify(expected)]);
  const queueCount=async()=>Number((await db.query("select count(*) n from sms_private.jobs where queue='sms_send_jobs'")).rows[0].n);
  const beforeQueues=await queueCount();let mid,inbound;
  await t.test('database owns revision and no-op conversation updates do not increment it',async()=>{
   const start=await row(ra.general);assert.equal(start.revision,1);
   await db.query('update public.sms_conversations set ai_paused=ai_paused where id=$1',[ra.general]);assert.equal((await row(ra.general)).revision,1);
   await assert.rejects(()=>db.query('update public.sms_conversations set revision=revision+1 where id=$1',[ra.general]),e=>e.code==='23514');
   await db.query('update public.sms_conversations set ai_paused=true where id=$1',[ra.general]);const changed=await row(ra.general);assert.equal(changed.revision,2);assert.equal(changed.generation,start.generation);
   await assert.rejects(()=>lock(a,ra.general,1),e=>e.code==='40001');assert.equal((await lock(a,ra.general,2)).rows[0].r,2);
  });
  await t.test('worker message inserts, status, content and deletion advance revision without borrowing generation',async()=>{
   let before=await row(ra.general);mid=await message(ra.general);let after=await row(ra.general);assert.equal(after.revision,before.revision+1);assert.equal(after.generation,before.generation);
   before=after;await db.query("update public.sms_messages set status='delivered' where id=$1",[mid]);after=await row(ra.general);assert.ok(after.revision>before.revision);assert.ok(after.generation>before.generation);await assert.rejects(()=>lock(a,ra.general,before.revision),e=>e.code==='40001');
   before=after;await db.query("update public.sms_messages set body='Edited message' where id=$1",[mid]);after=await row(ra.general);assert.equal(after.revision,before.revision+1);assert.equal(after.generation,before.generation);
   before=after;await db.query('update public.sms_messages set body=body,updated_at=clock_timestamp() where id=$1',[mid]);assert.equal((await row(ra.general)).revision,before.revision);
   const temporary=await message(ra.general);before=await row(ra.general);await db.query('delete from public.sms_messages where id=$1',[temporary]);assert.equal((await row(ra.general)).revision,before.revision+1);
  });
  await t.test('canonical CRM mark-read and pause actions invalidate snapshots; read no-ops retain revision',async()=>{
   inbound=await message(ra.general,'inbound');let before=await row(ra.general);
   await call(db,'conversation_action','staff',a,ra.general,'read',{});let after=await row(ra.general);assert.equal(after.revision,before.revision+1);assert.equal(after.generation,before.generation);
   const readAt=(await db.query('select read_at from public.sms_messages where id=$1',[inbound])).rows[0].read_at;
   await call(db,'conversation_action','staff',a,ra.general,'read',{});assert.equal((await row(ra.general)).revision,after.revision);assert.deepEqual((await db.query('select read_at from public.sms_messages where id=$1',[inbound])).rows[0].read_at,readAt);
   await assert.rejects(()=>lock(a,ra.general,before.revision),e=>e.code==='40001');before=after;await call(db,'conversation_action','staff',a,ra.general,'pause',{});assert.ok((await row(ra.general)).revision>before.revision);
  });
  await t.test('reassignments touch both threads; contacts and groups remain business scoped',async()=>{
   const foreign=await row(rb.general),foreignGroup=await row(rb.group),beforeA=await row(ra.general),beforeGroup=await row(ra.group);
   await db.query('update public.sms_messages set conversation_id=$2 where id=$1',[inbound,ra.group]);assert.ok((await row(ra.general)).revision>beforeA.revision);assert.ok((await row(ra.group)).revision>beforeGroup.revision);
   await assert.rejects(()=>db.query('update public.sms_messages set conversation_id=$2 where id=$1',[inbound,rb.general]),e=>e.code==='23503');
   let general=await row(ra.general),group=await row(ra.group);
   await db.query("update public.sms_contacts set name='Updated',opted_out=true where id=$1",[ra.contact]);assert.equal((await row(ra.general)).revision,general.revision+1);assert.equal((await row(ra.group)).revision,group.revision+1);
   general=await row(ra.general);group=await row(ra.group);await db.query("update public.sms_automation_groups set name='Renamed' where tenant_id=$1 and id='group-a'",[a]);assert.equal((await row(ra.general)).revision,general.revision);assert.equal((await row(ra.group)).revision,group.revision+1);
   assert.deepEqual(await row(rb.general),foreign);assert.deepEqual(await row(rb.group),foreignGroup);
   await assert.rejects(()=>lock(a,rb.general,foreign.revision),e=>e.code==='42501');await assert.rejects(()=>lock(a,crypto.randomUUID(),1),e=>e.code==='42501');
  });
  await t.test('revision helper rejects malformed versions, unauthorized identities and direct application execution',async()=>{
   for(const expected of [null,'1',0,-1,1.5,Number.MAX_SAFE_INTEGER+1,{},true])await assert.rejects(()=>lock(a,ra.general,expected),e=>e.code==='22023');
   await assert.rejects(()=>lock(a,ra.general,1,'reader'),e=>e.code==='42501');
   for(const role of ['anon','authenticated','service_role','sms_api','crm_mcp','sms_sender','sms_ai']){await db.exec(`set role ${role}`);await assert.rejects(()=>lock(a,ra.general,1),/permission denied/);await db.exec('reset role');}
  });
  await t.test('action grants remain independent and do not imply reads or reserved reply tools',async()=>{
   const invoke=async(tool,p={})=>{const requestId=crypto.randomUUID();return {...(await db.query('select crm_mcp.invoke($1,$2,$3,$4,$5) r',['staff','https://test.example/revisions',tool,JSON.stringify(p),requestId])).rows[0].r,requestId};};
   const id=(await invoke('crm_get_access')).data.connectionId;let revision=0;
   const grant=async permissions=>{const r=await call(db,'mcp_admin','staff','save',{connectionId:id,revision,status:'active',permissions,businessIds:[a],allBusinesses:false});revision=r.connection.revision;};
   for(const permission of ['conversation_reply','conversation_mark_read']){
    await grant([permission]);assert.deepEqual((await invoke('crm_get_access')).data.permissions,[permission]);
    for(const tool of ['crm_list_conversations','crm_get_conversation',])assert.equal((await invoke(tool,{businessId:a,conversationId:ra.general,revision:1,body:'Do not send',messageIds:[inbound],idempotencyKey:'reserved-test'})).error.code,'PERMISSION_DENIED');
   }
   await grant(['conversation_read']);const expected=await row(ra.general),detail=await invoke('crm_get_conversation',{businessId:a,conversationId:ra.general});assert.equal(detail.ok,true);toolOutputs.crm_get_conversation.parse(detail.data);assert.equal(detail.data.conversation.revision,expected.revision);assert.equal(detail.data.messages,null);
   const audit=(await db.query('select revision from sms_private.mcp_activity where request_id=$1',[detail.requestId])).rows[0];assert.equal(audit.revision,expected.revision);
   const list=await invoke('crm_list_conversations',{businessId:a});toolOutputs.crm_list_conversations.parse(list.data);assert.equal(list.data.conversations.find(x=>x.id===ra.general).revision,expected.revision);
   const crm=await call(db,'conversation_detail','staff',a,ra.general);assert.equal(crm.revision,expected.revision);const inbox=await call(db,'list_conversation_threads','staff',a,{});assert.equal(inbox.rows.find(x=>x.id===ra.general).revision,expected.revision);
   assert.deepEqual(await row(ra.general),expected);assert.equal(await queueCount(),beforeQueues);
  });
 }finally{await db.close();}
});
