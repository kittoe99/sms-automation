// Disposable PostgreSQL, never a production URL. Uses the existing optional
// embedded-postgres runtime documented in test-inbound-concurrency.js.
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import assert from 'node:assert/strict';
import {fixture} from '../test/helpers/twilioConnections.js';
import {call} from '../test/helpers/database.js';
const {default:EmbeddedPostgres}=await import(pathToFileURL(resolve('data/inbound-postgres/node_modules/embedded-postgres/dist/index.js')));
const pg=new EmbeddedPostgres({databaseDir:resolve('data/inbound-postgres/mcp-'+Date.now()),user:'postgres',password:crypto.randomUUID(),port:55446,persistent:true,postgresFlags:['-h','127.0.0.1'],onLog:()=>{},onError:()=>{}});
const clients=[],adapter=c=>({exec:s=>c.query(s),query:(s,p)=>c.query(s,p),close:async()=>{}});
try {
 await pg.initialise();await pg.start();
 const a=pg.getPgClient(),b=pg.getPgClient();await a.connect();await b.connect();clients.push(a,b);
 const x=await fixture({database:adapter(a)}),other=adapter(b),{tenant}=await x.business('mcp-owner');
 for(const client of clients){await client.query("set statement_timeout='10s'");await client.query("select set_config('platform.actor_issuer','https://staff.example.test',false)");}
 const invoke=(db,tool,input={})=>call(db,'mcp_invoke','staff','codex-test',tool,input,crypto.randomUUID());
 const {data:{connectionId}}=await invoke(x.db,'crm_get_access');
 const grant=(status,revision)=>call(x.db,'mcp_admin','staff','save',{connectionId,revision,status,permissions:['draft'],businessIds:[tenant]});
 await grant('active',0);
 const payload={businessId:tenant,revision:1,profile:{summary:'Concurrent draft'},idempotencyKey:'concurrent-0001'};
 await a.query('begin');const first=await invoke(x.db,'crm_save_business_profile_draft',payload);assert.equal(first.ok,true,JSON.stringify(first));
 let settled=false;const waiting=invoke(other,'crm_save_business_profile_draft',payload).finally(()=>settled=true);
 await new Promise(r=>setTimeout(r,150));assert.equal(settled,false);await a.query('commit');assert.deepEqual(await waiting,first);
 assert.equal(Number((await a.query('select count(*) n from sms_private.mcp_requests')).rows[0].n),1);
 console.log('PASS concurrent duplicate requests commit once and return the same result');
 await a.query('begin');await grant('disabled',1);
 settled=false;const denied=invoke(other,'crm_save_business_profile_draft',{...payload,revision:2,idempotencyKey:'revoked-0001'}).finally(()=>settled=true);
 await new Promise(r=>setTimeout(r,150));assert.equal(settled,false);await a.query('commit');assert.equal((await denied).error.code,'PERMISSION_DENIED');
 console.log('PASS committed connection disable fences a waiting mutation');
 await grant('active',2);
 await a.query('begin');const temporary=await invoke(x.db,'crm_save_business_profile_draft',{...payload,revision:2,idempotencyKey:'rollback-0001'});assert.equal(temporary.ok,true);
 const retry=invoke(other,'crm_save_business_profile_draft',{...payload,revision:2,idempotencyKey:'rollback-0001'});await a.query('rollback');assert.equal((await retry).ok,true);
 console.log('PASS rolled-back writes leave no idempotency result and a waiting retry succeeds');
 await a.query('begin');await invoke(x.db,'crm_save_business_profile_draft',{...payload,revision:3,idempotencyKey:'edit-00001'});
 const conflict=invoke(other,'crm_save_business_profile_draft',{...payload,revision:3,idempotencyKey:'edit-00002'});await a.query('commit');assert.equal((await conflict).error.code,'CONFLICT');
 console.log('PASS concurrent edits cannot overwrite a newer revision');
}catch(error){console.error(error.message);process.exitCode=1;}finally{await Promise.allSettled(clients.map(c=>c.end()));await pg.stop();}
