import test from 'node:test';
import assert from 'node:assert/strict';
import {z} from 'zod';
import {fixture} from './helpers/twilioConnections.js';
import {call} from './helpers/database.js';
import {formDraftTools} from '../src/mcp/formSchemas.js';
import {toolOutputs} from '../src/mcp/tools.js';
import {connectionPermissionNames} from '../public/mcpPermissions.js';

const definition={title:'Private draft title',description:'Private draft description',buttonLabel:'Request help',fields:[
 {key:'items',label:'Items',type:'textarea',required:true},
 {key:'size',label:'Size',type:'select',required:false,options:['Small','Large']},
]};
const invalidDefinitions=[null,{}, {...definition,title:' '},{...definition,title:1},{...definition,description:null},
 {...definition,buttonLabel:''},{...definition,enabled:true},{...definition,fields:null},
 {...definition,fields:Array(21).fill(definition.fields[0])},
 ...[{...definition.fields[0],key:'phone'},{...definition.fields[0],key:'email_opt_in'},
 {...definition.fields[0],key:'consent_evidence'},{...definition.fields[0],key:'bad-key'},
 {...definition.fields[0],label:' '},{...definition.fields[0],required:null},
 {...definition.fields[0],type:'script'},{...definition.fields[0],options:null},
 {...definition.fields[0],private:'secret'},{...definition.fields[1],options:[]},
 {...definition.fields[1],options:['Small','Small']},{...definition.fields[1],options:[' ']},
 {...definition.fields[1],options:[1]}].map(field=>({...definition,fields:[field]})),
 {...definition,fields:[definition.fields[0],definition.fields[0]]},
];
test('form write schemas forbid collection/SMS switches and validate definitions and revisions',()=>{
 for(const [tool,,shape] of formDraftTools){
  const schema=z.object(shape).strict(),p={businessId:'a',idempotencyKey:'test-key-123',definition,
   ...(tool==='crm_create_form'?{preset:'contacts'}:{formId:crypto.randomUUID(),revision:2,draftRevision:0})};
  assert.ok(schema.safeParse(p).success);
  for(const d of invalidDefinitions)assert.equal(schema.safeParse({...p,definition:d}).success,false,JSON.stringify(d));
  for(const extra of [{enabled:true},{collectionEnabled:true},{smsEnabled:true},{emailEnabled:true},{publish:true},{actor:'staff'},{idempotencyKey:'short'},{businessId:''}])assert.equal(schema.safeParse({...p,...extra}).success,false);
  if(tool==='crm_save_form_draft')for(const extra of [{revision:null},{revision:0.5},{revision:-1},{draftRevision:-1},{draftRevision:'1'},{formId:'bad'},{preset:'bookings'}])assert.equal(schema.safeParse({...p,...extra}).success,false);
 }
});

