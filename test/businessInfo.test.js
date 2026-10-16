import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './helpers/twilioConnections.js';
import {call} from './helpers/database.js';
import {inboundInstructions} from '../src/workers/inboundAgent.js';

test('Business Info is authoritative and missing pricing uses only saved contacts',()=>{
 const prompt=inboundInstructions({business:{name:'Example',timeZone:'UTC'},profile:{businessInfo:'Removal. Ask us for an accurate quote.',pricing:['STALE PRICE $999'],contactPhone:'+13035550123',websiteUrl:'https://example.test'},settings:{}},[]);
 assert.ok(prompt.includes('Removal. Ask us'));assert.ok(!prompt.includes('STALE PRICE'));assert.ok(prompt.includes('https://example.test'));assert.ok(prompt.includes('+13035550123'));
 assert.ok(prompt.includes('do not estimate'));assert.ok(prompt.includes('never authority'));assert.ok(prompt.includes('not a reservation'));
 const absent=inboundInstructions({business:{name:'Example',timeZone:'UTC'},profile:{businessInfo:'No public contacts available.'},settings:{}},[]);assert.ok(absent.includes('"phone":null'));assert.ok(absent.includes('If neither is available, request staff help'));
});

test('Document review and live on/off retain authorization, revisions, replay and no historical sends',async t=>{
 const {db,business}=await fixture();try{
  const a=(await business('document-owner')).tenant,b=(await business('other-document-owner')).tenant;
  const invoke=async(tool,p={})=>(await db.query('select crm_mcp.invoke($1,$2,$3,$4,$5) r',['staff','document-client',tool,JSON.stringify(p),crypto.randomUUID()])).rows[0].r;
  const cid=(await invoke('crm_get_access')).data.connectionId;
  await call(db,'mcp_admin','staff','save',{connectionId:cid,revision:0,status:'active',permissions:['read','draft','review','ai_config_read','ai_config_edit','ai_activate'],businessIds:[a],allBusinesses:false});
  const initial=(await invoke('crm_get_business',{businessId:a})).data.business;
  const p={businessId:a,revision:initial.setup.revision,profile:{businessInfo:'Removal and moving. Visit our website for an accurate quote.',services:[],locations:[],pricing:[],websiteUrl:'https://example.test'},idempotencyKey:crypto.randomUUID()};
  await t.test('price-free document can be reviewed with no structured service lists; retries do not duplicate versions',async()=>{
   const r=await invoke('crm_review_business_profile',p);assert.equal(r.ok,true,JSON.stringify(r));assert.deepEqual((await invoke('crm_review_business_profile',p)).data,r.data);
   const saved=(await invoke('crm_get_business',{businessId:a})).data.business;assert.equal(saved.approvedProfile.businessInfo,p.profile.businessInfo);assert.deepEqual(saved.approvedProfile.pricing,[]);
   assert.equal((await invoke('crm_review_business_profile',{...p,idempotencyKey:crypto.randomUUID()})).error.code,'CONFLICT');
   assert.equal((await invoke('crm_review_business_profile',{...p,businessId:b})).error.code,'PERMISSION_DENIED');
   for(const value of ['',[],{},'x'.repeat(20001)])await assert.rejects(()=>db.query('select sms_private.validate_business_facts($1)',[JSON.stringify({...saved.approvedProfile,businessInfo:value})]),/Business Info/);
  });
  await t.test('draft content never changes approved facts',async()=>{
   const before=(await invoke('crm_get_business',{businessId:a})).data.business;
   const r=await invoke('crm_save_business_profile_draft',{businessId:a,revision:before.setup.revision,profile:{businessInfo:'UNREVIEWED DRAFT'},idempotencyKey:crypto.randomUUID()});assert.equal(r.ok,true);
   const after=(await invoke('crm_get_business',{businessId:a})).data.business;assert.equal(after.approvedProfile.businessInfo,before.approvedProfile.businessInfo);assert.equal(after.setup.draft.businessInfo,'UNREVIEWED DRAFT');
  });
  await t.test('live requires provider readiness, but neither a pilot flag nor a separate validation timestamp',async()=>{
   let config=(await invoke('crm_get_ai_configuration',{businessId:a})).data.configuration;
   const blocked=await invoke('crm_set_ai_mode',{businessId:a,revision:config.revision,mode:'live',bookingEnabled:false,idempotencyKey:crypto.randomUUID()});assert.equal(blocked.ok,false);
   await db.query("insert into sms_private.providers(tenant_id,account_sid,auth_secret_id,messaging_service_sid,phone_number_sid,from_number,provisioning_state) values($1,$2,vault.create_secret('synthetic'),$3,$4,'+13035550123','configured')",[a,'AC'+'1'.repeat(32),'MG'+'1'.repeat(32),'PN'+'1'.repeat(32)]);
   await db.query("insert into public.sms_twilio_registrations(tenant_id,sender_type,state,messaging_service_sid) values($1,'toll_free','ready',$2)",[a,'MG'+'1'.repeat(32)]);
   await db.query("update public.sms_businesses set status='active',sending_enabled=true where tenant_id=$1",[a]);
   config=(await invoke('crm_get_ai_configuration',{businessId:a})).data.configuration;assert.equal(config.liveValidated,false);assert.equal(config.pilot,false);
   const input={businessId:a,revision:config.revision,mode:'live',bookingEnabled:false,idempotencyKey:crypto.randomUUID()};const r=await invoke('crm_set_ai_mode',input);assert.equal(r.ok,true,JSON.stringify(r));assert.equal(r.data.configuration.mode,'live');assert.equal(r.data.configuration.liveValidated,false);assert.equal(r.data.messageQueued,false);assert.deepEqual((await invoke('crm_set_ai_mode',input)).data,r.data);
   assert.equal((await invoke('crm_set_ai_mode',{...input,idempotencyKey:crypto.randomUUID()})).error.code,'CONFLICT');
   assert.equal((await invoke('crm_set_ai_mode',{...input,businessId:b})).error.code,'PERMISSION_DENIED');
   const off=await invoke('crm_set_ai_mode',{businessId:a,revision:r.data.revision,mode:'off',bookingEnabled:false,idempotencyKey:crypto.randomUUID()});assert.equal(off.ok,true);assert.equal(off.data.configuration.mode,'off');
   const rows=(await db.query("select * from sms_private.audit where action='inbound_ai_settings_saved'")).rows;assert.equal(rows.length,2);assert.ok(rows.every(x=>x.actor==='staff'));assert.ok(!JSON.stringify(rows).includes('UNREVIEWED'));
   assert.equal((await db.query("select count(*) n from sms_private.jobs where queue in ('ai_reply_jobs','sms_send_jobs')")).rows[0].n,0);
   assert.equal((await db.query('select count(*) n from public.sms_messages')).rows[0].n,0);
  });
 }finally{await db.close();}
});
