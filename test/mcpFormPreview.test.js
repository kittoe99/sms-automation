import test from 'node:test';
import assert from 'node:assert/strict';
import {z} from 'zod';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {fixture} from './helpers/twilioConnections.js';
import {call} from './helpers/database.js';
import {formPreviewTools,formPreviewOutputs} from '../src/mcp/formSchemas.js';
import {formPreviewResource} from '../src/mcp/formPreview.js';
import {createMcpServer,toolOutputs} from '../src/mcp/tools.js';
import {connectionPermissionNames} from '../public/mcpPermissions.js';

const definition={title:'Saved <img src=x onerror=alert(1)>',description:'Private draft <script>alert(1)</script>',buttonLabel:'Request <help>',fields:[
 {key:'items',label:'Items & materials',type:'textarea',required:true},
 {key:'size',label:'Size',type:'select',required:false,options:['Small','<img src=x>']},
 {key:'access',label:'Access',type:'checkbox',required:true},
 {key:'day',label:'Preferred date',type:'date',required:false},
 {key:'notes',label:'Notes',type:'text',required:false},
]};
const preview={businessId:'business-a',timeZone:'America/Denver',mode:'saved_draft',submittable:false,
 form:{id:'00000000-0000-4000-8000-000000000001',preset:'contacts',revision:2,draftRevision:1,draftBaseRevision:2,draftStale:false,collectionEnabled:false,archived:false,definition},
 fixedFields:[['name','Name','text'],['phone','Phone','tel'],['email','Email','email']].map(([key,label,type])=>({key,label,type,required:true})),
 consent:{sms:{text:'Optional SMS consent',required:false,checked:false},email:null},warnings:[]};

