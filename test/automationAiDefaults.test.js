import test from 'node:test';
import assert from 'node:assert/strict';
import {testDatabase,call} from './helpers/database.js';
import {setupCoordination,addRun,incoming,tenant,phone} from './helpers/coordination.js';
import {emptySequence,newMessage,validateSequence,BUILTIN_PRESETS} from '../public/formAutomation.js';
import {smsSequenceSchema} from '../src/mcp/smsSchemas.js';
import {validateDirectSequence} from '../public/contactAutomations.js';

const sequence=()=>({...emptySequence(),startHour:0,endHour:24,steps:[newMessage('Hello {{first_name}}')]});
const api=(db,action,p)=>call(db,'contact_automations','admin',tenant,action,{idempotencyKey:crypto.randomUUID(),...p});
async function disabledForm(db,options={}) {
 const r=await addRun(db,options);
 await db.query(`update sms_private.form_sequence_versions set sequence=sequence||'{"aiRepliesEnabled":false}' where tenant_id=$1 and form_id=$2`,[r.tenant_id,r.form_id]);
 return r;
}

test('browser validators default on, preserve explicit off, and reject nonboolean values',()=>{
 assert.equal(emptySequence().aiRepliesEnabled,true);
 assert.ok(BUILTIN_PRESETS.every(p=>p.sequence.aiRepliesEnabled));
 for(const validate of [validateSequence,validateDirectSequence]) {
  const legacy=sequence();delete legacy.aiRepliesEnabled;
  assert.equal(validate(legacy).aiRepliesEnabled,true);
  assert.equal(validate({...legacy,aiRepliesEnabled:false}).aiRepliesEnabled,false);
  for(const value of ['false',null,0])assert.throws(()=>validate({...legacy,aiRepliesEnabled:value}),/AI replies/);
 }
});

test('upgrade changes only untouched defaults and preserves explicit off and review choices',async()=>{
 const db=await testDatabase({beforeMigration:async(db,file)=>{
  if(!file.endsWith('_automation_ai_reply_defaults_rollout.sql'))return;
  await db.exec("insert into sms_private.admins values('admin') on conflict do nothing");
  for(const id of ['untouched','explicit-off','review'])await call(db,'api_action','admin',null,'create_business',{id,name:id,timeZone:'UTC'});
  await db.exec(`insert into sms_private.inbound_ai_settings(tenant_id,mode,revision) values
   ('untouched','off',0),('explicit-off','off',2),('review','shadow',1)`);
 }});
 try {
  const rows=(await db.query('select tenant_id,mode,revision from sms_private.inbound_ai_settings order by tenant_id')).rows;
  assert.deepEqual(rows,[{tenant_id:'explicit-off',mode:'off',revision:2},{tenant_id:'review',mode:'shadow',revision:1},{tenant_id:'untouched',mode:'live',revision:1}]);
 }finally{await db.close();}
});

test('new nonpilot businesses receive default live replies without opening settings, while explicit off persists',async()=>{
 const db=await testDatabase();try {
  const t='new-default-business';
  await call(db,'api_action','admin',null,'create_business',{id:t,name:'New business',timeZone:'UTC'});
  await db.query("update public.sms_businesses set sending_enabled=true,status='active' where tenant_id=$1",[t]);
  const payload={From:phone,To:'+18005550100',Body:'Hello',MessageSid:crypto.randomUUID()};
  await call(db,'record_webhook',t,'inbound',payload);
  await call(db,'record_webhook',t,'inbound',payload);
  assert.equal((await db.query("select count(*) n from sms_private.jobs where queue='ai_reply_jobs'")).rows[0].n,1);
  const settings=await call(db,'inbound_ai_settings_api','admin',t,null);
  assert.equal(settings.mode,'live');assert.equal(settings.coordinationEnabled,true);
  assert.equal(settings.pilot,false);assert.equal(settings.liveValidated,false);
  await call(db,'inbound_ai_settings_api','admin',t,{mode:'off',bookingEnabled:false,systemPrompt:settings.systemPrompt,revision:settings.revision});
  await call(db,'record_webhook',t,'inbound',{...payload,MessageSid:crypto.randomUUID()});
  assert.equal((await db.query("select count(*) n from sms_private.jobs where queue='ai_reply_jobs'")).rows[0].n,1);
  assert.equal((await call(db,'inbound_ai_settings_api','admin',t,null)).mode,'off');
 }finally{await db.close();}
});

