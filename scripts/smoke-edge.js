import fs from 'node:fs';
import dotenv from 'dotenv';
const config=dotenv.parse(fs.readFileSync('data/edge-secrets.env'));
const base='https://wxamwhfmelxqahkdtcci.supabase.co/functions/v1';
const targets={
  'sms-worker':'SMS_WORKER_SECRET',
  'automation-worker':'AUTOMATION_WORKER_SECRET',
  'ai-worker':'AI_WORKER_SECRET',
  'provisioning-worker':'PROVISIONING_WORKER_SECRET',
  'knowledge-worker':'KNOWLEDGE_WORKER_SECRET',
  'embedding-worker':'EMBEDDING_WORKER_SECRET',
  'handoff-worker':'HANDOFF_WORKER_SECRET',
  'compliance-worker':'COMPLIANCE_WORKER_SECRET',
};
for(const [name,key] of Object.entries(targets)) {
 for(const valid of [false,true]) {
  const r=await fetch(`${base}/${name}`,{method:'POST',headers:{Authorization:`Bearer ${valid?config[key]:'invalid'}`},signal:AbortSignal.timeout(20000)});
  const body=await r.json();console.log(JSON.stringify({function:name,authenticated:valid,status:r.status,result:body.status || body.error || body.code,processed:body.processed}));
 }
}
for(const path of ['crm-api/auth/config','crm-api/tenants','twilio-webhook/inbound','business-events']) {
 const r=await fetch(`${base}/${path}`,{method:path.includes('webhook')||path==='business-events'?'POST':'GET',signal:AbortSignal.timeout(20000)});
 console.log(JSON.stringify({endpoint:path,status:r.status}));
}
