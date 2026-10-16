export function withEmailAdapter(invoke,ticket,{adapterUrl,fetchImpl=fetch}={}) {
 return async(identity,tool,input,requestId)=>{
  if(!['crm_save_email_group','crm_set_email_group_enabled'].includes(tool))return invoke(identity,tool,input,requestId);
  const unavailable=()=>({ok:false,error:{code:'TEMPORARY_FAILURE',message:'Email configuration service unavailable. Retry with the same idempotency key.',retryable:true}});
  try{
   const url=new URL(adapterUrl);
   if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash||url.pathname!=='/functions/v1/crm-api/mcp/knowledge-upload')return unavailable();
   url.pathname='/functions/v1/crm-api/mcp/email-action';
   const authorization=await ticket(identity,tool,input,requestId);
   if(!authorization.ok)return authorization;
   const response=await fetchImpl(url,{method:'POST',redirect:'error',signal:AbortSignal.timeout(15000),headers:{'Content-Type':'application/json'},body:JSON.stringify({ticket:authorization.ticket,input})});
   if(!response.ok)return unavailable();
   const result=await response.json();
   return typeof result.ok==='boolean'?result:unavailable();
  }catch{return unavailable();}
 };
}
