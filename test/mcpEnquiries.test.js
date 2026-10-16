import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {z} from 'zod';
import {testDatabase,call} from './helpers/database.js';
import {toolOutputs,toolDefinitions} from '../src/mcp/tools.js';
import {enquiryReadTools} from '../src/mcp/enquirySchemas.js';
import {connectionPermissionNames} from '../public/mcpPermissions.js';
const crm='https://staff.example.test',customer='https://customer.example.test',client='https://client.example.test/codex.json';
const migration='20261016061921_crm_mcp_enquiry_reads.sql',oldConnection='00000000-0000-4000-8000-000000000002';
const fields=[{key:'items',label:'Original items label',type:'textarea',required:true}];

test('strict enquiry inputs reject unsafe scope, pagination, timestamps and unknown fields',()=>{
 for(const [name,,shape] of enquiryReadTools){
  const schema=z.object(shape).strict(),p={businessId:'a',...(name==='crm_get_enquiry'?{formId:crypto.randomUUID(),submissionId:crypto.randomUUID()}:{})};
  assert.ok(schema.safeParse(p).success);
  for(const extra of [{businessId:''},{businessId:' '},{businessId:12},{businessId:'x'.repeat(256)},{tenantId:'b'},{actor:'forged'},{includeAnswers:true},{idempotencyKey:'not-a-write'},{formId:'no'}])assert.equal(schema.safeParse({...p,...extra}).success,false);
  assert.equal(toolDefinitions.find(t=>t[0]===name)[3],undefined);
 }
 const list=z.object(enquiryReadTools[0][2]).strict();
 for(const extra of [{page:0},{page:1.1},{page:100001},{pageSize:101},{pageSize:null},{preset:'reviews'},{submittedFrom:'today'},{submittedFrom:'2026-01-01T10:00:00'},{submittedFrom:'2026-02-30T10:00:00Z'}])assert.equal(list.safeParse({businessId:'a',...extra}).success,false);
 assert.deepEqual(connectionPermissionNames.filter(p=>p.startsWith('enquiry_')),['enquiry_read','enquiry_status_read']);
});

