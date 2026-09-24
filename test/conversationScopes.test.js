import test from 'node:test';
import assert from 'node:assert/strict';
import {testDatabase,call} from './helpers/database.js';
import {createCrmHandler} from '../supabase/functions/crm-api/handler.js';
const rule=JSON.stringify({anchor:'enrollment',firstDelayCount:0,firstDelayUnit:'day',intervalCount:1,
  intervalUnit:'day',repeatCount:1,leadHours:null,startHour:0,endHour:24});

async function setup(db) {
  await db.exec(`
    insert into public.sms_businesses(tenant_id,name,time_zone,status,sending_enabled)
      values('alpha','Alpha','UTC','active',true);
    insert into public.sms_contacts(tenant_id,phone) values('alpha','+13035550199');
    insert into public.sms_automation_groups(tenant_id,id,name,rule) values
      ('alpha','group-a','Group A','${rule}'::jsonb),('alpha','group-b','Group B','${rule}'::jsonb);
    insert into public.sms_automation_intents(tenant_id,group_id,intent,system_prompt,business_context)
      values('alpha','group-a','Help with A','Ask about A','A facts'),
        ('alpha','group-b','Help with B','Ask about B','B facts');
    insert into public.sms_ai_settings(tenant_id,group_id,enabled)
      values('alpha','group-a',true),('alpha','group-b',true);
    insert into public.sms_business_ai_settings(tenant_id,enabled,system_prompt)
      values('alpha',true,'Ask an unfamiliar texter what they need.');
  `);
}

async function incoming(db,sid,body='Hello') {
  await call(db,'record_webhook','alpha','inbound',{
    From:'+13035550199',MessageSid:sid,Body:body,
  });
  return (await db.query('select * from public.sms_messages where tenant_id=$1 and sid=$2',['alpha',sid])).rows[0];
}

test('a phone has separate general and group histories; only accepted outbound controls inbound routing',async()=>{
  const db=await testDatabase();try {
    await setup(db);
    await db.exec(`
      insert into public.sms_messages(tenant_id,contact_phone,direction,body,category_id,status)
        values('alpha','+13035550199','outbound','A is queued','group-a','queued');
      insert into public.sms_messages(tenant_id,contact_phone,direction,body,category_id,status,provider_accepted_at)
        values('alpha','+13035550199','outbound','B was sent','group-b','accepted',now()-interval '1 day');
    `);
    const first=await incoming(db,'SM_scope_1');
    const groupB=(await db.query("select id from public.sms_conversations where tenant_id='alpha' and group_id='group-b'")).rows[0].id;
    assert.equal(first.conversation_id,groupB);
    const firstJob=(await db.query("select payload from sms_private.jobs where tenant_id='alpha' and queue='ai_reply_jobs' and dedupe_key='SM_scope_1'")).rows[0];
    assert.equal(firstJob.payload.conversation_id,groupB);
    assert.equal(firstJob.payload.group_id,'group-b');
    await db.exec("update public.sms_messages set status='accepted' where tenant_id='alpha' and body='A is queued'");
    const second=await incoming(db,'SM_scope_2');
    const groupA=(await db.query("select id from public.sms_conversations where tenant_id='alpha' and group_id='group-a'")).rows[0].id;
    assert.equal(second.conversation_id,groupA);
    await db.exec(`insert into public.sms_messages(tenant_id,contact_phone,direction,body,status,provider_accepted_at)
      values('alpha','+13035550199','outbound','General reply','accepted',now())`);
    const third=await incoming(db,'SM_scope_3');
    const general=(await db.query("select id from public.sms_conversations where tenant_id='alpha' and group_id is null")).rows[0].id;
    assert.equal(third.conversation_id,general);
    const groupContextJob=(await call(db,'claim','ai_reply_jobs','ai')).id;
    assert.ok(groupContextJob);
    const list=await call(db,'list_conversation_threads','admin','alpha',{page:1,pageSize:50});
    assert.equal(list.total,3);
    assert.equal(list.unreadTotal,3);
    assert.equal((await call(db,'list_conversation_threads','admin','alpha',{page:1,pageSize:1})).unreadTotal,3);
    assert.equal((await call(db,'api_read','admin','alpha','overview',{})).conversationCount,3);
    assert.deepEqual(new Set(list.rows.map(x=>x.group_id)),new Set([null,'group-a','group-b']));
    const detail=await call(db,'conversation_detail','admin','alpha',groupB);
    assert.deepEqual(detail.messages.map(x=>x.body).sort(),['B was sent','Hello']);
    await db.exec("update public.sms_messages set provider_accepted_at=now()-interval '8 days' where tenant_id='alpha' and direction='outbound'");
    assert.equal((await incoming(db,'SM_scope_4')).conversation_id,general);
  }finally{await db.close();}
});

