import test from 'node:test';
import assert from 'node:assert/strict';
import { testDatabase, call } from './helpers/database.js';
import { createCrmHandler } from '../supabase/functions/crm-api/handler.js';

test('a new conflicting quote clears an unfinished booking draft but keeps consent',async()=>{
 const db=await testDatabase();
 try {
  await call(db,'api_action','admin',null,'create_business',{id:'alpha',name:'Alpha',timeZone:'UTC'});
  const phone='+13035550188';
  await call(db,'api_action','admin','alpha','contact',{phone,name:'Old customer'});
  await call(db,'api_action','admin','alpha','consent',{phone,consent:true,evidence:'Test opt-in'});
  await db.query(`insert into public.sms_booking_sessions
    (tenant_id,contact_id,customer_phone,settings_version,conversation_generation,customer_name,service_address)
    select 'alpha',id,phone,1,1,'Old customer','Old street' from public.sms_contacts where phone=$1`,[phone]);
  await db.query(`insert into public.sms_automation_quote_requests(tenant_id,name,phone,details)
    values('alpha','New customer',$1,$2::jsonb)`,[phone,JSON.stringify({service_address:'New street'})]);
  assert.equal((await db.query("select count(*) from public.sms_booking_sessions where tenant_id='alpha'")).rows[0].count,0);
  assert.equal((await db.query('select marketing_consent from public.sms_contacts where phone=$1',[phone])).rows[0].marketing_consent,true);
 } finally {await db.close();}
});

test('Quote Request default becomes day zero without changing custom rules or enrolled due times', async () => {
  let priorDue;
  const db = await testDatabase({ beforeMigration: async (database, file) => {
    if (file !== '20260923080000_quote_request_immediate.sql') return;
    await database.exec("insert into sms_private.admins values('admin') on conflict do nothing");
    await call(database, 'api_action', 'admin', null, 'create_business', { id: 'custom', name: 'Custom', timeZone: 'UTC' });
    await call(database, 'api_action', 'admin', null, 'create_business', { id: 'default', name: 'Default', timeZone: 'UTC' });
    await database.exec("update public.sms_automation_groups set rule=jsonb_set(rule,'{firstDelayCount}','5'::jsonb) where tenant_id='custom' and fixed_type='quote_requests'");
    await call(database, 'api_action', 'admin', 'default', 'contact', { phone: '+13035550191', name: 'Test' });
    await call(database, 'api_action', 'admin', 'default', 'consent', { phone: '+13035550191', consent: true, evidence: 'Test opt-in' });
    const intake = await call(database, 'create_intake', 'admin', 'default', 'quote_requests', {
      phone: '+13035550191', source: 'test', sourceRecordId: 'before-rule-change', details: {},
    });
    priorDue = (await database.query('select next_run_at from public.sms_automation_enrollments where id=$1', [intake.enrollment_id])).rows[0].next_run_at;
  } });
  try {
    const groups = (await db.query("select tenant_id,rule from public.sms_automation_groups where fixed_type='quote_requests' and tenant_id in ('custom','default') order by tenant_id")).rows;
    assert.deepEqual(groups.map(group => [group.tenant_id, group.rule.firstDelayCount]), [['custom', 5], ['default', 0]]);
    const due = (await db.query("select next_run_at from public.sms_automation_enrollments where tenant_id='default'")).rows[0].next_run_at;
    assert.equal(new Date(due).toISOString(), new Date(priorDue).toISOString());
    await call(db, 'api_action', 'admin', null, 'create_business', { id: 'future', name: 'Future', timeZone: 'UTC' });
    const future = (await db.query("select rule from public.sms_automation_groups where tenant_id='future' and fixed_type='quote_requests'")).rows[0].rule;
    assert.equal(future.firstDelayCount, 0);
    assert.equal(future.intervalCount, 2);
    assert.equal(future.startHour, 9);
    assert.equal(future.endHour, 19);
    const businessHours = await db.query("select sms_private.automation_due('2026-09-01T16:00:00Z'::timestamptz,$1::jsonb,'America/Denver',true) as due", [JSON.stringify(future)]);
    const afterHours = await db.query("select sms_private.automation_due('2026-09-01T03:00:00Z'::timestamptz,$1::jsonb,'America/Denver',true) as due", [JSON.stringify(future)]);
    assert.equal(new Date(businessHours.rows[0].due).toISOString(), '2026-09-01T16:00:00.000Z');
    assert.equal(new Date(afterHours.rows[0].due).toISOString(), '2026-09-01T15:00:00.000Z');
  } finally { await db.close(); }
});

