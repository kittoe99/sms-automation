import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {z} from 'zod';
import {testDatabase,call} from './helpers/database.js';
import {toolOutputs} from '../src/mcp/tools.js';
import {smsReadTools} from '../src/mcp/smsSchemas.js';
import {connectionPermissionNames,connectionPermissions} from '../public/mcpPermissions.js';
import {emptySequence,newMessage} from '../public/formAutomation.js';

const crm='https://staff.example.test',customer='https://customer.example.test',client='https://client.example.test/codex.json';
const migration='20261015043000_crm_mcp_sms_reads.sql';
const oldConnection='00000000-0000-4000-8000-000000000001';
const sequence={...emptySequence(),steps:[newMessage('Hello {{name}}')]};
test('SMS read input schemas require business context, typed references and bounded pages',()=>{
 for(const [name,,shape] of smsReadTools){
  const schema=z.object(shape).strict();assert.equal(schema.safeParse({}).success,false,name);
  const p={businessId:'business',...(name==='crm_get_sms_automation'?{kind:'form',automationId:crypto.randomUUID()}:{}),...(name==='crm_list_form_submissions'?{formId:crypto.randomUUID()}:{})};
  assert.equal(schema.safeParse(p).success,true,name);
  for(const extra of [{tenantId:'other'},{actor:'forged'},{pageSize:101},{page:0},{kind:'legacy'},{businessId:''}])assert.equal(schema.safeParse({...p,...extra}).success,false,name);
 }
 assert.equal(new Set(connectionPermissionNames).size,15);
 assert.deepEqual(connectionPermissions.map(([key])=>key),connectionPermissionNames);
});

