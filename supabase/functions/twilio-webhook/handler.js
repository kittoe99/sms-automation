import {json,env,failure} from '../_shared/http.js';
export function constantEqual(a,b) {
 const x=new TextEncoder().encode(a || ''),y=new TextEncoder().encode(b || '');let delta=x.length^y.length;
 for(let i=0;i<Math.max(x.length,y.length);i++) delta|=(x[i] || 0)^(y[i] || 0);return delta===0;
}
export async function twilioSignature(token,url,params) {
 const data=url+Object.keys(params).sort().map(k=>k+params[k]).join('');
 const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(token),{name:'HMAC',hash:'SHA-1'},false,['sign']);
 const bytes=new Uint8Array(await crypto.subtle.sign('HMAC',key,new TextEncoder().encode(data)));
 return btoa(String.fromCharCode(...bytes));
}
export function createTwilioHandler(db,base=env('SMS_WEBHOOK_BASE_URL')) {
 return async request=>{
  try {
   if(request.method!=='POST') return json({error:'POST required'},405);
   const url=new URL(request.url),event=url.pathname.split('/').at(-1);
   if(!['inbound','status','call'].includes(event)) return json({error:'Unknown webhook'},404);
   if(!request.headers.get('Content-Type')?.startsWith('application/x-www-form-urlencoded')) return json({error:'Form content required'},415);
   const raw=await request.text();if(raw.length>65536) return json({error:'Payload too large'},413);
   const form=new URLSearchParams(raw),params=Object.fromEntries(form);
   if([...form.keys()].length!==Object.keys(params).length) return json({error:'Duplicate fields'},400);
   const config=await db.call('webhook_credentials',params.AccountSid);
   if(!config?.auth_token || !base || new URL(base).protocol!=='https:') return json({error:'Webhook not configured'},403);
   const canonical=base.replace(/\/$/,'')+'/'+event+url.search;
   const signature=await twilioSignature(config.auth_token,canonical,params);
   if(!constantEqual(signature,request.headers.get('X-Twilio-Signature'))) return json({error:'Invalid signature'},403);
   if(event==='inbound' && config.from_number && params.To!==config.from_number) return json({error:'Wrong receiving number'},403);
   if(event==='status' && url.searchParams.has('attempt_id')) params.attempt_id=url.searchParams.get('attempt_id');
   await db.call('record_webhook',config.tenant_id,event,params);
   return new Response('<Response/>',{status:200,headers:{'Content-Type':'text/xml','Cache-Control':'no-store'}});
  } catch(error) {return failure(error);}
 };
}
