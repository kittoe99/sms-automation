// Disposable local PostgreSQL. No provider access or production data.
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import assert from 'node:assert/strict';
import {fixture} from '../test/helpers/twilioConnections.js';
import {call} from '../test/helpers/database.js';
import {bookingPermissions} from '../src/mcp/bookingSchemas.js';
const {default:EmbeddedPostgres}=await import(pathToFileURL(resolve('data/inbound-postgres/node_modules/embedded-postgres/dist/index.js')));
const pg=new EmbeddedPostgres({databaseDir:resolve('data/inbound-postgres/mcp-bookings-'+Date.now()),user:'postgres',password:crypto.randomUUID(),port:55462,persistent:true,initdbFlags:['--encoding=UTF8','--locale=C'],postgresFlags:['-h','127.0.0.1'],onLog:()=>{},onError:()=>{}});
const clients=[];
try{
 await pg.initialise();await pg.start();
 const main=pg.getPgClient();await main.connect();clients.push(main);
 const db={exec:s=>main.query(s),query:(s,p)=>main.query(s,p),close:async()=>{}};
 const f=await fixture({database:db}),tenant=(await f.business('booking-races')).tenant,phone='+17208429167';
 const a=pg.getPgClient(),b=pg.getPgClient();for(const c of [a,b]){await c.connect();clients.push(c);await c.query("select set_config('platform.actor_issuer','https://staff.example.test',false)");await c.query("set statement_timeout='8s'");}
 const invoke=async(client,tool,p,oauth='https://booking-concurrency.test')=>(await client.query('select crm_mcp.invoke($1,$2,$3,$4,$5) r',['staff',oauth,tool,JSON.stringify(p),crypto.randomUUID()])).rows[0].r;
 for(const oauth of ['https://booking-concurrency.test','https://booking-concurrency.test/other']){
  const id=(await invoke(a,'crm_get_access',{},oauth)).data.connectionId;
  await call(db,'mcp_admin','staff','save',{connectionId:id,revision:0,status:'active',permissions:bookingPermissions.map(x=>x[0]).concat('contact_edit'),businessIds:[tenant],allBusinesses:false});
 }
 await call(db,'platform_action','staff','service_add',{tenantId:tenant,kind:'sms'});
 await main.query('insert into public.sms_contacts(tenant_id,phone) values($1,$2)',[tenant,phone]);
 const cfg={service:'junk_removal',market:'Denver',resourcePool:'crew',timeZone:'America/Denver',durationMinutes:60,capacity:1,minimumNoticeMinutes:0,maximumAdvanceDays:90,weeklyAvailability:Object.fromEntries(Array.from({length:7},(_,i)=>[i,[]])),dateExceptions:[]};
 const p={businessId:tenant,configuration:cfg,idempotencyKey:crypto.randomUUID()};
 const pair=await Promise.all([invoke(a,'crm_create_booking_schedule',p),invoke(b,'crm_create_booking_schedule',p)]);assert.equal(pair[0].ok,true,JSON.stringify(pair));assert.deepEqual(pair[0],pair[1]);const id=pair[0].data.scheduleId;
 const edit={businessId:tenant,scheduleId:id,revision:1,configuration:{...cfg,capacity:2},idempotencyKey:crypto.randomUUID()};
 await a.query('begin');await call({query:(q,p)=>a.query(q,p)},'voice_save_rule','staff',tenant,{...cfg,id,enabled:false});
 const waiting=invoke(b,'crm_update_booking_schedule',edit);await new Promise(r=>setTimeout(r,100));await a.query('commit');assert.equal((await waiting).error.code,'CONFLICT');
 const enabled={businessId:tenant,scheduleId:id,revision:2,enabled:true,idempotencyKey:crypto.randomUUID()};
 const race=await Promise.all([invoke(a,'crm_set_booking_schedule_enabled',enabled),invoke(b,'crm_set_booking_schedule_enabled',{...enabled,enabled:false,idempotencyKey:crypto.randomUUID()},'https://booking-concurrency.test/other')]);assert.equal(race.filter(x=>x.ok).length,1,JSON.stringify(race));assert.equal(race.find(x=>!x.ok).error.code,'CONFLICT');
 await main.query("insert into public.sms_bookings(tenant_id,id,contact_id,customer_phone,status,appointment_at,voice_resource_pool) select tenant_id,'synthetic-booking',id,phone,'confirmed',now()+interval '3 days','crew' from public.sms_contacts where tenant_id=$1",[tenant]);
 const contactRevision=Number((await main.query('select revision from public.sms_contacts where tenant_id=$1 and phone=$2',[tenant,phone])).rows[0].revision);
 const cancel={businessId:tenant,bookingId:'synthetic-booking',revision:1,contactRevision,idempotencyKey:crypto.randomUUID()};
 await a.query('begin');assert.equal((await invoke(a,'crm_cancel_booking',cancel)).ok,true);await a.query('rollback');assert.equal((await invoke(b,'crm_cancel_booking',cancel)).ok,true);assert.equal((await invoke(b,'crm_cancel_booking',cancel)).data.status,'cancelled');
 assert.equal(Number((await main.query("select count(*) n from public.sms_messages where direction='outbound' or read_at is not null")).rows[0].n),0);
 console.log('PASS: concurrent schedule creation, browser revision race, competing enablement and interrupted cancellation; no sends or read marks.');
}catch(e){console.error(e);process.exitCode=1;}finally{await Promise.allSettled(clients.map(c=>c.end()));await pg.stop();}