test('staff can reassign inbound text and reply in the chosen conversation',async()=>{
  const db=await testDatabase();try {
    await setup(db);
    await db.exec(`insert into public.sms_messages(tenant_id,contact_phone,direction,body,category_id,status,provider_accepted_at)
      values('alpha','+13035550199','outbound','A sent','group-a','accepted',now())`);
    const message=await incoming(db,'SM_move_1');
    const moved=await call(db,'reassign_inbound_message','admin','alpha',message.id,'group-b');
    assert.equal(moved.changed,true);
    const job=(await db.query("select status from sms_private.jobs where tenant_id='alpha' and queue='ai_reply_jobs' and dedupe_key='SM_move_1'")).rows[0];
    assert.equal(job.status,'cancelled');
    assert.equal((await incoming(db,'SM_move_2')).conversation_id,moved.conversationId);
    const reply=await call(db,'conversation_action','admin','alpha',moved.conversationId,'reply',{
      body:'A staff reply for B.',idempotencyKey:'manual-b-1',
    });
    const outbound=(await db.query('select conversation_id,category_id from public.sms_messages where tenant_id=$1 and id=$2',['alpha',reply.messageId])).rows[0];
    assert.equal(outbound.conversation_id,moved.conversationId);
    assert.equal(outbound.category_id,'group-b');
    const handler=createCrmHandler({call:(name,...args)=>call(db,name,...args)},async()=> 'admin');
    const list=await handler(new Request('https://example.com/functions/v1/crm-api/conversations',{headers:{'X-Tenant-ID':'alpha'}}));
    assert.equal(list.status,200);
    assert.equal((await list.json()).conversations.some(c=>c.id===moved.conversationId && c.groupName==='Group B'),true);
  }finally{await db.close();}
});

test('group AI reads only its conversation and can answer after enrollment has completed',async()=>{
  const db=await testDatabase();try {
    await setup(db);
    await db.exec(`
      insert into public.sms_messages(tenant_id,contact_phone,direction,body,category_id,status,provider_accepted_at)
        values('alpha','+13035550199','outbound','Unrelated B details','group-b','accepted',now()-interval '2 days'),
          ('alpha','+13035550199','outbound','A request details','group-a','accepted',now()-interval '1 day');
    `);
    await incoming(db,'SM_completed_group','I have a question about A.');
    const job=await call(db,'claim','ai_reply_jobs','ai');
    assert.equal(job.payload.group_id,'group-a');
    const context=await call(db,'job_context',job.id,job.lease_token);
    assert.equal(context.inboundAi.scope,'group');
    assert.equal(context.conversation.id,job.payload.conversation_id);
    assert.equal(context.history.some(m=>m.body==='Unrelated B details'),false);
    assert.equal(context.history.some(m=>m.body==='A request details'),true);
    const result=await call(db,'complete_grounded_ai',job.id,job.lease_token,{
      reply:'Thanks for asking about A. What detail can I clarify?',disposition:'collect_lead',
      grounded:false,citationIds:[],lead:{},bookingIntent:'none',
      leadSummary:'A question',mode:'live',model:'test',
    });
    assert.ok(result.messageId);
    const sent=(await db.query('select conversation_id,category_id from public.sms_messages where tenant_id=$1 and id=$2',['alpha',result.messageId])).rows[0];
    assert.equal(sent.conversation_id,context.conversation.id);
    assert.equal(sent.category_id,'group-a');
  }finally{await db.close();}
});

test('migration keeps old inbound in General and explicit group outbound in its group',async()=>{
  const db=await testDatabase({beforeMigration:async(database,file)=>{
    if(file!=='20260924030000_conversation_scopes.sql')return;
    await database.exec(`
      insert into public.sms_businesses(tenant_id,name) values('archive','Archive');
      insert into public.sms_contacts(tenant_id,phone) values('archive','+13035550198');
      insert into public.sms_automation_groups(tenant_id,id,name,rule)
        values('archive','group-a','Group A','${rule}'::jsonb);
      insert into public.sms_messages(tenant_id,sid,contact_phone,direction,body,category_id,status)
        values('archive','SM_old_out','+13035550198','outbound','Old A','group-a','delivered'),
          ('archive','SM_old_in','+13035550198','inbound','Old reply',null,'received');
    `);
  }});try {
    const rows=(await db.query("select m.sid,m.conversation_id,c.group_id,m.provider_accepted_at from public.sms_messages m join public.sms_conversations c on c.tenant_id=m.tenant_id and c.id=m.conversation_id where m.tenant_id='archive' order by m.sid")).rows;
    assert.equal(rows.length,2);
    assert.equal(rows.find(x=>x.sid==='SM_old_out').group_id,'group-a');
    assert.ok(rows.find(x=>x.sid==='SM_old_out').provider_accepted_at);
    assert.equal(rows.find(x=>x.sid==='SM_old_in').group_id,null);
  }finally{await db.close();}
});

