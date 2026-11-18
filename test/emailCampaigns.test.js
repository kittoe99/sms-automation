import test from 'node:test';
import assert from 'node:assert/strict';
import { testDatabase, call } from './helpers/database.js';
import { processEmailBatch } from '../src/workers/email.js';
import { createEmailWorkerHandler } from '../supabase/functions/email-worker/handler.js';
import { createCrmHandler } from '../supabase/functions/crm-api/handler.js';
import { summarizeCounts } from '../public/emailCampaignWorkspace.js';

const marketing = {purpose:'marketing',startHour:0,endHour:24,steps:[{subject:'News for {{firstName}}',anchor:'event',offsetMinutes:0,
 document:[{type:'paragraph',content:[{text:'Hello from {{businessName}}. '},{text:'See our offer',href:'https://example.test/offer'}]}]}]};

async function setup() {
 const db=await testDatabase();
 for(const [id,name] of [['camp','Campaign business'],['other','Other business']]) await call(db,'api_action','admin',null,'create_business',{id,name,timeZone:'America/Denver'});
 await db.exec("update sms_private.email_sender_domains set status='verified'; update sms_private.runtime set edge_enabled=true; update public.sms_businesses set status='active'");
 const secret=(await db.query("select vault.create_secret(repeat('a',32)) id")).rows[0].id;
 await db.query('insert into vault.secrets(id) values($1)',[secret]);
 await db.query("update sms_private.edge_config set enabled=true,secret_id=$1 where queue='automation_jobs'",[secret]);
 const automation=(tenant,name,input={})=>call(db,'email_automations','admin',tenant,name,{...input,idempotencyKey:input.idempotencyKey||crypto.randomUUID()});
 const campaigns=(name,input={},tenant='camp')=>call(db,'email_campaigns','admin',tenant,name,['read','segment_preview','campaign_preview'].includes(name)?input:{...input,idempotencyKey:input.idempotencyKey||crypto.randomUUID()});
 await automation('camp','settings',{revision:0,enabled:true,replyTo:'owner@example.test',mailingAddress:'123 Main Street, Denver, CO'});
 const contacts={};
 for(const [phone,name,email,source] of [['+13035550101','Alex','alex@example.test','form'],['+13035550102','Blake','blake@example.test','form'],
  ['+13035550103','Casey','casey@example.test','form'],['+13035550104','Dana','DANA@Example.test','contact'],['+13035550105','No Email',null,'form']]) {
  contacts[name]=(await db.query("insert into public.sms_contacts(tenant_id,phone,name,email,source) values('camp',$1,$2,$3,$4) returning *",[phone,name,email,source])).rows[0];
 }
 await db.query("insert into public.sms_contacts(tenant_id,phone,name,email) values('other','+13035550199','Other','other@example.test')");
 for(const name of ['Alex','Casey','Dana']) await automation('camp','consent',{contactId:contacts[name].id,contactRevision:contacts[name].revision,consent:true,evidence:'Signed newsletter opt-in'});
 await call(db,'email_set_permission','camp','casey@example.test',false,'Customer unsubscribed','test');
 let template=await automation('camp','create',{name:'Newsletter',definition:marketing});
 template=await automation('camp','publish',{id:template.id,revision:template.revision});
 return {db,automation,campaigns,contacts,template,workerDb:{call:(name,...args)=>call(db,name,...args)}};
}

