import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './helpers/twilioConnections.js';
import {call} from './helpers/database.js';
import {estimateSmsSegments} from '../src/workers/sms.js';
import {toolOutputs,toolDefinitions} from '../src/mcp/tools.js';
const tool='crm_preview_conversation_reply';

test('conversation reply preview isolates scope, rechecks eligibility and never changes conversation or send state',async t=>{
 const {db,business,admin}=await fixture();
 try{
  const a=(await business('preview-a')).tenant,b=(await business('preview-b')).tenant;
  for(const tenant of [a,b])await call(db,'platform_action','staff','service_add',{tenantId:tenant,kind:'sms'});
  const thread=async tenant=>{await db.query("insert into public.sms_contacts(tenant_id,phone,name,marketing_consent) values($1,'+17208429167','Synthetic',false)",[tenant]);return call(db,'ensure_conversation',tenant,'+17208429167',null);};
  const cid=await thread(a),foreign=await thread(b);
  await db.query("insert into public.sms_messages(tenant_id,contact_phone,conversation_id,direction,body,status) values($1,'+17208429167',$2,'inbound','UNREAD CUSTOMER CONTENT','received')",[a,cid]);
  const rev=async()=>(await db.query('select revision from public.sms_conversations where id=$1',[cid])).rows[0].revision;
  const input=async()=>({businessId:a,conversationId:cid,revision:await rev(),body:'  PRIVATE DRAFT REPLY  '});
  const invoke=async(p,name=tool,user='staff')=>{const requestId=crypto.randomUUID();return {...(await db.query('select crm_mcp.invoke($1,$2,$3,$4,$5) r',[user,'https://test.example/reply-preview',name,JSON.stringify(p),requestId])).rows[0].r,requestId};};
  const connectionId=(await invoke({},'crm_get_access')).data.connectionId;let grantRevision=0;
  const grant=async(permissions=['conversation_reply'],businessIds=[a],status='active')=>{const r=await call(db,'mcp_admin','staff','save',{connectionId,revision:grantRevision,status,permissions,businessIds,allBusinesses:false});grantRevision=r.connection.revision;};
  const snapshot=async()=>{
   const result={};for(const table of ['public.sms_contacts','public.sms_messages','public.sms_conversations','public.sms_thread_contacts','public.sms_consent_events','sms_private.form_runs','sms_private.inbound_ai_runs','sms_private.jobs','sms_private.attempts','sms_private.providers','sms_private.mcp_requests'])result[table]=(await db.query(`select to_jsonb(x) value from ${table} x order by to_jsonb(x)::text`)).rows;
   return result;
  };
  await t.test('reply grant is independent; pending/read/mark-read grants cannot preview or send',async()=>{
   const before=await snapshot();assert.equal((await invoke(await input())).error.code,'PERMISSION_DENIED');
   for(const perms of [[],['conversation_read','conversation_messages_read'],['conversation_mark_read']]){await grant(perms);assert.equal((await invoke(await input())).error.code,'PERMISSION_DENIED');}
   await grant();assert.equal((await invoke(await input())).ok,true);
   assert.equal((await invoke({businessId:a,conversationId:cid},'crm_get_conversation')).error.code,'PERMISSION_DENIED');
   assert.equal((await invoke({...await input(),idempotencyKey:'do-not-send'},'crm_reply_to_conversation')).error.code,'PERMISSION_DENIED');
   assert.equal(toolDefinitions.some(x=>x[0]==='crm_reply_to_conversation'),true);assert.deepEqual(await snapshot(),before);
  });
  await t.test('strict raw inputs and tenant/thread substitution fail without leaking content',async()=>{
   const p=await input();const before=await snapshot();
   for(const patch of [{body:''},{body:' \n\t '},{body:null},{body:4},{body:'x'.repeat(1601)},{body:'🙂'.repeat(801)},{revision:'1'},{revision:0},{revision:1.5},{revision:null},{revision:Number.MAX_SAFE_INTEGER+1},{phone:'+13035550123'},{purpose:'marketing'},{idempotencyKey:'not-needed'},{actor:'forged'},{conversationId:'bad'}])assert.equal((await invoke({...p,...patch})).error?.code,'VALIDATION_ERROR',JSON.stringify(patch));
   for(const patch of [{businessId:b,conversationId:foreign},{conversationId:foreign},{conversationId:crypto.randomUUID()}])assert.equal((await invoke({...p,...patch})).error.code,'PERMISSION_DENIED');
   assert.deepEqual(await snapshot(),before);
  });
  await t.test('opt-out, inactive business, sending switch and sender metadata are checked separately',async()=>{
   let r=await invoke(await input());assert.deepEqual(r.data.blockers,['BUSINESS_SENDING_DISABLED','SENDER_NOT_READY']);assert.equal(r.data.eligible,false);
   await db.query("update public.sms_businesses set status='active',sending_enabled=true where tenant_id=$1",[a]);
   await db.query("update sms_private.providers set provisioning_state='configured',account_sid='AC'||repeat('1',32),from_number='+18775550180',auth_secret_id=vault.create_secret('SYNTHETIC SECRET') where tenant_id=$1",[a]);
   await db.query('insert into vault.secrets(id) select auth_secret_id from sms_private.providers where tenant_id=$1',[a]);
   r=await invoke(await input());assert.equal(r.data.eligible,true,JSON.stringify(r));assert.deepEqual(r.data.blockers,[]);assert.equal(r.data.recipientPhone,'+17208429167');assert.equal(r.data.body,'PRIVATE DRAFT REPLY');assert.equal(r.data.aiWillPause,true);assert.equal(r.data.queued,false);toolOutputs[tool].parse(r.data);
   // Marketing consent remains false: the existing staff reply is transactional.
   await db.query('update public.sms_contacts set opted_out=true where tenant_id=$1',[a]);r=await invoke(await input());assert.deepEqual(r.data.blockers,['CONTACT_OPTED_OUT']);
   await db.query("update public.sms_businesses set status='paused' where tenant_id=$1",[a]);r=await invoke(await input());assert.deepEqual(r.data.blockers,['CONTACT_OPTED_OUT','BUSINESS_SENDING_DISABLED']);
   await db.query('update public.sms_contacts set opted_out=false where tenant_id=$1',[a]);await db.query("update public.sms_businesses set status='active' where tenant_id=$1",[a]);
   for(const column of ['auth_secret_id','account_sid','from_number']){
    await db.exec('begin');await db.query(`update sms_private.providers set ${column}=null${column==='auth_secret_id'?',account_sid=null':''} where tenant_id=$1`,[a]);assert.ok((await invoke(await input())).data.blockers.includes('SENDER_NOT_READY'));await db.exec('rollback');
   }
   await db.exec('begin');await db.query("update sms_private.providers set provisioning_state='connection_needs_review' where tenant_id=$1",[a]);assert.ok((await invoke(await input())).data.blockers.includes('SENDER_NOT_READY'));await db.exec('rollback');
   await db.query('update public.sms_conversations set ai_paused=true where id=$1',[cid]);assert.equal((await invoke(await input())).data.aiWillPause,false);
  });
  await t.test('shared revisions reject changed contacts/messages; eligibility is fresh even with unchanged revision',async()=>{
   let p=await input();await db.query("update public.sms_contacts set name='New name' where tenant_id=$1",[a]);assert.equal((await invoke(p)).error.code,'CONFLICT');
   p=await input();await db.query("update public.sms_messages set body='EDITED UNREAD CONTENT' where conversation_id=$1",[cid]);assert.equal((await invoke(p)).error.code,'CONFLICT');
   p=await input();assert.equal((await invoke(p)).data.eligible,true);await db.query('update public.sms_businesses set sending_enabled=false where tenant_id=$1',[a]);assert.equal(await rev(),p.revision);assert.ok((await invoke(p)).data.blockers.includes('BUSINESS_SENDING_DISABLED'));
   await db.query('update public.sms_businesses set sending_enabled=true where tenant_id=$1',[a]);
  });
  await t.test('segment estimates match worker for GSM, extension characters and Unicode',async()=>{
   const p=await input(),before=await snapshot();
   assert.equal((await invoke({...p,body:'\uFEFF\u00a0Hi\n\t'})).data.body,'Hi');
   for(const body of ['Hello','x'.repeat(160),'x'.repeat(161),'^'.repeat(80),'^'.repeat(81),'{}[]\\~|€','🙂'.repeat(35),'🙂'.repeat(36),'漢'.repeat(71),'🙂'.repeat(800),'x'.repeat(1600)]){
    const r=await invoke({...p,body});assert.equal(r.ok,true,JSON.stringify(r));assert.equal(r.data.estimatedSegments,estimateSmsSegments(body));toolOutputs[tool].parse(r.data);
   }
   assert.deepEqual(await snapshot(),before);
  });
  await t.test('preview repeats leave domain state untouched and audit only target/revision, never body or credentials',async()=>{
   const before=await snapshot(),p=await input(),r=await invoke(p),again=await invoke(p);assert.deepEqual(r.data,again.data);assert.deepEqual(await snapshot(),before);
   const audit=(await db.query('select * from sms_private.mcp_activity where request_id=$1',[r.requestId])).rows[0];assert.equal(audit.actor_id,admin);assert.equal(audit.connection_id,connectionId);assert.equal(audit.target,cid);assert.equal(audit.revision,p.revision);assert.equal(audit.outcome,'success');
   const serialized=JSON.stringify((await db.query('select to_jsonb(a) a from sms_private.mcp_activity a')).rows);assert.doesNotMatch(serialized,/PRIVATE DRAFT|UNREAD CONTENT|17208429167|SYNTHETIC SECRET/);
   for(const role of ['anon','authenticated','service_role','crm_mcp','sms_api','sms_sender','sms_webhook','sms_ai','sms_automation']){await db.exec(`set role ${role}`);await assert.rejects(()=>db.query('select sms_private.mcp_conversation_reply_preview($1,$2,$3)',['staff',a,JSON.stringify(p)]),/permission denied/);await db.exec('reset role');}
  });
  await t.test('permission/scope removal, suspension and revocation immediately deny new previews',async()=>{
   const p=await input();await grant([]);assert.equal((await invoke(p)).error.code,'PERMISSION_DENIED');await grant(undefined,[b]);assert.equal((await invoke(p)).error.code,'PERMISSION_DENIED');await grant();
   assert.equal((await invoke(p,tool,'reader')).error.code,'PERMISSION_DENIED');await db.query("update public.dashboard_accounts set status='suspended' where id=$1",[admin]);assert.equal((await invoke(p)).error.code,'PERMISSION_DENIED');await db.query("update public.dashboard_accounts set status='active' where id=$1",[admin]);
   await grant(undefined,[a],'revoked');assert.equal((await invoke(p)).error.code,'PERMISSION_DENIED');
  });
 }finally{await db.close();}
});
