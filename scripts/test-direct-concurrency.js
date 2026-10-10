// Disposable real PostgreSQL; never reads production credentials.
import {resolve} from 'node:path';import {pathToFileURL} from 'node:url';import assert from 'node:assert/strict';
import {call} from '../test/helpers/database.js';import {setupCoordination,queuedForm,tenant,phone} from '../test/helpers/coordination.js';
const {default:EmbeddedPostgres}=await import(pathToFileURL(resolve('data/inbound-postgres/node_modules/embedded-postgres/dist/index.js')));
const pg=new EmbeddedPostgres({databaseDir:resolve('data/inbound-postgres/direct-'+Date.now()),user:'postgres',password:crypto.randomUUID(),port:55442,persistent:true,postgresFlags:['-h','127.0.0.1'],onLog:()=>{},onError:()=>{}});
const clients=[],adapter=c=>({exec:s=>c.query(s),query:(s,p)=>c.query(s,p),close:async()=>{}});
const sequence={trigger:'submission',replyPolicy:'pause',startHour:0,endHour:24,leadHours:24,steps:[{body:'Do you need help?',delayCount:0,delayUnit:'minute',sendCount:2,intervalCount:1,intervalUnit:'day'}]};
try{
 await pg.initialise();await pg.start();const a=pg.getPgClient(),b=pg.getPgClient();await a.connect();await b.connect();clients.push(a,b);await a.query("set statement_timeout='10s'");await b.query("set statement_timeout='10s'");
 const db=await setupCoordination({database:adapter(a)}),other=adapter(b),api=(d,action,p)=>call(d,'contact_automations','admin',tenant,action,p);
 let c=(await a.query('select * from public.sms_contacts where tenant_id=$1 and phone=$2',[tenant,phone])).rows[0];
 const tpl=(await api(db,'publish',{name:'Concurrency',sequence,idempotencyKey:'template'})).template;
 let p={contactId:c.id,contactRevision:c.revision,templateId:tpl.id,templateRevision:tpl.revision,overlaps:[],idempotencyKey:'same-enrollment'};
 const [one,two]=await Promise.all([api(db,'enroll',p),api(other,'enroll',p)]);assert.equal(one.run.id,two.run.id);console.log('PASS concurrent duplicate enrollment creates one run');
 await queuedForm(db);const send=await call(db,'claim','sms_send_jobs','sender');
 await a.query('begin');await api(db,'block',{contactId:c.id,revision:c.revision,blocked:true,idempotencyKey:'stop'});
 let done=false;const pending=call(other,'begin_submission',send.id,send.lease_token).finally(()=>done=true);await new Promise(r=>setTimeout(r,120));assert.equal(done,false);await a.query('commit');assert.equal(await pending,null);
 assert.equal(Number((await a.query('select count(*) n from sms_private.attempts')).rows[0].n),0);console.log('PASS contact stop fences racing final provider submission');
 c=(await api(db,'read',{contactId:c.id})).contact;await api(db,'block',{contactId:c.id,revision:c.revision,blocked:false,idempotencyKey:'allow'});c=(await api(db,'read',{contactId:c.id})).contact;
 await a.query('begin');await api(db,'block',{contactId:c.id,revision:c.revision,blocked:true,idempotencyKey:'block-again'});
 const enrollment=api(other,'enroll',{...p,contactRevision:c.revision,idempotencyKey:'race-enrollment'}).then(()=>({ok:true}),e=>({error:e.message}));await a.query('commit');assert.match((await enrollment).error,/blocked|changed/);console.log('PASS enrollment cannot race past contact block');
 const raw={phone:'+13035550999',name:'Concurrent',source:'staff'};await Promise.all([call(db,'api_action','admin',tenant,'contact',raw),call(other,'api_action','admin',tenant,'contact',{phone:raw.phone,source:'integration'})]);
 const rows=(await a.query('select * from public.sms_contacts where tenant_id=$1 and phone=$2',[tenant,raw.phone])).rows;assert.equal(rows.length,1);assert.equal(rows[0].name,'Concurrent');assert.equal(rows[0].marketing_consent,false);console.log('PASS contact upsert race preserves one identity, name and consent');
}catch(e){console.error(e.message);process.exitCode=1;}finally{await Promise.allSettled(clients.map(c=>c.end()));await pg.stop();}
