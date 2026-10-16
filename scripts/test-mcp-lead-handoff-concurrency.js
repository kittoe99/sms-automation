// Disposable loopback PostgreSQL only; never accepts a deployment database URL.
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import assert from 'node:assert/strict';
import {fixture} from '../test/helpers/twilioConnections.js';
import {call} from '../test/helpers/database.js';
const {default:EmbeddedPostgres}=await import(pathToFileURL(resolve('data/inbound-postgres/node_modules/embedded-postgres/dist/index.js')));
const pg=new EmbeddedPostgres({databaseDir:resolve('data/inbound-postgres/mcp-lead-writes-'+Date.now()),user:'postgres',password:crypto.randomUUID(),port:55443,persistent:true,postgresFlags:['-h','127.0.0.1'],onLog:()=>{},onError:()=>{}});
const clients=[],adapter=c=>({exec:s=>c.query(s),query:(s,p)=>c.query(s,p),close:async()=>{}});
try{
 await pg.initialise();await pg.start();const a=pg.getPgClient(),b=pg.getPgClient();await a.connect();await b.connect();clients.push(a,b);
 const db=adapter(a),{business}=await fixture({database:db}),tenant=(await business('concurrency')).tenant;
 await call(db,'platform_action','staff','service_add',{tenantId:tenant,kind:'sms'});
 await b.query("select set_config('platform.actor_issuer','https://staff.example.test',false)");
 for(const client of clients)await client.query("set statement_timeout='15s'");
 const invoke=async(c,tool,p={})=>(await c.query('select crm_mcp.invoke($1,$2,$3,$4,$5) r',['staff','https://client.example.test/race.json',tool,JSON.stringify(p),crypto.randomUUID()])).rows[0].r;
 const connectionId=(await invoke(a,'crm_get_access')).data.connectionId;
 await call(db,'mcp_admin','staff','save',{connectionId,revision:0,status:'active',permissions:['lead_assign','lead_status_update','handoff_assign','handoff_status_update'],businessIds:[tenant],allBusinesses:false});
 const cid=(await a.query("insert into public.sms_contacts(tenant_id,phone) values($1,'+17208429167') returning id",[tenant])).rows[0].id;
 const lead=(await a.query('insert into public.sms_leads(tenant_id,contact_id) values($1,$2) returning id',[tenant,cid])).rows[0].id;
 const job=(await a.query("insert into sms_private.jobs(tenant_id,queue,dedupe_key,payload) values($1,'ai_reply_jobs','test','{}') returning id",[tenant])).rows[0].id;
 const handoff=(await a.query("insert into public.sms_handoffs(tenant_id,contact_id,ai_job_id,reason) values($1,$2,$3,'Test') returning id",[tenant,cid,job])).rows[0].id;
 for(const [resource,id,table] of [['lead',lead,'sms_leads'],['handoff',handoff,'sms_handoffs']]){
  const tool=`crm_assign_${resource}`,statusTool=`crm_set_${resource}_status`,base={businessId:tenant,[resource+'Id']:id};
  const input={...base,revision:1,idempotencyKey:crypto.randomUUID(),owner:'Test owner'};
  await a.query('begin');const first=await invoke(a,tool,input);assert.ok(first.ok);let done=false;
  const retry=invoke(b,tool,input).finally(()=>done=true);
  await new Promise(r=>setTimeout(r,120));assert.equal(done,false);await a.query('commit');assert.deepEqual((await retry).data,first.data);
  assert.equal(Number((await a.query(`select revision from public.${table} where id=$1`,[id])).rows[0].revision),2);
  await a.query('begin');assert.ok((await invoke(a,statusTool,{...base,revision:2,idempotencyKey:crypto.randomUUID(),status:'assigned'})).ok);done=false;
  const competing=invoke(b,tool,{...input,revision:2,idempotencyKey:crypto.randomUUID(),owner:'Competing owner'}).finally(()=>done=true);
  await new Promise(r=>setTimeout(r,120));assert.equal(done,false);await a.query('commit');assert.equal((await competing).error.code,'CONFLICT');
  await a.query('begin');await a.query(`update public.${table} set ${resource==='lead'?'summary':'reason'}='Worker updated' where id=$1`,[id]);done=false;
  const stale=invoke(b,statusTool,{...base,revision:3,idempotencyKey:crypto.randomUUID(),status:'closed'}).finally(()=>done=true);
  await new Promise(r=>setTimeout(r,120));assert.equal(done,false);await a.query('commit');assert.equal((await stale).error.code,'CONFLICT');
  const rollbackInput={...base,revision:4,idempotencyKey:crypto.randomUUID(),status:'closed'};
  await a.query('begin');assert.ok((await invoke(a,statusTool,rollbackInput)).ok);await a.query('rollback');
  assert.equal(Number((await a.query('select count(*) n from sms_private.mcp_requests where idempotency_key=$1',[rollbackInput.idempotencyKey])).rows[0].n),0);
  const saved=await invoke(b,statusTool,rollbackInput);assert.ok(saved.ok);assert.equal(saved.data.record.revision,5);
  const current=(await a.query(`select * from public.${table} where id=$1`,[id])).rows[0];assert.equal(current.owner,'Test owner');assert.equal(current.status,'closed');
  console.log(`PASS ${resource}: simultaneous retry executes once; competing writes and worker races conflict; rolled-back transaction safely retries`);
 }
 assert.equal(Number((await a.query('select count(*) n from public.sms_messages')).rows[0].n),0);
 assert.equal(Number((await a.query("select count(*) n from sms_private.jobs where queue in ('sms_send_jobs','handoff_alert_jobs')")).rows[0].n),0);
 console.log('PASS no SMS or alert jobs created');
}catch(e){console.error(e.message);process.exitCode=1;}finally{await Promise.allSettled(clients.map(c=>c.end()));await pg.stop();}
