// Disposable local PostgreSQL only; no production URL, model call or SMS provider.
// Uses the same optional embedded-postgres runtime as test-inbound-concurrency.js.
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import assert from 'node:assert/strict';
import {setupCoordination,incoming,tenant} from '../test/helpers/coordination.js';
import {call} from '../test/helpers/database.js';
const {default:EmbeddedPostgres}=await import(pathToFileURL(resolve('data/inbound-postgres/node_modules/embedded-postgres/dist/index.js')));
const pg=new EmbeddedPostgres({databaseDir:resolve('data/inbound-postgres/profile-'+Date.now()),user:'postgres',password:crypto.randomUUID(),port:55442,persistent:true,
 initdbFlags:['--encoding=UTF8','--locale=C'],postgresFlags:['-h','127.0.0.1'],onLog:()=>{},onError:()=>{}});
const clients=[];
try {
 await pg.initialise();await pg.start();
 const connect=async()=>{const c=pg.getPgClient();await c.connect();clients.push(c);return c;};
 const main=await connect(),editor=await connect(),contender=await connect();
 const db={exec:s=>main.query(s),query:(s,p)=>main.query(s,p),close:async()=>{}};
 await setupCoordination({mode:'shadow',database:db});
 const profiles=[];
 for(const version of [1,2])profiles.push((await main.query("insert into public.sms_business_profile_versions(tenant_id,version,facts,status,content_hash,created_by,approved_at) values($1,$2,$3,'approved',$4,'admin',now()) returning id",[tenant,version,JSON.stringify({businessInfo:'Version '+version}),crypto.randomUUID()])).rows[0].id);
 await main.query('update public.sms_businesses set active_profile_version_id=$2 where tenant_id=$1',[tenant,profiles[0]]);
 const job=await incoming(db);
 await main.query('begin');
 const first=await call(db,'inbound_ai_context',job.id,job.lease_token);
 // A profile review can commit while generation holds its own job lock.
 await editor.query('update public.sms_businesses set active_profile_version_id=$2 where tenant_id=$1',[tenant,profiles[1]]);
 let settled=false;
 const waiting=contender.query('select sms_private.inbound_ai_context($1,$2) value',[job.id,job.lease_token]).then(r=>r.rows[0].value).finally(()=>{settled=true;});
 await new Promise(resolve=>setTimeout(resolve,150));assert.equal(settled,false,'Competing context read must wait on the job lock');
 await main.query('commit');
 const second=await waiting;
 assert.equal(first.profileVersionId,profiles[0]);assert.equal(second.profileVersionId,profiles[0]);assert.equal(second.profile.businessInfo,'Version 1');
 await call(db,'complete_inbound_ai',job.id,job.lease_token,{reply:'Hello',profileVersionId:profiles[1]});
 const recorded=(await main.query('select profile_version_id from sms_private.inbound_ai_runs where job_id=$1',[job.id])).rows[0];assert.equal(recorded.profile_version_id,profiles[0]);
 const rollbackJob=await incoming(db);
 await main.query('begin');await call(db,'inbound_ai_context',rollbackJob.id,rollbackJob.lease_token);await main.query('rollback');
 assert.equal(Number((await main.query('select count(*) n from sms_private.inbound_ai_profile_contexts where job_id=$1',[rollbackJob.id])).rows[0].n),0);
 assert.equal(Number((await main.query("select count(*) n from public.sms_messages where direction='outbound'")).rows[0].n),0);
 console.log('PASS: concurrent review, serialized same-lease context, trusted completion and interrupted transaction rollback; zero outbound messages.');
} catch(error) {console.error(error.message);process.exitCode=1;}
finally {await Promise.allSettled(clients.map(c=>c.end()));await pg.stop();}
