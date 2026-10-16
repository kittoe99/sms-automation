import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {resolve,sep} from 'node:path';
import {pathToFileURL} from 'node:url';
import {testDatabase,call} from './helpers/database.js';
import {toolOutputs} from '../src/mcp/tools.js';

const staffIssuer='https://staff.example.test',customerIssuer='https://customer.example.test';
const profile={businessName:'MCP test business',contactEmail:'owner@example.test',contactPhone:'+13035550123',summary:'Local moving and delivery services.',services:['Moving'],locations:['Denver'],timeZone:'America/Denver'};
test('MCP enforces paired business permissions, revisions, retries, release and audit',async t=>{
 const db=await testDatabase();
 try {
  const dir=process.env.E2_PROJECT_ROOT?pathToFileURL(resolve(process.env.E2_PROJECT_ROOT,'supabase/migrations')+sep):new URL('../../E2local-main/supabase/migrations/',import.meta.url);
  for(const file of (await readdir(dir)).filter(x=>x.endsWith('.sql')).sort())await db.exec(await readFile(new URL(file,dir),'utf8'));
  await db.query('select public.configure_platform_login_realms($1,$2)',[customerIssuer,staffIssuer]);
  const account=async(subject,issuer)=>{
   const {rows:[{id}]}=await db.query('select public.sync_platform_account($1,$2,$2,$3,1) id',[issuer,subject,subject+'@example.test']);
   await db.query('update public.dashboard_accounts set personal_info=$2 where id=$1',[id,JSON.stringify({firstName:'Test',lastName:'Owner',phone:'+13035550123',role:'Owner'})]);return id;
  };
  const staff=await account('user_staff',staffIssuer),nonstaff=await account('user_nonstaff',staffIssuer),owner=await account('user_owner',customerIssuer),other=await account('user_other',customerIssuer);
  await db.query('insert into public.platform_staff_grants(account_id) values($1)',[staff]);
  const register=async(id,name)=>{await db.query('select public.complete_platform_onboarding($1,$2)',[id,JSON.stringify({...profile,businessName:name})]);return (await db.query('select tenant_id from public.dashboard_business_profiles where account_id=$1',[id])).rows[0].tenant_id;};
  const a=await register(owner,'Allowed business'),b=await register(other,'Hidden business');
  await db.query("select set_config('platform.actor_issuer',$1,false)",[staffIssuer]);
  const invoke=async(tool,input={},user='user_staff')=>{const result=await call(db,'mcp_invoke',user,'https://client.example.test/codex.json',tool,input,crypto.randomUUID());if(result.ok)toolOutputs[tool].parse(result.data);return result;};
  const access=await invoke('crm_get_access');assert.equal(access.ok,true,JSON.stringify(access));
  const connectionId=access.data.connectionId;
  const pendingList=await call(db,'mcp_admin','user_staff','list',{});
  assert.equal(pendingList.total,1);assert.equal(pendingList.connections[0].id,connectionId);
  let revision=0;
  const grant=async(permissions,status='active')=>{const result=await call(db,'mcp_admin','user_staff','save',{connectionId,revision,status,permissions,businessIds:[a]});revision=result.connection.revision;return result;};
  await t.test('pending, nonstaff and wrong realm are denied without leaking business data',async()=>{
   assert.equal(access.data.status,'pending');assert.deepEqual(access.data.businesses,[]);
   assert.equal((await invoke('crm_list_businesses')).error.code,'PERMISSION_DENIED');
   assert.equal((await invoke('crm_get_access',{},'user_nonstaff')).error.code,'PERMISSION_DENIED');
   await db.query("select set_config('platform.actor_issuer',$1,false)",[customerIssuer]);
   assert.equal((await invoke('crm_get_access',{},'user_owner')).error.code,'PERMISSION_DENIED');
   await db.query("select set_config('platform.actor_issuer',$1,false)",[staffIssuer]);
   await assert.rejects(call(db,'mcp_admin','user_nonstaff','list',{}),/staff/);
  });
  await t.test('scoped reads filter before pagination and nested projections exclude unrelated businesses',async()=>{
   await grant(['read']);
   const directory=await call(db,'mcp_admin','user_staff','list',{});
   assert.equal(directory.connections[0].business_labels[a],'Allowed business');
   const listed=await invoke('crm_list_businesses',{pageSize:1});assert.equal(listed.data.total,1);assert.equal(listed.data.businesses[0].id,a);
   assert.equal((await invoke('crm_get_business',{businessId:b})).error.code,'PERMISSION_DENIED');
   const customers=await invoke('crm_search_customers');assert.equal(customers.data.total,1);assert.equal(customers.data.customers[0].id,owner);
   assert.equal((await invoke('crm_get_customer',{accountId:other})).error.code,'PERMISSION_DENIED');
   await grant(['read','global_customer_lookup']);
   assert.equal((await invoke('crm_search_customers')).data.total,2);
   assert.deepEqual((await invoke('crm_get_customer',{accountId:other})).data.customer.businesses,[]);
   const read=await invoke('crm_get_business',{businessId:a});assert.equal(read.ok,true,JSON.stringify(read));assert.equal(JSON.stringify(read).includes('account_sid'),false);
  });
  const input={businessId:a,revision:0,profile,idempotencyKey:'draft-0001'};
  await t.test('each write is independently granted and rejects forged context',async()=>{
   for(const [tool,p] of [['crm_save_business_profile_draft',input],['crm_review_business_profile',input],['crm_add_business_service',{businessId:a,kind:'sms',idempotencyKey:'sms-00001'}],['crm_set_service_visibility',{businessId:a,serviceId:crypto.randomUUID(),visibility:'live',revision:0,idempotencyKey:'live-0001'}]])assert.equal((await invoke(tool,p)).error.code,'PERMISSION_DENIED');
   await grant(['draft']);
   assert.equal((await invoke('crm_review_business_profile',input)).error.code,'PERMISSION_DENIED');
   assert.equal((await invoke('crm_save_business_profile_draft',{...input,tenantId:b})).error.code,'VALIDATION_ERROR');
   assert.equal((await invoke('crm_save_business_profile_draft',{...input,businessId:b})).error.code,'PERMISSION_DENIED');
  });
  await t.test('draft idempotency survives retries and conflicts never overwrite',async()=>{
   const saved=await invoke('crm_save_business_profile_draft',input);assert.equal(saved.ok,true,JSON.stringify(saved));
   assert.deepEqual(await invoke('crm_save_business_profile_draft',input),saved);
   assert.equal((await invoke('crm_save_business_profile_draft',{...input,profile:{...profile,businessName:'Changed'}})).error.code,'CONFLICT');
   assert.equal((await invoke('crm_save_business_profile_draft',{...input,idempotencyKey:'stale-0001'})).error.code,'CONFLICT');
   assert.equal((await db.query('select revision from public.platform_business_setup where tenant_id=$1',[a])).rows[0].revision,1);
   await grant([]);assert.equal((await invoke('crm_save_business_profile_draft',input)).error.code,'PERMISSION_DENIED');
  });
  let sms;
  await t.test('explicit all-business scope includes future registrations without changing default scope',async()=>{
   let r=await call(db,'mcp_admin','user_staff','save',{connectionId,revision,status:'active',permissions:['read'],businessIds:[],allBusinesses:true});revision=r.connection.revision;
   assert.equal((await invoke('crm_get_access')).data.businessScope,'all');
   assert.equal((await invoke('crm_list_businesses')).data.total,2);
   const future=await account('user_future',customerIssuer),futureBusiness=await register(future,'Future business');
   assert.equal((await invoke('crm_list_businesses')).data.total,3);
   assert.equal((await invoke('crm_get_business',{businessId:futureBusiness})).ok,true);
   await grant(['read']);assert.equal((await invoke('crm_get_access')).data.businessScope,'selected');
   assert.equal((await invoke('crm_get_business',{businessId:futureBusiness})).error.code,'PERMISSION_DENIED');
  });
  await t.test('review, addition and release preserve E2 behavior and sending boundaries',async()=>{
   await grant(['review']);
   const approved=await invoke('crm_review_business_profile',{...input,revision:1,idempotencyKey:'review-0001'});assert.equal(approved.ok,true,JSON.stringify(approved));
   await grant(['service_add']);
   assert.equal((await invoke('crm_add_business_service',{businessId:a,kind:'website',siteId:crypto.randomUUID(),idempotencyKey:'web-00001'})).error.code,'PERMISSION_DENIED');
   const add=await invoke('crm_add_business_service',{businessId:a,kind:'sms',idempotencyKey:'sms-00001'});assert.equal(add.ok,true,JSON.stringify(add));sms=add.data.record;
   assert.equal(sms.visibility,'draft');
   assert.ok(add.data.providerSetup.jobs.some(job=>job.status==='queued'));
   const customer=async()=>(await db.query('select public.read_customer_business_services($1) result',[owner])).rows[0].result;
   assert.deepEqual((await customer()).services,[]);
   await grant(['visibility']);
   const released=await invoke('crm_set_service_visibility',{businessId:a,serviceId:sms.id,revision:0,visibility:'live',idempotencyKey:'live-0001'});assert.equal(released.ok,true,JSON.stringify(released));
   assert.equal((await customer()).services[0].kind,'sms');
   assert.equal((await db.query('select sending_enabled from public.sms_businesses where tenant_id=$1',[a])).rows[0].sending_enabled,false);
   assert.equal((await invoke('crm_set_service_visibility',{businessId:b,serviceId:sms.id,revision:1,visibility:'draft',idempotencyKey:'hide-0001'})).error.code,'PERMISSION_DENIED');
  });
  await t.test('audit redacts content, scoped login cannot bypass wrappers, revocation is immediate',async()=>{
   const activity=await call(db,'mcp_admin','user_staff','activity',{connectionId});
   assert.ok(activity.activity.some(x=>x.outcome==='replayed'));assert.ok(activity.activity.some(x=>x.outcome==='denied'));
   assert.equal(JSON.stringify(activity).includes(profile.contactPhone),false);
   assert.equal((await db.query("select has_function_privilege('crm_mcp','sms_private.platform_action(text,text,jsonb)','EXECUTE') allowed")).rows[0].allowed,false);
   assert.equal((await db.query("select has_function_privilege('crm_mcp','sms_private.mcp_admin(text,text,jsonb)','EXECUTE') allowed")).rows[0].allowed,false);
   assert.equal((await db.query("select has_schema_privilege('crm_mcp','sms_private','USAGE') allowed")).rows[0].allowed,false);
   const exposed=(await db.query("select n.nspname,p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in ('public','sms_private','crm_mcp') and has_schema_privilege('crm_mcp',n.oid,'usage') and has_function_privilege('crm_mcp',p.oid,'execute')")).rows;
   assert.deepEqual(exposed.sort((a,b)=>a.proname.localeCompare(b.proname)),[{nspname:'crm_mcp',proname:'email_action_ticket'},{nspname:'crm_mcp',proname:'invoke'},{nspname:'crm_mcp',proname:'knowledge_upload_ticket'},{nspname:'crm_mcp',proname:'voice_media_ticket'}]);
   await db.exec('set role crm_mcp');
   const throughRole=(await db.query('select crm_mcp.invoke($1,$2,$3,$4,$5) r',['user_staff','https://client.example.test/codex.json','crm_get_access','{}',crypto.randomUUID()])).rows[0].r;
   assert.equal(throughRole.ok,true);await assert.rejects(db.query('select sms_private.seed_web_forms($1)',[a]),/permission denied/);await db.exec('reset role');
   await grant(['read']);
   await db.query("update public.dashboard_accounts set status='suspended' where id=$1",[staff]);
   assert.equal((await invoke('crm_list_businesses')).error.code,'PERMISSION_DENIED');
   await db.query("update public.dashboard_accounts set status='active' where id=$1",[staff]);
   await grant(['read'],'revoked');assert.equal((await invoke('crm_list_businesses')).error.code,'PERMISSION_DENIED');
   await assert.rejects(grant(['read']),/cannot be reactivated/);
   assert.equal((await invoke('crm_get_access')).data.status,'revoked');
  });
 } finally {await db.close();}
});
