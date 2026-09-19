import 'dotenv/config';
const names=['SUPABASE_URL','SUPABASE_PUBLISHABLE_KEY','MIGRATION_DATABASE_URL','SMS_API_DATABASE_URL','SMS_WEBHOOK_DATABASE_URL','CLERK_PUBLISHABLE_KEY','CLERK_ISSUER','CRM_ADMIN_CLERK_USER_ID','CRM_ALLOWED_ORIGINS','OPENAI_API_KEY'];
for(const name of names) console.log(`${name}: ${process.env[name]?'set':'missing'}`);
if(process.env.SUPABASE_URL!=='https://wxamwhfmelxqahkdtcci.supabase.co') process.exitCode=1;
