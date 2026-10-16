import test from 'node:test';
import assert from 'node:assert/strict';
import {z} from 'zod';
import {fixture} from './helpers/twilioConnections.js';
import {call} from './helpers/database.js';
import {formApplyTools} from '../src/mcp/formSchemas.js';
import {toolOutputs} from '../src/mcp/tools.js';
import {connectionPermissionNames} from '../public/mcpPermissions.js';

const old={title:'Applied title',description:'Original',buttonLabel:'Submit',fields:[
 {key:'items',label:'Original label',type:'textarea',required:true},{key:'obsolete',label:'Historical field',type:'text',required:false}]};
const definition={...old,title:'Saved draft title',description:'Saved draft description',buttonLabel:'Request help',fields:[{...old.fields[0],label:'New label'}]};
const sequence=key=>({trigger:'submission',leadHours:24,replyPolicy:'pause',startHour:0,endHour:24,
 steps:[{body:'Hi {{field.'+key+'}}',delayCount:0,delayUnit:'day',sendCount:1,intervalCount:1,intervalUnit:'day'}]});

test('applying forms requires strict IDs, both revisions and a retry key, never inline definitions or activation',()=>{
 const schema=z.object(formApplyTools[0][2]).strict(),p={businessId:'a',formId:crypto.randomUUID(),revision:2,draftRevision:1,idempotencyKey:'apply-12345'};
 assert.ok(schema.safeParse(p).success);
 for(const patch of [{businessId:''},{businessId:' '},{formId:'invalid'},{revision:0},{revision:null},{revision:1.5},{revision:1e100},{draftRevision:-1},{draftRevision:'1'},
  {idempotencyKey:'short'},{idempotencyKey:null},{definition},{enabled:true},{collectionEnabled:false},{emailEnabled:true},{force:true},{rebase:true},{preset:'bookings'}])assert.equal(schema.safeParse({...p,...patch}).success,false);
 for(const key of Object.keys(p)){const v={...p};delete v[key];assert.equal(schema.safeParse(v).success,false);}
});

