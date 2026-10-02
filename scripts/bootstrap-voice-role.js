import 'dotenv/config';
import postgres from 'postgres';
import {randomBytes} from 'node:crypto';
import {mkdir,writeFile} from 'node:fs/promises';

const url=process.env.MIGRATION_DATABASE_URL;
if(!url)throw new Error('Set MIGRATION_DATABASE_URL');
if(!url.includes('wxamwhfmelxqahkdtcci')&&process.env.ALLOW_LOCAL_DATABASE!=='true')
  throw new Error('Database must target WPacquisition');
const sql=postgres(url,{ssl:process.env.ALLOW_LOCAL_DATABASE==='true'?false:'require',prepare:false,max:1});
try{
  const login='sms_voice_login';
  if((await sql`select 1 from pg_roles where rolname=${login}`).length)
    throw new Error(`${login} already exists; rotate its credential explicitly`);
  const password=randomBytes(32).toString('hex');
  await sql.unsafe(`create role ${login} login password '${password}' in role sms_voice`);
  const parsed=new URL(url),suffix=parsed.username.includes('.')?'.wxamwhfmelxqahkdtcci':'';
  parsed.username=login+suffix;parsed.password=password;
  await mkdir('data',{recursive:true});
  await writeFile('data/voice-agent-credentials.env',[
    `VOICE_AGENT_DATABASE_URL=${parsed.href}`,
    `SONI_BRIDGE_SECRET=${randomBytes(32).toString('hex')}`,
    `SONI_OTP_SECRET=${randomBytes(32).toString('hex')}`,
  ].join('\n')+'\n',{flag:'wx',mode:0o600});
  console.log('Created voice role. Secrets saved in ignored data/voice-agent-credentials.env.');
}finally{await sql.end();}
