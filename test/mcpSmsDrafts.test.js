import test from 'node:test';
import assert from 'node:assert/strict';
import {z} from 'zod';
import {fixture} from './helpers/twilioConnections.js';
import {call} from './helpers/database.js';
import {toolOutputs} from '../src/mcp/tools.js';
import {smsDraftTools} from '../src/mcp/smsDraftSchemas.js';
import {emptySequence,newMessage} from '../public/formAutomation.js';

const seq=(body='Hello {{first_name}}',extra={})=>({...emptySequence(),startHour:0,endHour:24,steps:[newMessage(body)],...extra});
const sample={name:'Alex Example',phone:'+13035550166',email:'alex@example.test',smsOptIn:true};
const start='2030-03-09T10:00';
test('draft and preview schemas are explicit and bounded',()=>{
 const shapes=Object.fromEntries(smsDraftTools.map(([name,,shape])=>[name,z.object(shape).strict()]));
 const input={businessId:'test',kind:'contact',name:'Test',sequence:seq(),idempotencyKey:'request-1'};
 assert.equal(shapes.crm_create_sms_automation.safeParse(input).success,true);
 for(const patch of [{idempotencyKey:''},{sequence:{...seq(),steps:[]}},{sequence:{...seq(),startHour:1.5}},{sequence:seq('x'.repeat(1601))},{enabled:true},{kind:'legacy'}])assert.equal(shapes.crm_create_sms_automation.safeParse({...input,...patch}).success,false);
 assert.equal(shapes.crm_save_sms_automation_draft.safeParse(input).success,false);
 assert.equal(shapes.crm_preview_sms_automation.safeParse({businessId:'a',kind:'form',automationId:crypto.randomUUID(),revision:0,submittedLocal:start,sample}).success,true);
 assert.equal(shapes.crm_preview_sms_automation.safeParse({businessId:'a',kind:'form',automationId:crypto.randomUUID(),revision:0,sample}).success,false);
});

