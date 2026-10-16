// Disposable local PostgreSQL. No provider access or production data.
import {resolve} from 'node:path';
import {createServer} from 'node:net';
import {pathToFileURL} from 'node:url';
import assert from 'node:assert/strict';
import {fixture} from '../test/helpers/twilioConnections.js';
import {call} from '../test/helpers/database.js';
import {emailPermissions} from '../src/mcp/emailSchemas.js';
const {default:EmbeddedPostgres}=await import(pathToFileURL(resolve('data/inbound-postgres/node_modules/embedded-postgres/dist/index.js')));
const probe=createServer();await new Promise(resolve=>probe.listen(0,'127.0.0.1',resolve));const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));
const diagnostics=[];
const pg=new EmbeddedPostgres({databaseDir:resolve('data/inbound-postgres/mcp-email-'+Date.now()),user:'postgres',password:crypto.randomUUID(),port,persistent:true,initdbFlags:['--encoding=UTF8','--locale=C'],postgresFlags:['-h','127.0.0.1'],onLog:s=>diagnostics.push(String(s)),onError:s=>diagnostics.push(String(s))});
const clients=[];
try{
 await pg.initialise();await pg.start();
 const main=pg.getPgClient();await main.connect();clients.push(main);
 const db={exec:s=>main.query(s),query:(s,p)=>main.query(s,p),close:async()=>{}};
 const f=await fixture({database:db}),tenant=(await f.business('email-races')).tenant,phone='+17208429167';
 const a=pg.getPgClient(),b=pg.getPgClient();for(const c of [a,b]){await c.connect();clients.push(c);await c.query("select set_config('platform.actor_issuer','https://staff.example.test',false)");await c.query("set statement_timeout='8s'");}
 const invoke=async(client,tool,p,oauth='https://email-concurrency.test')=>(await client.query('select crm_mcp.invoke($1,$2,$3,$4,$5) r',['staff',oauth,tool,JSON.stringify(p),crypto.randomUUID()])).rows[0].r;
 for(const oauth of ['https://email-concurrency.test','https://email-concurrency.test/other']){
  const id=(await invoke(a,'crm_get_access',{},oauth)).data.connectionId;
  await call(db,'mcp_admin','staff','save',{connectionId:id,revision:0,status:'active',permissions:emailPermissions.map(x=>x[0]).concat('contact_edit'),businessIds:[tenant],allBusinesses:false});
 }
 await call(db,'seed_fixed_automation_groups',tenant);
 const g=(await main.query("select * from sms_private.email_group_settings where tenant_id=$1 order by group_id limit 1",[tenant])).rows[0];
 const conf={rule:{...g.rule,leadHours:24,firstDelayCount:0,firstDelayUnit:'hour'},intent:'Synthetic intent',systemPrompt:'Synthetic instructions',businessContext:'Synthetic context',mailingAddress:'Synthetic address'};
 const prepare=async(client,p)=> (await client.query('select crm_mcp.email_action_ticket($1,$2,$3,$4,$5) r',['staff','https://email-concurrency.test','crm_save_email_group',JSON.stringify(p),crypto.randomUUID()])).rows[0].r;
 const exec=async(client,token,p)=>(await client.query('select sms_private.mcp_execute_email_action($1,$2,false) r',[token,JSON.stringify(p)])).rows[0].r;
 const p={businessId:tenant,groupId:g.group_id,revision:1,configuration:conf,idempotencyKey:crypto.randomUUID()};
 const ta=await prepare(a,p),tb=await prepare(b,p);assert.equal(ta.ok,true);assert.equal(tb.ok,true);
 const pair=await Promise.all([exec(a,ta.ticket,p),exec(b,tb.ticket,p)]);assert.equal(pair[0].ok,true,JSON.stringify(pair));assert.deepEqual(pair[0],pair[1]);
 const stale={...p,revision:2,idempotencyKey:crypto.randomUUID()},auth=await prepare(b,stale);
 await a.query('begin');await call({query:(q,p)=>a.query(q,p)},'email_save_group','staff',tenant,g.group_id,{...conf,enabled:false,revision:2});
 assert.equal((await exec(b,auth.ticket,stale)).error.code,'TEMPORARY_FAILURE');await a.query('commit');
 const retryAuth=await prepare(b,stale);assert.equal((await exec(b,retryAuth.ticket,stale)).error.code,'CONFLICT');
 const rollback={...p,revision:3,idempotencyKey:crypto.randomUUID()},ra=await prepare(a,rollback);
 await a.query('begin');assert.equal((await exec(a,ra.ticket,rollback)).ok,true);await a.query('rollback');
 const rb=await prepare(b,rollback);assert.equal((await exec(b,rb.ticket,rollback)).ok,true);
 const single={...p,revision:4,idempotencyKey:crypto.randomUUID()},one=await prepare(a,single);
 const consumes=await Promise.allSettled([exec(a,one.ticket,single),exec(b,one.ticket,single)]);assert.equal(consumes.filter(x=>x.status==='fulfilled').length,1);
 const e=(await main.query("insert into sms_private.email_enrollments(tenant_id,group_id,source_type,source_id,email,name,rule_snapshot) values($1,$2,'contacts',gen_random_uuid(),'synthetic@example.test','Synthetic',$3) returning *",[tenant,g.group_id,JSON.stringify(conf.rule)])).rows[0];
 const resolve={businessId:tenant,enrollmentId:e.id,revision:Number(e.revision),generation:e.generation,idempotencyKey:crypto.randomUUID()};
 const results=await Promise.all([invoke(a,'crm_resolve_email_enrollment',resolve),invoke(b,'crm_resolve_email_enrollment',resolve)]);assert.equal(results[0].ok,true);assert.deepEqual(results[0],results[1]);
 assert.equal(Number((await main.query("select count(*) n from public.sms_messages where direction='outbound' or read_at is not null")).rows[0].n),0);
 assert.equal(Number((await main.query("select count(*) n from sms_private.email_jobs")).rows[0].n),0);
 console.log('PASS: identical configuration retries, browser lock/revision conflicts, interrupted adapter rollback, one-use ticket race and resolution retries; no email/SMS sends.');
}catch(e){console.error(e??diagnostics.slice(-12).join('\n'));process.exitCode=1;}finally{await Promise.allSettled(clients.map(c=>c.end()));await pg.stop();}
