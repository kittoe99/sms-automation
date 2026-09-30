import {json,env,failure} from '../_shared/http.js';
import {constantEqual,twilioSignature} from '../twilio-webhook/handler.js';

const OPEK_NUMBER='+18777574365';
const SIP_HOST='65qezov0v3b.sip.livekit.cloud';

function safeAttribute(value) {
  if(!/^[A-Za-z0-9_-]{12,128}$/.test(value||'')) throw Object.assign(new Error('SIP access is not configured'),{status:503});
  return value;
}

export function createSoniInboundHandler(db,{
  base=env('SONI_VOICE_WEBHOOK_URL'),
  sipUsername=env('SONI_SIP_USERNAME'),
  sipPassword=env('SONI_SIP_PASSWORD'),
}={}) {
  return async request=>{
    try{
      if(request.method!=='POST')return json({error:'POST required'},405);
      if(!base||new URL(base).protocol!=='https:')throw Object.assign(new Error('Voice routing is not configured'),{status:503});
      const username=safeAttribute(sipUsername),password=safeAttribute(sipPassword);
      if(!request.headers.get('Content-Type')?.startsWith('application/x-www-form-urlencoded'))
        return json({error:'Form content required'},415);
      const raw=await request.text();if(raw.length>8192)return json({error:'Payload too large'},413);
      const form=new URLSearchParams(raw),params=Object.fromEntries(form);
      if([...form.keys()].length!==Object.keys(params).length)return json({error:'Duplicate fields'},400);
      if(params.To!==OPEK_NUMBER||!/^AC[0-9a-f]{32}$/i.test(params.AccountSid||''))
        return json({error:'Wrong destination'},403);
      const config=await db.call('webhook_credentials',params.AccountSid);
      if(config?.tenant_id!=='opek'||config.from_number!==OPEK_NUMBER||!config.auth_token)
        return json({error:'Unknown account'},403);
      const signature=await twilioSignature(config.auth_token,base,params);
      if(!constantEqual(signature,request.headers.get('X-Twilio-Signature')))
        return json({error:'Invalid signature'},403);
      const body=`<?xml version="1.0" encoding="UTF-8"?><Response><Dial><Sip username="${username}" password="${password}">sip:${OPEK_NUMBER}@${SIP_HOST};transport=tcp</Sip></Dial></Response>`;
      return new Response(body,{status:200,headers:{'Content-Type':'text/xml; charset=utf-8','Cache-Control':'no-store'}});
    }catch(error){return failure(error);}
  };
}
