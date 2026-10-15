import test from 'node:test';import assert from 'node:assert/strict';import {z} from 'zod';
import {fixture} from './helpers/twilioConnections.js';import {call} from './helpers/database.js';
import {toolOutputs} from '../src/mcp/tools.js';import {smsActivityTools} from '../src/mcp/smsActivitySchemas.js';
const sequence={trigger:'submission',replyPolicy:'pause',startHour:0,endHour:24,leadHours:24,steps:[{body:'Private message {{name}}',delayCount:0,delayUnit:'minute',sendCount:2,intervalCount:1,intervalUnit:'day'}]};
test('run control/activity schemas enforce revisions, bounds and exact fields',()=>{
 const s=name=>z.object(smsActivityTools.find(t=>t[0]===name)[2]).strict(),base={businessId:'a',runId:crypto.randomUUID()};
 assert.equal(s('crm_resume_sms_run').safeParse({...base,generation:1,contactRevision:1,idempotencyKey:'resume-123'}).success,true);
 for(const patch of [{generation:-1},{generation:1.5},{contactRevision:null},{contactRevision:undefined},{idempotencyKey:'short'},{consent:true},{sequence}])assert.equal(s('crm_resume_sms_run').safeParse({...base,generation:1,contactRevision:1,idempotencyKey:'resume-123',...patch}).success,false);
 assert.equal(s('crm_pause_sms_run').safeParse({...base,generation:1,idempotencyKey:'pause-123',contactRevision:1}).success,false);
 for(const pageSize of [0,101,1.5])assert.equal(s('crm_get_sms_run_activity').safeParse({...base,pageSize}).success,false);
});
test('MCP lifecycle preserves grants, scope, consent, immutable rules, retries and redacted activity',async t=>{
 const x=await fixture(),{db}=x;try{
  const {tenant:a}=await x.business('control-a'),{tenant:b}=await x.business('control-b');
  for(const business of [a,b]){await call(db,'platform_action','staff','service_add',{tenantId:business,kind:'sms'});await db.query("update public.sms_businesses set sending_enabled=true,status='active' where tenant_id=$1",[business]);}
  const make=async(business,phone)=>{
   const c=(await db.query('insert into public.sms_contacts(tenant_id,phone,name,marketing_consent) values($1,$2,$3,true) returning *',[business,phone,'Private person'])).rows[0];
   const d=(await call(db,'contact_automations','staff',business,'publish',{name:'Template',sequence,idempotencyKey:'publish-'+phone})).template;
   const run=(await call(db,'contact_automations','staff',business,'enroll',{contactId:c.id,contactRevision:c.revision,templateId:d.id,templateRevision:d.revision,overlaps:[],overlapChoice:'keep',context:'Secret request',idempotencyKey:'enroll-'+phone})).run;
   return {c,d,run};
  };
  const direct=await make(a,'+13035550180'),foreign=await make(b,'+13035550180'),other=await make(a,'+13035550181');
  let f=(await call(db,'form_workspace','staff',a,'create',null,{title:'Form',preset:'contacts',fields:[],description:'',buttonLabel:'Send',enabled:false})).form;
  f=(await call(db,'form_workspace','staff',a,'save',f.public_id,{title:f.title,fields:[],description:'',buttonLabel:'Send',enabled:true})).form;
  await call(db,'form_workspace','staff',a,'publish',f.public_id,{revision:0,sequence});await call(db,'form_workspace','staff',a,'state',f.public_id,{enabled:true});
  const submission=await call(db,'submit_web_form',f.public_id,{submissionId:crypto.randomUUID(),name:'Private submission',phone:'+13035550182',email:'secret@example.test',smsOptIn:true,details:{}});
  const formRun=(await db.query('select * from sms_private.form_runs where submission_id=$1',[submission.submissionId])).rows[0];
  const invoke=async(tool,p={})=>{const r=await call(db,'mcp_invoke','staff','control-client',tool,p,crypto.randomUUID());if(r.ok)toolOutputs[tool].parse(r.data);return r;};
  const connectionId=(await invoke('crm_get_access')).data.connectionId;let grantRevision=0;
  const grant=async(permissions,status='active')=>{const r=await call(db,'mcp_admin','staff','save',{connectionId,revision:grantRevision,status,permissions,businessIds:[a]});grantRevision=r.connection.revision;};
  const snapshot=async id=>(await db.query('select * from sms_private.form_runs where id=$1',[id])).rows[0];
  const request=async(id,key=crypto.randomUUID(),resume=false)=>{const r=await snapshot(id);return {businessId:a,runId:id,generation:r.generation,idempotencyKey:key,...(resume?{contactRevision:(await db.query('select revision from public.sms_contacts where tenant_id=$1 and phone=$2',[a,r.phone])).rows[0]?.revision}:{})};};
  const baselineJobs=(await db.query('select count(*) n from sms_private.jobs')).rows[0].n;
  // STOP/contact triggers may terminate runs. Synthetic paused fixtures below
  // exercise the resume guard independently; real terminal runs are never reset.
  const pausedFixture=()=>db.query("update sms_private.form_runs set status='paused',generation=generation+1 where id=$1",[direct.run.id]);
  const before=await snapshot(direct.run.id);let pauseRequest,pauseResult;
  await t.test('each grant is independent and business/run/filter substitution fails before changes',async()=>{
   await grant(['automation_read','automation_run_start','automation_publish']);
   for(const tool of ['crm_list_sms_runs','crm_get_sms_run','crm_get_sms_run_activity'])assert.equal((await invoke(tool,{businessId:a,runId:direct.run.id})).error.code,'PERMISSION_DENIED');
   for(const tool of ['crm_resume_sms_run','crm_pause_sms_run','crm_stop_sms_run'])assert.equal((await invoke(tool,await request(direct.run.id))).error.code,'PERMISSION_DENIED');
   await grant(['automation_activity']);
   for(const tool of ['crm_get_sms_run','crm_get_sms_run_activity'])for(const input of [{businessId:a,runId:foreign.run.id},{businessId:b,runId:foreign.run.id}])assert.equal((await invoke(tool,input)).error.code,'PERMISSION_DENIED');
   for(const filter of [{contactId:foreign.c.id},{kind:'contact',automationId:foreign.d.id}])assert.equal((await invoke('crm_list_sms_runs',{businessId:a,...filter})).error.code,'PERMISSION_DENIED');
   assert.equal((await invoke('crm_list_sms_runs',{businessId:a,pageSize:101})).error.code,'VALIDATION_ERROR');
   assert.equal((await invoke('crm_list_sms_runs',{businessId:a,automationId:direct.d.id})).error.code,'VALIDATION_ERROR');
   const listed=await invoke('crm_list_sms_runs',{businessId:a,pageSize:1});assert.equal(listed.ok,true,JSON.stringify(listed));assert.equal(listed.data.total,3);assert.equal(listed.data.runs.length,1);
   assert.equal((await invoke('crm_list_sms_runs',{businessId:a,contactId:direct.c.id})).data.total,1);
   assert.equal((await invoke('crm_list_sms_runs',{businessId:a,kind:'form',automationId:f.public_id})).data.total,1);
   assert.equal((await invoke('crm_get_sms_run',{businessId:a,runId:direct.run.id})).data.run.contactRevision,direct.c.revision);
   await grant(['automation_run_pause_stop']);
   assert.equal((await invoke('crm_pause_sms_run',{...await request(foreign.run.id),businessId:a})).error.code,'PERMISSION_DENIED');
   assert.equal((await invoke('crm_resume_sms_run',await request(direct.run.id,undefined,true))).error.code,'PERMISSION_DENIED');
   assert.equal((await invoke('crm_get_sms_run',{businessId:a,runId:direct.run.id})).error.code,'PERMISSION_DENIED');
   assert.deepEqual(await snapshot(direct.run.id),before);
  });
  await t.test('pause retries commit one generation; stale or changed requests conflict without touching other runs',async()=>{
   pauseRequest=await request(direct.run.id,'pause-first');pauseResult=await invoke('crm_pause_sms_run',pauseRequest);assert.equal(pauseResult.ok,true,JSON.stringify(pauseResult));
   assert.equal(pauseResult.data.run.generation,before.generation+1);assert.equal(pauseResult.data.run.status,'paused');assert.deepEqual(await invoke('crm_pause_sms_run',pauseRequest),pauseResult);
   assert.equal((await invoke('crm_pause_sms_run',{...pauseRequest,generation:pauseRequest.generation+1})).error.code,'CONFLICT');
   assert.equal((await invoke('crm_stop_sms_run',pauseRequest)).error.code,'CONFLICT');
   assert.equal((await invoke('crm_pause_sms_run',{...pauseRequest,idempotencyKey:'stale-new-key'})).error.code,'CONFLICT');
   assert.equal((await invoke('crm_pause_sms_run',{...await request(direct.run.id),consent:true})).error.code,'VALIDATION_ERROR');
   assert.equal((await snapshot(other.run.id)).status,'active');assert.deepEqual((await snapshot(direct.run.id)).direct_sequence,before.direct_sequence);
  });
  await t.test('resume rechecks revisions, STOP, consent, blocks, sending and direct runtime; failures do not consume keys',async()=>{
   await grant(['automation_run_resume']);const p=await request(direct.run.id,'resume-denied-key',true);
   assert.equal((await invoke('crm_stop_sms_run',await request(direct.run.id))).error.code,'PERMISSION_DENIED');
   await db.query('update public.sms_contacts set opted_out=true where id=$1',[direct.c.id]);assert.equal((await invoke('crm_resume_sms_run',p)).error.code,'CONFLICT');
   for(const update of ['opted_out=true','opted_out=false,marketing_consent=false','marketing_consent=true,enquiry_blocked=true']){
    await db.query('update public.sms_contacts set '+update+' where id=$1',[direct.c.id]);await pausedFixture();assert.equal((await invoke('crm_resume_sms_run',await request(direct.run.id,undefined,true))).error.code,'VALIDATION_ERROR');
   }
   await db.query('update public.sms_contacts set enquiry_blocked=false where id=$1',[direct.c.id]);
   await db.query('update public.sms_businesses set sending_enabled=false where tenant_id=$1',[a]);assert.equal((await invoke('crm_resume_sms_run',await request(direct.run.id,undefined,true))).error.code,'VALIDATION_ERROR');
   await db.query("update public.sms_businesses set sending_enabled=true,status='paused' where tenant_id=$1",[a]);assert.equal((await invoke('crm_resume_sms_run',await request(direct.run.id,undefined,true))).error.code,'VALIDATION_ERROR');
   await db.query("update public.sms_businesses set status='active' where tenant_id=$1",[a]);
   await db.query('update sms_private.runtime set direct_automations_enabled=false');assert.equal((await invoke('crm_resume_sms_run',await request(direct.run.id,undefined,true))).error.code,'VALIDATION_ERROR');await db.query('update sms_private.runtime set direct_automations_enabled=true');
   assert.equal((await db.query('select count(*) n from sms_private.mcp_requests where connection_id=$1 and idempotency_key=$2',[connectionId,p.idempotencyKey])).rows[0].n,0);
   await pausedFixture();const good=await request(direct.run.id,'resume-good-key',true),r=await invoke('crm_resume_sms_run',good);assert.equal(r.ok,true,JSON.stringify(r));assert.equal(r.data.run.status,'active');assert.deepEqual(await invoke('crm_resume_sms_run',good),r);
   assert.equal((await invoke('crm_resume_sms_run',await request(direct.run.id,undefined,true))).error.code,'VALIDATION_ERROR');
   assert.deepEqual((await snapshot(direct.run.id)).direct_sequence,before.direct_sequence);
  });
  await t.test('form resume obeys enabled/archive settings and keeps its published version',async()=>{
   await grant(['automation_run_pause_stop','automation_run_resume']);
   assert.equal((await invoke('crm_pause_sms_run',await request(formRun.id))).ok,true);
   await call(db,'form_workspace','staff',a,'state',f.public_id,{enabled:false});
   assert.equal((await invoke('crm_resume_sms_run',await request(formRun.id,undefined,true))).error.code,'VALIDATION_ERROR');
   await call(db,'form_workspace','staff',a,'state',f.public_id,{enabled:true});
   await db.query('update public.sms_web_form_definitions set archived=true where public_id=$1',[f.public_id]);
   assert.equal((await invoke('crm_resume_sms_run',await request(formRun.id,undefined,true))).error.code,'VALIDATION_ERROR');
   await db.query('update public.sms_web_form_definitions set archived=false where public_id=$1',[f.public_id]);
   const r=await invoke('crm_resume_sms_run',await request(formRun.id,undefined,true));assert.equal(r.ok,true,JSON.stringify(r));assert.equal(r.data.run.publishedVersion,formRun.version);
  });
  await t.test('historical recipients without contacts can be stopped; test snapshots and past appointments stay explicit',async()=>{
   const missing=(await db.query("insert into sms_private.form_runs(tenant_id,form_id,version,submission_id,phone,context) values($1,$2,$3,$4,'+13035550189','{}') returning *",[a,f.public_id,formRun.version,crypto.randomUUID()])).rows[0];
   assert.equal((await invoke('crm_pause_sms_run',await request(missing.id))).ok,true);
   assert.equal((await invoke('crm_resume_sms_run',{...await request(missing.id),contactRevision:0})).error.code,'VALIDATION_ERROR');
   assert.equal((await invoke('crm_stop_sms_run',await request(missing.id))).ok,true);
   await grant(['automation_activity','automation_run_pause_stop','automation_run_resume']);
   const testRun=(await db.query("insert into sms_private.form_runs(tenant_id,form_id,version,submission_id,phone,context,test_sequence,test_actor,test_request) values($1,$2,null,$3,'+13035550182','{}',$4,'staff','{}') returning *",[a,f.public_id,crypto.randomUUID(),JSON.stringify(sequence)])).rows[0];
   const read=await invoke('crm_get_sms_run',{businessId:a,runId:testRun.id});assert.equal(read.data.run.test,true);assert.equal(read.data.run.publishedVersion,null);
   assert.equal((await invoke('crm_pause_sms_run',await request(testRun.id))).ok,true);assert.equal((await invoke('crm_stop_sms_run',await request(testRun.id))).ok,true);
   await db.query("update sms_private.form_runs set status='completed' where id=$1",[testRun.id]);
   assert.equal((await invoke('crm_resume_sms_run',await request(testRun.id,undefined,true))).error.code,'VALIDATION_ERROR');
   assert.equal((await invoke('crm_pause_sms_run',await request(formRun.id))).ok,true);
   await db.query("update sms_private.form_runs set appointment_at='2020-01-01' where id=$1",[formRun.id]);
   assert.equal((await invoke('crm_resume_sms_run',await request(formRun.id,undefined,true))).error.code,'VALIDATION_ERROR');
   assert.equal((await invoke('crm_stop_sms_run',await request(formRun.id))).ok,true);
  });
  await t.test('uncertain sends block resume but do not prevent stopping; terminal runs never restart',async()=>{
   const job=(await db.query("insert into sms_private.jobs(tenant_id,queue,status,dedupe_key,payload) values($1,'sms_send_jobs','submission_unknown','synthetic-uncertain',jsonb_build_object('request',jsonb_build_object('form_run_id',$2::text))) returning id",[a,direct.run.id])).rows[0].id;
   const paused=await invoke('crm_pause_sms_run',await request(direct.run.id));assert.equal(paused.data.inFlightMayDeliver,true);
   assert.equal((await invoke('crm_resume_sms_run',await request(direct.run.id,undefined,true))).error.code,'VALIDATION_ERROR');
   await db.query('update public.sms_contacts set opted_out=true,marketing_consent=false where id=$1',[direct.c.id]);await db.query('update public.sms_businesses set sending_enabled=false where tenant_id=$1',[a]);
   await pausedFixture();const p=await request(direct.run.id,'stop-uncertain'),r=await invoke('crm_stop_sms_run',p);assert.equal(r.ok,true,JSON.stringify(r));assert.equal(r.data.run.status,'stopped');assert.equal(r.data.run.nextRunAt,null);assert.equal(r.data.inFlightMayDeliver,true);assert.deepEqual(await invoke('crm_stop_sms_run',p),r);
   assert.equal((await invoke('crm_resume_sms_run',await request(direct.run.id,undefined,true))).error.code,'VALIDATION_ERROR');
   assert.equal((await db.query('select status from sms_private.jobs where id=$1',[job])).rows[0].status,'submission_unknown');
   await db.query('update public.sms_businesses set sending_enabled=true where tenant_id=$1',[a]);
  });
  await t.test('activity projects only scoped events and facts, separates accepted from delivered, and paginates counts',async()=>{
   await grant(['automation_activity']);
   const message=async(business,run,phone,status,accepted)=>db.query("insert into public.sms_messages(tenant_id,contact_phone,direction,body,status,provider_accepted_at,meta) values($1,$2,'outbound','TOP SECRET BODY',$3,case when $4 then now() end,jsonb_build_object('form_run_id',$5::text))",[business,phone,status,accepted,run]);
   await message(a,direct.run.id,direct.c.phone,'accepted',true);await message(a,direct.run.id,direct.c.phone,'delivered',true);await message(a,direct.run.id,direct.c.phone,'failed',false);
   await message(b,foreign.run.id,foreign.c.phone,'delivered',true);await message(a,other.run.id,other.c.phone,'delivered',true);
   await call(db,'activity_event',a,direct.run.id,'synthetic-history','historical_status_snapshot',null,{phone:direct.c.phone,body:'TOP SECRET BODY'},true,true);
   const first=await invoke('crm_get_sms_run_activity',{businessId:a,runId:direct.run.id,pageSize:1});assert.equal(first.ok,true,JSON.stringify(first));assert.ok(first.data.total>1);assert.equal(first.data.events.length,1);assert.equal(first.data.events[0].historical,true);assert.equal(first.data.events[0].simulated,true);assert.equal(first.data.events[0].occurredAt,null);
   assert.deepEqual(first.data.counts,{providerAccepted:2,delivered:1,failed:1,unresolvedSends:1,responses:0});
   const next=await invoke('crm_get_sms_run_activity',{businessId:a,runId:direct.run.id,pageSize:1,page:2});assert.notEqual(next.data.events[0].id,first.data.events[0].id);assert.equal(next.data.total,first.data.total);
   const all=await invoke('crm_get_sms_run_activity',{businessId:a,runId:direct.run.id});assert.ok(all.data.events.some(e=>e.operation==='stop'));assert.ok(all.data.events.some(e=>e.status==='paused'));
   for(const secret of ['TOP SECRET BODY','Private person','Secret request',direct.c.phone,'secret@example.test'])assert.equal(JSON.stringify(all).includes(secret),false);
  });
  await t.test('revocation and removed grants block replay; audit records target generations and helpers remain private',async()=>{
   assert.equal((await invoke('crm_pause_sms_run',pauseRequest)).error.code,'PERMISSION_DENIED');
   await grant(['automation_activity','automation_run_pause_stop'],'revoked');assert.equal((await invoke('crm_pause_sms_run',pauseRequest)).error.code,'PERMISSION_DENIED');assert.equal((await invoke('crm_get_sms_run',{businessId:a,runId:direct.run.id})).error.code,'PERMISSION_DENIED');
   for(const fn of ['mcp_sms_activity(text,text,text,jsonb)','mcp_sms_control(text,text,text,jsonb,uuid)','mcp_sms_run_detail(sms_private.form_runs)'])for(const role of ['crm_mcp','anon','authenticated','service_role'])assert.equal((await db.query('select has_function_privilege($1,$2,$3) ok',[role,'sms_private.'+fn,'execute'])).rows[0].ok,false);
   const audit=(await db.query('select * from sms_private.mcp_activity where connection_id=$1',[connectionId])).rows;
   assert.ok(audit.some(v=>v.target===direct.run.id&&v.revision===pauseResult.data.run.generation&&v.outcome==='replayed'));
   assert.ok(audit.some(v=>v.target===foreign.run.id&&v.outcome==='denied'),'denied substitutions retain the requested run reference');
   for(const secret of ['Private person','Secret request',direct.c.phone,'TOP SECRET BODY'])assert.equal(JSON.stringify(audit).includes(secret),false);
   assert.equal((await db.query('select count(*) n from sms_private.jobs')).rows[0].n,baselineJobs+1,'controls add no jobs beyond the synthetic uncertain fixture');
  });
 }finally{await db.close();}
});
