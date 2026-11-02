import test from 'node:test';
import assert from 'node:assert/strict';
import { testDatabase,call } from './helpers/database.js';
import { EMAIL_STARTERS,validateEmailDefinition,renderTemplateEmail } from '../src/lib/emailTemplates.js';
import { processEmailJob } from '../src/workers/email.js';

test('template renderer escapes fields, preserves formatting, rejects executable links and separates service footer',()=>{
 const d=structuredClone(EMAIL_STARTERS[0]);validateEmailDefinition(d);
 const values={firstName:'<script>alert(1)</script>',businessName:'Business',request:'help'};
 const rendered=renderTemplateEmail(d.steps[0],values,{businessName:'Business',mailingAddress:'Address',unsubscribeUrl:'https://example.test/unsub',purpose:'marketing'});
 assert.match(rendered.html,/&lt;script&gt;/);assert.doesNotMatch(rendered.html,/<script>/);assert.match(rendered.text,/Unsubscribe:/);
 assert.doesNotMatch(renderTemplateEmail(d.steps[0],values,{businessName:'Business',mailingAddress:'Address',purpose:'service'}).html,/Unsubscribe/);
 d.steps[0].document[0].content[0].href='javascript:alert(1)';assert.throws(()=>validateEmailDefinition(d),/http/);
});
async function setup() {
 const db=await testDatabase();
 await call(db,'api_action','admin',null,'create_business',{id:'email-test',name:'Test business',timeZone:'America/Denver'});
 await db.exec("update sms_private.email_sender_domains set status='verified'; update sms_private.runtime set edge_enabled=true; update public.sms_businesses set status='active' where tenant_id='email-test'");
 const secret=(await db.query("select vault.create_secret(repeat('a',32)) id")).rows[0].id;
 await db.query('insert into vault.secrets(id) values($1)',[secret]);
 await db.query("update sms_private.edge_config set enabled=true,secret_id=$1 where queue='automation_jobs'",[secret]);
 const action=(name,input={})=>call(db,'email_automations','admin','email-test',name,{...input,idempotencyKey:input.idempotencyKey||crypto.randomUUID()});
 await action('settings',{revision:0,enabled:true,replyTo:'owner@example.test',mailingAddress:'123 Main Street, Denver, CO'});
 const contact=(await db.query("insert into public.sms_contacts(tenant_id,phone,name,email) values('email-test','+13035550100','Alex','alex@example.test') returning *")).rows[0];
 const create=async (definition=EMAIL_STARTERS[0])=>{let t=await action('create',{name:'Email template',definition});return action('publish',{id:t.id,revision:t.revision});};
 return {db,action,contact,create};
}
test('immutable versions, revision/retry guards, consent, frozen Resend payload and unsubscribe races',async()=>{
 const {db,action,contact,create}=await setup();
 try {
  const t=await create();
  await assert.rejects(()=>action('start',{contactId:contact.id,contactRevision:contact.revision,templateId:t.id}),/cannot start/);
  await action('consent',{contactId:contact.id,contactRevision:contact.revision,consent:true,evidence:'Signed email marketing opt-in'});
  const input={contactId:contact.id,contactRevision:contact.revision,templateId:t.id,idempotencyKey:crypto.randomUUID()};
  const started=await action('start',input);assert.deepEqual(await action('start',input),started);
  const legacy=await call(db,'mcp_email_action','admin','email-test','crm_list_email_enrollments',{businessId:'email-test',page:1,pageSize:25},null,null);
  assert.equal(legacy.total,0);
  assert.equal((await db.query('select count(*)::integer n from sms_private.email_enrollments where template_id=$1',[t.id])).rows[0].n,1);
  const changed=structuredClone(EMAIL_STARTERS[0]);changed.steps[0].subject='Updated';
  await action('save',{id:t.id,revision:t.revision,name:t.name,definition:changed});
  await assert.rejects(()=>action('publish',{id:t.id,revision:t.revision}),/changed/);
  assert.equal((await db.query('select definition from sms_private.email_enrollments where id=$1',[started.runId])).rows[0].definition.steps[0].subject,EMAIL_STARTERS[0].steps[0].subject);
  const preview=await action('preview',{id:t.id,revision:t.revision+1});assert.equal(preview.queued,false);
  await db.query("update sms_private.email_enrollments set next_run_at=now(),definition=jsonb_set(jsonb_set(definition,'{startHour}','0'),'{endHour}','24') where id=$1",[started.runId]);
  await call(db,'dispatch_email_edge');const job=await call(db,'email_claim');assert.ok(job);
  let sent;const workerDb={call:(name,...args)=>call(db,name,...args)};
  await processEmailJob(job,workerDb,{apiKey:'test',draft:()=>{throw new Error('Templates must not use AI');},fetchImpl:async(url,options)=>{sent=JSON.parse(options.body);return Response.json({id:'resend-template-1'});}});
  assert.ok(sent);assert.equal(sent.reply_to,'owner@example.test');assert.match(sent.from,/@e2local.com/);assert.match(sent.subject,/Alex/);
  const run=(await db.query('select * from sms_private.email_enrollments where id=$1',[started.runId])).rows[0];
  assert.equal((await db.query('select status from sms_private.email_jobs where id=$1',[job.id])).rows[0].status,'sent');
  await call(db,'email_unsubscribe',run.unsubscribe_token);
  assert.equal((await db.query('select status from sms_private.email_enrollments where id=$1',[run.id])).rows[0].status,'unsubscribed');
 } finally{await db.close();}
});
test('pausing a prepared send defers it, and a send already underway advances while preserving pause',async()=>{
 const {db,action,contact,create}=await setup();try{
  const d=structuredClone(EMAIL_STARTERS[0]);d.startHour=0;d.endHour=24;
  const t=await create(d);await action('consent',{contactId:contact.id,contactRevision:contact.revision,consent:true,evidence:'Signed email permission'});
  const {runId}=await action('start',{contactId:contact.id,contactRevision:contact.revision,templateId:t.id});
  await call(db,'dispatch_email_edge');let job=await call(db,'email_claim');
  let r=(await db.query('select * from sms_private.email_enrollments where id=$1',[runId])).rows[0];
  await action('pause',{runId,revision:r.revision,generation:r.generation});
  assert.equal(await call(db,'email_before_send',job.id,job.lease_token),null);
  assert.equal((await db.query('select status from sms_private.email_jobs where id=$1',[job.id])).rows[0].status,'pending');
  r=(await db.query('select * from sms_private.email_enrollments where id=$1',[runId])).rows[0];
  await action('resume',{runId,revision:r.revision,generation:r.generation});
  await db.query('update sms_private.email_jobs set due_at=now() where id=$1',[job.id]);job=await call(db,'email_claim');
  await call(db,'email_save_draft',job.id,job.lease_token,'Test subject','Hello Alex. Your next step.');
  const s=(await call(db,'email_job_context',job.id,job.lease_token)).settings;
  await call(db,'email_save_payload',job.id,job.lease_token,{from:s.sender,to:contact.email,reply_to:s.reply_to,subject:'Test subject',text:'Hello Alex. Your next step.',html:'<p>'+'.'.repeat(120)+'</p>'});
  assert.ok(await call(db,'email_before_send',job.id,job.lease_token));
  r=(await db.query('select * from sms_private.email_enrollments where id=$1',[runId])).rows[0];
  await action('pause',{runId,revision:r.revision,generation:r.generation});
  await call(db,'email_finish',job.id,job.lease_token,'sent','provider-paused',null);
  r=(await db.query('select * from sms_private.email_enrollments where id=$1',[runId])).rows[0];assert.equal(r.status,'paused');assert.equal(r.step_index,1);
 }finally{await db.close();}
});
test('booking service emails need no marketing consent and changes fence old reminders',async()=>{
 const {db,action,contact,create}=await setup();
 try {
  const t=await create(EMAIL_STARTERS[2]);
  await action('connection',{templateId:t.id,event:'booking.confirmed',enabled:true,replaceLegacy:false});
  await db.query("insert into public.sms_bookings(tenant_id,id,contact_id,appointment_at) values('email-test','book-one',$1,now()+interval '7 days')",[contact.id]);
  let runs=(await db.query("select * from sms_private.email_enrollments where origin_type='booking'")).rows;assert.equal(runs.length,1);assert.equal(runs[0].purpose,'service');
  const generation=runs[0].generation;
  await db.exec("update public.sms_bookings set appointment_at=appointment_at+interval '1 day' where id='book-one'");
  runs=(await db.query("select * from sms_private.email_enrollments where origin_type='booking'")).rows;assert.equal(runs[0].generation,generation+1);
  await call(db,'email_unsubscribe',runs[0].unsubscribe_token);assert.equal((await db.query('select status from sms_private.email_enrollments where id=$1',[runs[0].id])).rows[0].status,'active');
  await db.exec("update public.sms_bookings set status='cancelled' where id='book-one'");
  assert.equal((await db.query('select status from sms_private.email_enrollments where id=$1',[runs[0].id])).rows[0].status,'cancelled');
 }finally{await db.close();}
});
test('existing legacy consent is reusable, current withdrawal is authoritative, and nothing backfills',async()=>{
 const {db,action,contact,create}=await setup();try{
  const t=await create();
  const intake=await call(db,'create_intake','admin','email-test','contacts',{name:contact.name,phone:contact.phone,email:contact.email,emailOptIn:true,emailConsentEvidence:'Existing signed email consent',details:{}});
  assert.equal((await db.query('select count(*)::integer n from sms_private.email_enrollments where template_id is not null')).rows[0].n,0);
  assert.equal(await call(db,'email_has_permission','email-test',contact.email),true);
  const current=(await db.query('select revision from public.sms_contacts where id=$1',[contact.id])).rows[0];
  await action('start',{contactId:contact.id,contactRevision:current.revision,templateId:t.id});
  await db.query('update public.sms_automation_contacts set email_opt_in=false where id=$1',[intake.id]);
  assert.equal(await call(db,'email_has_permission','email-test',contact.email),false);
 }finally{await db.close();}
});
test('custom forms offer independent consent and duplicate submissions cannot create duplicate runs',async()=>{
 const {db,action,create}=await setup();
 try {
  const f=await call(db,'form_workspace','admin','email-test','create',null,{title:'Custom form',preset:'contacts',description:'',buttonLabel:'Send',enabled:false,emailEnabled:false,fields:[]});
  const formId=f.form?.public_id||f.public_id||f.formId;
  assert.ok(formId,JSON.stringify(f));
  const t=await create();
  await action('connection',{templateId:t.id,event:'form.submitted',formId,enabled:true});
  await db.query('update public.sms_web_form_definitions set enabled=true,email_enabled=true where public_id=$1',[formId]);
  const publicForm=await call(db,'public_web_form',formId);assert.equal(publicForm.emailEnabled,true);
  const payload={submissionId:crypto.randomUUID(),name:'Taylor',phone:'+13035550199',email:'taylor@example.test',smsOptIn:false,emailOptIn:true,details:{}};
  await call(db,'submit_web_form',formId,payload);await call(db,'submit_web_form',formId,payload);
  assert.equal((await db.query('select count(*)::integer n from sms_private.email_enrollments where form_public_id=$1',[formId])).rows[0].n,1);
  assert.equal((await db.query('select count(*)::integer n from sms_private.form_runs where form_id=$1',[formId])).rows[0].n,0);
  await assert.rejects(()=>call(db,'submit_web_form',formId,{...payload,emailOptIn:false}),/already used/);
 }finally{await db.close();}
});
