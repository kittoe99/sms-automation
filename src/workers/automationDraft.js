import {generateAutomationSequence} from '../lib/automations/sequenceDraft.js';

export async function processAutomationDraft(job,db,options={}){
 const context=await db.call('draft_job_context',job.id,job.lease_token);
 if(!context?.draft)return db.call('finish',job.id,job.lease_token,'cancelled','DRAFT_MISSING',0);
 const result=await generateAutomationSequence(context,options);
 return db.call('complete_automation_draft',job.id,job.lease_token,result);
}
