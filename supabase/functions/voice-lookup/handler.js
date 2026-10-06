import {json,failure} from '../_shared/http.js';
import {hmac} from '../voice-agent/handler.js';

const TENANT='biz-1c0c09ce-819e-4795-86b9-0e457ab92f58';
const ACTIONS=new Set(['business.lookup','verify.start','verify.check','customer.lookup']);
function invalid(message,status=400){return Object.assign(new Error(message),{status});}
function equalHex(a,b){
  if(typeof a!=='string'||typeof b!=='string'||a.length!==64||b.length!==64)return false;
  let different=0;for(let i=0;i<64;i++)different|=a.charCodeAt(i)^b.charCodeAt(i);
  return different===0;
}
export function createLookupHandler(db,{secret,otpSecret}={}){
  return async request=>{
    try{
      if(request.method!=='POST')return json({error:'POST required'},405);
      if(!secret||secret.length<32||!otpSecret||otpSecret.length<32)throw invalid('Lookup bridge unavailable',503);
      const stamp=request.headers.get('X-Voice-Timestamp')||'';
      if(!/^\d+$/.test(stamp)||Math.abs(Date.now()/1000-Number(stamp))>60)throw invalid('Expired request',401);
      const body=await request.text();
      if(body.length>4096)throw invalid('Payload too large',413);
      const signature=await hmac(secret,`${stamp}.${body}`);
      if(!equalHex(signature,request.headers.get('X-Voice-Signature')))throw invalid('Invalid signature',401);
      let input;try{input=JSON.parse(body);}catch{throw invalid('Invalid JSON');}
      if(!input||typeof input!=='object'||Array.isArray(input))throw invalid('Invalid request');
      const {action,callId,payload={}}=input;
      if(Object.keys(input).some(k=>!['action','callId','payload'].includes(k))||!ACTIONS.has(action)
        ||typeof callId!=='string'||callId.length<8||callId.length>160
        ||!payload||typeof payload!=='object'||Array.isArray(payload))throw invalid('Invalid request');
      let result;
      if(action==='business.lookup'){
        if(Object.keys(payload).some(k=>k!=='query')||typeof payload.query!=='string'||payload.query.length>500)
          throw invalid('Invalid search');
        result=await db.call('voice_read_business',TENANT,payload.query);
      }else{
        const phone=payload.phone;
        if(typeof phone!=='string'||!/^\+[1-9]\d{7,14}$/.test(phone))throw invalid('Valid phone required');
        if(Object.keys(payload).some(k=>!['phone',...(action==='verify.check'?['code']:[])].includes(k)))
          throw invalid('Invalid payload');
        if(action==='verify.start'){
          const random=new Uint32Array(1);crypto.getRandomValues(random);
          const code=String(random[0]%1000000).padStart(6,'0');
          const digest=await hmac(otpSecret,`${TENANT}.${callId}.${phone}.${code}`);
          result=await db.call('voice_read_start_otp',TENANT,callId,phone,digest,
            `Your business booking verification code is ${code}. It expires in five minutes.`);
        }else if(action==='verify.check'){
          if(typeof payload.code!=='string'||!/^\d{6}$/.test(payload.code))throw invalid('Invalid code');
          const digest=await hmac(otpSecret,`${TENANT}.${callId}.${phone}.${payload.code}`);
          result=await db.call('voice_read_verify_otp',TENANT,callId,phone,digest);
        }else result=await db.call('voice_read_customer',TENANT,callId,phone);
      }
      return json({ok:true,result});
    }catch(error){return failure(error);}
  };
}
