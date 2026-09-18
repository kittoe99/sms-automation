import 'dotenv/config';
import postgres from 'postgres';
import {randomBytes} from 'node:crypto';
import {writeFile,readFile,mkdir} from 'node:fs/promises';
const url=process.env.MIGRATION_DATABASE_URL;
const admin=process.env.CRM_ADMIN_CLERK_USER_ID;
if(!url||!admin) throw new Error('Set MIGRATION_DATABASE_URL and CRM_ADMIN_CLERK_USER_ID');
if(!url.includes('wxamwhfmelxqahkdtcci') && process.env.ALLOW_LOCAL_DATABASE!=='true') throw new Error('Database must target WPacquisition');
const sql=postgres(url,{ssl:process.env.ALLOW_LOCAL_DATABASE==='true'?false:'require',prepare:false,max:1});
const outputs={};
try {
 await sql.begin(async tx=>{
   await tx`insert into sms_private.admins(clerk_user_id) values(${admin}) on conflict do nothing`;
   for(const role of ['sms_api','sms_webhook','sms_sender','sms_automation','sms_ai']) {
     const login=role+'_login',password=randomBytes(32).toString('hex');
     const exists=await tx`select 1 from pg_roles where rolname=${login}`;
     if(exists.length) throw new Error(`${login} already exists; use the existing secret file or explicitly rotate credentials`);
     await tx.unsafe(`create role ${login} login password '${password}' in role ${role}`);
     const parsed=new URL(url),suffix=parsed.username.includes('.')?'.wxamwhfmelxqahkdtcci':'';
     parsed.username=login+suffix;parsed.password=password; outputs[role]=parsed.href;
   }
 });
 await mkdir('data',{recursive:true});
 await writeFile('data/worker-credentials.env',[
   `SMS_API_DATABASE_URL=${outputs.sms_api}`,`SMS_WEBHOOK_DATABASE_URL=${outputs.sms_webhook}`,
   `SMS_SENDER_DATABASE_URL=${outputs.sms_sender}`,`SMS_AUTOMATION_DATABASE_URL=${outputs.sms_automation}`,`SMS_AI_DATABASE_URL=${outputs.sms_ai}`,
 ].join('\n')+'\n',{flag:'wx',mode:0o600});
 console.log('Created scoped database logins. Credentials saved in ignored data/worker-credentials.env; values are not printed.');
} finally {await sql.end();}
