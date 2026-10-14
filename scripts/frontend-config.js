import {readFile} from 'node:fs/promises';

export async function frontendConfig(env=process.env) {
  const environment=env.CRM_ENVIRONMENT||'production';
  if(!/^[a-z][a-z0-9-]*$/.test(environment))throw new Error('Invalid CRM_ENVIRONMENT');
  const approved=JSON.parse(await readFile(new URL(`../config/environments/${environment}.json`,import.meta.url),'utf8'));
  for(const [name,field] of Object.entries({SUPABASE_URL:'supabaseUrl',CRM_API_BASE:'apiBase',HOSTING_API_BASE:'hostingApiBase',PUBLIC_FORM_BASE_URL:'embedBaseUrl'})) {
    if(env[name] && env[name]!==approved[field])throw new Error(`${name} does not match the reviewed ${environment} environment`);
    const url=new URL(approved[field]);
    if(url.protocol!=='https:'||url.username||url.password)throw new Error(`Invalid ${field} in environment manifest`);
  }
  if(!/^sb_publishable_[a-zA-Z0-9_-]+$/.test(env.SUPABASE_PUBLISHABLE_KEY||''))throw new Error('Use a Supabase publishable key, never a secret or service role key');
  if(approved.apiBase!==`${approved.supabaseUrl}/functions/v1/crm-api`)throw new Error('CRM API and Supabase environment must match');
  return {apiBase:approved.apiBase,supabaseUrl:approved.supabaseUrl,supabasePublishableKey:env.SUPABASE_PUBLISHABLE_KEY,
    formApiBase:`${approved.supabaseUrl}/functions/v1/web-form`,embedBaseUrl:approved.embedBaseUrl,hostingApiBase:approved.hostingApiBase};
}
