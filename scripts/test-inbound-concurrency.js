// Uses a disposable local PostgreSQL cluster, never a production database URL.
// Install the optional runtime with:
// npm install --prefix data/inbound-postgres --no-save --package-lock=false embedded-postgres@17.10.0-beta.17
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import assert from 'node:assert/strict';
import {testDatabase,call} from '../test/helpers/database.js';
const {default:EmbeddedPostgres}=await import(pathToFileURL(resolve('data/inbound-postgres/node_modules/embedded-postgres/dist/index.js')));
const pg=new EmbeddedPostgres({databaseDir:resolve('data/inbound-postgres/cluster-'+Date.now()),user:'postgres',password:crypto.randomUUID(),port:55439,persistent:true,
 postgresFlags:['-h','127.0.0.1'],onLog:()=>{},onError:()=>{}});
const tenant='biz-1c0c09ce-819e-4795-86b9-0e457ab92f58';let clients=[];
try {
 await pg.initialise();await pg.start();
 const main=pg.getPgClient();await main.connect();clients.push(main);
 const db={exec:sql=>main.query(sql),query:(sql,args)=>main.query(sql,args),close:async()=>{}};
 await testDatabase({database:db});
 await call(db,'api_action','admin',null,'create_business',{id:tenant,name:'Concurrency fixture',timeZone:'UTC'});
 await db.query("update public.sms_businesses set status='active',sending_enabled=true where tenant_id=$1",[tenant]);
 await db.query("update sms_private.providers set from_number='+18777574365' where tenant_id=$1",[tenant]);
 await db.query("insert into sms_private.inbound_ai_settings(tenant_id,mode,booking_enabled) values($1,'live',true)",[tenant]);
 const hours=Object.fromEntries(Array.from({length:7},(_,i)=>[i,[{start:'09:00',end:'17:00'}]]));
 await call(db,'voice_save_rule','admin',tenant,{service:'junk_removal',market:'Test',resourcePool:'crew',timeZone:'UTC',enabled:true,durationMinutes:60,capacity:1,minimumNoticeMinutes:0,maximumAdvanceDays:90,weeklyAvailability:hours,dateExceptions:[]});
 for(const first of ['voice','sms']) {
  const day=new Date(Date.now()+(first==='voice'?3:4)*86400000).toISOString().slice(0,10),smsPhone='+13035550122',voicePhone='+13035550123';
  const details={service:'junk_removal',name:'Synthetic Customer',address:'123 Test Street',localDate:day,localTime:'10:00',details:{}};
  const sid=crypto.randomUUID(),voiceId='voice-test-'+sid;
  await call(db,'record_webhook',tenant,'inbound',{From:smsPhone,To:'+18005550100',Body:'Book',MessageSid:sid});
  await db.query("update sms_private.jobs set available_at=now() where queue='ai_reply_jobs'");await db.query("update pgmq.test_messages set vt=now() where q='ai_reply_jobs'");
  let job=await call(db,'claim','ai_reply_jobs','test');
  await call(db,'inbound_ai_tool',job.id,job.lease_token,'prepare_booking',details);
  const out=await call(db,'complete_inbound_ai',job.id,job.lease_token,{reply:'unused'});
  await db.query("update public.sms_messages set status='accepted',provider_accepted_at=now() where id=$1",[out.messageId]);
  await call(db,'record_webhook',tenant,'inbound',{From:smsPhone,To:'+18005550100',Body:'YES',MessageSid:crypto.randomUUID()});
  await db.query("update sms_private.jobs set available_at=now() where queue='ai_reply_jobs'");await db.query("update pgmq.test_messages set vt=now() where q='ai_reply_jobs'");
  job=await call(db,'claim','ai_reply_jobs','test');
  await db.query("insert into sms_private.voice_otps(tenant_id,call_id,phone,code_hash,expires_at,verified_at) values($1,$2,$3,$4,now()+interval '5 minutes',now())",[tenant,voiceId,voicePhone,'a'.repeat(64)]);
  const prepared=(await db.query('select voice_booking_api.prepare($1,$2,$3) result',[tenant,voiceId,JSON.stringify({...details,phone:voicePhone})])).rows[0].result;
  const a=pg.getPgClient(),b=pg.getPgClient();await a.connect();await b.connect();clients.push(a,b);
  const voice=client=>client.query('select voice_booking_api.confirm($1,$2,$3) result',[tenant,voiceId,prepared.holdId]);
  const sms=client=>client.query("select sms_private.inbound_ai_tool($1,$2,'confirm_booking','{}') result",[job.id,job.lease_token]);
  await a.query('begin');await b.query('begin');
  const winner=await (first==='voice'?voice:sms)(a);assert.equal(winner.rows[0].result.status,'confirmed');
  let settled=false;const contender=(first==='voice'?sms:voice)(b).then(value=>({value}),error=>({error})).finally(()=>{settled=true;});
  await new Promise(resolve=>setTimeout(resolve,150));assert.equal(settled,false,'Other channel must wait on shared pool lock');
  await a.query('commit');const loser=await contender;
  if(first==='voice') assert.equal(loser.value?.rows[0].result.needsPreparation,true);
  else assert.match(loser.error?.message||'',/no longer available/);
  await b.query('rollback');
  assert.equal(Number((await db.query("select count(*) n from public.sms_bookings where tenant_id=$1 and appointment_at::date=$2",[tenant,day])).rows[0].n),1);
  await call(db,'finish',job.id,job.lease_token,'completed',null,0);
  console.log(first+' wins: concurrent other channel waited, then refused occupied capacity');
 }
 console.log('PASS: PostgreSQL shared-capacity concurrency in both directions');
} catch(error) { console.error(error.message);process.exitCode=1; }
finally {await Promise.allSettled(clients.map(c=>c.end()));await pg.stop();}
