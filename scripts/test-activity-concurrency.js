// Disposable real PostgreSQL. Never accepts a production connection string.
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import assert from 'node:assert/strict';
import {call} from '../test/helpers/database.js';
import {setupCoordination,addRun,tenant,phone} from '../test/helpers/coordination.js';
const {default:EmbeddedPostgres}=await import(pathToFileURL(resolve('data/inbound-postgres/node_modules/embedded-postgres/dist/index.js')));
const pg=new EmbeddedPostgres({databaseDir:resolve('data/inbound-postgres/activity-'+Date.now()),user:'postgres',password:crypto.randomUUID(),port:55441,persistent:true,postgresFlags:['-h','127.0.0.1'],onLog:()=>{},onError:()=>{}});
const clients=[],adapter=c=>({exec:s=>c.query(s),query:(s,p)=>c.query(s,p),close:async()=>{}});
try{
 await pg.initialise();await pg.start();const a=pg.getPgClient(),b=pg.getPgClient();await a.connect();await b.connect();clients.push(a,b);
 const db=await setupCoordination({database:adapter(a)}),other=adapter(b),r1=await addRun(db),r2=await addRun(db);
 await a.query("insert into public.sms_bookings(tenant_id,id,contact_id,customer_phone,status,appointment_at) select $1,'shared-booking',id,phone,'confirmed',now()+interval '1 day' from public.sms_contacts where tenant_id=$1 and phone=$2",[tenant,phone]);
 await a.query('begin');await call(db,'automation_activity','admin',tenant,'booking_link',{runId:r1.id,bookingId:'shared-booking',revision:0});
 let done=false;const edit=call(other,'automation_activity','admin',tenant,'booking_link',{runId:r2.id,bookingId:'shared-booking',revision:0}).then(()=>({ok:true}),e=>({error:e.message})).finally(()=>done=true);
 await new Promise(r=>setTimeout(r,120));assert.equal(done,false);await a.query('commit');assert.match((await edit).error,/changed/);
 assert.equal(Number((await a.query('select count(*) n from sms_private.activity_bookings')).rows[0].n),1);
 console.log('PASS: concurrent primary booking links serialize and reject stale edits');
 const out=await call(db,'outbox',tenant,'callback-race',{phone,body:'Interested?',purpose:'marketing'});
 await a.query("update public.sms_messages set meta=meta||jsonb_build_object('form_run_id',$2::text),provider_accepted_at=now() where id=$1",[out.messageId,r1.id]);
 await Promise.all([a.query("update public.sms_messages set status='delivered' where id=$1",[out.messageId]),b.query("update public.sms_messages set status='delivered' where id=$1",[out.messageId])]);
 assert.equal(Number((await a.query("select count(*) n from sms_private.activity_events where event_key=$1",['delivered:'+out.messageId])).rows[0].n),1);
 console.log('PASS: competing duplicate delivery callbacks record one durable event');
 await a.query('begin');await a.query('update public.sms_contacts set opted_out=true where tenant_id=$1 and phone=$2',[tenant,phone]);
 const resume=call(other,'automation_activity','admin',tenant,'sequence',{runId:r1.id,generation:1,operation:'resume'}).then(()=>({ok:true}),e=>({error:e.message}));await a.query('commit');assert.ok((await resume).error);
 console.log('PASS: STOP and resume race cannot re-enable sending');
}catch(e){console.error(e.message);process.exitCode=1;}finally{await Promise.allSettled(clients.map(c=>c.end()));await pg.stop();}
