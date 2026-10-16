// Disposable local PostgreSQL. No provider access or production data.
import {resolve} from 'node:path';
import {createServer} from 'node:net';
import {pathToFileURL} from 'node:url';
import assert from 'node:assert/strict';
import {fixture} from '../test/helpers/twilioConnections.js';
const {default:EmbeddedPostgres}=await import(pathToFileURL(resolve('data/inbound-postgres/node_modules/embedded-postgres/dist/index.js')));
const probe=createServer();await new Promise(resolve=>probe.listen(0,'127.0.0.1',resolve));const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));
const diagnostics=[];
const pg=new EmbeddedPostgres({databaseDir:resolve('data/inbound-postgres/compliance-lifecycle-'+Date.now()),user:'postgres',password:crypto.randomUUID(),port,persistent:true,initdbFlags:['--encoding=UTF8','--locale=C'],postgresFlags:['-h','127.0.0.1'],onLog:s=>diagnostics.push(String(s)),onError:s=>diagnostics.push(String(s))});
const clients=[];
try{
 await pg.initialise();await pg.start();
 const main=pg.getPgClient();await main.connect();clients.push(main);
 const db={exec:s=>main.query(s),query:(s,p)=>main.query(s,p),close:async()=>{}};
 const f=await fixture({database:db}),tenant=(await f.business('operations-races')).tenant,phone='+17208429167';
 const a=pg.getPgClient(),b=pg.getPgClient();for(const c of [a,b]){await c.connect();clients.push(c);await c.query("select set_config('platform.actor_issuer','https://staff.example.test',false)");await c.query("set statement_timeout='8s'");}

 const make=async(state='processing')=>{
  const o=(await main.query("insert into sms_private.remote_operations(tenant_id,provider,operation,idempotency_key) values($1,'twilio','refresh_status',gen_random_uuid()::text) returning *",[tenant])).rows[0];
  const j=(await main.query("insert into sms_private.jobs(tenant_id,queue,dedupe_key,status,payload) values($1,'compliance_jobs',gen_random_uuid()::text,$2,$3) returning *",[tenant,state,JSON.stringify({operation_id:o.id})])).rows[0];return {o,j};
 };
 // A concurrent provider completion wins; terminal-job repair must not replace it.
 const x=await make();await a.query('begin');await a.query("update sms_private.remote_operations set state='completed' where id=$1",[x.o.id]);
 const failing=b.query("update sms_private.jobs set status='failed' where id=$1",[x.j.id]);await a.query('commit');await failing;
 assert.equal((await main.query('select state from sms_private.remote_operations where id=$1',[x.o.id])).rows[0].state,'completed');
 // Independent terminal writers create one transition/audit, and interrupted work rolls back.
 const y=await make();await Promise.all([a.query("update sms_private.jobs set status='failed' where id=$1",[y.j.id]),b.query("update sms_private.jobs set status='failed' where id=$1",[y.j.id])]);
 assert.equal(Number((await main.query("select count(*) n from sms_private.audit where action='compliance_operation_failed' and detail->>'operationId'=$1",[y.o.id])).rows[0].n),1);
 const z=await make();await a.query('begin');await a.query("update sms_private.jobs set status='failed' where id=$1",[z.j.id]);await a.query('rollback');assert.equal((await main.query('select state from sms_private.remote_operations where id=$1',[z.o.id])).rows[0].state,'pending');
 // Archive takes explicit NOWAIT locks and cannot overtake active work or a revision change.
 await a.query('begin');await a.query('select * from sms_private.jobs where id=$1 for update',[z.j.id]);
 await assert.rejects(()=>b.query("select sms_private.archive_obsolete_provider_job('staff',$1,$2,1,1)",[tenant,z.j.id]),e=>e.code==='55P03');await a.query('commit');
 await main.query("update sms_private.jobs set status='failed' where id=$1",[z.j.id]);
 await assert.rejects(()=>b.query("select sms_private.archive_obsolete_provider_job('staff',$1,$2,1,1)",[tenant,z.j.id]),e=>e.code==='40001');
 assert.equal(Number((await main.query('select count(*) n from public.sms_messages')).rows[0].n),0);
 assert.equal(Number((await main.query("select count(*) n from sms_private.jobs where queue='sms_send_jobs'")).rows[0].n),0);
 console.log('PASS: provider completion vs terminal failure, duplicate terminal writers, audit exactly once, rollback, archive lock/revision conflicts; no sends.');
}catch(e){console.error(e??diagnostics.slice(-12).join('\n'));process.exitCode=1;}finally{await Promise.allSettled(clients.map(c=>c.end()));await pg.stop();}
