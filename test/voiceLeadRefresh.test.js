import test from 'node:test';
import assert from 'node:assert/strict';
import {testDatabase,call} from './helpers/database.js';

const tenant='biz-1c0c09ce-819e-4795-86b9-0e457ab92f58',caller='+13035550122';
const base={name:'Phone',persona:'',voice:'Speak clearly',brain:'Use approved facts',voiceName:'marin'};
const json=x=>typeof x==='object'?JSON.stringify(x):x;
const runtime=async(db,cid,action,p={})=>(await db.query('select voice_runtime_api.dispatch($1,$2,$3,$4) as result',[tenant,cid,action,json(p)])).rows[0].result;

test('a repeat caller\'s open lead takes the latest call\'s details',async()=>{
 const db=await testDatabase();try{
  await call(db,'api_action','admin',null,'create_business',{id:tenant,name:'Voice CRM',timeZone:'UTC'});
  await db.query("update sms_private.providers set from_number='+18777574365' where tenant_id=$1",[tenant]);
  const ws=(action,p={})=>call(db,'voice_workspace','admin',tenant,action,p);
  await ws('initialize',{configuration:base});
  const a=(await ws('overview')).agents[0];await ws('publish',{agentId:a.id,version:a.draft_version});
  const start=async cid=>{const cfg=await runtime(db,cid,'configuration');
   await runtime(db,cid,'start',{room:'phone-'+cid,phone:caller,revision:cfg.revision,source:'crm'});};
  await start('phone-job-first');
  const first=await runtime(db,'phone-job-first','outcome',{outcome:'quote_request',summary:'Toilet clog at 360 Colorado Blvd',phone:caller,name:'Pat',location:'360 Colorado Blvd',request:'Evening visit'});
  await start('phone-job-second');
  const second=await runtime(db,'phone-job-second','outcome',{outcome:'service_request',summary:'Toilet clog at 860 Clermont St, Tuesday morning offered',phone:caller,name:'Pat',location:'860 Clermont St',request:''});
  assert.equal(second.leadId,first.leadId,'the open lead is reused');
  const lead=(await db.query('select summary,fields from public.sms_leads where id=$1',[first.leadId])).rows[0];
  assert.equal(lead.summary,'Toilet clog at 860 Clermont St, Tuesday morning offered');
  assert.equal(lead.fields.location,'860 Clermont St');
  assert.equal(lead.fields.request,'Evening visit','an empty value does not wipe an earlier one');
  assert.equal(lead.fields.source,'voice');assert.equal(lead.fields.phoneVerified,false);
 }finally{await db.close();}
});
