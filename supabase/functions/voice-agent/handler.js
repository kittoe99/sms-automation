import {json,failure} from '../_shared/http.js';

const encoder=new TextEncoder();
const TENANT='opek';
const ACTIONS=new Set([
  'verify.start','verify.check','customer.lookup','intake.create','record.update',
  'booking.prepare','booking.confirm','booking.cancel','sms.send',
]);

async function hmac(secret,value) {
  const key=await crypto.subtle.importKey('raw',encoder.encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign']);
  const bytes=new Uint8Array(await crypto.subtle.sign('HMAC',key,encoder.encode(value)));
  return Array.from(bytes,b=>b.toString(16).padStart(2,'0')).join('');
}
function equalHex(a,b) {
  if(typeof a!=='string'||typeof b!=='string'||a.length!==64||b.length!==64)return false;
  let diff=0;for(let i=0;i<64;i++)diff|=a.charCodeAt(i)^b.charCodeAt(i);
  return diff===0;
}
function invalid(message,status=400){return Object.assign(new Error(message),{status});}

export function createVoiceHandler(db,{secret,otpSecret}={}) {
  return async request=>{
    try {
      if(request.method!=='POST')return json({error:'POST required'},405);
      if(!secret||secret.length<32||!otpSecret||otpSecret.length<32)
        throw invalid('Voice bridge is not configured',503);
      const stamp=request.headers.get('X-Voice-Timestamp')||'';
      if(!/^\d+$/.test(stamp)||Math.abs(Date.now()/1000-Number(stamp))>60)
        throw invalid('Expired request',401);
      const body=await request.text();
      if(body.length>16384)throw invalid('Payload too large',413);
      const signature=await hmac(secret,`${stamp}.${body}`);
      if(!equalHex(signature,request.headers.get('X-Voice-Signature')))
        throw invalid('Invalid signature',401);
      let input;try{input=JSON.parse(body);}catch{throw invalid('Invalid JSON');}
      const {action,callId,callerNumber,payload={},requestId}=input;
      if(!ACTIONS.has(action)||typeof callId!=='string'||callId.length<8||callId.length>160
        ||!payload||typeof payload!=='object'||Array.isArray(payload))throw invalid('Invalid action');
      if(callerNumber!==null&&callerNumber!==undefined&&!/^\+[1-9]\d{7,14}$/.test(callerNumber))
        throw invalid('Invalid caller number');
      let result;
      switch(action){
        case 'verify.start': {
          const phone=String(payload.phone||'');
          if(!/^\+[1-9]\d{7,14}$/.test(phone))throw invalid('Valid phone required');
          const number=new Uint32Array(1);crypto.getRandomValues(number);
          const code=String(number[0]%1000000).padStart(6,'0');
          const digest=await hmac(otpSecret,`${TENANT}.${callId}.${phone}.${code}`);
          result=await db.call('voice_start_otp',TENANT,callId,phone,digest,
            `Your Opek verification code is ${code}. It expires in five minutes.`);
          break;
        }
        case 'verify.check': {
          const phone=String(payload.phone||''),code=String(payload.code||'');
          if(!/^\+[1-9]\d{7,14}$/.test(phone)||!/^\d{6}$/.test(code))throw invalid('Invalid code');
          const digest=await hmac(otpSecret,`${TENANT}.${callId}.${phone}.${code}`);
          result=await db.call('voice_verify_otp',TENANT,callId,phone,digest);
          break;
        }
        case 'customer.lookup':
          result=await db.call('voice_lookup',TENANT,callId,String(payload.phone||''));break;
        case 'intake.create':
          if(!['contacts','quote_requests'].includes(payload.type)||typeof requestId!=='string'
            ||requestId.length<8||requestId.length>160)throw invalid('Invalid intake request');
          result=await db.call('voice_create_intake',TENANT,callId,payload.type,payload.record||{},requestId);break;
        case 'record.update':
          result=await db.call('voice_update_record',TENANT,callId,String(payload.phone||''),
            String(payload.type||''),String(payload.id||''),payload.patch||{});break;
        case 'booking.prepare':
          result=await db.call('voice_prepare_booking',TENANT,callId,payload);break;
        case 'booking.confirm':
          if(!/^[0-9a-f]{8}-[0-9a-f-]{27,}$/.test(String(payload.holdId||'')))
            throw invalid('Invalid hold');
          result=await db.call('voice_confirm_booking',TENANT,callId,payload.holdId,callerNumber||null);break;
        case 'booking.cancel':
          if(typeof requestId!=='string'||requestId.length<8||requestId.length>160)
            throw invalid('Idempotency key required');
          result=await db.call('voice_cancel_booking',TENANT,callId,String(payload.phone||''),
            String(payload.bookingId||''),requestId);break;
        case 'sms.send':
          if(typeof requestId!=='string'||requestId.length<8||requestId.length>160)
            throw invalid('Idempotency key required');
          result=await db.call('voice_send_sms',TENANT,callId,String(payload.phone||''),
            callerNumber||null,String(payload.body||''),requestId);break;
      }
      return json({ok:true,result});
    }catch(error){return failure(error);}
  };
}

export {hmac};
