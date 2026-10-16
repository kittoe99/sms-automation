import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './helpers/twilioConnections.js';
import {call} from './helpers/database.js';
import {emptySequence,newMessage,validateSequence,sequenceSummary} from '../public/formAutomation.js';
import {smsSequenceSchema} from '../src/mcp/smsSchemas.js';
import {toolOutputs} from '../src/mcp/tools.js';
const sequence=()=>({...emptySequence(),instantAcknowledgment:true,startHour:9,endHour:18,steps:[newMessage('Received {{first_name}}'),{...newMessage('Follow-up'),delayCount:2}]});

test('instant acknowledgment is an explicit boolean with zero first delay',()=>{
 const cfg=sequence();assert.equal(validateSequence(cfg).instantAcknowledgment,true);assert.equal(smsSequenceSchema.parse(cfg).instantAcknowledgment,true);
 assert.match(sequenceSummary(cfg),/outside sending hours/);
 for(const patch of [{instantAcknowledgment:'true'},{trigger:'appointment'},{steps:[{...newMessage('Hi'),delayCount:1}]}])assert.throws(()=>validateSequence({...cfg,...patch}));
 assert.equal(smsSequenceSchema.safeParse({...cfg,instantAcknowledgment:'true'}).success,false);
 assert.equal(Object.hasOwn(validateSequence({...emptySequence(),steps:[newMessage('Hi')]}),'instantAcknowledgment'),false);
});