test('segments preview consent-aware eligibility, and campaigns snapshot recipients once',async()=>{
 const {db,campaigns,template}=await setup();try{
  await assert.rejects(()=>campaigns('segment_save',{name:'Bad',definition:{match:'all',rules:[{field:'sql',value:'1=1'}]}}),/Unknown segment field/);
  const preview=await campaigns('segment_preview',{definition:{match:'all',rules:[]}});
  assert.equal(preview.total,4);assert.equal(preview.eligible,2);
  assert.deepEqual(preview.skipped,{NO_CONSENT:1,UNSUBSCRIBED:1});
  assert.equal((await campaigns('segment_preview',{definition:{match:'all',rules:[{field:'source',value:'contact'}]}})).total,1);
  assert.equal((await campaigns('segment_preview',{definition:{match:'any',rules:[{field:'source',value:'contact'},{field:'emailDomain',value:'EXAMPLE.test'}]}})).total,4);
  const segment=await campaigns('segment_save',{name:'Everyone',definition:{match:'all',rules:[]}});
  let campaign=await campaigns('campaign_save',{name:'November news',templateId:template.id,segmentId:segment.id});
  assert.equal(campaign.status,'draft');
  assert.deepEqual((await campaigns('read',{},'other')).campaigns,[]);
  await assert.rejects(()=>call(db,'email_campaigns','admin','other','campaign_start',{id:campaign.id,revision:campaign.revision,idempotencyKey:crypto.randomUUID()}),/no rows|Enable email/);
  const start={id:campaign.id,revision:campaign.revision,idempotencyKey:crypto.randomUUID()};
  campaign=await campaigns('campaign_start',start);
  assert.equal(campaign.status,'sending');assert.equal(campaign.counts.queued,2);assert.deepEqual(campaign.counts.skipped,{NO_CONSENT:1,UNSUBSCRIBED:1});
  assert.deepEqual(await campaigns('campaign_start',start),campaign);
  await assert.rejects(()=>campaigns('campaign_start',{id:campaign.id,revision:campaign.revision}),/already started/);
  await assert.rejects(()=>campaigns('campaign_save',{id:campaign.id,revision:campaign.revision,name:'Edited'}),/Only draft/);
  await assert.rejects(()=>campaigns('segment_archive',{id:segment.id,revision:segment.revision+5}),/changed/);
  const runs=(await db.query("select email,purpose,origin_type from sms_private.email_enrollments where campaign_id=$1 order by email",[campaign.id])).rows;
  assert.deepEqual(runs.map(r=>r.email),['alex@example.test','dana@example.test']);assert.ok(runs.every(r=>r.purpose==='marketing'&&r.origin_type==='campaign'));
 }finally{await db.close();}
});

test('campaign templates must be published marketing content with event timing',async()=>{
 const {db,automation,campaigns}=await setup();try{
  const service={...structuredClone(marketing),purpose:'service'};service.steps[0].anchor='appointment';service.steps[0].offsetMinutes=-60;
  let t=await automation('camp','create',{name:'Reminder',definition:service});t=await automation('camp','publish',{id:t.id,revision:t.revision});
  await assert.rejects(()=>campaigns('campaign_save',{name:'Bad',templateId:t.id}),/marketing template/);
  const draft=await automation('camp','create',{name:'Unpublished',definition:marketing});
  await assert.rejects(()=>campaigns('campaign_save',{name:'Bad',templateId:draft.id}),/published/);
  assert.ok((await campaigns('read')).templates.every(x=>x.id!==t.id&&x.id!==draft.id));
 }finally{await db.close();}
});

