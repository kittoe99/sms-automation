import test from 'node:test';
import assert from 'node:assert/strict';
import {z} from 'zod';
import {fixture} from './helpers/twilioConnections.js';
import {call} from './helpers/database.js';
import {formCollectionTools} from '../src/mcp/formSchemas.js';
import {toolOutputs} from '../src/mcp/tools.js';
import {connectionPermissionNames} from '../public/mcpPermissions.js';

const tool='crm_set_form_collection_enabled';
const definition={title:'Applied collection title',description:'Applied content',buttonLabel:'Submit',fields:[]};
const invalid=[{businessId:''},{businessId:' '},{formId:'bad'},{revision:0},{revision:null},{revision:'2'},{revision:1.2},{revision:1e100},
 {draftRevision:-1},{draftRevision:null},{draftRevision:'1'},{enabled:null},{enabled:'false'},{idempotencyKey:'short'},
 {definition},{emailEnabled:true},{followupsEnabled:true},{force:true},{rebase:true}];
test('collection control requires strict scope, both revisions, an explicit boolean and retry key',()=>{
 const schema=z.object(formCollectionTools[0][2]).strict(),p={businessId:'a',formId:crypto.randomUUID(),revision:2,draftRevision:1,enabled:true,idempotencyKey:'collection-test'};
 assert.ok(schema.safeParse(p).success);assert.ok(schema.safeParse({...p,draftRevision:0,enabled:false}).success);
 for(const patch of invalid)assert.equal(schema.safeParse({...p,...patch}).success,false,JSON.stringify(patch));
 for(const key of Object.keys(p)){const v={...p};delete v[key];assert.equal(schema.safeParse(v).success,false);}
});

