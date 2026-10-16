// Disposable local PostgreSQL. No provider access or production data.
import {resolve} from 'node:path';
import {createServer} from 'node:net';
import {pathToFileURL} from 'node:url';
import assert from 'node:assert/strict';
import {fixture} from '../test/helpers/twilioConnections.js';
import {call} from '../test/helpers/database.js';
import {websitePermissions} from '../src/mcp/websiteSchemas.js';
const {default:EmbeddedPostgres}=await import(pathToFileURL(resolve('data/inbound-postgres/node_modules/embedded-postgres/dist/index.js')));
const probe=createServer();await new Promise(resolve=>probe.listen(0,'127.0.0.1',resolve));const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));
const diagnostics=[];
const pg=new EmbeddedPostgres({databaseDir:resolve('data/inbound-postgres/mcp-website-'+Date.now()),user:'postgres',password:crypto.randomUUID(),port,persistent:true,initdbFlags:['--encoding=UTF8','--locale=C'],postgresFlags:['-h','127.0.0.1'],onLog:s=>diagnostics.push(String(s)),onError:s=>diagnostics.push(String(s))});
const clients=[];
try{
 await pg.initialise();await pg.start();
 const main=pg.getPgClient();await main.connect();clients.push(main);
 const db={exec:s=>main.query(s),query:(s,p)=>main.query(s,p),close:async()=>{}};
 const f=await fixture({database:db}),tenant=(await f.business('website-races')).tenant,phone='+17208429167';
 const a=pg.getPgClient(),b=pg.getPgClient();for(const c of [a,b]){await c.connect();clients.push(c);await c.query("select set_config('platform.actor_issuer','https://staff.example.test',false)");await c.query("set statement_timeout='8s'");}
 const invoke=async(client,tool,p,oauth='https://website-concurrency.test')=>(await client.query('select crm_mcp.invoke($1,$2,$3,$4,$5) r',['staff',oauth,tool,JSON.stringify(p),crypto.randomUUID()])).rows[0].r;
 for(const oauth of ['https://website-concurrency.test','https://website-concurrency.test/other']){
  const id=(await invoke(a,'crm_get_access',{},oauth)).data.connectionId;
  await call(db,'mcp_admin','staff','save',{connectionId:id,revision:0,status:'active',permissions:websitePermissions.map(x=>x[0]).concat('contact_edit'),businessIds:[tenant],allBusinesses:false});
 }
 const site=(await main.query("insert into public.hosting_sites(id,slug,name,created_by,sms_tenant_id) values(gen_random_uuid(),'mcp-race','Synthetic','staff',$1) returning *",[tenant])).rows[0];
 const p={businessId:tenant,siteId:site.id,revision:0,name:'Synthetic edit',details:{},idempotencyKey:crypto.randomUUID()};
 const pair=await Promise.all([invoke(a,'crm_update_website_details',p),invoke(b,'crm_update_website_details',p)]);assert.equal(pair[0].ok,true,JSON.stringify(pair));assert.deepEqual(pair[0],pair[1]);
 await a.query('begin');await a.query('update public.hosting_sites set name=name where id=$1',[site.id]);
 const stale={...p,revision:1,idempotencyKey:crypto.randomUUID()};assert.equal((await invoke(b,'crm_update_website_details',stale)).error.code,'TEMPORARY_FAILURE');await a.query('commit');assert.equal((await invoke(b,'crm_update_website_details',stale)).error.code,'CONFLICT');
 const unpublish={businessId:tenant,siteId:site.id,revision:2,idempotencyKey:crypto.randomUUID()};
 await a.query('begin');assert.equal((await invoke(a,'crm_unpublish_website',unpublish)).ok,true);await a.query('rollback');
 const queued=await Promise.all([invoke(a,'crm_unpublish_website',unpublish),invoke(b,'crm_unpublish_website',unpublish)]);assert.equal(queued[0].ok,true);assert.deepEqual(queued[0],queued[1]);
 const id=queued[0].data.operation.id;
 const ticket=async client=>(await client.query('select crm_mcp.hosting_ticket($1,$2,$3,$4,$5) token',['staff','https://website-concurrency.test',tenant,site.id,id])).rows[0].token;
 const ta=await ticket(a),tb=await ticket(b);
 const claim=async(client,token)=>(await client.query('select public.claim_mcp_hosting_ticket($1) r',[token])).rows[0].r;
 const claims=await Promise.all([claim(a,ta),claim(b,tb)]);assert.equal(claims.filter(x=>x.mode==='execute').length,1);assert.equal(claims.filter(x=>x.mode==='status').length,1);
 const lease=claims.find(x=>x.mode==='execute');
 assert.equal((await a.query("select public.begin_hosting_operation($1,'unpublish','browser',null) r",[site.id])).rows[0].r.status,'busy');
 await a.query("select public.apply_hosting_operation($1,$2,$3,'invalidate','{}')",[site.id,lease.token,lease.generation]);
 const done=(await a.query("select public.finish_mcp_hosting_operation($1,$2,$3,'completed') r",[id,lease.token,lease.generation])).rows[0].r;assert.equal(done.state,'completed');assert.equal(Number(done.resultingRevision),3);
 const single=await ticket(a),consume=await Promise.allSettled([claim(a,single),claim(b,single)]);assert.equal(consume.filter(x=>x.status==='fulfilled').length,1);
 assert.equal(Number((await main.query('select count(*) n from sms_private.mcp_hosting_operations')).rows[0].n),1);
 assert.equal(Number((await main.query("select count(*) n from public.sms_messages where direction='outbound' or read_at is not null")).rows[0].n),0);
 assert.equal(Number((await main.query("select count(*) n from sms_private.email_jobs")).rows[0].n),0);
 console.log('PASS: identical details/intent retries, browser lock/revision conflicts, interrupted intent rollback, competing execution claims and one-use hosting tickets; no email/SMS sends.');
}catch(e){console.error(e??diagnostics.slice(-12).join('\n'));process.exitCode=1;}finally{await Promise.allSettled(clients.map(c=>c.end()));await pg.stop();}
