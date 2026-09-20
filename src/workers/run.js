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
const modes={sms:[['sms_send_jobs',processSms],['handoff_alert_jobs',processHandoffAlert]],automation:[['automation_jobs',processAutomation],['provisioning_jobs',processProvisioning],['compliance_jobs',processCompliance]],ai:[['ai_reply_jobs',processAi],['knowledge_ingest_jobs',processKnowledge],['embedding_jobs',processEmbeddings]]};
const mode=process.argv[2]; if(!modes[mode]) throw new Error('Use sms, automation or ai');
const db=connectDatabase(); const workerId=`${mode}:${randomUUID()}`; let stopping=false;
process.on('SIGTERM',()=>{stopping=true;}); process.on('SIGINT',()=>{stopping=true;});
try {
  while(!stopping) {
    let worked=false;
    for(const [queue,handler] of modes[mode]) {
      if(stopping) break;
      let job;
      try { job=await db.call('claim',queue,workerId); } catch(error) {
        console.error(JSON.stringify({event:'claim_failed',queue,code:error.code || 'DB_ERROR'})); await sleep(5000); continue;
      }
      if(!job) continue; worked=true;
      let renewal=Promise.resolve();
      const timer=setInterval(()=>{ renewal=renewal.then(()=>db.call('extend_lease',job.id,job.lease_token)).catch(()=>{}); },30000);
      try {
        await handler(job,db);
        console.log(JSON.stringify({event:'job_processed',jobId:job.id,tenantId:job.tenant_id,queue}));
      } catch(error) {
        console.error(JSON.stringify({event:'job_failed',jobId:job.id,tenantId:job.tenant_id,queue,code:error.code || 'WORKER_ERROR'}));
        // Never retry an SMS here: the worker may have crossed the submission boundary.
        if(queue!=='sms_send_jobs') await db.call('finish',job.id,job.lease_token,'retry',error.code || 'WORKER_ERROR',Math.min(3600,30*2**job.attempts)).catch(()=>{});
      } finally {clearInterval(timer); await renewal;}
    }
    if(!worked) await sleep(1000);
  }
} finally {await db.close();}