test('fixed intake tables enroll only eligible rows and progress through lifecycle types', async () => {
  const db = await testDatabase();
  try {
    await call(db, 'api_action', 'admin', null, 'create_business', { id: 'alpha', name: 'Alpha', timeZone: 'UTC' });
    const groups = (await db.query("select fixed_type from public.sms_automation_groups where tenant_id='alpha' order by fixed_type")).rows;
    assert.deepEqual(groups.map(row => row.fixed_type), ['bookings', 'contacts', 'quote_requests', 'reviews']);

    const phone = '+13035550123';
    const skipped = (await db.query("insert into public.sms_automation_contacts(tenant_id,name,phone,details,source_record_id) values('alpha','Alex',$1,'{\"interest\":\"moving\"}', 'first') returning *", [phone])).rows[0];
    assert.equal(skipped.intake_state, 'skipped');
    assert.equal(skipped.skip_reason, 'CONSENT_REQUIRED');
    assert.equal((await db.query('select marketing_consent from public.sms_contacts where phone=$1', [phone])).rows[0].marketing_consent, false);
    await call(db, 'api_action', 'admin', 'alpha', 'consent', { phone, consent: true, evidence: 'Customer opted in on intake form' });

    const contact = (await db.query("insert into public.sms_automation_contacts(tenant_id,name,phone,source_record_id) values('alpha','Alex',$1,'second') returning *", [phone])).rows[0];
    assert.equal(contact.intake_state, 'enrolled');
    const quote1 = (await db.query("insert into public.sms_automation_quote_requests(tenant_id,name,phone,details,source_record_id) values('alpha','Alex',$1,'{\"service\":\"moving\"}','quote-1') returning *", [phone])).rows[0];
    assert.equal(quote1.intake_state, 'enrolled');
    assert.equal((await db.query('select status from public.sms_automation_enrollments where id=$1', [contact.enrollment_id])).rows[0].status, 'cancelled');
    const quote2 = (await db.query("insert into public.sms_automation_quote_requests(tenant_id,name,phone,details,source_record_id) values('alpha','Alex',$1,'{\"service\":\"packing\"}','quote-2') returning *", [phone])).rows[0];
    assert.equal((await db.query('select status from public.sms_automation_enrollments where id=$1', [quote1.enrollment_id])).rows[0].status, 'cancelled');
    await assert.rejects(() => db.query("insert into public.sms_automation_quote_requests(tenant_id,name,phone,source_record_id) values('alpha','Alex',$1,'quote-2')", [phone]));

    const booking = (await db.query("insert into public.sms_automation_bookings(tenant_id,name,phone,status,appointment_at,source_record_id) values('alpha','Alex',$1,'requested',now()+interval '3 days','booking-1') returning *", [phone])).rows[0];
    assert.equal(booking.intake_state, 'waiting_confirmation');
    assert.equal((await db.query('select status from public.sms_automation_enrollments where id=$1', [quote2.enrollment_id])).rows[0].status, 'active');
    const confirmed = (await db.query("update public.sms_automation_bookings set status='confirmed' where id=$1 returning *", [booking.id])).rows[0];
    assert.equal(confirmed.intake_state, 'enrolled');
    assert.equal((await db.query('select status from public.sms_automation_enrollments where id=$1', [quote2.enrollment_id])).rows[0].status, 'cancelled');
    const rescheduled = (await db.query("update public.sms_automation_bookings set appointment_at=appointment_at+interval '1 day' where id=$1 returning *", [booking.id])).rows[0];
    assert.notEqual(rescheduled.enrollment_id, confirmed.enrollment_id);
    assert.equal((await db.query('select status from public.sms_automation_enrollments where id=$1', [confirmed.enrollment_id])).rows[0].status, 'cancelled');

    const review = (await db.query("insert into public.sms_automation_reviews(tenant_id,name,phone,details,source_record_id) values('alpha','Alex',$1,'{\"service\":\"moving\"}','review-1') returning *", [phone])).rows[0];
    assert.equal(review.intake_state, 'enrolled');
    assert.equal((await db.query('select status from public.sms_automation_enrollments where id=$1', [rescheduled.enrollment_id])).rows[0].status, 'cancelled');
    await call(db, 'api_action', 'admin', 'alpha', 'consent', { phone, consent: false, evidence: 'STOP' });
    const optedOut = (await db.query("insert into public.sms_automation_reviews(tenant_id,name,phone,source_record_id) values('alpha','Alex',$1,'review-2') returning *", [phone])).rows[0];
    assert.equal(optedOut.skip_reason, 'OPTED_OUT');
    assert.equal((await db.query('select status from public.sms_automation_enrollments where id=$1', [review.enrollment_id])).rows[0].status, 'cancelled');
  } finally { await db.close(); }
});