test('saved form preview has strict, revision-bound schemas and inert escaped HTML',()=>{
 const schema=z.object(formPreviewTools[0][2]).strict(),p={businessId:'a',formId:preview.form.id,revision:2,draftRevision:1};
 assert.ok(schema.safeParse(p).success);
 for(const patch of [{businessId:''},{businessId:' '},{formId:'bad'},{revision:null},{revision:0},{revision:1.2},{revision:1e100},{draftRevision:'1'},{draftRevision:0},
  {sample:{phone:'+17208429167'}},{definition},{idempotencyKey:'not-needed'},{enabled:true},{source:'published'},{contactId:crypto.randomUUID()}])assert.equal(schema.safeParse({...p,...patch}).success,false);
 for(const key of Object.keys(p)){const missing={...p};delete missing[key];assert.equal(schema.safeParse(missing).success,false);}
 const r=formPreviewResource(preview),html=r.resource.text;
 assert.equal(r.resource.mimeType,'text/html');assert.match(r.resource.uri,/^crm-form-preview:\/\/draft\//);
 assert.match(html,/&lt;img src=x onerror=alert\(1\)&gt;/);assert.match(html,/&lt;script&gt;/);assert.match(html,/Request &lt;help&gt;/);
 assert.doesNotMatch(html,/<(?:form|script|img|iframe|a)\b/i);assert.doesNotMatch(html,/\b(?:action|src|href|on\w+)="/i);
 assert.match(html,/default-src 'none'/);assert.match(html,/form-action 'none'/);
 for(const tag of html.match(/<(?:input|textarea|select|button)\b[^>]*>/g))assert.match(tag,/\bdisabled\b/);
 assert.doesNotMatch(html,/\bchecked(?:\s|>|=)/);
 assert.match(html,/<button type="button" disabled>/);assert.match(html,/id="preview-day" disabled type="date"/);
 assert.ok(html.indexOf('id="preview-name"')<html.indexOf('id="preview-items"'));
 assert.ok(html.indexOf('id="preview-notes"')<html.indexOf('id="preview-sms_opt_in"'));
 assert.equal(formPreviewOutputs.crm_preview_form.safeParse({...preview,contacts:[]}).success,false);
 assert.equal(formPreviewOutputs.crm_preview_form.safeParse({...preview,form:{...preview.form,secret:'not allowed'}}).success,false);
});

test('MCP preview returns typed data and an embedded inert resource only on successful authorization',async()=>{
 const [clientTransport,serverTransport]=InMemoryTransport.createLinkedPair();let denied=false;
 const server=createMcpServer({identity:{subject:'staff',clientId:'test'},requestId:crypto.randomUUID(),invoke:async()=>denied?
  {ok:false,error:{code:'PERMISSION_DENIED',message:'Preview not granted',retryable:false}}:{ok:true,data:preview}});
 const client=new Client({name:'form-preview-test',version:'1'},{capabilities:{}});
 try{
  await server.connect(serverTransport);await client.connect(clientTransport);
  const args={businessId:preview.businessId,formId:preview.form.id,revision:2,draftRevision:1};
  const result=await client.callTool({name:'crm_preview_form',arguments:args});
  assert.deepEqual(result.structuredContent.data,preview);assert.equal(result.content.length,2);
  assert.deepEqual(result.content[1],formPreviewResource(preview));
  denied=true;const error=await client.callTool({name:'crm_preview_form',arguments:args});
  assert.equal(error.isError,true);assert.equal(error.content.length,1);assert.equal(error.structuredContent.data,undefined);
 }finally{await client.close();await server.close();}
});

test('form previews enforce independent grants, tenant isolation and zero domain changes',async t=>{
 const x=await fixture(),{db}=x;
 try{
  const {tenant:a}=await x.business('allowed'),{tenant:b}=await x.business('hidden');
  const invoke=async(tool,p={},subject='staff')=>{
   const r=(await db.query('select crm_mcp.invoke($1,$2,$3,$4,$5) r',[subject,'preview-client',tool,JSON.stringify(p),crypto.randomUUID()])).rows[0].r;
   if(r.ok)toolOutputs[tool].parse(r.data);return r;
  };
  const connectionId=(await invoke('crm_get_access')).data.connectionId;let revision=0;
  const grant=async(permissions,{businessIds=[a],status='active',allBusinesses=false}={})=>{
   const r=await call(db,'mcp_admin','staff','save',{connectionId,revision,status,permissions,businessIds,allBusinesses});revision=r.connection.revision;
  };
  const canonical=async(business,title)=>(await call(db,'form_workspace','staff',business,'create',null,{...definition,title,preset:'contacts'})).form;
  const absent=await canonical(a,'No saved draft'),foreign=await canonical(b,'Hidden form');
  const p={businessId:a,formId:absent.public_id,revision:2,draftRevision:1};
  await t.test('preview is denied for pending connections and every other grant combined',async()=>{
   assert.equal((await invoke('crm_preview_form',p)).error.code,'PERMISSION_DENIED');
   await grant(connectionPermissionNames.filter(x=>x!=='form_preview'));
   assert.equal((await invoke('crm_preview_form',p)).error.code,'PERMISSION_DENIED');
  });
  await grant(['form_create']);const forms=[];
  for(const preset of ['contacts','quote_requests','bookings']){
   const r=await invoke('crm_create_form',{businessId:a,preset,definition,idempotencyKey:'preview-'+preset});assert.equal(r.ok,true,JSON.stringify(r));forms.push(r.data.form);
  }
  const [contact,quote,booking]=forms;
  // Existing collection/automation data provides a nonempty no-side-effect fixture.
  await db.query('update public.sms_web_form_definitions set enabled=true where public_id=$1',[contact.id]);
  await db.query('update public.sms_web_form_definitions set legacy_form=true,email_enabled=true where public_id=$1',[quote.id]);
  await db.query('insert into sms_private.form_sequences(tenant_id,form_id,published_version,enabled) values($1,$2,1,true)',[a,contact.id]);
  await db.query("insert into sms_private.form_sequence_versions(tenant_id,form_id,version,sequence) values($1,$2,1,'{}')",[a,contact.id]);
  await db.query("insert into sms_private.form_runs(tenant_id,form_id,version,submission_id,phone,context,status,next_run_at) values($1,$2,1,gen_random_uuid(),'+17208429167','{}','active',now()+interval '1 day')",[a,contact.id]);
  const inputs=f=>({businessId:a,formId:f.id,revision:f.revision,draftRevision:f.draftRevision});
  const tables=['public.sms_web_form_definitions','sms_private.mcp_form_drafts','public.sms_contacts','public.sms_businesses','sms_private.form_sequences','sms_private.form_sequence_versions','sms_private.form_runs','sms_private.jobs','sms_private.email_enrollments','sms_private.mcp_requests','pgmq.test_messages','net.test_requests',
   'public.sms_web_form_contact_submissions','public.sms_web_form_quote_request_submissions','public.sms_web_form_booking_submissions'];
  const snapshot=async()=>{const out={};for(const table of tables)out[table]=(await db.query(`select coalesce(jsonb_agg(to_jsonb(x) order by to_jsonb(x)::text),'[]') value from ${table} x`)).rows[0].value;return out;};
  await grant(['form_preview']);const before=await snapshot();
  await t.test('preview-only access shows the saved definition, ordered fields and unchecked canonical consent',async()=>{
   for(const f of forms){
    const r=await invoke('crm_preview_form',inputs(f));assert.equal(r.ok,true,JSON.stringify(r));
    assert.deepEqual(r.data.form.definition,definition);assert.equal(r.data.submittable,false);assert.deepEqual(r.data.warnings,[]);
    assert.equal(r.data.form.draftRevision,1);assert.equal(r.data.form.draftBaseRevision,2);
    assert.deepEqual(r.data.fixedFields.map(x=>x.key),['name','phone','email',...(f.preset==='bookings'?['appointment_at']:[])]);
    const business=(await db.query('select name from public.sms_businesses where tenant_id=$1',[a])).rows[0].name;
    assert.deepEqual(r.data.consent.sms,{text:await call(db,'web_form_consent_text',business),checked:false,required:false});
    assert.equal(!!r.data.consent.email,f.id===quote.id);
    if(f.id===quote.id)assert.deepEqual(r.data.consent.email,{text:await call(db,'email_consent_text',business),checked:false,required:false});
    if(f.id===booking.id)assert.match(r.data.fixedFields[3].label,/America\/Denver/);
    formPreviewResource(r.data);
    assert.deepEqual(await invoke('crm_preview_form',inputs(f)),r);
   }
   for(const tool of ['crm_get_form','crm_list_forms','crm_create_form','crm_save_form_draft','crm_preview_sms_automation','crm_set_form_followups_enabled','crm_start_sms_automation_run'])assert.equal((await invoke(tool,inputs(contact))).error.code,'PERMISSION_DENIED');
   assert.equal((await invoke('crm_preview_form',p)).error.code,'VALIDATION_ERROR');
  });
  await t.test('business and form substitution cannot expose even metadata or counts',async()=>{
   for(const v of [{...inputs(contact),businessId:b},{...p,formId:foreign.public_id},{...p,formId:crypto.randomUUID()}])assert.equal((await invoke('crm_preview_form',v)).error.code,'PERMISSION_DENIED');
   await grant(['form_preview'],{businessIds:[a,b]});
   assert.equal((await invoke('crm_preview_form',{...p,formId:foreign.public_id})).error.message,'Form unavailable');
   await grant(['form_preview']);
  });
  await t.test('SQL independently rejects unexpected sample data, invalid revisions and stale snapshots',async()=>{
   for(const patch of [{sample:{phone:'+17208429167'}},{contactId:crypto.randomUUID()},{definition},{enabled:true},{idempotencyKey:'extra-key'},{revision:null},{revision:'2'},{revision:0},{revision:1.1},{revision:1e100},{draftRevision:0},{draftRevision:null},{formId:'invalid'}]){
    const r=await invoke('crm_preview_form',{...inputs(contact),...patch});assert.equal(r.error.code,'VALIDATION_ERROR',JSON.stringify(patch));
   }
   for(const patch of [{revision:3},{draftRevision:2}])assert.equal((await invoke('crm_preview_form',{...inputs(contact),...patch})).error.code,'CONFLICT');
   assert.deepEqual(await snapshot(),before);
  });
  await t.test('stale bases and archived forms can be inspected with explicit warnings, never applied or reconciled',async()=>{
   await call(db,'form_workspace','staff',a,'save',contact.id,{...definition,title:'Applied edit',enabled:true});
   await call(db,'form_workspace','staff',a,'archive',contact.id,{});
   const state=await snapshot(),r=await invoke('crm_preview_form',{...inputs(contact),revision:3});
   assert.equal(r.ok,true,JSON.stringify(r));assert.equal(r.data.form.draftStale,true);
   assert.equal(r.data.form.draftBaseRevision,2);assert.equal(r.data.form.definition.title,definition.title);
   assert.deepEqual(r.data.warnings,['DRAFT_BASE_CHANGED','FORM_ARCHIVED']);
   assert.match(formPreviewResource(r.data).resource.text,/Reconciliation is required/);
   assert.deepEqual(await snapshot(),state);
  });
  await t.test('restricted role and audit expose no raw draft, customer answers or preview HTML',async()=>{
   await db.exec('set role crm_mcp');
   try{
    assert.equal((await invoke('crm_preview_form',inputs(booking))).ok,true);
    await assert.rejects(db.query('select sms_private.mcp_form_preview($1,$2,$3)',['staff',a,JSON.stringify(inputs(booking))]),/permission denied/);
   }finally{await db.exec('reset role');}
   for(const role of ['anon','authenticated','service_role','crm_mcp','sms_api'])assert.equal((await db.query("select has_function_privilege($1,'sms_private.mcp_form_preview(text,text,jsonb)','execute') allowed",[role])).rows[0].allowed,false);
   const audit=(await db.query("select * from sms_private.mcp_activity where connection_id=$1 and tool='crm_preview_form'",[connectionId])).rows;
   assert.ok(audit.some(row=>row.target===booking.id&&row.revision===2&&row.draft_revision===1&&row.outcome==='success'));
   assert.ok(audit.some(row=>row.outcome==='denied'));assert.ok(audit.every(row=>row.actor_id===x.admin&&row.request_id));
   for(const value of [definition.title,definition.description,'7208429167','<html>'])assert.equal(JSON.stringify(audit).includes(value),false);
  });
  await t.test('scope, permission, staff and connection changes are honored on every preview',async()=>{
   await grant(['form_preview'],{allBusinesses:true,businessIds:[]});assert.equal((await invoke('crm_preview_form',inputs(booking))).ok,true);
   await grant(['form_preview'],{businessIds:[]});assert.equal((await invoke('crm_preview_form',inputs(booking))).error.code,'PERMISSION_DENIED');
   await grant([]);assert.equal((await invoke('crm_preview_form',inputs(booking))).error.code,'PERMISSION_DENIED');
   await grant(['form_preview']);
   assert.equal((await invoke('crm_preview_form',inputs(booking),'reader')).error.code,'PERMISSION_DENIED');
   await db.query("update public.dashboard_accounts set status='suspended' where id=$1",[x.admin]);
   assert.equal((await invoke('crm_preview_form',inputs(booking))).error.code,'PERMISSION_DENIED');
   await db.query("update public.dashboard_accounts set status='active' where id=$1",[x.admin]);
   await db.query("select set_config('platform.actor_issuer','https://customer.example.test',false)");
   assert.equal((await invoke('crm_preview_form',inputs(booking),'allowed')).error.code,'PERMISSION_DENIED');
   await db.query("select set_config('platform.actor_issuer','https://staff.example.test',false)");
   for(const status of ['disabled','revoked']){await grant(['form_preview'],{status});assert.equal((await invoke('crm_preview_form',inputs(booking))).error.code,'PERMISSION_DENIED');}
  });
 }finally{await db.close();}
});
