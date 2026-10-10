// Runs synthetic messages through the real worker and isolated shadow database.
// Requires an injected OPENAI_API_KEY. No Twilio sends or production DB access.
import 'dotenv/config';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {testDatabase,call} from '../test/helpers/database.js';
import {processInboundAgent} from '../src/workers/inboundAgent.js';
import {inboundAgentCases} from '../test/fixtures/inboundAgentEval.js';
const proxy=process.env.INBOUND_AI_EVAL_PROXY_FILE?JSON.parse(await readFile(process.env.INBOUND_AI_EVAL_PROXY_FILE,'utf8')):null;
if(proxy && proxy.url!=='https://wxamwhfmelxqahkdtcci.supabase.co/functions/v1/inbound-ai-validation') throw new Error('Unexpected evaluation proxy');
const apiKey=proxy?.token||process.env.OPENAI_API_KEY;
if(!apiKey) {console.error('Set OPENAI_API_KEY in the operator environment; do not put it in source or command arguments.');process.exit(1);}
const fetchImpl=(url,options={})=>fetch(proxy?.url||url,proxy?{...options,headers:{Authorization:`Bearer ${proxy.token}`,'Content-Type':'application/json'}}:options);
const access=await fetchImpl('https://api.openai.com/v1/models/gpt-6.1-sol',{headers:{Authorization:`Bearer ${apiKey}`}});
const modelStatus=proxy&&access.ok?(await access.json()).modelStatus:access.status;
if(modelStatus!==200){console.error(`GPT 6.1 Sol access check failed (${modelStatus}).`);process.exit(1);}
const db=await testDatabase(),tenant='biz-1c0c09ce-819e-4795-86b9-0e457ab92f58',results=[];
const bookingOnly=process.argv.includes('--booking-only');
const filename=`data/inbound-agent-${bookingOnly?'booking':'eval'}-${new Date().toISOString().replace(/[:.]/g,'-')}.json`;
try {
 await call(db,'api_action','admin',null,'create_business',{id:tenant,name:'Synthetic SMS evaluation',timeZone:'America/Denver'});
 await db.query("update public.sms_businesses set status='active' where tenant_id=$1",[tenant]);
 const facts={businessName:'Synthetic SMS evaluation',hours:'Monday–Saturday 9 AM–5 PM; closed Sunday',areas:['Denver'],services:['junk removal','property cleanout','local moving','dumpster rental'],policies:['No hazardous waste or asbestos','Fully insured','Payment after service; never collect card details by text'],pricing:['One moving helper $79/hour; two $119/hour; truck fee $99; no truck fee for in-home rearrangement. Do not quote a full moving job total.']};
 const profile=(await db.query("insert into public.sms_business_profile_versions(tenant_id,version,facts,status,content_hash,created_by,approved_by,approved_at) values($1,1,$2,'approved','synthetic','admin','admin',now()) returning id",[tenant,JSON.stringify(facts)])).rows[0].id;
 await db.query('update public.sms_businesses set active_profile_version_id=$2 where tenant_id=$1',[tenant,profile]);
 await db.query("insert into sms_private.inbound_ai_settings(tenant_id,mode,system_prompt,booking_enabled) values($1,'shadow','Help customers using approved facts and tools. Ask one question at a time.',true)",[tenant]);
 const hours=Object.fromEntries(Array.from({length:7},(_,i)=>[i,i===0?[]:[{start:'09:00',end:'17:00'}]]));
 for(const service of ['junk_removal','property_cleanout','local_moving','dumpster_rental']) await call(db,'voice_save_rule','admin',tenant,{
  service,market:'Synthetic',resourcePool:'crew',timeZone:'America/Denver',enabled:true,durationMinutes:service==='dumpster_rental'?1440:60,
  capacity:1,minimumNoticeMinutes:120,maximumAdvanceDays:90,weeklyAvailability:hours,dateExceptions:[],
 });
 const adapter={call:(name,...args)=>call(db,name,...args)};
 for(const [index,scenario] of (bookingOnly?[]:inboundAgentCases).entries()) {
  const phone='+1303555'+String(index+1000),message=scenario.message.replace(/2099-01-(\d{2})/g,(_,day)=>new Date(Date.now()+(Number(day)-9)*86400000).toISOString().slice(0,10));
  await call(db,'record_webhook',tenant,'inbound',{From:phone,To:'+18005550100',Body:message,MessageSid:scenario.id});
  await db.query("update sms_private.jobs set available_at=now() where queue='ai_reply_jobs'");await db.query("update pgmq.test_messages set vt=now() where q='ai_reply_jobs'");
  const job=await call(db,'claim','ai_reply_jobs','eval');
  // Terminal failure reporting keeps one record per scenario; no provider retries here.
  await db.query('update sms_private.jobs set attempts=3 where id=$1',[job.id]);
  await processInboundAgent(job,adapter,{apiKey,fetchImpl});
  const run=(await db.query('select result from sms_private.inbound_ai_runs where job_id=$1',[job.id])).rows[0]?.result;
  const actions=(await db.query('select name,arguments,result from sms_private.inbound_ai_actions where job_id=$1 order by created_at',[job.id])).rows;
  results.push({...scenario,message,run,actions,expectedToolObserved:scenario.expected==='answer'?actions.length===0:scenario.expected==='review'?null:actions.some(x=>x.name===scenario.expected),humanReview:'pending'});
  await mkdir('data',{recursive:true});await writeFile(filename,JSON.stringify({model:'gpt-6.1-sol',humanReviewRequired:true,results},null,2));
  console.log(`${scenario.id}: ${run?.code||'recorded'}; review pending`);
 }
 for(const table of ['public.sms_bookings','sms_private.inbound_ai_sessions','public.sms_handoffs']) {
  if(Number((await db.query(`select count(*) n from ${table}`)).rows[0].n)!==0)throw new Error(`Shadow mode mutated ${table}`);
 }
 if(Number((await db.query("select count(*) n from public.sms_messages where direction='outbound'")).rows[0].n)!==0)throw new Error('Shadow mode queued a message');
 // Exercise real model confirmation against a local database only. Acceptance is
 // simulated; no sender worker or production customer records are involved.
 await db.query("update sms_private.inbound_ai_settings set mode='live' where tenant_id=$1",[tenant]);
 await db.query('update public.sms_businesses set sending_enabled=true where tenant_id=$1',[tenant]);
 const bookingConversation=[];
 const day=new Date(Date.now()+3*86400000).toISOString().slice(0,10);
 for(const message of [`Book junk removal for Alex Sample at 123 Example Street on ${day} at 10 AM.`, 'YES', 'YES']) {
  await call(db,'record_webhook',tenant,'inbound',{From:'+13035559999',To:'+18005550100',Body:message,MessageSid:crypto.randomUUID()});
  await db.query("update sms_private.jobs set available_at=now() where queue='ai_reply_jobs'");await db.query("update pgmq.test_messages set vt=now() where q='ai_reply_jobs'");
  const job=await call(db,'claim','ai_reply_jobs','eval-booking');
  await db.query('update sms_private.jobs set attempts=3 where id=$1',[job.id]);
  const out=await processInboundAgent(job,adapter,{apiKey,fetchImpl});
  const run=(await db.query('select result from sms_private.inbound_ai_runs where job_id=$1',[job.id])).rows[0]?.result;
  bookingConversation.push({message,run});
  if(out?.messageId)await db.query("update public.sms_messages set provider_accepted_at=now(),status='accepted' where id=$1",[out.messageId]);
 }
 const bookings=Number((await db.query('select count(*) n from public.sms_bookings')).rows[0].n);
 await writeFile(filename,JSON.stringify({model:'gpt-6.1-sol',humanReviewRequired:true,shadowIsolationPassed:true,results,bookingConversation,localBookingCount:bookings},null,2));
 if(bookings!==1 || !bookingConversation[0].run?.reply.includes('Reply YES'))throw new Error('Local real-model booking conversation failed; inspect evaluation artifact');
 console.log(`Saved ${results.length} scenarios to ${filename}. Review every reply and tool argument; this does not authorize live mode.`);
}finally{await db.close();}