test('SMS MCP reads isolate business data, grants, nested references and audit',async t=>{
 const db=await testDatabase({beforeMigration:async(db,file)=>{
  if(file===migration)await db.query(`insert into sms_private.mcp_connections(id,issuer,subject,account_id,client_id,status,permissions,all_businesses)
   values($1,'legacy','legacy',$1,'legacy','active',array['read','draft'],true)`,[oldConnection]);
 }});
 try{
  assert.deepEqual((await db.query('select permissions from sms_private.mcp_connections where id=$1',[oldConnection])).rows[0].permissions,['read','draft']);
  const dir=new URL('../../E2local-main/supabase/migrations/',import.meta.url);
  for(const file of (await readdir(dir)).filter(x=>x.endsWith('.sql')).sort())await db.exec(await readFile(new URL(file,dir),'utf8'));
  await db.query('select public.configure_platform_login_realms($1,$2)',[customer,crm]);
  const account=async(subject,issuer)=>{
   const id=(await db.query('select public.sync_platform_account($1,$2,$2,null,1) id',[issuer,subject])).rows[0].id;
   await db.query('update public.dashboard_accounts set personal_info=$2 where id=$1',[id,JSON.stringify({firstName:'Test',lastName:'Owner',phone:'+13035550123',role:'Owner'})]);return id;
  };
  const staff=await account('staff',crm);await db.query('insert into public.platform_staff_grants(account_id) values($1)',[staff]);
  await account('nonstaff',crm);
  await db.query("select set_config('platform.actor_issuer',$1,false)",[crm]);
  const register=async(subject)=>{
   const owner=await account(subject,customer);
   await db.query('select public.complete_platform_onboarding($1,$2)',[owner,JSON.stringify({businessName:subject,contactEmail:'owner@example.test',contactPhone:'+13035550123',summary:'Local services for testing.',services:['Repairs'],locations:['Denver'],timeZone:'America/Denver'})]);
   const business=(await db.query('select tenant_id from public.dashboard_business_profiles where account_id=$1',[owner])).rows[0].tenant_id;
   const profile=(await db.query('select draft from public.platform_business_setup where tenant_id=$1',[business])).rows[0].draft;
   await call(db,'platform_action','staff','business_profile_review',{tenantId:business,revision:0,profile});
   await call(db,'platform_action','staff','service_add',{tenantId:business,kind:'sms'});
   return business;
  };
  const a=await register('allowed'),b=await register('hidden');
  await db.query("select set_config('platform.actor_issuer',$1,false)",[crm]);
  const invoke=async(tool,p={},user='staff')=>{
   const r=(await db.query('select crm_mcp.invoke($1,$2,$3,$4,$5) r',[user,client,tool,JSON.stringify(p),crypto.randomUUID()])).rows[0].r;
   if(r.ok)toolOutputs[tool].parse(r.data);return r;
  };
  const connectionId=(await invoke('crm_get_access')).data.connectionId;
  let revision=0;
  const grant=async(permissions,{status='active',allBusinesses=false}={})=>{
   const r=await call(db,'mcp_admin','staff','save',{connectionId,revision,status,permissions,businessIds:[a],allBusinesses});revision=r.connection.revision;
  };
  const form=async(business,title,preset='contacts')=>{
   const input={title,preset,description:'',buttonLabel:'Send',fields:[],enabled:true};
   const f=(await call(db,'form_workspace','staff',business,'create',null,input)).form;
   return (await call(db,'form_workspace','staff',business,'save',f.public_id,input)).form;
  };
  const fa=await form(a,'Allowed form'),fb=await form(b,'Hidden form');
  const quote=await form(a,'Quote form','quote_requests'),booking=await form(a,'Booking form','bookings');
  const template=async(business,name)=>(await call(db,'contact_automations','staff',business,'save',{name,sequence,idempotencyKey:crypto.randomUUID()})).template;
  const da=await template(a,'Allowed template'),hidden=await template(b,'Hidden template');
  const contacts=[];
  for(const business of [a,b])contacts.push((await db.query(`insert into public.sms_contacts(tenant_id,phone,name,email,metadata)
   values($1,'+13035550199',$2,'contact@example.test','{"private":"do not expose"}') returning id,revision`,[business,business===a?'Allowed person':'Hidden person'])).rows[0]);
  const submit=async(f,name)=>call(db,'submit_web_form',f.public_id,{submissionId:crypto.randomUUID(),name,phone:'+13035550199',email:'contact@example.test',smsOptIn:true,details:{},...(f.preset==='bookings'?{appointmentAt:'2030-05-01T15:00:00Z'}:{})});
  const sa=await submit(fa,'Allowed submission'),sb=await submit(fb,'Hidden submission');
  await submit(quote,'Quote submission');await submit(booking,'Booking submission');
  const inputs=[['crm_list_sms_automations',{businessId:a}],['crm_get_sms_automation',{businessId:a,kind:'form',automationId:fa.public_id}],['crm_search_sms_contacts',{businessId:a}],['crm_list_form_submissions',{businessId:a,formId:fa.public_id}]];
  await t.test('pending and legacy grants reveal no SMS data; future grants are independent',async()=>{
   for(const [tool,p] of inputs)assert.equal((await invoke(tool,p)).error.code,'PERMISSION_DENIED');
   await grant(['read','global_customer_lookup']);
   for(const [tool,p] of inputs)assert.equal((await invoke(tool,p)).error.code,'PERMISSION_DENIED');
   for(const permission of connectionPermissionNames.filter(x=>x.startsWith('automation_')&&x!=='automation_read')){
    await grant([permission]);assert.equal((await invoke('crm_list_sms_automations',{businessId:a})).error.code,'PERMISSION_DENIED',permission);
   }
   await grant(['automation_read']);
   assert.deepEqual((await invoke('crm_get_access')).data.permissions,['automation_read']);
   assert.equal((await invoke('crm_list_businesses')).error.code,'PERMISSION_DENIED');
   assert.equal((await invoke('crm_create_sms_automation',{businessId:a})).error.code,'PERMISSION_DENIED');
  });
  await t.test('catalog filters/counts/pagination and typed IDs cannot cross business scope',async()=>{
   const listed=await invoke('crm_list_sms_automations',{businessId:a,pageSize:1});assert.equal(listed.ok,true,JSON.stringify(listed));
   assert.equal(listed.data.total,4);assert.equal(listed.data.automations.length,1);
   const page2=await invoke('crm_list_sms_automations',{businessId:a,pageSize:1,page:2});assert.notEqual(page2.data.automations[0].id,listed.data.automations[0].id);
   assert.equal((await invoke('crm_list_sms_automations',{businessId:a,q:'Hidden'})).data.total,0);
   assert.equal((await invoke('crm_list_sms_automations',{businessId:a,kind:'contact'})).data.total,1);
   for(const [tool,p] of inputs)assert.equal((await invoke(tool,{...p,businessId:b})).error.code,'PERMISSION_DENIED');
   for(const [kind,automationId] of [['form',fb.public_id],['contact',hidden.id],['contact',fa.public_id],['form',da.id]])assert.equal((await invoke('crm_get_sms_automation',{businessId:a,kind,automationId})).error.code,'PERMISSION_DENIED');
   assert.equal((await invoke('crm_list_form_submissions',{businessId:a,formId:fb.public_id})).error.code,'PERMISSION_DENIED');
   await db.query('update sms_private.direct_templates set archived=true where tenant_id=$1 and id=$2',[a,da.id]);
   assert.equal((await invoke('crm_list_sms_automations',{businessId:a})).data.total,3);
   assert.equal((await invoke('crm_list_sms_automations',{businessId:a,includeArchived:true})).data.total,4);
  });
  await t.test('detail exposes drafts, immutable versions, canonical revision and readiness without changing state',async()=>{
   let r=await invoke('crm_get_sms_automation',{businessId:a,kind:'form',automationId:fa.public_id});
   assert.equal(r.data.automation.revision,0);assert.equal(r.data.automation.draft,null);assert.ok(r.data.readiness.blockers.includes('UNPUBLISHED'));
   await call(db,'form_workspace','staff',a,'publish',fa.public_id,{revision:0,sequence});
   r=await invoke('crm_get_sms_automation',{businessId:a,kind:'form',automationId:fa.public_id});
   assert.deepEqual(r.data.automation.published,sequence);assert.equal(r.data.automation.publishedVersion,1);
   assert.ok(r.data.readiness.blockers.includes('SENDING_DISABLED'));assert.ok(r.data.readiness.blockers.includes('AUTOMATION_DISABLED'));
   assert.equal(r.data.readiness.recipientChecksRequired,true);
   const direct=await invoke('crm_get_sms_automation',{businessId:a,kind:'contact',automationId:da.id});
   assert.deepEqual(direct.data.automation.draft,sequence);assert.equal(direct.data.automation.enabled,null);assert.ok(direct.data.automation.supportedFields.includes('request'));
   assert.ok(direct.data.readiness.blockers.includes('ARCHIVED'));
  });
  await t.test('contacts/submissions project only safe fields with same-business joins for every form type',async()=>{
   await call(db,'form_workspace','staff',b,'publish',fb.public_id,{revision:0,sequence});
   for(const [business,f,submission] of [[a,fa,sa],[b,fb,sb]]){
    await call(db,'form_workspace','staff',business,'state',f.public_id,{enabled:true});
    await call(db,'form_workspace','staff',business,'enroll',f.public_id,{submissionId:submission.submissionId});
   }
   const ownRun=(await db.query('select id from sms_private.form_runs where tenant_id=$1',[a])).rows[0].id;
   const r=await invoke('crm_search_sms_contacts',{businessId:a,q:'contact@example.test'});assert.equal(r.data.total,1);assert.equal(r.data.contacts[0].id,contacts[0].id);
   assert.equal((await invoke('crm_search_sms_contacts',{businessId:a,q:'Hidden'})).data.total,0);
   assert.equal('metadata' in r.data.contacts[0],false);
   for(const f of [fa,quote,booking]){
    const s=await invoke('crm_list_form_submissions',{businessId:a,formId:f.public_id});assert.equal(s.ok,true,JSON.stringify(s));
    assert.equal(s.data.total,1);assert.equal(s.data.submissions[0].contactId,contacts[0].id);
    assert.equal('consent_evidence' in s.data.submissions[0],false);assert.equal('details' in s.data.submissions[0],false);
    if(f===fa)assert.equal(s.data.submissions[0].run.id,ownRun);else assert.equal(s.data.submissions[0].run,null);
    assert.equal(s.data.submissions[0].appointmentAt!==null,f.preset==='bookings');
   }
  });
  await t.test('database boundary rejects forged and unbounded input and the restricted role has no helper access',async()=>{
   for(const p of [{page:0},{pageSize:101},{page:1.5},{page:1e100},{q:null},{includeArchived:'true'},{kind:'legacy'},{actor:'staff'},{tenantId:b}]){
    const r=await invoke('crm_list_sms_automations',{businessId:a,...p});assert.equal(r.error.code,'VALIDATION_ERROR',JSON.stringify(r));
   }
   assert.equal((await invoke('crm_list_sms_automations',{})).error.code,'PERMISSION_DENIED');
   await db.exec('set role crm_mcp');
   assert.equal((await invoke('crm_list_sms_automations',{businessId:a})).ok,true);
   await assert.rejects(db.query('select * from sms_private.mcp_sms_catalog($1)',[a]),/permission denied/);
   await db.exec('reset role');
   assert.equal((await db.query("select has_function_privilege('crm_mcp','sms_private.mcp_sms_read(text,text,text,jsonb)','execute') allowed")).rows[0].allowed,false);
  });
  await t.test('read tools leave contacts, runs, jobs and sending state unchanged',async()=>{
   const snapshot=async()=>(await db.query(`select
    (select count(*) from sms_private.jobs) jobs,(select count(*) from public.sms_contacts) contacts,
    (select jsonb_agg(jsonb_build_object('id',id,'status',status,'generation',generation) order by id) from sms_private.form_runs) runs,
    (select jsonb_agg(jsonb_build_object('id',tenant_id,'sending',sending_enabled) order by tenant_id) from public.sms_businesses) businesses,
    (select jsonb_agg(jsonb_build_object('id',form_id,'revision',revision,'enabled',enabled) order by form_id) from sms_private.form_sequences) sequences`)).rows[0];
   const before=await snapshot();for(const [tool,p] of inputs)assert.equal((await invoke(tool,p)).ok,true);
   assert.deepEqual(await snapshot(),before);
  });
  await t.test('all-business scope includes future businesses; suspension, permission removal and revocation take effect',async()=>{
   await grant(['automation_read'],{allBusinesses:true});
   assert.equal((await invoke('crm_get_sms_automation',{businessId:b,kind:'form',automationId:fb.public_id})).ok,true);
   const future=await register('future'),ff=await form(future,'Future form');
   assert.equal((await invoke('crm_get_sms_automation',{businessId:future,kind:'form',automationId:ff.public_id})).ok,true);
   await grant([]);assert.equal((await invoke('crm_list_sms_automations',{businessId:a})).error.code,'PERMISSION_DENIED');
   await grant(['automation_read']);
   await db.query("update public.dashboard_accounts set status='suspended' where id=$1",[staff]);
   assert.equal((await invoke('crm_list_sms_automations',{businessId:a})).error.code,'PERMISSION_DENIED');
   await db.query("update public.dashboard_accounts set status='active' where id=$1",[staff]);
   assert.equal((await invoke('crm_list_sms_automations',{businessId:a},'nonstaff')).error.code,'PERMISSION_DENIED');
   await db.query("select set_config('platform.actor_issuer',$1,false)",[customer]);
   assert.equal((await invoke('crm_list_sms_automations',{businessId:a},'allowed')).error.code,'PERMISSION_DENIED');
   await db.query("select set_config('platform.actor_issuer',$1,false)",[crm]);
   await grant(['automation_read'],{status:'disabled'});assert.equal((await invoke('crm_list_sms_automations',{businessId:a})).error.code,'PERMISSION_DENIED');
   await grant(['automation_read'],{status:'revoked'});assert.equal((await invoke('crm_list_sms_automations',{businessId:a})).error.code,'PERMISSION_DENIED');
   const audit=(await db.query('select * from sms_private.mcp_activity where connection_id=$1',[connectionId])).rows;
   assert.ok(audit.some(x=>x.tool==='crm_get_sms_automation'&&x.target===fa.public_id&&x.revision===2));
   assert.ok(audit.some(x=>x.outcome==='denied'));assert.ok(audit.every(x=>x.actor_id===staff));
   assert.equal(JSON.stringify(audit).includes('+13035550199'),false);assert.equal(JSON.stringify(audit).includes('Hello'),false);
   assert.equal((await db.query('select count(*) n from sms_private.form_runs')).rows[0].n,2);
   assert.equal((await db.query('select count(*) n from sms_private.mcp_requests where connection_id=$1',[connectionId])).rows[0].n,0);
  });
 }finally{await db.close();}
});