test('form opt-out suppresses overlapping AI replies but keeps scheduled reply policies',async()=>{
 const db=await setupCoordination();try {
  const off=await disabledForm(db,{policy:'pause'});
  const on=await addRun(db,{policy:'continue',title:'Enabled overlap'});
  assert.equal(await incoming(db),null);
  const rows=(await db.query('select id,status from sms_private.form_runs')).rows;
  assert.equal(rows.find(r=>r.id===off.id).status,'paused');
  assert.equal(rows.find(r=>r.id===on.id).status,'active');
  // A paused opt-out still prevents replies, independently of the schedule.
  assert.equal(await incoming(db,'More information'),null);
  // Another contact is unaffected.
  assert.equal(await call(db,'automation_ai_replies_allowed',tenant,'+13035550999'),true);
 }finally{await db.close();}
});

test('direct publish and enrollment preserve off; completed and stopped sent runs still honor it',async()=>{
 const db=await setupCoordination();try {
  const contact=(await db.query('select * from public.sms_contacts where tenant_id=$1 and phone=$2',[tenant,phone])).rows[0];
  const cfg={...sequence(),replyPolicy:'stop',aiRepliesEnabled:false};
  const tpl=(await api(db,'publish',{name:'No AI',sequence:cfg})).template;
  assert.equal(tpl.draft.aiRepliesEnabled,false);
  const run=(await api(db,'enroll',{contactId:contact.id,templateId:tpl.id,templateRevision:tpl.revision,contactRevision:contact.revision,overlaps:[],context:'Help request'})).run;
  assert.equal(run.direct_sequence.aiRepliesEnabled,false);
  const out=await call(db,'outbox',tenant,crypto.randomUUID(),{phone,body:'Can we help?',purpose:'marketing'});
  await db.query("update public.sms_messages set meta=meta||jsonb_build_object('form_run_id',$2::text),provider_accepted_at=now() where id=$1",[out.messageId,run.id]);
  assert.equal(await incoming(db),null);
  assert.equal((await db.query('select status from sms_private.form_runs where id=$1',[run.id])).rows[0].status,'stopped');
  assert.equal(await incoming(db,'A second reply'),null);
  await db.query("update sms_private.form_runs set status='completed' where id=$1",[run.id]);
  assert.equal(await incoming(db,'A later reply'),null);
  await assert.rejects(api(db,'publish',{name:'Invalid',sequence:{...cfg,aiRepliesEnabled:'false'}}),/AI replies/);
 }finally{await db.close();}
});

test('new opt-out fences already queued AI at provider submission and private helpers remain denied',async()=>{
 const db=await setupCoordination();try {
  const job=await incoming(db);
  const out=await call(db,'complete_inbound_ai',job.id,job.lease_token,{reply:'Hello, how can we help?'});
  assert.ok(out.messageId);
  await disabledForm(db);
  const sms=await call(db,'claim','sms_send_jobs','sender');
  assert.equal(await call(db,'begin_submission',sms.id,sms.lease_token),null);
  assert.equal((await db.query('select provider_accepted_at from public.sms_messages where id=$1',[out.messageId])).rows[0].provider_accepted_at,null);
  for(const role of ['anon','authenticated','sms_api','sms_ai','sms_webhook','sms_sender']) {
   const grants=(await db.query("select has_function_privilege($1,'sms_private.automation_ai_replies_allowed(text,text)','execute') allowed",[role])).rows[0];
   assert.equal(grants.allowed,false);
  }
 }finally{await db.close();}
});

test('MCP retains AI opt-outs and instant acknowledgments with strict boolean validation',async()=>{
 const db=await testDatabase();try {
  const cfg={...sequence(),aiRepliesEnabled:false,instantAcknowledgment:true};
  smsSequenceSchema.parse(cfg);
  await call(db,'mcp_sms_validate_sequence',cfg,'form',[],'contacts');
  const projected=await call(db,'mcp_sms_sequence',cfg);
  assert.equal(projected.aiRepliesEnabled,false);assert.equal(projected.instantAcknowledgment,true);
  assert.equal((await call(db,'mcp_sms_sequence',{...sequence(),aiRepliesEnabled:undefined})).aiRepliesEnabled,true);
  for(const value of ['false',null,0]) {
   assert.equal(smsSequenceSchema.safeParse({...cfg,aiRepliesEnabled:value}).success,false);
   await assert.rejects(()=>call(db,'mcp_sms_validate_sequence',{...cfg,aiRepliesEnabled:value},'form',[],'contacts'),/AI replies/);
  }
  await assert.rejects(()=>call(db,'mcp_sms_validate_sequence',{...cfg,unknown:true},'form',[],'contacts'),/Invalid sequence fields/);
  await assert.rejects(()=>call(db,'mcp_sms_validate_sequence',cfg,'contact',[],'contacts'),/only available for form/);
  await assert.rejects(()=>call(db,'mcp_sms_validate_sequence',{...cfg,steps:[{...newMessage('Hi'),delayCount:1}]},'form',[],'contacts'),/zero first delay/);
 }finally{await db.close();}
});
