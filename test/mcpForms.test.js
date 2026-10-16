import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {z} from 'zod';
import {testDatabase,call} from './helpers/database.js';
import {toolOutputs} from '../src/mcp/tools.js';
import {formReadTools,formDefinitionSchema} from '../src/mcp/formSchemas.js';
import {connectionPermissionNames} from '../public/mcpPermissions.js';

const crm='https://staff.example.test',customer='https://customer.example.test',client='https://client.example.test/codex.json';
const migration='20261016040535_crm_mcp_form_reads.sql',oldConnection='00000000-0000-4000-8000-000000000002';
const fields=[{key:'items',label:'Items',type:'textarea',required:true},
 {key:'size',label:'Size',type:'select',required:false,options:['Small','Large']}];

test('form schemas reject unknown keys, invalid IDs, filters, page bounds and nested output leakage',()=>{
 for(const [name,,shape] of formReadTools){
  const schema=z.object(shape).strict(),p={businessId:'a',...(name==='crm_get_form'?{formId:crypto.randomUUID()}:{})};
  assert.ok(schema.safeParse(p).success);
  for(const extra of [{businessId:''},{businessId:' '},{businessId:123},{businessId:'a'.repeat(256)},{tenantId:'b'},{actor:'forged'},{idempotencyKey:'not-a-write'}])assert.equal(schema.safeParse({...p,...extra}).success,false);
  assert.equal(schema.safeParse({}).success,false);
 }
 const list=z.object(formReadTools[0][2]).strict(),detail=z.object(formReadTools[1][2]).strict();
 for(const p of [{page:0},{page:1.5},{page:100001},{pageSize:101},{pageSize:null},{q:null},{q:'x'.repeat(101)},{preset:'legacy'},{includeArchived:'true'},{collectionEnabled:1}])assert.equal(list.safeParse({businessId:'a',...p}).success,false);
 for(const formId of [null,12,'not-uuid',''])assert.equal(detail.safeParse({businessId:'a',formId}).success,false);
 const definition={title:'Test',description:'',buttonLabel:'Send',fields};
 assert.ok(formDefinitionSchema.safeParse(definition).success);
 for(const f of [{...fields[0],private:'secret'},{...fields[0],options:['x']},{...fields[1],options:[]},{...fields[0],type:'script'}])assert.equal(formDefinitionSchema.safeParse({...definition,fields:[f]}).success,false);
 assert.deepEqual(connectionPermissionNames.filter(x=>x.startsWith('form_')),['form_read','form_create','form_edit','form_preview','form_publish','form_activate']);
});

