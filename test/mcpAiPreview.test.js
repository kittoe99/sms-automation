import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './helpers/twilioConnections.js';
import {call} from './helpers/database.js';
import {aiPreviewInput,aiPreviewOutputs} from '../src/mcp/aiPreviewSchemas.js';
import {withAiReplyPreview} from '../src/mcp/aiReplyPreview.js';
const client='preview-test',tool='crm_preview_ai_reply',identity={subject:'staff',clientId:client};
const response=(reply='For an accurate junk removal quote, call the saved business number.')=>new Response(JSON.stringify({status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify({reply,citationIds:[]})}]}]}));

test('AI preview strict schemas reject customer references, forged context and send controls',()=>{
 const p={businessId:'a',message:'Quote?',businessRevision:1,settingsRevision:0,profileVersionId:crypto.randomUUID()};
 assert.ok(aiPreviewInput.safeParse(p).success);
 for(const patch of [{businessId:' '},{message:' '},{message:'x'.repeat(4001)},{businessRevision:-1},{businessRevision:'1'},{settingsRevision:0.1},{profileVersionId:'bad'},{contactId:crypto.randomUUID()},{conversationId:crypto.randomUUID()},{history:[]},{profile:{}},{apiKey:'secret'},{send:true},{idempotencyKey:'retry'}])assert.equal(aiPreviewInput.safeParse({...p,...patch}).success,false,JSON.stringify(patch));
 for(const key of Object.keys(p)){const copy={...p};delete copy[key];assert.equal(aiPreviewInput.safeParse(copy).success,false);}
});

