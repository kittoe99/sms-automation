// Disposable loopback PostgreSQL only; never contacts a provider or live database.
// Optional runtime setup matches test-inbound-concurrency.js.
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import assert from 'node:assert/strict';
import {fixture} from '../test/helpers/twilioConnections.js';
import {call} from '../test/helpers/database.js';
const {default:EmbeddedPostgres}=await import(pathToFileURL(resolve('data/inbound-postgres/node_modules/embedded-postgres/dist/index.js')));
const pg=new EmbeddedPostgres({databaseDir:resolve('data/inbound-postgres/conversation-reply-preview-'+Date.now()),user:'postgres',password:crypto.randomUUID(),port:55453,persistent:true,initdbFlags:['--encoding=UTF8','--locale=C'],postgresFlags:['-h','127.0.0.1'],onLog:()=>{},onError:()=>{}});
const clients=[];
try{
 await pg.initialise();await pg.start();
 const main=pg.getPgClient();await main.connect();clients.push(main);
 const db={exec:s=>main.query(s),query:(s,p)=>main.query(s,p),close:async()=>{}};
 const f=await fixture({database:db}),tenant=(await f.business('mark-concurrency')).tenant;
 await call(db,'platform_action','staff','service_add',{tenantId:tenant,kind:'sms'});
 await db.query("insert into public.sms_contacts(tenant_id,phone) values($1,'+17208429167')",[tenant]);
 const cid=await call(db,'ensure_conversation',tenant,'+17208429167',null);
 const insert=client=>client.query("insert into public.sms_messages(tenant_id,contact_phone,conversation_id,direction,body,status) values($1,'+17208429167',$2,'inbound','Synthetic','received') returning id",[tenant,cid]);
 const ids=[];for(let i=0;i<5;i++)ids.push((await insert(main)).rows[0].id);
 const a=pg.getPgClient(),b=pg.getPgClient();await a.connect();await b.connect();clients.push(a,b);
 for(const client of [a,b])await client.query("select set_config('platform.actor_issuer','https://staff.example.test',false);set statement_timeout='10s'");
 const invoke=async(client,p,tool='crm_preview_conversation_reply')=>(await client.query('select crm_mcp.invoke($1,$2,$3,$4,$5) r',['staff','https://test.example/mark-concurrency',tool,JSON.stringify(p),crypto.randomUUID()])).rows[0].r;
 const connection=(await invoke(main,{},'crm_get_access')).data.connectionId;
 await call(db,'mcp_admin','staff','save',{connectionId:connection,revision:0,status:'active',permissions:['conversation_reply'],businessIds:[tenant],allBusinesses:false});
 const revision=async()=>Number((await main.query('select revision from public.sms_conversations where id=$1',[cid])).rows[0].revision);
 const payload=async(id)=>({businessId:tenant,conversationId:cid,revision:await revision(),body:'Synthetic preview'});
 const readAt=async(id)=>(await main.query('select read_at from public.sms_messages where id=$1',[id])).rows[0].read_at;

 const p=await payload();await a.query('begin');
 await a.query('update public.sms_contacts set opted_out=true where tenant_id=$1',[tenant]);
 let settled=false;const pending=invoke(b,p).finally(()=>{settled=true;});
 await new Promise(r=>setTimeout(r,100));assert.equal(settled,false);await a.query('commit');
 assert.equal((await pending).error.code,'CONFLICT');
 console.log('PASS preview waits for concurrent consent update and rejects stale revision');
 const current=await payload(),before=await main.query('select to_jsonb(c) value from public.sms_conversations c where id=$1',[cid]);
 const results=await Promise.all([invoke(a,current),invoke(b,current)]);
 assert.ok(results.every(r=>r.ok));assert.deepEqual(results[0],results[1]);assert.ok(results[0].data.blockers.includes('CONTACT_OPTED_OUT'));
 assert.deepEqual((await main.query('select to_jsonb(c) value from public.sms_conversations c where id=$1',[cid])).rows,before.rows);
 assert.equal(Number((await main.query('select count(*) n from public.sms_messages where read_at is not null')).rows[0].n),0);
 assert.equal(Number((await main.query('select count(*) n from sms_private.mcp_requests')).rows[0].n),0);
 console.log('PASS concurrent previews leave revision, AI state, read state and receipts unchanged');
 assert.equal(Number((await main.query("select count(*) n from sms_private.jobs where queue='sms_send_jobs'")).rows[0].n),0);
 console.log('PASS no SMS jobs created or provider called');
}catch(error){console.error(error);process.exitCode=1;}
finally{await Promise.allSettled(clients.map(c=>c.end()));await pg.stop();}
