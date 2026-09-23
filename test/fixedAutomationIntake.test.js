import test from 'node:test';
import assert from 'node:assert/strict';
import { testDatabase, call } from './helpers/database.js';
import { createCrmHandler } from '../supabase/functions/crm-api/handler.js';

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
