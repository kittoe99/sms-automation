import { createRemoteJWKSet, jwtVerify } from 'jose';
import postgres from 'postgres';
const env = name => globalThis.Deno?.env.get(name) ?? globalThis.process?.env[name];
export { env };
export const json = (value,status=200,headers={}) => new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json','Cache-Control':'no-store',...headers}});
export function database(variable) {
 let sql;
 return { async call(name,...args) {
  if(!/^[a-z_]+$/.test(name)) throw new Error('Invalid operation');
  const url=env(variable); if(!url) throw new Error(`${variable} is not configured`);
  sql ??=postgres(url,{ssl:'require',prepare:false,max:2,connect_timeout:5,idle_timeout:10,connection:{statement_timeout:8000}});
  const r=await sql.unsafe(`select sms_private.${name}(${args.map((_,i)=>'$'+(i+1)).join(',')}) as result`,args);
  return r[0]?.result;
 }};
}
let jwks;
export async function authenticate(request) {
 const issuer=env('CLERK_ISSUER'); const origins=(env('CRM_ALLOWED_ORIGINS') || '').split(',').map(x=>x.trim()).filter(Boolean);
 if(!issuer || !origins.length) throw new Error('Clerk issuer and allowed origins are required');
 const authorization=request.headers.get('Authorization') || '';
 if(!authorization.startsWith('Bearer ')) throw Object.assign(new Error('Sign in required'),{status:401});
 jwks ??=createRemoteJWKSet(new URL('/.well-known/jwks.json',issuer));
 try {
   const {payload}=await jwtVerify(authorization.slice(7),jwks,{issuer,algorithms:['RS256'],requiredClaims:['sub','exp','iat','azp']});
   if(!origins.includes(payload.azp)) throw new Error('Untrusted authorized party');
   return payload.sub;
 } catch {throw Object.assign(new Error('Invalid session'),{status:401});}
}
export function cors(request) {
 const origin=request.headers.get('Origin');
 if(origin && !(env('CRM_ALLOWED_ORIGINS') || '').split(',').map(s=>s.trim()).includes(origin)) throw Object.assign(new Error('Origin denied'),{status:403});
 return {'Access-Control-Allow-Origin':origin || 'null','Vary':'Origin','Access-Control-Allow-Headers':'authorization,content-type,x-tenant-id,idempotency-key','Access-Control-Allow-Methods':'GET,POST,PUT,DELETE,PATCH,OPTIONS'};
}
export async function readJson(request) {
 const text=await request.text(); if(text.length>65536) throw Object.assign(new Error('Payload too large'),{status:413});
 try{return text ? JSON.parse(text):{};}catch{throw Object.assign(new Error('Invalid JSON'),{status:400});}
}
export function failure(error,headers={}) {
 const status=error.status || (error.code==='42501'?403:error.code==='23505'?409:['P0001','22P02','23514','P0002','23502'].includes(error.code)?400:500);
 console.error(JSON.stringify({event:'request_failed',code:error.code || 'REQUEST_ERROR',status}));
 return json({error:status>=500?'Service temporarily unavailable':error.message},status,headers);
}
