// Disposable loopback PostgreSQL only; never contacts a provider or live database.
// Optional runtime setup matches test-inbound-concurrency.js.
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import assert from 'node:assert/strict';
import {fixture} from '../test/helpers/twilioConnections.js';
import {call} from '../test/helpers/database.js';
const {default:EmbeddedPostgres}=await import(pathToFileURL(resolve('data/inbound-postgres/node_modules/embedded-postgres/dist/index.js')));
const pg=new EmbeddedPostgres({databaseDir:resolve('data/inbound-postgres/conversation-mark-read-'+Date.now()),user:'postgres',password:crypto.randomUUID(),port:55451,persistent:true,initdbFlags:['--encoding=UTF8','--locale=C'],postgresFlags:['-h','127.0.0.1'],onLog:()=>{},onError:()=>{}});
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
 const invoke=async(client,p,tool='crm_mark_conversation_messages_read')=>(await client.query('select crm_mcp.invoke($1,$2,$3,$4,$5) r',['staff','https://test.example/mark-concurrency',tool,JSON.stringify(p),crypto.randomUUID()])).rows[0].r;
 const connection=(await invoke(main,{},'crm_get_access')).data.connectionId;
 await call(db,'mcp_admin','staff','save',{connectionId:connection,revision:0,status:'active',permissions:['conversation_mark_read'],businessIds:[tenant],allBusinesses:false});
 const revision=async()=>Number((await main.query('select revision from public.sms_conversations where id=$1',[cid])).rows[0].revision);
 const payload=async(id)=>({businessId:tenant,conversationId:cid,revision:await revision(),messageIds:[id],idempotencyKey:crypto.randomUUID()});
 const readAt=async(id)=>(await main.query('select read_at from public.sms_messages where id=$1',[id])).rows[0].read_at;
 let p=await payload(ids[0]);const simultaneous=await Promise.all([invoke(a,p),invoke(b,p)]);
 assert.ok(simultaneous.every(r=>r.ok),JSON.stringify(simultaneous));assert.deepEqual(simultaneous[0],simultaneous[1]);assert.equal(await revision(),p.revision+1);
 assert.equal(Number((await main.query('select count(*) n from sms_private.mcp_requests where idempotency_key=$1',[p.idempotencyKey])).rows[0].n),1);
 console.log('PASS concurrent same-key retries commit one change and return identical receipts');

 p=await payload(ids[1]);const competing=await Promise.all([invoke(a,p),invoke(b,{...p,idempotencyKey:crypto.randomUUID()})]);
 assert.equal(competing.filter(r=>r.ok).length,1);assert.equal(competing.find(r=>!r.ok).error.code,'CONFLICT');
 console.log('PASS competing edits with the same revision produce one success and one conflict');

 p=await payload(ids[2]);await a.query('begin');await a.query('select id from public.sms_messages where id=$1 for update',[ids[2]]);
 const locked=await invoke(b,p);assert.equal(locked.error?.code,'TEMPORARY_FAILURE');assert.equal(locked.error.retryable,true);assert.equal(await readAt(ids[2]),null);assert.equal(await revision(),p.revision);
 await a.query('commit');assert.equal((await invoke(b,p)).ok,true);
 console.log('PASS message contention fails safely without deadlock and identical retry succeeds');

 p=await payload(ids[3]);await a.query('begin');await a.query("update public.sms_messages set body='Worker update' where id=$1",[ids[3]]);
 let settled=false;const stale=invoke(b,p).finally(()=>{settled=true;});await new Promise(r=>setTimeout(r,100));assert.equal(settled,false);await a.query('commit');
 assert.equal((await stale).error.code,'CONFLICT');assert.equal(await readAt(ids[3]),null);
 console.log('PASS worker commits invalidate waiting mark-read requests');

 p=await payload(ids[4]);await a.query('begin');const receipt=await invoke(a,p);assert.equal(receipt.ok,true);
 settled=false;const incoming=insert(b).finally(()=>{settled=true;});await new Promise(r=>setTimeout(r,100));assert.equal(settled,false);
 await a.query('commit');const incomingId=(await incoming).rows[0].id;assert.equal(await readAt(incomingId),null);assert.ok(await readAt(ids[4]));
 assert.deepEqual((await invoke(main,p)).data,receipt.data);
 console.log('PASS inbound arrival after selection remains unread; delayed retry returns original receipt');
 assert.equal(Number((await main.query("select count(*) n from sms_private.jobs where queue='sms_send_jobs'")).rows[0].n),0);
 console.log('PASS no SMS jobs created or provider called');
}catch(error){console.error(error);process.exitCode=1;}
finally{await Promise.allSettled(clients.map(c=>c.end()));await pg.stop();}
