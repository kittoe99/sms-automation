// Disposable local PostgreSQL. No provider access or production data.
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import assert from 'node:assert/strict';
import {fixture} from '../test/helpers/twilioConnections.js';
import {call} from '../test/helpers/database.js';
import {addRun} from '../test/helpers/coordination.js';
import {formLifecyclePermissions} from '../src/mcp/formLifecycleSchemas.js';
const {default:EmbeddedPostgres}=await import(pathToFileURL(resolve('data/inbound-postgres/node_modules/embedded-postgres/dist/index.js')));
const pg=new EmbeddedPostgres({databaseDir:resolve('data/inbound-postgres/mcp-lifecycle-'+Date.now()),user:'postgres',password:crypto.randomUUID(),port:55461,persistent:true,initdbFlags:['--encoding=UTF8','--locale=C'],postgresFlags:['-h','127.0.0.1'],onLog:()=>{},onError:()=>{}});
const clients=[];
try{
 await pg.initialise();await pg.start();
 const main=pg.getPgClient();await main.connect();clients.push(main);
 const db={exec:s=>main.query(s),query:(s,p)=>main.query(s,p),close:async()=>{}};
 const f=await fixture({database:db}),tenant=(await f.business('lifecycle-races')).tenant,phone='+17208429167';
 const a=pg.getPgClient(),b=pg.getPgClient();for(const c of [a,b]){await c.connect();clients.push(c);await c.query("select set_config('platform.actor_issuer','https://staff.example.test',false)");await c.query("set statement_timeout='8s'");}
 const invoke=async(client,tool,p,oauth='https://lifecycle-concurrency.test')=>(await client.query('select crm_mcp.invoke($1,$2,$3,$4,$5) r',['staff',oauth,tool,JSON.stringify(p),crypto.randomUUID()])).rows[0].r;
 for(const oauth of ['https://lifecycle-concurrency.test','https://lifecycle-concurrency.test/other']){
  const id=(await invoke(a,'crm_get_access',{},oauth)).data.connectionId;
  await call(db,'mcp_admin','staff','save',{connectionId:id,revision:0,status:'active',permissions:formLifecyclePermissions.map(x=>x[0]),businessIds:[tenant],allBusinesses:false});
 }
 await call(db,'platform_action','staff','service_add',{tenantId:tenant,kind:'sms'});
 await main.query('insert into public.sms_contacts(tenant_id,phone) values($1,$2)',[tenant,phone]);
 const run=await addRun(db,{business:tenant,customer:phone});
 const current=async()=>(await main.query('select version from public.sms_web_form_definitions where public_id=$1',[run.form_id])).rows[0].version;
 const payload=async(extra={})=>({businessId:tenant,formId:run.form_id,revision:await current(),draftRevision:0,idempotencyKey:crypto.randomUUID(),...extra});
 const duplicate=await payload({automationRevision:1});
 let pair=await Promise.all([invoke(a,'crm_duplicate_form',duplicate),invoke(b,'crm_duplicate_form',duplicate)]);assert.equal(pair[0].ok,true,JSON.stringify(pair));assert.deepEqual(pair[0],pair[1]);
 const stale=await payload();await a.query('begin');await a.query("update public.sms_web_form_definitions set title='Browser newer' where public_id=$1",[run.form_id]);
 const waiting=invoke(b,'crm_archive_form',stale);await new Promise(r=>setTimeout(r,100));await a.query('commit');assert.equal((await waiting).error.code,'CONFLICT');
 const p=await payload();await a.query('begin');await a.query('select id from sms_private.form_runs where id=$1 for update',[run.id]);
 const blocked=await invoke(b,'crm_archive_form',p);assert.equal(blocked.error.code,'TEMPORARY_FAILURE');await a.query('rollback');
 pair=await Promise.all([invoke(a,'crm_archive_form',p),invoke(b,'crm_archive_form',{...p,idempotencyKey:crypto.randomUUID()},'https://lifecycle-concurrency.test/other')]);assert.equal(pair.filter(x=>x.ok).length,1,JSON.stringify(pair));assert.equal(pair.find(x=>!x.ok).error.code,'CONFLICT');
 const restore=await payload();await a.query('begin');assert.equal((await invoke(a,'crm_restore_form',restore)).ok,true);await a.query('rollback');assert.equal((await invoke(b,'crm_restore_form',restore)).ok,true);
 assert.equal((await main.query('select enabled from public.sms_web_form_definitions where public_id=$1',[run.form_id])).rows[0].enabled,false);
 assert.equal((await main.query('select status from sms_private.form_runs where id=$1',[run.id])).rows[0].status,'stopped');
 assert.equal(Number((await main.query("select count(*) n from public.sms_messages where direction='outbound' or read_at is not null")).rows[0].n),0);
 console.log('PASS: concurrent duplication, browser revision race, locked run exclusion, competing archive and interrupted restore; no sends or read marks.');
}catch(e){console.error(e);process.exitCode=1;}finally{await Promise.allSettled(clients.map(c=>c.end()));await pg.stop();}
