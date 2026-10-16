import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './helpers/twilioConnections.js';
import {call} from './helpers/database.js';
import {createCrmHandler} from '../supabase/functions/crm-api/handler.js';
import {saveLeadEdit} from '../public/voiceWorkspace.js';
const migration='20261016165709_lead_handoff_revisions.sql';
test('shared revisions backfill without changing historical lead content',async()=>{
 let id,prior;
 const {db}=await fixture({beforeMigration:async(db,file)=>{
  if(file!==migration)return;
  await db.exec("insert into sms_private.admins values('admin') on conflict do nothing");
  await call(db,'api_action','admin',null,'create_business',{id:'legacy-revision-test',name:'Legacy',timeZone:'UTC'});
  const cid=(await db.query("insert into public.sms_contacts(tenant_id,phone) values('legacy-revision-test','+17208429167') returning id")).rows[0].id;
  prior=(await db.query("insert into public.sms_leads(tenant_id,contact_id,status,owner,summary,updated_at) values('legacy-revision-test',$1,'assigned','Existing owner','Existing summary','2020-01-01') returning *",[cid])).rows[0];id=prior.id;
 }});
 try{const row=(await db.query('select * from public.sms_leads where id=$1',[id])).rows[0];assert.equal(row.revision,1);delete row.revision;assert.deepEqual(row,prior);}finally{await db.close();}
});
test('staff and worker changes share revisions, isolate tenants, and preserve unrelated state',async t=>{
 const {db,business,admin}=await fixture();
 try{
  const a=(await business('a')).tenant,b=(await business('b')).tenant;
  for(const tenantId of [a,b])await call(db,'platform_action','staff','service_add',{tenantId,kind:'sms'});
  const records=async(tenant)=>{
   const cid=(await db.query("insert into public.sms_contacts(tenant_id,phone) values($1,'+17208429167') returning id",[tenant])).rows[0].id;
   const lead=(await db.query("insert into public.sms_leads(tenant_id,contact_id,summary,revision) values($1,$2,'Initial',99) returning *",[tenant,cid])).rows[0];
   const job=(await db.query("insert into sms_private.jobs(tenant_id,queue,dedupe_key,payload) values($1,'ai_reply_jobs',$2,'{}') returning id",[tenant,crypto.randomUUID()])).rows[0].id;
   const handoff=(await db.query("insert into public.sms_handoffs(tenant_id,contact_id,lead_id,ai_job_id,reason) values($1,$2,$3,$4,'Initial reason') returning *",[tenant,cid,lead.id,job])).rows[0];return {lead,handoff};
  };
  const ra=await records(a),rb=await records(b);
  const row=async(resource,id)=>(await db.query(`select * from public.sms_${resource==='lead'?'leads':'handoffs'} where id=$1`,[id])).rows[0];
  const edit=(resource,id,input,user='staff',tenant=a)=>call(db,'update_lead_handoff',user,tenant,resource,id,input);
  const tables=['public.sms_contacts','public.sms_messages','sms_private.jobs','sms_private.form_runs','sms_private.mcp_requests','public.dashboard_cache_versions','pgmq.test_messages','net.test_requests'];
  const snapshot=async()=>{const x={};for(const table of tables)x[table]=(await db.query(`select coalesce(jsonb_agg(to_jsonb(x) order by to_jsonb(x)::text),'[]') v from ${table} x`)).rows[0].v;return x;};
  const unchanged=await snapshot();
  await t.test('both resources start at one, advance once per meaningful change and reject stale saves',async()=>{
   for(const resource of ['lead','handoff']){
    const id=ra[resource].id;assert.equal((await row(resource,id)).revision,1);
    const saved=await edit(resource,id,{revision:1,status:'assigned',owner:'Team member'});assert.equal(saved.revision,2);
    await assert.rejects(()=>edit(resource,id,{revision:1,status:'closed'}),e=>e.code==='40001');
    const same=await edit(resource,id,{revision:2,status:'assigned',owner:'Team member'});assert.equal(same.revision,2);assert.equal(same.updated_at,saved.updated_at);
    const changed=await edit(resource,id,{revision:2,status:'resolved'});assert.equal(changed.owner,'Team member');assert.equal(changed.revision,3);
    const cleared=await edit(resource,id,{revision:3,owner:null});assert.equal(cleared.status,'resolved');assert.equal(cleared.revision,4);
   }
  });
  await t.test('worker update/upsert and alert metadata invalidate stale staff snapshots without overwriting staff fields',async()=>{
   await db.query("update public.sms_leads set fields=fields||'{\"worker\":true}',summary='Worker summary',updated_at=now() where id=$1",[ra.lead.id]);
   const lead=await row('lead',ra.lead.id);assert.equal(lead.revision,5);assert.equal(lead.status,'resolved');assert.equal(lead.owner,null);
   await assert.rejects(()=>edit('lead',ra.lead.id,{revision:4,status:'closed'}),e=>e.code==='40001');
   await db.query("update public.sms_handoffs set alert_status='failed',alert_error='synthetic worker error' where id=$1",[ra.handoff.id]);
   assert.equal((await row('handoff',ra.handoff.id)).revision,5);
   await assert.rejects(()=>edit('handoff',ra.handoff.id,{revision:4,status:'closed'}),e=>e.code==='40001');
   await edit('handoff',ra.handoff.id,{revision:5,status:'assigned',owner:'Retain owner'});
   await db.query("insert into public.sms_handoffs(tenant_id,contact_id,lead_id,ai_job_id,reason,priority) select tenant_id,contact_id,lead_id,ai_job_id,'Worker follow-up','high' from public.sms_handoffs where id=$1 on conflict(tenant_id,contact_id) where status in ('open','assigned') do update set reason=excluded.reason,priority=excluded.priority,updated_at=now()",[ra.handoff.id]);
   const handoff=await row('handoff',ra.handoff.id);assert.equal(handoff.revision,7);assert.equal(handoff.status,'assigned');assert.equal(handoff.owner,'Retain owner');
   await db.query('update public.sms_handoffs set updated_at=now() where id=$1',[ra.handoff.id]);assert.deepEqual(await row('handoff',ra.handoff.id),handoff);
   await assert.rejects(()=>db.query('update public.sms_leads set revision=100 where id=$1',[ra.lead.id]),e=>e.code==='23514');
  });
  await t.test('strict edits, private helper and unauthorized identities leave records unchanged',async()=>{
   const before=await row('lead',ra.lead.id);
   for(const p of [{status:'closed'},{revision:null,status:'closed'},{revision:'5',status:'closed'},{revision:1.5,status:'closed'},{revision:0,status:'closed'},{revision:5},{revision:5,status:'won'},{revision:5,status:null},{revision:5,owner:{}},{revision:5,owner:'x'.repeat(201)},{revision:5,status:'closed',tenantId:b}])await assert.rejects(()=>edit('lead',ra.lead.id,p));
   assert.deepEqual(await row('lead',ra.lead.id),before);
   for(const resource of ['lead','handoff']){
    await assert.rejects(()=>edit(resource,rb[resource].id,{revision:1,status:'closed'}),e=>e.code==='42501'&&e.message==='Record unavailable');
    await assert.rejects(()=>edit(resource,crypto.randomUUID(),{revision:1,status:'closed'}),e=>e.code==='42501'&&e.message==='Record unavailable');
    await assert.rejects(()=>edit(resource,ra[resource].id,{revision:5,status:'closed'},'reader'),e=>e.code==='42501');
    assert.equal((await row(resource,rb[resource].id)).revision,1);
   }
   assert.deepEqual(await snapshot(),unchanged);
   await db.query("update public.dashboard_accounts set status='suspended' where id=$1",[admin]);await assert.rejects(()=>edit('lead',ra.lead.id,{revision:5,status:'closed'}),e=>e.code==='42501');
   await db.query("update public.dashboard_accounts set status='active' where id=$1",[admin]);
   const afterIdentityChanges=await snapshot();
   for(const role of ['crm_mcp','anon','authenticated','service_role']){await db.exec(`set role ${role}`);await assert.rejects(()=>edit('lead',ra.lead.id,{revision:5,status:'closed'}),/permission denied/);await db.exec('reset role');}
   assert.deepEqual(await snapshot(),afterIdentityChanges);
  });
  await t.test('reopening conflicts with an existing open record and rolls back the counter',async()=>{
   const old=await row('lead',ra.lead.id);
   await db.query("insert into public.sms_leads(tenant_id,contact_id,status) values($1,$2,'open')",[a,old.contact_id]);
   await assert.rejects(()=>edit('lead',old.id,{revision:old.revision,status:'open'}),e=>e.code==='23505');assert.deepEqual(await row('lead',old.id),old);
  });
 }finally{await db.close();}
});
test('CRM forwards expected revision with verified identity and maps conflicts to 409',async()=>{
 const calls=[];
 const handler=createCrmHandler({call:async(name,...args)=>{calls.push([name,...args]);if(name==='update_lead_handoff')throw Object.assign(new Error('Record changed; refresh and review before saving'),{code:'40001'});return {rows:[]};}},async()=> 'verified-staff');
 for(const resource of ['leads','handoffs']){
  const p={revision:4,status:'closed'};
  const response=await handler(new Request(`https://api.example.test/crm-api/${resource}/00000000-0000-4000-8000-000000000001`,{method:'PATCH',headers:{'X-Tenant-Id':'allowed','Content-Type':'application/json'},body:JSON.stringify(p)}));
  assert.equal(response.status,409);assert.match((await response.json()).error,/refresh/);assert.deepEqual(calls.at(-1).slice(0,4),['update_lead_handoff','verified-staff','allowed',resource==='leads'?'lead':'handoff']);assert.deepEqual(calls.at(-1).at(-1),p);
 }
});
test('lead editor preserves stale edits and never retries automatically',async()=>{
 const calls=[],fields={status:'assigned',owner:'My unsaved choice'};
 await assert.rejects(()=>saveLeadEdit(async(url,options)=>{calls.push({url,...options});return Response.json({error:'Record changed; refresh and review before saving'},{status:409});},'lead-id',7,fields),/refresh/);
 assert.equal(calls.length,1);assert.deepEqual(JSON.parse(calls[0].body),{...fields,revision:7});assert.equal(fields.owner,'My unsaved choice');
 await assert.rejects(()=>saveLeadEdit(()=>{throw new Error('Should not call');},'id',NaN,fields),/Refresh/);
});
