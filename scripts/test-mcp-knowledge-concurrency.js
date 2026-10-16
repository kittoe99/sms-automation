// Disposable local PostgreSQL. No provider access or production data.
import {resolve} from 'node:path';
import {createServer} from 'node:net';
import {pathToFileURL} from 'node:url';
import assert from 'node:assert/strict';
import {fixture} from '../test/helpers/twilioConnections.js';
import {call} from '../test/helpers/database.js';
import {knowledgePermissions} from '../src/mcp/knowledgeSchemas.js';
const {default:EmbeddedPostgres}=await import(pathToFileURL(resolve('data/inbound-postgres/node_modules/embedded-postgres/dist/index.js')));
const probe=createServer();await new Promise(resolve=>probe.listen(0,'127.0.0.1',resolve));const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));
const diagnostics=[];
const pg=new EmbeddedPostgres({databaseDir:resolve('data/inbound-postgres/mcp-knowledge-'+Date.now()),user:'postgres',password:crypto.randomUUID(),port,persistent:true,initdbFlags:['--encoding=UTF8','--locale=C'],postgresFlags:['-h','127.0.0.1'],onLog:s=>diagnostics.push(String(s)),onError:s=>diagnostics.push(String(s))});
const clients=[];
try{
 await pg.initialise();await pg.start();
 const main=pg.getPgClient();await main.connect();clients.push(main);
 const db={exec:s=>main.query(s),query:(s,p)=>main.query(s,p),close:async()=>{}};
 const f=await fixture({database:db}),tenant=(await f.business('knowledge-races')).tenant,phone='+17208429167';
 const a=pg.getPgClient(),b=pg.getPgClient();for(const c of [a,b]){await c.connect();clients.push(c);await c.query("select set_config('platform.actor_issuer','https://staff.example.test',false)");await c.query("set statement_timeout='8s'");}
 const invoke=async(client,tool,p,oauth='https://knowledge-concurrency.test')=>(await client.query('select crm_mcp.invoke($1,$2,$3,$4,$5) r',['staff',oauth,tool,JSON.stringify(p),crypto.randomUUID()])).rows[0].r;
 for(const oauth of ['https://knowledge-concurrency.test','https://knowledge-concurrency.test/other']){
  const id=(await invoke(a,'crm_get_access',{},oauth)).data.connectionId;
  await call(db,'mcp_admin','staff','save',{connectionId:id,revision:0,status:'active',permissions:knowledgePermissions.map(x=>x[0]).concat('contact_edit'),businessIds:[tenant],allBusinesses:false});
 }
 const p={businessId:tenant,type:'manual',title:'Concurrent source',text:'Synthetic source text for local tests only.',idempotencyKey:crypto.randomUUID()};
 const pair=await Promise.all([invoke(a,'crm_create_knowledge_source',p),invoke(b,'crm_create_knowledge_source',p)]);assert.equal(pair[0].ok,true,JSON.stringify(pair));assert.deepEqual(pair[0],pair[1]);const id=pair[0].data.sourceId;
 await a.query('begin');await a.query('update public.sms_knowledge_sources set title=title where tenant_id=$1 and id=$2',[tenant,id]);
 const locked=await invoke(b,'crm_refresh_knowledge_source',{businessId:tenant,sourceId:id,revision:1,idempotencyKey:crypto.randomUUID()});assert.equal(locked.error.code,'TEMPORARY_FAILURE');await a.query('commit');
 assert.equal((await invoke(b,'crm_refresh_knowledge_source',{businessId:tenant,sourceId:id,revision:1,idempotencyKey:crypto.randomUUID()})).error.code,'CONFLICT');
 const archive={businessId:tenant,sourceId:id,revision:2,idempotencyKey:crypto.randomUUID()};
 await a.query('begin');assert.equal((await invoke(a,'crm_archive_knowledge_source',archive)).ok,true);await a.query('rollback');
 const races=await Promise.all([invoke(a,'crm_archive_knowledge_source',archive),invoke(b,'crm_refresh_knowledge_source',{businessId:tenant,sourceId:id,revision:2,idempotencyKey:crypto.randomUUID()},'https://knowledge-concurrency.test/other')]);assert.equal(races.filter(x=>x.ok).length,1,JSON.stringify(races));assert.equal(races.find(x=>!x.ok).error.code,'CONFLICT');
 const settings={businessId:tenant,revision:0,systemPrompt:'Synthetic concurrent instructions',idempotencyKey:crypto.randomUUID()};
 const cfg=await Promise.all([invoke(a,'crm_save_ai_configuration',settings),invoke(b,'crm_save_ai_configuration',settings)]);assert.equal(cfg[0].ok,true,JSON.stringify(cfg));assert.deepEqual(cfg[0],cfg[1]);
 const upload=await invoke(a,'crm_prepare_knowledge_upload',{businessId:tenant,fileName:'test.txt',contentType:'text/plain',size:100,idempotencyKey:crypto.randomUUID()});assert.equal(upload.ok,true);
 const ticket=(await a.query('select crm_mcp.knowledge_upload_ticket($1,$2,$3) t',['staff','https://knowledge-concurrency.test',upload.data.uploadId])).rows[0].t;
 const consumes=await Promise.allSettled([a.query('select sms_private.mcp_consume_upload_ticket($1)',[ticket]),b.query('select sms_private.mcp_consume_upload_ticket($1)',[ticket])]);assert.equal(consumes.filter(x=>x.status==='fulfilled').length,1);
 assert.equal(Number((await main.query("select count(*) n from public.sms_messages where direction='outbound' or read_at is not null")).rows[0].n),0);
 console.log('PASS: duplicate indexing retries, worker revision/lock conflicts, interrupted archive rollback, competing archive/refresh, AI retries and one-use upload race; no sends/read marks.');
}catch(e){console.error(e??diagnostics.slice(-12).join('\n'));process.exitCode=1;}finally{await Promise.allSettled(clients.map(c=>c.end()));await pg.stop();}