test('enquiry reads isolate canonical submissions and preserve domain state',async t=>{
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
  await db.query("select set_config('platform.actor_issuer',$1,false)",[crm]);
  const register=async(subject)=>{
   const owner=await account(subject,customer);
   await db.query('select public.complete_platform_onboarding($1,$2)',[owner,JSON.stringify({businessName:subject,contactEmail:'owner@example.test',contactPhone:'+17208429167',summary:'Local repair services for nearby residents.',services:['Repairs'],locations:['Denver'],timeZone:'America/Denver'})]);
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
  const connectionId=(await invoke('crm_get_access')).data.connectionId;let revision=0;
  const grant=async(permissions,{status='active',allBusinesses=false,businessIds=[a]}={})=>{
   const r=await call(db,'mcp_admin','staff','save',{connectionId,revision,status,permissions,businessIds,allBusinesses});revision=r.connection.revision;
  };
  const form=async(business,preset)=>{
   const f=(await call(db,'form_workspace','staff',business,'create',null,{title:'Shared form',preset,description:'',buttonLabel:'Send',fields})).form;
   await call(db,'form_workspace','staff',business,'save',f.public_id,{title:f.title,description:'',buttonLabel:'Send',fields,enabled:true});return f;
  };
  const fa=await form(a,'contacts'),fq=await form(a,'quote_requests'),fb=await form(b,'quote_requests'),booking=await form(a,'bookings');
  const submit=async(f)=>{
   const id=crypto.randomUUID();await call(db,'submit_web_form',f.public_id,{submissionId:id,name:'Test person',phone:'+17208429167',email:'test@example.test',smsOptIn:false,details:{items:'Saved answer'},...(f.preset==='bookings'?{appointmentAt:'2099-01-01T17:00:00Z'}:{})});return id;
  };
  const sa=await submit(fa),sq=await submit(fq),sb=await submit(fb),sk=await submit(booking);
  const detail={businessId:a,formId:fa.public_id,submissionId:sa};
  await t.test('new grants independent; status grant and all older grants do not expose answers',async()=>{
   assert.equal((await invoke('crm_get_enquiry',detail)).error.code,'PERMISSION_DENIED');
   await grant(connectionPermissionNames.filter(p=>p!=='enquiry_read'));
   assert.equal((await invoke('crm_list_enquiries',{businessId:a})).error.code,'PERMISSION_DENIED');
   assert.equal((await invoke('crm_get_enquiry',detail)).error.code,'PERMISSION_DENIED');
   await grant(['enquiry_read']);
   assert.equal((await invoke('crm_get_enquiry',detail)).ok,true);
   for(const tool of ['crm_list_sms_runs','crm_list_form_submissions','crm_get_form','crm_get_enquiry_status','crm_start_sms_automation_run'])assert.equal((await invoke(tool,detail)).error.code,'PERMISSION_DENIED');
  });
  await t.test('tenant filters precede totals/pages; same phone/email and form title cannot join another tenant',async()=>{
   const one=(await invoke('crm_list_enquiries',{businessId:a,pageSize:1})).data;
   const two=(await invoke('crm_list_enquiries',{businessId:a,pageSize:1,page:2})).data;
   assert.equal(one.total,3);assert.notEqual(one.enquiries[0].id,two.enquiries[0].id);
   assert.equal((await invoke('crm_list_enquiries',{businessId:a,page:100000})).data.enquiries.length,0);
   assert.equal((await invoke('crm_list_enquiries',{businessId:a,preset:'quote_requests'})).data.enquiries[0].id,sq);
   assert.equal((await invoke('crm_list_enquiries',{businessId:a,formId:fa.public_id})).data.total,1);
   const at=(await invoke('crm_get_enquiry',detail)).data.enquiry.submittedAt;
   assert.equal((await invoke('crm_list_enquiries',{businessId:a,formId:fa.public_id,submittedFrom:at})).data.total,1);
   assert.equal((await invoke('crm_list_enquiries',{businessId:a,formId:fa.public_id,submittedBefore:at})).data.total,0);
   for(const p of [{...detail,businessId:b},{...detail,formId:fb.public_id,submissionId:sb},{...detail,submissionId:sb},{...detail,formId:fq.public_id}])assert.equal((await invoke('crm_get_enquiry',p)).error.code,'PERMISSION_DENIED');
   await grant(['enquiry_read'],{businessIds:[a,b]});
   const hidden=(await invoke('crm_get_enquiry',{...detail,submissionId:sb})).error;
   assert.deepEqual(hidden,(await invoke('crm_get_enquiry',{...detail,submissionId:crypto.randomUUID()})).error);
   assert.equal((await invoke('crm_list_enquiries',{businessId:a,formId:fb.public_id})).error.message,'Enquiry unavailable');
   assert.equal((await invoke('crm_get_enquiry',{businessId:b,formId:fb.public_id,submissionId:sb})).ok,true);
   await grant(['enquiry_read']);
  });
  await t.test('historical content, consent and appointment facts survive form edits/archive; strict projection',async()=>{
   await call(db,'form_workspace','staff',a,'save',fa.public_id,{title:'Renamed',description:'',buttonLabel:'Send',fields:[{...fields[0],label:'New label'}],enabled:false});
   await call(db,'form_workspace','staff',a,'archive',fa.public_id,{});
   const d=(await invoke('crm_get_enquiry',detail)).data.enquiry;
   assert.equal(d.formName,'Renamed');assert.equal(d.smsConsent,false);assert.equal(d.answers[0].label,'Original items label');assert.equal(d.answers[0].value,'Saved answer');
   assert.ok(d.formRevision>d.submittedFormVersion);assert.equal(d.appointmentAt,null);
   assert.equal((await invoke('crm_list_enquiries',{businessId:a})).data.total,3);
   assert.ok((await invoke('crm_get_enquiry',{businessId:a,formId:booking.public_id,submissionId:sk})).data.enquiry.appointmentAt);
   assert.equal(toolOutputs.crm_get_enquiry.safeParse({...(await invoke('crm_get_enquiry',detail)).data,enquiry:{...d,internal:'secret'}}).success,false);
   assert.equal(toolOutputs.crm_get_enquiry.safeParse({...(await invoke('crm_get_enquiry',detail)).data,enquiry:{...d,answers:[{...d.answers[0],internal:'secret'}]}}).success,false);
   const list=(await invoke('crm_list_enquiries',{businessId:a})).data;
   assert.equal(JSON.stringify(list).includes('Saved answer'),false);
   for(const key of ['run','contactId','status','consent_evidence','payload_fingerprint','automation_intake_id','details','field_snapshot'])assert.equal(key in d,false);
   await db.query("update public.sms_web_form_contact_submissions set details=$2 where tenant_id=$1",[a,JSON.stringify({items:'x'.repeat(4100),nested:{private:'not-exposed'},flag:false,count:0,empty:null})]);
   const capped=(await invoke('crm_get_enquiry',detail)).data.enquiry;
   assert.equal(capped.answersTruncated,true);assert.equal(capped.answers.find(x=>x.key==='items').value.length,4000);assert.equal(JSON.stringify(capped).includes('not-exposed'),false);
   assert.equal(capped.answers.find(x=>x.key==='flag').value,false);assert.equal(capped.answers.find(x=>x.key==='count').value,0);
   const many=Object.fromEntries(Array.from({length:105},(_,i)=>['answer'+String(i).padStart(3,'0'),'Value']));
   await db.query('update public.sms_web_form_contact_submissions set details=$2 where tenant_id=$1',[a,JSON.stringify(many)]);
   const legacy=(await invoke('crm_get_enquiry',detail)).data.enquiry;
   assert.equal(legacy.answers.length,100);assert.equal(legacy.answersTruncated,true);
   assert.equal(legacy.answers[0].label,legacy.answers[0].key);
  });
  await t.test('database wrapper validates raw calls and cannot be called directly by MCP/API roles',async()=>{
   for(const extra of [{page:0},{page:1.1},{pageSize:101},{pageSize:'1'},{preset:'reviews'},{actor:'forged'},{submittedFrom:'infinity'},{submittedFrom:'2026-02-30T10:00:00Z'},{submittedFrom:'2026-01-02T00:00:00Z',submittedBefore:'2026-01-01T00:00:00Z'}])assert.equal((await invoke('crm_list_enquiries',{businessId:a,...extra})).error.code,'VALIDATION_ERROR');
   for(const extra of [{submissionId:null},{submissionId:'bad'},{formId:null},{includeAnswers:true}])assert.equal((await invoke('crm_get_enquiry',{...detail,...extra})).error.code,'VALIDATION_ERROR');
   await db.exec('set role crm_mcp');assert.equal((await invoke('crm_get_enquiry',detail)).ok,true);await db.exec('reset role');
   for(const role of ['crm_mcp','anon','authenticated','sms_api','service_role']){
    await db.exec(`set role ${role}`);
    await assert.rejects(()=>call(db,'mcp_enquiry_read','staff',a,'crm_get_enquiry',detail),/permission denied/);
    if(role==='crm_mcp')await assert.rejects(()=>db.query('select * from public.sms_web_form_contact_submissions'),/permission denied/);
    await db.exec('reset role');
   }
  });
  await t.test('reads change only audit/access bookkeeping, never domain data or retry cache',async()=>{
   const tables=['public.sms_web_form_contact_submissions','public.sms_web_form_quote_request_submissions','public.sms_web_form_booking_submissions','public.sms_contacts','public.sms_web_form_definitions','sms_private.form_runs','sms_private.jobs','public.sms_messages','sms_private.mcp_requests','public.dashboard_cache_versions','pgmq.test_messages','net.test_requests'];
   const snapshot=async()=>{const out={};for(const table of tables)out[table]=(await db.query(`select coalesce(jsonb_agg(to_jsonb(x) order by to_jsonb(x)::text),'[]') value from ${table} x`)).rows[0].value;return out;};
   const before=await snapshot();await invoke('crm_get_enquiry',detail);await invoke('crm_list_enquiries',{businessId:a});await invoke('crm_get_enquiry',detail);assert.deepEqual(await snapshot(),before);
   const audit=(await db.query("select * from sms_private.mcp_activity where connection_id=$1 and tool in ('crm_get_enquiry','crm_list_enquiries')",[connectionId])).rows;
   assert.ok(audit.some(x=>x.target===sa&&x.revision!==null&&x.outcome==='success'));assert.ok(audit.some(x=>x.outcome==='denied'));
   assert.ok(audit.every(x=>x.actor_id===staff&&x.request_id));assert.doesNotMatch(JSON.stringify(audit),/Saved answer|test@example|7208429167|not-exposed/);
  });
  await t.test('all-business scope and immediate revocation, staff suspension and customer realm denial',async()=>{
   await grant(['enquiry_read'],{allBusinesses:true});assert.equal((await invoke('crm_get_enquiry',{businessId:b,formId:fb.public_id,submissionId:sb})).ok,true);
   const future=await register('future');assert.equal((await invoke('crm_list_enquiries',{businessId:future})).data.total,0);
   await grant(['enquiry_read'],{businessIds:[]});assert.equal((await invoke('crm_get_enquiry',detail)).error.code,'PERMISSION_DENIED');
   await grant([]);assert.equal((await invoke('crm_get_enquiry',detail)).error.code,'PERMISSION_DENIED');await grant(['enquiry_read']);
   await db.query("update public.dashboard_accounts set status='suspended' where id=$1",[staff]);assert.equal((await invoke('crm_get_enquiry',detail)).error.code,'PERMISSION_DENIED');
   await db.query("update public.dashboard_accounts set status='active' where id=$1",[staff]);assert.equal((await invoke('crm_get_enquiry',detail,'nonstaff')).error.code,'PERMISSION_DENIED');
   await db.query("select set_config('platform.actor_issuer',$1,false)",[customer]);assert.equal((await invoke('crm_get_enquiry',detail,'allowed')).error.code,'PERMISSION_DENIED');
   await db.query("select set_config('platform.actor_issuer',$1,false)",[crm]);
   await grant(['enquiry_read'],{status:'disabled'});assert.equal((await invoke('crm_get_enquiry',detail)).error.code,'PERMISSION_DENIED');
   await grant(['enquiry_read'],{status:'revoked'});assert.equal((await invoke('crm_get_enquiry',detail)).error.code,'PERMISSION_DENIED');
  });
 }finally{await db.close();}
});


