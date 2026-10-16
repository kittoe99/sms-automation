// Disposable UTF-8 loopback PostgreSQL. No live database or provider access.
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import assert from 'node:assert/strict';
import {fixture} from '../test/helpers/twilioConnections.js';
import {call} from '../test/helpers/database.js';
const {default:EmbeddedPostgres}=await import(pathToFileURL(resolve('data/inbound-postgres/node_modules/embedded-postgres/dist/index.js')));
const pg=new EmbeddedPostgres({databaseDir:resolve('data/inbound-postgres/mcp-contacts-'+Date.now()),user:'postgres',password:crypto.randomUUID(),port:55459,persistent:true,initdbFlags:['--encoding=UTF8','--locale=C'],postgresFlags:['-h','127.0.0.1'],onLog:()=>{},onError:()=>{}});
const clients=[];
try{
 await pg.initialise();await pg.start();
 const main=pg.getPgClient();await main.connect();clients.push(main);
 const db={exec:s=>main.query(s),query:(s,p)=>main.query(s,p),close:async()=>{}};
 const f=await fixture({database:db}),tenant=(await f.business('contact-races')).tenant;
 const a=pg.getPgClient(),b=pg.getPgClient();for(const c of [a,b]){await c.connect();clients.push(c);await c.query("select set_config('platform.actor_issuer','https://staff.example.test',false)");}
 const invoke=async(client,tool,p,oauth='https://contact-concurrency.test')=>(await client.query('select crm_mcp.invoke($1,$2,$3,$4,$5) r',['staff',oauth,tool,JSON.stringify(p),crypto.randomUUID()])).rows[0].r;
 const grants=['contact_create','contact_edit','consent_opt_in','sms_message_send'];
 for(const oauth of ['https://contact-concurrency.test','https://contact-concurrency.test/other']){
  const id=(await invoke(a,'crm_get_access',{},oauth)).data.connectionId;
  await call(db,'mcp_admin','staff','save',{connectionId:id,revision:0,status:'active',permissions:grants,businessIds:[tenant],allBusinesses:false});
 }
 const p={businessId:tenant,phone:'+17208429167',name:'Synthetic',idempotencyKey:crypto.randomUUID()};
 const pair=await Promise.all([invoke(a,'crm_create_contact',p),invoke(b,'crm_create_contact',p)]);assert.equal(pair[0].ok,true,JSON.stringify(pair));assert.deepEqual(pair[0],pair[1]);const id=pair[0].data.contactId;
 const row=async()=>(await main.query('select * from public.sms_contacts where tenant_id=$1 and id=$2',[tenant,id])).rows[0];
 const payload=async(extra={})=>({businessId:tenant,contactId:id,revision:Number((await row()).revision),idempotencyKey:crypto.randomUUID(),...extra});
 const update=await payload({name:'First'});const competing=await Promise.all([invoke(a,'crm_update_contact',update),invoke(b,'crm_update_contact',{...update,name:'Second',idempotencyKey:crypto.randomUUID()},'https://contact-concurrency.test/other')]);assert.equal(competing.filter(x=>x.ok).length,1);assert.equal(competing.find(x=>!x.ok).error.code,'CONFLICT');
 // A browser insert that does not acquire the MCP coordination lock must survive.
 await a.query('begin');await a.query("insert into public.sms_contacts(tenant_id,phone,name) values($1,'+13035550123','Browser winner')",[tenant]);
 let settled=false;const racing=invoke(b,'crm_create_contact',{...p,phone:'+13035550123',idempotencyKey:crypto.randomUUID()}).finally(()=>{settled=true;});await new Promise(r=>setTimeout(r,100));assert.equal(settled,false);await a.query('commit');assert.equal((await racing).error.code,'CONFLICT');assert.equal((await main.query("select name from public.sms_contacts where tenant_id=$1 and phone='+13035550123'",[tenant])).rows[0].name,'Browser winner');
 await call(db,'platform_action','staff','service_add',{tenantId:tenant,kind:'sms'});
 await main.query("update public.sms_businesses set status='active',sending_enabled=true where tenant_id=$1",[tenant]);
 await main.query("update sms_private.providers set provisioning_state='configured',account_sid='AC'||repeat('1',32),from_number='+18775550180',auth_secret_id=vault.create_secret('SYNTHETIC') where tenant_id=$1",[tenant]);await main.query('insert into vault.secrets(id) select auth_secret_id from sms_private.providers where tenant_id=$1',[tenant]);
 await main.query('update public.sms_contacts set marketing_consent=true where tenant_id=$1 and id=$2',[tenant,id]);
 const count=async()=>Number((await main.query("select count(*) n from sms_private.jobs where queue='sms_send_jobs'")).rows[0].n);
 const send=await payload({body:'Synthetic concurrency message'});const sent=await Promise.all([invoke(a,'crm_send_contact_sms',send),invoke(b,'crm_send_contact_sms',send)]);assert.equal(sent[0].ok,true,JSON.stringify(sent));assert.deepEqual(sent[0],sent[1]);assert.equal(await count(),1);
 const stale=await payload({body:'Must not send'});await a.query('begin');await a.query('update public.sms_contacts set opted_out=true where tenant_id=$1 and id=$2',[tenant,id]);const blocked=invoke(b,'crm_send_contact_sms',stale);await a.query('commit');assert.equal((await blocked).error.code,'CONFLICT');assert.equal((await invoke(b,'crm_send_contact_sms',await payload({body:'Denied'}))).error.code,'PERMISSION_DENIED');assert.equal(await count(),1);
 await main.query('update public.sms_contacts set opted_out=false where tenant_id=$1 and id=$2',[tenant,id]);const retry=await payload({body:'Rollback'});await a.query('begin');assert.equal((await invoke(a,'crm_send_contact_sms',retry)).ok,true);await a.query('rollback');assert.equal(await count(),1);assert.equal((await invoke(b,'crm_send_contact_sms',retry)).ok,true);assert.equal(await count(),2);
 assert.equal(Number((await main.query('select count(*) n from sms_private.attempts')).rows[0].n),0);
 console.log('PASS: identical retries, competing revisions, browser create race, consent race, interrupted rollback; no provider submissions.');
}catch(e){console.error(e);process.exitCode=1;}finally{await Promise.allSettled(clients.map(c=>c.end()));await pg.stop();}
