import {json,failure} from '../_shared/http.js';
import {hmac} from '../voice-agent/handler.js';
import {voiceStorage} from '../_shared/voice-storage.js';
export const RUNTIME_TENANT='biz-1c0c09ce-819e-4795-86b9-0e457ab92f58';
const fields={configuration:[],start:['room','sipCallId','phone','revision','source'],heartbeat:[],finish:['status','duration','transcript','audio'],outcome:['outcome','summary','phone','name','service','location','request'],upload:['bytes'],uploaded:['bytes']};
const bad=(message,status=400)=>Object.assign(new Error(message),{status});
export async function signedInput(request,secret,maxBytes=600000){
 if(request.method!=='POST')throw bad('POST required',405);
 if(!secret||secret.length<32)throw bad('Runtime is not configured',503);
 const stamp=request.headers.get('X-Voice-Timestamp')||'';
 if(!/^\d+$/.test(stamp)||Math.abs(Date.now()/1000-Number(stamp))>60)throw bad('Expired request',401);
 const reader=request.body?.getReader();let chunks=[],size=0;
 if(reader)for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>maxBytes){await reader.cancel();throw bad('Payload too large',413);}chunks.push(value);}
 const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
 const body=new TextDecoder('utf-8',{fatal:true}).decode(bytes),expected=await hmac(secret,`${stamp}.${body}`),supplied=request.headers.get('X-Voice-Signature')||'';
 let diff=supplied.length^expected.length;for(let i=0;i<expected.length;i++)diff|=expected.charCodeAt(i)^(supplied.charCodeAt(i)||0);
 if(diff)throw bad('Invalid signature',401);
 try{return JSON.parse(body);}catch{throw bad('Invalid JSON');}
}
export function createRuntimeHandler(db,{secret,enabled=false,storage=voiceStorage()}={}) {
 return async request=>{try{
  if(!enabled)throw bad('Voice CRM runtime is not enabled',503);
  const input=await signedInput(request,secret);
  if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>!['action','callId','payload'].includes(k)))throw bad('Invalid request');
  const {action,callId,payload}=input;
  if(!Object.hasOwn(fields,action)||typeof callId!=='string'||callId.length<8||callId.length>160||!payload||typeof payload!=='object'||Array.isArray(payload)||Object.keys(payload).some(k=>!fields[action].includes(k)))throw bad('Invalid runtime request');
  // Reuse the server-owned upload path, never a worker/model supplied object key.
  if(action==='uploaded'){
   const upload=await db.call('dispatch',RUNTIME_TENANT,callId,'upload',payload);
   await storage.verify(upload.path,payload.bytes);
  }
  const result=await db.call('dispatch',RUNTIME_TENANT,callId,action,payload);
  if(action==='upload'&&!result.ready)Object.assign(result,await storage.upload(result.path));
  return json({ok:true,result});
 }catch(error){return failure(error);}};
}
