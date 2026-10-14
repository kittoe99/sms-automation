import fs from 'node:fs';
import dotenv from 'dotenv';
import {collectEdgeFiles} from './edge-files.js';
const bundleOnly=process.argv.includes('--bundle-only');
const e=bundleOnly?{}:dotenv.parse(fs.readFileSync('data/edge-secrets.env'));
const map={
  sms_send_jobs:'SMS_WORKER_SECRET',
  automation_jobs:'AUTOMATION_WORKER_SECRET',
  ai_reply_jobs:'AI_WORKER_SECRET',
  provisioning_jobs:'PROVISIONING_WORKER_SECRET',
  knowledge_ingest_jobs:'KNOWLEDGE_WORKER_SECRET',
  embedding_jobs:'EMBEDDING_WORKER_SECRET',
  handoff_alert_jobs:'HANDOFF_WORKER_SECRET',
  compliance_jobs:'COMPLIANCE_WORKER_SECRET',
};
fs.mkdirSync('data',{recursive:true});
if(!bundleOnly) {
  for(const name of Object.values(map))if(typeof e[name]!=='string'||e[name].length<32)throw new Error(`Missing worker secret: ${name}`);
  const literal=value=>`'${value.replaceAll("'","''")}'`;
  const sql=Object.entries(map).map(([q,k])=>`update sms_private.edge_config set secret_id=vault.create_secret(${literal(e[k])}) where queue='${q}' and secret_id is null;`).join('\n');
  fs.writeFileSync('data/edge-vault.sql',sql,{mode:0o600});
}
const files=await collectEdgeFiles();
fs.writeFileSync('data/edge-bundle.json',JSON.stringify(files));
console.log(`Prepared complete Edge source bundle (${files.length} files)${bundleOnly?'': ' and local Vault configuration'}.`);
