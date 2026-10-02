import {database,json,failure} from '../_shared/http.js';
import {constantEqual} from '../twilio-webhook/handler.js';
const db=database('SMS_WEBHOOK_DATABASE_URL');
Deno.serve(async request=>{
 try {
  if(request.method!=='POST') return json({error:'POST required'},405);
  const tenant=request.headers.get('X-Tenant-ID'),stamp=request.headers.get('X-Event-Timestamp') || '';
  if(!/^\d+$/.test(stamp)||Math.abs(Date.now()/1000-Number(stamp))>300) return json({error:'Expired event'},403);
  const body=await request.text();if(body.length>65536) return json({error:'Payload too large'},413);
  const secret=await db.call('integration_credentials',tenant);if(!secret) return json({error:'Integration not configured'},403);
  const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign']);
  const bytes=new Uint8Array(await crypto.subtle.sign('HMAC',key,new TextEncoder().encode(`${stamp}.${body}`)));
  const signature=Array.from(bytes,b=>b.toString(16).padStart(2,'0')).join('');
  if(!constantEqual(signature,request.headers.get('X-Event-Signature'))) return json({error:'Invalid signature'},403);
  const p=JSON.parse(body);if(!p.eventId || !p.id || !p.phone) return json({error:'eventId, id and phone required'},400);
  return json(await db.call('ingest_event',tenant,p),202);
 }catch(error){return failure(error);}
});