test('instant form acknowledgment is scoped, consent gated, revision protected and enforced at dispatch',async t=>{
 const x=await fixture(),{db}=x;
 try{
 const {tenant}=await x.business('instant-owner');await call(db,'platform_action','staff','service_add',{tenantId:tenant,kind:'sms'});
 const act=(action,id,p={})=>call(db,'form_workspace','staff',tenant,action,id,p);
 const f=(await act('create',null,{title:'Instant test',preset:'quote_requests',fields:[],description:'',buttonLabel:'Send',enabled:false})).form;
 const invoke=async(tool,p={})=>{const r=await call(db,'mcp_invoke','staff','instant-client',tool,p,crypto.randomUUID());if(r.ok)toolOutputs[tool].parse(r.data);return r;};
 const connectionId=(await invoke('crm_get_access')).data.connectionId;
 await call(db,'mcp_admin','staff','save',{connectionId,revision:0,status:'active',permissions:['automation_read','automation_draft','automation_preview'],businessIds:[tenant]});
 const create={businessId:tenant,kind:'form',automationId:f.public_id,formRevision:f.version,sequence:sequence(),idempotencyKey:'instant-create-1'};
 const created=await invoke('crm_create_sms_automation',create);assert.equal(created.ok,true,JSON.stringify(created));
 const a=created.data.automation;
 await t.test('draft retry, conflict and projection retain the opt-in without enabling anything',async()=>{
  assert.deepEqual((await invoke('crm_create_sms_automation',create)).data,created.data);
  assert.equal((await invoke('crm_create_sms_automation',{...create,sequence:{...sequence(),instantAcknowledgment:false}})).error.code,'CONFLICT');
  const read=await invoke('crm_get_sms_automation',{businessId:tenant,kind:'form',automationId:f.public_id});
  assert.equal(read.data.automation.draft.instantAcknowledgment,true);assert.equal(read.data.automation.enabled,false);assert.equal(read.data.automation.publishedVersion,null);
  const stale=await invoke('crm_save_sms_automation_draft',{...create,revision:0,idempotencyKey:'stale-instant-1'});assert.equal(stale.error.code,'CONFLICT');
  for(const bad of [{instantAcknowledgment:'true'},{trigger:'appointment'},{steps:[{...newMessage('Hi'),delayCount:1}]}])await assert.rejects(()=>call(db,'validate_form_sequence',{...sequence(),...bad},[],true),/Instant acknowledgment/);
  await assert.rejects(()=>call(db,'direct_validate',sequence()),/only available for form/);
 });
 const preview=(smsOptIn=true,extra={})=>invoke('crm_preview_sms_automation',{businessId:tenant,kind:'form',automationId:f.public_id,revision:a.revision,formRevision:f.version,source:'draft',submittedLocal:'2030-03-09T22:00',sample:{name:'Alex Example',phone:'+13035550160',email:'alex@example.test',smsOptIn,details:{}},...extra});
 await t.test('after-hours preview sends first immediately, later steps and repeats keep hours',async()=>{
  const r=await preview();assert.equal(r.ok,true,JSON.stringify(r));assert.equal(new Date(r.data.rows[0].at).toISOString(),'2030-03-10T05:00:00.000Z');assert.equal(new Date(r.data.rows[1].at).toISOString(),'2030-03-12T15:00:00.000Z');
  const no=await preview(false);assert.deepEqual(no.data.rows,[]);assert.match(no.data.outcome,/consent was not selected/);
  const legacy=await preview(true,{source:'input',sequence:{...sequence(),instantAcknowledgment:false}});assert.equal(new Date(legacy.data.rows[0].at).toISOString(),'2030-03-10T15:00:00.000Z');
  const repeated=await preview(true,{source:'input',sequence:{...sequence(),steps:[{...newMessage('Repeat'),sendCount:2,intervalUnit:'minute'}]}});
  assert.equal(repeated.data.rows[0].at,r.data.rows[0].at);assert.equal(repeated.data.rows[1].at,legacy.data.rows[0].at);
  for(const scenario of ['reply','opt_out']){const p=await preview(true,{scenario});assert.equal(p.data.rows.length,1);assert.match(p.data.outcome,scenario==='reply'?/Paused:/ : /Stopped:/);}
  const fold=await call(db,'form_due','2030-11-03T07:30:00Z',0,'minute','America/Denver',0,24);assert.equal(new Date(fold).toISOString(),'2030-11-03T07:30:00.000Z');
 });
 await t.test('real database enrollment and sender preparation preserve consent and future windows',async()=>{
  await db.exec('begin');
  const hour=(await db.query("select extract(hour from now() at time zone 'UTC')::int h")).rows[0].h,start=(hour+2)%24;
  const cfg={...sequence(),startHour:start,endHour:start+1,steps:[{...newMessage('Received {{first_name}}'),sendCount:2,intervalUnit:'minute'},newMessage('Later')]};
  await db.query("update public.sms_businesses set sending_enabled=true,status='active',time_zone='UTC' where tenant_id=$1",[tenant]);
  await db.query("update sms_private.providers set provisioning_state='configured',account_sid='AC'||repeat('1',32),from_number='+18775552060',auth_secret_id=vault.create_secret('test-secret') where tenant_id=$1",[tenant]);
  await act('save',f.public_id,{title:f.title,description:'',buttonLabel:'Send',fields:[],enabled:true});
  await act('publish',f.public_id,{revision:a.revision,sequence:cfg});await act('state',f.public_id,{enabled:true});
  const submit=(consent,phone='+13035550160')=>call(db,'submit_web_form',f.public_id,{submissionId:crypto.randomUUID(),name:'Alex Example',phone,email:'alex@example.test',smsOptIn:consent,details:{}});
  await submit(false);assert.equal((await db.query('select count(*) n from sms_private.form_runs')).rows[0].n,0);
  await submit(true);let run=(await db.query('select *,next_run_at=now() immediate from sms_private.form_runs')).rows[0];assert.equal(run.immediate,true);
  await submit(true);assert.equal((await db.query('select count(*) n from sms_private.form_runs')).rows[0].n,1,'Overlap must not duplicate acknowledgment');
  assert.equal(await call(db,'enqueue_due_automations'),1);assert.equal(await call(db,'enqueue_due_automations'),0);
  const job=(await db.query("select * from sms_private.jobs where queue='automation_jobs' and status='queued'")).rows[0],token=crypto.randomUUID();
  const lease=id=>db.query("update sms_private.jobs set status='processing',lease_token=$2,leased_until=now()+interval '5 minutes' where id=$1",[id,token]);
  await lease(job.id);const out=await call(db,'process_form_automation',job.id,token);assert.ok(out.messageId);
  const send=(await db.query('select * from sms_private.jobs where id=$1',[out.jobId])).rows[0];assert.equal(send.payload.request.start_hour,0);assert.equal(send.payload.request.end_hour,24);
  await lease(out.jobId);const prepared=await call(db,'begin_submission',out.jobId,token);assert.ok(prepared?.attempt_id,'Final send gate must allow the immediate acknowledgment');
  // No network/provider call: exercise durable acceptance and duplicate callback locally.
  await call(db,'accept_attempt',prepared.attempt_id,'SM'+'1'.repeat(32));await call(db,'accept_attempt',prepared.attempt_id,'SM'+'1'.repeat(32));
  run=(await db.query('select *,next_run_at>now() later from sms_private.form_runs')).rows[0];assert.equal(run.send_index,1);assert.equal(run.repeat_index,1);assert.equal(run.later,true);
  const dueHour=(await db.query("select extract(hour from next_run_at at time zone 'UTC')::int h from sms_private.form_runs")).rows[0].h;assert.equal(dueHour,start);
  // A forced early wake cannot bypass the window for the repeat.
  await db.query('update sms_private.form_runs set next_run_at=now() where id=$1',[run.id]);await call(db,'enqueue_due_automations');
  const repeat=(await db.query("select * from sms_private.jobs where queue='automation_jobs' and status='queued'")).rows[0];await lease(repeat.id);assert.equal(await call(db,'process_form_automation',repeat.id,token),null);
  assert.equal((await db.query('select count(*) n from public.sms_messages where direction=\'outbound\'')).rows[0].n,1);
  // Another phone's unchecked submission remains excluded even though a draft/published rule exists.
  await submit(false,'+13035550161');assert.equal((await db.query('select count(*) n from sms_private.form_runs')).rows[0].n,1);
  await db.exec('rollback');
 });
 }finally{await db.close();}
});

