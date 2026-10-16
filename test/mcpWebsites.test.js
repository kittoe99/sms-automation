import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './helpers/twilioConnections.js';
import {call} from './helpers/database.js';
import {toolOutputs} from '../src/mcp/tools.js';
import {websitePermissions,websiteToolPermissions} from '../src/mcp/websiteSchemas.js';
import {withHostingAdapter} from '../src/mcp/hostingAdapter.js';
const rpc=async(db,name,...args)=>(await db.query(`select public.${name}(${args.map((_,i)=>'$'+(i+1)).join(',')}) r`,args)).rows[0].r;
test('Website MCP isolates existing sites and uses revisioned, retry-safe E2 hosting operations',async t=>{
 const {db,business}=await fixture();try{
  const a=(await business('site-owner-a')).tenant,b=(await business('site-owner-b')).tenant;
  const sites=[];for(const [tenant,slug] of [[a,'mcp-site-a'],[b,'mcp-site-b']])sites.push((await db.query("insert into public.hosting_sites(id,slug,name,created_by,sms_tenant_id,details) values(gen_random_uuid(),$1,'Synthetic website','staff',$2,'{\"description\":\"Public description\",\"secret\":\"PRIVATE site\"}') returning *",[slug,tenant])).rows[0]);
  const site=sites[0],other=sites[1];let rev=site.revision;
  const invoke=async(tool,p={})=>{const r=(await db.query('select crm_mcp.invoke($1,$2,$3,$4,$5) r',['staff','website-client',tool,JSON.stringify(p),crypto.randomUUID()])).rows[0].r;if(r.ok)toolOutputs[tool].parse(r.data);return r;};
  const cid=(await invoke('crm_get_access')).data.connectionId;let gr=0;
  const grant=async(perms=websitePermissions.map(x=>x[0]),status='active')=>{gr=(await call(db,'mcp_admin','staff','save',{connectionId:cid,revision:gr,status,permissions:perms,businessIds:[a],allBusinesses:false})).connection.revision;};await grant();
  const scope={businessId:a,siteId:site.id};
  const ticket=async(operationId=null)=>(await db.query('select crm_mcp.hosting_ticket($1,$2,$3,$4,$5) token',['staff','website-client',a,site.id,operationId])).rows[0].token;
  const claim=async(op=null)=>rpc(db,'claim_mcp_hosting_ticket',await ticket(op));
  const revision=async()=>(await db.query('select revision from public.hosting_sites where id=$1',[site.id])).rows[0].revision;
  let dep,foreignDep,form,connection,published;
  await t.test('independent grants, scoped counts and metadata redaction',async()=>{
   for(const [tool,permission] of Object.entries(websiteToolPermissions)){
    await grant(websitePermissions.map(x=>x[0]).filter(x=>x!==permission));assert.equal((await invoke(tool,scope)).error.code,'PERMISSION_DENIED',tool);
   }await grant();
   const list=(await invoke('crm_list_websites',{businessId:a,page:1,pageSize:1})).data;assert.equal(list.total,1);assert.ok(!JSON.stringify(list).includes('PRIVATE'));
   assert.equal((await invoke('crm_get_website',{businessId:a,siteId:other.id})).error.code,'PERMISSION_DENIED');
   assert.equal((await invoke('crm_list_websites',{businessId:b})).error.code,'PERMISSION_DENIED');
   assert.equal((await invoke('crm_list_websites',{businessId:a,pageSize:101})).error.code,'VALIDATION_ERROR');
   assert.equal((await invoke('crm_get_website_publication',scope)).data.status,'unavailable');
   const read=await claim();assert.equal(read.mode,'read');assert.equal(read.slug,site.slug);assert.equal(await rpc(db,'check_mcp_hosting_read',cid,a,site.id),true);
   assert.equal(await rpc(db,'check_mcp_hosting_read',cid,a,other.id),false);
  });
  await t.test('E2 service credentials consume scoped tickets without impersonating a browser session',async()=>{
   const proof=await ticket();
   await db.query("select set_config('request.jwt.claims','{\"iss\":\"supabase\",\"role\":\"service_role\"}',false)");
   await db.exec('set role service_role');const read=await rpc(db,'claim_mcp_hosting_ticket',proof);assert.equal(read.siteId,site.id);await db.exec('reset role');
   await db.query("select set_config('request.jwt.claims','{}',false)");
   for(const role of ['anon','authenticated','crm_mcp'])assert.equal((await db.query("select has_function_privilege($1,'public.claim_mcp_hosting_ticket(text)','execute') allowed",[role])).rows[0].allowed,false);
  });
  await t.test('detail edits preserve ownership and stale browser revisions cannot overwrite',async()=>{
   const p={...scope,revision:rev,name:'Renamed',details:{description:'Public',contactPhone:'+17208429167',services:['Removal']},idempotencyKey:crypto.randomUUID()};
   const r=await invoke('crm_update_website_details',p);assert.equal(r.ok,true,JSON.stringify(r));rev=r.data.revision;assert.deepEqual((await invoke('crm_update_website_details',p)).data,r.data);
   assert.equal((await invoke('crm_update_website_details',{...p,name:'different'})).error.code,'CONFLICT');
   assert.equal((await invoke('crm_update_website_details',{...p,revision:rev,details:{secret:'no'},idempotencyKey:crypto.randomUUID()})).error.code,'VALIDATION_ERROR');
   assert.equal((await invoke('crm_update_website_details',{...p,revision:rev,details:{contactPhone:'invalid'},idempotencyKey:crypto.randomUUID()})).error.code,'VALIDATION_ERROR');
   const old=(await db.query('update public.hosting_sites set name=$1 where id=$2 and revision=$3 returning id',['Browser stale',site.id,p.revision])).rows;assert.equal(old.length,0);
   await db.query('update public.hosting_sites set name=$1 where id=$2 and revision=$3',['Browser edit',site.id,rev]);
   assert.equal((await invoke('crm_update_website_details',{...p,revision:rev,idempotencyKey:crypto.randomUUID()})).error.code,'CONFLICT');rev=await revision();
   const after=(await db.query('select * from public.hosting_sites where id=$1',[site.id])).rows[0];assert.equal(after.sms_tenant_id,a);assert.equal(after.slug,site.slug);assert.equal(after.owner_account_id,site.owner_account_id);
  });
  await t.test('audit failure rolls back details and its retry receipt',async()=>{
   const p={...scope,revision:rev,name:'Must roll back',details:{},idempotencyKey:crypto.randomUUID()};
   await db.exec("create function public.fail_website_audit() returns trigger language plpgsql as $$ begin if new.tool='crm_update_website_details' then raise exception 'synthetic audit failure';end if;return new;end $$;create trigger fail_website_audit before insert on sms_private.mcp_activity for each row execute function public.fail_website_audit();");
   await assert.rejects(()=>invoke('crm_update_website_details',p),/audit failure/);
   await db.exec('drop trigger fail_website_audit on sms_private.mcp_activity;drop function public.fail_website_audit();');assert.equal(await revision(),rev);
  });
  await t.test('form connection scope and revisions leave collection/follow-ups unchanged',async()=>{
   form=(await db.query("insert into public.sms_web_form_definitions(tenant_id,preset,title,enabled) values($1,'quote_requests','Synthetic form',true) returning *",[a])).rows[0];
   const foreign=(await db.query("insert into public.sms_web_form_definitions(tenant_id,preset,title,enabled) values($1,'quote_requests','Other form',true) returning *",[b])).rows[0];
   const p={...scope,revision:rev,formId:form.public_id,formRevision:form.version,idempotencyKey:crypto.randomUUID()};
   assert.equal((await invoke('crm_connect_website_form',{...p,formId:foreign.public_id})).error.code,'PERMISSION_DENIED');
   const r=await invoke('crm_connect_website_form',p);assert.equal(r.ok,true,JSON.stringify(r));connection=r.data.connectionId;rev=r.data.revision;assert.equal(r.data.connectionRevision,0);assert.deepEqual((await invoke('crm_connect_website_form',p)).data,r.data);
   assert.equal((await invoke('crm_list_website_form_connections',scope)).data.total,1);
   const disabled=await invoke('crm_disable_website_form_connection',{...scope,revision:rev,connectionId:connection,connectionRevision:0,idempotencyKey:crypto.randomUUID()});assert.equal(disabled.ok,true);rev=disabled.data.revision;assert.equal(disabled.data.connectionRevision,1);
   const unchanged=(await db.query('select * from public.sms_web_form_definitions where public_id=$1',[form.public_id])).rows[0];assert.deepEqual(unchanged,form);
   assert.equal((await invoke('crm_disable_website_form_connection',{...scope,revision:rev,connectionId:connection,connectionRevision:0,idempotencyKey:crypto.randomUUID()})).error.code,'CONFLICT');
  });
  await t.test('customer requests are site/business scoped, revisioned and exclude identity metadata',async()=>{
   const r=(await db.query("insert into public.hosting_update_requests(id,site_id,account_id,tenant_id,title,category,description) values(gen_random_uuid(),$1,$2,$3,'Update','content','PRIVATE request') returning *",[site.id,site.owner_account_id,a])).rows[0];
   const list=(await invoke('crm_list_website_requests',scope)).data;assert.equal(list.total,1);assert.equal(Object.hasOwn(list.requests[0],'account_id'),false);
   const p={...scope,websiteRequestId:r.id,revision:0,status:'in_progress',response:'PRIVATE staff response',idempotencyKey:crypto.randomUUID()};
   const saved=await invoke('crm_update_website_request',p);assert.equal(saved.ok,true,JSON.stringify(saved));assert.equal(saved.data.revision,1);assert.deepEqual((await invoke('crm_update_website_request',p)).data,saved.data);
   assert.equal((await invoke('crm_update_website_request',{...p,idempotencyKey:crypto.randomUUID()})).error.code,'CONFLICT');
   assert.equal((await invoke('crm_get_website_request',{businessId:a,siteId:other.id,websiteRequestId:r.id})).error.code,'PERMISSION_DENIED');
  });
  await t.test('publication queues exactly one operation, uses E2 lease and never replays external work',async()=>{
   for(const s of sites){const id=crypto.randomUUID();const d=(await db.query("insert into public.hosting_deployments(id,site_id,mode,status,source_files,source_bytes,created_by,manifest,preview_token) values($1,$2,'static','ready','[]',0,'staff',$3,'PRIVATE'||gen_random_uuid()) returning *",[id,s.id,JSON.stringify({siteSlug:s.slug,deploymentId:id,files:{}})])).rows[0];if(s.id===site.id)dep=d;else foreignDep=d;}
   assert.equal((await invoke('crm_list_website_deployments',scope)).data.total,1);assert.ok(!JSON.stringify((await invoke('crm_get_website_deployment',{...scope,deploymentId:dep.id})).data).includes('PRIVATE'));
   const p={...scope,revision:rev,deploymentId:dep.id,deploymentRevision:0,idempotencyKey:crypto.randomUUID()};
   assert.equal((await invoke('crm_publish_website',{...p,deploymentId:foreignDep.id})).error.code,'PERMISSION_DENIED');
   const queued=await invoke('crm_publish_website',p);assert.equal(queued.ok,true,JSON.stringify(queued));published=queued.data.operation.id;assert.deepEqual((await invoke('crm_publish_website',p)).data,queued.data);
   const lease=await claim(published);assert.equal(lease.mode,'execute',JSON.stringify(lease));assert.equal(lease.manifest.deploymentId,dep.id);
   assert.equal((await claim(published)).mode,'status');
   await assert.rejects(()=>db.query('update public.hosting_sites set name=$1 where id=$2',['Race',site.id]),/operation/);
   const authorized=await rpc(db,'assert_mcp_hosting_operation',published,lease.token,lease.generation);assert.equal(authorized.ok,true);
   await grant(websitePermissions.map(x=>x[0]).filter(x=>x!=='website_publish'));await assert.rejects(()=>rpc(db,'assert_mcp_hosting_operation',published,lease.token,lease.generation),/denied/);await grant();
   await rpc(db,'apply_hosting_operation',site.id,lease.token,lease.generation,'invalidate',{});
   const done=await rpc(db,'finish_mcp_hosting_operation',published,lease.token,lease.generation,'completed');assert.equal(done.state,'completed');rev=await revision();assert.equal(done.resultingRevision,rev);
   assert.equal((await claim(published)).operation.state,'completed');assert.deepEqual(await rpc(db,'finish_mcp_hosting_operation',published,lease.token,lease.generation,'completed'),done);
  });
  await t.test('stale queued operations fail closed and uncertain storage outcomes stay held',async()=>{
   const p={...scope,revision:rev,idempotencyKey:crypto.randomUUID()};const stale=await invoke('crm_unpublish_website',p);assert.equal(stale.ok,true);
   await db.query('update public.hosting_sites set name=name where id=$1',[site.id]);rev=await revision();assert.equal((await claim(stale.data.operation.id)).operation.state,'failed');
   const queued=await invoke('crm_unpublish_website',{...p,revision:rev,idempotencyKey:crypto.randomUUID()});assert.equal(queued.ok,true);
   const lease=await claim(queued.data.operation.id);assert.equal(lease.mode,'execute',JSON.stringify(lease));
   const unknown=await rpc(db,'finish_mcp_hosting_operation',lease.operationId,lease.token,lease.generation,'uncertain');assert.equal(unknown.state,'attention');assert.equal((await claim(lease.operationId)).operation.state,'attention');
   assert.equal((await invoke('crm_get_website_operation',{...scope,operationId:lease.operationId})).data.operation.state,'attention');
   assert.equal((await invoke('crm_unpublish_website',{...p,revision:rev,idempotencyKey:crypto.randomUUID()})).error.code,'CONFLICT');
  });
  await t.test('receipts/audits omit request content and credentials; revocation blocks reads',async()=>{
   const rows=(await db.query('select result from sms_private.mcp_requests where connection_id=$1',[cid])).rows;assert.ok(!JSON.stringify(rows).includes('PRIVATE'));assert.ok(!JSON.stringify(rows).includes('lease_token'));
   const audit=(await db.query('select * from sms_private.mcp_activity where connection_id=$1',[cid])).rows;assert.ok(!JSON.stringify(audit).includes('PRIVATE'));assert.ok(audit.some(x=>x.tool==='crm_publish_website:provider'));
   await grant([], 'disabled');assert.equal((await invoke('crm_get_website',scope)).error.code,'PERMISSION_DENIED');await assert.rejects(()=>ticket(published),/denied/);
   assert.equal((await db.query('select count(*) n from public.sms_messages')).rows[0].n,0);
  });
 }finally{await db.close();}
});
test('hosting transport retains committed intent if response is interrupted',async()=>{
 const data={businessId:'b',siteId:'s',previousRevision:0,revision:0,databaseStatus:'committed',operation:{id:'00000000-0000-4000-8000-000000000001',state:'pending',kind:'publish',siteRevision:0,resultingRevision:null,deploymentId:null,createdAt:'now',finishedAt:null},providerWork:'queued'};
 const invoke=async()=>({ok:true,data});const options={adapterUrl:'https://www.e2local.com/api/web-hosting/mcp',fetchImpl:async(url,p)=>{assert.equal(p.headers.Authorization,undefined);assert.deepEqual(JSON.parse(p.body),{ticket:'opaque'});throw Error('Interrupted');}};
 assert.deepEqual((await withHostingAdapter(invoke,async()=> 'opaque',options)({},'crm_publish_website',{businessId:'b',siteId:'s'},'r')).data,data);
 const result=await withHostingAdapter(invoke,async()=> 'opaque',{...options,fetchImpl:async()=>Response.json({operation:{...data.operation,state:'completed',resultingRevision:1}})})({},'crm_publish_website',{businessId:'b',siteId:'s'},'r');assert.equal(result.data.providerWork,'completed');assert.equal(result.data.revision,1);
});
