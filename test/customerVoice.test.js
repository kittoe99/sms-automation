import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './helpers/twilioConnections.js';
import {call} from './helpers/database.js';
async function agent(db,t,id='agent',phone='+18775550180') {
 await db.query("insert into sms_private.voice_agents(tenant_id,id,deployment_id,agent_name,phone,draft) values($1,$2,$2,'private deployment',$3,'{\"brain\":\"secret prompt\"}')",[t,id,phone]);
 const revision=(await db.query("insert into sms_private.voice_configurations(tenant_id,agent_id,configuration,created_by) values($1,$2,'{\"name\":\"Alex\",\"brain\":\"secret prompt\",\"voiceName\":\"marin\"}','staff') returning revision",[t,id])).rows[0].revision;
 await db.query('update sms_private.voice_agents set published_revision=$3 where tenant_id=$1 and id=$2',[t,id,revision]);
}
async function seedCall(db,t,id='agent',extra={}) {
 return (await db.query(`insert into sms_private.voice_calls(tenant_id,agent_id,job_id,room_id,phone,status,summary,transcript,media_state,media_path,started_at,expires_at)
 values($1,$2,gen_random_uuid()::text,'private-room','+13035550123','completed','Asked about a repair',
 '[{"role":"user","text":"Please repair my door","internal":"secret"}]','ready','private/recording.wav',$3,$4) returning id`,
 [t,id,extra.startedAt||'2026-01-02T03:00:00Z',extra.expiresAt||'2099-01-01T00:00:00Z'])).rows[0].id;
}
const read=async(db,owner,resource='voice',filters={})=>(await db.query('select public.read_customer_voice($1,$2,$3) r',[owner,resource,filters])).rows[0].r;
const action=(db,kind,p,user='staff')=>call(db,'platform_action',user,kind,p);
async function release(db,t) {const s=await action(db,'service_add',{tenantId:t,kind:'voice'});return action(db,'service_visibility',{tenantId:t,serviceId:s.id,revision:s.revision,visibility:'live'});}

test('Voice release is explicit, revision checked and restricted to staff with reviewed, owned and configured businesses',async()=>{
 const {db,business}=await fixture();try {
  const b=await business('voice-owner');
  await assert.rejects(()=>action(db,'service_add',{tenantId:b.tenant,kind:'voice'}),/Register a voice agent/);
  await agent(db,b.tenant);
  const s=await action(db,'service_add',{tenantId:b.tenant,kind:'voice'});
  assert.equal(s.visibility,'draft');assert.deepEqual(await read(db,b.owner),{businesses:[]});
  assert.equal((await action(db,'service_add',{tenantId:b.tenant,kind:'voice'})).id,s.id);
  await assert.rejects(()=>action(db,'service_visibility',{tenantId:b.tenant,serviceId:s.id,revision:99,visibility:'live'}),/changed/);
  await assert.rejects(()=>action(db,'service_visibility',{tenantId:b.tenant,serviceId:s.id,revision:s.revision,visibility:'live'},'reader'),/Staff access/);
  await action(db,'service_visibility',{tenantId:b.tenant,serviceId:s.id,revision:s.revision,visibility:'live'});
  const result=await read(db,b.owner);assert.equal(result.businesses[0].agents[0].name,'Alex');
  assert.deepEqual(Object.keys(result.businesses[0].agents[0]).sort(),['id','name','phone']);
  assert.equal(JSON.stringify(result).includes('secret'),false);
  await db.exec('set role service_role');
  assert.equal((await read(db,b.owner)).businesses[0].id,b.tenant);
  await assert.rejects(()=>db.query('select * from sms_private.voice_calls'),/permission denied/);
  await db.exec('reset role');
  assert.equal((await db.query('select public.read_customer_business_services($1) r',[b.owner])).rows[0].r.services[0].kind,'voice');
  assert.equal((await db.query("select count(*)::int n from public.platform_audit where action='service_add' and target=$1",[b.tenant])).rows[0].n,2);
 }finally{await db.close();}
});

