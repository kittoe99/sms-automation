// Disposable loopback PostgreSQL only; no provider, remote URL or live data.
// Uses the optional embedded-postgres runtime documented by test-inbound-concurrency.js.
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import assert from 'node:assert/strict';
import {fixture} from '../test/helpers/twilioConnections.js';
import {call} from '../test/helpers/database.js';
const {default:EmbeddedPostgres}=await import(pathToFileURL(resolve('data/inbound-postgres/node_modules/embedded-postgres/dist/index.js')));
const pg=new EmbeddedPostgres({databaseDir:resolve('data/inbound-postgres/conversation-revisions-'+Date.now()),user:'postgres',password:crypto.randomUUID(),port:55449,persistent:true,initdbFlags:['--encoding=UTF8','--locale=C'],postgresFlags:['-h','127.0.0.1'],onLog:()=>{},onError:()=>{}});
const clients=[];
try{
 await pg.initialise();await pg.start();
 const main=pg.getPgClient();await main.connect();clients.push(main);
 const db={exec:s=>main.query(s),query:(s,p)=>main.query(s,p),close:async()=>{}};
 const f=await fixture({database:db}),tenant=(await f.business('concurrency')).tenant;
 await call(db,'platform_action','staff','service_add',{tenantId:tenant,kind:'sms'});
 await db.query("insert into public.sms_contacts(tenant_id,phone,name) values($1,'+17208429167','Synthetic')",[tenant]);
 const cid=await call(db,'ensure_conversation',tenant,'+17208429167',null);
 const ids=[];
 for(let i=0;i<2;i++)ids.push((await db.query("insert into public.sms_messages(tenant_id,contact_phone,conversation_id,direction,body,status) values($1,'+17208429167',$2,'outbound','Synthetic','queued') returning id",[tenant,cid])).rows[0].id);
 const a=pg.getPgClient(),b=pg.getPgClient();await a.connect();await b.connect();clients.push(a,b);
 for(const c of [a,b])await c.query("select set_config('platform.actor_issuer','https://staff.example.test',false)");
 const revision=async()=>Number((await main.query('select revision from public.sms_conversations where id=$1',[cid])).rows[0].revision);
 const guard=(client,expected)=>client.query('select sms_private.lock_conversation_revision($1,$2,$3,$4::jsonb)',['staff',tenant,cid,String(expected)]);
 let before=await revision();await a.query('begin');await b.query('begin');
 await a.query("update public.sms_messages set body='Worker edit' where id=$1",[ids[0]]);
 let settled=false;const stale=guard(b,before).then(value=>({value}),error=>({error})).finally(()=>{settled=true;});
 await new Promise(resolve=>setTimeout(resolve,150));assert.equal(settled,false,'Revision check must wait for uncommitted worker edit');
 await a.query('commit');assert.equal((await stale).error?.code,'40001');await b.query('rollback');
 console.log('PASS stale revision waits for worker commit and conflicts');

 before=await revision();await a.query('begin');await b.query('begin');
 await a.query("update public.sms_messages set body='Worker A' where id=$1",[ids[0]]);
 settled=false;const update=b.query("update public.sms_messages set body='Worker B' where id=$1",[ids[1]]).finally(()=>{settled=true;});
 await new Promise(resolve=>setTimeout(resolve,150));assert.equal(settled,false);await a.query('commit');await update;await b.query('commit');assert.equal(await revision(),before+2);
 console.log('PASS independent worker updates serialize revision increments without lost updates');

 before=await revision();await a.query('begin');await guard(a,before);await a.query("update public.sms_messages set read_at=clock_timestamp() where id=$1",[ids[0]]);await a.query('rollback');assert.equal(await revision(),before);
 assert.equal((await main.query('select read_at from public.sms_messages where id=$1',[ids[0]])).rows[0].read_at,null);
 console.log('PASS protected operation rollback restores message and revision');

 // A detail reader pins the revision while it reads metadata and the page.
 await a.query('begin');await a.query('select id from public.sms_conversations where id=$1 for share',[cid]);await b.query('begin');
 settled=false;const duringRead=b.query("update public.sms_messages set status='failed' where id=$1",[ids[1]]).finally(()=>{settled=true;});
 await new Promise(resolve=>setTimeout(resolve,150));assert.equal(settled,false);assert.equal((await a.query('select status from public.sms_messages where id=$1',[ids[1]])).rows[0].status,'queued');
 await a.query('commit');await duringRead;await b.query('commit');assert.ok(await revision()>before);
 console.log('PASS detail snapshot pins parent revision until related writer can commit');
 assert.equal(Number((await main.query("select count(*) n from sms_private.jobs where queue='sms_send_jobs'")).rows[0].n),0);
 console.log('PASS no SMS jobs created; no provider called');
}catch(error){console.error(error.message);process.exitCode=1;}
finally{await Promise.allSettled(clients.map(c=>c.end()));await pg.stop();}