test('AI preview enforces scope, grants, revisions, immutable capture and no customer side effects',async t=>{
 const {db,business,admin,reader}=await fixture();
 try{
  const a=(await business('preview-a')).tenant,b=(await business('preview-b')).tenant;
  await db.query("insert into sms_private.inbound_ai_settings(tenant_id,mode,system_prompt) values($1,'off','OWN INSTRUCTIONS'),($2,'live','FOREIGN SECRET')",[a,b]);
  // Same phone in two businesses must not pull either customer's real history.
  for(const [tenant,marker] of [[a,'OWN PRIVATE HISTORY'],[b,'FOREIGN PRIVATE HISTORY']]){
   await db.query("insert into public.sms_contacts(tenant_id,phone,name) values($1,'+17208429167',$2)",[tenant,marker]);
   const conversation=await call(db,'ensure_conversation',tenant,'+17208429167',null);
   await db.query("insert into public.sms_messages(tenant_id,contact_phone,conversation_id,direction,body,status) values($1,'+17208429167',$2,'inbound',$3,'received')",[tenant,conversation,marker]);
  }
  const p={businessId:a,message:'For junk removal only, accurate couch quote?',businessRevision:1,settingsRevision:0,profileVersionId:(await db.query('select active_profile_version_id id from public.sms_businesses where tenant_id=$1',[a])).rows[0].id};
  const invoke=async(actor,name,input,id)=>(await db.query('select crm_mcp.invoke($1,$2,$3,$4,$5) r',[actor.subject,actor.clientId,name,JSON.stringify(input),id])).rows[0].r;
  const finish=async(actor,input,id,ok,hash)=>(await db.query('select crm_mcp.ai_reply_preview_finish($1,$2,$3,$4,$5,$6) r',[actor.subject,actor.clientId,JSON.stringify(input),id,ok,hash])).rows[0].r;
  const cid=(await invoke(identity,'crm_get_access',{},crypto.randomUUID())).data.connectionId;let revision=0,modelCalls=0;
  const grant=async(perms=['ai_reply_preview'],status='active')=>{revision=(await call(db,'mcp_admin','staff','save',{connectionId:cid,revision,status,permissions:perms,businessIds:[a],allBusinesses:false})).connection.revision;};
  const snapshot=async()=>{const s={};for(const table of ['public.sms_businesses','public.platform_business_setup','public.sms_business_profile_versions','sms_private.jobs','sms_private.inbound_ai_runs','sms_private.inbound_ai_profile_contexts','sms_private.inbound_ai_actions','sms_private.inbound_ai_settings','public.sms_messages','public.sms_conversations','public.sms_contacts','public.sms_handoffs','public.sms_bookings','sms_private.form_runs','sms_private.mcp_requests','public.dashboard_cache_versions','pgmq.test_messages','net.test_requests'])s[table]=(await db.query(`select coalesce(jsonb_agg(to_jsonb(x) order by to_jsonb(x)::text),'[]') v from ${table} x`)).rows[0].v;return s;};
  const make=(fetchImpl)=>withAiReplyPreview(invoke,finish,{apiKey:'TEST KEY',fetchImpl:async(...args)=>{modelCalls++;return fetchImpl(...args);}});
  const run=(adapter,input=p,actor=identity)=>adapter(actor,tool,input,crypto.randomUUID());
  const good=make(async(url,options)=>{assert.equal(url,'https://api.openai.com/v1/responses');const body=JSON.parse(options.body);assert.equal(body.store,false);assert.deepEqual(body.tools,[]);assert.equal(body.tool_choice,'none');assert.equal(body.input.length,1);assert.match(body.instructions,/OWN INSTRUCTIONS/);assert.doesNotMatch(body.instructions,/FOREIGN SECRET|OWN PRIVATE HISTORY|FOREIGN PRIVATE HISTORY/);assert.match(body.instructions,/do not estimate, substitute another service/);assert.match(body.instructions,/Never claim a booking, handoff/);return response();});
  await t.test('new connections and unrelated grants deny before the model',async()=>{
   assert.equal((await run(good)).error.code,'PERMISSION_DENIED');await grant(['read','ai_config_read','ai_reply_read']);assert.equal((await run(good)).error.code,'PERMISSION_DENIED');assert.equal(modelCalls,0);
  });
  await grant();
  await t.test('foreign businesses, foreign profiles, stale revisions and malformed raw inputs',async()=>{
   const foreignProfile=(await db.query('select active_profile_version_id id from public.sms_businesses where tenant_id=$1',[b])).rows[0].id;
   for(const patch of [{businessId:b},{businessId:'missing'},{profileVersionId:foreignProfile},{profileVersionId:crypto.randomUUID()},{businessRevision:0},{settingsRevision:1},{send:true},{message:null},{message:' '}]){const r=await invoke(identity,tool,{...p,...patch},crypto.randomUUID());assert.equal(r.ok,false);}
   assert.equal(modelCalls,0);
  });
  await t.test('preview returns actual approved version and leaves all domain snapshots unchanged',async()=>{
   const before=await snapshot(),r=await run(good);assert.equal(r.ok,true,JSON.stringify(r));aiPreviewOutputs.crm_preview_ai_reply.parse(r.data);assert.equal(r.data.profileVersionId,p.profileVersionId);assert.equal(r.data.profileVersion,1);assert.equal(r.data.messageQueued,false);assert.equal(r.data.actionsExecuted,false);assert.equal(r.data.context,undefined);assert.deepEqual(await snapshot(),before);
   const audit=(await db.query("select * from sms_private.mcp_activity where tool like 'crm_preview_ai_reply%' order by id")).rows;assert.ok(audit.some(x=>x.tool===tool+':result'&&x.target===p.profileVersionId&&Number(x.revision)===1));assert.ok(audit.every(x=>x.actor_id===admin));assert.doesNotMatch(JSON.stringify(audit),/couch|OWN INSTRUCTIONS|TEST KEY|FOREIGN SECRET|accurate junk/);
  });
  await t.test('settings edit during generation rejects stale output',async()=>{
   const r=await run(make(async()=>{await db.query('update sms_private.inbound_ai_settings set revision=revision+1 where tenant_id=$1',[a]);return response();}));assert.equal(r.error.code,'CONFLICT');p.settingsRevision++;
  });
  await t.test('profile changes during generation conflict, even without a revision bump',async()=>{
   const r=await run(make(async()=>{await db.query("update public.sms_business_profile_versions set facts=facts||'{\"summary\":\"Changed facts\"}' where id=$1",[p.profileVersionId]);return response();}));assert.equal(r.error.code,'CONFLICT');
  });
  await t.test('revocation, scope and staff suspension after generation discard output',async()=>{
   // Keep another synthetic administrator so canonical last-admin protection applies.
   await db.query('insert into public.platform_staff_grants(account_id) values($1)',[reader]);
   for(const revoke of [()=>grant([]),()=>grant(['ai_reply_preview'],'disabled'),()=>db.query('update sms_private.mcp_connections set business_ids=array[]::text[] where id=$1',[cid]),()=>db.query('delete from public.platform_staff_grants where account_id=$1',[admin])]){
    await grant();const r=await run(make(async()=>{await revoke();return response();}));assert.equal(r.error.code,'PERMISSION_DENIED');await db.query('insert into public.platform_staff_grants(account_id) values($1) on conflict do nothing',[admin]);
   }await grant();
  });
  await t.test('missing profile/settings and customer identities fail closed',async()=>{
   assert.equal((await run(good,p,{subject:'preview-a',clientId:client})).error.code,'PERMISSION_DENIED');
   await db.exec('begin');await db.query('delete from sms_private.inbound_ai_settings where tenant_id=$1',[a]);assert.equal((await run(good)).error.code,'VALIDATION_ERROR');await db.exec('rollback');
   await db.query('update public.sms_businesses set active_profile_version_id=null where tenant_id=$1',[a]);assert.equal((await run(good)).error.code,'VALIDATION_ERROR');await db.query('update public.sms_businesses set active_profile_version_id=$2 where tenant_id=$1',[a,p.profileVersionId]);
  });
  await t.test('provider errors, malformed output and forbidden tool calls are sanitized and audited',async()=>{
   const before=await snapshot();
   for(const f of [async()=>new Response('PRIVATE PROVIDER SECRET',{status:429}),async()=>{throw new TypeError('PRIVATE PROVIDER SECRET');},async()=>response('x'.repeat(601)),async()=>new Response(JSON.stringify({status:'completed',output:[{type:'function_call',name:'confirm_booking'}]})),async()=>new Response('invalid json'),async()=>new Response(JSON.stringify({status:'completed',output:[{type:'message',content:[{type:'refusal'}]}]}))]){const r=await run(make(f));assert.equal(r.error.code,'TEMPORARY_FAILURE');assert.doesNotMatch(JSON.stringify(r),/PRIVATE PROVIDER SECRET/);}
   const noKey=withAiReplyPreview(invoke,finish,{fetchImpl:()=>{throw new Error('must not call');}});assert.equal((await run(noKey)).error.code,'TEMPORARY_FAILURE');assert.deepEqual(await snapshot(),before);
   assert.ok(Number((await db.query("select count(*) n from sms_private.mcp_activity where tool='crm_preview_ai_reply:result' and code='TEMPORARY_FAILURE'")).rows[0].n)>=7);
  });
  await t.test('an interrupted final check never releases a reply or retries the model',async()=>{
   const before=await snapshot();let calls=0;const adapter=withAiReplyPreview(invoke,async()=>{throw new Error('lost database response');},{apiKey:'TEST',fetchImpl:async()=>{calls++;return response();}});assert.equal((await run(adapter)).error.code,'TEMPORARY_FAILURE');assert.equal(calls,1);assert.deepEqual(await snapshot(),before);
  });
  await t.test('revoked connections cannot preview',async()=>{await grant(['ai_reply_preview'],'revoked');const before=modelCalls;assert.equal((await run(good)).error.code,'PERMISSION_DENIED');assert.equal(modelCalls,before);});
  await t.test('private helpers cannot be executed directly by MCP or browser/worker roles',async()=>{
   for(const role of ['anon','authenticated','service_role','sms_api','sms_ai','crm_mcp'])assert.equal((await db.query("select has_function_privilege($1,'sms_private.mcp_ai_preview_context(text,text,text,jsonb,uuid)','execute') ok",[role])).rows[0].ok,false);
   for(const role of ['anon','authenticated','service_role','sms_api','sms_ai','crm_mcp'])assert.equal((await db.query("select has_function_privilege($1,'crm_mcp.ai_reply_preview_finish(text,text,jsonb,uuid,boolean,text)','execute') ok",[role])).rows[0].ok,role==='crm_mcp');
  });
 }finally{await db.close();}
});
