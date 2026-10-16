import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './helpers/twilioConnections.js';
import {call} from './helpers/database.js';
import {toolOutputs,toolDefinitions} from '../src/mcp/tools.js';
import {contactPermissions,contactTools,contactToolPermissions} from '../src/mcp/contactSchemas.js';
import {connectionPermissions} from '../public/mcpPermissions.js';
import {z} from 'zod';

test('contact catalog has explicit independent grants and strict request/receipt contracts',()=>{
 for(const p of contactPermissions)assert.deepEqual(connectionPermissions.find(x=>x[0]===p[0]),p);
 for(const [name,,shape] of contactTools){assert.ok(contactToolPermissions[name]);assert.ok(toolOutputs[name]);assert.equal(toolDefinitions.filter(t=>t[0]===name).length,1);assert.equal(z.object(shape).strict().safeParse({businessId:'a',sql:'select 1'}).success,false);}
});

test('contact MCP isolation, consent, revision, retries and queued sending',async t=>{
 const {db,business,admin}=await fixture();
 try{
  const a=(await business('contacts-a')).tenant,b=(await business('contacts-b')).tenant;
  const invoke=async(tool,p,user='staff',client='https://contacts.example')=>{
   const requestId=crypto.randomUUID();const r=(await db.query('select crm_mcp.invoke($1,$2,$3,$4,$5) r',[user,client,tool,JSON.stringify(p),requestId])).rows[0].r;
   if(r.ok)toolOutputs[tool].parse(r.data);return {...r,requestId};
  };
  const connectionId=(await invoke('crm_get_access',{})).data.connectionId;let grantRevision=0;
  const grant=async(permissions=contactPermissions.map(p=>p[0]),businessIds=[a],status='active')=>{
   grantRevision=(await call(db,'mcp_admin','staff','save',{connectionId,revision:grantRevision,status,permissions,businessIds,allBusinesses:false})).connection.revision;
  };
  const snapshot=async()=>{const r={};for(const table of ['public.sms_contacts','public.sms_consent_events','public.sms_messages','public.sms_conversations','sms_private.jobs','sms_private.mcp_requests','sms_private.form_runs'])r[table]=(await db.query(`select to_jsonb(x) v from ${table} x order by to_jsonb(x)::text`)).rows;return r;};
  const foreign=(await db.query("insert into public.sms_contacts(tenant_id,phone,name) values($1,'+17208429167','FOREIGN PRIVATE') returning id",[b])).rows[0].id;
  const create={businessId:a,phone:'+17208429167',name:'Synthetic canary',email:'canary@example.test',idempotencyKey:crypto.randomUUID()};let cid;
  const contact=async()=>(await db.query('select * from public.sms_contacts where tenant_id=$1 and id=$2',[a,cid])).rows[0];
  const payload=async(extra={})=>({businessId:a,contactId:cid,revision:(await contact()).revision,idempotencyKey:crypto.randomUUID(),...extra});
  await t.test('pending cannot create; explicit create never upserts or grants consent',async()=>{
   assert.equal((await invoke('crm_create_contact',create)).error.code,'PERMISSION_DENIED');await grant();
   const r=await invoke('crm_create_contact',create);assert.equal(r.ok,true,JSON.stringify(r));cid=r.data.contactId;
   const c=await contact();assert.equal(c.marketing_consent,false);assert.equal(c.opted_out,false);assert.equal(c.revision,1);
   const before=await snapshot();assert.deepEqual((await invoke('crm_create_contact',create)).data,r.data);
   assert.equal((await invoke('crm_create_contact',{...create,idempotencyKey:crypto.randomUUID(),name:'Overwrite'})).error.code,'CONFLICT');
   assert.equal((await invoke('crm_create_contact',{...create,name:'Changed retry'})).error.code,'CONFLICT');assert.deepEqual(await snapshot(),before);
  });
  await t.test('scoped reads exclude other businesses and consent history needs its own grant',async()=>{
   await grant(['contact_read']);const list=await invoke('crm_list_contacts',{businessId:a,page:1,pageSize:1});assert.equal(list.ok,true,JSON.stringify(list));assert.equal(list.data.total,1);assert.equal(list.data.contacts[0].id,cid);
   assert.equal((await invoke('crm_list_contacts',{businessId:a,q:'FOREIGN'})).data.total,0);
   assert.equal((await invoke('crm_get_contact',{businessId:a,contactId:foreign})).error.code,'PERMISSION_DENIED');
   assert.equal((await invoke('crm_get_contact',{businessId:b,contactId:foreign})).error.code,'PERMISSION_DENIED');
   assert.equal((await invoke('crm_get_contact_consent',{businessId:a,contactId:cid})).error.code,'PERMISSION_DENIED');
   await grant(['consent_read']);assert.equal((await invoke('crm_get_contact_consent',{businessId:a,contactId:cid})).data.events.length,0);
   assert.equal((await invoke('crm_get_contact',{businessId:a,contactId:cid})).error.code,'PERMISSION_DENIED');await grant();
  });
  await t.test('raw schemas reject identity overrides and invalid paging, revisions and consent evidence',async()=>{
   const before=await snapshot();
   for(const patch of [{page:0},{pageSize:101},{q:null},{page:'1'},{unknown:true}])assert.equal((await invoke('crm_list_contacts',{businessId:a,...patch})).error.code,'VALIDATION_ERROR');
   for(const patch of [{revision:null},{revision:'1'},{revision:0},{phone:'+13035550123'},{name:null},{email:'invalid'}])assert.equal((await invoke('crm_update_contact',{...await payload({name:'x'}),...patch})).error.code,'VALIDATION_ERROR');
   assert.equal((await invoke('crm_update_contact',await payload())).error.code,'VALIDATION_ERROR');
   assert.equal((await invoke('crm_record_contact_sms_opt_in',await payload({channel:'sms',purpose:'marketing',evidence:'',source:'test',observedAt:new Date().toISOString()}))).error.code,'VALIDATION_ERROR');
   assert.deepEqual(await snapshot(),before);
  });
  await t.test('every write permission is independent and foreign targets cannot mutate',async()=>{
   for(const name of contactTools.filter(x=>x[3]).map(x=>x[0])){
    await grant(contactPermissions.map(p=>p[0]).filter(p=>p!==contactToolPermissions[name]));const before=await snapshot();
    assert.equal((await invoke(name,name==='crm_create_contact'?create:await payload())).error.code,'PERMISSION_DENIED');assert.deepEqual(await snapshot(),before);
   }
   await grant();for(const name of contactTools.filter(x=>x[3]&&x[0]!=='crm_create_contact').map(x=>x[0]))assert.equal((await invoke(name,{...await payload(),contactId:foreign})).error.code,'PERMISSION_DENIED');
  });
  await t.test('explicit edits check revision; shared CRM/worker updates invalidate stale edits',async()=>{
   const p=await payload({name:'Updated',email:null});const r=await invoke('crm_update_contact',p);assert.equal(r.ok,true,JSON.stringify(r));assert.ok(r.data.revision>p.revision);
   assert.equal((await contact()).email,null);assert.deepEqual((await invoke('crm_update_contact',p)).data,r.data);
   assert.equal((await invoke('crm_update_contact',{...p,idempotencyKey:crypto.randomUUID()})).error.code,'CONFLICT');
   const next=await payload({name:'Stale'});await db.query("update public.sms_contacts set name='Worker edit' where tenant_id=$1 and id=$2",[a,cid]);assert.equal((await invoke('crm_update_contact',next)).error.code,'CONFLICT');
  });
  await t.test('evidence-backed consent is separate; previews remain non-mutating and sends recheck',async()=>{
   const p=await payload({body:'PRIVATE MARKETING BODY'});delete p.idempotencyKey;let before=await snapshot();let r=await invoke('crm_preview_contact_sms',p);
   assert.equal(r.ok,true,JSON.stringify(r));assert.ok(r.data.blockers.includes('MARKETING_CONSENT_REQUIRED'));assert.equal(r.data.queued,false);assert.deepEqual(await snapshot(),before);
   assert.equal((await invoke('crm_send_contact_sms',{...p,idempotencyKey:crypto.randomUUID()})).error.code,'PERMISSION_DENIED');
   const consent=await payload({channel:'sms',purpose:'marketing',evidence:'PRIVATE SIGNED CONSENT',source:'synthetic test',observedAt:'2026-01-01T00:00:00Z'});
   r=await invoke('crm_record_contact_sms_opt_in',consent);assert.equal(r.ok,true,JSON.stringify(r));assert.equal((await contact()).marketing_consent,true);
   const history=await invoke('crm_get_contact_consent',{businessId:a,contactId:cid});assert.equal(history.data.events.length,1);assert.ok(history.data.events[0].evidence.includes('PRIVATE SIGNED CONSENT'));
   await call(db,'platform_action','staff','service_add',{tenantId:a,kind:'sms'});
   await db.query("update public.sms_businesses set status='active',sending_enabled=true where tenant_id=$1",[a]);
   await db.query("update sms_private.providers set provisioning_state='configured',account_sid='AC'||repeat('1',32),from_number='+18775550180',auth_secret_id=vault.create_secret('SYNTHETIC') where tenant_id=$1",[a]);
   await db.query('insert into vault.secrets(id) select auth_secret_id from sms_private.providers where tenant_id=$1',[a]);
   const send=await payload({body:'PRIVATE MARKETING BODY'});before=await snapshot();r=await invoke('crm_preview_contact_sms',Object.fromEntries(Object.entries(send).filter(([k])=>k!=='idempotencyKey')));assert.equal(r.data.eligible,true);assert.deepEqual(await snapshot(),before);
   r=await invoke('crm_send_contact_sms',send);assert.equal(r.ok,true,JSON.stringify(r));assert.equal(r.data.deliveryStatus,'queued');before=await snapshot();assert.deepEqual((await invoke('crm_send_contact_sms',send)).data,r.data);assert.deepEqual(await snapshot(),before);
   const message=(await db.query('select * from public.sms_messages where id=$1',[r.data.messageId])).rows[0];assert.equal(message.meta.purpose,'marketing');assert.equal(message.contact_phone,create.phone);assert.equal(message.provider_accepted_at,null);
   const audit=(await db.query('select * from sms_private.mcp_activity where request_id=$1',[r.requestId])).rows[0];assert.equal(audit.actor_id,admin);assert.equal(audit.target,cid);assert.equal(audit.previous_revision,send.revision);
   assert.equal((await invoke('crm_suppress_contact_sms',await payload({reason:'PRIVATE STOP REASON'}))).ok,true);assert.equal((await contact()).opted_out,true);
   assert.equal((await invoke('crm_send_contact_sms',await payload({body:'Must fail'}))).error.code,'PERMISSION_DENIED');
   assert.deepEqual((await invoke('crm_send_contact_sms',send)).data,r.data);
  });
  await t.test('block/unblock never restores consent or starts runs; receipts and audits redact content',async()=>{
   assert.equal((await invoke('crm_set_contact_automation_blocked',await payload({blocked:true}))).ok,true);
   assert.equal((await invoke('crm_set_contact_automation_blocked',await payload({blocked:false}))).ok,true);assert.equal((await contact()).opted_out,true);
   assert.equal(Number((await db.query('select count(*) n from sms_private.form_runs')).rows[0].n),0);
   for(const table of ['sms_private.mcp_activity','sms_private.mcp_requests']){const text=JSON.stringify((await db.query(`select * from ${table}`)).rows);for(const value of ['PRIVATE','17208429167','canary@example.test'])assert.ok(!text.includes(value));}
   for(const role of ['anon','authenticated','crm_mcp','service_role','sms_api']){await db.exec(`set role ${role}`);await assert.rejects(()=>db.query('select sms_private.mcp_contact_action($1,$2,$3,$4,$5)',['staff',a,'crm_get_contact',JSON.stringify({businessId:a,contactId:cid}),connectionId]),/permission denied/);await db.exec('reset role');}
  });
  await t.test('audit/receipt failures roll back and revocation blocks even cached retries',async()=>{
   for(const table of ['mcp_requests','mcp_activity']){
    const p=await payload({name:'Rollback'}),before=await snapshot();await db.exec(`create function sms_private.test_contact_fail() returns trigger language plpgsql as $$begin raise exception 'Synthetic failure' using errcode='XX000';end$$;create trigger test_contact_fail before insert on sms_private.${table} for each row execute function sms_private.test_contact_fail();`);
    if(table==='mcp_requests')assert.equal((await invoke('crm_update_contact',p)).error.code,'TEMPORARY_FAILURE');else await assert.rejects(()=>invoke('crm_update_contact',p));
    assert.deepEqual(await snapshot(),before);await db.exec(`drop trigger test_contact_fail on sms_private.${table};drop function sms_private.test_contact_fail();`);
   }
   await grant(undefined,[b]);assert.equal((await invoke('crm_create_contact',create)).error.code,'PERMISSION_DENIED');await grant();
   await db.query("update public.dashboard_accounts set status='suspended' where id=$1",[admin]);assert.equal((await invoke('crm_create_contact',create)).error.code,'PERMISSION_DENIED');await db.query("update public.dashboard_accounts set status='active' where id=$1",[admin]);
   await grant(undefined,[a],'revoked');assert.equal((await invoke('crm_create_contact',create)).error.code,'PERMISSION_DENIED');
  });
 }finally{await db.close();}
});
