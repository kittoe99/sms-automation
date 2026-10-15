import test from 'node:test';
import assert from 'node:assert/strict';
import {z} from 'zod';
import {fixture} from './helpers/twilioConnections.js';
import {call} from './helpers/database.js';
import {toolOutputs} from '../src/mcp/tools.js';
import {smsReleaseTools} from '../src/mcp/smsReleaseSchemas.js';
import {emptySequence,newMessage} from '../public/formAutomation.js';

const seq=body=>({...emptySequence(),startHour:0,endHour:24,steps:[newMessage(body)]});
test('publication and enable schemas require revisions/retry keys and reject replacement content',()=>{
 const schemas=Object.fromEntries(smsReleaseTools.map(([n,,s])=>[n,z.object(s).strict()]));
 const target={businessId:'a',automationId:crypto.randomUUID(),revision:2,idempotencyKey:'publish-0001'};
 assert.equal(schemas.crm_publish_sms_automation.safeParse({...target,kind:'contact'}).success,true);
 for(const patch of [{sequence:seq('Injected')},{name:'Renamed'},{enabled:true},{revision:-1},{idempotencyKey:'short'}])assert.equal(schemas.crm_publish_sms_automation.safeParse({...target,kind:'contact',...patch}).success,false);
 const state={...target,formRevision:1,enabled:true};
 assert.equal(schemas.crm_set_form_followups_enabled.safeParse(state).success,true);
 for(const patch of [{enabled:'true'},{formRevision:undefined},{kind:'contact'},{revision:undefined}])assert.equal(schemas.crm_set_form_followups_enabled.safeParse({...state,...patch}).success,false);
});

