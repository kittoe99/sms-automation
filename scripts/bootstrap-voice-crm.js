// Deployment-only bootstrap. Save credentials first; never overwrite existing logins.
import 'dotenv/config';
import postgres from 'postgres';
import {randomBytes} from 'node:crypto';
import {mkdir,writeFile} from 'node:fs/promises';
const url=process.env.MIGRATION_DATABASE_URL;
if(!url||(!url.includes('wxamwhfmelxqahkdtcci')&&process.env.ALLOW_LOCAL_DATABASE!=='true'))throw new Error('Set the owning migration database URL');
const sql=postgres(url,{ssl:process.env.ALLOW_LOCAL_DATABASE==='true'?false:'require',prepare:false,max:1});
try{
 const roles=['sms_voice_runtime_login','sms_voice_maintenance_login'];
 if((await sql`select 1 from pg_roles where rolname=any(${roles})`).length)throw new Error('Voice CRM login exists; use saved credentials or rotate explicitly');
 const secrets=roles.map(()=>randomBytes(32).toString('hex')),passwords=roles.map(()=>randomBytes(32).toString('hex'));
 const urls=roles.map((role,i)=>{const u=new URL(url);u.username=role+(u.username.includes('.')?'.wxamwhfmelxqahkdtcci':'');u.password=passwords[i];return u.href;});
 await mkdir('data',{recursive:true});
 await writeFile('data/voice-crm-credentials.env',`VOICE_RUNTIME_DATABASE_URL=${urls[0]}\nVOICE_RUNTIME_SECRET=${secrets[0]}\nVOICE_MAINTENANCE_DATABASE_URL=${urls[1]}\nVOICE_MAINTENANCE_SECRET=${secrets[1]}\nVOICE_CRM_ENABLED=false\n`,{flag:'wx',mode:0o600});
 await sql.begin(async tx=>{
  for(let i=0;i<roles.length;i++)await tx.unsafe(`create role ${roles[i]} login password '${passwords[i]}' in role ${roles[i].replace('_login','')}`);
  const [vault]=await tx`select vault.create_secret(${secrets[1]}) as id`;
  await tx`insert into sms_private.voice_maintenance_settings(secret_id) values(${vault.id})`;
 });
 console.log('Restricted logins and maintenance configured. Recovery credentials saved under ignored data/. Runtime remains disabled.');
}finally{await sql.end();}
