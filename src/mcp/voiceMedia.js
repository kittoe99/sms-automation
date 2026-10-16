export function withVoiceMedia(invoke,ticket,{adapterUrl,fetchImpl=fetch}={}) {
 return async(identity,tool,input,requestId)=>{
  const result=await invoke(identity,tool,input,requestId);
  if(tool!=='crm_get_voice_recording'||!result.ok||!adapterUrl)return result;
  try{
   const base=new URL(adapterUrl);if(base.protocol!=='https:'||base.username||base.password||base.search||base.hash||base.pathname!=='/functions/v1/crm-api/mcp/knowledge-upload')throw new Error('Invalid adapter');
   const token=await ticket(identity,input.businessId,input.callId);
   const response=await fetchImpl(new URL('/functions/v1/crm-api/mcp/voice-media',base),{method:'POST',redirect:'error',signal:AbortSignal.timeout(15000),headers:{'Content-Type':'application/json'},body:JSON.stringify({ticket:token})});
   if(!response.ok)throw new Error('Media unavailable');
   const body=await response.json(),signed=new URL(body.signedUrl),ttl=Number(body.expiresIn);
   if(signed.origin!==base.origin||!signed.pathname.startsWith('/storage/v1/object/sign/voice-recordings/')||!signed.searchParams.get('token')||!Number.isInteger(ttl)||ttl<1||ttl>300)throw new Error('Invalid media response');
   return {...result,data:{...result.data,status:'available',signedUrl:signed.href,expiresIn:ttl,urlExpiresAt:new Date(Date.now()+Math.max(0,ttl-5)*1000).toISOString()}};
  }catch{return result;}
 };
}
