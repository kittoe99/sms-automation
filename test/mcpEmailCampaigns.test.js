import test from 'node:test';
import assert from 'node:assert/strict';
import {z} from 'zod';
import {fixture} from './helpers/twilioConnections.js';
import {call} from './helpers/database.js';
import {toolOutputs,toolDefinitions} from '../src/mcp/tools.js';
import {emailCampaignPermissions,emailCampaignTools} from '../src/mcp/emailCampaignSchemas.js';
import {emailAutomationPermissions} from '../src/mcp/emailAutomationSchemas.js';

const marketing={purpose:'marketing',startHour:0,endHour:24,steps:[{subject:'PRIVATE CAMPAIGN SUBJECT',anchor:'event',offsetMinutes:0,document:[{type:'paragraph',content:[{text:'Hello from {{businessName}}'}]}]}]};

test('MCP email campaigns use opt-in grants, business scope, the canonical workflow, private receipts and replay',async()=>{
 const {db,business}=await fixture();
 try {
  const a=(await business('campaign-owner')).tenant,b=(await business('other-owner')).tenant;
  const invoke=async(tool,p={})=>{const r=(await db.query('select crm_mcp.invoke($1,$2,$3,$4,$5) r',['staff','campaign-client',tool,JSON.stringify(p),crypto.randomUUID()])).rows[0].r;if(r.ok)toolOutputs[tool].parse(r.data);return r;};
  const cid=(await invoke('crm_get_access')).data.connectionId;let grantRevision=0;
  const grant=async(permissions,status='active')=>{const saved=await call(db,'mcp_admin','staff','save',{connectionId:cid,revision:grantRevision,status,permissions,businessIds:[a],allBusinesses:false});grantRevision=saved.connection.revision;return saved.connection;};
  const write=(tool,p)=>invoke(tool,{businessId:a,idempotencyKey:crypto.randomUUID(),...p});

  // New grants are opt-in: an existing email automation grant gives no campaign access.
  await grant(emailAutomationPermissions.map(x=>x[0]));
  assert.equal((await invoke('crm_get_email_campaign_workspace',{businessId:a})).error.code,'PERMISSION_DENIED');
  const granted=await grant([...emailAutomationPermissions.map(x=>x[0]),...emailCampaignPermissions.map(x=>x[0])]);
  assert.ok(emailCampaignPermissions.every(([p])=>granted.permissions.includes(p)));
  assert.ok(granted.permissions.includes('email_automation_read'),'existing grants are kept alongside campaign grants');
  assert.equal((await invoke('crm_get_access')).data.permissions.includes('email_campaign_send'),true);
  assert.equal((await invoke('crm_get_email_campaign_workspace',{businessId:b})).error.code,'PERMISSION_DENIED');
  assert.equal((await invoke('crm_get_email_campaign_workspace',{businessId:a,extra:1})).error.code,'VALIDATION_ERROR');
  assert.equal((await invoke('crm_preview_email_segment',{businessId:a})).error.code,'VALIDATION_ERROR');

  // Setup through the existing tools: sender activation, a published template, one consented contact.
  await db.exec("update sms_private.email_sender_domains set status='verified'; update public.sms_businesses set status='active'; update sms_private.runtime set edge_enabled=true");
  const secret=(await db.query("select vault.create_secret('SYNTHETIC') id")).rows[0].id;await db.query('insert into vault.secrets(id) values($1)',[secret]);await db.query("update sms_private.edge_config set enabled=true,secret_id=$1 where queue='automation_jobs'",[secret]);
  assert.equal((await write('crm_set_email_automation_settings',{revision:0,enabled:true,replyTo:'owner@example.test',mailingAddress:'Synthetic address',domainId:null})).ok,true);
  const created=await write('crm_create_email_template',{name:'Newsletter',definition:marketing});
  const templateId=created.data.id;assert.equal((await write('crm_publish_email_template',{id:templateId,revision:created.data.revision})).ok,true);
  const yes=(await db.query("insert into public.sms_contacts(tenant_id,phone,name,email,source) values($1,'+13035550101','PRIVATE NAME','private@example.test','form') returning *",[a])).rows[0];
  await db.query("insert into public.sms_contacts(tenant_id,phone,name,email,source) values($1,'+13035550102','Other','noconsent@example.test','form')",[a]);
  assert.equal((await write('crm_record_email_marketing_consent',{contactId:yes.id,contactRevision:yes.revision,consent:true,evidence:'PRIVATE CONSENT EVIDENCE'})).ok,true);

  const definition={match:'all',rules:[{field:'source',value:'form'}]};
  const preview=await invoke('crm_preview_email_segment',{businessId:a,definition});assert.equal(preview.ok,true,JSON.stringify(preview));
  assert.equal(preview.data.total,2);assert.equal(preview.data.eligible,1);assert.deepEqual(preview.data.skipped,{NO_CONSENT:1});
  await grant(['email_campaign_read']);
  assert.equal((await write('crm_save_email_segment',{name:'Form leads',definition})).error.code,'PERMISSION_DENIED');
  await grant(emailCampaignPermissions.map(x=>x[0]));

  const segInput={businessId:a,idempotencyKey:crypto.randomUUID(),name:'Form leads',definition};
  const segment=await invoke('crm_save_email_segment',segInput);assert.equal(segment.ok,true,JSON.stringify(segment));
  assert.deepEqual((await invoke('crm_save_email_segment',segInput)).data,segment.data,'identical retry replays');
  assert.equal((await invoke('crm_save_email_segment',{...segInput,name:'Changed'})).error.code,'CONFLICT');
  assert.equal((await write('crm_save_email_segment',{id:segment.data.id,name:'No revision',definition})).error.code,'VALIDATION_ERROR');
  assert.equal((await write('crm_save_email_segment',{name:'Bad',definition:{match:'all',rules:[{field:'sql',value:'1=1'}]}})).error.code,'VALIDATION_ERROR');

  let draft=await write('crm_save_email_campaign',{name:'Launch',templateId,segmentId:segment.data.id});assert.equal(draft.ok,true,JSON.stringify(draft));assert.equal(draft.data.status,'draft');
  const check=await invoke('crm_preview_email_campaign',{businessId:a,id:draft.data.id});assert.equal(check.data.eligible,1);assert.equal(check.data.queued,false);
  assert.equal((await write('crm_start_email_campaign',{id:draft.data.id,revision:draft.data.revision+3})).error.code,'CONFLICT');
  await grant(['email_campaign_read','email_campaign_edit','email_campaign_control']);
  assert.equal((await write('crm_start_email_campaign',{id:draft.data.id,revision:draft.data.revision})).error.code,'PERMISSION_DENIED','starting requires the send grant');
  await grant(emailCampaignPermissions.map(x=>x[0]));
  const started=await write('crm_start_email_campaign',{id:draft.data.id,revision:draft.data.revision});assert.equal(started.ok,true,JSON.stringify(started));
  assert.equal(started.data.status,'sending');assert.equal(started.data.counts.queued,1);assert.deepEqual(started.data.counts.skipped,{NO_CONSENT:1});
  const paused=await write('crm_pause_email_campaign',{id:draft.data.id,revision:started.data.revision});assert.equal(paused.data.status,'paused');
  const resumed=await write('crm_resume_email_campaign',{id:draft.data.id,revision:paused.data.revision});assert.equal(resumed.data.status,'sending');

  const report=await invoke('crm_get_email_campaign',{businessId:a,campaignId:draft.data.id});assert.equal(report.ok,true,JSON.stringify(report));
  assert.equal(report.data.recipients.length,2);
  const workspace=await invoke('crm_get_email_campaign_workspace',{businessId:a});
  assert.equal(workspace.data.campaigns.length,1);assert.ok(!JSON.stringify(workspace).includes('providerId'));assert.ok(!JSON.stringify(workspace).includes('private@example.test'));
  assert.equal((await invoke('crm_get_email_campaign',{businessId:b,campaignId:draft.data.id})).error.code,'PERMISSION_DENIED');
  assert.equal((await write('crm_archive_email_segment',{id:segment.data.id,revision:segment.data.revision})).ok,true,'a sending campaign keeps its snapshot');
  const cancelled=await write('crm_cancel_email_campaign',{id:draft.data.id,revision:resumed.data.revision});assert.equal(cancelled.data.status,'cancelled');

  // Receipts and audit rows never hold recipient data, consent evidence or content.
  const saved=JSON.stringify((await db.query('select result from sms_private.mcp_requests')).rows)+JSON.stringify((await db.query('select * from sms_private.mcp_activity')).rows);
  for(const value of ['private@example.test','PRIVATE NAME','PRIVATE CONSENT EVIDENCE','PRIVATE CAMPAIGN SUBJECT'])assert.ok(!saved.includes(value),value);
  const audit=(await db.query("select tool,outcome from sms_private.mcp_activity where tool like '%email_campaign%' or tool like '%email_segment%'")).rows;
  assert.ok(audit.some(r=>r.tool==='crm_start_email_campaign'&&r.outcome==='success'));assert.ok(audit.some(r=>r.outcome==='denied'));assert.ok(audit.some(r=>r.outcome==='replayed'));

  // Other tools still go through the original gateway; revoking removes campaign access.
  assert.equal((await invoke('crm_get_email_automation_workspace',{businessId:a})).error.code,'PERMISSION_DENIED');
  await grant([],'revoked');assert.equal((await invoke('crm_get_email_campaign_workspace',{businessId:a})).error.code,'PERMISSION_DENIED');
  for(const fn of ['sms_private.mcp_email_campaign_action(text,text,text,jsonb,uuid)','sms_private.mcp_invoke_before_campaigns(text,text,text,jsonb,uuid)','sms_private.mcp_admin_before_campaigns(text,text,jsonb)'])
   assert.equal((await db.query("select has_function_privilege('crm_mcp',$1,'execute') ok",[fn])).rows[0].ok,false,fn);
  assert.equal((await db.query('select count(*)::integer n from sms_private.email_jobs where send_started_at is not null')).rows[0].n,0);
 } finally {await db.close();}
});

test('MCP campaign schemas reject SQL-like segment rules and unknown fields',()=>{
 const save=z.object(emailCampaignTools.find(t=>t[0]==='crm_save_email_segment')[2]).strict();
 const base={businessId:'b',idempotencyKey:crypto.randomUUID(),name:'x'};
 assert.equal(save.safeParse({...base,definition:{match:'all',rules:[{field:'source',value:'form'}]}}).success,true);
 assert.equal(save.safeParse({...base,definition:{match:'all',rules:[{field:'where',value:'1=1'}]}}).success,false);
 assert.equal(save.safeParse({...base,definition:{match:'all',rules:[],sql:'x'}}).success,false);
 assert.equal(save.safeParse({...base,definition:{match:'all',rules:[{field:'createdWithinDays',value:0}]}}).success,false);
 assert.ok(toolDefinitions.filter(t=>t[0].includes('email_campaign')||t[0].includes('email_segment')).length===11);
});
