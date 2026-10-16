// Disposable loopback PostgreSQL only. Never reads a deployment connection URL.
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import assert from 'node:assert/strict';
import {testDatabase,call} from '../test/helpers/database.js';
const {default:EmbeddedPostgres}=await import(pathToFileURL(resolve('data/inbound-postgres/node_modules/embedded-postgres/dist/index.js')));
const pg=new EmbeddedPostgres({databaseDir:resolve('data/inbound-postgres/lead-revisions-'+Date.now()),user:'postgres',password:crypto.randomUUID(),port:55442,persistent:true,initdbFlags:['--encoding=UTF8','--locale=C'],postgresFlags:['-h','127.0.0.1'],onLog:()=>{},onError:()=>{}});
const clients=[],adapter=c=>({exec:s=>c.query(s),query:(s,p)=>c.query(s,p),close:async()=>{}});
try{
 await pg.initialise();await pg.start();const a=pg.getPgClient(),b=pg.getPgClient();await a.connect();await b.connect();clients.push(a,b);
 await testDatabase({database:adapter(a)});const db=adapter(a),other=adapter(b),tenant='revision-race';
 await call(db,'api_action','admin',null,'create_business',{id:tenant,name:'Revision race',timeZone:'UTC'});
 const cid=(await a.query("insert into public.sms_contacts(tenant_id,phone) values($1,'+17208429167') returning id",[tenant])).rows[0].id;
 const lead=(await a.query('insert into public.sms_leads(tenant_id,contact_id) values($1,$2) returning id',[tenant,cid])).rows[0].id;
 const job=(await a.query("insert into sms_private.jobs(tenant_id,queue,dedupe_key,payload) values($1,'ai_reply_jobs','test','{}') returning id",[tenant])).rows[0].id;
 const handoff=(await a.query("insert into public.sms_handoffs(tenant_id,contact_id,ai_job_id,reason) values($1,$2,$3,'Test') returning id",[tenant,cid,job])).rows[0].id;
 const edit=(connection,resource,id,revision,status)=>call(connection,'update_lead_handoff','admin',tenant,resource,id,{revision,status});
 for(const [resource,id,table,field] of [['lead',lead,'sms_leads','summary'],['handoff',handoff,'sms_handoffs','reason']]){
  await a.query('begin');await edit(db,resource,id,1,'assigned');let done=false;
  const second=edit(other,resource,id,1,'closed').then(()=>({ok:true}),e=>({code:e.code})).finally(()=>done=true);
  await new Promise(r=>setTimeout(r,120));assert.equal(done,false);await a.query('commit');assert.equal((await second).code,'40001');
  await a.query('begin');await a.query(`update public.${table} set ${field}='worker changed' where id=$1`,[id]);done=false;
  const stale=edit(other,resource,id,2,'closed').then(()=>({ok:true}),e=>({code:e.code})).finally(()=>done=true);
  await new Promise(r=>setTimeout(r,120));assert.equal(done,false);await a.query('commit');assert.equal((await stale).code,'40001');
  const current=(await a.query(`select * from public.${table} where id=$1`,[id])).rows[0];assert.equal(Number(current.revision),3);assert.equal(current.status,'assigned');
  await edit(other,resource,id,3,'closed');assert.equal(Number((await a.query(`select revision from public.${table} where id=$1`,[id])).rows[0].revision),4);
  console.log(`PASS ${resource}: competing staff edits and worker/staff race reject stale revisions; fresh revision succeeds`);
 }
 assert.equal(Number((await a.query('select count(*) n from public.sms_messages')).rows[0].n),0);
 assert.equal(Number((await a.query("select count(*) n from sms_private.jobs where queue in ('sms_send_jobs','handoff_alert_jobs')")).rows[0].n),0);
 console.log('PASS no SMS or alert jobs created');
}catch(e){console.error(e.message);process.exitCode=1;}finally{await Promise.allSettled(clients.map(c=>c.end()));await pg.stop();}
