import {readFile,readdir} from 'node:fs/promises';
import {resolve,sep} from 'node:path';
import {pathToFileURL} from 'node:url';
import {testDatabase,call} from './database.js';
const crm='https://staff.example.test',customer='https://customer.example.test';
const profile={businessName:'Example Services',contactEmail:'owner@example.test',contactPhone:'+13035550123',summary:'Home repairs and maintenance.',services:['Home repairs'],locations:['Denver'],timeZone:'America/Denver'};
export const selection={accountSid:'AC'+'1'.repeat(32),messagingServiceSid:'MG'+'2'.repeat(32),phoneNumberSid:'PN'+'3'.repeat(32),phoneNumber:'+18775550180',
 profileSid:'BU'+'4'.repeat(32),profileName:'Example Services LLC',legalBusinessName:'Example Services LLC',accountName:'Platform',serviceName:'Example SMS',senderType:'toll_free',registrationSid:'HH'+'5'.repeat(32),revision:0};
export async function fixture(options={}) {
 const db=await testDatabase(options);
 try {
  const directory=process.env.E2_PROJECT_ROOT?pathToFileURL(resolve(process.env.E2_PROJECT_ROOT,'supabase/migrations')+sep):new URL('../../../E2local-main/supabase/migrations/',import.meta.url);
  for(const file of (await readdir(directory)).filter(f=>f.endsWith('.sql')).sort())await db.exec(await readFile(new URL(file,directory),'utf8'));
  await db.query('select public.configure_platform_login_realms($1,$2)',[customer,crm]);
  const account=async(subject,issuer)=>{
   const id=(await db.query('select public.sync_platform_account($1,$2,$2,null,1) id',[issuer,subject])).rows[0].id;
   await db.query('update public.dashboard_accounts set personal_info=$2 where id=$1',[id,JSON.stringify({firstName:'Example',lastName:'Owner',phone:'+13035550123',role:'Owner'})]);return id;
  };
  const admin=await account('staff',crm),reader=await account('reader',crm);
  await db.query('insert into public.platform_staff_grants(account_id) values($1)',[admin]);
  await db.query("select set_config('platform.actor_issuer',$1,false)",[crm]);
  const business=async(subject)=>{
   const owner=await account(subject,customer);await db.query('select public.complete_platform_onboarding($1,$2)',[owner,JSON.stringify(profile)]);
   const tenant=(await db.query('select tenant_id from public.dashboard_business_profiles where account_id=$1',[owner])).rows[0].tenant_id;
   await call(db,'platform_action','staff','business_profile_review',{tenantId:tenant,revision:0,profile});return {owner,tenant};
  };
  return {db,admin,reader,business};
 }catch(error){await db.close();throw error;}
}
