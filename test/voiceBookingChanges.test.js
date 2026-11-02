import test from 'node:test';
import assert from 'node:assert/strict';
import {testDatabase,call} from './helpers/database.js';

const tenant='biz-1c0c09ce-819e-4795-86b9-0e457ab92f58',phone='+13035550122',cid='change-call-123';
const hours=Object.fromEntries(Array.from({length:7},(_,i)=>[i,[{start:'09:00',end:'12:00'},{start:'13:00',end:'17:00'}]]));
const dayIn=n=>new Date(Date.now()+n*86400000).toISOString().slice(0,10);
const rule=()=>({service:'junk_removal',variant:'',market:'Test',zipCodes:['80231'],timeZone:'UTC',resourcePool:'crew',enabled:true,durationMinutes:60,capacity:1,minimumNoticeMinutes:0,maximumAdvanceDays:90,weeklyAvailability:structuredClone(hours),dateExceptions:[]});
async function setup(){
  const db=await testDatabase();
  await call(db,'api_action','admin',null,'create_business',{id:tenant,name:'Change test',timeZone:'UTC'});
  await db.query("update sms_private.providers set from_number='+18777574365' where tenant_id=$1",[tenant]);
  await call(db,'voice_save_rule','admin',tenant,rule());
  return db;
}
const api=(schema,name)=>async(db,...args)=>(await db.query(`select ${schema}.${name}(${args.map((_,i)=>'$'+(i+1)).join(',')}) as result`,
  args.map(x=>typeof x==='object'?JSON.stringify(x):x))).rows[0].result;
const booking=(name,...args)=>api('voice_booking_api',name)(...args);
const lookup=(name,...args)=>api('voice_lookup_api',name)(...args);
async function book(db,day,callId='booking-call-1',name='Maria del Carmen'){
  const prepared=await booking('prepare',db,tenant,callId,{service:'junk_removal',localDate:day,localTime:'10:00',phone,name,address:'123 Test Street',details:{}});
  assert.equal(prepared.available,true);
  return (await booking('confirm',db,tenant,callId,prepared.holdId)).bookingId;
}

test('new phone bookings no longer need a texted code',async()=>{
  const db=await setup();try{
    const id=await book(db,dayIn(5));
    assert.equal((await db.query('select status from public.sms_bookings where id=$1',[id])).rows[0].status,'confirmed');
  }finally{await db.close();}
});

test('phone finds a booking, the full name unlocks it, and wrong names lock after three tries',async()=>{
  const db=await setup();try{
    await book(db,dayIn(5));
    assert.equal((await lookup('voice_find_bookings',db,tenant,cid,phone)).found,true);
    assert.equal((await lookup('voice_find_bookings',db,tenant,cid,'+13035550199')).found,false);
    await assert.rejects(()=>call(db,'voice_read_customer',tenant,cid,phone),/verification required/);
    assert.equal((await lookup('voice_identify',db,tenant,cid,phone,'Maria')).verified,false);
    const ok=await lookup('voice_identify',db,tenant,cid,phone,'del carmen, MARIA');
    assert.equal(ok.verified,true);
    assert.equal((await call(db,'voice_read_customer',tenant,cid,phone)).bookings.length,1);
    await assert.rejects(()=>call(db,'voice_read_customer',tenant,'other-call-123',phone),/verification required/);
    for(const guess of ['Ana Lopez','Ann Lopez']) assert.equal((await lookup('voice_identify',db,tenant,'locked-call-1',phone,guess)).verified,false);
    assert.equal((await lookup('voice_identify',db,tenant,'locked-call-1',phone,'Jo Lopez')).attemptsLeft,0);
    assert.equal((await lookup('voice_identify',db,tenant,'locked-call-1',phone,'Maria del Carmen')).verified,false);
  }finally{await db.close();}
});

test('a name-confirmed caller can move, update and cancel their booking',async()=>{
  const db=await setup();try{
    const id=await book(db,dayIn(10));
    const move={kind:'reschedule',bookingId:id,phone,localDate:dayIn(11),localTime:'14:00'};
    await assert.rejects(()=>booking('check_change',db,tenant,cid,move),/Confirm the name/);
    await lookup('voice_identify',db,tenant,cid,phone,'Maria del Carmen');
    const checked=await booking('check_change',db,tenant,cid,move);
    assert.equal(checked.available,true);assert.equal(checked.lateFee,0);
    const moved=await booking('apply_change',db,tenant,cid,move);
    assert.equal(moved.status,'confirmed');
    const row=(await db.query("select appointment_at,metadata from public.sms_bookings where id=$1",[id])).rows[0];
    assert.equal(new Date(row.appointment_at).toISOString(),`${dayIn(11)}T14:00:00.000Z`);
    assert.equal(row.metadata.voice_changes.length,1);
    assert.equal((await db.query("select appointment_at from public.sms_automation_bookings where source_record_id=$1",[id])).rows[0].appointment_at.toISOString(),`${dayIn(11)}T14:00:00.000Z`);
    assert.equal((await booking('apply_change',db,tenant,cid,move)).duplicate,true);
    await book(db,dayIn(12),'booking-call-2','Someone Else');
    const taken=await booking('check_change',db,tenant,cid,{...move,localDate:dayIn(12),localTime:'10:00'});
    assert.equal(taken.available,false);
    const updated=await booking('apply_change',db,tenant,cid,{kind:'update',bookingId:id,phone,address:'456 New Avenue',notes:'Add a couch'});
    assert.equal(updated.address,'456 New Avenue');
    assert.equal((await db.query("select extra_answers from public.sms_bookings where id=$1",[id])).rows[0].extra_answers.voice_notes,'Add a couch');
    const cancelled=await booking('apply_change',db,tenant,cid,{kind:'cancel',bookingId:id,phone});
    assert.equal(cancelled.status,'cancelled');
    assert.equal((await booking('apply_change',db,tenant,cid,{kind:'cancel',bookingId:id,phone})).duplicate,true);
    assert.equal((await db.query("select status from public.sms_automation_bookings where source_record_id=$1",[id])).rows[0].status,'cancelled');
    assert.ok((await db.query("select 1 from sms_private.audit where action='booking_voice_cancel'")).rows.length);
  }finally{await db.close();}
});

test('changes inside 72 hours need the $69 fee agreed, and other phones cannot touch the booking',async()=>{
  const db=await setup();try{
    const id=await book(db,dayIn(2));
    await lookup('voice_identify',db,tenant,cid,phone,'Maria del Carmen');
    assert.equal((await booking('check_change',db,tenant,cid,{kind:'cancel',bookingId:id,phone})).lateFee,69);
    await assert.rejects(()=>booking('apply_change',db,tenant,cid,{kind:'cancel',bookingId:id,phone}),/\$69/);
    await booking('apply_change',db,tenant,cid,{kind:'cancel',bookingId:id,phone,lateFeeAccepted:'true'});
    assert.equal((await db.query("select metadata from public.sms_bookings where id=$1",[id])).rows[0].metadata.late_change_fee,69);
    await assert.rejects(()=>booking('apply_change',db,tenant,cid,{kind:'cancel',bookingId:id,phone:'+13035550199'}),/Confirm the name/);
    await db.exec('set role sms_voice_booking');
    await assert.rejects(()=>db.query('select * from sms_private.voice_identity_checks'),/permission denied/);
    await assert.rejects(()=>db.query("select sms_private.voice_change_booking('x','y','{}',true)"),/permission denied/);
    await db.exec('reset role');
  }finally{await db.close();}
});
