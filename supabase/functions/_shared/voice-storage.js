import {env} from './http.js';
const bucket='voice-recordings';
export function voiceStorage(fetchImpl=fetch) {
 const base=()=>env('SUPABASE_URL'), key=()=>env('SUPABASE_SERVICE_ROLE_KEY');
 const path=p=>p.split('/').map(encodeURIComponent).join('/');
 async function request(route,body,method='POST') {
  if(!base()||!key())throw new Error('Voice storage is not configured');
  const response=await fetchImpl(`${base()}/storage/v1/${route}`,{method,headers:{Authorization:`Bearer ${key()}`,apikey:key(),'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
  if(!response.ok)throw new Error('Private recording storage unavailable');
  return response.json();
 }
 function absolute(url){return url?.startsWith('/storage/v1/')?`${base()}${url}`:`${base()}/storage/v1${url?.startsWith('/')?'':'/'}${url}`;}
 return {
  async upload(p){const r=await request(`object/upload/sign/${bucket}/${path(p)}`,{});return {signedUrl:absolute(r.url||r.signedURL||r.signedUrl),token:r.token};},
  async playback(p){const r=await request(`object/sign/${bucket}/${path(p)}`,{expiresIn:300});return {signedUrl:absolute(r.signedURL||r.signedUrl),expiresIn:300};},
  async verify(p,bytes){const r=await request(`object/info/${bucket}/${path(p)}`,undefined,'GET');
   if(Number(r.metadata?.size??r.size)!==Number(bytes)||!String(r.metadata?.mimetype??r.content_type??r.contentType??'').startsWith('audio/ogg'))throw new Error('Recording upload is incomplete');},
  async remove(paths){if(paths.length)await request(`object/${bucket}`,{prefixes:paths},'DELETE');},
 };
}
