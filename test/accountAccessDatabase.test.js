import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {resolve,sep} from 'node:path';
import {pathToFileURL} from 'node:url';
import {testDatabase,call} from './helpers/database.js';
const staffIssuer='https://staff.example.test',customerIssuer='https://customer.example.test';

test('staff block, unblock, suspend reasons, sign-out audit, history and access filter',async()=>{
 const db=await testDatabase();
 try {
  const dir=process.env.E2_PROJECT_ROOT?pathToFileURL(resolve(process.env.E2_PROJECT_ROOT,'supabase/migrations')+sep):new URL('../../E2local-main/supabase/migrations/',import.meta.url);
  for(const file of (await readdir(dir)).filter(x=>x.endsWith('.sql')).sort())await db.exec(await readFile(new URL(file,dir),'utf8'));
  await db.query('select public.configure_platform_login_realms($1,$2)',[customerIssuer,staffIssuer]);
  const account=async(subject,issuer)=>(await db.query('select public.sync_platform_account($1,$2,$2,$3,1) id',[issuer,subject,subject+'@example.test'])).rows[0].id;
  const staff=await account('user_staff',staffIssuer),other=await account('user_staff2',staffIssuer),customer=await account('user_customer',customerIssuer);
  await account('user_nonstaff',staffIssuer);
  await db.query('insert into public.platform_staff_grants(account_id) values($1)',[staff]);
  await db.query("select set_config('platform.actor_issuer',$1,false)",[staffIssuer]);
  const revision=async id=>Number((await db.query('select revision from public.dashboard_accounts where id=$1',[id])).rows[0].revision);
  const status=async id=>(await db.query('select status,access_blocked_at is not null blocked from public.dashboard_accounts where id=$1',[id])).rows[0];
  const action=(name,p,user='user_staff')=>call(db,'platform_action',user,name,p);

  await assert.rejects(action('access_block',{accountId:customer,revision:await revision(customer),reason:'x'},'user_nonstaff'),/Staff access required/);
  await assert.rejects(action('access_block',{accountId:customer,revision:await revision(customer)}),/Give a reason/);
  await assert.rejects(action('access_block',{accountId:staff,revision:await revision(staff),reason:'test'}),/your own account/);
  await assert.rejects(action('status',{accountId:customer,revision:await revision(customer),status:'suspended'}),/Give a reason/);

  // Suspend with a reason, then restore; both appear in history with the reason.
  await action('status',{accountId:customer,revision:await revision(customer),status:'suspended',reason:'Unpaid invoice'});
  assert.equal((await status(customer)).status,'suspended');
  await action('status',{accountId:customer,revision:await revision(customer),status:'active'});

  // Block: suspended + blocked, identities returned for Clerk, cannot be restored by status.
  const blocked=await action('access_block',{accountId:customer,revision:await revision(customer),reason:'Abusive messages'});
  assert.equal(blocked.blocked,true);assert.equal(blocked.status,'suspended');
  assert.deepEqual(blocked.identities,[{issuer:customerIssuer,subject:'user_customer'}]);
  assert.deepEqual(await status(customer),{status:'suspended',blocked:true});
  await assert.rejects(action('status',{accountId:customer,revision:await revision(customer),status:'active'}),/Unblock it/);
  assert.equal((await db.query("select sms_private.login_account($1,'customer') ok",[customer])).rows[0].ok,false);

  // Clerk sync after a ban event must not restore access.
  await db.query('select public.sync_platform_account($1,$2,$3,$4,2)',[customerIssuer,'user_customer','user_customer','user_customer@example.test']);
  assert.deepEqual(await status(customer),{status:'suspended',blocked:true});

  // Filtered list and history.
  const list=async access=>(await call(db,'platform_read','user_staff','accounts',{access})).rows.map(r=>[r.id,r.access]);
  assert.deepEqual(await list('blocked'),[[customer,'blocked']]);
  assert.equal((await list('active')).some(([id])=>id===customer),false);
  await assert.rejects(call(db,'platform_read','user_staff','accounts',{access:'weird'}),/Unknown access filter/);
  await assert.rejects(call(db,'platform_read','user_nonstaff','accounts',{access:'blocked'}),/Staff access required/);
  const detail=(await call(db,'platform_read','user_staff','accounts',{id:customer})).rows[0];
  assert.equal(detail.access,'blocked');assert.equal(detail.access_block_reason,'Abusive messages');assert.equal(detail.accessBlockedByName,'user_staff');
  assert.deepEqual(detail.accessHistory.map(h=>[h.action,h.reason]),[['access_block','Abusive messages'],['status',null],['status','Unpaid invoice']]);

  // Unblock restores access; sign-out is audited and returns identities.
  const restored=await action('access_unblock',{accountId:customer,reason:'Resolved'});
  assert.equal(restored.blocked,false);assert.deepEqual(await status(customer),{status:'active',blocked:false});
  const out=await action('access_sign_out',{accountId:customer});assert.equal(out.identities[0].subject,'user_customer');
  assert.deepEqual((await call(db,'platform_read','user_staff','accounts',{id:customer})).rows[0].accessHistory.slice(0,2).map(h=>h.action),['access_sign_out','access_unblock']);

  // The last active administrator cannot be blocked by another (non-staff can't act at all).
  await db.query('insert into public.platform_staff_grants(account_id) values($1)',[other]);
  await action('access_block',{accountId:other,revision:await revision(other),reason:'Left the company'});
  assert.deepEqual(await status(other),{status:'suspended',blocked:true});
  await assert.rejects(action('access_identity',{accountId:staff},'user_staff2'),/Staff access required/);
 } finally {await db.close();}
});
