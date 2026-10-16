import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './helpers/twilioConnections.js';
import {call} from './helpers/database.js';
import {toolOutputs} from '../src/mcp/tools.js';
import {operationsPermissions,operationsToolPermissions} from '../src/mcp/operationsSchemas.js';

test('Operational MCP isolates metadata and preserves revision, recovery, activation and audit boundaries',async t=>{
 const {db,business}=await fixture();try{
  const a=(await business('ops-a')).tenant,b=(await business('ops-b')).tenant;
  for(const [tenant,n] of [[a,'1'],[b,'2']]){
   await db.query("insert into sms_private.providers(tenant_id,account_sid,auth_secret_id,messaging_service_sid,phone_number_sid,from_number,provisioning_state) values($1,$2,vault.create_secret('PRIVATE credential'),$3,$4,$5,'configured')",[tenant,'AC'+n.repeat(32),'MG'+n.repeat(32),'PN'+n.repeat(32),'+1303555010'+n]);
   await db.query("insert into public.sms_twilio_registrations(tenant_id,sender_type,state,messaging_service_sid,rejection_reason) values($1,'toll_free','ready',$2,'PRIVATE provider content')",[tenant,'MG'+n.repeat(32)]);
  }
  const invoke=async(tool,p={})=>{const r=(await db.query('select crm_mcp.invoke($1,$2,$3,$4,$5) r',['staff','ops-client',tool,JSON.stringify(p),crypto.randomUUID()])).rows[0].r;if(r.ok)toolOutputs[tool].parse(r.data);return r;};
  const cid=(await invoke('crm_get_access')).data.connectionId;let gr=0;
  const grant=async(perms=operationsPermissions.map(x=>x[0]),status='active')=>{gr=(await call(db,'mcp_admin','staff','save',{connectionId:cid,revision:gr,status,permissions:perms,businessIds:[a],allBusinesses:false})).connection.revision;};await grant();
  const versions=async()=>{const x=(await invoke('crm_get_provider_readiness',{businessId:a})).data;return {businessId:a,revision:x.revision,providerRevision:x.providerRevision,registrationRevision:x.registrationRevision};};
  const make=async(tenant,kind='refresh_status',state='pending',status='failed')=>{
   const o=(await db.query("insert into sms_private.remote_operations(tenant_id,provider,operation,idempotency_key,state,request) values($1,'twilio',$2,gen_random_uuid()::text,$3,'{\"secret\":\"PRIVATE operation\"}') returning *",[tenant,kind,state])).rows[0];
   const j=(await db.query("insert into sms_private.jobs(tenant_id,queue,dedupe_key,payload,status) values($1,'compliance_jobs',gen_random_uuid()::text,$2,$3) returning *",[tenant,JSON.stringify({operation_id:o.id,body:'PRIVATE message'}),status])).rows[0];return {o,j};
  };
  const own=await make(a),foreign=await make(b);let queued;
  await t.test('independent grants, bounded paging, scoped counts and private content redaction',async()=>{
   for(const [tool,permission] of Object.entries(operationsToolPermissions)){await grant(operationsPermissions.map(x=>x[0]).filter(x=>x!==permission));assert.equal((await invoke(tool,{businessId:a})).error.code,'PERMISSION_DENIED',tool);}await grant();
   for(const tool of ['crm_get_provider_inventory','crm_get_provider_readiness','crm_get_operations_summary','crm_list_operational_jobs','crm_list_provider_operations']){const r=await invoke(tool,{businessId:a});assert.equal(r.ok,true,JSON.stringify(r));assert.ok(!JSON.stringify(r).includes('PRIVATE'));assert.equal((await invoke(tool,{businessId:b})).error.code,'PERMISSION_DENIED');}
   assert.equal((await invoke('crm_list_operational_jobs',{businessId:a})).data.total,1);
   assert.equal((await invoke('crm_list_provider_operations',{businessId:a})).data.total,1);
   assert.equal((await invoke('crm_get_operational_job',{businessId:a,jobId:foreign.j.id})).error.code,'PERMISSION_DENIED');
   assert.equal((await invoke('crm_get_provider_operation',{businessId:a,operationId:foreign.o.id})).error.code,'PERMISSION_DENIED');
   assert.equal((await invoke('crm_list_operational_jobs',{businessId:a,pageSize:101})).error.code,'VALIDATION_ERROR');
   assert.equal((await invoke('crm_get_provider_inventory',{businessId:a,includeCredentials:true})).error.code,'VALIDATION_ERROR');
  });
  await t.test('worker changes invalidate revisions and refresh retries queue exactly once',async()=>{
   const p={...await versions(),idempotencyKey:crypto.randomUUID()};await db.query('update sms_private.providers set provisioning_state=provisioning_state where tenant_id=$1',[a]);
   assert.equal((await invoke('crm_refresh_provider_status',p)).error.code,'CONFLICT');Object.assign(p,await versions());
   const r=await invoke('crm_refresh_provider_status',p);assert.equal(r.ok,true,JSON.stringify(r));queued=r.data;
   assert.deepEqual((await invoke('crm_refresh_provider_status',p)).data,r.data);
   assert.equal((await invoke('crm_refresh_provider_status',{...p,revision:p.revision+1})).error.code,'CONFLICT');
   assert.equal((await invoke('crm_refresh_provider_status',{...p,idempotencyKey:crypto.randomUUID()})).error.code,'CONFLICT');
   assert.equal((await db.query('select count(*) n from sms_private.jobs where id=$1',[queued.jobId])).rows[0].n,1);
   await grant(operationsPermissions.map(x=>x[0]).filter(x=>x!=='provider_refresh'));assert.equal((await invoke('crm_refresh_provider_status',p)).error.code,'PERMISSION_DENIED');await grant();
   await db.query("update sms_private.jobs set status='completed' where id=$1",[queued.jobId]);
  });
  await t.test('only failed non-reconciliation status checks can be retried',async()=>{
   await db.query('update sms_private.jobs set lease_token=gen_random_uuid(),leased_until=null where id=$1',[own.j.id]);
   const p={...await versions(),jobId:own.j.id,jobRevision:2,operationRevision:1,idempotencyKey:crypto.randomUUID()};
   const r=await invoke('crm_retry_operational_job',p);assert.equal(r.ok,true,JSON.stringify(r));assert.equal(r.data.jobRevision,3);assert.deepEqual((await invoke('crm_retry_operational_job',p)).data,r.data);
   assert.equal((await invoke('crm_retry_operational_job',{...p,idempotencyKey:crypto.randomUUID()})).error.code,'CONFLICT');
   await db.query("update sms_private.jobs set status='completed' where id=$1",[own.j.id]);
   for(const [kind,state] of [['purchase_number','pending'],['activation_canary','pending'],['refresh_status','submission_unknown']]){
    const x=await make(a,kind,state);const q={...await versions(),jobId:x.j.id,jobRevision:1,operationRevision:1,idempotencyKey:crypto.randomUUID()};assert.equal((await invoke('crm_retry_operational_job',q)).error.code,'VALIDATION_ERROR');
   }
  });
  await t.test('reconciliation excludes purchases and rechecks target before worker provider access',async()=>{
   await db.query("update public.sms_twilio_registrations set state='submission_unknown' where tenant_id=$1",[a]);
   const purchase=await make(a,'purchase_number','submission_unknown');
   assert.equal((await invoke('crm_reconcile_provider_status',{...await versions(),operationId:purchase.o.id,operationRevision:1,idempotencyKey:crypto.randomUUID()})).error.code,'VALIDATION_ERROR');
   await db.query("update sms_private.remote_operations set state='reconciled' where tenant_id=$1 and state='submission_unknown'",[a]);
   const target=await make(a,'submit_registration','submission_unknown');
   const r=await invoke('crm_reconcile_provider_status',{...await versions(),operationId:target.o.id,operationRevision:1,idempotencyKey:crypto.randomUUID()});assert.equal(r.ok,true,JSON.stringify(r));
   const token=crypto.randomUUID();await db.query("update sms_private.jobs set status='processing',lease_token=$2,leased_until=now()+interval '5 minutes' where id=$1",[r.data.jobId,token]);
   const ctx=(await db.query('select sms_private.compliance_job_context($1,$2) r',[r.data.jobId,token])).rows[0].r;assert.equal(ctx.uncertain_operation.id,target.o.id);
   await db.query("update sms_private.remote_operations set request=request where id=$1",[target.o.id]);
   await assert.rejects(()=>db.query('select sms_private.compliance_job_context($1,$2)',[r.data.jobId,token]),/state changed/);
   await db.query("update sms_private.jobs set status='completed',lease_token=null where id=$1",[r.data.jobId]);
  });
  await t.test('activation requires delivered canary and current state, never queues a test',async()=>{
   await db.query("update public.sms_twilio_registrations set state='webhook_verified' where tenant_id=$1",[a]);
   const r=await invoke('crm_get_provider_readiness',{businessId:a});assert.equal(r.data.ready,false);assert.ok(r.data.reasons.includes('delivered_canary_required'));
   assert.equal((await invoke('crm_activate_sms_sending',{...await versions(),idempotencyKey:crypto.randomUUID()})).error.code,'VALIDATION_ERROR');
   await db.query("update public.sms_twilio_registrations set state='ready' where tenant_id=$1",[a]);
   const p={...await versions(),idempotencyKey:crypto.randomUUID()},saved=await invoke('crm_activate_sms_sending',p);assert.equal(saved.ok,true,JSON.stringify(saved));assert.equal(saved.data.revision,p.revision+1);assert.deepEqual((await invoke('crm_activate_sms_sending',p)).data,saved.data);
  });
  await t.test('audit failure rolls back a queued operation and its receipt; audit stays redacted',async()=>{
   await db.query("update sms_private.remote_operations set idempotency_key=gen_random_uuid()::text where tenant_id=$1",[a]);
   await db.exec("create function public.fail_ops_audit() returns trigger language plpgsql as $$ begin if new.tool='crm_refresh_provider_status' then raise exception 'synthetic audit failure';end if;return new;end $$;create trigger fail_ops_audit before insert on sms_private.mcp_activity for each row execute function public.fail_ops_audit();");
   const before=(await db.query('select count(*) n from sms_private.remote_operations')).rows[0].n;
   const p={...await versions(),idempotencyKey:crypto.randomUUID()};
   await assert.rejects(()=>invoke('crm_refresh_provider_status',p),/audit failure/);
   await db.exec('drop trigger fail_ops_audit on sms_private.mcp_activity;drop function public.fail_ops_audit();');
   assert.equal((await db.query('select count(*) n from sms_private.remote_operations')).rows[0].n,before);
   const audits=(await db.query('select * from sms_private.mcp_activity')).rows;assert.ok(!JSON.stringify(audits).includes('PRIVATE'));
   assert.ok(audits.some(x=>x.tool==='crm_retry_operational_job:job'&&x.previous_revision===2&&x.revision===3&&x.target===own.j.id));
   assert.ok(audits.some(x=>x.tool==='crm_retry_operational_job'&&x.target===a));
   assert.equal((await db.query("select count(*) n from sms_private.jobs where queue='sms_send_jobs'")).rows[0].n,0);
   for(const role of ['anon','authenticated','crm_mcp','sms_api','service_role','sms_automation'])assert.equal((await db.query("select has_function_privilege($1,'sms_private.compliance_job_context_before_mcp(uuid,uuid)','execute') allowed",[role])).rows[0].allowed,false);
  });
 }finally{await db.close();}
});
