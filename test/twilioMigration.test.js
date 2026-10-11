import test from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {testDatabase} from './helpers/database.js';
const stage2='20261011192649_shared_twilio_accounts.sql';
const seed=async(db,duplicate)=>{
 await db.exec("insert into public.sms_businesses(tenant_id,name) values('first','First'),('second','Second')");
 for(const [t,n] of [['first','1'],['second','2']])await db.query("insert into sms_private.providers(tenant_id,account_sid,from_number,provisioning_state,auth_secret_id) values($1,$2,$3,'configured',vault.create_secret('fixture-token'))",[t,'AC'+n.repeat(32),duplicate?'+13035550100':'+1303555010'+n]);
};
test('shared-account migration preflight rejects existing cross-business sender conflicts',async()=>{
 const db=new PGlite();try {
  await assert.rejects(()=>testDatabase({database:db,beforeMigration:async(d,file)=>{if(file===stage2)await seed(d,true);}}),/ownership conflicts exist/);
 }finally{await db.close();}
});
test('shared-account migration backfills existing ownership and fences later provider writes',async()=>{
 const db=await testDatabase({beforeMigration:async(d,file)=>{if(file===stage2)await seed(d,false);}});try {
  const claims=(await db.query('select * from sms_private.twilio_sender_claims order by tenant_id')).rows;
  assert.equal(claims.length,2);assert.equal(claims[0].tenant_id,'first');
  await assert.rejects(()=>db.query("update sms_private.providers set from_number='+13035550101' where tenant_id='second'"),/already assigned or reserved/);
 }finally{await db.close();}
});