test('MCP publication and form state use separate grants, canonical operations and transactional retries',async t=>{
 const x=await fixture(),{db}=x;
 try{
  const {tenant:a}=await x.business('release-a'),{tenant:b}=await x.business('release-b');
  const form=async business=>(await call(db,'form_workspace','staff',business,'create',null,{title:'Release form',preset:'contacts',fields:[],description:'',buttonLabel:'Send',enabled:false})).form;
  let fa=await form(a);const fb=await form(b);
  await call(db,'form_workspace','staff',a,'draft',fa.public_id,{revision:0,sequence:seq('Form secret v1')});
  let direct=(await call(db,'contact_automations','staff',a,'save',{name:'Direct name',sequence:seq('Direct secret v1'),idempotencyKey:'ui-direct-create'})).template;
  const invoke=async(tool,p={})=>{const r=await call(db,'mcp_invoke','staff','release-client',tool,p,crypto.randomUUID());if(r.ok)toolOutputs[tool].parse(r.data);return r;};
  const connectionId=(await invoke('crm_get_access')).data.connectionId;let grantRevision=0;
  const grant=async permissions=>{const r=await call(db,'mcp_admin','staff','save',{connectionId,revision:grantRevision,status:'active',permissions,businessIds:[a]});grantRevision=r.connection.revision;};
  const formState=()=>call(db,'form_workspace','staff',a,'read',fa.public_id);
  const pubForm=async(key=crypto.randomUUID())=>({businessId:a,kind:'form',automationId:fa.public_id,revision:(await formState()).revision,formRevision:fa.version,idempotencyKey:key});
  const setState=async(enabled,key=crypto.randomUUID())=>{const {kind,...p}=await pubForm(key);return {...p,enabled};};
  const pubDirect=(key=crypto.randomUUID())=>({businessId:a,kind:'contact',automationId:direct.id,revision:direct.revision,idempotencyKey:key});
  const counts=async()=>(await db.query(`select (select count(*) from sms_private.form_runs) runs,(select count(*) from sms_private.jobs) jobs,
   (select count(*) from public.sms_messages) messages,(select count(*) from public.sms_contacts) contacts`)).rows[0];
  const baseline=await counts();let publishedForm,publishedDirect;
  await t.test('grants are independent; foreign references and denied calls cannot publish or enable',async()=>{
   await grant(['automation_draft','automation_preview','automation_read']);
   assert.equal((await invoke('crm_publish_sms_automation',await pubForm())).error.code,'PERMISSION_DENIED');
   assert.equal((await invoke('crm_set_form_followups_enabled',await setState(true))).error.code,'PERMISSION_DENIED');
   await grant(['automation_publish']);
   for(const p of [{...await pubForm(),automationId:fb.public_id},{...pubDirect(),businessId:b}])assert.equal((await invoke('crm_publish_sms_automation',p)).error.code,'PERMISSION_DENIED');
   assert.equal((await invoke('crm_set_form_followups_enabled',await setState(true))).error.code,'PERMISSION_DENIED');
   assert.equal((await formState()).publishedVersion,null);
   await grant(['automation_enable']);
   assert.equal((await invoke('crm_publish_sms_automation',pubDirect())).error.code,'PERMISSION_DENIED');
   assert.equal((await invoke('crm_set_form_followups_enabled',await setState(true))).error.code,'VALIDATION_ERROR');
   assert.equal((await invoke('crm_set_form_followups_enabled',{...await setState(true),automationId:fb.public_id})).error.code,'PERMISSION_DENIED');
   assert.equal((await invoke('crm_set_form_followups_enabled',{...await setState(true),automationId:direct.id})).error.code,'PERMISSION_DENIED');
   assert.deepEqual(await counts(),baseline);
  });
  await t.test('publish snapshots only saved content; retries create one version and stale requests conflict',async()=>{
   await grant(['automation_publish']);
   for(const patch of [{sequence:seq('Injected')},{name:'Injected'},{enabled:true},{formRevision:undefined}]){
    const p={...await pubForm(),...patch};if(p.formRevision===undefined)delete p.formRevision;
    assert.equal((await invoke('crm_publish_sms_automation',p)).error.code,'VALIDATION_ERROR');
   }
   const fp=await pubForm('publish-form-1'),dp=pubDirect('publish-direct-1');
   publishedForm=await invoke('crm_publish_sms_automation',fp);assert.equal(publishedForm.ok,true,JSON.stringify(publishedForm));
   publishedDirect=await invoke('crm_publish_sms_automation',dp);assert.equal(publishedDirect.ok,true,JSON.stringify(publishedDirect));
   assert.deepEqual(await invoke('crm_publish_sms_automation',fp),publishedForm);assert.deepEqual(await invoke('crm_publish_sms_automation',dp),publishedDirect);
   assert.equal(publishedForm.data.automation.enabled,false);assert.equal(publishedForm.data.automation.publishedVersion,1);
   assert.equal((await formState()).published.steps[0].body,'Form secret v1');
   direct=(await db.query('select * from sms_private.direct_templates where id=$1',[direct.id])).rows[0];
   assert.equal(direct.name,'Direct name');assert.equal(direct.published_version,1);
   for(const p of [fp,dp])assert.equal((await invoke('crm_publish_sms_automation',{...p,idempotencyKey:crypto.randomUUID()})).error.code,'CONFLICT');
   assert.equal((await invoke('crm_publish_sms_automation',{...fp,revision:fp.revision+1})).error.code,'CONFLICT');
   const versions=(await db.query('select (select count(*) from sms_private.form_sequence_versions) f,(select count(*) from sms_private.direct_versions) d')).rows[0];assert.deepEqual(versions,{f:1,d:1});
   assert.deepEqual(await counts(),baseline);
  });
  await t.test('enable requires a collecting published form and current form/sequence revisions',async()=>{
   await grant(['automation_enable']);
   assert.equal((await invoke('crm_set_form_followups_enabled',await setState(true))).error.code,'VALIDATION_ERROR');
   const stale=await setState(true);
   fa=(await call(db,'form_workspace','staff',a,'save',fa.public_id,{title:fa.title,description:'',buttonLabel:'Send',fields:[],enabled:true})).form;
   assert.equal((await invoke('crm_set_form_followups_enabled',stale)).error.code,'CONFLICT');
   const p=await setState(true,'enable-form-1'),r=await invoke('crm_set_form_followups_enabled',p);assert.equal(r.ok,true,JSON.stringify(r));
   assert.equal(r.data.effect,'form_followups_enabled');assert.equal(r.data.automation.enabled,true);
   assert.deepEqual(await invoke('crm_set_form_followups_enabled',p),r);
   assert.equal((await invoke('crm_set_form_followups_enabled',{...p,enabled:false})).error.code,'CONFLICT');
   assert.equal((await invoke('crm_set_form_followups_enabled',{...p,idempotencyKey:'stale-enable'})).error.code,'CONFLICT');
   assert.deepEqual(await counts(),baseline);
   assert.equal((await db.query('select sending_enabled from public.sms_businesses where tenant_id=$1',[a])).rows[0].sending_enabled,false);
  });
  await t.test('publish on an enabled form preserves existing runs; disable pauses only this form and enable never resumes',async()=>{
   const addRun=async(id,status='active')=>(await db.query(`insert into sms_private.form_runs(tenant_id,form_id,version,submission_id,phone,context,status)
    values($1,$2,1,$3,'+13035550160','{}',$4) returning *`,[a,id,crypto.randomUUID(),status])).rows[0];
   const run=await addRun(fa.public_id),paused=await addRun(fa.public_id,'paused');
   const otherForm=await form(a);await call(db,'form_workspace','staff',a,'publish',otherForm.public_id,{revision:0,sequence:seq('Other form')});const other=await addRun(otherForm.public_id);
   const directRun=(await db.query(`insert into sms_private.form_runs(tenant_id,origin,direct_template_id,version,direct_sequence,phone,context,enrollment_key)
    values($1,'direct',$2,1,$3,'+13035550161','{}','test-existing-run') returning *`,[a,direct.id,seq('Direct secret v1')])).rows[0];
   await call(db,'form_workspace','staff',a,'draft',fa.public_id,{revision:(await formState()).revision,sequence:seq('Form secret v2')});
   direct=(await call(db,'contact_automations','staff',a,'save',{id:direct.id,revision:direct.revision,name:direct.name,sequence:seq('Direct secret v2'),idempotencyKey:'ui-edit-2'})).template;
   await grant(['automation_publish']);
   const r=await invoke('crm_publish_sms_automation',await pubForm());assert.equal(r.data.automation.enabled,true);assert.equal(r.data.automation.publishedVersion,2);
   assert.equal((await invoke('crm_publish_sms_automation',pubDirect())).data.automation.publishedVersion,2);
   const readRun=async id=>(await db.query('select * from sms_private.form_runs where id=$1',[id])).rows[0];
   assert.deepEqual(await readRun(run.id),run);assert.deepEqual(await readRun(directRun.id),directRun);
   await grant(['automation_enable']);const off=await setState(false,'disable-form-1');
   const disabled=await invoke('crm_set_form_followups_enabled',off);assert.equal(disabled.data.effect,'form_followups_disabled');
   assert.deepEqual(await invoke('crm_set_form_followups_enabled',off),disabled);
   let current=await readRun(run.id);assert.equal(current.status,'paused');assert.equal(current.reason,'AUTOMATION_PAUSED');assert.equal(current.generation,run.generation+1);
   assert.deepEqual(await readRun(paused.id),paused);assert.deepEqual(await readRun(other.id),other);assert.deepEqual(await readRun(directRun.id),directRun);
   await invoke('crm_set_form_followups_enabled',await setState(true));assert.deepEqual(await readRun(run.id),current);
   assert.equal((await counts()).runs,4);assert.equal((await counts()).messages,baseline.messages);assert.equal((await counts()).jobs,baseline.jobs);
  });
  await t.test('archived and invalid drafts roll back safely without consuming retry keys',async()=>{
   await grant(['automation_publish','automation_enable']);
   const p=await pubForm('invalid-draft-key');
   await db.query("update sms_private.form_sequences set draft='{}' where tenant_id=$1 and form_id=$2",[a,fa.public_id]);
   assert.equal((await invoke('crm_publish_sms_automation',p)).error.code,'VALIDATION_ERROR');
   assert.equal((await db.query('select count(*) n from sms_private.mcp_requests where connection_id=$1 and idempotency_key=$2',[connectionId,p.idempotencyKey])).rows[0].n,0);
   await db.query('update sms_private.form_sequences set draft=$3 where tenant_id=$1 and form_id=$2',[a,fa.public_id,seq('Valid again')]);
   assert.equal((await invoke('crm_publish_sms_automation',p)).ok,true);
   await call(db,'form_workspace','staff',a,'archive',fa.public_id,{});
   fa=(await db.query('select * from public.sms_web_form_definitions where public_id=$1',[fa.public_id])).rows[0];
   assert.equal((await invoke('crm_publish_sms_automation',await pubForm())).error.code,'VALIDATION_ERROR');
   assert.equal((await invoke('crm_set_form_followups_enabled',await setState(true))).error.code,'VALIDATION_ERROR');
   direct=(await db.query('update sms_private.direct_templates set archived=true where id=$1 returning *',[direct.id])).rows[0];
   assert.equal((await invoke('crm_publish_sms_automation',pubDirect())).error.code,'VALIDATION_ERROR');
  });
  await t.test('revocation prevents replay and private helpers remain inaccessible; audit is attributable and redacted',async()=>{
   await grant([]);
   assert.equal((await invoke('crm_publish_sms_automation',{...await pubForm(),idempotencyKey:'publish-form-1'})).error.code,'PERMISSION_DENIED');
   const priv=(await db.query("select has_function_privilege('crm_mcp','sms_private.mcp_sms_release(text,text,text,jsonb,uuid)','execute') allowed")).rows[0];assert.equal(priv.allowed,false);
   const audit=(await db.query('select * from sms_private.mcp_activity where connection_id=$1',[connectionId])).rows;
   assert.ok(audit.some(r=>r.tool==='crm_publish_sms_automation'&&r.target===fa.public_id&&r.revision===publishedForm.data.automation.revision&&r.actor_id===x.admin&&r.outcome==='success'));
   assert.ok(audit.some(r=>r.tool==='crm_set_form_followups_enabled'&&r.outcome==='replayed'));
   for(const secret of ['Form secret','Direct secret','+13035550160'])assert.equal(JSON.stringify(audit).includes(secret),false);
  });
 }finally{await db.close();}
});
