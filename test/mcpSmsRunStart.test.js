import test from 'node:test';import assert from 'node:assert/strict';import {z} from 'zod';
import {fixture} from './helpers/twilioConnections.js';import {call} from './helpers/database.js';
import {toolOutputs} from '../src/mcp/tools.js';import {smsRunTools} from '../src/mcp/smsRunSchemas.js';
const sequence={trigger:'submission',replyPolicy:'pause',startHour:0,endHour:24,leadHours:24,steps:[{body:'Hi {{name}}',delayCount:0,delayUnit:'minute',sendCount:2,intervalCount:1,intervalUnit:'day'}]};
test('run start schemas reject overrides and require bounded overlaps and retry keys',()=>{
 const s=z.object(smsRunTools[1][2]).strict(),p={businessId:'a',kind:'contact',automationId:crypto.randomUUID(),contactId:crypto.randomUUID(),revision:1,contactRevision:1,overlaps:[],overlapChoice:'keep',idempotencyKey:'start-key-1'};
 assert.equal(s.safeParse(p).success,true);
 for(const patch of [{sequence},{smsOptIn:true},{overlaps:Array(101).fill({id:crypto.randomUUID(),generation:1})},{contactRevision:undefined},{overlapChoice:undefined},{startAt:'2030-01-01T10:00'},{idempotencyKey:''}])assert.equal(s.safeParse({...p,...patch}).success,false);
});
test('run starts isolate scopes and preserve consent, snapshots, retries and overlap decisions',async t=>{
 const x=await fixture(),{db}=x;try{
  const {tenant:a}=await x.business('start-a'),{tenant:b}=await x.business('start-b');
  for(const business of [a,b]){await call(db,'platform_action','staff','service_add',{tenantId:business,kind:'sms'});await db.query("update public.sms_businesses set sending_enabled=true,status='active' where tenant_id=$1",[business]);}
  const makeForm=async(business,preset='contacts',phone='+13035550160',consent=true)=>{
   let f=(await call(db,'form_workspace','staff',business,'create',null,{title:'Start form',preset,fields:[],description:'',buttonLabel:'Send',enabled:false})).form;
   f=(await call(db,'form_workspace','staff',business,'save',f.public_id,{title:f.title,fields:[],description:'',buttonLabel:'Send',enabled:true})).form;
   const submission=await call(db,'submit_web_form',f.public_id,{submissionId:crypto.randomUUID(),name:'Private customer',phone,email:'private@example.test',smsOptIn:consent,details:{},...(preset==='bookings'?{appointmentAt:'2030-05-01T15:00:00Z'}:{})});
   await call(db,'form_workspace','staff',business,'publish',f.public_id,{revision:0,sequence:{...sequence,trigger:preset==='bookings'?'appointment':'submission'}});
   await call(db,'form_workspace','staff',business,'state',f.public_id,{enabled:true});
   return {businessId:business,kind:'form',automationId:f.public_id,submissionId:submission.submissionId};
  };
  const fa=await makeForm(a),fb=await makeForm(b),fq=await makeForm(a,'quote_requests','+13035550162'),booking=await makeForm(a,'bookings','+13035550163');
  const c=(await db.query("insert into public.sms_contacts(tenant_id,phone,name,marketing_consent) values($1,'+13035550161','Direct private',true) returning *",[a])).rows[0];
  const hidden=(await db.query("insert into public.sms_contacts(tenant_id,phone,name,marketing_consent) values($1,'+13035550161','Hidden',true) returning *",[b])).rows[0];
  const d=(await call(db,'contact_automations','staff',a,'publish',{name:'Published',sequence,idempotencyKey:'ui-pub-direct'})).template;
  const direct={businessId:a,kind:'contact',automationId:d.id,contactId:c.id};
  const invoke=async(tool,p={})=>{const r=await call(db,'mcp_invoke','staff','start-client',tool,p,crypto.randomUUID());if(r.ok)toolOutputs[tool].parse(r.data);return r;};
  const connectionId=(await invoke('crm_get_access')).data.connectionId;let grantRevision=0;
  const grant=async(permissions,status='active')=>{const r=await call(db,'mcp_admin','staff','save',{connectionId,revision:grantRevision,status,permissions,businessIds:[a]});grantRevision=r.connection.revision;};
  const context=p=>call(db,'mcp_sms_start_context','staff',p.businessId,p);
  const request=async(p,key=crypto.randomUUID())=>{const v=await context(p);return {...p,revision:v.automation.revision,contactRevision:v.contactRevision,overlaps:v.overlaps,overlapChoice:'keep',idempotencyKey:key,...(p.kind==='form'?{formRevision:v.automation.formRevision,submissionFingerprint:v.submissionFingerprint}:{})};};
  const start=p=>invoke('crm_start_sms_automation_run',p);
  const counts=async()=>(await db.query('select (select count(*) from sms_private.form_runs) runs,(select count(*) from sms_private.jobs) jobs,(select count(*) from public.sms_messages) messages')).rows[0];
  const baseline=await counts();let directRun,formRun,firstRequest,firstResult;
  await t.test('independent grants and scoped context reject foreign contacts, forms and submissions',async()=>{
   await grant(['automation_read','automation_publish','automation_enable']);
   assert.equal((await start(await request(direct))).error.code,'PERMISSION_DENIED');
   const r=await invoke('crm_get_sms_run_start_context',fa);assert.equal(r.ok,true,JSON.stringify(r));assert.equal(JSON.stringify(r).includes('Private customer'),false);
   for(const p of [{...direct,contactId:hidden.id},{...fa,submissionId:fb.submissionId},{...fa,automationId:fb.automationId}])assert.equal((await invoke('crm_get_sms_run_start_context',p)).error.code,'PERMISSION_DENIED');
   await grant(['automation_run_start']);assert.equal((await invoke('crm_get_sms_run_start_context',direct)).error.code,'PERMISSION_DENIED');
   assert.equal((await start({...await request(direct),contactId:hidden.id})).error.code,'PERMISSION_DENIED');
   assert.equal((await start({...await request(direct),businessId:b})).error.code,'PERMISSION_DENIED');
   assert.deepEqual(await counts(),baseline);
  });
  await t.test('direct starts pin published content, schedule once and reject changed/stale retries',async()=>{
   firstRequest={...await request(direct,'direct-start-first'),startAt:'2030-05-01T15:00:00.123Z'};firstResult=await start(firstRequest);assert.equal(firstResult.ok,true,JSON.stringify(firstResult));directRun=firstResult.data.run;
   assert.equal(new Date(directRun.nextRunAt).toISOString(),firstRequest.startAt);
   assert.equal(firstResult.data.effect,'run_scheduled');assert.equal(directRun.publishedVersion,1);assert.deepEqual(await start(firstRequest),firstResult);
   assert.equal((await start({...firstRequest,context:'Different'})).error.code,'CONFLICT');
   assert.equal((await start({...firstRequest,idempotencyKey:'new-key-stale-overlaps'})).error.code,'CONFLICT');
   assert.equal((await start({...await request(direct),sequence})).error.code,'VALIDATION_ERROR');
   assert.equal((await start({...await request(direct),revision:0})).error.code,'CONFLICT');
   const stored=(await db.query('select direct_sequence from sms_private.form_runs where id=$1',[directRun.id])).rows[0];assert.deepEqual(stored.direct_sequence,sequence);
   assert.equal((await counts()).runs,baseline.runs+1);assert.equal((await counts()).messages,baseline.messages);assert.equal((await counts()).jobs,baseline.jobs);
  });
  await t.test('form history uses recorded data and fingerprints; all form types start without changing submissions',async()=>{
   const p=await request(fa,'form-start-first');
   assert.equal((await start({...p,submissionFingerprint:'0'.repeat(64)})).error.code,'CONFLICT');
   assert.equal((await start({...p,formRevision:0})).error.code,'CONFLICT');
   await db.query("update public.sms_web_form_contact_submissions set details='{\"note\":\"edited\"}' where id=$1",[fa.submissionId]);
   assert.equal((await start(p)).error.code,'CONFLICT');
   await db.query("update public.sms_web_form_contact_submissions set details='{}' where id=$1",[fa.submissionId]);
   const r=await start(p);assert.equal(r.ok,true,JSON.stringify(r));formRun=r.data.run;assert.deepEqual(await start(p),r);
   const again=await start(await request(fa));assert.equal(again.data.effect,'already_enrolled');assert.equal(again.data.run.id,formRun.id);
   for(const target of [fq,booking]){const r=await start(await request(target));assert.equal(r.ok,true,JSON.stringify(r));}
   assert.equal((await context(fa)).submissionFingerprint,p.submissionFingerprint);
   assert.equal((await counts()).runs,baseline.runs+4);
  });
  await t.test('overlap changes conflict and replacement needs its separate grant and exact generations',async()=>{
   const p=await request(direct);p.overlapChoice='stop_selected';p.stopRunIds=[directRun.id];
   assert.equal((await start(p)).error.code,'PERMISSION_DENIED');
   await grant(['automation_run_start','automation_run_pause_stop']);
   assert.equal((await start({...p,stopRunIds:[formRun.id]})).error.code,'PERMISSION_DENIED');
   assert.equal((await start({...p,overlaps:[{id:directRun.id,generation:0}]})).error.code,'CONFLICT');
   const r=await start(p);assert.equal(r.ok,true,JSON.stringify(r));assert.deepEqual(r.data.stoppedRuns,[{id:directRun.id,generation:directRun.generation+1}]);
   assert.deepEqual(await start(p),r);assert.equal((await db.query('select status from sms_private.form_runs where id=$1',[formRun.id])).rows[0].status,'active');
   await grant(['automation_run_start']);assert.equal((await start(p)).error.code,'PERMISSION_DENIED','replacement grant checked before replay');
   const keep=await start(await request(direct));assert.equal(keep.ok,true,JSON.stringify(keep));assert.equal(keep.data.stoppedRuns.length,0);
  });
  await t.test('STOP, consent, blocks, disabled sending and runtime deny starts without consuming retry keys',async()=>{
   const p=await request(direct,'consent-retry');
   await db.query('update public.sms_contacts set opted_out=true where id=$1',[c.id]);
   assert.equal((await start(p)).error.code,'CONFLICT');
   for(const updates of ['opted_out=true','opted_out=false,marketing_consent=false','marketing_consent=true,enquiry_blocked=true']){
    await db.query('update public.sms_contacts set '+updates+' where id=$1',[c.id]);
    assert.equal((await start(await request(direct))).error.code,'VALIDATION_ERROR');
   }
   await db.query('update public.sms_contacts set enquiry_blocked=false where id=$1',[c.id]);
   await db.query('update public.sms_businesses set sending_enabled=false where tenant_id=$1',[a]);
   assert.equal((await start(await request(direct))).error.code,'VALIDATION_ERROR');
   await db.query('update public.sms_businesses set sending_enabled=true where tenant_id=$1',[a]);
   await db.query('update sms_private.runtime set direct_automations_enabled=false');assert.equal((await start(await request(direct))).error.code,'VALIDATION_ERROR');await db.query('update sms_private.runtime set direct_automations_enabled=true');
   assert.equal((await db.query('select count(*) n from sms_private.mcp_requests where connection_id=$1 and idempotency_key=$2',[connectionId,p.idempotencyKey])).rows[0].n,0);
   const noConsent=await makeForm(a,'contacts','+13035550165',false);assert.equal((await start(await request(noConsent))).error.code,'VALIDATION_ERROR');
   // Existing enrollments return their identity, never restart a finished/paused run.
   await db.query("update sms_private.form_runs set status='stopped',next_run_at=null where id=$1",[formRun.id]);
   const existing=await start(await request(fa));assert.equal(existing.data.effect,'already_enrolled');assert.equal(existing.data.run.status,'stopped');
  });
  await t.test('same-form duplicate and appointment cutoff protections do not stop unrelated runs',async()=>{
   const fresh=await makeForm(a,'contacts','+13035550162');
   const r=await start(await request(fresh));assert.equal(r.ok,true,JSON.stringify(r));
   const extra=await call(db,'submit_web_form',fresh.automationId,{submissionId:crypto.randomUUID(),name:'Another',phone:'+13035550162',email:'another@example.test',smsOptIn:true,details:{}});
   const target={...fresh,submissionId:extra.submissionId};
   assert.equal((await start(await request(target))).error.code,'CONFLICT');
   await grant(['automation_run_start','automation_run_pause_stop']);const p=await request(target);p.overlapChoice='stop_selected';p.stopRunIds=[r.data.run.id];
   const replaced=await start(p);assert.equal(replaced.ok,true,JSON.stringify(replaced));assert.equal(replaced.data.stoppedRuns.length,1);
   const past=await makeForm(a,'bookings','+13035550166');
   // Age a valid synthetic fixture to model time passing. Production writes
   // correctly forbid changing an appointment or initially submitting a past one.
   await db.exec("begin; set local session_replication_role='replica'");
   await db.query("update public.sms_web_form_booking_submissions set appointment_at='2020-01-01' where id=$1",[past.submissionId]);await db.exec('commit');
   assert.equal((await start(await request(past))).error.code,'VALIDATION_ERROR');
  });
  await t.test('revocation blocks replay; helper access and audit redact recipient/context data',async()=>{
   await grant([],'disabled');assert.equal((await start(firstRequest)).error.code,'PERMISSION_DENIED');
   for(const signature of ['mcp_sms_start(text,text,jsonb,uuid,boolean)','mcp_sms_start_context(text,text,jsonb)'])assert.equal((await db.query('select has_function_privilege($1,$2,$3) ok',['crm_mcp','sms_private.'+signature,'execute'])).rows[0].ok,false);
   const audit=(await db.query('select * from sms_private.mcp_activity where connection_id=$1',[connectionId])).rows;
   assert.ok(audit.some(v=>v.target===directRun.id&&v.revision===directRun.generation));assert.ok(audit.some(v=>v.tool==='crm_start_sms_automation_run:replace'));
   for(const secret of ['Private customer','Direct private','+13035550161','Hi {{name}}'])assert.equal(JSON.stringify(audit).includes(secret),false);
   assert.equal((await counts()).messages,baseline.messages);assert.equal((await counts()).jobs,baseline.jobs);
  });
 }finally{await db.close();}
});
