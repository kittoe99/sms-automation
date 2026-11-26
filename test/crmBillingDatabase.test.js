import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {resolve,sep} from 'node:path';
import {pathToFileURL} from 'node:url';
import {testDatabase,call} from './helpers/database.js';
const staffIssuer='https://staff.example.test',customerIssuer='https://customer.example.test';
const profile={businessName:'Billing test business',contactEmail:'owner@example.test',contactPhone:'+13035550123',summary:'Local moving.',services:['Moving'],locations:['Denver'],timeZone:'America/Denver'};

test('staff billing reads, audits and business-list summary over the paired schema',async()=>{
 const db=await testDatabase();
 try {
  const dir=process.env.E2_PROJECT_ROOT?pathToFileURL(resolve(process.env.E2_PROJECT_ROOT,'supabase/migrations')+sep):new URL('../../E2local-main/supabase/migrations/',import.meta.url);
  for(const file of (await readdir(dir)).filter(x=>x.endsWith('.sql')).sort())await db.exec(await readFile(new URL(file,dir),'utf8'));
  await db.query('select public.configure_platform_login_realms($1,$2)',[customerIssuer,staffIssuer]);
  const account=async(subject,issuer)=>{
   const {rows:[{id}]}=await db.query('select public.sync_platform_account($1,$2,$2,$3,1) id',[issuer,subject,subject+'@example.test']);
   await db.query('update public.dashboard_accounts set personal_info=$2 where id=$1',[id,JSON.stringify({firstName:'Test',lastName:'Owner',phone:'+13035550123',role:'Owner'})]);return id;
  };
  const staff=await account('user_staff',staffIssuer);await account('user_nonstaff',staffIssuer);const owner=await account('user_owner',customerIssuer);
  await db.query('insert into public.platform_staff_grants(account_id) values($1)',[staff]);
  await db.query('select public.complete_platform_onboarding($1,$2)',[owner,JSON.stringify(profile)]);
  const tenant=(await db.query('select tenant_id from public.dashboard_business_profiles where account_id=$1',[owner])).rows[0].tenant_id;
  await db.query("select set_config('platform.actor_issuer',$1,false)",[staffIssuer]);

  let view=await call(db,'platform_billing','user_staff','read',{tenantId:tenant});
  assert.equal(view.customerId,null);assert.deepEqual(view.subscriptions,[]);
  await assert.rejects(call(db,'platform_billing','user_nonstaff','read',{tenantId:tenant}),/Staff access required/);
  await assert.rejects(call(db,'platform_billing','user_staff','read',{tenantId:'missing'}),/Business not found/);

  // The customer's owner links a Stripe customer; the E2 webhook stores a subscription.
  assert.equal((await db.query('select public.link_customer_billing($1,$2,$3) id',[owner,tenant,'cus_test1'])).rows[0].id,'cus_test1');
  await db.query("select public.record_billing_subscription('cus_test1','sub_test1','active',array['website','sms_marketing'],now()+interval '30 days',false)");
  view=await call(db,'platform_billing','user_staff','read',{tenantId:tenant});
  assert.equal(view.customerId,'cus_test1');assert.equal(view.subscriptions[0].id,'sub_test1');assert.deepEqual(view.subscriptions[0].plans,['website','sms_marketing']);

  const list=await call(db,'platform_read','user_staff','businesses',{q:'Billing test'});
  assert.deepEqual(list.rows.find(r=>r.tenant_id===tenant).billing,{status:'active',plans:['website','sms_marketing'],cancelAtPeriodEnd:false});

  assert.deepEqual(await call(db,'platform_billing','user_staff','audit',{tenantId:tenant,kind:'refund',details:{refundId:'re_1',amount:9900}}),{audited:true});
  const audit=(await db.query("select action,target,changed,actor_account_id from public.platform_audit where action='billing_refund'")).rows[0];
  assert.equal(audit.target,tenant);assert.equal(audit.actor_account_id,staff);assert.equal(audit.changed.refundId,'re_1');
  await assert.rejects(call(db,'platform_billing','user_staff','audit',{tenantId:tenant,kind:'delete_everything'}),/Unknown billing action/);

  // Waiving payment: staff only, reason required, once at a time, audited both ways.
  const access=async()=>(await db.query('select public.read_customer_setup_access($1) r',[owner])).rows[0].r.unlocked;
  await db.query("select public.record_billing_subscription('cus_test1','sub_test1','canceled',array['website'],null,false)");
  assert.equal(await access(),false,'a canceled subscription locks a new business');
  await assert.rejects(call(db,'platform_billing','user_nonstaff','exempt',{tenantId:tenant,reason:'Comped'}),/Staff access required/);
  await assert.rejects(call(db,'platform_billing','user_staff','exempt',{tenantId:tenant,reason:' '}),/Give a reason/);
  assert.deepEqual(await call(db,'platform_billing','user_staff','exempt',{tenantId:tenant,reason:'Comped partner'}),{exempt:true});
  await assert.rejects(call(db,'platform_billing','user_staff','exempt',{tenantId:tenant,reason:'Again'}),/already waived/);
  assert.equal(await access(),true,'an exempt business opens without paying');
  view=await call(db,'platform_billing','user_staff','read',{tenantId:tenant});
  assert.equal(view.exemption.reason,'Comped partner');assert.equal(view.exemption.createdBy,'user_staff');
  assert.equal((await call(db,'platform_read','user_staff','businesses',{q:'Billing test'})).rows.find(r=>r.tenant_id===tenant).billingExempt,true);
  assert.deepEqual(await call(db,'platform_billing','user_staff','unexempt',{tenantId:tenant,reason:'Partner ended'}),{exempt:false});
  await assert.rejects(call(db,'platform_billing','user_staff','unexempt',{tenantId:tenant}),/not waived/);
  assert.equal(await access(),false);
  const trail=(await db.query("select action,changed from public.platform_audit where action like 'billing_exempt%' order by id")).rows;
  assert.deepEqual(trail.map(r=>r.action),['billing_exempt','billing_exempt_removed']);
  assert.equal(trail[1].changed.reason,'Comped partner');assert.equal(trail[1].changed.note,'Partner ended');
 } finally {await db.close();}
});
