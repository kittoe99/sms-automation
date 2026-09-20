import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { connectDatabase } from './database.js';
import { processSms } from './sms.js';
import { processAutomation } from './automation.js';
import { processAi } from './ai.js';
import { processProvisioning } from './provisioning.js';
import {processKnowledge} from './knowledge.js';
import {processEmbeddings} from './embeddings.js';
import {processHandoffAlert} from './handoff.js';
import {processCompliance} from './compliance.js';
import {processAutomationDraft} from './automationDraft.js';
const modes={sms:[['sms_send_jobs',processSms]],automation:[['automation_jobs',processAutomation]],ai:[['ai_reply_jobs',processAi]],draft:[['automation_draft_jobs',processAutomationDraft]],support:[['handoff_alert_jobs',processHandoffAlert],['provisioning_jobs',processProvisioning],['compliance_jobs',processCompliance],['knowledge_ingest_jobs',processKnowledge],['embedding_jobs',processEmbeddings]]};
const mode=process.argv[2]; if(!modes[mode]) throw new Error('Use sms, automation, ai, draft or support');
const db=connectDatabase(); const workerId=`${mode}:${randomUUID()}`; let stopping=false;
const defaults={sms:32,automation:32,ai:8,draft:2,support:4};
const concurrency=Math.min(64,Math.max(1,Number(process.env.WORKER_CONCURRENCY)||defaults[mode]));
process.on('SIGTERM',()=>{stopping=true;}); process.on('SIGINT',()=>{stopping=true;});

async function consume(slot){
 while(!stopping){
  let worked=false;
  for(const [queue,handler] of modes[mode]){
   if(stopping)break;
   let job;
   try{job=await db.call('claim',queue,`${workerId}:${slot}`);}catch(error){
    console.error(JSON.stringify({event:'claim_failed',queue,code:error.code||'DB_ERROR'}));await sleep(5000);continue;
   }
   if(!job)continue;worked=true;
   let renewal=Promise.resolve();
   const timer=setInterval(()=>{renewal=renewal.then(()=>db.call('extend_lease',job.id,job.lease_token)).catch(()=>{});},30000);
   try{
    await handler(job,db);
    console.log(JSON.stringify({event:'job_processed',jobId:job.id,tenantId:job.tenant_id,queue}));
   }catch(error){
    console.error(JSON.stringify({event:'job_failed',jobId:job.id,tenantId:job.tenant_id,queue,code:error.code||'WORKER_ERROR'}));
    const delay=Math.min(3600,30*2**job.attempts);
    if(queue==='automation_draft_jobs')await db.call('fail_automation_draft',job.id,job.lease_token,error.code||'WORKER_ERROR',Boolean(error.permanent),delay).catch(()=>{});
    else if(queue!=='sms_send_jobs')await db.call('finish',job.id,job.lease_token,error.permanent?'failed':'retry',error.code||'WORKER_ERROR',delay).catch(()=>{});
   }finally{clearInterval(timer);await renewal;}
  }
  if(!worked&&!stopping)await sleep(500);
 }
}

try{
 console.log(JSON.stringify({event:'worker_started',mode,workerId,concurrency}));
 await Promise.all(Array.from({length:concurrency},(_,slot)=>consume(slot)));
}finally{
 await db.close();
 console.log(JSON.stringify({event:'worker_stopped',mode,workerId}));
}
