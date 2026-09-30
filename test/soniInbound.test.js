import test from 'node:test';
import assert from 'node:assert/strict';
import {createSoniInboundHandler} from '../supabase/functions/soni-voice-inbound/handler.js';
import {twilioSignature} from '../supabase/functions/twilio-webhook/handler.js';

const url='https://wxamwhfmelxqahkdtcci.supabase.co/functions/v1/soni-voice-inbound';
const account='AC'+'0'.repeat(32);
const number='+18777574365';
const token='test-token';
const params={AccountSid:account,To:number,From:'+13035550122',CallSid:'CA123'};
const db={call:async()=>({tenant_id:'opek',from_number:number,auth_token:token})};
const handler=createSoniInboundHandler(db,{base:url,sipUsername:'opek_soni_inbound',sipPassword:'S'.repeat(32)});

test('signed Opek voice webhook forwards only the approved number to LiveKit',async()=>{
  const signature=await twilioSignature(token,url,params);
  const response=await handler(new Request(url,{method:'POST',
    headers:{'Content-Type':'application/x-www-form-urlencoded','X-Twilio-Signature':signature},
    body:new URLSearchParams(params)}));
  assert.equal(response.status,200);
  const twiml=await response.text();
  assert.match(twiml,/sip:\+18777574365@65qezov0v3b\.sip\.livekit\.cloud;transport=tcp/);
  assert.match(twiml,/username="opek_soni_inbound"/);
  const bad=await handler(new Request(url,{method:'POST',
    headers:{'Content-Type':'application/x-www-form-urlencoded','X-Twilio-Signature':'bad'},
    body:new URLSearchParams(params)}));
  assert.equal(bad.status,403);
  const other=await handler(new Request(url,{method:'POST',
    headers:{'Content-Type':'application/x-www-form-urlencoded','X-Twilio-Signature':signature},
    body:new URLSearchParams({...params,To:'+18313187139'})}));
  assert.equal(other.status,403);
});
