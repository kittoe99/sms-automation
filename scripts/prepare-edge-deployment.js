import fs from 'node:fs';
import dotenv from 'dotenv';
const e=dotenv.parse(fs.readFileSync('data/edge-secrets.env'));
const map={sms_send_jobs:'SMS_WORKER_SECRET',automation_jobs:'AUTOMATION_WORKER_SECRET',ai_reply_jobs:'AI_WORKER_SECRET',provisioning_jobs:'PROVISIONING_WORKER_SECRET'};
const sql=Object.entries(map).map(([q,k])=>`update sms_private.edge_config set secret_id=vault.create_secret('${e[k]}') where queue='${q}' and secret_id is null;`).join('\n');
fs.writeFileSync('data/edge-vault.sql',sql);
const paths=[];
function walk(dir){for(const d of fs.readdirSync(dir,{withFileTypes:true})){const p=dir+'/'+d.name;if(d.isDirectory())walk(p);else if(/\.(js|ts|json)$/.test(p))paths.push(p);}}
walk('supabase/functions');
for(const file of ['sms.js','ai.js','automation.js','provisioning.js','providerHttp.js'])paths.push('src/workers/'+file);
paths.push('src/lib/automations/timeRules.js','src/lib/tenantContext.js','src/lib/dataMode.js');
fs.writeFileSync('data/edge-bundle.json',JSON.stringify(paths.map(name=>({name,content:fs.readFileSync(name,'utf8')}))));
console.log('Prepared Vault configuration and function bundle.');
