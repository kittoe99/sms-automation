// Disposable local PostgreSQL. No provider access or production data.
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import assert from 'node:assert/strict';
import {fixture} from '../test/helpers/twilioConnections.js';
import {call} from '../test/helpers/database.js';
import {addRun} from '../test/helpers/coordination.js';
import {activityPermissions} from '../src/mcp/activitySchemas.js';
const {default:EmbeddedPostgres}=await import(pathToFileURL(resolve('data/inbound-postgres/node_modules/embedded-postgres/dist/index.js')));
const pg=new EmbeddedPostgres({databaseDir:resolve('data/inbound-postgres/mcp-activity-'+Date.now()),user:'postgres',password:crypto.randomUUID(),port:55460,persistent:true,initdbFlags:['--encoding=UTF8','--locale=C'],postgresFlags:['-h','127.0.0.1'],onLog:()=>{},onError:()=>{}});
const clients=[];
try{
 await pg.initialise();await pg.start();
 const main=pg.getPgClient();await main.connect();clients.push(main);
 const db={exec:s=>main.query(s),query:(s,p)=>main.query(s,p),close:async()=>{}};
 const f=await fixture({database:db}),tenant=(await f.business('activity-races')).tenant,phone='+17208429167';
 const a=pg.getPgClient(),b=pg.getPgClient();for(const c of [a,b]){await c.connect();clients.push(c);await c.query("select set_config('platform.actor_issuer','https://staff.example.test',false)");await c.query("set statement_timeout='8s'");}
 const invoke=async(client,tool,p,oauth='https://activity-concurrency.test')=>(await client.query('select crm_mcp.invoke($1,$2,$3,$4,$5) r',['staff',oauth,tool,JSON.stringify(p),crypto.randomUUID()])).rows[0].r;
 for(const oauth of ['https://activity-concurrency.test','https://activity-concurrency.test/other']){
  const id=(await invoke(a,'crm_get_access',{},oauth)).data.connectionId;
  await call(db,'mcp_admin','staff','save',{connectionId:id,revision:0,status:'active',permissions:activityPermissions.map(x=>x[0]),businessIds:[tenant],allBusinesses:false});
 }
 await call(db,'platform_action','staff','service_add',{tenantId:tenant,kind:'sms'});
 await main.query('insert into public.sms_contacts(tenant_id,phone) values($1,$2)',[tenant,phone]);
 const cid=await call(db,'ensure_conversation',tenant,phone,null),run=await addRun(db,{business:tenant,customer:phone});
 const revision=async()=>Number((await main.query('select revision from public.sms_conversations where id=$1',[cid])).rows[0].revision);
 const pause={businessId:tenant,conversationId:cid,revision:await revision(),idempotencyKey:crypto.randomUUID()};
 let pair=await Promise.all([invoke(a,'crm_pause_conversation_ai',pause),invoke(b,'crm_pause_conversation_ai',pause)]);assert.equal(pair[0].ok,true,JSON.stringify(pair));assert.deepEqual(pair[0],pair[1]);
 const resume={...pause,revision:await revision(),idempotencyKey:crypto.randomUUID()};
 pair=await Promise.all([invoke(a,'crm_resume_conversation_ai',resume),invoke(b,'crm_pause_conversation_ai',{...resume,idempotencyKey:crypto.randomUUID()},'https://activity-concurrency.test/other')]);assert.equal(pair.filter(x=>x.ok).length,1,JSON.stringify(pair));assert.equal(pair.find(x=>!x.ok).error.code,'CONFLICT');
 const tag=(await invoke(a,'crm_create_activity_tag',{businessId:tenant,name:'Synthetic',idempotencyKey:crypto.randomUUID()})).data.tagId;
 const current=async()=>(await main.query('select generation,activity_revision from sms_private.form_runs where id=$1',[run.id])).rows[0];
 const payload=async()=>{const r=await current();return {businessId:tenant,runId:run.id,generation:Number(r.generation),activityRevision:Number(r.activity_revision),tagId:tag,tagRevision:1,present:true,idempotencyKey:crypto.randomUUID()};};
 const stale=await payload();
 await a.query('begin');await a.query("insert into sms_private.activity_events(tenant_id,run_id,event_key,kind) values($1,$2,'worker-race','test')",[tenant,run.id]);
 const waiting=invoke(b,'crm_set_enquiry_tag',stale);await new Promise(r=>setTimeout(r,100));await a.query('commit');assert.equal((await waiting).error.code,'CONFLICT');
 const p=await payload();pair=await Promise.all([invoke(a,'crm_set_enquiry_tag',p),invoke(b,'crm_set_enquiry_tag',p)]);assert.equal(pair[0].ok,true,JSON.stringify(pair));assert.deepEqual(pair[0],pair[1]);assert.equal(Number((await current()).generation),p.generation);
 const remove={...await payload(),present:false};await a.query('begin');assert.equal((await invoke(a,'crm_set_enquiry_tag',remove)).ok,true);await a.query('rollback');assert.equal((await invoke(b,'crm_set_enquiry_tag',remove)).ok,true);
 // A leased/locked alert must never be reset while a worker may submit it.
 const job=(await main.query("insert into sms_private.jobs(tenant_id,queue,dedupe_key,payload) values($1,'ai_reply_jobs','synthetic','{}') returning id",[tenant])).rows[0].id;
 const handoff=(await main.query("insert into public.sms_handoffs(tenant_id,contact_id,ai_job_id,reason,alert_status) select tenant_id,id,$2,'Synthetic','failed' from public.sms_contacts where tenant_id=$1 returning id",[tenant,job])).rows[0].id;
 const alert=(await main.query("insert into sms_private.jobs(tenant_id,queue,dedupe_key,payload,status) values($1,'handoff_alert_jobs',$2,'{}','failed') returning id",[tenant,'handoff-alert:'+handoff])).rows[0].id;
 await a.query('begin');await a.query("update sms_private.jobs set status='leased' where id=$1",[alert]);
 const retry=await invoke(b,'crm_retry_handoff_alert',{businessId:tenant,handoffId:handoff,revision:1,idempotencyKey:crypto.randomUUID()});assert.equal(retry.ok,false);assert.equal(retry.error.code,'TEMPORARY_FAILURE');assert.equal(retry.error.retryable,true);await a.query('commit');
 assert.equal((await main.query('select status from sms_private.jobs where id=$1',[alert])).rows[0].status,'leased');
 assert.equal(Number((await main.query("select count(*) n from public.sms_messages where direction='outbound' or read_at is not null")).rows[0].n),0);
 console.log('PASS: competing conversation edits, identical retries, worker activity race, interrupted rollback and leased alert exclusion; no sends or read marks.');
}catch(e){console.error(e);process.exitCode=1;}finally{await Promise.allSettled(clients.map(c=>c.end()));await pg.stop();}
