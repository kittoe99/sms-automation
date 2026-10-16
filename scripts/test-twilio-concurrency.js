// Disposable local PostgreSQL only; never reads production credentials.
// Uses the optional embedded-postgres runtime documented in test-inbound-concurrency.js.
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import assert from 'node:assert/strict';
import {fixture,selection} from '../test/helpers/twilioConnections.js';
import {call} from '../test/helpers/database.js';
const {default:EmbeddedPostgres}=await import(pathToFileURL(resolve('data/inbound-postgres/node_modules/embedded-postgres/dist/index.js')));
const pg=new EmbeddedPostgres({databaseDir:resolve('data/inbound-postgres/twilio-'+Date.now()),user:'postgres',password:crypto.randomUUID(),port:55443,persistent:true,initdbFlags:['--encoding=UTF8','--locale=C'],postgresFlags:['-h','127.0.0.1'],onLog:()=>{},onError:()=>{}});
const clients=[],adapter=c=>({exec:s=>c.query(s),query:(s,p)=>c.query(s,p),close:async()=>{}});
try {
 await pg.initialise();await pg.start();
 const a=pg.getPgClient(),b=pg.getPgClient();await a.connect();await b.connect();clients.push(a,b);
 const x=await fixture({database:adapter(a)}),other=adapter(b);
 await b.query("select set_config('platform.actor_issuer','https://staff.example.test',false)");
 await a.query("set statement_timeout='10s'");await b.query("set statement_timeout='10s'");
 const one=await x.business('first'),two=await x.business('second');
 const reserve=(db,t,s)=>call(db,'reserve_twilio_connection','staff',t,s);
 // Different transactions, same account AND same sender: exactly one wins.
 await a.query('begin');await reserve(x.db,one.tenant,selection);
 let settled=false;
 const competing=reserve(other,two.tenant,selection).then(()=>({ok:true}),e=>({error:e.message})).finally(()=>settled=true);
 await new Promise(r=>setTimeout(r,150));assert.equal(settled,false);await a.query('commit');
 assert.match((await competing).error,/already assigned or reserved/);
 console.log('PASS concurrent reservation waits and rejects a committed conflicting owner');
 const second={...selection,phoneNumber:'+18775550181',phoneNumberSid:'PN'+'6'.repeat(32),messagingServiceSid:'MG'+'7'.repeat(32)};
 await reserve(other,two.tenant,second);
 assert.equal(Number((await a.query('select count(*) n from sms_private.twilio_connection_requests')).rows[0].n),2);
 console.log('PASS independent senders can reserve the same Twilio account');
 // Cross-table collision: a worker assigning a provider cannot steal a reservation.
 const third=await x.business('third');
 await a.query('begin');
 const fresh={...selection,phoneNumber:'+18775550182',phoneNumberSid:'PN'+'8'.repeat(32),messagingServiceSid:'MG'+'8'.repeat(32)};
 await reserve(x.db,third.tenant,fresh);
 const worker=b.query('update sms_private.providers set from_number=$1 where tenant_id=$2',[fresh.phoneNumber,two.tenant]).then(()=>({ok:true}),e=>({error:e.message}));
 await a.query('commit');assert.match((await worker).error,/already assigned or reserved/);
 console.log('PASS provider writes cannot race past an in-flight reservation');
 const fourth=await x.business('fourth'),fifth=await x.business('fifth');
 const last={...selection,phoneNumber:'+18775550183',phoneNumberSid:'PN'+'9'.repeat(32),messagingServiceSid:'MG'+'9'.repeat(32)};
 await a.query('begin');await reserve(x.db,fourth.tenant,last);
 const retry=reserve(other,fifth.tenant,last);await a.query('rollback');await retry;
 console.log('PASS rollback releases ownership for a waiting reservation');
} catch(error){console.error(error);process.exitCode=1;}
finally {await Promise.allSettled(clients.map(c=>c.end()));await pg.stop();}
