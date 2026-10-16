import test from 'node:test';
import assert from 'node:assert/strict';
import {z} from 'zod';
import {fixture} from './helpers/twilioConnections.js';
import {call} from './helpers/database.js';
import {conversationTools} from '../src/mcp/conversationSchemas.js';
import {toolDefinitions,toolOutputs} from '../src/mcp/tools.js';
import {connectionPermissionNames} from '../public/mcpPermissions.js';
const migration='20261016174527_crm_mcp_conversation_reads.sql',oldId='00000000-0000-4000-8000-000000000098';
test('conversation schemas require explicit IDs, typed options, bounded pages and reject mutations',()=>{
 for(const [name,,shape] of conversationTools){
  const schema=z.object(shape).strict(),detail=name==='crm_get_conversation',p={businessId:'a',...(detail?{conversationId:crypto.randomUUID()}: {})};
  assert.ok(schema.safeParse(p).success);assert.equal(toolDefinitions.find(x=>x[0]===name)[3],undefined);
  for(const patch of [{businessId:''},{businessId:' '},{businessId:42},{businessId:'x'.repeat(256)},{tenantId:'b'},{actor:'x'},{markRead:true},{idempotencyKey:'unused'},{phone:'+17208429167'}])assert.equal(schema.safeParse({...p,...patch}).success,false);
  for(const patch of detail?[{conversationId:'bad'},{includeMessages:'true'},{includeMessages:null},{messagePage:0},{messagePage:100001},{messagePageSize:101},{messagePageSize:1.2},{messagePage:'1'}]:[{contactId:'bad'},{page:0},{page:100001},{pageSize:101},{pageSize:'1'},{q:'x'.repeat(101)},{unreadOnly:'true'},{includeMessages:true}])assert.equal(schema.safeParse({...p,...patch}).success,false);
 }
});
test('conversation MCP reads isolate metadata and content grants, related records and read state',async t=>{
 const {db,business,admin}=await fixture({beforeMigration:async(db,file)=>{
  if(file===migration)await db.query("insert into sms_private.mcp_connections(id,issuer,subject,account_id,client_id,status,permissions,all_businesses) values($1,'legacy','legacy',$1,'legacy','active',array['read'],true)",[oldId]);
 }});
 try{
  assert.deepEqual((await db.query('select permissions from sms_private.mcp_connections where id=$1',[oldId])).rows[0].permissions,['read']);
  const a=(await business('a')).tenant,b=(await business('b')).tenant;
  for(const tenantId of [a,b])await call(db,'platform_action','staff','service_add',{tenantId,kind:'sms'});
  const make=async(tenant,name)=>{
   const contact=(await db.query("insert into public.sms_contacts(tenant_id,phone,name,metadata) values($1,'+17208429167',$2,'{\"secret\":\"private-contact-meta\"}') returning id",[tenant,name])).rows[0].id;
   await db.query("insert into public.sms_automation_groups(tenant_id,id,name,rule) values($1,'group-a','Group A','{\"anchor\":\"enrollment\",\"firstDelayCount\":0,\"firstDelayUnit\":\"day\",\"intervalCount\":1,\"intervalUnit\":\"day\",\"repeatCount\":1,\"leadHours\":null,\"startHour\":0,\"endHour\":24}'),($1,'group-empty','Empty group','{\"anchor\":\"enrollment\",\"firstDelayCount\":0,\"firstDelayUnit\":\"day\",\"intervalCount\":1,\"intervalUnit\":\"day\",\"repeatCount\":1,\"leadHours\":null,\"startHour\":0,\"endHour\":24}')",[tenant]);
   const general=await call(db,'ensure_conversation',tenant,'+17208429167',null),group=await call(db,'ensure_conversation',tenant,'+17208429167','group-a'),empty=await call(db,'ensure_conversation',tenant,'+17208429167','group-empty');
   const message=async(cid,direction,body,status,category,when,readAt=null)=>(await db.query("insert into public.sms_messages(tenant_id,contact_phone,conversation_id,direction,body,status,category_id,created_at,read_at,meta,error_code,sid) values($1,'+17208429167',$2,$3,$4,$5,$6,$7,$8,'{\"secret\":\"private-message-meta\"}','private-error',$9) returning id",[tenant,cid,direction,body,status,category,when,readAt,crypto.randomUUID()])).rows[0].id;
   const inbound=await message(general,'inbound',name+' private reply','received',null,'2026-01-01T10:00:00Z');
   const outbound=await message(general,'outbound',name+' accepted text','accepted',null,'2026-01-01T11:00:00Z');
   await db.query("update public.sms_messages set provider_accepted_at='2026-01-01T11:00:00Z' where id=$1",[outbound]);
   const groupMessage=await message(group,'inbound',name+' group-only text','received',null,'2026-01-02T10:00:00Z','2026-01-02T10:01:00Z');
   return {contact,general,group,empty,inbound,outbound,groupMessage};
  };
  const ra=await make(a,'Alpha'),rb=await make(b,'Foreign');
  const invoke=async(tool,p={},user='staff')=>{const r=(await db.query('select crm_mcp.invoke($1,$2,$3,$4,$5) r',[user,'https://client.example.test/conversations.json',tool,JSON.stringify(p),crypto.randomUUID()])).rows[0].r;if(r.ok)toolOutputs[tool].parse(r.data);return r;};
  const connectionId=(await invoke('crm_get_access')).data.connectionId;let revision=0;
  const grant=async(permissions,{status='active',businessIds=[a],allBusinesses=false}={})=>{const r=await call(db,'mcp_admin','staff','save',{connectionId,revision,status,permissions,businessIds,allBusinesses});revision=r.connection.revision;};
  const list=(p={})=>invoke('crm_list_conversations',{businessId:a,...p}),detail=(p={})=>invoke('crm_get_conversation',{businessId:a,conversationId:ra.general,...p});
  const snapshot=async()=>{const result={};for(const table of ['public.sms_contacts','public.sms_conversations','public.sms_thread_contacts','public.sms_messages','public.sms_automation_groups','sms_private.jobs','sms_private.form_runs','sms_private.mcp_requests','sms_private.activity_events','public.dashboard_cache_versions','pgmq.test_messages','net.test_requests'])result[table]=(await db.query(`select coalesce(jsonb_agg(to_jsonb(x) order by to_jsonb(x)::text),'[]') v from ${table} x`)).rows[0].v;return result;};
  const before=await snapshot();
  await t.test('new grants are opt-in; content requires both grants and explicit request',async()=>{
   assert.equal((await list()).error.code,'PERMISSION_DENIED');
   await grant(connectionPermissionNames.filter(x=>!x.startsWith('conversation_')));assert.equal((await list()).error.code,'PERMISSION_DENIED');assert.equal((await detail({includeMessages:true})).error.code,'PERMISSION_DENIED');
   await grant(['conversation_messages_read']);assert.equal((await detail({includeMessages:true})).error.code,'PERMISSION_DENIED');
   await grant(['conversation_read']);const d=(await detail()).data;assert.equal(d.messages,null);assert.equal(d.conversation.messageCount,2);assert.equal(d.conversation.unreadCount,1);
   assert.equal((await detail({includeMessages:true})).error.code,'PERMISSION_DENIED');
   assert.doesNotMatch(JSON.stringify(d),/private reply|accepted text|group-only|private-contact-meta|private-message-meta|private-error|"body"/);
   await grant(['conversation_read','conversation_messages_read']);assert.equal((await detail()).data.messages,null);assert.equal((await detail({includeMessages:true})).data.messages.total,2);
   assert.equal((await invoke('crm_pause_sms_run',{businessId:a})).error.code,'PERMISSION_DENIED');
  });
  await t.test('scope and filters apply before counts, unread totals, search and pagination',async()=>{
   const l=(await list()).data;assert.equal(l.total,2);assert.equal(l.unreadTotal,1);assert.equal(l.conversations[0].id,ra.group);assert.equal(l.conversations[1].id,ra.general);
   const p1=(await list({pageSize:1})).data,p2=(await list({pageSize:1,page:2})).data;assert.equal(p1.total,2);assert.equal(p2.total,2);assert.notEqual(p1.conversations[0].id,p2.conversations[0].id);
   assert.equal((await list({unreadOnly:true})).data.total,1);assert.equal((await list({unreadOnly:true})).data.conversations[0].id,ra.general);
   for(const q of ['Foreign','private reply','accepted text','%','_']){const x=(await list({q})).data;assert.equal(x.total,0);assert.equal(x.unreadTotal,0);}
   assert.equal((await list({q:'alpha'})).data.total,2);assert.equal((await list({contactId:rb.contact})).data.total,0);assert.equal((await list({contactId:ra.contact})).data.total,2);
   assert.equal((await list({page:100000})).data.conversations.length,0);
   assert.equal((await detail({conversationId:rb.general})).error.code,'PERMISSION_DENIED');assert.deepEqual((await detail({conversationId:rb.general})).error,(await detail({conversationId:crypto.randomUUID()})).error);
   assert.equal((await detail({businessId:b,conversationId:rb.general})).error.code,'PERMISSION_DENIED');
   await grant(['conversation_read','conversation_messages_read'],{allBusinesses:true,businessIds:[]});assert.equal((await list()).data.total,2);assert.equal((await detail({businessId:b,conversationId:rb.general})).data.conversation.contact.name,'Foreign');await grant(['conversation_read','conversation_messages_read']);
  });
  await t.test('message pages preserve explicit threads and accepted/read timestamps without raw internals',async()=>{
   const p1=(await detail({includeMessages:true,messagePageSize:1})).data,p2=(await detail({includeMessages:true,messagePageSize:1,messagePage:2})).data;
   assert.equal(p1.messages.rows[0].id,ra.outbound);assert.equal(p2.messages.rows[0].id,ra.inbound);assert.equal(p1.messages.order,'newest_first');assert.equal(p1.messages.total,2);
   assert.equal(p1.messages.rows[0].status,'accepted');assert.ok(p1.messages.rows[0].providerAcceptedAt);assert.equal(p2.messages.rows[0].readAt,null);
   assert.doesNotMatch(JSON.stringify(p1),/Foreign|group-only|private-contact-meta|private-message-meta|private-error|"sid"|"meta"|"error_code"/);
   const g=(await detail({conversationId:ra.group,includeMessages:true})).data;assert.equal(g.messages.total,1);assert.equal(g.messages.rows[0].id,ra.groupMessage);assert.ok(g.messages.rows[0].readAt);
   const empty=(await detail({conversationId:ra.empty,includeMessages:true})).data;assert.equal(empty.conversation.lastMessageAt,null);assert.equal(empty.messages.total,0);assert.deepEqual(empty.messages.rows,[]);
   assert.deepEqual((await detail({includeMessages:true,messagePage:100000})).data.messages.rows,[]);
  });
  await t.test('SQL gateway independently validates raw inputs; direct helper execution is denied',async()=>{
   for(const p of [{businessId:null},{businessId:2},{page:0},{page:1.1},{page:'1'},{pageSize:101},{page:100001},{q:null},{q:'x'.repeat(101)},{unreadOnly:'true'},{contactId:'bad'},{includeMessages:true},{markRead:true},{idempotencyKey:'unused'}])assert.equal((await list(p)).error.code,p.businessId!==undefined?'PERMISSION_DENIED':'VALIDATION_ERROR');
   for(const p of [{conversationId:'bad'},{conversationId:null},{includeMessages:'true'},{includeMessages:1},{messagePageSize:101},{messagePage:0},{messagePageSize:null},{messagePage:'1'},{q:'x'},{markRead:true}])assert.equal((await detail(p)).error.code,'VALIDATION_ERROR');
   for(const role of ['anon','authenticated','service_role','sms_api','crm_mcp']){await db.exec(`set role ${role}`);await assert.rejects(()=>call(db,'mcp_conversation_read','staff',a,'crm_get_conversation',{}),/permission denied/);await db.exec('reset role');}
   assert.deepEqual(await snapshot(),before);
  });
  await t.test('corrupt message relationships are excluded before counts and pages',async()=>{
   await db.query("update public.sms_messages set category_id='group-a' where id=$1",[ra.outbound]);
   const d=(await detail({includeMessages:true})).data;assert.equal(d.conversation.messageCount,1);assert.equal(d.messages.total,1);assert.deepEqual(d.messages.rows.map(x=>x.id),[ra.inbound]);
   await assert.rejects(()=>db.query('update public.sms_messages set conversation_id=$2 where id=$1',[ra.inbound,rb.general]),e=>e.code==='23503');
   await db.query('update public.sms_messages set category_id=null where id=$1',[ra.outbound]);
   await db.query('update public.sms_contacts set name=$2 where id=$1',[ra.contact,'x'.repeat(250)]);const truncated=(await detail()).data.conversation;assert.equal(truncated.contact.name.length,200);assert.equal(truncated.textTruncated,true);
   await db.query("update public.sms_contacts set name='Alpha' where id=$1",[ra.contact]);
  });
  const beforeAuth=await snapshot();
  await t.test('current scope, grant removal, suspension, realm and revocation are rechecked',async()=>{
   await grant(['conversation_read']);assert.equal((await detail({includeMessages:true})).error.code,'PERMISSION_DENIED');
   await grant(['conversation_read','conversation_messages_read'],{businessIds:[b]});assert.equal((await detail()).error.code,'PERMISSION_DENIED');
   await grant(['conversation_read','conversation_messages_read'],{status:'disabled'});assert.equal((await list()).error.code,'PERMISSION_DENIED');
   await grant(['conversation_read','conversation_messages_read']);assert.equal((await invoke('crm_get_conversation',{businessId:a,conversationId:ra.general},'reader')).error.code,'PERMISSION_DENIED');
   await db.query("update public.dashboard_accounts set status='suspended' where id=$1",[admin]);assert.equal((await detail()).error.code,'PERMISSION_DENIED');await db.query("update public.dashboard_accounts set status='active' where id=$1",[admin]);
   await db.query("select set_config('platform.actor_issuer','https://customer.example.test',false)");assert.equal((await detail()).error.code,'PERMISSION_DENIED');await db.query("select set_config('platform.actor_issuer','https://staff.example.test',false)");
   await grant(['conversation_read','conversation_messages_read'],{status:'revoked'});assert.equal((await detail()).error.code,'PERMISSION_DENIED');
  });
  await t.test('audits identify the actor and exact conversation without message/search payloads',async()=>{
   const rows=(await db.query("select * from sms_private.mcp_activity where connection_id=$1 and tool in ('crm_get_conversation','crm_list_conversations')",[connectionId])).rows;
   assert.ok(rows.some(x=>x.outcome==='denied'));const successful=rows.filter(x=>x.outcome==='success');assert.ok(successful.length>0);
   for(const x of successful){assert.equal(x.actor_id,admin);assert.ok(x.request_id);if(x.tool==='crm_get_conversation'){assert.ok([ra.general,ra.group,ra.empty,rb.general].includes(x.target));assert.ok(x.revision>=0);}}
   assert.doesNotMatch(JSON.stringify(rows),/private reply|accepted text|group-only|private-contact-meta|private-message-meta|17208429167|Foreign/);
   const after=await snapshot();delete after['public.dashboard_cache_versions'];delete beforeAuth['public.dashboard_cache_versions'];assert.deepEqual(after,beforeAuth);
  });
 }finally{await db.close();}
});
