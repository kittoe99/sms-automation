// Local disposable PostgreSQL only. Model transport is mocked; no SMS provider.
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import assert from 'node:assert/strict';
import {fixture} from '../test/helpers/twilioConnections.js';
import {call} from '../test/helpers/database.js';
import {withAiReplyPreview} from '../src/mcp/aiReplyPreview.js';
const {default:EmbeddedPostgres}=await import(pathToFileURL(resolve('data/inbound-postgres/node_modules/embedded-postgres/dist/index.js')));
const pg=new EmbeddedPostgres({databaseDir:resolve('data/inbound-postgres/ai-preview-'+Date.now()),user:'postgres',password:crypto.randomUUID(),port:55448,persistent:true,initdbFlags:['--encoding=UTF8','--locale=C'],postgresFlags:['-h','127.0.0.1'],onLog:()=>{},onError:()=>{}});
const clients=[],adapt=c=>({exec:s=>c.query(s),query:(s,p)=>c.query(s,p),close:async()=>{}});
try{
 await pg.initialise();await pg.start();
 for(let i=0;i<2;i++){const c=pg.getPgClient();await c.connect();clients.push(c);}
 const [connection,editor]=clients,db=adapt(connection),x=await fixture({database:db}),{tenant}=await x.business('preview-owner');
 for(const c of clients){await c.query("set statement_timeout='5s'");await c.query("select set_config('platform.actor_issuer','https://staff.example.test',false)");}
 await connection.query("insert into sms_private.inbound_ai_settings(tenant_id,mode) values($1,'off')",[tenant]);
 const identity={subject:'staff',clientId:'preview-concurrency'};
 const invoke=async(actor,tool,p,id)=>(await connection.query('select crm_mcp.invoke($1,$2,$3,$4,$5) r',[actor.subject,actor.clientId,tool,JSON.stringify(p),id])).rows[0].r;
 const finish=async(actor,p,id,ok,hash)=>(await connection.query('select crm_mcp.ai_reply_preview_finish($1,$2,$3,$4,$5,$6) r',[actor.subject,actor.clientId,JSON.stringify(p),id,ok,hash])).rows[0].r;
 const cid=(await invoke(identity,'crm_get_access',{},crypto.randomUUID())).data.connectionId;
 await call(db,'mcp_admin','staff','save',{connectionId:cid,revision:0,status:'active',permissions:['ai_reply_preview'],businessIds:[tenant]});
 const p={businessId:tenant,message:'Quote for junk removal?',businessRevision:1,settingsRevision:0,profileVersionId:(await connection.query('select active_profile_version_id id from public.sms_businesses where tenant_id=$1',[tenant])).rows[0].id};
 const fake=()=>new Response(JSON.stringify({status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify({reply:'Please contact the business for a quote.',citationIds:[]})}]}]}));
 const preview=withAiReplyPreview(invoke,finish,{apiKey:'synthetic',fetchImpl:async()=>{
  // A separate session can edit during generation: no network-spanning lock.
  await editor.query('update sms_private.inbound_ai_settings set revision=revision+1 where tenant_id=$1',[tenant]);return fake();
 }});
 assert.equal((await preview(identity,'crm_preview_ai_reply',p,crypto.randomUUID())).error.code,'CONFLICT');p.settingsRevision++;
 const revoked=withAiReplyPreview(invoke,finish,{apiKey:'synthetic',fetchImpl:async()=>{
  await call(adapt(editor),'mcp_admin','staff','save',{connectionId:cid,revision:1,status:'disabled',permissions:[],businessIds:[tenant]});return fake();
 }});
 assert.equal((await revoked(identity,'crm_preview_ai_reply',p,crypto.randomUUID())).error.code,'PERMISSION_DENIED');
 for(const table of ['public.sms_messages','public.sms_conversations','public.sms_contacts','public.sms_bookings','public.sms_handoffs','sms_private.inbound_ai_runs','sms_private.inbound_ai_profile_contexts','sms_private.mcp_requests'])assert.equal(Number((await connection.query(`select count(*) n from ${table}`)).rows[0].n),0,table);
 assert.equal(Number((await connection.query("select count(*) n from sms_private.jobs where queue in ('sms_send_jobs','ai_reply_jobs')")).rows[0].n),0);
 console.log('PASS: independent-session edits and revocation during generation discard output; no model-spanning locks, customer writes, runs or send jobs.');
}catch(error){console.error(error.message);process.exitCode=1;}
finally{await Promise.allSettled(clients.map(c=>c.end()));await pg.stop();}