test('MCP drafts and simulation preserve grants, retries, versions and messaging boundaries',async t=>{
 const x=await fixture(),{db}=x;
 try{
  const {tenant:a}=await x.business('allowed'),{tenant:b}=await x.business('hidden');
  const form=async(tenant,preset='contacts',fields=[])=>(await call(db,'form_workspace','staff',tenant,'create',null,{title:'Form',preset,fields,description:'',buttonLabel:'Send',enabled:false})).form;
  let fa=await form(a),fb=await form(b),booking=await form(a,'bookings');
  const custom=await form(a,'contacts',[{key:'service',label:'Service',type:'text',required:false}]);
  const invoke=async(tool,p={},client='mcp-drafts')=>{
   const r=await call(db,'mcp_invoke','staff',client,tool,p,crypto.randomUUID());if(r.ok)toolOutputs[tool].parse(r.data);return r;
  };
  const connectionId=(await invoke('crm_get_access')).data.connectionId;
  let grantRevision=0;
  const grant=async(permissions,status='active')=>{const r=await call(db,'mcp_admin','staff','save',{connectionId,revision:grantRevision,status,permissions,businessIds:[a]});grantRevision=r.connection.revision;};
  const createForm={businessId:a,kind:'form',automationId:fa.public_id,formRevision:fa.version,sequence:seq(),idempotencyKey:'create-form-1'};
  const createDirect={businessId:a,kind:'contact',name:'Contact follow-up',sequence:seq('About {{request}}'),idempotencyKey:'create-direct-1'};
  const save=(automation,sequence,key='save-0001')=>({businessId:a,kind:automation.kind,automationId:automation.id,revision:automation.revision,sequence,idempotencyKey:key,...(automation.kind==='form'?{formRevision:automation.formRevision}:{name:automation.name})});
  let f,d;
  await t.test('grants are independent and foreign IDs produce no drafts',async()=>{
   await grant(['automation_read']);
   for(const p of [createForm,createDirect])assert.equal((await invoke('crm_create_sms_automation',p)).error.code,'PERMISSION_DENIED');
   assert.equal((await invoke('crm_preview_sms_automation',{businessId:a,kind:'form',automationId:fa.public_id,revision:0,formRevision:fa.version,source:'input',sequence:seq(),submittedLocal:start,sample})).error.code,'PERMISSION_DENIED');
   await grant(['automation_draft']);
   assert.equal((await invoke('crm_create_sms_automation',{...createForm,automationId:fb.public_id})).error.code,'PERMISSION_DENIED');
   assert.equal((await invoke('crm_create_sms_automation',{...createForm,businessId:b})).error.code,'PERMISSION_DENIED');
   assert.equal((await db.query('select count(*) n from sms_private.form_sequences')).rows[0].n,0);
   f=await invoke('crm_create_sms_automation',createForm);assert.equal(f.ok,true,JSON.stringify(f));f=f.data.automation;
   d=await invoke('crm_create_sms_automation',createDirect);assert.equal(d.ok,true,JSON.stringify(d));d=d.data.automation;
   assert.equal(f.enabled,false);assert.equal(f.publishedVersion,null);assert.equal(d.publishedVersion,null);
   assert.equal((await invoke('crm_get_sms_automation',{businessId:a,kind:'contact',automationId:d.id})).error.code,'PERMISSION_DENIED');
  });
  await t.test('identical creates replay once; conflicting keys, existing drafts and stale edits conflict',async()=>{
   assert.equal((await invoke('crm_create_sms_automation',createDirect)).data.automation.id,d.id);
   assert.equal((await invoke('crm_create_sms_automation',createForm)).data.automation.id,f.id);
   assert.equal((await invoke('crm_create_sms_automation',{...createDirect,name:'Different'})).error.code,'CONFLICT');
   assert.equal((await invoke('crm_create_sms_automation',{...createForm,idempotencyKey:'another-form'})).error.code,'CONFLICT');
   assert.equal((await invoke('crm_save_sms_automation_draft',{...save(d,seq()),idempotencyKey:createDirect.idempotencyKey})).error.code,'CONFLICT');
   const p=save(d,seq('Updated {{name}}'),'save-direct-1');
   let r=await invoke('crm_save_sms_automation_draft',p);assert.equal(r.ok,true,JSON.stringify(r));d=r.data.automation;
   assert.deepEqual(await invoke('crm_save_sms_automation_draft',p),r);
   assert.equal((await invoke('crm_save_sms_automation_draft',{...p,idempotencyKey:'stale-direct'})).error.code,'CONFLICT');
   const count=(await db.query('select count(*) n from sms_private.direct_templates')).rows[0].n;assert.equal(count,1);
   const second=(await invoke('crm_get_access',{},'other-client')).data.connectionId;
   await call(db,'mcp_admin','staff','save',{connectionId:second,revision:0,status:'active',permissions:['automation_draft'],businessIds:[a]});
   const other=await invoke('crm_create_sms_automation',createDirect,'other-client');assert.equal(other.ok,true,JSON.stringify(other));assert.notEqual(other.data.automation.id,d.id);
   await grant([]);assert.equal((await invoke('crm_create_sms_automation',createDirect)).error.code,'PERMISSION_DENIED');await grant(['automation_draft']);
  });
  await t.test('form field revisions and archived targets fence edits; invalid requests roll back retry records',async()=>{
   fa=(await call(db,'form_workspace','staff',a,'save',fa.public_id,{title:'Edited form',fields:[],description:'',buttonLabel:'Send',enabled:false})).form;
   assert.equal((await invoke('crm_save_sms_automation_draft',save(f,seq('New')))).error.code,'CONFLICT');
   f.formRevision=fa.version;
   let r=await invoke('crm_save_sms_automation_draft',save(f,seq('New'),'save-form-1'));assert.equal(r.ok,true,JSON.stringify(r));f=r.data.automation;
   for(const [sequence,patch] of [[{...seq(),startHour:0.5},{}],[seq('{{unknown}}'),{}],[seq(),{enabled:true}],[{...seq(),steps:[{...newMessage('Bad'),private:'x'}]},{}]]){
    const p={...save(f,sequence,crypto.randomUUID()),...patch};assert.equal((await invoke('crm_save_sms_automation_draft',p)).error.code,'VALIDATION_ERROR');
    assert.equal((await db.query('select count(*) n from sms_private.mcp_requests where connection_id=$1 and idempotency_key=$2',[connectionId,p.idempotencyKey])).rows[0].n,0);
   }
   await db.query('update sms_private.direct_templates set archived=true where tenant_id=$1 and id=$2',[a,d.id]);
   assert.equal((await invoke('crm_save_sms_automation_draft',save(d,seq()))).error.code,'VALIDATION_ERROR');
   await db.query('update sms_private.direct_templates set archived=false where tenant_id=$1 and id=$2',[a,d.id]);
  });
  await t.test('saving draft content preserves published versions and enable state',async()=>{
   fa=(await call(db,'form_workspace','staff',a,'save',fa.public_id,{title:fa.title,fields:[],description:'',buttonLabel:'Send',enabled:true})).form;
   f.formRevision=fa.version;
   await call(db,'form_workspace','staff',a,'publish',fa.public_id,{revision:f.revision,sequence:seq('Published form')});
   await call(db,'form_workspace','staff',a,'state',fa.public_id,{enabled:true});
   const read=await call(db,'form_workspace','staff',a,'read',fa.public_id);f.revision=read.revision;
   f=(await invoke('crm_save_sms_automation_draft',save(f,seq('Draft form'),'draft-after-publish'))).data.automation;
   const current=await call(db,'form_workspace','staff',a,'read',fa.public_id);
   assert.equal(current.published.steps[0].body,'Published form');assert.equal(current.draft.steps[0].body,'Draft form');assert.equal(current.enabled,true);
   const pub=(await call(db,'contact_automations','staff',a,'publish',{id:d.id,revision:d.revision,name:d.name,sequence:seq('Published direct'),idempotencyKey:'ui-publish'})).template;
   d.revision=pub.revision;d=(await invoke('crm_save_sms_automation_draft',save(d,seq('Draft direct'),'direct-after-publish'))).data.automation;
   assert.equal(d.publishedVersion,1);
   assert.equal((await db.query('select sequence from sms_private.direct_versions where tenant_id=$1 and template_id=$2',[a,d.id])).rows[0].sequence.steps[0].body,'Published direct');
  });
  const preview=(automation,extra={})=>({businessId:a,kind:automation.kind,automationId:automation.id,revision:automation.revision,
   ...(automation.kind==='form'?{formRevision:automation.formRevision}:{}),submittedLocal:start,sample,...extra});
  await t.test('preview-only grant supports draft, published and unsaved rules with source fingerprints',async()=>{
   await grant(['automation_preview']);
   assert.equal((await invoke('crm_save_sms_automation_draft',save(d,seq()))).error.code,'PERMISSION_DENIED');
   for(const automation of [f,d]){
    let r=await invoke('crm_preview_sms_automation',preview(automation));assert.equal(r.ok,true,JSON.stringify(r));
    assert.match(r.data.rows[0].body,/Draft/);assert.equal(r.data.source.revision,automation.revision);
    const again=await invoke('crm_preview_sms_automation',preview(automation));assert.equal(again.data.fingerprint,r.data.fingerprint);
    const published=await invoke('crm_preview_sms_automation',preview(automation,{source:'published'}));assert.match(published.data.rows[0].body,/Published/);assert.notEqual(published.data.fingerprint,r.data.fingerprint);
    const unsaved=await invoke('crm_preview_sms_automation',preview(automation,{source:'input',sequence:seq('Unsaved {{name}}')}));assert.equal(unsaved.data.rows[0].body,'Unsaved Alex Example');assert.notEqual(unsaved.data.fingerprint,r.data.fingerprint);
    assert.equal((await invoke('crm_preview_sms_automation',preview(automation,{sequence:seq()}))).error.code,'VALIDATION_ERROR');
    assert.equal((await invoke('crm_preview_sms_automation',preview(automation,{revision:0}))).error.code,'CONFLICT');
   }
   const fresh={kind:'form',id:custom.public_id,revision:0,formRevision:custom.version};
   assert.equal((await invoke('crm_preview_sms_automation',preview(fresh,{source:'input',sequence:seq('{{field.service}}')}))).data.rows.length,0);
   assert.equal((await invoke('crm_preview_sms_automation',preview(fresh))).error.code,'VALIDATION_ERROR');
   assert.equal((await invoke('crm_preview_sms_automation',preview(d,{source:'input',sequence:seq('About {{request}}'),context:'Repairs'}))).data.rows[0].body,'About Repairs');
   await assert.rejects(call(db,'direct_validate',seq('x'.repeat(1590)+'{{request}}')),/1600/);
  });
  await t.test('simulations preserve repeat ordering, caps, DST, sending hours, reply policies and appointment cutoffs',async()=>{
   for(const automation of [f,d]){
    const input=preview(automation,{source:'input',sequence:seq('A',{steps:[{...newMessage('A'),sendCount:2},newMessage('B'),{...newMessage('C'),sendCount:100}]})});
    const r=(await invoke('crm_preview_sms_automation',input)).data;
    assert.equal(r.totalSends,103);assert.deepEqual(r.rows.slice(0,4).map(v=>[v.message,v.repeat]),[[1,1],[1,2],[2,1],[3,1]]);
    assert.equal(r.rows.length,automation.kind==='form'?103:50);assert.equal(r.truncated,automation.kind==='contact');
    assert.equal(new Date(r.rows[0].at).toISOString(),'2030-03-09T17:00:00.000Z');assert.equal(new Date(r.rows[1].at).toISOString(),'2030-03-10T16:00:00.000Z');
    const pause=(await invoke('crm_preview_sms_automation',{...input,scenario:'reply'})).data;assert.equal(pause.rows.length,1);assert.match(pause.outcome,/Paused/);
    const stop=(await invoke('crm_preview_sms_automation',{...input,scenario:'opt_out'})).data;assert.equal(stop.rows.length,1);assert.match(stop.outcome,/Stopped/);
    const continued=(await invoke('crm_preview_sms_automation',{...input,scenario:'reply',sequence:seq('Hi',{replyPolicy:'continue',steps:[{...newMessage('Hi'),sendCount:3,intervalUnit:'minute'}]})})).data;
    assert.equal(new Date(continued.rows[1].at)-new Date(continued.rows[0].at),30*60000);
    const overnight=(await invoke('crm_preview_sms_automation',{...input,submittedLocal:'2030-03-09T16:50',scenario:'reply',sequence:seq('Hi',{startHour:9,endHour:17,replyPolicy:'continue',steps:[{...newMessage('Hi'),sendCount:2,intervalUnit:'minute'}]})})).data;
    assert.equal(new Date(overnight.rows[1].at).toISOString(),'2030-03-10T15:00:00.000Z');
    const capped=(await invoke('crm_preview_sms_automation',{...input,sequence:seq('Many',{steps:[{...newMessage('Many'),sendCount:1000}]})})).data;
    assert.equal(capped.rows.length,automation.kind==='form'?200:50);assert.equal(capped.totalSends,1000);assert.equal(capped.truncated,true);
    assert.equal((await invoke('crm_preview_sms_automation',{...input,submittedLocal:'2030-03-10T02:30'})).error.code,'VALIDATION_ERROR');
   }
   const stopReply=await invoke('crm_preview_sms_automation',preview(d,{source:'input',scenario:'reply',sequence:seq('Hi',{replyPolicy:'stop',steps:[{...newMessage('Hi'),sendCount:3}]})}));assert.equal(stopReply.data.rows.length,1);assert.match(stopReply.data.outcome,/Stopped/);
   const appt=await invoke('crm_preview_sms_automation',preview({kind:'form',id:booking.public_id,revision:0,formRevision:booking.version},{source:'input',sample:{...sample,appointmentLocal:'2030-03-11T10:00'},sequence:seq('Appointment {{appointment_at}}',{trigger:'appointment',leadHours:24,steps:[{...newMessage('Appointment {{appointment_at}}'),sendCount:10}]})}));
   assert.equal(appt.ok,true,JSON.stringify(appt));assert.equal(appt.data.rows.length,1);assert.match(appt.data.outcome,/appointment/);
  });
  await t.test('existing contacts require matching business and revision; consent and STOP cannot be simulated away',async()=>{
   const contact=async(business,optedOut=false)=>(await db.query('insert into public.sms_contacts(tenant_id,phone,name,email,marketing_consent,opted_out) values($1,$2,$3,$4,true,$5) returning *',[business,sample.phone,sample.name,sample.email,optedOut])).rows[0];
   const own=await contact(a),other=await contact(b,true);
   const p={...preview(d),contactId:own.id,contactRevision:own.revision};delete p.sample;
   assert.equal((await invoke('crm_preview_sms_automation',p)).ok,true);
   assert.equal((await invoke('crm_preview_sms_automation',{...p,contactId:other.id})).error.code,'PERMISSION_DENIED');
   assert.equal((await invoke('crm_preview_sms_automation',{...p,contactRevision:0})).error.code,'CONFLICT');
   assert.equal((await invoke('crm_preview_sms_automation',{...p,sample})).error.code,'VALIDATION_ERROR');
   assert.equal((await invoke('crm_preview_sms_automation',preview(d))).data.rows.length,1,'other business STOP does not leak');
   await db.query('update public.sms_contacts set opted_out=true where tenant_id=$1 and id=$2',[a,own.id]);
   assert.equal((await invoke('crm_preview_sms_automation',p)).error.code,'CONFLICT');
   for(const automation of [f,d])assert.equal((await invoke('crm_preview_sms_automation',preview(automation))).data.rows.length,0);
   await db.query('update public.sms_contacts set opted_out=false,enquiry_blocked=true where tenant_id=$1 and id=$2',[a,own.id]);
   for(const automation of [f,d])assert.equal((await invoke('crm_preview_sms_automation',preview(automation))).data.rows.length,0);
  });
  await t.test('preview is read-only apart from MCP audit; denied grants and audit exclude sample content',async()=>{
   const counts=async()=>(await db.query(`select (select count(*) from public.sms_contacts) contacts,(select count(*) from public.sms_messages) messages,
    (select count(*) from sms_private.form_runs) runs,(select count(*) from sms_private.jobs) jobs,(select count(*) from public.sms_web_form_contact_submissions) leads,
    (select count(*) from sms_private.mcp_requests) retries,(select count(*) from sms_private.direct_operations) direct_operations`)).rows[0];
   const before=await counts();
   for(const automation of [f,d]){
    const p=preview(automation);
    await db.exec('begin read only');const r=await call(db,'mcp_sms_preview','staff',a,p);await db.exec('commit');toolOutputs.crm_preview_sms_automation.parse(r);
    assert.equal((await invoke('crm_preview_sms_automation',p)).ok,true);
   }
   assert.deepEqual(await counts(),before);assert.equal(before.runs,0);assert.equal(before.messages,0);
   for(const functionName of ['mcp_sms_draft(text,text,text,jsonb,uuid)','mcp_sms_preview(text,text,jsonb)','simulate_sms_sequence(jsonb,jsonb,timestamptz,timestamptz,text,text,integer)']){
    const r=await db.query('select has_function_privilege($1,$2,$3) allowed',['crm_mcp','sms_private.'+functionName,'execute']);assert.equal(r.rows[0].allowed,false);
   }
   await grant(['automation_draft','automation_preview'],'disabled');
   assert.equal((await invoke('crm_preview_sms_automation',preview(d))).error.code,'PERMISSION_DENIED');
   assert.equal((await invoke('crm_create_sms_automation',createDirect)).error.code,'PERMISSION_DENIED');
   const audit=(await db.query('select * from sms_private.mcp_activity where connection_id=$1',[connectionId])).rows;
   assert.ok(audit.some(r=>r.tool==='crm_create_sms_automation'&&r.target===d.id));assert.ok(audit.some(r=>r.tool==='crm_preview_sms_automation'&&r.revision===d.revision));
   for(const secret of [sample.phone,sample.name,sample.email,'Unsaved Alex Example','Published direct'])assert.equal(JSON.stringify(audit).includes(secret),false);
  });
 }finally{await db.close();}
});
