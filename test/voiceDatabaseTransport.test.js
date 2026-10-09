import test from 'node:test';
import assert from 'node:assert/strict';
import postgres from 'postgres';
import {runtimeDatabase} from '../supabase/functions/voice-runtime/database.js';
import {bookingDatabase} from '../supabase/functions/voice-booking/database.js';

test('voice adapters encode JSONB objects once with the actual Postgres.js serializer',async()=>{
 const driver=postgres('postgres://unused:unused@localhost/unused');
 try{
  const jsonb=driver.options.serializers[3802];
  const calls=[];
  const connect=()=>({unsafe:async(query,args)=>{
   calls.push({query,args});
   const payload=args.at(-1);
   // Model PostgreSQL decoding the driver's JSONB wire value, not PGlite string binding.
   return [{result:typeof payload==='object'?JSON.parse(jsonb(payload)):payload}];
  }});
  const start={room:'phone-test',source:'crm',revision:'test',phone:'+13035550123'};
  assert.deepEqual(await runtimeDatabase('test',{connect}).call('dispatch','tenant','call-id','start',start),start);
  assert.equal(typeof calls.at(-1).args.at(-1),'object');
  const deleted={deleted:['tenant/call/audio.ogg']};
  assert.deepEqual(await runtimeDatabase('test',{maintenance:true,connect}).call('cleanup',deleted),deleted);
  const booking={service:'junk_removal',localDate:'2026-12-01',details:{notes:'Test'}};
  assert.deepEqual(await bookingDatabase('test',{connect}).call('prepare','tenant','call-id',booking),booking);
  assert.equal(await bookingDatabase('test',{connect}).call('confirm','tenant','call-id','hold-id'),'hold-id');
  await assert.rejects(()=>runtimeDatabase('test',{connect}).call('confirm'),/Unsupported/);
  await assert.rejects(()=>bookingDatabase('test',{connect}).call('dispatch'),/Unsupported/);
 }finally{await driver.end();}
});