test('migration preserves pre-existing quote and booking records without backfilling sends', async () => {
  const db = await testDatabase({ beforeMigration: async (database, file) => {
    if (!file.endsWith('fixed_automation_intake.sql')) return;
    await database.exec("insert into sms_private.admins values('admin') on conflict do nothing");
    await call(database, 'api_action', 'admin', null, 'create_business', { id: 'alpha', name: 'Alpha', timeZone: 'UTC' });
    await call(database, 'api_action', 'admin', 'alpha', 'contact', { phone: '+13035550128', name: 'Alex' });
    const quoteRule = { anchor: 'enrollment', firstDelayCount: 1, firstDelayUnit: 'day', intervalCount: 2,
      intervalUnit: 'day', repeatCount: 6, leadHours: null, startHour: 9, endHour: 19 };
    const bookingRule = { anchor: 'appointment', firstDelayCount: 0, firstDelayUnit: 'day', intervalCount: 6,
      intervalUnit: 'hour', repeatCount: 1, leadHours: 24, startHour: 0, endHour: 24 };
    await database.query("insert into public.sms_automation_groups(tenant_id,id,name,kind,rule) values('alpha','quote-requests','Quote follow-up','quote',$1::jsonb),('alpha','appointment-reminders','Appointment reminder','reminder',$2::jsonb)", [JSON.stringify(quoteRule), JSON.stringify(bookingRule)]);
    await database.exec("insert into public.sms_automation_intents(tenant_id,group_id,intent) values('alpha','quote-requests','Follow up on the customer quote, answer relevant questions, and help with the next decision without implying acceptance or a confirmed booking.'),('alpha','appointment-reminders','Remind about the confirmed appointment.')");
    await database.exec("insert into public.sms_quotes(tenant_id,id,contact_id,details) select 'alpha','old-quote',id,'{}'::jsonb from public.sms_contacts where tenant_id='alpha'; insert into public.sms_bookings(tenant_id,id,contact_id,appointment_at,status) select 'alpha','old-booking',id,now()+interval '2 days','confirmed' from public.sms_contacts where tenant_id='alpha'");
  } });
  try {
    const groups = (await db.query("select id,fixed_type from public.sms_automation_groups where tenant_id='alpha' order by fixed_type")).rows;
    assert.deepEqual(groups.map(row => row.fixed_type), ['bookings', 'contacts', 'quote_requests', 'reviews']);
    assert.equal(groups.find(row => row.fixed_type === 'quote_requests').id, 'quote-requests');
    assert.equal(groups.find(row => row.fixed_type === 'bookings').id, 'appointment-reminders');
    assert.equal((await db.query("select count(*) from public.sms_automation_quote_requests where tenant_id='alpha'")).rows[0].count, 0);
    assert.equal((await db.query("select count(*) from public.sms_automation_bookings where tenant_id='alpha'")).rows[0].count, 0);
    assert.equal((await db.query("select count(*) from public.sms_quotes where tenant_id='alpha'")).rows[0].count, 1);
    assert.equal((await db.query("select count(*) from public.sms_bookings where tenant_id='alpha'")).rows[0].count, 1);
  } finally { await db.close(); }
});

