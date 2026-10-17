import {aiPreviewInput,aiPreviewOutputs} from './aiPreviewSchemas.js';
import {inboundInstructions,INBOUND_AGENT_MODEL} from '../workers/inboundAgent.js';
import {z} from 'zod';
const answer=z.object({reply:z.string().trim().min(1).max(600),citationIds:z.array(z.string()).max(0)}).strict();
const unavailable=()=>({ok:false,error:{code:'TEMPORARY_FAILURE',message:'AI preview unavailable. No customer action or SMS was performed.',retryable:true}});
// Deliberately no worker/database adapter is passed to the model. It cannot call
// inbound_ai_tool, complete_inbound_ai, queues, customer reads or send endpoints.
export function withAiReplyPreview(invoke,finish,{apiKey,fetchImpl=fetch,now=Date.now}={}) {
 return async(identity,tool,input,requestId)=>{
  if(tool!=='crm_preview_ai_reply')return invoke(identity,tool,input,requestId);
  const parsed=aiPreviewInput.safeParse(input);
  if(!parsed.success)return {ok:false,error:{code:'VALIDATION_ERROR',message:'Invalid AI preview input',retryable:false}};
  const p=parsed.data;let prepared;
  try{prepared=await invoke(identity,tool,p,requestId);}catch{return unavailable();}
  if(!prepared.ok)return prepared;
  const data=prepared.data;let reply=null;
  try{
   if(!apiKey)throw new Error('Preview key not configured');
   const instructions=inboundInstructions({...data.context,services:[],requests:[],history:[],session:{},automation:{}},[],now())+
    '\nPREVIEW LIMITS: This is a hypothetical Business Info answer only. No customer history, supplementary evidence, live availability or action tools are provided. Never claim a booking, handoff, cancellation, opt-out or other action occurred. Explain the next step or ask a clarifying question when an action would be needed. Return no citationIds.';
   const response=await fetchImpl('https://api.openai.com/v1/responses',{
    method:'POST',redirect:'error',signal:AbortSignal.timeout(35000),headers:{Authorization:`Bearer ${apiKey}`,'Content-Type':'application/json'},
    body:JSON.stringify({model:INBOUND_AGENT_MODEL,reasoning:{effort:'low'},service_tier:'default',store:false,
     instructions,input:[{role:'user',content:p.message}],tools:[],tool_choice:'none',max_output_tokens:4096,
     text:{format:{type:'json_schema',name:'ai_reply_preview',strict:true,schema:{type:'object',properties:{reply:{type:'string'},citationIds:{type:'array',items:{type:'string'}}},required:['reply','citationIds'],additionalProperties:false}}}}),
   });
   if(!response.ok)throw new Error('Preview provider failed');
   const raw=await response.text();if(raw.length>131072)throw new Error('Oversized provider response');
   const result=JSON.parse(raw);
   if(result.status!=='completed'||!Array.isArray(result.output)||result.output.some(x=>!['message','reasoning'].includes(x.type))||result.output.some(x=>(x.content||[]).some(c=>c.type==='refusal')))throw new Error('Invalid preview result');
   reply=answer.parse(JSON.parse(result.output.filter(x=>x.type==='message').flatMap(x=>x.content||[]).filter(x=>x.type==='output_text').map(x=>x.text).join(''))).reply;
  }catch{/* Raw provider failures and customer text never enter logs or audit. */}
  // No transaction remains open during the model call. Recheck scope, active
  // staff/connection, permissions, revisions and the captured context afterwards.
  let checked;try{checked=await finish(identity,p,requestId,reply!==null,data.contextHash);}catch{return unavailable();}
  if(!checked.ok)return checked;
  if(reply===null)return unavailable();
  return {ok:true,data:aiPreviewOutputs.crm_preview_ai_reply.parse({
   businessId:data.businessId,businessRevision:data.businessRevision,settingsRevision:data.settingsRevision,
   profileVersionId:data.profileVersionId,profileVersion:data.profileVersion,profileCapturedAt:data.profileCapturedAt,
   profileVersionAvailability:'recorded',reply,model:INBOUND_AGENT_MODEL,promptVersion:'business-info-preview-v1',
   previewOnly:true,contextScope:'approved_business_info_only',actionsExecuted:false,messageQueued:false,
  })};
 };
}
