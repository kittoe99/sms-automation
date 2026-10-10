import { createRemoteJWKSet, jwtVerify } from 'jose';
import postgres from 'postgres';
const env = name => globalThis.Deno?.env.get(name) ?? globalThis.process?.env[name];
export { env };
export const json = (value,status=200,headers={}) => new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json','Cache-Control':'no-store',...headers}});
export function database(variable,{human=variable==='SMS_API_DATABASE_URL'}={}) {
 let sql;
 return { async call(name,...args) {
  if(!/^[a-z_]+$/.test(name)) throw new Error('Invalid operation');
  const url=env(variable); if(!url) throw new Error(`${variable} is not configured`);
  sql ??=postgres(url,{ssl:'require',prepare:false,max:2,connect_timeout:5,idle_timeout:10,connection:{statement_timeout:8000}});
  const query=`select sms_private.${name}(${args.map((_,i)=>'$'+(i+1)).join(',')}) as result`;
  // Human API calls carry the configured, JWT-verified issuer into the same
  // transaction as the RPC. Never leave request identity on a pooled session.
  if(human && !env('CRM_CLERK_ISSUER')) throw new Error('CRM Clerk issuer is required');
  const r=human ? await sql.begin(async tx=>{
    await tx`select set_config('platform.actor_issuer',${env('CRM_CLERK_ISSUER')},true)`;
    return tx.unsafe(query,args);
  }) : await sql.unsafe(query,args);
  return r[0]?.result;
 }};
}
export function crmLoginConfig() {
 const issuer=env('CRM_CLERK_ISSUER'),customerIssuer=env('E2_CLERK_ISSUER');
 const origins=(env('CRM_ALLOWED_ORIGINS') || '').split(',').map(x=>x.trim()).filter(Boolean);
 return {issuer,customerIssuer,origins};
}
export function createCrmAuthenticator({config=crmLoginConfig,keyForIssuer=issuer=>createRemoteJWKSet(new URL('/.well-known/jwks.json',issuer))}={}) {
 let cachedIssuer,key;
 return async request=>{
  const {issuer,customerIssuer,origins}=config();
  if(!/^https:\/\/[^/]+$/.test(issuer||'') || !/^https:\/\/[^/]+$/.test(customerIssuer||'') || issuer===customerIssuer || !origins.length)
    throw Object.assign(new Error('Separate CRM authentication is not configured'),{status:503});
  const authorization=request.headers.get('Authorization') || '';
  if(!authorization.startsWith('Bearer ')) throw Object.assign(new Error('Sign in required'),{status:401});
  if(cachedIssuer!==issuer){key=keyForIssuer(issuer);cachedIssuer=issuer;}
  try {
    const {payload}=await jwtVerify(authorization.slice(7),key,{issuer,algorithms:['RS256'],requiredClaims:['sub','exp','iat','azp']});
    if(typeof payload.sub!=='string' || !payload.sub || !origins.includes(payload.azp)) throw new Error('Untrusted session');
    return payload.sub;
  } catch {throw Object.assign(new Error('Invalid session'),{status:401});}
 };
}
export const authenticate=createCrmAuthenticator();
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
 const status=error.status || (error.code==='42501'?403:['23505','40001'].includes(error.code)?409:['P0001','22P02','22023','23514','P0002','23502'].includes(error.code)?400:500);
 console.error(JSON.stringify({event:'request_failed',code:error.code || 'REQUEST_ERROR',status}));
 return json({error:status>=500?'Service temporarily unavailable':error.message},status,headers);
}