test('form creation and separate drafts preserve applied forms, enforce revisions and record retries atomically',async t=>{
 const x=await fixture(),{db}=x;
 try{
  const {tenant:a}=await x.business('allowed'),{tenant:b}=await x.business('hidden');
  const invoke=async(tool,p={})=>{
   const r=(await db.query('select crm_mcp.invoke($1,$2,$3,$4,$5) r',['staff','form-draft-client',tool,JSON.stringify(p),crypto.randomUUID()])).rows[0].r;
   if(r.ok)toolOutputs[tool].parse(r.data);return r;
  };
  const connectionId=(await invoke('crm_get_access')).data.connectionId;let grantRevision=0;
  const grant=async(permissions,{businessIds=[a],status='active'}={})=>{
   const r=await call(db,'mcp_admin','staff','save',{connectionId,revision:grantRevision,status,permissions,businessIds});grantRevision=r.connection.revision;
  };
  const create={businessId:a,preset:'contacts',definition,idempotencyKey:'form-create-001'};
  const canonical=async(tenant,title)=>(await call(db,'form_workspace','staff',tenant,'create',null,{...definition,title,preset:'contacts'})).form;
  const live=await canonical(a,'Live title'),foreign=await canonical(b,'Hidden title');
  await call(db,'form_workspace','staff',a,'save',live.public_id,{title:live.title,description:live.description,buttonLabel:live.button_label,fields:definition.fields,enabled:true});
  const save={businessId:a,formId:live.public_id,revision:3,draftRevision:0,definition,idempotencyKey:'draft-save-001'};
  // Existing automation/run fixtures must survive form drafts byte-for-byte.
  // This isolated database has no workers or provider credentials.
  await db.query('insert into sms_private.form_sequences(tenant_id,form_id,published_version,enabled) values($1,$2,1,true)',[a,live.public_id]);
  await db.query("insert into sms_private.form_sequence_versions(tenant_id,form_id,version,sequence) values($1,$2,1,'{}')",[a,live.public_id]);
  await db.query("insert into sms_private.form_runs(tenant_id,form_id,version,submission_id,phone,context,status,next_run_at) values($1,$2,1,gen_random_uuid(),'+17208429167','{}','active',now()+interval '1 day')",[a,live.public_id]);
  const snapshot=async(tables)=>{const out={};for(const table of tables)out[table]=(await db.query(`select coalesce(jsonb_agg(to_jsonb(x) order by to_jsonb(x)::text),'[]') value from ${table} x`)).rows[0].value;return out;};
  const operational=['public.sms_web_form_definitions','public.sms_contacts','public.sms_businesses','sms_private.form_sequences','sms_private.form_sequence_versions','sms_private.form_runs','sms_private.jobs','sms_private.email_enrollments','pgmq.test_messages','net.test_requests',
   'public.sms_web_form_contact_submissions','public.sms_web_form_quote_request_submissions','public.sms_web_form_booking_submissions'];
  const all=[...operational,'sms_private.mcp_form_drafts','sms_private.mcp_requests'];
  let created,saved;
  await t.test('create and edit are independent grants; denied mutations leave no domain changes',async()=>{
   const before=await snapshot(all);
   for(const tool of ['crm_create_form','crm_save_form_draft'])assert.equal((await invoke(tool,tool==='crm_create_form'?create:save)).error.code,'PERMISSION_DENIED');
   await grant(connectionPermissionNames.filter(p=>!['form_create','form_edit'].includes(p)));
   for(const [tool,p] of [['crm_create_form',create],['crm_save_form_draft',save]])assert.equal((await invoke(tool,p)).error.code,'PERMISSION_DENIED');
   await grant(['form_create']);assert.equal((await invoke('crm_save_form_draft',save)).error.code,'PERMISSION_DENIED');
   await grant(['form_edit']);assert.equal((await invoke('crm_create_form',create)).error.code,'PERMISSION_DENIED');
   assert.deepEqual(await snapshot(all),before);
  });
  await t.test('creation is inactive, canonical and retry-safe for every form preset',async()=>{
   await grant(['form_create']);
   const before=await snapshot(operational.filter(x=>x!=='public.sms_web_form_definitions'));
   for(const preset of ['contacts','quote_requests','bookings']){
    const p={...create,preset,idempotencyKey:'create-'+preset};const r=await invoke('crm_create_form',p);
    assert.equal(r.ok,true,JSON.stringify(r));const f=r.data.form;
    assert.equal(f.collectionEnabled,false);assert.equal(f.archived,false);assert.equal(f.legacyForm,false);assert.equal(f.emailConsentEnabled,false);
    assert.equal(f.revision,2);assert.equal(f.draftRevision,1);assert.equal(f.draftBaseRevision,2);assert.equal(f.draftStale,false);
    assert.deepEqual(f.definition,definition);assert.deepEqual(f.draft,definition);
    assert.equal(await call(db,'public_web_form',f.id),null,'New inactive forms cannot collect public submissions');
    assert.deepEqual(await invoke('crm_create_form',p),r);
    assert.equal((await invoke('crm_create_form',{...p,definition:{...definition,title:'Changed'}})).error.code,'CONFLICT');
    if(preset==='contacts')created=r;
   }
   assert.deepEqual(await snapshot(operational.filter(x=>x!=='public.sms_web_form_definitions')),before);
   assert.equal((await db.query('select count(*)::int n from sms_private.mcp_form_drafts')).rows[0].n,3);
  });
  await t.test('active form edits only change the separate draft, and retain immutable retry snapshots',async()=>{
   await grant(['form_edit']);const before=await snapshot(operational),publicBefore=await call(db,'public_web_form',live.public_id);
   assert.ok(publicBefore);
   saved=await invoke('crm_save_form_draft',save);assert.equal(saved.ok,true,JSON.stringify(saved));
   assert.equal(saved.data.form.definition.title,'Live title');assert.deepEqual(saved.data.form.draft,definition);
   assert.equal(saved.data.form.revision,3);assert.equal(saved.data.form.draftRevision,1);assert.equal(saved.data.form.draftBaseRevision,3);assert.equal(saved.data.form.collectionEnabled,true);
   const edited=await invoke('crm_save_form_draft',{...save,draftRevision:1,idempotencyKey:'draft-save-002',definition:{...definition,title:'Second private draft'}});
   assert.equal(edited.ok,true,JSON.stringify(edited));assert.equal(edited.data.form.draftRevision,2);
   assert.deepEqual(await invoke('crm_save_form_draft',save),saved);
   assert.equal((await invoke('crm_save_form_draft',{...save,definition:{...definition,title:'Different'}})).error.code,'CONFLICT');
   assert.equal((await invoke('crm_save_form_draft',{...save,idempotencyKey:'stale-draft-key'})).error.code,'CONFLICT');
   assert.deepEqual(await snapshot(operational),before);
   assert.deepEqual(await call(db,'public_web_form',live.public_id),publicBefore,'Public rendering must not see the staged definition');
   await grant(['form_read']);const r=await invoke('crm_get_form',{businessId:a,formId:live.public_id});
   assert.equal(r.data.form.draft.title,'Second private draft');assert.equal(r.data.form.draftRevision,2);
   const list=await invoke('crm_list_forms',{businessId:a,q:'Second private'});assert.equal(list.data.total,0);
  });
  await t.test('cross-business substitution, archives, missing/changed revisions and malformed definitions cannot mutate',async()=>{
   await grant(['form_create','form_edit'],{businessIds:[a,b]});const before=await snapshot(all);
   for(const p of [{...save,formId:foreign.public_id},{...save,businessId:b},{...save,formId:crypto.randomUUID()}])assert.equal((await invoke('crm_save_form_draft',{...p,idempotencyKey:'scope-substitution'})).error.code,'PERMISSION_DENIED');
   for(const patch of [{revision:2,draftRevision:2},{revision:3,draftRevision:9}])assert.equal((await invoke('crm_save_form_draft',{...save,...patch,idempotencyKey:'conflict-key'})).error.code,'CONFLICT');
   for(const d of invalidDefinitions)assert.equal((await invoke('crm_create_form',{...create,idempotencyKey:'invalid-definition',definition:d})).error.code,'VALIDATION_ERROR',JSON.stringify(d));
   for(const patch of [{revision:null},{revision:0.5},{revision:1e100},{draftRevision:null},{draftRevision:'2'},{formId:'invalid'},{enabled:true},{preset:'contacts'}])assert.equal((await invoke('crm_save_form_draft',{...save,...patch,idempotencyKey:'invalid-input'})).error.code,'VALIDATION_ERROR',JSON.stringify(patch));
   for(const patch of [{preset:null},{preset:'bad'},{enabled:true},{emailEnabled:true},{idempotencyKey:null},{idempotencyKey:'short'}])assert.equal((await invoke('crm_create_form',{...create,...patch})).error.code,'VALIDATION_ERROR');
   assert.deepEqual(await snapshot(all),before);
   const archived=await canonical(a,'Archived');await call(db,'form_workspace','staff',a,'archive',archived.public_id,{});
   assert.equal((await invoke('crm_save_form_draft',{...save,formId:archived.public_id,revision:2,idempotencyKey:'archived-draft'})).error.code,'VALIDATION_ERROR');
  });
  await t.test('CRM applied edits mark the base stale and cannot silently rebase a saved draft',async()=>{
   await call(db,'form_workspace','staff',a,'save',live.public_id,{...definition,title:'New applied title',enabled:true});
   await grant(['form_read','form_edit']);const r=await invoke('crm_get_form',{businessId:a,formId:live.public_id});
   assert.equal(r.data.form.revision,4);assert.equal(r.data.form.draftBaseRevision,3);assert.equal(r.data.form.draftStale,true);
   const before=await snapshot(all);
   assert.equal((await invoke('crm_save_form_draft',{...save,revision:4,draftRevision:2,idempotencyKey:'stale-base-key'})).error.code,'CONFLICT');
   assert.deepEqual(await snapshot(all),before);
  });
  await t.test('idempotency persistence failure rolls back creation and draft together; retry succeeds',async()=>{
   await grant(['form_create']);const before=await snapshot(all);
   await db.exec(`create function sms_private.test_fail_retry() returns trigger language plpgsql as $$ begin raise exception 'fixture failure' using errcode='08006'; end $$;
    create trigger test_fail_retry before insert on sms_private.mcp_requests for each row execute function sms_private.test_fail_retry();`);
   const p={...create,idempotencyKey:'interrupted-create'};const r=await invoke('crm_create_form',p);assert.equal(r.error.code,'TEMPORARY_FAILURE');
   assert.deepEqual(await snapshot(all),before);
   await db.exec('drop trigger test_fail_retry on sms_private.mcp_requests; drop function sms_private.test_fail_retry()');
   const retry=await invoke('crm_create_form',p);assert.equal(retry.ok,true);assert.deepEqual(await invoke('crm_create_form',p),retry);
  });
  await t.test('private storage and helper privileges remain gateway-only; audit attributes both revisions without content',async()=>{
   await grant(['form_create','form_edit','form_read']);await db.exec('set role crm_mcp');
   await assert.rejects(db.query('select * from sms_private.mcp_form_drafts'),/permission denied/);
   assert.equal((await invoke('crm_get_form',{businessId:a,formId:created.data.form.id})).ok,true);
   await db.exec('reset role');
   for(const role of ['anon','authenticated','service_role','crm_mcp','sms_api']){
    for(const signature of ['sms_private.mcp_validate_form_definition(jsonb)','sms_private.mcp_form_draft(text,text,text,jsonb,uuid)'])assert.equal((await db.query('select has_function_privilege($1,$2,\'execute\') allowed',[role,signature])).rows[0].allowed,false);
    assert.equal((await db.query("select has_table_privilege($1,'sms_private.mcp_form_drafts','select,insert,update,delete') allowed",[role])).rows[0].allowed,false);
   }
   const audit=(await db.query('select * from sms_private.mcp_activity where connection_id=$1',[connectionId])).rows;
   assert.ok(audit.some(x=>x.tool==='crm_save_form_draft'&&x.target===live.public_id&&x.revision===3&&x.draft_revision===2));
   assert.ok(audit.some(x=>x.outcome==='replayed'&&x.draft_revision===1));assert.ok(audit.some(x=>x.code==='TEMPORARY_FAILURE'));
   assert.ok(audit.every(row=>row.actor_id===x.admin&&row.request_id));
   for(const secret of ['Private draft','Second private','items','Small'])assert.equal(JSON.stringify(audit).includes(secret),false);
  });
  await t.test('scope removal, permission removal and connection revocation fence even completed retries',async()=>{
   const p={...create,idempotencyKey:'create-contacts'};
   await grant(['form_create'],{businessIds:[]});assert.equal((await invoke('crm_create_form',p)).error.code,'PERMISSION_DENIED');
   await grant(['form_edit']);assert.equal((await invoke('crm_create_form',p)).error.code,'PERMISSION_DENIED');
   await grant(['form_create'],{status:'revoked'});assert.equal((await invoke('crm_create_form',p)).error.code,'PERMISSION_DENIED');
  });
 }finally{await db.close();}
});