test('tenant-scoped intake functions preserve idempotency and exact source context', async () => {
  const db = await testDatabase();
  try {
    await call(db, 'api_action', 'admin', null, 'create_business', { id: 'alpha', name: 'Alpha', timeZone: 'UTC' });
    const phone = '+13035550124';
    await call(db, 'api_action', 'admin', 'alpha', 'contact', { phone, name: 'Blair' });
    await call(db, 'api_action', 'admin', 'alpha', 'consent', { phone, consent: true, evidence: 'Test opt-in' });
    const payload = { name: 'Blair', phone, details: { service: 'painting' }, source: 'staff', sourceRecordId: 'same-key' };
    const first = await call(db, 'create_intake', 'admin', 'alpha', 'quote_requests', payload);
    const duplicate = await call(db, 'create_intake', 'admin', 'alpha', 'quote_requests', payload);
    assert.equal(first.id, duplicate.id);
    assert.equal((await call(db, 'list_intake', 'admin', 'alpha', 'quote_requests', 1, 50)).total, 1);
    assert.equal((await db.query('select count(*) from public.sms_automation_enrollments where source_id=$1', [first.id])).rows[0].count, 1);
    await db.exec("update public.sms_automation_intents set system_prompt='Ask a useful question',business_context='Alpha provides painting' where tenant_id='alpha' and group_id='quote-requests'");
    await db.exec("update public.sms_businesses set status='active',sending_enabled=true where tenant_id='alpha'; update sms_private.runtime set scheduler_enabled=true");
    await db.query("update public.sms_automation_enrollments set created_at=now()-interval '2 days',next_run_at=now()-interval '1 minute' where source_id=$1", [first.id]);
    await call(db, 'tick');
    const job = await call(db, 'claim', 'automation_jobs', 'test-worker');
    assert.ok(job, JSON.stringify({ enrollment: (await db.query('select status,next_run_at,created_at from public.sms_automation_enrollments where source_id=$1', [first.id])).rows,
      jobs: (await db.query("select status,dedupe_key from sms_private.jobs where queue='automation_jobs'")).rows }));
    const source = await call(db, 'intake_context', job.id, job.lease_token);
    assert.equal(source.id, first.id);
    assert.equal(source.details.service, 'painting');
  } finally { await db.close(); }
});

test('staff API lists and creates intake rows but refuses arbitrary automation groups', async () => {
  const db = await testDatabase();
  const previousOrigins = process.env.CRM_ALLOWED_ORIGINS;
  process.env.CRM_ALLOWED_ORIGINS = 'https://crm.example.com';
  try {
    await call(db, 'api_action', 'admin', null, 'create_business', { id: 'alpha', name: 'Alpha', timeZone: 'UTC' });
    const handler = createCrmHandler({ call: (name, ...args) => call(db, name, ...args) }, async () => 'admin');
    const headers = { Origin: 'https://crm.example.com', 'X-Tenant-ID': 'alpha', 'Content-Type': 'application/json', 'Idempotency-Key': 'lead-1' };
    const created = await handler(new Request('https://example.com/functions/v1/crm-api/automation-intake/contacts', {
      method: 'POST', headers, body: JSON.stringify({ name: 'Alex', phone: '+13035550126', details: { topic: 'moving' } }),
    }));
    assert.equal(created.status, 201);
    assert.equal((await created.json()).record.skip_reason, 'CONSENT_REQUIRED');
    const listed = await handler(new Request('https://example.com/functions/v1/crm-api/automation-intake/contacts', { headers }));
    assert.equal((await listed.json()).total, 1);
    const rejected = await handler(new Request('https://example.com/functions/v1/crm-api/automation-groups', {
      method: 'POST', headers, body: JSON.stringify({ name: 'Custom' }),
    }));
    assert.equal(rejected.status, 405);
    const oldEnroll = await handler(new Request('https://example.com/functions/v1/crm-api/directory/enroll', {
      method: 'POST', headers, body: JSON.stringify({ phone: '+13035550126', categoryId: 'sms-contact' }),
    }));
    assert.equal(oldEnroll.status, 405);
  } finally {
    if (previousOrigins === undefined) delete process.env.CRM_ALLOWED_ORIGINS;
    else process.env.CRM_ALLOWED_ORIGINS = previousOrigins;
    await db.close();
  }
});