test('batch delivery replays an uncertain request identically, then records engagement and completes',async()=>{
 const {db,campaigns,template,workerDb}=await setup();try{
  const segment=await campaigns('segment_save',{name:'Everyone',definition:{match:'all',rules:[]}});
  let campaign=await campaigns('campaign_save',{name:'Launch',templateId:template.id,segmentId:segment.id});
  campaign=await campaigns('campaign_start',{id:campaign.id,revision:campaign.revision});
  await call(db,'dispatch_email_edge');
  assert.equal(await call(db,'email_claim'),null,'single-message claims leave campaign jobs to batches');
  const claim=await call(db,'email_claim_batch');assert.equal(claim.resume,false);assert.equal(claim.jobs.length,2);
  const requests=[];
  const failing=async(url,options)=>{requests.push({url,key:options.headers['Idempotency-Key'],body:options.body});throw new Error('socket closed');};
  assert.deepEqual(await processEmailBatch(claim,workerDb,{apiKey:'test',fetchImpl:failing}),{sent:0});
  assert.match(requests[0].url,/\/emails\/batch$/);
  const payloads=JSON.parse(requests[0].body);assert.equal(payloads.length,2);
  assert.ok(payloads.every(p=>p.headers['List-Unsubscribe-Post']==='List-Unsubscribe=One-Click'&&/Unsubscribe/.test(p.html)&&p.reply_to==='owner@example.test'));
  assert.deepEqual(payloads.map(p=>p.subject).sort(),['News for Alex','News for Dana']);
  // A consent withdrawal after submission cannot change the frozen request.
  await call(db,'email_set_permission','camp','dana@example.test',false,'Changed mind','test');
  await db.query("update sms_private.email_jobs set due_at=now() where batch_id=$1",[claim.batch.id]);
  const replay=await call(db,'email_claim_batch');assert.equal(replay.resume,true);assert.equal(replay.batch.id,claim.batch.id);
  const ok=async(url,options)=>{requests.push({url,key:options.headers['Idempotency-Key'],body:options.body});return Response.json({data:JSON.parse(options.body).map((_,i)=>({id:`resend-${i}`}))});};
  assert.deepEqual(await processEmailBatch(replay,workerDb,{apiKey:'test',fetchImpl:ok}),{sent:2});
  assert.equal(requests[1].key,requests[0].key);assert.equal(requests[1].body,requests[0].body);
  const jobs=(await db.query("select status,provider_id from sms_private.email_jobs where batch_id=$1 order by provider_id",[claim.batch.id])).rows;
  assert.deepEqual(jobs.map(j=>[j.status,j.provider_id]),[['sent','resend-0'],['sent','resend-1']]);
  assert.equal((await db.query('select status from sms_private.email_send_batches where id=$1',[claim.batch.id])).rows[0].status,'sent');
  await call(db,'email_record_engagement','evt-open','resend-0','email.opened',null);
  await call(db,'email_record_engagement','evt-click','resend-0','email.clicked','https://example.test/offer');
  await call(db,'email_record_engagement','evt-click','resend-0','email.clicked','https://example.test/offer');
  await call(db,'email_record_engagement','evt-js','resend-1','email.clicked','javascript:alert(1)');
  await call(db,'email_record_provider_event','evt-delivered','resend-1','email.delivered','alex@example.test');
  await call(db,'dispatch_email_edge');
  const report=await campaigns('read',{campaignId:campaign.id});
  assert.equal(report.campaign.status,'completed');
  const s=summarizeCounts(report.campaign.counts);
  assert.equal(s.sent,2);assert.equal(s.opened,2);assert.equal(s.clicked,2);assert.equal(s.delivered,1);assert.equal(s.openRate,'100%');
  assert.deepEqual(report.links,[{url:'https://example.test/offer',clicks:1}]);
  assert.equal(report.recipients.length,4);
 }finally{await db.close();}
});

test('the send guard drops ineligible members before the first submission; pause, resume and cancel fence work',async()=>{
 const {db,campaigns,template,workerDb}=await setup();try{
  const segment=await campaigns('segment_save',{name:'Everyone',definition:{match:'all',rules:[]}});
  let campaign=await campaigns('campaign_save',{name:'Flash sale',templateId:template.id,segmentId:segment.id});
  campaign=await campaigns('campaign_start',{id:campaign.id,revision:campaign.revision});
  campaign=await campaigns('campaign_pause',{id:campaign.id,revision:campaign.revision});assert.equal(campaign.status,'paused');
  await call(db,'dispatch_email_edge');
  assert.equal(await call(db,'email_claim_batch'),null,'paused campaigns create no work');
  campaign=await campaigns('campaign_resume',{id:campaign.id,revision:campaign.revision});assert.equal(campaign.status,'sending');
  await call(db,'dispatch_email_edge');
  await call(db,'email_set_permission','camp','dana@example.test',false,'Unsubscribed before send','test');
  const claim=await call(db,'email_claim_batch');assert.equal(claim.jobs.length,2);
  let body;await processEmailBatch(claim,workerDb,{apiKey:'test',fetchImpl:async(url,options)=>{body=JSON.parse(options.body);return Response.json({data:body.map((_,i)=>({id:`flash-${i}`}))});}});
  assert.deepEqual(body.map(p=>p.to),['alex@example.test']);
  const batch=(await db.query('select job_ids from sms_private.email_send_batches where id=$1',[claim.batch.id])).rows[0];assert.equal(batch.job_ids.length,1);
  assert.equal((await db.query("select count(*)::integer n from sms_private.email_jobs where batch_id=$1",[claim.batch.id])).rows[0].n,1);
  const cancelled=await campaigns('campaign_cancel',{id:campaign.id,revision:campaign.revision});
  assert.equal(cancelled.status,'cancelled');
  await assert.rejects(()=>campaigns('campaign_resume',{id:campaign.id,revision:cancelled.revision}),/Only paused/);
 }finally{await db.close();}
});