test('collection changes are scoped, independently granted, atomic and never start messaging',async t=>{
 const x=await fixture(),{db}=x;
 try{
  const {tenant:a}=await x.business('collection-allowed'),{tenant:b}=await x.business('collection-hidden');
  await call(db,'platform_action','staff','service_add',{tenantId:a,kind:'sms'});
  const invoke=async(name,p={},user='staff')=>{
   const r=(await db.query('select crm_mcp.invoke($1,$2,$3,$4,$5) r',[user,'collection-client',name,JSON.stringify(p),crypto.randomUUID()])).rows[0].r;
   if(r.ok)toolOutputs[name].parse(r.data);return r;
  };
  const connectionId=(await invoke('crm_get_access')).data.connectionId;let connectionRevision=0;
  const grant=async(permissions,{businessIds=[a],status='active'}={})=>{
   const r=await call(db,'mcp_admin','staff','save',{connectionId,revision:connectionRevision,permissions,businessIds,status});connectionRevision=r.connection.revision;
  };
  const create=async(preset='contacts')=>{
   await grant(['form_create','form_activate','form_edit']);
   const r=await invoke('crm_create_form',{businessId:a,preset,definition,idempotencyKey:crypto.randomUUID()});assert.equal(r.ok,true,JSON.stringify(r));return r.data.form;
  };
  const input=(f,enabled=true)=>({businessId:a,formId:f.id,revision:f.revision,draftRevision:f.draftRevision??0,enabled,idempotencyKey:crypto.randomUUID()});
  const untouched=['public.sms_contacts','public.sms_businesses','sms_private.form_sequences','sms_private.form_sequence_versions','sms_private.jobs','sms_private.email_jobs','pgmq.test_messages','net.test_requests',
   'public.sms_web_form_contact_submissions','public.sms_web_form_quote_request_submissions','public.sms_web_form_booking_submissions'];
  const domain=[...untouched,'public.sms_web_form_definitions','sms_private.mcp_form_drafts','sms_private.form_runs','sms_private.email_enrollments','sms_private.mcp_requests','public.dashboard_cache_versions'];
  const snapshot=async(tables=domain)=>{const out={};for(const table of tables)out[table]=(await db.query(`select coalesce(jsonb_agg(to_jsonb(x) order by to_jsonb(x)::text),'[]') value from ${table} x`)).rows[0].value;return out;};
  const blank={businessId:a,formId:crypto.randomUUID(),revision:2,draftRevision:1,enabled:true,idempotencyKey:'pending-control'};
  assert.equal((await invoke(tool,blank)).error.code,'PERMISSION_DENIED');
  const f=await create();let activation;
  await t.test('all other permissions combined do not grant collection control',async()=>{
   await grant(connectionPermissionNames.filter(p=>p!=='form_activate'));const before=await snapshot();
   assert.equal((await invoke(tool,input(f))).error.code,'PERMISSION_DENIED');assert.deepEqual(await snapshot(),before);
   await grant(['form_activate']);
   for(const name of ['crm_apply_form_draft','crm_save_form_draft','crm_create_form','crm_set_form_followups_enabled','crm_start_sms_automation_run','crm_resume_sms_run'])assert.equal((await invoke(name,input(f))).error.code,'PERMISSION_DENIED');
  });
  await t.test('activation uses applied content, preserves a distinct saved draft and invalidates E2 cache',async()=>{
   await grant(['form_edit','form_activate']);
   const edited=(await invoke('crm_save_form_draft',{...input(f),enabled:undefined,definition:{...definition,title:'Unapplied private title'}})).data.form;
   const before=await snapshot([...untouched,'sms_private.form_runs','sms_private.email_enrollments']);
   const cacheBefore=(await db.query('select revision from public.dashboard_cache_versions where scope=$1',['tenant:'+a])).rows[0].revision;
   const p=input(edited),r=await invoke(tool,p);assert.equal(r.ok,true,JSON.stringify(r));activation=[p,r];
   assert.equal(r.data.effect,'activated');assert.equal(r.data.form.collectionEnabled,true);assert.equal(r.data.form.revision,3);
   assert.equal(r.data.form.draft.title,'Unapplied private title');assert.equal(r.data.form.definition.title,definition.title);
   assert.equal(r.data.form.draftRevision,3);assert.equal(r.data.form.draftBaseRevision,3);assert.equal(r.data.form.draftStale,false);
   assert.equal(r.data.pausedSmsRuns,0);assert.equal(r.data.cancelledEmailEnrollments,0);assert.equal(r.data.inFlightMayDeliver,false);
   assert.equal((await call(db,'public_web_form',f.id)).title,definition.title);
   assert.ok((await db.query('select revision from public.dashboard_cache_versions where scope=$1',['tenant:'+a])).rows[0].revision>cacheBefore);
   assert.deepEqual(await snapshot([...untouched,'sms_private.form_runs','sms_private.email_enrollments']),before);
  });
  await t.test('identical retries, stale requests, changed payloads and no-op requests preserve state',async()=>{
   const [p,r]=activation,before=await snapshot();assert.deepEqual(await invoke(tool,p),r);
   assert.equal((await invoke(tool,{...p,enabled:false})).error.code,'CONFLICT');
   assert.equal((await invoke(tool,{...p,idempotencyKey:crypto.randomUUID()})).error.code,'CONFLICT');
   assert.deepEqual(await snapshot(),before);
   const noOp=await invoke(tool,input(r.data.form));assert.equal(noOp.data.effect,'unchanged');assert.deepEqual(noOp.data.form,r.data.form);
   const off=await invoke(tool,input(r.data.form,false));assert.equal(off.data.effect,'deactivated');assert.equal(await call(db,'public_web_form',f.id),null);
   assert.deepEqual(await invoke(tool,p),r,'A retry returns the original response, never reactivates');
   assert.equal((await db.query('select enabled from public.sms_web_form_definitions where public_id=$1',[f.id])).rows[0].enabled,false);
  });
  await t.test('scope substitution and direct SQL schema bypass attempts cannot change forms',async()=>{
   const foreign=(await call(db,'form_workspace','staff',b,'create',null,{...definition,preset:'contacts'})).form;
   await grant(['form_activate'],{businessIds:[a,b]});const before=await snapshot();
   for(const p of [{...input(f),businessId:b},{...input(f),formId:foreign.public_id},{...input(f),formId:crypto.randomUUID()}])assert.equal((await invoke(tool,p)).error.code,'PERMISSION_DENIED');
   for(const patch of invalid)assert.ok(['VALIDATION_ERROR','PERMISSION_DENIED'].includes((await invoke(tool,{...input(f),...patch})).error.code),JSON.stringify(patch));
   assert.deepEqual(await snapshot(),before);
  });
  await t.test('all presets, no private draft, stale bases and archived states are handled explicitly',async()=>{
   for(const preset of ['contacts','quote_requests','bookings']){
    const fresh=await create(preset);assert.equal((await invoke(tool,input(fresh))).data.form.preset,preset);
   }
   const bare=(await call(db,'form_workspace','staff',a,'create',null,{...definition,preset:'contacts'})).form;
   const enabled=await invoke(tool,{...input(f),formId:bare.public_id,revision:bare.version,draftRevision:0});assert.equal(enabled.ok,true,JSON.stringify(enabled));assert.equal(enabled.data.form.draft,null);
   const stale=await create();await call(db,'form_workspace','staff',a,'save',stale.id,{...definition,title:'Human applied edit',enabled:false});
   const result=await invoke(tool,{...input(stale),revision:3});assert.equal(result.ok,true,JSON.stringify(result));assert.equal(result.data.form.draftStale,true);
   assert.equal(result.data.form.draftBaseRevision,2);assert.equal(result.data.form.draftRevision,1);
   await call(db,'form_workspace','staff',a,'archive',stale.id,{});const before=await snapshot();
   assert.equal((await invoke(tool,input(result.data.form))).error.code,'VALIDATION_ERROR');assert.deepEqual(await snapshot(),before);
  });
  let pausedRun,emailId,disabled;
  await t.test('deactivation preserves canonical pause/cancel safeguards, generation fences and in-flight reporting',async()=>{
   const live=await create('quote_requests');await db.query('update public.sms_web_form_definitions set enabled=true,email_enabled=true,legacy_form=true where public_id=$1',[live.id]);
   const other=await create();
   for(const target of [live,other]){
    await db.query('insert into sms_private.form_sequences(tenant_id,form_id,enabled,published_version) values($1,$2,true,1)',[a,target.id]);
    await db.query("insert into sms_private.form_sequence_versions(tenant_id,form_id,version,sequence) values($1,$2,1,'{}')",[a,target.id]);
    await db.query("insert into sms_private.form_runs(tenant_id,form_id,version,submission_id,phone,context,next_run_at) values($1,$2,1,gen_random_uuid(),'+17208429167','{}',now()+interval '1 day')",[a,target.id]);
   }
   pausedRun=(await db.query('select * from sms_private.form_runs where form_id=$1',[live.id])).rows[0];
   emailId=(await db.query(`insert into sms_private.email_enrollments(tenant_id,group_id,source_type,source_id,form_public_id,email,name,rule_snapshot,next_run_at)
    select $1,group_id,'quote_requests',gen_random_uuid(),$2,'test@example.test','Private name',rule,now()+interval '1 day' from sms_private.email_group_settings where tenant_id=$1 limit 1 returning id`,[a,live.id])).rows[0].id;
   await db.query("insert into sms_private.jobs(tenant_id,queue,status,dedupe_key,payload) values($1,'sms_send_jobs','submission_unknown','collection-in-flight',jsonb_build_object('request',jsonb_build_object('form_run_id',$2::text)))",[a,pausedRun.id]);
   const before=await snapshot(untouched),otherBefore=(await db.query('select * from sms_private.form_runs where form_id=$1',[other.id])).rows;
   await grant(['form_activate']);const p=input(live,false),r=await invoke(tool,p);assert.equal(r.ok,true,JSON.stringify(r));disabled=[p,r];
   assert.equal(r.data.pausedSmsRuns,1);assert.equal(r.data.cancelledEmailEnrollments,1);assert.equal(r.data.inFlightMayDeliver,true);
   assert.equal(r.data.form.emailConsentEnabled,true);assert.deepEqual(r.data.form.definition,definition);
   const run=(await db.query('select * from sms_private.form_runs where id=$1',[pausedRun.id])).rows[0];
   assert.equal(run.status,'paused');assert.equal(run.reason,'FORM_DISABLED');assert.equal(run.generation,pausedRun.generation+1);assert.equal(String(run.next_run_at),String(pausedRun.next_run_at));
   const email=(await db.query('select * from sms_private.email_enrollments where id=$1',[emailId])).rows[0];assert.equal(email.status,'cancelled');assert.equal(email.next_run_at,null);assert.equal(email.generation,2);
   assert.deepEqual((await db.query('select * from sms_private.form_runs where form_id=$1',[other.id])).rows,otherBefore);assert.deepEqual(await snapshot(untouched),before);
   assert.deepEqual(await invoke(tool,p),r);assert.equal((await invoke(tool,input(r.data.form,false))).data.pausedSmsRuns,0);
  });
  await t.test('activation rejects enabled follow-ups or active form runs, never resumes paused runs',async()=>{
   const f=disabled[1].data.form,before=await snapshot();
   assert.match((await invoke(tool,input(f))).error.message,/Disable SMS follow-ups separately/);assert.deepEqual(await snapshot(),before);
   await db.query('update sms_private.form_sequences set enabled=false where form_id=$1',[f.id]);
   await db.query("update sms_private.form_runs set status='active' where id=$1",[pausedRun.id]);
   assert.match((await invoke(tool,input(f))).error.message,/Pause active form SMS runs separately/);
   // Already-disabled requests still fence inconsistent active runs, like CRM save.
   const off=await invoke(tool,input(f,false));assert.equal(off.data.effect,'unchanged');assert.equal(off.data.pausedSmsRuns,1);
   const runsBefore=await snapshot(['sms_private.form_runs','sms_private.email_enrollments']);
   assert.equal((await invoke(tool,input(f))).data.effect,'activated');assert.deepEqual(await snapshot(['sms_private.form_runs','sms_private.email_enrollments']),runsBefore);
  });
  await t.test('retry persistence failures roll back state, safeguards, draft metadata, effect audits and cache',async()=>{
   const fresh=await create();
   await db.query('update public.sms_web_form_definitions set enabled=true where public_id=$1',[fresh.id]);
   await db.query('insert into sms_private.form_sequences(tenant_id,form_id,published_version) values($1,$2,1)',[a,fresh.id]);
   await db.query("insert into sms_private.form_sequence_versions(tenant_id,form_id,version,sequence) values($1,$2,1,'{}')",[a,fresh.id]);
   await db.query("insert into sms_private.form_runs(tenant_id,form_id,version,submission_id,phone,context) values($1,$2,1,gen_random_uuid(),'+17208429167','{}')",[a,fresh.id]);
   await db.query(`insert into sms_private.email_enrollments(tenant_id,group_id,source_type,source_id,form_public_id,email,name,rule_snapshot,status)
    select $1,group_id,'contacts',gen_random_uuid(),$2,'test@example.test','Private name',rule,'paused' from sms_private.email_group_settings where tenant_id=$1 limit 1`,[a,fresh.id]);
   const p=input(fresh,false),before=await snapshot();
   const effectAudits=()=>db.query("select id from sms_private.mcp_activity where connection_id=$1 and tool like 'crm_set_form_collection_enabled:%' order by id",[connectionId]).then(x=>x.rows);
   const auditBefore=await effectAudits();
   await db.exec(`create function sms_private.test_fail_collection() returns trigger language plpgsql as $$ begin raise exception 'fixture failure' using errcode='08006'; end $$;
    create trigger test_fail_collection before insert on sms_private.mcp_requests for each row execute function sms_private.test_fail_collection();`);
   assert.equal((await invoke(tool,p)).error.code,'TEMPORARY_FAILURE');assert.deepEqual(await snapshot(),before);assert.deepEqual(await effectAudits(),auditBefore);
   await db.exec('drop trigger test_fail_collection on sms_private.mcp_requests; drop function sms_private.test_fail_collection()');
   const r=await invoke(tool,p);assert.equal(r.ok,true,JSON.stringify(r));assert.equal(r.data.pausedSmsRuns,1);assert.equal(r.data.cancelledEmailEnrollments,1);assert.deepEqual(await invoke(tool,p),r);
  });
  await t.test('audit attributes all changed generations and hides customer content; private helper is inaccessible',async()=>{
   await grant(['form_activate']);await db.exec('set role crm_mcp');
   try{
    assert.deepEqual(await invoke(tool,disabled[0]),disabled[1]);
    await assert.rejects(db.query('select sms_private.mcp_form_collection($1,$2,$3,$4,$5)',['staff',a,JSON.stringify(disabled[0]),connectionId,crypto.randomUUID()]),/permission denied/);
   }finally{await db.exec('reset role');}
   for(const role of ['anon','authenticated','service_role','crm_mcp','sms_api'])assert.equal((await db.query("select has_function_privilege($1,'sms_private.mcp_form_collection(text,text,jsonb,uuid,uuid)','execute') allowed",[role])).rows[0].allowed,false);
   const audits=(await db.query("select * from sms_private.mcp_activity where connection_id=$1 and tool like 'crm_set_form_collection_enabled%'",[connectionId])).rows;
   assert.ok(audits.some(r=>r.target===pausedRun.id&&r.revision===2&&r.tool.endsWith(':pause')));
   assert.ok(audits.some(r=>r.target===emailId&&r.revision===2&&r.tool.endsWith(':cancel_email')));
   assert.ok(audits.some(r=>r.outcome==='replayed'));assert.ok(audits.some(r=>r.outcome==='denied'));assert.ok(audits.some(r=>r.target===f.id&&r.revision===3&&r.draft_revision===3));
   assert.ok(audits.every(r=>r.actor_id===x.admin&&r.request_id));
   for(const value of [definition.title,'Private name','17208429167','test@example.test'])assert.equal(JSON.stringify(audits).includes(value),false);
  });
  await t.test('scope, grants, suspended staff and revoked connections fence completed retries too',async()=>{
   const p=activation[0];await grant(['form_activate'],{businessIds:[]});assert.equal((await invoke(tool,p)).error.code,'PERMISSION_DENIED');
   await grant([]);assert.equal((await invoke(tool,p)).error.code,'PERMISSION_DENIED');await grant(['form_activate']);
   await db.query("update public.dashboard_accounts set status='suspended' where id=$1",[x.admin]);assert.equal((await invoke(tool,p)).error.code,'PERMISSION_DENIED');
   await db.query("update public.dashboard_accounts set status='active' where id=$1",[x.admin]);assert.equal((await invoke(tool,p,'reader')).error.code,'PERMISSION_DENIED');
   await grant(['form_activate'],{status:'revoked'});assert.equal((await invoke(tool,p)).error.code,'PERMISSION_DENIED');
  });
 }finally{await db.close();}
});
