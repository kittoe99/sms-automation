// Disposable local PostgreSQL. No provider access or production data.
import {resolve} from 'node:path';
import {createServer} from 'node:net';
import {pathToFileURL} from 'node:url';
import assert from 'node:assert/strict';
import {fixture} from '../test/helpers/twilioConnections.js';
import {call} from '../test/helpers/database.js';
import {operationsPermissions} from '../src/mcp/operationsSchemas.js';
const {default:EmbeddedPostgres}=await import(pathToFileURL(resolve('data/inbound-postgres/node_modules/embedded-postgres/dist/index.js')));
const probe=createServer();await new Promise(resolve=>probe.listen(0,'127.0.0.1',resolve));const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));
const diagnostics=[];
const pg=new EmbeddedPostgres({databaseDir:resolve('data/inbound-postgres/mcp-operations-'+Date.now()),user:'postgres',password:crypto.randomUUID(),port,persistent:true,initdbFlags:['--encoding=UTF8','--locale=C'],postgresFlags:['-h','127.0.0.1'],onLog:s=>diagnostics.push(String(s)),onError:s=>diagnostics.push(String(s))});
const clients=[];
try{
 await pg.initialise();await pg.start();
 const main=pg.getPgClient();await main.connect();clients.push(main);
 const db={exec:s=>main.query(s),query:(s,p)=>main.query(s,p),close:async()=>{}};
 const f=await fixture({database:db}),tenant=(await f.business('operations-races')).tenant,phone='+17208429167';
 const a=pg.getPgClient(),b=pg.getPgClient();for(const c of [a,b]){await c.connect();clients.push(c);await c.query("select set_config('platform.actor_issuer','https://staff.example.test',false)");await c.query("set statement_timeout='8s'");}
 const invoke=async(client,tool,p,oauth='https://operations-concurrency.test')=>(await client.query('select crm_mcp.invoke($1,$2,$3,$4,$5) r',['staff',oauth,tool,JSON.stringify(p),crypto.randomUUID()])).rows[0].r;
 for(const oauth of ['https://operations-concurrency.test','https://operations-concurrency.test/other']){
  const id=(await invoke(a,'crm_get_access',{},oauth)).data.connectionId;
  await call(db,'mcp_admin','staff','save',{connectionId:id,revision:0,status:'active',permissions:operationsPermissions.map(x=>x[0]).concat('contact_edit'),businessIds:[tenant],allBusinesses:false});
 }
 await main.query("insert into sms_private.providers(tenant_id,account_sid,auth_secret_id,messaging_service_sid,phone_number_sid,from_number,provisioning_state) values($1,$2,vault.create_secret('synthetic'),$3,$4,'+17208429167','configured')",[tenant,'AC'+'1'.repeat(32),'MG'+'2'.repeat(32),'PN'+'3'.repeat(32)]);
 await main.query("insert into public.sms_twilio_registrations(tenant_id,sender_type,state,messaging_service_sid) values($1,'toll_free','ready',$2)",[tenant,'MG'+'2'.repeat(32)]);
 const versions=async()=>{const x=(await invoke(a,'crm_get_provider_readiness',{businessId:tenant})).data;return {businessId:tenant,revision:x.revision,providerRevision:x.providerRevision,registrationRevision:x.registrationRevision};};
 const p={...await versions(),idempotencyKey:crypto.randomUUID()};
 const pair=await Promise.all([invoke(a,'crm_refresh_provider_status',p),invoke(b,'crm_refresh_provider_status',p)]);assert.equal(pair[0].ok,true,JSON.stringify(pair));assert.deepEqual(pair[0],pair[1]);
 await main.query("update sms_private.jobs set status='completed' where id=$1",[pair[0].data.jobId]);
 const stale={...await versions(),idempotencyKey:crypto.randomUUID()};
 await a.query('begin');await a.query('update sms_private.providers set provisioning_state=provisioning_state where tenant_id=$1',[tenant]);
 assert.equal((await invoke(b,'crm_activate_sms_sending',stale)).error.code,'TEMPORARY_FAILURE');await a.query('commit');assert.equal((await invoke(b,'crm_activate_sms_sending',stale)).error.code,'CONFLICT');
 const activate={...await versions(),idempotencyKey:crypto.randomUUID()};
 await a.query('begin');assert.equal((await invoke(a,'crm_activate_sms_sending',activate)).ok,true);await a.query('rollback');
 const activated=await Promise.all([invoke(a,'crm_activate_sms_sending',activate),invoke(b,'crm_activate_sms_sending',activate)]);assert.equal(activated[0].ok,true,JSON.stringify(activated));assert.deepEqual(activated[0],activated[1]);assert.equal(Number(activated[0].data.revision),activate.revision+1);
 const op=(await main.query("insert into sms_private.remote_operations(tenant_id,provider,operation,idempotency_key) values($1,'twilio','refresh_status',gen_random_uuid()::text) returning *",[tenant])).rows[0];
 const job=(await main.query("insert into sms_private.jobs(tenant_id,queue,dedupe_key,status,payload) values($1,'compliance_jobs',gen_random_uuid()::text,'failed',$2) returning *",[tenant,JSON.stringify({operation_id:op.id})])).rows[0];
 const retry={...await versions(),jobId:job.id,jobRevision:1,operationRevision:1,idempotencyKey:crypto.randomUUID()};
 await b.query('begin');await b.query('update sms_private.jobs set attempts=attempts+1 where id=$1',[job.id]);assert.equal((await invoke(a,'crm_retry_operational_job',retry)).error.code,'TEMPORARY_FAILURE');await b.query('commit');assert.equal((await invoke(a,'crm_retry_operational_job',retry)).error.code,'CONFLICT');
 retry.jobRevision=2;const retries=await Promise.all([invoke(a,'crm_retry_operational_job',retry),invoke(b,'crm_retry_operational_job',retry)]);assert.equal(retries[0].ok,true,JSON.stringify(retries));assert.deepEqual(retries[0],retries[1]);assert.equal(Number(retries[0].data.jobRevision),3);
 assert.equal(Number((await main.query("select count(*) n from sms_private.jobs where queue='sms_send_jobs'")).rows[0].n),0);
 assert.equal(Number((await main.query('select count(*) n from public.sms_messages')).rows[0].n),0);
 console.log('PASS: concurrent refresh/retry/activation deduplication, worker lock and stale revision conflicts, interrupted activation rollback; no sends or provider calls.');
}catch(e){console.error(e??diagnostics.slice(-12).join('\n'));process.exitCode=1;}finally{await Promise.allSettled(clients.map(c=>c.end()));await pg.stop();}
