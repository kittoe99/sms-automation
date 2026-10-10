import {testDatabase,call} from './database.js';
export const tenant='biz-1c0c09ce-819e-4795-86b9-0e457ab92f58',phone='+13035550122';
export async function setupCoordination({mode='live',database}={}) {
 const db=await testDatabase({database});
 await call(db,'api_action','admin',null,'create_business',{id:tenant,name:'Pilot',timeZone:'UTC'});
 await db.query("update public.sms_businesses set status='active',sending_enabled=true where tenant_id=$1",[tenant]);
 await db.query("update sms_private.providers set account_sid=$2,from_number='+18005550100',auth_secret_id=vault.create_secret('synthetic-secret') where tenant_id=$1",[tenant,'AC'+'a'.repeat(32)]);
 await db.query("insert into sms_private.inbound_ai_settings(tenant_id,mode,booking_enabled,coordination_enabled) values($1,$2,true,true)",[tenant,mode]);
 await db.query("insert into public.sms_contacts(tenant_id,phone,name,marketing_consent) values($1,$2,'Test Customer',true)",[tenant,phone]);
 const hours=Object.fromEntries(Array.from({length:7},(_,i)=>[i,[{start:'09:00',end:'17:00'}]]));
 await call(db,'voice_save_rule','admin',tenant,{service:'junk_removal',market:'Pilot',resourcePool:'crew',timeZone:'UTC',enabled:true,durationMinutes:60,capacity:1,minimumNoticeMinutes:0,maximumAdvanceDays:90,weeklyAvailability:hours,dateExceptions:[]});
 return db;
}
export async function addRun(db,{title='Junk enquiry',policy='continue',appointment=false,customer=phone,business=tenant}={}) {
 const form=(await db.query("insert into public.sms_web_form_definitions(tenant_id,preset,title) values($1,'contacts',$2) returning public_id",[business,title])).rows[0].public_id;
 const sequence={trigger:appointment?'appointment':'submission',replyPolicy:policy,startHour:0,endHour:24,leadHours:24,steps:[{body:'Do you still need help?',delayCount:0,delayUnit:'minute',sendCount:3,intervalCount:1,intervalUnit:'minute'}]};
 await db.query('insert into sms_private.form_sequences(tenant_id,form_id,published_version,enabled) values($1,$2,1,true)',[business,form]);
 await db.query('insert into sms_private.form_sequence_versions(tenant_id,form_id,version,sequence) values($1,$2,1,$3)',[business,form,JSON.stringify(sequence)]);
 return (await db.query("insert into sms_private.form_runs(tenant_id,form_id,version,submission_id,phone,context,next_run_at,appointment_at) values($1,$2,1,gen_random_uuid(),$3,'{\"name\":\"Alex\",\"fields\":{\"service\":\"junk removal\"}}',now(),case when $4 then now()+interval '1 day' end) returning *",[business,form,customer,appointment])).rows[0];
}
export async function incoming(db,body='Hello',sid=crypto.randomUUID()) {
 await call(db,'record_webhook',tenant,'inbound',{From:phone,To:'+18005550100',Body:body,MessageSid:sid});
 await db.query("update sms_private.jobs set available_at=now() where queue='ai_reply_jobs'");
 await db.query("update pgmq.test_messages set vt=now() where q='ai_reply_jobs'");
 return call(db,'claim','ai_reply_jobs','test-ai');
}
export const invoke=(db,job,name,args={})=>call(db,'inbound_ai_tool',job.id,job.lease_token,name,args);
export const details=()=>({service:'junk_removal',name:'Test Person',address:'123 Test Street',localDate:new Date(Date.now()+3*86400000).toISOString().slice(0,10),localTime:'10:00',details:{notes:null}});
export const runState=async(db,run)=>(await db.query('select * from sms_private.form_runs where id=$1',[run.id])).rows[0];
export async function accepted(db,messageId) {await db.query("update public.sms_messages set provider_accepted_at=clock_timestamp(),status='accepted' where id=$1",[messageId]);}
export async function queuedForm(db) {
 await call(db,'enqueue_due_automations');
 const job=await call(db,'claim','automation_jobs','test-automation');
 return {job,out:job?await call(db,'process_form_automation',job.id,job.lease_token):null};
}
