// Disposable loopback PostgreSQL only; never contacts a provider or live database.
// Optional runtime setup matches test-inbound-concurrency.js.
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import assert from 'node:assert/strict';
import {fixture} from '../test/helpers/twilioConnections.js';
import {call} from '../test/helpers/database.js';
const {default:EmbeddedPostgres}=await import(pathToFileURL(resolve('data/inbound-postgres/node_modules/embedded-postgres/dist/index.js')));
const pg=new EmbeddedPostgres({databaseDir:resolve('data/inbound-postgres/conversation-reply-'+Date.now()),user:'postgres',password:crypto.randomUUID(),port:55455,persistent:true,initdbFlags:['--encoding=UTF8','--locale=C'],postgresFlags:['-h','127.0.0.1'],onLog:()=>{},onError:()=>{}});
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
 const invoke=async(client,p,tool='crm_reply_to_conversation')=>(await client.query('select crm_mcp.invoke($1,$2,$3,$4,$5) r',['staff','https://test.example/mark-concurrency',tool,JSON.stringify(p),crypto.randomUUID()])).rows[0].r;
 const connection=(await invoke(main,{},'crm_get_access')).data.connectionId;
 await call(db,'mcp_admin','staff','save',{connectionId:connection,revision:0,status:'active',permissions:['conversation_reply'],businessIds:[tenant],allBusinesses:false});
 const revision=async()=>Number((await main.query('select revision from public.sms_conversations where id=$1',[cid])).rows[0].revision);
 const payload=async(id)=>({businessId:tenant,conversationId:cid,revision:await revision(),body:'Synthetic reply',idempotencyKey:crypto.randomUUID()});
 const readAt=async(id)=>(await main.query('select read_at from public.sms_messages where id=$1',[id])).rows[0].read_at;

 await main.query("update public.sms_businesses set status='active',sending_enabled=true where tenant_id=$1",[tenant]);
 await main.query("update sms_private.providers set provisioning_state='configured',account_sid='AC'||repeat('1',32),from_number='+18775550180',auth_secret_id=vault.create_secret('SYNTHETIC SECRET') where tenant_id=$1",[tenant]);
 await main.query('insert into vault.secrets(id) select auth_secret_id from sms_private.providers where tenant_id=$1',[tenant]);
 const count=async()=>Number((await main.query("select count(*) n from sms_private.jobs where queue='sms_send_jobs'")).rows[0].n);
 let p=await payload();const simultaneous=await Promise.all([invoke(a,p),invoke(b,p)]);
 assert.ok(simultaneous.every(r=>r.ok),JSON.stringify(simultaneous));assert.deepEqual(simultaneous[0],simultaneous[1]);assert.equal(await count(),1);
 console.log('PASS concurrent identical replies create one message/job/receipt');
 p=await payload();const competing=await Promise.all([invoke(a,p),invoke(b,{...p,idempotencyKey:crypto.randomUUID()})]);
 assert.equal(competing.filter(r=>r.ok).length,1);assert.equal(competing.find(r=>!r.ok).error.code,'CONFLICT');assert.equal(await count(),2);
 console.log('PASS competing reply revisions produce one success and one conflict');
 for(const table of ['public.sms_contacts','sms_private.providers']){
  p=await payload();const before=await count();await a.query('begin');await a.query('select tenant_id from '+table+' where tenant_id=$1 for update',[tenant]);
  const r=await invoke(b,p);assert.equal(r.error?.code,'TEMPORARY_FAILURE');assert.equal(await count(),before);await a.query('commit');assert.equal((await invoke(b,p)).ok,true);
 }
 console.log('PASS consent/provider contention safely rolls back and same-key retry succeeds');
 p=await payload();await a.query('begin');await a.query('update public.sms_contacts set opted_out=true where tenant_id=$1',[tenant]);
 let settled=false;const stale=invoke(b,p).finally(()=>{settled=true;});await new Promise(r=>setTimeout(r,100));assert.equal(settled,false);await a.query('commit');assert.equal((await stale).error.code,'CONFLICT');
 assert.equal((await invoke(b,await payload())).error.code,'PERMISSION_DENIED');await main.query('update public.sms_contacts set opted_out=false where tenant_id=$1',[tenant]);
 console.log('PASS concurrent opt-out invalidates revision and blocks fresh reply');
 p=await payload();const before=await count();await a.query('begin');assert.equal((await invoke(a,p)).ok,true);await a.query('rollback');assert.equal(await count(),before);assert.equal((await invoke(b,p)).ok,true);
 console.log('PASS interrupted transaction rolls back and identical retry creates one job');
 assert.equal(Number((await main.query('select count(*) n from sms_private.attempts')).rows[0].n),0);
 assert.equal(Number((await main.query('select count(*) n from public.sms_messages where provider_accepted_at is not null or read_at is not null')).rows[0].n),0);
 console.log('PASS no provider calls, accepted messages, read marks or SMS delivery');
}catch(error){console.error(error);process.exitCode=1;}
finally{await Promise.allSettled(clients.map(c=>c.end()));await pg.stop();}
