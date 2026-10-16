import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './helpers/twilioConnections.js';
import {call} from './helpers/database.js';

test('Terminal compliance operations and scoped archival retain evidence without queueing sends',async t=>{
 const {db,business}=await fixture();try{
  const a=(await business('lifecycle-a')).tenant,b=(await business('lifecycle-b')).tenant;
  const make=async(tenant=a,kind='activation_canary',state='pending',status='processing',request={})=>{
   const o=(await db.query("insert into sms_private.remote_operations(tenant_id,provider,operation,idempotency_key,state,request,created_at) values($1,'twilio',$2,gen_random_uuid()::text,$3,$4,now()-interval '10 days') returning *",[tenant,kind,state,JSON.stringify(request)])).rows[0];
   const j=(await db.query("insert into sms_private.jobs(tenant_id,queue,dedupe_key,payload,status,created_at,updated_at) values($1,'compliance_jobs',gen_random_uuid()::text,$2,$3,now()-interval '10 days',now()-interval '9 days') returning *",[tenant,JSON.stringify({operation_id:o.id}),status])).rows[0];return {o,j};
  };
  const fail=async(x)=>db.query("update sms_private.jobs set status='failed',error_code='ACTIVATION_VERIFICATION_FAILED' where id=$1",[x.j.id]);
  const op=async x=>(await db.query('select * from sms_private.remote_operations where id=$1',[x.o.id])).rows[0];
  const archive=async(x,tenant=a,actor='staff',jrev=x.j.operations_revision,orev=x.o.operations_revision)=>(await db.query('select sms_private.archive_obsolete_provider_job($1,$2,$3,$4,$5) r',[actor,tenant,x.j.id,jrev,orev])).rows[0].r;
  await t.test('worker finish and exhausted recovery synchronize safe pending operations exactly once',async()=>{
   for(const kind of ['activation_canary','refresh_status']){
    const x=await make(a,kind);await fail(x);const saved=await op(x);assert.equal(saved.state,'failed');assert.equal(saved.error_code,'ACTIVATION_VERIFICATION_FAILED');assert.equal(saved.operations_revision,2);
    await fail(x);assert.equal((await op(x)).operations_revision,2);
   }
   const x=await make(),token=crypto.randomUUID();await db.query("update sms_private.jobs set lease_token=$2,leased_until=now()+interval '2 minutes',attempts=6 where id=$1",[x.j.id,token]);
   await db.query("select sms_private.finish($1,$2,'retry','PREFLIGHT_FAILED',1)",[x.j.id,token]);assert.equal((await op(x)).state,'failed');
   const y=await make();await db.query("update sms_private.jobs set lease_token=gen_random_uuid(),leased_until=now()-interval '1 minute',attempts=6 where id=$1",[y.j.id]);
   await db.query('select sms_private.tick()');assert.equal((await op(y)).state,'failed');
  });
  await t.test('uncertain, successful, paid, reconciliation, foreign and child-send operations are untouched',async()=>{
   for(const [kind,state,request] of [['activation_canary','completed',{}],['activation_canary','submission_unknown',{}],['activation_canary','submitting',{}],['purchase_number','pending',{}],['submit_registration','pending',{}],['refresh_status','pending',{reconcile:true}]]){
    const x=await make(a,kind,state,'processing',request);await fail(x);assert.equal((await op(x)).state,state);assert.equal((await op(x)).operations_revision,1);
   }
   const foreign=await make(b);await db.query('update sms_private.jobs set tenant_id=$2 where id=$1',[foreign.j.id,a]);await fail(foreign);assert.equal((await op(foreign)).state,'pending');
   const child=await make();await db.query("insert into sms_private.jobs(tenant_id,queue,dedupe_key,payload,status) values($1,'sms_send_jobs',$2,'{}','completed')",[a,'activation-canary:'+child.o.id]);await fail(child);assert.equal((await op(child)).state,'pending');
  });
  await t.test('audit failure rolls back job and operation atomically',async()=>{
   const x=await make();await db.exec("create function public.reject_lifecycle_audit() returns trigger language plpgsql as $$ begin if new.action='compliance_operation_failed' then raise exception 'synthetic lifecycle audit failure';end if;return new;end $$;create trigger reject_lifecycle_audit before insert on sms_private.audit for each row execute function public.reject_lifecycle_audit();");
   await assert.rejects(()=>fail(x),/audit failure/);assert.equal((await op(x)).state,'pending');assert.equal((await db.query('select status from sms_private.jobs where id=$1',[x.j.id])).rows[0].status,'processing');
   await db.exec('drop trigger reject_lifecycle_audit on sms_private.audit;drop function public.reject_lifecycle_audit();');
  });
  await db.query("insert into sms_private.providers(tenant_id,account_sid,auth_secret_id,messaging_service_sid,phone_number_sid,from_number,provisioning_state) values($1,$2,vault.create_secret('synthetic'),$3,$4,'+13035550111','configured')",[a,'AC'+'1'.repeat(32),'MG'+'1'.repeat(32),'PN'+'1'.repeat(32)]);
  await db.query("insert into public.sms_contacts(tenant_id,phone,name) values($1,'+13035550111','Synthetic')",[a]);
  const delivered=(await db.query("insert into public.sms_messages(tenant_id,contact_phone,direction,body,status) values($1,'+13035550111','outbound','synthetic delivered evidence','delivered') returning id",[a])).rows[0].id;
  await db.query("insert into public.sms_twilio_registrations(tenant_id,sender_type,state,canary_message_id) values($1,'toll_free','ready',$2)",[a,delivered]);
  const success=await make(a,'activation_canary','completed','completed');await db.query('update sms_private.remote_operations set created_at=now() where id=$1',[success.o.id]);
  const stale=await make(a,'activation_canary','pending','failed');
  await t.test('archive denies nonstaff, cross-business, stale revisions and non-obsolete work',async()=>{
   await assert.rejects(()=>archive(stale,a,'reader'),/Admin access|required/i);
   await assert.rejects(()=>archive(stale,b),/access denied/);
   await assert.rejects(()=>archive(stale,a,'staff',2),/Job changed/);
   await assert.rejects(()=>archive(stale,a,'staff',1,2),/Operation changed/);
   await assert.rejects(()=>archive(success),/terminal/);
   const leased=await make(a,'activation_canary','pending','failed');await db.query("update sms_private.jobs set leased_until=now()+interval '1 minute' where id=$1",[leased.j.id]);await assert.rejects(()=>archive(leased,a,'staff',2),/unleased/);
   const recent=await make(a,'activation_canary','pending','failed');await db.query('update sms_private.jobs set updated_at=now() where id=$1',[recent.j.id]);await assert.rejects(()=>archive(recent,a,'staff',2),/old terminal/);
   const sent=await make(a,'activation_canary','failed','failed');await db.query('update public.sms_messages set meta=$2 where id=$1',[delivered,JSON.stringify({operationId:sent.o.id})]);await assert.rejects(()=>archive(sent),/sending evidence/);
   await db.query("update public.sms_twilio_registrations set state='canary_pending' where tenant_id=$1",[a]);await assert.rejects(()=>archive(stale),/verified replacement/);await db.query("update public.sms_twilio_registrations set state='ready' where tenant_id=$1",[a]);
  });
  let result;
  await t.test('archive repairs old pending state and retains records, revisions and redacted attribution',async()=>{
   result=await archive(stale);assert.equal(result.jobRevision,2);assert.equal(result.operationRevision,3);assert.ok(result.archivedAt);
   assert.equal((await op(stale)).state,'failed');assert.ok((await op(stale)).archived_at);
   assert.equal((await op(success)).state,'completed');assert.equal((await op(success)).archived_at,null);
   const audit=(await db.query("select * from sms_private.audit where action='obsolete_provider_job_archived'")).rows;assert.equal(audit.length,1);assert.equal(audit[0].actor,'staff');assert.equal(audit[0].detail.previousOperationRevision,1);assert.equal(audit[0].detail.operationRevision,3);assert.ok(!JSON.stringify(audit).includes('synthetic delivered'));
   await assert.rejects(()=>call(db,'api_action','staff',a,'retry_job',{id:stale.j.id}),/Archived/);
   await assert.rejects(()=>db.query("update sms_private.remote_operations set state='pending' where id=$1",[stale.o.id]),/Archived/);
  });
  await t.test('only superseded cancelled bootstrap jobs can be archived; archive audit failure rolls back',async()=>{
   const j=(await db.query("insert into sms_private.jobs(tenant_id,queue,dedupe_key,payload,status,error_code,updated_at) values($1,'provisioning_jobs',gen_random_uuid()::text,'{}','cancelled','EXISTING_TWILIO_CONNECTION',now()-interval '2 days') returning *",[a])).rows[0];
   await db.exec("create function public.reject_archive_audit() returns trigger language plpgsql as $$ begin if new.action='obsolete_provider_job_archived' then raise exception 'synthetic archive audit failure';end if;return new;end $$;create trigger reject_archive_audit before insert on sms_private.audit for each row execute function public.reject_archive_audit();");
   const x={j,o:{operations_revision:null}};await assert.rejects(()=>archive(x),/audit failure/);assert.equal((await db.query('select archived_at from sms_private.jobs where id=$1',[j.id])).rows[0].archived_at,null);
   await db.exec('drop trigger reject_archive_audit on sms_private.audit;drop function public.reject_archive_audit();');assert.equal((await archive(x)).jobRevision,2);
  });
  await t.test('CRM and MCP filter archives before counts/pages while scoped detail retains history',async()=>{
   const invoke=async(tool,p={})=>(await db.query('select crm_mcp.invoke($1,$2,$3,$4,$5) r',['staff','lifecycle-client',tool,JSON.stringify(p),crypto.randomUUID()])).rows[0].r;
   const cid=(await invoke('crm_get_access')).data.connectionId;await call(db,'mcp_admin','staff','save',{connectionId:cid,revision:0,status:'active',permissions:['operations_read'],businessIds:[a],allBusinesses:false});
   const jobs=await invoke('crm_list_operational_jobs',{businessId:a,pageSize:100}),ops=await invoke('crm_list_provider_operations',{businessId:a,pageSize:100});assert.equal(jobs.ok,true,JSON.stringify(jobs));assert.equal(ops.ok,true,JSON.stringify(ops));
   assert.ok(!jobs.data.jobs.some(x=>x.id===stale.j.id));assert.ok(!ops.data.operations.some(x=>x.id===stale.o.id));assert.equal(jobs.data.total,jobs.data.jobs.length);assert.equal(ops.data.total,ops.data.operations.length);
   assert.equal((await invoke('crm_get_operational_job',{businessId:a,jobId:stale.j.id})).data.job.retryEligible,false);
   assert.equal((await invoke('crm_get_provider_operation',{businessId:a,operationId:stale.o.id})).data.operation.state,'failed');
   assert.equal((await invoke('crm_get_provider_operation',{businessId:b,operationId:stale.o.id})).error.code,'PERMISSION_DENIED');
   const diagnostics=(await db.query("select sms_private.api_read('staff',$1,'operations','{}') r",[a])).rows[0].r;assert.ok(!diagnostics.problems.some(x=>x.id===stale.j.id));
   const grounded=(await db.query("select sms_private.grounded_operations('staff',$1) r",[a])).rows[0].r;assert.equal(grounded.queues.find(x=>x.queue==='compliance_jobs').failed,diagnostics.jobs.find(x=>x.queue==='compliance_jobs'&&x.status==='failed').count);
   for(const role of ['anon','authenticated','crm_mcp','sms_api','service_role','sms_automation'])assert.equal((await db.query("select has_function_privilege($1,'sms_private.archive_obsolete_provider_job(text,text,uuid,bigint,bigint)','execute') allowed",[role])).rows[0].allowed,false);
   assert.equal((await db.query("select count(*) n from sms_private.jobs where queue='sms_send_jobs' and status<>'completed'")).rows[0].n,0);
   assert.equal((await db.query('select count(*) n from public.sms_messages')).rows[0].n,1);
  });
 }finally{await db.close();}
});
