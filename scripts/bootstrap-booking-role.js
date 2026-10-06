// Optional direct-DB bootstrap for a new deployment. Never rotates an existing login.
import 'dotenv/config';
import postgres from 'postgres';
import {randomBytes} from 'node:crypto';
import {mkdir,writeFile} from 'node:fs/promises';
const url=process.env.MIGRATION_DATABASE_URL;
if(!url||(!url.includes('wxamwhfmelxqahkdtcci')&&process.env.ALLOW_LOCAL_DATABASE!=='true'))throw new Error('Set MIGRATION_DATABASE_URL for WPacquisition');
const sql=postgres(url,{ssl:process.env.ALLOW_LOCAL_DATABASE==='true'?false:'require',prepare:false,max:1});
try{
 const login='sms_voice_booking_login';
 if((await sql`select 1 from pg_roles where rolname=${login}`).length)throw new Error('Booking login already exists; rotate explicitly');
 const password=randomBytes(32).toString('hex'),secret=randomBytes(32).toString('hex');
 const parsed=new URL(url);parsed.username=login+(parsed.username.includes('.')?'.wxamwhfmelxqahkdtcci':'');parsed.password=password;
 await mkdir('data',{recursive:true});
 // Save recovery credentials before provisioning, so a file failure cannot orphan the login.
 await writeFile('data/voice-booking-credentials.env',`VOICE_BOOKING_DATABASE_URL=${parsed.href}\nSONI_BOOKING_SECRET=${secret}\nVOICE_BOOKING_ENABLED=false\n`,{flag:'wx',mode:0o600});
 await sql.unsafe(`create role ${login} login password '${password}' in role sms_voice_booking`);
 console.log('Created restricted booking login. Credentials saved in ignored data/voice-booking-credentials.env; booking remains disabled.');
}finally{await sql.end();}
