import 'dotenv/config';
import postgres from 'postgres';
const tenant=process.argv[2];
if(!tenant||!process.env.MIGRATION_DATABASE_URL) throw new Error('Usage: node scripts/configure-provider.js <business-id> with MIGRATION_DATABASE_URL');
const account=process.env.TWILIO_ACCOUNT_SID,token=process.env.TWILIO_AUTH_TOKEN;
if(!/^AC[0-9a-f]{32}$/i.test(account||'')||!token) throw new Error('Twilio account credentials required');
const sql=postgres(process.env.MIGRATION_DATABASE_URL,{ssl:'require',prepare:false,max:1});
try {
 await sql.begin(async tx=>{
   const [b]=await tx`select tenant_id from public.sms_businesses where tenant_id=${tenant} for update`;
   if(!b) throw new Error('Business does not exist');
   const [secret]=await tx`select vault.create_secret(${token}) as id`;
   await tx`insert into sms_private.providers(tenant_id,account_sid,auth_secret_id,messaging_service_sid,from_number,provisioning_state)
   values(${tenant},${account},${secret.id},${process.env.TWILIO_MESSAGING_SERVICE_SID||null},${process.env.TWILIO_FROM_NUMBER||null},'configured')
   on conflict(tenant_id) do update set account_sid=excluded.account_sid,auth_secret_id=excluded.auth_secret_id,messaging_service_sid=excluded.messaging_service_sid,from_number=excluded.from_number,provisioning_state='configured'`;
 });
 console.log('Provider stored in Vault for the selected business. Sending was not enabled.');
}finally{await sql.end();}