test('Owners see only released business calls and safe details; playback rejects foreign, hidden and expired media',async()=>{
 const {db,business,reader}=await fixture();try {
  const a=await business('one'),b=await business('two');
  await agent(db,a.tenant);await agent(db,b.tenant);const ca=await seedCall(db,a.tenant),cb=await seedCall(db,b.tenant);
  assert.equal(await read(db,a.owner,'voice-call',{business:a.tenant,id:ca}),null);
  const sa=await release(db,a.tenant);await release(db,b.tenant);
  assert.equal((await read(db,a.owner)).businesses.length,1);
  assert.deepEqual((await read(db,reader)).businesses,[]);
  assert.equal(await read(db,a.owner,'voice-call',{business:b.tenant,id:cb}),null);
  assert.equal(await read(db,a.owner,'voice-call',{business:a.tenant,id:cb}),null);
  assert.equal(await read(db,a.owner,'voice-recording',{business:b.tenant,id:cb}),null);
  const page=await read(db,a.owner,'voice-calls');assert.equal(page.rows[0].id,ca);assert.equal(page.total,1);assert.equal('transcript' in page.rows[0],false);
  const detail=await read(db,a.owner,'voice-call',{business:a.tenant,id:ca});assert.deepEqual(detail.transcript,[{role:'user',text:'Please repair my door'}]);
  for(const key of ['media_path','request','configuration_revision','room_id','job_id']) assert.equal(key in detail,false);
  const media=await read(db,a.owner,'voice-recording',{business:a.tenant,id:ca});assert.equal(media.expiresIn,300);
  assert.equal((await db.query("select count(*)::int n from sms_private.audit where action='customer_voice_recording_access'",[])).rows[0].n,1);
  await db.query("update sms_private.voice_calls set expires_at=now()+interval '30 seconds' where tenant_id=$1 and id=$2",[a.tenant,ca]);
  assert.ok((await read(db,a.owner,'voice-recording',{business:a.tenant,id:ca})).expiresIn<=30);
  await db.query("update sms_private.voice_calls set expires_at=now()-interval '1 second' where tenant_id=$1 and id=$2",[a.tenant,ca]);
  assert.equal(await read(db,a.owner,'voice-recording',{business:a.tenant,id:ca}),null);
  const expired=await read(db,a.owner,'voice-call',{business:a.tenant,id:ca});assert.equal(expired.transcript,null);assert.equal(expired.recordingState,'expired');
  await action(db,'service_visibility',{tenantId:a.tenant,serviceId:sa.id,revision:sa.revision,visibility:'draft'});
  assert.equal(await read(db,a.owner,'voice-calls'),null);
  await action(db,'owner',{tenantId:b.tenant,accountId:a.owner,previousOwnerId:b.owner,revision:-1});
  await release(db,b.tenant);await release(db,a.tenant);
  const both=await read(db,a.owner);assert.equal(both.businesses.length,2);
  assert.equal((await read(db,a.owner,'voice-calls',{business:b.tenant})).rows[0].id,cb);
  assert.equal((await read(db,a.owner,'voice-calls',{business:a.tenant})).rows[0].id,ca);
 }finally{await db.close();}
});

test('Voice history is retained before release, filtered in business time zone and paginated; drafts and heartbeats do not invalidate cache',async()=>{
 const {db,business}=await fixture();try {
  const a=await business('history');await agent(db,a.tenant);const id=await seedCall(db,a.tenant);
  await release(db,a.tenant);
  const revision=async()=>(await db.query('select public.read_dashboard_cache_state($1) r',[a.owner])).rows[0].r.revision;
  const before=await revision();
  await db.query("update sms_private.voice_agents set observed_at=now(),draft='{}',draft_version=draft_version+1 where tenant_id=$1",[a.tenant]);
  await db.query('update sms_private.voice_calls set seen_at=now() where tenant_id=$1',[a.tenant]);assert.equal(await revision(),before);
  await db.query("update sms_private.voice_calls set summary='New summary' where tenant_id=$1",[a.tenant]);assert.notEqual(await revision(),before);
  assert.equal((await read(db,a.owner,'voice-calls',{from:'2026-01-01',to:'2026-01-01'})).total,1);
  assert.equal((await read(db,a.owner,'voice-calls',{from:'2026-01-02',to:'2026-01-02'})).total,0);
  assert.equal((await read(db,a.owner,'voice-calls',{q:'NEW',agent:'agent',status:'completed'})).rows[0].id,id);
  for(let i=0;i<25;i++) await seedCall(db,a.tenant);
  assert.equal((await read(db,a.owner,'voice-calls',{page:1})).rows.length,25);
  assert.equal((await read(db,a.owner,'voice-calls',{page:2})).rows.length,1);
  await db.query('update sms_private.voice_calls set deleted_at=now() where tenant_id=$1',[a.tenant]);
  assert.equal((await read(db,a.owner,'voice-calls')).total,26);
 }finally{await db.close();}
});

test('Viewer/operator and suspended owners have no Voice access; ownership changes hide the service and RPC grants stay server-only',async()=>{
 const {db,business,reader}=await fixture();try {
  const a=await business('owner-a'),b=await business('owner-b');await agent(db,a.tenant);const id=await seedCall(db,a.tenant);await release(db,a.tenant);
  await action(db,'membership',{tenantId:a.tenant,accountId:b.owner,role:'viewer',revision:-1,enabled:true,websiteRead:true,enquiriesRead:true,bookingsRead:true});
  assert.deepEqual((await read(db,b.owner)).businesses,[]);
  await action(db,'membership',{tenantId:a.tenant,accountId:reader,role:'operator',revision:-1,enabled:true,websiteRead:true,enquiriesRead:true,bookingsRead:true});
  assert.equal(await read(db,reader,'voice-recording',{business:a.tenant,id}),null);
  const membership=(await db.query("select revision from public.platform_business_memberships where tenant_id=$1 and account_id=$2",[a.tenant,b.owner])).rows[0];
  await action(db,'owner',{tenantId:a.tenant,accountId:b.owner,previousOwnerId:a.owner,revision:membership.revision,enabled:true});
  assert.deepEqual((await read(db,a.owner)).businesses,[]);assert.deepEqual((await read(db,b.owner)).businesses,[]);
  for(const role of ['anon','authenticated','sms_api']) assert.equal((await db.query("select has_function_privilege($1,'public.read_customer_voice(uuid,text,jsonb)','execute') allowed",[role])).rows[0].allowed,false);
  assert.equal((await db.query("select has_function_privilege('service_role','public.read_customer_voice(uuid,text,jsonb)','execute') allowed")).rows[0].allowed,true);
  await release(db,a.tenant);
  await db.query("update public.dashboard_accounts set status='suspended' where id=$1",[b.owner]);
  assert.equal(await read(db,b.owner,'voice-call',{business:a.tenant,id}),null);
 }finally{await db.close();}
});