test('scheduled campaigns wait, provider 4xx fails the batch without retry, and drafts can be discarded',async()=>{
 const {db,campaigns,template,workerDb}=await setup();try{
  const segment=await campaigns('segment_save',{name:'Form leads',definition:{match:'all',rules:[{field:'source',value:'form'}]}});
  let later=await campaigns('campaign_save',{name:'Later',templateId:template.id,segmentId:segment.id,scheduledAt:new Date(Date.now()+86400000).toISOString()});
  later=await campaigns('campaign_start',{id:later.id,revision:later.revision});assert.equal(later.status,'scheduled');
  await call(db,'dispatch_email_edge');assert.equal(await call(db,'email_claim_batch'),null);
  await db.query("update sms_private.email_campaigns set scheduled_at=now() where id=$1",[later.id]);
  await db.query("update sms_private.email_enrollments set next_run_at=now() where campaign_id=$1",[later.id]);
  await call(db,'dispatch_email_edge');
  assert.equal((await campaigns('read')).campaigns.find(c=>c.id===later.id).status,'sending');
  const claim=await call(db,'email_claim_batch');assert.equal(claim.jobs.length,1);
  await processEmailBatch(claim,workerDb,{apiKey:'test',fetchImpl:async()=>Response.json({name:'validation_error',message:'Invalid from'},{status:422})});
  assert.equal((await db.query('select status from sms_private.email_jobs where batch_id=$1',[claim.batch.id])).rows[0].status,'failed');
  assert.equal((await db.query('select status from sms_private.email_send_batches where id=$1',[claim.batch.id])).rows[0].status,'failed');
  const draft=await campaigns('campaign_save',{name:'Scrap'});
  assert.equal((await campaigns('campaign_cancel',{id:draft.id,revision:draft.revision})).status,'cancelled');
 }finally{await db.close();}
});

test('worker handler runs single jobs before campaign batches within one admission slot',async()=>{
 const calls=[];let batchClaims=0;
 const db={call:async name=>{calls.push(name);if(name==='edge_enter')return 'slot';if(name==='email_claim')return null;
  if(name==='email_claim_batch')return batchClaims++<2?{batch:{id:'b',lease_token:'t'},jobs:[{id:'j1'},{id:'j2'}],resume:false}:null;}};
 const processed=[];
 const handler=createEmailWorkerHandler({db,secret:'s'.repeat(32),processJob:async()=>{},processBatch:async claim=>processed.push(claim.batch.id)});
 const response=await handler(new Request('http://localhost',{method:'POST',headers:{Authorization:`Bearer ${'s'.repeat(32)}`}}));
 assert.deepEqual(await response.json(),{processed:4,batches:2});
 assert.deepEqual(calls.filter(n=>n!=='edge_exit'),['edge_enter','email_claim','email_claim_batch','email_claim_batch','email_claim_batch']);
 assert.equal(processed.length,2);
});

test('campaign API routes authenticate, scope the RPC and restrict methods',async()=>{
 const calls=[];
 const handler=createCrmHandler({call:async(...args)=>{calls.push(args);return {campaigns:[]};}},async()=>'staff');
 let response=await handler(new Request('http://localhost/api/email-campaigns/read?campaignId=x',{headers:{'X-Tenant-ID':'camp'}}));
 assert.equal(response.status,200);assert.deepEqual(calls[0],['email_campaigns','staff','camp','read',{campaignId:'x'}]);
 response=await handler(new Request('http://localhost/api/email-campaigns/campaign_start',{headers:{'X-Tenant-ID':'camp'}}));
 assert.equal(response.status,405);
 response=await handler(new Request('http://localhost/api/email-campaigns/campaign_start',{method:'POST',headers:{'X-Tenant-ID':'camp'},body:JSON.stringify({id:'c'})}));
 assert.equal(response.status,200);assert.deepEqual(calls[1],['email_campaigns','staff','camp','campaign_start',{id:'c'}]);
 assert.equal((await handler(new Request('http://localhost/api/email-campaigns/drop_table',{method:'POST',headers:{'X-Tenant-ID':'camp'}}))).status,404);
});