test('form reads enforce grants and tenant isolation through the restricted database gateway',async t=>{
 const db=await testDatabase({beforeMigration:async(db,file)=>{
  if(file===migration)await db.query(`insert into sms_private.mcp_connections(id,issuer,subject,account_id,client_id,status,permissions,all_businesses)
   values($1,'legacy','legacy',$1,'legacy','active',array['read','automation_read'],true)`,[oldConnection]);
 }});
 try{
  assert.deepEqual((await db.query('select permissions from sms_private.mcp_connections where id=$1',[oldConnection])).rows[0].permissions,['read','automation_read']);
  const dir=new URL('../../E2local-main/supabase/migrations/',import.meta.url);
  for(const file of (await readdir(dir)).filter(x=>x.endsWith('.sql')).sort())await db.exec(await readFile(new URL(file,dir),'utf8'));
  await db.query('select public.configure_platform_login_realms($1,$2)',[customer,crm]);
  const account=async(subject,issuer)=>{
   const id=(await db.query('select public.sync_platform_account($1,$2,$2,null,1) id',[issuer,subject])).rows[0].id;
   await db.query('update public.dashboard_accounts set personal_info=$2 where id=$1',[id,JSON.stringify({firstName:'Test',lastName:'Owner',phone:'+17208429167',role:'Owner'})]);return id;
  };
  const staff=await account('staff',crm);await db.query('insert into public.platform_staff_grants(account_id) values($1)',[staff]);
  await account('nonstaff',crm);
  const register=async(subject)=>{
   const owner=await account(subject,customer);
   await db.query('select public.complete_platform_onboarding($1,$2)',[owner,JSON.stringify({businessName:subject,contactEmail:'owner@example.test',contactPhone:'+17208429167',summary:'Local services.',services:['Repairs'],locations:['Denver'],timeZone:'America/Denver'})]);
   return (await db.query('select tenant_id from public.dashboard_business_profiles where account_id=$1',[owner])).rows[0].tenant_id;
  };
  const a=await register('allowed'),b=await register('hidden');
  await db.query("select set_config('platform.actor_issuer',$1,false)",[crm]);
  const invoke=async(tool,p={},user='staff')=>{
   const r=(await db.query('select crm_mcp.invoke($1,$2,$3,$4,$5) r',[user,client,tool,JSON.stringify(p),crypto.randomUUID()])).rows[0].r;
   if(r.ok)toolOutputs[tool].parse(r.data);return r;
  };
  const connectionId=(await invoke('crm_get_access')).data.connectionId;let revision=0;
  const grant=async(permissions,{status='active',allBusinesses=false,businessIds=[a]}={})=>{
   const r=await call(db,'mcp_admin','staff','save',{connectionId,revision,status,permissions,businessIds,allBusinesses});revision=r.connection.revision;
  };
  const form=async(business,title,preset='contacts')=>(await call(db,'form_workspace','staff',business,'create',null,{title,preset,description:'Definition only',buttonLabel:'Send',fields})).form;
  const fa=await form(a,'Shared title'),fb=await form(b,'Hidden form'),quote=await form(a,'Shared title','quote_requests'),booking=await form(a,'Booking','bookings');
  await call(db,'form_workspace','staff',a,'save',fa.public_id,{title:fa.title,description:fa.description,buttonLabel:fa.button_label,fields,enabled:true});
  await call(db,'form_workspace','staff',a,'archive',quote.public_id,{});
  // Deliberately add private future JSON fields; the read projection must exclude them.
  await db.query("update public.sms_web_form_definitions set fields=jsonb_set(fields,'{0,private}', '\"secret-field-value\"') where public_id=$1",[fa.public_id]);
  const inputs=[['crm_list_forms',{businessId:a}],['crm_get_form',{businessId:a,formId:fa.public_id}]];
  await t.test('pending, legacy and independent grants cannot imply form reads',async()=>{
   for(const [tool,p] of inputs)assert.equal((await invoke(tool,p)).error.code,'PERMISSION_DENIED');
   await grant(connectionPermissionNames.filter(x=>x!=='form_read'));
   for(const [tool,p] of inputs)assert.equal((await invoke(tool,p)).error.code,'PERMISSION_DENIED');
   await grant(['form_read']);
   assert.deepEqual((await invoke('crm_get_access')).data.permissions,['form_read']);
   for(const tool of ['crm_list_sms_automations','crm_search_sms_contacts','crm_list_form_submissions','crm_get_sms_run_activity','crm_create_form','crm_save_form_draft','crm_set_form_collection_enabled'])assert.equal((await invoke(tool,{businessId:a,formId:fa.public_id})).error.code,'PERMISSION_DENIED',tool);
  });
  await t.test('scope filters precede counts, pages and detail lookups',async()=>{
   assert.equal((await invoke('crm_list_forms',{businessId:a})).data.total,2);
   const one=await invoke('crm_list_forms',{businessId:a,includeArchived:true,pageSize:1}),two=await invoke('crm_list_forms',{businessId:a,includeArchived:true,pageSize:1,page:2});
   assert.equal(one.data.total,3);assert.notEqual(one.data.forms[0].id,two.data.forms[0].id);
   assert.equal((await invoke('crm_list_forms',{businessId:a,page:100000})).data.forms.length,0);
   assert.equal((await invoke('crm_list_forms',{businessId:a,q:'Hidden'})).data.total,0);
   assert.equal((await invoke('crm_list_forms',{businessId:a,q:'%'})).data.total,0);
   assert.equal((await invoke('crm_list_forms',{businessId:a,preset:'bookings'})).data.forms[0].id,booking.public_id);
   assert.equal((await invoke('crm_list_forms',{businessId:a,collectionEnabled:true})).data.total,1);
   for(const [tool,p] of inputs)assert.equal((await invoke(tool,{...p,businessId:b})).error.code,'PERMISSION_DENIED');
   for(const formId of [fb.public_id,crypto.randomUUID()]){
    const r=await invoke('crm_get_form',{businessId:a,formId});assert.equal(r.error.code,'PERMISSION_DENIED');assert.equal(r.error.message,'Form unavailable');
   }
   await grant(['form_read'],{businessIds:[a,b]});
   assert.equal((await invoke('crm_get_form',{businessId:a,formId:fb.public_id})).error.code,'PERMISSION_DENIED');
   assert.equal((await invoke('crm_get_form',{businessId:b,formId:fa.public_id})).error.code,'PERMISSION_DENIED');
   await grant(['form_read']);
  });
  await t.test('detail projects current definition, type-specific fixed fields and no staged draft or SMS data',async()=>{
   const r=await invoke('crm_get_form',{businessId:a,formId:fa.public_id});assert.equal(r.ok,true,JSON.stringify(r));
   const f=r.data.form;assert.equal(f.revision,3);assert.equal(f.collectionEnabled,true);
   assert.equal(r.data.timeZone,'America/Denver');assert.deepEqual(f.definition.fields,fields);
   assert.equal(f.draft,null);assert.equal(f.draftRevision,null);
   for(const key of ['submissions','submissionCount','contacts','automation','sequence','tenant_id'])assert.equal(key in f,false);
   assert.equal(JSON.stringify(r).includes('secret-field-value'),false);
   assert.ok((await invoke('crm_get_form',{businessId:a,formId:booking.public_id})).data.form.fixedFields.includes('appointment_at'));
   assert.equal((await invoke('crm_get_form',{businessId:a,formId:quote.public_id})).data.form.archived,true);
   await db.query('update public.sms_web_form_definitions set email_enabled=true,legacy_form=true where public_id=$1',[quote.public_id]);
   assert.ok((await invoke('crm_get_form',{businessId:a,formId:quote.public_id})).data.form.fixedFields.includes('email_opt_in'));
  });
  await t.test('database validates JSON types, nulls, bounds and extra fields independently of SDK',async()=>{
   for(const p of [{page:0},{page:1.5},{page:1e100},{pageSize:0},{pageSize:101},{page:null},{pageSize:'2'},{q:null},{preset:null},{preset:'other'},{includeArchived:null},{collectionEnabled:'true'},{actor:'staff'},{tenantId:b},{businessId:123}]){
    const r=await invoke('crm_list_forms',{businessId:a,...p});assert.equal(r.ok,false,JSON.stringify(p));assert.ok(['VALIDATION_ERROR','PERMISSION_DENIED'].includes(r.error.code));
   }
   for(const p of [{},{formId:null},{formId:123},{formId:'invalid'},{formId:fa.public_id,q:'extra'}])assert.equal((await invoke('crm_get_form',{businessId:a,...p})).error.code,'VALIDATION_ERROR');
   assert.equal((await invoke('crm_list_forms',null)).ok,false);
   await db.exec('set role crm_mcp');
   assert.equal((await invoke('crm_get_form',{businessId:a,formId:fa.public_id})).ok,true);
   await assert.rejects(db.query('select * from public.sms_web_form_definitions'),/permission denied/);
   await assert.rejects(db.query('select sms_private.mcp_form_read($1,$2,$3,$4)',['staff',b,'crm_list_forms',JSON.stringify({businessId:b})]),/permission denied/);
   await db.exec('reset role');
   for(const role of ['anon','authenticated','service_role','crm_mcp'])assert.equal((await db.query("select has_function_privilege($1,'sms_private.mcp_form_read(text,text,text,jsonb)','execute') allowed",[role])).rows[0].allowed,false);
  });
  await t.test('reads do not change domain state; audit records contain only attribution and revision',async()=>{
   const snapshot=async()=>{const out={};for(const table of ['public.sms_web_form_definitions','public.sms_contacts','public.sms_businesses','sms_private.form_sequences','sms_private.form_runs','sms_private.jobs','sms_private.mcp_requests'])out[table]=(await db.query(`select coalesce(jsonb_agg(to_jsonb(x) order by to_jsonb(x)::text),'[]') value from ${table} x`)).rows[0].value;return out;};
   const before=await snapshot();for(const [tool,p] of inputs)assert.equal((await invoke(tool,p)).ok,true);assert.deepEqual(await snapshot(),before);
   const audit=(await db.query('select * from sms_private.mcp_activity where connection_id=$1',[connectionId])).rows;
   assert.ok(audit.some(x=>x.tool==='crm_get_form'&&x.target===fa.public_id&&x.revision===3));
   assert.ok(audit.some(x=>x.outcome==='denied'));assert.ok(audit.every(x=>x.actor_id===staff&&x.request_id));
   for(const value of ['secret-field-value','Definition only','7208429167'])assert.equal(JSON.stringify(audit).includes(value),false);
  });
  await t.test('all-business and future scope work; changes to scope, staff and connection apply immediately',async()=>{
   await grant(['form_read'],{allBusinesses:true});assert.equal((await invoke('crm_get_form',{businessId:b,formId:fb.public_id})).ok,true);
   const future=await register('future');const ff=await form(future,'Future');
   assert.equal((await invoke('crm_get_form',{businessId:future,formId:ff.public_id})).ok,true);
   await grant(['form_read'],{businessIds:[]});assert.equal((await invoke('crm_list_forms',{businessId:a})).error.code,'PERMISSION_DENIED');
   await grant([]);assert.equal((await invoke('crm_list_forms',{businessId:a})).error.code,'PERMISSION_DENIED');
   await grant(['form_read']);
   await db.query("update public.dashboard_accounts set status='suspended' where id=$1",[staff]);assert.equal((await invoke('crm_list_forms',{businessId:a})).error.code,'PERMISSION_DENIED');
   await db.query("update public.dashboard_accounts set status='active' where id=$1",[staff]);
   assert.equal((await invoke('crm_list_forms',{businessId:a},'nonstaff')).error.code,'PERMISSION_DENIED');
   await db.query("select set_config('platform.actor_issuer',$1,false)",[customer]);assert.equal((await invoke('crm_list_forms',{businessId:a},'allowed')).error.code,'PERMISSION_DENIED');
   await db.query("select set_config('platform.actor_issuer',$1,false)",[crm]);
   await grant(['form_read'],{status:'disabled'});assert.equal((await invoke('crm_list_forms',{businessId:a})).error.code,'PERMISSION_DENIED');
   await grant(['form_read'],{status:'revoked'});assert.equal((await invoke('crm_list_forms',{businessId:a})).error.code,'PERMISSION_DENIED');
  });
 }finally{await db.close();}
});
