import test from 'node:test';
import assert from 'node:assert/strict';
import {testDatabase,call} from './helpers/database.js';

const facts=name=>({businessName:name,summary:`${name} provides dependable local services for its customers.`,services:['Repairs'],locations:['Denver'],faqs:[],pricing:[],policies:[],tone:'friendly'});

test('profile approval switches atomically and knowledge lists remain tenant scoped',async()=>{
 const db=await testDatabase();try{
  await db.exec("insert into public.sms_businesses(tenant_id,name) values('alpha','Alpha'),('beta','Beta')");
  const first=await call(db,'save_profile_version','admin','alpha',facts('Alpha'),true);assert.equal(first.status,'approved');
  const draft=await call(db,'save_profile_version','admin','alpha',{...facts('Alpha'),hours:'Monday to Friday'},false);assert.equal(draft.status,'draft');
  let active=(await call(db,'knowledge_overview','admin','alpha')).profile;assert.equal(active.id,first.id);
  await call(db,'approve_profile_version','admin','alpha',draft.id);active=(await call(db,'knowledge_overview','admin','alpha')).profile;assert.equal(active.id,draft.id);
  const old=(await db.query("select status from public.sms_business_profile_versions where tenant_id='alpha' and id=$1",[first.id])).rows[0];assert.equal(old.status,'superseded');
  const alphaSource=await call(db,'create_knowledge_source','admin','alpha',{type:'website',title:'Alpha site',origin:'https://alpha.example'});
  await call(db,'create_knowledge_source','admin','beta',{type:'website',title:'Beta site',origin:'https://beta.example'});
  const alpha=await call(db,'knowledge_overview','admin','alpha'),beta=await call(db,'knowledge_overview','admin','beta');assert.deepEqual(alpha.sources.map(x=>x.title),['Alpha site']);assert.deepEqual(beta.sources.map(x=>x.title),['Beta site']);
  const version=(await db.query("insert into public.sms_knowledge_source_versions(tenant_id,source_id,version,status,extracted_text,created_by,approved_by,approved_at) values('alpha',$1,1,'approved','Live facts','admin','admin',now()) returning id",[alphaSource.id])).rows[0];
  await db.query("update public.sms_knowledge_sources set active_version_id=$1,status='ready' where tenant_id='alpha' and id=$2",[version.id,alphaSource.id]);
  await call(db,'archive_knowledge_source','admin','alpha',alphaSource.id);
  const archived=(await db.query("select status,active_version_id from public.sms_knowledge_sources where tenant_id='alpha' and id=$1",[alphaSource.id])).rows[0];assert.equal(archived.status,'archived');assert.equal(archived.active_version_id,null);
  assert.equal((await db.query("select status from public.sms_knowledge_source_versions where tenant_id='alpha' and id=$1",[version.id])).rows[0].status,'archived');
 }finally{await db.close();}
});

test('sending activation fails closed until every knowledge and Twilio readiness gate passes',async()=>{
 const db=await testDatabase();try{await db.exec("insert into public.sms_businesses(tenant_id,name) values('blocked','Blocked')");await assert.rejects(call(db,'activate_twilio','admin','blocked'),/Activation requirements|no rows/i);}finally{await db.close();}
});
