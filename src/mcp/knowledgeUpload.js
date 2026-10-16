export function withKnowledgeUpload(invoke,ticket,{adapterUrl,fetchImpl=fetch}={}) {
 return async(identity,tool,input,requestId)=>{
  const result=await invoke(identity,tool,input,requestId);
  if(tool!=='crm_prepare_knowledge_upload'||!result.ok)return result;
  // The committed receipt contains only the intent, never either credential.
  // Retrying obtains another short-lived URL for that same storage object.
  const data={...result.data,uploadStatus:'temporarily_unavailable'};
  if(!adapterUrl)return {...result,data};
  try{
   const url=new URL(adapterUrl);
   if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash||url.pathname!=='/functions/v1/crm-api/mcp/knowledge-upload')throw new Error('Invalid adapter URL');
   const credential=await ticket(identity,data.uploadId);
   const response=await fetchImpl(url,{method:'POST',redirect:'error',signal:AbortSignal.timeout(15000),headers:{'Content-Type':'application/json'},body:JSON.stringify({ticket:credential})});
   if(!response.ok)throw new Error('Upload signing unavailable');
   const body=await response.json(),signed=new URL(body.signedUrl);
   if(signed.origin!==url.origin||!signed.pathname.startsWith('/storage/v1/object/upload/sign/business-knowledge/')||!signed.searchParams.get('token'))throw new Error('Invalid signed upload');
   return {...result,data:{...data,uploadStatus:'ready',signedUrl:signed.href,uploadUrlExpiresAt:new Date(Date.now()+7190000).toISOString()}};
  }catch{return {...result,data};}
 };
}
