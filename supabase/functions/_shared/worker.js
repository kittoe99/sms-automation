import {json,constantTimeToken,env} from './workerAuth.js';

// One invocation has a finite job count and time budget. Queues own all remaining work.
export function createWorkerHandler({queue,secret,db,processJob,maxJobs=5,budgetMs=45000,now=Date.now}) {
 return async request=>{
  if(request.method!=='POST') return json({error:'POST required'},405);
  if(!secret || secret.length<32) return json({error:'Worker is not configured'},503);
  if(!constantTimeToken(request.headers.get('Authorization'),`Bearer ${secret}`)) return json({error:'Unauthorized'},401);
  const workerId=`edge:${queue}:${crypto.randomUUID()}`;
  let slot;let processed=0;
  try {
   slot=await db.call('edge_enter',queue,workerId);
   if(!slot) return json({status:'paused_or_busy',processed:0});
   const started=now();
   while(processed<maxJobs && now()-started<budgetMs) {
    const job=await db.call('claim',queue,workerId);
    if(!job) break;
    try {await processJob(job,db);} catch(error) {
     console.error(JSON.stringify({event:'edge_job_failed',queue,tenantId:job.tenant_id,jobId:job.id,code:error.code || 'WORKER_ERROR'}));
     // SMS transport uncertainty is handled inside the sender; a crash is recovered by tick().
     if(queue!=='sms_send_jobs') await db.call('finish',job.id,job.lease_token,error.permanent?'failed':'retry',error.code || 'WORKER_ERROR',Math.min(3600,30*2**job.attempts)+Math.floor(Math.random()*10));
    }
    processed++;
   }
   console.log(JSON.stringify({event:'edge_batch_completed',queue,workerId,processed}));
   return json({status:'completed',processed});
  } catch(error) {
   console.error(JSON.stringify({event:'edge_worker_failed',queue,code:error.code || 'DB_ERROR'}));
   return json({error:'Worker temporarily unavailable'},503);
  } finally {if(slot) await db.call('edge_exit',queue,slot).catch(()=>{});}
 };
}
export {env};
