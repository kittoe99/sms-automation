// Disposable local PostgreSQL. No provider access or production data.
import {resolve} from 'node:path';
import {createServer} from 'node:net';
import {pathToFileURL} from 'node:url';
import assert from 'node:assert/strict';
import {fixture} from '../test/helpers/twilioConnections.js';
import {call} from '../test/helpers/database.js';
import {voicePermissions} from '../src/mcp/voiceSchemas.js';
const {default:EmbeddedPostgres}=await import(pathToFileURL(resolve('data/inbound-postgres/node_modules/embedded-postgres/dist/index.js')));
const probe=createServer();await new Promise(resolve=>probe.listen(0,'127.0.0.1',resolve));const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));
const diagnostics=[];
const pg=new EmbeddedPostgres({databaseDir:resolve('data/inbound-postgres/mcp-voice-'+Date.now()),user:'postgres',password:crypto.randomUUID(),port,persistent:true,initdbFlags:['--encoding=UTF8','--locale=C'],postgresFlags:['-h','127.0.0.1'],onLog:s=>diagnostics.push(String(s)),onError:s=>diagnostics.push(String(s))});
const clients=[];
try{
 await pg.initialise();await pg.start();
 const main=pg.getPgClient();await main.connect();clients.push(main);
 const db={exec:s=>main.query(s),query:(s,p)=>main.query(s,p),close:async()=>{}};
 const f=await fixture({database:db}),tenant=(await f.business('voice-races')).tenant,phone='+17208429167';
 const a=pg.getPgClient(),b=pg.getPgClient();for(const c of [a,b]){await c.connect();clients.push(c);await c.query("select set_config('platform.actor_issuer','https://staff.example.test',false)");await c.query("set statement_timeout='8s'");}
 const invoke=async(client,tool,p,oauth='https://voice-concurrency.test')=>(await client.query('select crm_mcp.invoke($1,$2,$3,$4,$5) r',['staff',oauth,tool,JSON.stringify(p),crypto.randomUUID()])).rows[0].r;
 for(const oauth of ['https://voice-concurrency.test','https://voice-concurrency.test/other']){
  const id=(await invoke(a,'crm_get_access',{},oauth)).data.connectionId;
  await call(db,'mcp_admin','staff','save',{connectionId:id,revision:0,status:'active',permissions:voicePermissions.map(x=>x[0]).concat('contact_edit'),businessIds:[tenant],allBusinesses:false});
 }
 const configuration={name:'Synthetic',persona:'Synthetic',voice:'Synthetic voice',brain:'Synthetic brain',voiceName:'marin'};
 const creation={businessId:tenant,configuration,idempotencyKey:crypto.randomUUID()};
 const pair=await Promise.all([invoke(a,'crm_create_voice_agent',creation),invoke(b,'crm_create_voice_agent',creation)]);assert.equal(pair[0].ok,true,JSON.stringify(pair));assert.deepEqual(pair[0],pair[1]);
 const agent=pair[0].data.agentId;
 const p={businessId:tenant,agentId:agent,revision:1,configuration,idempotencyKey:crypto.randomUUID()};
 const saves=await Promise.all([invoke(a,'crm_save_voice_draft',p),invoke(b,'crm_save_voice_draft',p)]);assert.equal(saves[0].ok,true);assert.deepEqual(saves[0],saves[1]);
 await a.query('begin');await call({query:(q,p)=>a.query(q,p)},'voice_workspace','staff',tenant,'save',{agentId:agent,version:2,configuration});
 const stale={...p,revision:2,idempotencyKey:crypto.randomUUID()};assert.equal((await invoke(b,'crm_save_voice_draft',stale)).error.code,'TEMPORARY_FAILURE');await a.query('commit');assert.equal((await invoke(b,'crm_save_voice_draft',stale)).error.code,'CONFLICT');
 await main.query("update sms_private.voice_agents set deployment_id='synthetic',phone='+17208429167' where tenant_id=$1 and id=$2",[tenant,agent]);
 const publish={businessId:tenant,agentId:agent,revision:3,idempotencyKey:crypto.randomUUID()};
 await a.query('begin');assert.equal((await invoke(a,'crm_publish_voice_draft',publish)).ok,true);await a.query('rollback');
 const published=await Promise.all([invoke(a,'crm_publish_voice_draft',publish),invoke(b,'crm_publish_voice_draft',publish)]);assert.equal(published[0].ok,true);assert.deepEqual(published[0],published[1]);
 assert.equal(Number((await main.query('select count(*) n from sms_private.voice_configurations where tenant_id=$1',[tenant])).rows[0].n),1);
 const callId=(await main.query("insert into sms_private.voice_calls(tenant_id,agent_id,job_id,room_id,media_state,media_path) values($1,$2,'synthetic','synthetic','ready','private.ogg') returning id",[tenant,agent])).rows[0].id;
 const token=(await a.query('select crm_mcp.voice_media_ticket($1,$2,$3,$4) token',['staff','https://voice-concurrency.test',tenant,callId])).rows[0].token;
 const consume=async client=>client.query('select sms_private.mcp_consume_voice_media_ticket($1)',[token]);const consumes=await Promise.allSettled([consume(a),consume(b)]);assert.equal(consumes.filter(x=>x.status==='fulfilled').length,1);
 assert.equal(Number((await main.query("select count(*) n from public.sms_messages where direction='outbound' or read_at is not null")).rows[0].n),0);
 assert.equal(Number((await main.query("select count(*) n from sms_private.email_jobs")).rows[0].n),0);
 console.log('PASS: identical draft creation/edit retries, browser lock/revision conflicts, interrupted publication rollback and one-use media ticket race; no email/SMS sends.');
}catch(e){console.error(e??diagnostics.slice(-12).join('\n'));process.exitCode=1;}finally{await Promise.allSettled(clients.map(c=>c.end()));await pg.stop();}
