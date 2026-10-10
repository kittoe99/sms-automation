// Disposable local PostgreSQL only; shares the optional runtime installation with
// test-inbound-concurrency.js. No production connection strings are accepted.
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import assert from 'node:assert/strict';
import {call} from '../test/helpers/database.js';
import {setupCoordination,addRun,incoming,invoke,queuedForm,tenant,phone} from '../test/helpers/coordination.js';
const {default:EmbeddedPostgres}=await import(pathToFileURL(resolve('data/inbound-postgres/node_modules/embedded-postgres/dist/index.js')));
const pg=new EmbeddedPostgres({databaseDir:resolve('data/inbound-postgres/coordination-'+Date.now()),user:'postgres',password:crypto.randomUUID(),port:55440,persistent:true,postgresFlags:['-h','127.0.0.1'],onLog:()=>{},onError:()=>{}});
const clients=[];
const adapter=c=>({exec:s=>c.query(s),query:(s,p)=>c.query(s,p),close:async()=>{}});
try {
 await pg.initialise();await pg.start();
 const a=pg.getPgClient(),b=pg.getPgClient();await a.connect();await b.connect();clients.push(a,b);
 const db=await setupCoordination({database:adapter(a)}),other=adapter(b);
 const run=await addRun(db);await queuedForm(db);
 let send=await call(db,'claim','sms_send_jobs','sender');
 await a.query('begin');
 await call(db,'record_webhook',tenant,'inbound',{From:phone,To:'+18005550100',Body:'I have a question',MessageSid:'concurrent-inbound'});
 let settled=false;
 const waiting=call(other,'begin_submission',send.id,send.lease_token).finally(()=>{settled=true;});
 await new Promise(r=>setTimeout(r,150));assert.equal(settled,false,'Sender waits for inbound transaction');
 await a.query('commit');assert.equal(await waiting,null);
 assert.equal(Number((await a.query('select count(*) n from sms_private.attempts')).rows[0].n),0);
 console.log('PASS: inbound vs queued sender serializes and defers before any attempt');

 // Duplicate webhook and expired lease recovery must not duplicate work.
 await call(db,'record_webhook',tenant,'inbound',{From:phone,To:'+18005550100',Body:'I have a question',MessageSid:'concurrent-inbound'});
 assert.equal(Number((await a.query("select count(*) n from sms_private.jobs where queue='ai_reply_jobs'")).rows[0].n),1);
 await a.query("update sms_private.jobs set available_at=now() where queue='ai_reply_jobs'");await a.query("update pgmq.test_messages set vt=now() where q='ai_reply_jobs'");
 let job=await call(db,'claim','ai_reply_jobs','first');
 await a.query("update sms_private.jobs set leased_until=now()-interval '1 second' where id=$1",[job.id]);await a.query("update pgmq.test_messages set vt=now() where q='ai_reply_jobs'");
 const recovered=await call(db,'claim','ai_reply_jobs','recovery');assert.equal(recovered.id,job.id);assert.notEqual(recovered.lease_token,job.lease_token);
 await assert.rejects(()=>invoke(db,job,'lookup_bookings'),/Lease lost/);
 await call(db,'finish',recovered.id,recovered.lease_token,'completed');
 console.log('PASS: duplicate webhook and lease recovery retain one job and fence stale lease');

 job=await incoming(db,'No thanks, not interested');
 await a.query('update sms_private.jobs set available_at=now() where id=$1',[send.id]);await a.query('update pgmq.test_messages set vt=now() where id=$1',[send.queue_msg_id]);
 send=await call(db,'claim','sms_send_jobs','sender-retry');
 await a.query('begin');const closure=await invoke(db,job,'close_enquiry',{requestRef:run.id,declineQuote:'not interested'});
 assert.equal(closure.coordination.reason,'AI_DECLINED');settled=false;
 const race=call(other,'begin_submission',send.id,send.lease_token).finally(()=>{settled=true;});
 await new Promise(r=>setTimeout(r,150));assert.equal(settled,false,'Sender waits for outcome transaction');
 await a.query('commit');assert.equal(await race,null);
 assert.equal((await a.query('select status from sms_private.jobs where id=$1',[send.id])).rows[0].status,'cancelled');
 assert.equal(Number((await a.query('select count(*) n from sms_private.attempts')).rows[0].n),0);
 console.log('PASS: committed enquiry closure invalidates a racing queued send');
} catch(error) {console.error(error.message);process.exitCode=1;}
finally {await Promise.allSettled(clients.map(c=>c.end()));await pg.stop();}
