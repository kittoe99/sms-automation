const fail=(message,code,permanent=false)=>Object.assign(new Error(message),{code,permanent});
export async function processHandoffAlert(job,db) {
 const ctx=await db.call('handoff_job_context',job.id,job.lease_token);
 if(!ctx?.handoff || !ctx.alertPhone) throw fail('Handoff alert is incomplete','HANDOFF_ALERT_INVALID',true);
 if(!['open','assigned'].includes(ctx.handoff.status)) return db.call('finish',job.id,job.lease_token,'cancelled','HANDOFF_RESOLVED',0);
 return db.call('complete_handoff_alert',job.id,job.lease_token);
}
