import {json,failure} from '../_shared/http.js';
import {hmac} from '../voice-agent/handler.js';
const TENANT='biz-1c0c09ce-819e-4795-86b9-0e457ab92f58';
const operations={availability:['service','variant','zip','localDate'],prepare:['service','variant','zip','localDate','localTime','phone','name','address','details'],confirm:['holdId']};
const invalid=(message,status=400)=>Object.assign(new Error(message),{status});
function equal(a,b){if(typeof a!=='string'||a.length!==64)return false;let diff=0;for(let i=0;i<64;i++)diff|=a.charCodeAt(i)^b.charCodeAt(i);return diff===0;}
export function createBookingHandler(db,{secret,enabled=false}={}){
 return async request=>{
  try{
   if(request.method!=='POST')return json({error:'POST required'},405);
   if(!enabled||!secret||secret.length<32)throw invalid('Phone booking is not enabled',503);
   const stamp=request.headers.get('X-Voice-Timestamp')||'';
   if(!/^\d+$/.test(stamp)||Math.abs(Date.now()/1000-Number(stamp))>60)throw invalid('Expired request',401);
   const body=await request.text();if(body.length>16384)throw invalid('Payload too large',413);
   if(!equal(request.headers.get('X-Voice-Signature'),await hmac(secret,`${stamp}.${body}`)))throw invalid('Invalid signature',401);
   let input;try{input=JSON.parse(body);}catch{throw invalid('Invalid JSON');}
   if(!input||typeof input!=='object'||Array.isArray(input))throw invalid('Invalid request');
   const {action,callId,payload}=input;
   if(Object.keys(input).some(k=>!['action','callId','payload'].includes(k))||!Object.hasOwn(operations,action)
    ||typeof callId!=='string'||callId.length<8||callId.length>160||!payload||typeof payload!=='object'||Array.isArray(payload)
    ||Object.keys(payload).some(k=>!operations[action].includes(k)))throw invalid('Invalid booking request');
   if(action==='confirm'&&!/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(payload.holdId||''))throw invalid('Invalid prepared booking');
   const result=await db.call(action,TENANT,callId,action==='confirm'?payload.holdId:payload);
   return json({ok:true,result});
  }catch(error){return failure(error);}
 };
}