test('signed business events mirror quote and booking records into intake exactly once', async () => {
  const db = await testDatabase();
  try {
    await call(db, 'api_action', 'admin', null, 'create_business', { id: 'alpha', name: 'Alpha', timeZone: 'UTC' });
    const phone = '+13035550127';
    await call(db, 'api_action', 'admin', 'alpha', 'contact', { phone, name: 'Alex' });
    await call(db, 'api_action', 'admin', 'alpha', 'consent', { phone, consent: true, evidence: 'Opted in' });
    const quote = { eventId: 'event-quote', id: 'quote-1', type: 'quote.created', phone, name: 'Alex', metadata: { service: 'painting' } };
    await call(db, 'ingest_event', 'alpha', quote);
    assert.equal((await db.query("select count(*) from public.sms_automation_quote_requests where tenant_id='alpha'")).rows[0].count, 1);
    assert.equal((await call(db, 'ingest_event', 'alpha', quote)).duplicate, true);
    const appointment_at = new Date(Date.now() + 3 * 86400000).toISOString();
    await call(db, 'ingest_event', 'alpha', { eventId: 'event-booking', id: 'booking-1', type: 'booking.created', phone, appointment_at, metadata: { service: 'painting' } });
    const first = (await db.query("select * from public.sms_automation_bookings where tenant_id='alpha'")).rows[0];
    assert.equal(first.intake_state, 'enrolled');
    assert.equal((await db.query("select count(*) from public.sms_automation_enrollments where tenant_id='alpha' and status='active'")).rows[0].count, 1);
    await call(db, 'ingest_event', 'alpha', { eventId: 'event-booking-replayed', id: 'booking-1', type: 'booking.created', phone, appointment_at, metadata: { service: 'painting' } });
    assert.equal((await db.query("select enrollment_id from public.sms_automation_bookings where tenant_id='alpha'")).rows[0].enrollment_id, first.enrollment_id);
    await call(db, 'ingest_event', 'alpha', { eventId: 'event-reschedule', id: 'booking-1', type: 'booking.rescheduled', phone, appointment_at: new Date(Date.now() + 4 * 86400000).toISOString(), metadata: { service: 'painting' } });
    const changed = (await db.query("select * from public.sms_automation_bookings where tenant_id='alpha'")).rows[0];
    assert.notEqual(changed.enrollment_id, first.enrollment_id);
    assert.equal((await db.query("select count(*) from public.sms_automation_bookings where tenant_id='alpha'")).rows[0].count, 1);
    assert.equal((await db.query("select count(*) from public.sms_automation_enrollments where tenant_id='alpha' and source_type='bookings'")).rows[0].count, 2);
    await call(db, 'ingest_event', 'alpha', { eventId: 'event-cancel', id: 'booking-1', type: 'booking.cancelled', phone, appointment_at, metadata: { service: 'painting' } });
    assert.equal((await db.query("select intake_state from public.sms_automation_bookings where tenant_id='alpha'")).rows[0].intake_state, 'cancelled');
    assert.equal((await db.query("select count(*) from public.sms_automation_enrollments where tenant_id='alpha' and status='active'")).rows[0].count, 0);
  } finally { await db.close(); }
});

