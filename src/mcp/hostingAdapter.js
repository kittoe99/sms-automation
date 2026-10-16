import {websiteOperation} from './websiteSchemas.js';
export function withHostingAdapter(invoke,ticket,{adapterUrl,fetchImpl=fetch}={}) {
 return async(identity,tool,input,requestId)=>{
  const result=await invoke(identity,tool,input,requestId);
  if(!result.ok||!['crm_get_website_publication','crm_publish_website','crm_unpublish_website'].includes(tool)||!adapterUrl)return result;
  try{
   const url=new URL(adapterUrl);if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash||url.pathname!=='/api/web-hosting/mcp')throw new Error('Invalid hosting adapter');
   const credential=await ticket(identity,input.businessId,input.siteId,result.data.operation?.id??null);
   const response=await fetchImpl(url,{method:'POST',redirect:'error',signal:AbortSignal.timeout(30000),headers:{'Content-Type':'application/json'},body:JSON.stringify({ticket:credential})});
   if(!response.ok)return result;
   const body=await response.json();
   if(tool==='crm_get_website_publication'){
    if(!['published','unpublished'].includes(body.status)||typeof body.checkedAt!=='string'||!Number.isFinite(Date.parse(body.checkedAt))||(body.status==='unpublished'?body.deploymentId!==null:!(/^[0-9a-f-]{36}$/i.test(body.deploymentId))))return result;
    return {...result,data:{...result.data,status:body.status,deploymentId:body.deploymentId,checkedAt:body.checkedAt}};
   }
   const operation=websiteOperation.parse(body.operation);if(operation.id!==result.data.operation.id)return result;
   return {...result,data:{...result.data,operation,revision:operation.resultingRevision??result.data.revision,providerWork:operation.state==='completed'?'completed':operation.state==='attention'?'attention':operation.state==='failed'?'failed':'queued'}};
  }catch{return result;}
 };
}
