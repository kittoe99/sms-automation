import test from 'node:test';
import assert from 'node:assert/strict';
import {z} from 'zod';
import {fixture} from './helpers/twilioConnections.js';
import {call} from './helpers/database.js';
import {leadHandoffWriteTools} from '../src/mcp/leadHandoffSchemas.js';
import {toolOutputs,toolDefinitions} from '../src/mcp/tools.js';
const cases=[['lead','leadId','sms_leads','crm_assign_lead','lead_assign','owner'],
 ['lead','leadId','sms_leads','crm_set_lead_status','lead_status_update','status'],
 ['handoff','handoffId','sms_handoffs','crm_assign_handoff','handoff_assign','owner'],
 ['handoff','handoffId','sms_handoffs','crm_set_handoff_status','handoff_status_update','status']];
test('management write schemas require explicit scope, revision, retry key and exactly one editable field',()=>{
 for(const [,idKey,,name,,field] of cases){
  const schema=z.object(leadHandoffWriteTools.find(x=>x[0]===name)[2]).strict();
  const p={businessId:'a',[idKey]:crypto.randomUUID(),revision:1,idempotencyKey:'schema-test', [field]:field==='owner'?null:'assigned'};
  assert.ok(schema.safeParse(p).success);assert.equal(toolDefinitions.find(x=>x[0]===name)[3],true);
  for(const key of Object.keys(p)){const x={...p};delete x[key];assert.equal(schema.safeParse(x).success,false,key);}
  for(const patch of [{businessId:' '},{revision:'1'},{revision:0},{revision:1.2},{revision:Number.MAX_SAFE_INTEGER+1},{idempotencyKey:'short'},{idempotencyKey:'x'.repeat(129)},{[idKey]:'bad'},{actor:'staff'},{[field==='owner'?'status':'owner']:'assigned'},{[field]:{}},{[field]:field==='owner'?'x'.repeat(201):'won'}])assert.equal(schema.safeParse({...p,...patch}).success,false);
 }
});
test('MCP management writes enforce independent grants, CAS, retries, isolation and redacted audits',async t=>{
 const {db,admin,business}=await fixture();
 try{
  const a=(await business('a')).tenant,b=(await business('b')).tenant;
  for(const tenantId of [a,b])await call(db,'platform_action','staff','service_add',{tenantId,kind:'sms'});
  const make=async tenant=>{
   const contact=(await db.query("insert into public.sms_contacts(tenant_id,phone,name) values($1,'+17208429167','Test') returning id",[tenant])).rows[0].id;
   const lead=(await db.query("insert into public.sms_leads(tenant_id,contact_id,summary,fields) values($1,$2,'private summary','{\"private\":\"answer\"}') returning id",[tenant,contact])).rows[0].id;
   const job=(await db.query("insert into sms_private.jobs(tenant_id,queue,dedupe_key,payload) values($1,'ai_reply_jobs',$2,'{}') returning id",[tenant,crypto.randomUUID()])).rows[0].id;
   const handoff=(await db.query("insert into public.sms_handoffs(tenant_id,contact_id,lead_id,ai_job_id,reason,alert_error) values($1,$2,$3,$4,'private reason','private alert') returning id",[tenant,contact,lead,job])).rows[0].id;return {contact,lead,handoff};
  };
  const ra=await make(a),rb=await make(b),client='https://client.example.test/manage.json';
  const invoke=async(tool,p={},u='staff',requestId=crypto.randomUUID())=>{
   const r=(await db.query('select crm_mcp.invoke($1,$2,$3,$4,$5) r',[u,client,tool,JSON.stringify(p),requestId])).rows[0].r;
   if(r.ok)toolOutputs[tool].parse(r.data);return r;
  };
  const connectionId=(await invoke('crm_get_access')).data.connectionId;let connectionRevision=0;
  const grant=async(permissions,status='active',businessIds=[a])=>{const v=await call(db,'mcp_admin','staff','save',{connectionId,revision:connectionRevision,permissions,status,businessIds,allBusinesses:false});connectionRevision=v.connection.revision;};
  const row=async table=>(await db.query(`select * from public.${table} where id=$1`,[table==='sms_leads'?ra.lead:ra.handoff])).rows[0];
  const input=async c=>({businessId:a,[c[1]]:ra[c[0]],revision:(await row(c[2])).revision,idempotencyKey:crypto.randomUUID(),[c[5]]:c[5]==='owner'?'Private owner label':'assigned'});
  const snap=async()=>{const out={};for(const table of ['public.sms_contacts','public.sms_messages','sms_private.jobs','sms_private.form_runs','public.sms_web_form_definitions','public.dashboard_cache_versions','pgmq.test_messages','net.test_requests'])out[table]=(await db.query(`select coalesce(jsonb_agg(to_jsonb(x) order by to_jsonb(x)::text),'[]') v from ${table} x`)).rows[0].v;return out;};
  const baseline=await snap();
  const events=async()=>(await db.query("select coalesce(jsonb_agg(to_jsonb(x) order by id),'[]') v from sms_private.activity_events x")).rows[0].v;
  await t.test('each write grant is independent and returns no ungranted record content',async()=>{
   for(const c of cases){
    await grant([c[4]]);
    for(const other of cases.filter(x=>x!==c)){
     const before=await row(other[2]);assert.equal((await invoke(other[3],await input(other))).error.code,'PERMISSION_DENIED');assert.deepEqual(await row(other[2]),before);
    }
    const before=await row(c[2]),p=await input(c),saved=await invoke(c[3],p);assert.ok(saved.ok,JSON.stringify(saved));
    assert.equal(saved.data.previousRevision,before.revision);assert.equal(saved.data.record.revision,before.revision+1);assert.deepEqual(saved.data.changedFields,[c[5]]);
    const after=await row(c[2]);assert.equal(after[c[5]],p[c[5]]);assert.equal(after[c[5]==='owner'?'status':'owner'],before[c[5]==='owner'?'status':'owner']);
    const minimal={...after};for(const key of [c[5],'revision','updated_at'])delete minimal[key];const prior={...before};for(const key of [c[5],'revision','updated_at'])delete prior[key];assert.deepEqual(minimal,prior);
    assert.equal((await invoke(c[0]==='lead'?'crm_get_lead':'crm_get_handoff',{businessId:a,[c[1]]:ra[c[0]]})).error.code,'PERMISSION_DENIED');
    assert.doesNotMatch(JSON.stringify(saved),/Private owner|private summary|private reason|private alert|phone|fields|contact|consent/);
   }
  });
  await grant(cases.map(x=>x[4]));
  await t.test('same key replays after a later edit; changed payload or tool conflicts; no-ops and clears are explicit',async()=>{
   for(const c of cases){
    const p=await input(c);p[c[5]]=c[5]==='owner'?' Next owner ':'resolved';
    const saved=await invoke(c[3],p),after=await row(c[2]);assert.ok(saved.ok);
    // Treat the successful response as lost; replay after another writer changes the row.
    await db.query(`update public.${c[2]} set ${c[0]==='lead'?'summary':'reason'}='worker update' where id=$1`,[ra[c[0]]]);
    const changed=await row(c[2]),beforeReplay=await events();assert.deepEqual((await invoke(c[3],p)).data,saved.data);assert.deepEqual(await row(c[2]),changed);assert.deepEqual(await events(),beforeReplay);
    assert.equal((await invoke(c[3],{...p,[c[5]]:c[5]==='owner'?null:'closed'})).error.code,'CONFLICT');
    const other=cases.find(x=>x[0]===c[0]&&x!==c);assert.equal((await invoke(other[3],{...await input(other),idempotencyKey:p.idempotencyKey})).error.code,'CONFLICT');
    assert.equal((await invoke(c[3],{...p,idempotencyKey:crypto.randomUUID()})).error.code,'CONFLICT');
    const same=await invoke(c[3],{...p,revision:changed.revision,idempotencyKey:crypto.randomUUID()});assert.ok(same.ok);assert.deepEqual(same.data.changedFields,[]);assert.equal(same.data.previousRevision,same.data.record.revision);assert.deepEqual(await row(c[2]),changed);
    if(c[5]==='owner'){assert.equal(after.owner,'Next owner');const clear=await invoke(c[3],{...p,owner:null,revision:changed.revision,idempotencyKey:crypto.randomUUID()});assert.ok(clear.ok);assert.equal((await row(c[2])).owner,null);}
   }
  });
  await t.test('raw SQL gateway validates inputs and cannot substitute businesses or corrupt contact references',async()=>{
   for(const c of cases){
    const p=await input(c),before=await row(c[2]);
    for(const patch of [{revision:null},{revision:'1'},{revision:0},{revision:1.5},{revision:9007199254740992},{[c[5]]:{}},{[c[5]]:c[5]==='owner'?'x'.repeat(201):null},{[c[5]==='owner'?'status':'owner']:'assigned'},{actor:'staff'},{idempotencyKey:null}])assert.equal((await invoke(c[3],{...p,...patch})).error.code,'VALIDATION_ERROR');
    const missing={...p};delete missing[c[5]];assert.equal((await invoke(c[3],missing)).error.code,'VALIDATION_ERROR');
    const foreign=(await invoke(c[3],{...p,[c[1]]:rb[c[0]]})).error;assert.equal(foreign.code,'PERMISSION_DENIED');assert.deepEqual(foreign,(await invoke(c[3],{...p,[c[1]]:crypto.randomUUID()})).error);
    assert.equal((await invoke(c[3],{...p,businessId:b,[c[1]]:rb[c[0]]})).error.code,'PERMISSION_DENIED');assert.deepEqual(await row(c[2]),before);
    await assert.rejects(()=>db.query(`update public.${c[2]} set contact_id=$2 where id=$1`,[ra[c[0]],rb.contact]),e=>e.code==='23503');
   }
   for(const role of ['anon','authenticated','service_role','sms_api','crm_mcp']){
    await db.exec(`set role ${role}`);await assert.rejects(()=>call(db,'mcp_lead_handoff_write','staff',a,'crm_assign_lead',{}),/permission denied/);await db.exec('reset role');
   }
  });
  await t.test('replay rechecks current grants, scope, connection, staff status and realm',async()=>{
   for(const c of cases){
    const p=await input(c),saved=await invoke(c[3],p);assert.ok(saved.ok);
    await grant([]);assert.equal((await invoke(c[3],p)).error.code,'PERMISSION_DENIED');
    await grant([c[4]],'active',[b]);assert.equal((await invoke(c[3],p)).error.code,'PERMISSION_DENIED');
    await grant([c[4]],'disabled');assert.equal((await invoke(c[3],p)).error.code,'PERMISSION_DENIED');
    await grant(cases.map(x=>x[4]));
    await db.query("update public.dashboard_accounts set status='suspended' where id=$1",[admin]);assert.equal((await invoke(c[3],p)).error.code,'PERMISSION_DENIED');await db.query("update public.dashboard_accounts set status='active' where id=$1",[admin]);
    assert.equal((await invoke(c[3],p,'reader')).error.code,'PERMISSION_DENIED');
    await db.query("select set_config('platform.actor_issuer','https://customer.example.test',false)");assert.equal((await invoke(c[3],p)).error.code,'PERMISSION_DENIED');await db.query("select set_config('platform.actor_issuer','https://staff.example.test',false)");
    assert.deepEqual((await invoke(c[3],p)).data,saved.data);
   }
  });
  await t.test('reopen uniqueness failures roll back domain changes and retry cache for both resources',async()=>{
   for(const c of cases.filter(x=>x[5]==='status')){
    let p=await input(c);assert.ok((await invoke(c[3],{...p,status:'closed'})).ok);const old=await row(c[2]);
    let duplicate,job;
    if(c[0]==='lead')duplicate=(await db.query('insert into public.sms_leads(tenant_id,contact_id) values($1,$2) returning id',[a,ra.contact])).rows[0].id;
    else {
     job=(await db.query("insert into sms_private.jobs(tenant_id,queue,dedupe_key,payload) values($1,'ai_reply_jobs',$2,'{}') returning id",[a,crypto.randomUUID()])).rows[0].id;
     duplicate=(await db.query("insert into public.sms_handoffs(tenant_id,contact_id,ai_job_id,reason) values($1,$2,$3,'Other') returning id",[a,ra.contact,job])).rows[0].id;
    }
    p={...await input(c),status:'open'};assert.equal((await invoke(c[3],p)).error.code,'CONFLICT');assert.deepEqual(await row(c[2]),old);
    assert.equal((await db.query('select count(*)::int n from sms_private.mcp_requests where idempotency_key=$1',[p.idempotencyKey])).rows[0].n,0);
    await db.query(`delete from public.${c[2]} where id=$1`,[duplicate]);if(job)await db.query('delete from sms_private.jobs where id=$1',[job]);assert.ok((await invoke(c[3],p)).ok);
   }
  });
  await t.test('failure persisting the retry receipt rolls back the operation and redacts internal errors',async()=>{
   await db.exec("create function sms_private.test_receipt_failure() returns trigger language plpgsql as $$ begin raise exception 'synthetic internal credential' using errcode='XX000'; end $$; create trigger test_receipt_failure before insert on sms_private.mcp_requests for each row execute function sms_private.test_receipt_failure()");
   for(const c of cases){
    const before=await row(c[2]),beforeEvents=await events(),p=await input(c);p[c[5]]=c[5]==='owner'?'rollback test':'closed';
    const r=await invoke(c[3],p);assert.equal(r.error.code,'TEMPORARY_FAILURE');assert.equal(r.error.retryable,true);assert.doesNotMatch(JSON.stringify(r),/credential|synthetic/);assert.deepEqual(await row(c[2]),before);
    assert.equal((await db.query('select count(*)::int n from sms_private.mcp_requests where idempotency_key=$1',[p.idempotencyKey])).rows[0].n,0);assert.deepEqual(await events(),beforeEvents);
   }
   await db.exec('drop trigger test_receipt_failure on sms_private.mcp_requests; drop function sms_private.test_receipt_failure()');
  });
  await t.test('revocation is permanent and blocks a previously successful retry',async()=>{
   const c=cases[0],p=await input(c);assert.ok((await invoke(c[3],p)).ok);await grant(cases.map(x=>x[4]),'revoked');assert.equal((await invoke(c[3],p)).error.code,'PERMISSION_DENIED');await assert.rejects(()=>grant(cases.map(x=>x[4])),/cannot be reactivated/);
  });
  await t.test('audit captures attribution, revisions, changed fields, denial and replay without customer content',async()=>{
   const rows=(await db.query('select * from sms_private.mcp_activity where connection_id=$1 and tool=any($2)',[connectionId,cases.map(x=>x[3])])).rows;
   assert.ok(rows.some(x=>x.outcome==='replayed'));assert.ok(rows.some(x=>x.outcome==='denied'));
   for(const audit of rows){assert.equal(audit.actor_id,admin);assert.ok(audit.request_id);assert.ok(audit.created_at);assert.ok(audit.target);
    if(audit.outcome==='denied'){assert.equal(audit.previous_revision,null);assert.equal(audit.revision,null);assert.equal(audit.changed_fields,null);}
    else {assert.ok(audit.previous_revision>0);assert.ok(audit.revision>=audit.previous_revision);assert.deepEqual(audit.changed_fields,audit.revision===audit.previous_revision?[]:[audit.tool.includes('assign')?'owner':'status']);}
   }
   assert.doesNotMatch(JSON.stringify(rows),/Private owner|Next owner|private summary|private reason|private alert|17208429167|answer|credential|token/);
   const adminView=await call(db,'mcp_admin','staff','activity',{connectionId});assert.ok(adminView.activity.some(x=>x.previous_revision>0));
  });
  // Account suspension affects cache counters; all other workflow state must be identical.
  const after=await snap();delete baseline['public.dashboard_cache_versions'];delete after['public.dashboard_cache_versions'];assert.deepEqual(after,baseline);
  for(const table of ['sms_leads','sms_handoffs'])assert.equal((await db.query(`select revision from public.${table} where id=$1`,[table==='sms_leads'?rb.lead:rb.handoff])).rows[0].revision,1);
 }finally{await db.close();}
});
