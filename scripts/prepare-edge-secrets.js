import fs from 'node:fs';
import crypto from 'node:crypto';
import dotenv from 'dotenv';
const local=dotenv.parse(fs.readFileSync('.env'));
const scoped=dotenv.parse(fs.readFileSync('data/worker-credentials.env'));
const prior=fs.existsSync('data/edge-secrets.env')?dotenv.parse(fs.readFileSync('data/edge-secrets.env')):{};
const result={...prior,...scoped};
for(const name of [
  'SMS_WORKER_SECRET',
  'AUTOMATION_WORKER_SECRET',
  'AI_WORKER_SECRET',
  'PROVISIONING_WORKER_SECRET',
  'KNOWLEDGE_WORKER_SECRET',
  'EMBEDDING_WORKER_SECRET',
  'HANDOFF_WORKER_SECRET',
  'COMPLIANCE_WORKER_SECRET',
]) result[name] ||= crypto.randomBytes(32).toString('hex');
for(const name of [
  'CLERK_ISSUER',
  'CLERK_PUBLISHABLE_KEY',
  'CRM_ALLOWED_ORIGINS',
  'OPENAI_API_KEY',
  'SUPABASE_SERVICE_ROLE_KEY',
  'AI_INPUT_USD_PER_MILLION',
  'AI_OUTPUT_USD_PER_MILLION',
  'EMBEDDING_USD_PER_MILLION',
]) if(local[name]) result[name]=local[name];
result.SMS_WEBHOOK_BASE_URL='https://wxamwhfmelxqahkdtcci.supabase.co/functions/v1/twilio-webhook';
result.SMS_CALLBACK_URL=result.SMS_WEBHOOK_BASE_URL+'/status';
result.AI_MODEL='gpt-5.4-mini-2026-03-17';
result.EMBEDDING_MODEL='text-embedding-3-small';
result.AI_INPUT_USD_PER_MILLION ||= '0.75';
result.AI_OUTPUT_USD_PER_MILLION ||= '4.50';
result.EMBEDDING_USD_PER_MILLION ||= '0.02';
if(local.TWILIO_ACCOUNT_SID && local.TWILIO_AUTH_TOKEN) { result.TWILIO_MASTER_ACCOUNT_SID=local.TWILIO_ACCOUNT_SID;result.TWILIO_MASTER_AUTH_TOKEN=local.TWILIO_AUTH_TOKEN; }
fs.writeFileSync('data/edge-secrets.env',Object.entries(result).map(([k,v])=>`${k}=${v}`).join('\n')+'\n');
console.log('Prepared Edge secrets; OpenAI key present:',Boolean(result.OPENAI_API_KEY));