test('saved drafts apply atomically with scope, revisions, retries and no collection or messaging changes',async t=>{
 const x=await fixture(),{db}=x;
 try{
  const {tenant:a}=await x.business('allowed'),{tenant:b}=await x.business('hidden');
  // Seeds canonical form-routing groups in this disposable DB; no workers run.
  await call(db,'platform_action','staff','service_add',{tenantId:a,kind:'sms'});
  const invoke=async(tool,p={},user='staff')=>{
   const r=(await db.query('select crm_mcp.invoke($1,$2,$3,$4,$5) r',[user,'apply-client',tool,JSON.stringify(p),crypto.randomUUID()])).rows[0].r;
   if(r.ok)toolOutputs[tool].parse(r.data);return r;
  };
  const connectionId=(await invoke('crm_get_access')).data.connectionId;let connectionRevision=0;
  const grant=async(permissions,{businessIds=[a],status='active'}={})=>{
   const r=await call(db,'mcp_admin','staff','save',{connectionId,revision:connectionRevision,permissions,businessIds,status});connectionRevision=r.connection.revision;
  };
  const create=async(key,preset='contacts')=>{
   const r=await invoke('crm_create_form',{businessId:a,preset,definition:old,idempotencyKey:key});assert.equal(r.ok,true,JSON.stringify(r));return r.data.form;
  };
  const save=async(f,def=definition)=>{
   const r=await invoke('crm_save_form_draft',{businessId:a,formId:f.id,revision:f.revision,draftRevision:f.draftRevision,definition:def,idempotencyKey:crypto.randomUUID()});
   assert.equal(r.ok,true,JSON.stringify(r));return r.data.form;
  };
  const input=f=>({businessId:a,formId:f.id,revision:f.revision,draftRevision:f.draftRevision,idempotencyKey:crypto.randomUUID()});
  const blank={businessId:a,formId:crypto.randomUUID(),revision:2,draftRevision:1,idempotencyKey:'pending-apply'};
  assert.equal((await invoke('crm_apply_form_draft',blank)).error.code,'PERMISSION_DENIED');
  await grant(['form_create','form_edit']);
  const inactive=await save(await create('inactive-form')),active=await save(await create('active-form','quote_requests')),booking=await save(await create('booking-form','bookings'));
  await db.query('update public.sms_web_form_definitions set enabled=true,email_enabled=true,legacy_form=true where public_id=$1',[active.id]);
  // Local-only historic submission: no SMS consent, workers, or provider calls.
  const history=await call(db,'submit_web_form',active.id,{submissionId:crypto.randomUUID(),name:'Test',phone:'+17208429167',email:'test@example.test',smsOptIn:false,details:{items:'Historical answer',obsolete:'Retain this answer'}});
  assert.ok(history.submissionId);
  // Applying definitions must not fire the lifecycle trigger that cancels even
  // paused email when a disabled/no-email form's enabled column is mentioned.
  for(const f of [inactive,active,booking])for(const status of ['active','paused']){
   await db.query(`insert into sms_private.email_enrollments(tenant_id,group_id,source_type,source_id,form_public_id,email,name,rule_snapshot,status)
    select $1,group_id,'contacts',gen_random_uuid(),$2,'test@example.test','Test',rule,$3 from sms_private.email_group_settings where tenant_id=$1 limit 1`,[a,f.id,status]);
  }
  for(const f of [inactive,active]){
   await db.query('insert into sms_private.form_sequences(tenant_id,form_id,published_version,enabled,draft) values($1,$2,2,true,$3)',[a,f.id,JSON.stringify(sequence('items'))]);
   for(const [version,key] of [[1,'obsolete'],[2,'items']])await db.query('insert into sms_private.form_sequence_versions(tenant_id,form_id,version,sequence) values($1,$2,$3,$4)',[a,f.id,version,JSON.stringify(sequence(key))]);
   await db.query("insert into sms_private.form_runs(tenant_id,form_id,version,submission_id,phone,context,status,next_run_at) values($1,$2,1,gen_random_uuid(),'+17208429167','{\"field.obsolete\":\"Original snapshot\"}','active',now()+interval '1 day')",[a,f.id]);
  }
  const foreign=(await call(db,'form_workspace','staff',b,'create',null,{...old,preset:'contacts'})).form;
  const missing=(await call(db,'form_workspace','staff',a,'create',null,{...old,preset:'contacts'})).form;
  const untouched=['public.sms_contacts','public.sms_businesses','sms_private.form_sequences','sms_private.form_sequence_versions','sms_private.form_runs','sms_private.jobs','sms_private.email_enrollments','sms_private.email_jobs','pgmq.test_messages','net.test_requests',
   'public.sms_web_form_contact_submissions','public.sms_web_form_quote_request_submissions','public.sms_web_form_booking_submissions'];
  const domain=[...untouched,'public.sms_web_form_definitions','sms_private.mcp_form_drafts','sms_private.mcp_requests','public.dashboard_cache_versions'];
  const snapshot=async(tables=domain)=>{const out={};for(const table of tables)out[table]=(await db.query(`select coalesce(jsonb_agg(to_jsonb(x) order by to_jsonb(x)::text),'[]') value from ${table} x`)).rows[0].value;return out;};
  const requests=[];
  await t.test('all other permissions combined cannot imply apply; failed calls leave domain state unchanged',async()=>{
   await grant(connectionPermissionNames.filter(p=>p!=='form_publish'));const before=await snapshot();
   assert.equal((await invoke('crm_apply_form_draft',input(inactive))).error.code,'PERMISSION_DENIED');
   assert.deepEqual(await snapshot(),before);
   await grant(['form_publish']);
   for(const tool of ['crm_create_form','crm_save_form_draft','crm_preview_form','crm_set_form_followups_enabled','crm_start_sms_automation_run'])assert.equal((await invoke(tool,input(inactive))).error.code,'PERMISSION_DENIED');
  });
  await t.test('apply updates only definitions and draft metadata; existing collection/consent and SMS snapshots stay intact',async()=>{
   const before=await snapshot(untouched);
   const cacheBefore=(await db.query('select revision from public.dashboard_cache_versions where scope=$1',['tenant:'+a])).rows[0].revision;
   for(const f of [inactive,active,booking]){
    const p=input(f),r=await invoke('crm_apply_form_draft',p);assert.equal(r.ok,true,JSON.stringify(r));requests.push([p,r]);
    const result=r.data.form;assert.deepEqual(result.definition,definition);assert.deepEqual(result.draft,definition);
    assert.equal(result.revision,3);assert.equal(result.draftRevision,3);assert.equal(result.draftBaseRevision,3);assert.equal(result.draftStale,false);
    assert.equal(r.data.previousRevision,2);assert.equal(r.data.appliedDraftRevision,2);
    assert.equal(result.collectionEnabled,f.id===active.id);assert.equal(result.emailConsentEnabled,f.id===active.id);assert.equal(result.preset,f.preset);
    const publicForm=await call(db,'public_web_form',f.id);
    if(f.id===active.id){assert.equal(publicForm.title,definition.title);assert.deepEqual(publicForm.fields,definition.fields);assert.equal(publicForm.emailEnabled,true);}
    else assert.equal(publicForm,null);
   }
   assert.deepEqual(await snapshot(untouched),before);
   const cacheAfter=(await db.query('select revision from public.dashboard_cache_versions where scope=$1',['tenant:'+a])).rows[0].revision;
   assert.ok(cacheAfter>cacheBefore,'Canonical E2 cache invalidation must remain intact');
   const historical=(await db.query('select field_snapshot,form_version,details from public.sms_web_form_quote_request_submissions where id=$1',[history.submissionId])).rows[0];
   assert.deepEqual(historical.field_snapshot,old.fields);assert.equal(historical.form_version,2);assert.equal(historical.details.obsolete,'Retain this answer');
  });
  await t.test('identical retries return the original snapshot; changed keys and competing stale apply requests conflict',async()=>{
   const [p,r]=requests[0],before=await snapshot();
   assert.deepEqual(await invoke('crm_apply_form_draft',p),r);
   assert.equal((await invoke('crm_apply_form_draft',{...p,revision:3})).error.code,'CONFLICT');
   assert.equal((await invoke('crm_apply_form_draft',{...p,idempotencyKey:'stale-apply'})).error.code,'CONFLICT');
   assert.deepEqual(await snapshot(),before);
   await grant(['form_edit','form_publish']);const next=await save(r.data.form,{...definition,title:'Next private draft'});
   assert.equal(next.draftRevision,4);assert.equal(next.definition.title,definition.title);
   assert.deepEqual(await invoke('crm_apply_form_draft',p),r,'Lost-response retry cannot apply the newer draft');
  });
  await t.test('scope substitution, missing drafts and SQL payload bypass attempts never mutate forms',async()=>{
   await grant(['form_publish'],{businessIds:[a,b]});const before=await snapshot();
   for(const p of [{...input(active),businessId:b},{...input(active),formId:foreign.public_id},{...input(active),formId:crypto.randomUUID()}])assert.equal((await invoke('crm_apply_form_draft',p)).error.code,'PERMISSION_DENIED');
   assert.equal((await invoke('crm_apply_form_draft',{...input(active),formId:missing.public_id})).error.code,'VALIDATION_ERROR');
   for(const patch of [{definition},{enabled:true},{emailEnabled:false},{force:true},{rebase:true},{revision:0},{revision:null},{revision:'3'},{revision:1.2},{revision:1e100},{draftRevision:null},{formId:'bad'},{idempotencyKey:null},{idempotencyKey:'short'}]){
    const r=await invoke('crm_apply_form_draft',{...input(active),...patch});assert.equal(r.error.code,'VALIDATION_ERROR',JSON.stringify(patch));
   }
   assert.deepEqual(await snapshot(),before);
  });
  await t.test('archived forms and drafts based on older applied definitions cannot be published or automatically rebased',async()=>{
   await grant(['form_create','form_edit','form_publish']);const stale=await save(await create('stale-base-form'));
   await call(db,'form_workspace','staff',a,'save',stale.id,{...old,title:'Newer human edit',enabled:false});
   const before=await snapshot();assert.equal((await invoke('crm_apply_form_draft',{...input(stale),revision:3})).error.code,'CONFLICT');
   assert.deepEqual(await snapshot(),before);
   await call(db,'form_workspace','staff',a,'archive',stale.id,{});
   assert.equal((await invoke('crm_apply_form_draft',{...input(stale),revision:3})).error.code,'VALIDATION_ERROR');
  });
  await t.test('current SMS draft/published field dependencies block apply without leaking rules or changing them',async()=>{
   for(const source of ['draft','published']){
    const f=await save(await create('dependent-'+source),{...definition,fields:[]});
    await db.query('insert into sms_private.form_sequences(tenant_id,form_id,draft,published_version) values($1,$2,$3,$4)',[a,f.id,JSON.stringify(source==='draft'?sequence('items'):{}),source==='published'?1:null]);
    if(source==='published')await db.query('insert into sms_private.form_sequence_versions(tenant_id,form_id,version,sequence) values($1,$2,1,$3)',[a,f.id,JSON.stringify(sequence('items'))]);
    await grant(['form_publish']);const before=await snapshot(),r=await invoke('crm_apply_form_draft',input(f));
    assert.equal(r.error.code,'VALIDATION_ERROR');assert.match(r.error.message,/incompatible with existing SMS rules/);assert.equal(r.error.message.includes('items'),false);
    assert.deepEqual(await snapshot(),before);await grant(['form_create','form_edit','form_publish']);
   }
  });
  await t.test('retry persistence failure rolls back definition, draft revision and cache changes atomically',async()=>{
   const f=await save(await create('rollback-form')),p=input(f),before=await snapshot();
   await db.exec(`create function sms_private.test_fail_apply() returns trigger language plpgsql as $$ begin raise exception 'fixture failure' using errcode='08006'; end $$;
    create trigger test_fail_apply before insert on sms_private.mcp_requests for each row execute function sms_private.test_fail_apply();`);
   assert.equal((await invoke('crm_apply_form_draft',p)).error.code,'TEMPORARY_FAILURE');assert.deepEqual(await snapshot(),before);
   await db.exec('drop trigger test_fail_apply on sms_private.mcp_requests; drop function sms_private.test_fail_apply()');
   const r=await invoke('crm_apply_form_draft',p);assert.equal(r.ok,true,JSON.stringify(r));assert.deepEqual(await invoke('crm_apply_form_draft',p),r);
  });
  await t.test('audit records both resulting revisions and the restricted role cannot bypass the gateway',async()=>{
   await grant(['form_publish']);await db.exec('set role crm_mcp');
   try{
    assert.deepEqual(await invoke('crm_apply_form_draft',requests[1][0]),requests[1][1]);
    await assert.rejects(db.query('select sms_private.mcp_form_apply($1,$2,$3,$4)',['staff',a,JSON.stringify(input(active)),connectionId]),/permission denied/);
   }finally{await db.exec('reset role');}
   for(const role of ['anon','authenticated','service_role','crm_mcp','sms_api'])assert.equal((await db.query("select has_function_privilege($1,'sms_private.mcp_form_apply(text,text,jsonb,uuid)','execute') allowed",[role])).rows[0].allowed,false);
   const audits=(await db.query("select * from sms_private.mcp_activity where connection_id=$1 and tool='crm_apply_form_draft'",[connectionId])).rows;
   assert.ok(audits.some(r=>r.target===inactive.id&&r.revision===3&&r.draft_revision===3&&r.outcome==='success'));
   assert.ok(audits.some(r=>r.outcome==='replayed'));assert.ok(audits.some(r=>r.outcome==='denied'));assert.ok(audits.every(r=>r.actor_id===x.admin&&r.request_id));
   for(const value of [definition.title,definition.description,'Historical answer','17208429167'])assert.equal(JSON.stringify(audits).includes(value),false);
  });
  await t.test('scope, staff, grants and revocation fence even completed retries',async()=>{
   const p=requests[1][0];await grant(['form_publish'],{businessIds:[]});assert.equal((await invoke('crm_apply_form_draft',p)).error.code,'PERMISSION_DENIED');
   await grant([]);assert.equal((await invoke('crm_apply_form_draft',p)).error.code,'PERMISSION_DENIED');await grant(['form_publish']);
   await db.query("update public.dashboard_accounts set status='suspended' where id=$1",[x.admin]);assert.equal((await invoke('crm_apply_form_draft',p)).error.code,'PERMISSION_DENIED');
   await db.query("update public.dashboard_accounts set status='active' where id=$1",[x.admin]);assert.equal((await invoke('crm_apply_form_draft',p,'reader')).error.code,'PERMISSION_DENIED');
   await grant(['form_publish'],{status:'revoked'});assert.equal((await invoke('crm_apply_form_draft',p)).error.code,'PERMISSION_DENIED');
  });
 }finally{await db.close();}
});
