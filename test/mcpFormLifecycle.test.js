import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './helpers/twilioConnections.js';
import {call} from './helpers/database.js';
import {addRun} from './helpers/coordination.js';
import {toolOutputs} from '../src/mcp/tools.js';
import {formLifecycleTools,formLifecyclePermissions,formLifecycleToolPermissions} from '../src/mcp/formLifecycleSchemas.js';
test('MCP form lifecycle and presets preserve scope, revisions, atomic retries and inactive restoration',async t=>{
 const {db,business,admin}=await fixture();
 try{
  const a=(await business('lifecycle-a')).tenant,b=(await business('lifecycle-b')).tenant;
  for(const tenant of [a,b])await call(db,'platform_action','staff','service_add',{tenantId:tenant,kind:'sms'});
  const run=await addRun(db,{business:a,customer:'+17208429167'}),foreign=await addRun(db,{business:b,customer:'+17208429167'});
  const seq={trigger:'submission',leadHours:24,replyPolicy:'pause',startHour:9,endHour:17,steps:[{body:'PRIVATE PRESET {{name}}',delayCount:0,delayUnit:'minute',sendCount:1,intervalCount:1,intervalUnit:'day'}]};
  await db.query('update sms_private.form_sequences set draft=$2 where tenant_id=$1',[a,seq]);
  const invoke=async(tool,p={})=>{const requestId=crypto.randomUUID(),r=(await db.query('select crm_mcp.invoke($1,$2,$3,$4,$5) r',['staff','lifecycle-client',tool,JSON.stringify(p),requestId])).rows[0].r;if(r.ok)toolOutputs[tool].parse(r.data);return {...r,requestId};};
  const cid=(await invoke('crm_get_access')).data.connectionId;let gr=0;
  const grant=async(permissions=formLifecyclePermissions.map(x=>x[0]),businessIds=[a],status='active')=>{gr=(await call(db,'mcp_admin','staff','save',{connectionId:cid,revision:gr,status,permissions,businessIds})).connection.revision;};
  const state=async(id=run.form_id)=>(await db.query('select * from public.sms_web_form_definitions where public_id=$1',[id])).rows[0];
  const input=async(extra={})=>({businessId:a,formId:run.form_id,revision:(await state()).version,draftRevision:0,idempotencyKey:crypto.randomUUID(),...extra});
  const snapshot=async()=>{const o={};for(const table of ['public.sms_web_form_definitions','sms_private.form_sequences','sms_private.form_runs','sms_private.form_rule_presets','sms_private.mcp_form_drafts','sms_private.mcp_requests','sms_private.jobs','public.sms_messages'])o[table]=(await db.query(`select to_jsonb(x) v from ${table} x order by to_jsonb(x)::text`)).rows;return o;};
  await t.test('grants and raw schemas reject substituted IDs, unknown keys and invalid revisions without mutations',async()=>{
   for(const [name] of formLifecycleTools){await grant(formLifecyclePermissions.map(x=>x[0]).filter(x=>x!==formLifecycleToolPermissions[name]));const before=await snapshot();assert.equal((await invoke(name,{businessId:a})).error.code,'PERMISSION_DENIED',name);assert.deepEqual(await snapshot(),before);}
   await grant();
   for(const [name] of formLifecycleTools)assert.equal((await invoke(name,{businessId:a,forged:true})).error.code,'VALIDATION_ERROR',name);
   assert.equal((await invoke('crm_archive_form',await input({formId:foreign.form_id}))).error.code,'PERMISSION_DENIED');
   for(const patch of [{revision:'1'},{draftRevision:-1},{revision:1.5},{enabled:true}])assert.equal((await invoke('crm_archive_form',await input(patch))).error.code,'VALIDATION_ERROR');
  });
  let preset;
  await t.test('saved presets are immutable scoped copies; retries create exactly one and never publish',async()=>{
   const before=await snapshot();const p=await input({name:'Shared label',automationRevision:1});delete p.draftRevision;
   const r=await invoke('crm_save_sms_preset',p);assert.equal(r.ok,true,JSON.stringify(r));preset=r.data.presetId;
   assert.deepEqual((await invoke('crm_save_sms_preset',p)).data,r.data);
   assert.equal((await invoke('crm_save_sms_preset',{...p,name:'Different'})).error.code,'CONFLICT');
   const read=await invoke('crm_get_sms_preset',{businessId:a,presetId:preset});assert.deepEqual(read.data.preset.sequence,seq);
   const hidden=(await db.query('insert into sms_private.form_rule_presets(tenant_id,name,sequence) values($1,$2,$3) returning id',[b,'Foreign secret',seq])).rows[0].id;
   assert.equal((await invoke('crm_get_sms_preset',{businessId:a,presetId:hidden})).error.code,'PERMISSION_DENIED');
   const list=await invoke('crm_list_sms_presets',{businessId:a,page:1,pageSize:1});assert.equal(list.data.total,1);assert.equal(list.data.presets[0].id,preset);
   const after=await snapshot();for(const table of ['public.sms_web_form_definitions','sms_private.form_sequences','sms_private.form_runs','sms_private.jobs','public.sms_messages'])assert.deepEqual(after[table],before[table],table);
  });
  await t.test('duplication copies applied definition and draft SMS only; archived source is restored separately',async()=>{
   const before=await snapshot(),p=await input({automationRevision:1});const r=await invoke('crm_duplicate_form',p);assert.equal(r.ok,true,JSON.stringify(r));const id=r.data.formId;
   assert.notEqual(id,run.form_id);assert.equal(r.data.collectionEnabled,false);assert.equal(r.data.archived,false);assert.equal(r.data.draftRevision,1);
   assert.deepEqual((await invoke('crm_duplicate_form',p)).data,r.data);
   const copied=(await db.query('select * from sms_private.form_sequences where form_id=$1',[id])).rows[0];assert.deepEqual(copied.draft,seq);assert.equal(copied.enabled,false);assert.equal(copied.published_version,null);
   assert.equal((await db.query('select count(*) n from sms_private.form_runs where form_id=$1',[id])).rows[0].n,0);
   const after=await snapshot();assert.deepEqual(after['sms_private.form_runs'],before['sms_private.form_runs']);
   const audits=(await db.query('select * from sms_private.mcp_activity where request_id=$1',[r.requestId])).rows;assert.equal(audits.length,2);assert.ok(audits.some(x=>x.target===id));assert.ok(audits.some(x=>x.target===run.form_id));
  });
  await t.test('archive stops only associated SMS, advances shared revisions and audits; restore stays inactive',async()=>{
   const foreignBefore=(await db.query('select * from sms_private.form_runs where id=$1',[foreign.id])).rows[0];const old=await input();
   // Browser updates must invalidate a reviewed MCP version too.
   await db.query('update public.sms_web_form_definitions set title=$2 where public_id=$1',[run.form_id,'Browser change']);assert.equal((await invoke('crm_archive_form',old)).error.code,'CONFLICT');
   const emails=(await db.query(`insert into sms_private.email_enrollments(tenant_id,group_id,source_type,source_id,form_public_id,email,name,rule_snapshot,status)
    select $1,g.group_id,'contacts',gen_random_uuid(),$2,'synthetic@example.test','Synthetic',g.rule,x.status from (select * from sms_private.email_group_settings where tenant_id=$1 limit 1) g cross join (values('active'),('paused')) x(status) returning id`,[a,run.form_id])).rows;
   const p=await input(),r=await invoke('crm_archive_form',p);assert.equal(r.ok,true,JSON.stringify(r));assert.equal(r.data.archived,true);assert.equal(r.data.stoppedSmsRuns,1);assert.equal(r.data.cancelledEmailEnrollments,2);for(const e of emails)assert.equal((await db.query('select status from sms_private.email_enrollments where id=$1',[e.id])).rows[0].status,'cancelled');assert.equal(r.data.collectionEnabled,false);
   assert.deepEqual((await invoke('crm_archive_form',p)).data,r.data);
   const stopped=(await db.query('select status,next_run_at,generation from sms_private.form_runs where id=$1',[run.id])).rows[0];assert.equal(stopped.status,'stopped');assert.equal(stopped.next_run_at,null);
   assert.deepEqual((await db.query('select * from sms_private.form_runs where id=$1',[foreign.id])).rows[0],foreignBefore);
   const restored=await invoke('crm_restore_form',await input());assert.equal(restored.ok,true,JSON.stringify(restored));assert.equal(restored.data.archived,false);assert.equal(restored.data.collectionEnabled,false);
   assert.equal((await db.query('select enabled from sms_private.form_sequences where form_id=$1',[run.form_id])).rows[0].enabled,false);
   assert.deepEqual((await db.query('select status,next_run_at,generation from sms_private.form_runs where id=$1',[run.id])).rows[0],stopped);
   const audits=(await db.query('select * from sms_private.mcp_activity where request_id=$1',[r.requestId])).rows;assert.ok(audits.some(x=>x.tool==='crm_archive_form:stop_sms'&&x.target===run.id));assert.ok(audits.every(x=>x.actor_id===admin));assert.ok(!JSON.stringify(audits).includes('PRIVATE PRESET'));
  });
  await t.test('template archive uses canonical revision and never stops existing direct runs',async()=>{
   const tpl=(await call(db,'contact_automations','staff',a,'save',{name:'Synthetic template',sequence:seq,idempotencyKey:crypto.randomUUID()})).template;
   const before=await snapshot();const p={businessId:a,automationId:tpl.id,revision:tpl.revision,idempotencyKey:crypto.randomUUID()};const r=await invoke('crm_archive_sms_template',p);assert.equal(r.ok,true,JSON.stringify(r));assert.equal(r.data.archived,true);assert.deepEqual((await invoke('crm_archive_sms_template',p)).data,r.data);
   assert.deepEqual((await snapshot())['sms_private.form_runs'],before['sms_private.form_runs']);
  });
  await t.test('audit failure rolls back duplication; revoked connections cannot replay results',async()=>{
   const p=await input({automationRevision:(await db.query('select revision from sms_private.form_sequences where form_id=$1',[run.form_id])).rows[0].revision}),before=await snapshot();
   await db.exec("create function sms_private.lifecycle_audit_fail() returns trigger language plpgsql as $$begin raise exception 'audit fail' using errcode='XX000';end$$;create trigger lifecycle_audit_fail before insert on sms_private.mcp_activity for each row execute function sms_private.lifecycle_audit_fail();");
   await assert.rejects(()=>invoke('crm_duplicate_form',p));assert.deepEqual(await snapshot(),before);await db.exec('drop trigger lifecycle_audit_fail on sms_private.mcp_activity;drop function sms_private.lifecycle_audit_fail();');
   const r=await invoke('crm_duplicate_form',p);assert.equal(r.ok,true,JSON.stringify(r));await grant(undefined,[a],'revoked');assert.equal((await invoke('crm_duplicate_form',p)).error.code,'PERMISSION_DENIED');
   assert.equal((await db.query("select count(*) n from public.sms_messages where direction='outbound' or read_at is not null")).rows[0].n,0);
  });
 }finally{await db.close();}
});
