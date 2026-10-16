import test from 'node:test';
import assert from 'node:assert/strict';
import {z} from 'zod';
import {fixture} from './helpers/twilioConnections.js';
import {call} from './helpers/database.js';
import {leadHandoffTools} from '../src/mcp/leadHandoffSchemas.js';
import {toolOutputs,toolDefinitions} from '../src/mcp/tools.js';
import {connectionPermissionNames} from '../public/mcpPermissions.js';
const migration='20261016164055_crm_mcp_lead_handoff_reads.sql',oldId='00000000-0000-4000-8000-000000000099';
test('lead/handoff input and output contracts are strict and reads are annotated',()=>{
 for(const [name,,shape] of leadHandoffTools){
  const schema=z.object(shape).strict(),input={businessId:'a',...(name==='crm_get_lead'?{leadId:crypto.randomUUID()}:name==='crm_get_handoff'?{handoffId:crypto.randomUUID()}:{} )};
  assert.ok(schema.safeParse(input).success);
  for(const patch of [{businessId:''},{businessId:' '},{businessId:1},{businessId:'a'.repeat(256)},{actor:'x'},{tenantId:'other'},{includeAnswers:true},{idempotencyKey:'not-a-write'}])assert.equal(schema.safeParse({...input,...patch}).success,false);
  assert.equal(toolDefinitions.find(t=>t[0]===name)[3],undefined);
  if(name.includes('list'))for(const patch of [{page:0},{pageSize:101},{page:1.5},{page:100001},{pageSize:'2'},{q:'x'.repeat(101)},{q:null},{status:'won'},{contactId:'bad'}])assert.equal(schema.safeParse({...input,...patch}).success,false);
 }
});
test('lead/handoff reads isolate grants, nested links, pagination and audit without domain mutations',async t=>{
 const {db,admin,business}=await fixture({beforeMigration:async(db,file)=>{
  if(file===migration)await db.query("insert into sms_private.mcp_connections(id,issuer,subject,account_id,client_id,status,permissions,all_businesses) values($1,'legacy','legacy',$1,'legacy','active',array['read'],true)",[oldId]);
 }});
 try{
  assert.deepEqual((await db.query('select permissions from sms_private.mcp_connections where id=$1',[oldId])).rows[0].permissions,['read']);
  const a=(await business('a')).tenant,b=(await business('b')).tenant;
  for(const tenantId of [a,b])await call(db,'platform_action','staff','service_add',{tenantId,kind:'sms'});
  const invoke=async(tool,p={},u='staff')=>{
   const r=(await db.query('select crm_mcp.invoke($1,$2,$3,$4,$5) r',[u,'https://client.example.test/codex.json',tool,JSON.stringify(p),crypto.randomUUID()])).rows[0].r;
   if(r.ok)toolOutputs[tool].parse(r.data);return r;
  };
  const connectionId=(await invoke('crm_get_access')).data.connectionId;let revision=0;
  const grant=async(permissions,{status='active',businessIds=[a],allBusinesses=false}={})=>{const v=await call(db,'mcp_admin','staff','save',{connectionId,revision,permissions,status,businessIds,allBusinesses});revision=v.connection.revision;};
  const make=async(tenant)=>{
   const contact=(await db.query("insert into public.sms_contacts(tenant_id,phone,name) values($1,'+17208429167','Shared test contact') returning id",[tenant])).rows[0].id;
   const lead=(await db.query("insert into public.sms_leads(tenant_id,contact_id,summary,owner,fields) values($1,$2,'Saved lead summary','Owner label','{\"secret\":\"private-fields\"}') returning id",[tenant,contact])).rows[0].id;
   const job=(await db.query("insert into sms_private.jobs(tenant_id,queue,dedupe_key,payload) values($1,'ai_reply_jobs',$2,'{}') returning id",[tenant,crypto.randomUUID()])).rows[0].id;
   const handoff=(await db.query("insert into public.sms_handoffs(tenant_id,contact_id,lead_id,ai_job_id,reason,alert_error) values($1,$2,$3,$4,'Needs staff assistance','private-alert') returning id",[tenant,contact,lead,job])).rows[0].id;
   return {contact,lead,handoff};
  };
  const ra=await make(a),rb=await make(b);
  const lead=()=>invoke('crm_get_lead',{businessId:a,leadId:ra.lead}),handoff=()=>invoke('crm_get_handoff',{businessId:a,handoffId:ra.handoff});
  await t.test('independent read grants; reserved writes and older grants reveal neither resource',async()=>{
   assert.equal((await lead()).error.code,'PERMISSION_DENIED');
   await grant(connectionPermissionNames.filter(x=>!['lead_read','handoff_read'].includes(x)));
   for(const [tool,p] of [['crm_list_leads',{}],['crm_list_handoffs',{}],['crm_get_lead',{leadId:ra.lead}],['crm_get_handoff',{handoffId:ra.handoff}]])assert.equal((await invoke(tool,{businessId:a,...p})).error.code,'PERMISSION_DENIED');
   await grant(['lead_read']);assert.ok((await lead()).ok);assert.equal((await handoff()).error.code,'PERMISSION_DENIED');
   await grant(['handoff_read']);assert.ok((await handoff()).ok);assert.equal((await lead()).error.code,'PERMISSION_DENIED');
   for(const tool of ['crm_get_enquiry','crm_get_enquiry_status','crm_get_sms_run','crm_start_sms_automation_run'])assert.equal((await invoke(tool,{businessId:a})).error.code,'PERMISSION_DENIED');
   assert.equal((await invoke('crm_update_handoff',{businessId:a,handoffId:ra.handoff,status:'closed'})).error.code,'PERMISSION_DENIED');
  });
  await grant(['lead_read','handoff_read']);
  await db.query("insert into public.sms_leads(tenant_id,contact_id,status,summary,created_at) values($1,$2,'closed','Older result','2000-01-01')",[a,ra.contact]);
  await t.test('scope precedes totals/search/pages; foreign and missing detail share an error',async()=>{
   const first=(await invoke('crm_list_leads',{businessId:a,pageSize:1})).data,second=(await invoke('crm_list_leads',{businessId:a,pageSize:1,page:2})).data;
   assert.equal(first.total,2);assert.equal(first.leads[0].id,ra.lead);assert.notEqual(first.leads[0].id,second.leads[0].id);
   assert.equal((await invoke('crm_list_leads',{businessId:a,status:'closed'})).data.total,1);
   assert.equal((await invoke('crm_list_leads',{businessId:a,q:'older'})).data.total,1);
   assert.equal((await invoke('crm_list_leads',{businessId:a,q:'%'})).data.total,0);
   assert.equal((await invoke('crm_list_leads',{businessId:a,contactId:rb.contact})).data.total,0);
   assert.equal((await invoke('crm_list_leads',{businessId:a,page:100000})).data.leads.length,0);
   assert.equal((await invoke('crm_list_handoffs',{businessId:a})).data.total,1);
   for(const [tool,key,id] of [['crm_get_lead','leadId',rb.lead],['crm_get_handoff','handoffId',rb.handoff]]){
    assert.deepEqual((await invoke(tool,{businessId:a,[key]:id})).error,(await invoke(tool,{businessId:a,[key]:crypto.randomUUID()})).error);
    assert.equal((await invoke(tool,{businessId:b,[key]:id})).error.code,'PERMISSION_DENIED');
   }
   await grant(['lead_read','handoff_read'],{businessIds:[a,b]});assert.ok((await invoke('crm_get_lead',{businessId:b,leadId:rb.lead})).ok);
   assert.equal((await invoke('crm_get_handoff',{businessId:a,handoffId:rb.handoff})).error.message,'Record unavailable');
   await grant(['lead_read','handoff_read']);
  });
  const makeRun=async(tenant)=>{
   const f=(await call(db,'form_workspace','staff',tenant,'create',null,{title:'Test',preset:'contacts',description:'',buttonLabel:'Send',fields:[]})).form;
   await call(db,'form_workspace','staff',tenant,'save',f.public_id,{title:'Test',description:'',buttonLabel:'Send',fields:[],enabled:true});
   const sid=crypto.randomUUID();await call(db,'submit_web_form',f.public_id,{submissionId:sid,name:'Shared test contact',phone:'+17208429167',email:'test@example.test',smsOptIn:false,details:{}});
   await db.query('insert into sms_private.form_sequences(tenant_id,form_id) values($1,$2)',[tenant,f.public_id]);
   await db.query("insert into sms_private.form_sequence_versions(tenant_id,form_id,version,sequence) values($1,$2,1,'{}')",[tenant,f.public_id]);
   const run=(await db.query("insert into sms_private.form_runs(tenant_id,form_id,version,submission_id,phone,context,status) values($1,$2,1,$3,'+17208429167','{}','stopped') returning id",[tenant,f.public_id,sid])).rows[0].id;
   return {run,form:f.public_id,submission:sid};
  };
  const runA=await makeRun(a),runB=await makeRun(b);
  await t.test('explicit associations only; corrupt foreign links and same-phone coincidences do not leak',async()=>{
   assert.equal((await lead()).data.lead.enquiry,null);assert.equal((await handoff()).data.handoff.enquiry,null);
   await db.query('insert into sms_private.activity_handoffs(tenant_id,handoff_id,run_id) values($1,$2,$3)',[a,ra.handoff,runB.run]);
   assert.equal((await handoff()).data.handoff.enquiry,null);
   await db.query('update sms_private.activity_handoffs set run_id=$3 where tenant_id=$1 and handoff_id=$2',[a,ra.handoff,runA.run]);
   assert.equal((await handoff()).data.handoff.enquiry.submissionId,runA.submission);
   const message=(await db.query("insert into public.sms_messages(tenant_id,contact_phone,direction,body,status) values($1,'+17208429167','inbound','private-message','received') returning id",[a])).rows[0].id;
   await db.query('update public.sms_leads set source_message_id=$2 where id=$1',[ra.lead,message]);
   await db.query("insert into sms_private.activity_responses(tenant_id,message_id,run_id,basis) values($1,$2,$3,'staff_explicit') on conflict(tenant_id,message_id) do update set run_id=excluded.run_id",[a,message,runB.run]);
   assert.equal((await lead()).data.lead.enquiry,null);
   await db.query('update sms_private.activity_responses set run_id=$3 where tenant_id=$1 and message_id=$2',[a,message,runA.run]);
   assert.equal((await lead()).data.lead.enquiry.runId,runA.run);
   await db.query("update sms_private.form_runs set test_sequence='{}',test_actor='staff',test_request='{}',version=null where id=$1",[runA.run]);
   assert.equal((await lead()).data.lead.enquiry,null);assert.equal((await handoff()).data.handoff.enquiry,null);
   await db.query('update sms_private.form_runs set test_sequence=null,test_actor=null,test_request=null,version=1,submission_id=$2 where id=$1',[runA.run,runB.submission]);
   assert.equal((await handoff()).data.handoff.enquiry,null);
   await db.query('update sms_private.form_runs set submission_id=$2 where id=$1',[runA.run,runA.submission]);
   const template=(await db.query("insert into sms_private.direct_templates(tenant_id,name,draft,published_version) values($1,'Direct test','{}',1) returning id",[a])).rows[0].id;
   await db.query("insert into sms_private.direct_versions(tenant_id,template_id,version,sequence,actor) values($1,$2,1,'{}','staff')",[a,template]);
   const direct=(await db.query("insert into sms_private.form_runs(tenant_id,origin,direct_template_id,version,direct_sequence,phone,context,status,enrollment_key) values($1,'direct',$2,1,'{}','+17208429167','{}','stopped','test-direct') returning id",[a,template])).rows[0].id;
   await db.query('update sms_private.activity_handoffs set run_id=$3 where tenant_id=$1 and handoff_id=$2',[a,ra.handoff,direct]);
   assert.deepEqual((await handoff()).data.handoff.enquiry,{runId:direct,origin:'direct',formId:null,submissionId:null});
   await db.query('update sms_private.activity_handoffs set run_id=$3 where tenant_id=$1 and handoff_id=$2',[a,ra.handoff,runA.run]);
  });
  await t.test('bounded redacted output, truthful revision availability and DB validation',async()=>{
   await db.query('update public.sms_leads set summary=$2,owner=$3 where id=$1',[ra.lead,'x'.repeat(4010),'y'.repeat(210)]);
   const d=(await lead()).data;assert.ok(d.lead.revision>1);assert.ok(d.lead.updatedAt);assert.equal(d.lead.summary.length,4000);assert.equal(d.lead.owner.length,200);assert.equal(d.lead.textTruncated,true);
   assert.equal(toolOutputs.crm_get_lead.safeParse({...d,lead:{...d.lead,fields:{}}}).success,false);
   assert.equal(toolOutputs.crm_get_lead.safeParse({...d,lead:{...d.lead,contact:{...d.lead.contact,email:'private'}}}).success,false);
   assert.doesNotMatch(JSON.stringify((await handoff()).data),/private-alert|private-message|private-fields|ai_job_id|lead_id|alert_status|consent/);
   for(const [name,,shape] of leadHandoffTools){
    const detail=name==='crm_get_lead'?{leadId:ra.lead}:name==='crm_get_handoff'?{handoffId:ra.handoff}:{};
    for(const extra of [{actor:'forged'},{businessId:''},{idempotencyKey:'bad'},...(name.includes('list')?[{page:0},{pageSize:'2'},{pageSize:101},{page:1.5},{q:null},{status:null},{contactId:null}]:[{[Object.keys(detail)[0]]:null}])])assert.equal((await invoke(name,{businessId:a,...detail,...extra})).ok,false);
    assert.ok(z.object(shape).strict().safeParse({businessId:a,...detail}).success);
   }
  });
  await t.test('private role restrictions, audit redaction and unchanged domain/cache/queues',async()=>{
   const tables=['public.sms_leads','public.sms_handoffs','public.sms_contacts','public.sms_messages','sms_private.form_runs','sms_private.jobs','sms_private.activity_events','sms_private.mcp_requests','public.dashboard_cache_versions','pgmq.test_messages','net.test_requests'];
   const snapshot=async()=>{const out={};for(const table of tables)out[table]=(await db.query(`select coalesce(jsonb_agg(to_jsonb(x) order by to_jsonb(x)::text),'[]') v from ${table} x`)).rows[0].v;return out;};
   const before=await snapshot();await lead();await handoff();await invoke('crm_list_leads',{businessId:a});await invoke('crm_list_handoffs',{businessId:a});assert.deepEqual(await snapshot(),before);
   await db.exec('set role crm_mcp');assert.ok((await lead()).ok);await assert.rejects(()=>db.query('select * from public.sms_leads'),/permission denied/);await db.exec('reset role');
   for(const role of ['crm_mcp','anon','authenticated','sms_api','service_role']){await db.exec(`set role ${role}`);await assert.rejects(()=>call(db,'mcp_lead_handoff_read','staff',a,'crm_get_lead',{businessId:a,leadId:ra.lead}),/permission denied/);await db.exec('reset role');}
   const audit=(await db.query("select * from sms_private.mcp_activity where connection_id=$1 and tool in ('crm_get_lead','crm_get_handoff','crm_list_leads','crm_list_handoffs')",[connectionId])).rows;
   assert.ok(audit.some(x=>x.target===ra.lead&&x.outcome==='success'&&x.revision>1));assert.ok(audit.some(x=>x.target===ra.handoff&&x.outcome==='success'));assert.ok(audit.some(x=>x.outcome==='denied'));assert.ok(audit.every(x=>x.actor_id===admin&&x.request_id));
   assert.doesNotMatch(JSON.stringify(audit),/Saved lead|Owner label|Needs staff|private-|7208429167/);
  });
  await t.test('immediate permission/scope/status revocation and identity enforcement',async()=>{
   await grant(['lead_read','handoff_read'],{allBusinesses:true});assert.ok((await invoke('crm_get_handoff',{businessId:b,handoffId:rb.handoff})).ok);
   const future=(await business('future')).tenant;assert.equal((await invoke('crm_list_leads',{businessId:future})).data.total,0);
   await grant(['lead_read','handoff_read'],{businessIds:[]});assert.equal((await lead()).error.code,'PERMISSION_DENIED');
   await grant([]);assert.equal((await handoff()).error.code,'PERMISSION_DENIED');await grant(['lead_read','handoff_read']);
   await db.query("update public.dashboard_accounts set status='suspended' where id=$1",[admin]);assert.equal((await lead()).error.code,'PERMISSION_DENIED');
   await db.query("update public.dashboard_accounts set status='active' where id=$1",[admin]);assert.equal((await invoke('crm_list_leads',{businessId:a},'reader')).error.code,'PERMISSION_DENIED');
   await db.query("select set_config('platform.actor_issuer','https://customer.example.test',false)");assert.equal((await invoke('crm_list_leads',{businessId:a},'a')).error.code,'PERMISSION_DENIED');
   await db.query("select set_config('platform.actor_issuer','https://staff.example.test',false)");
   await grant(['lead_read','handoff_read'],{status:'disabled'});assert.equal((await lead()).error.code,'PERMISSION_DENIED');
   await grant(['lead_read','handoff_read'],{status:'revoked'});assert.equal((await handoff()).error.code,'PERMISSION_DENIED');
  });
 }finally{await db.close();}
});
