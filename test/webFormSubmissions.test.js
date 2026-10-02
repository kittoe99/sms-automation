import test from 'node:test';
import assert from 'node:assert/strict';
import { testDatabase, call } from './helpers/database.js';

const forms = [
  ['sms_web_form_contact_submissions', 'sms_automation_contacts', 'contacts', '+13035550151'],
  ['sms_web_form_quote_request_submissions', 'sms_automation_quote_requests', 'quote_requests', '+13035550152'],
  ['sms_web_form_booking_submissions', 'sms_automation_bookings', 'bookings', '+13035550153'],
];

async function business(db, id) {
  await call(db, 'api_action', 'admin', null, 'create_business', {
    id, name: id, timeZone: 'UTC',
  });
}

test('Web Forms submissions retain business ownership and enter the matching fixed groups', async () => {
  const db = await testDatabase();
  try {
    await business(db, 'alpha');
    await business(db, 'beta');
    const appointment = new Date(Date.now() + 3 * 86400000).toISOString();
    for (const [webTable, intakeTable, fixedType, phone] of forms) {
      for (const tenant of ['alpha', 'beta']) {
        const email = `${fixedType}-${tenant}@example.com`;
        const details = { customQuestion: `${tenant} answer` };
        const params = [tenant, 'Alex', phone, email, JSON.stringify(details), true, 'Website checkbox: SMS updates'];
        const booking = fixedType === 'bookings';
        if (booking) params.push(appointment);
        const row = (await db.query(`insert into public.${webTable}
          (tenant_id,name,phone,email,details,sms_opt_in,consent_evidence${booking ? ',appointment_at' : ''})
          values(${params.map((_, index) => `$${index + 1}`).join(',')}) returning *`, params)).rows[0];
        const group = (await db.query('select id from public.sms_automation_groups where tenant_id=$1 and fixed_type=$2', [tenant, fixedType])).rows[0];
        assert.equal(row.automation_group_id, group.id);
        const intake = (await db.query(`select * from public.${intakeTable} where tenant_id=$1 and id=$2`, [tenant, row.automation_intake_id])).rows[0];
        assert.equal(intake.source, 'web_form');
        assert.equal(intake.source_record_id, row.id);
        assert.equal(intake.email, email);
        assert.deepEqual(intake.details, details);
        assert.equal(intake.intake_state, 'enrolled');
        if (booking) {
          assert.equal(intake.status, 'confirmed');
          assert.equal(new Date(intake.appointment_at).toISOString(), appointment);
        }
        const enrollment = (await db.query('select category_id,tenant_id from public.sms_automation_enrollments where tenant_id=$1 and id=$2', [tenant, intake.enrollment_id])).rows[0];
        assert.equal(enrollment.category_id, group.id);
        assert.equal(enrollment.tenant_id, tenant);
        assert.equal((await db.query('select email from public.sms_contacts where tenant_id=$1 and phone=$2', [tenant, phone])).rows[0].email, email);
        assert.equal((await db.query("select count(*) from public.sms_consent_events where tenant_id=$1 and source='web_form' and evidence=$2", [tenant, 'Website checkbox: SMS updates'])).rows[0].count, 1 + forms.findIndex(form => form[2] === fixedType));
      }
    }

    await db.exec("insert into public.sms_business_memberships(tenant_id,clerk_user_id,role) values('alpha','alpha-viewer','viewer')");
    await db.exec(`set role authenticated; select set_config('request.jwt.claims','{"sub":"alpha-viewer"}',false);`);
    for (const [webTable] of forms) {
      const rows = (await db.query(`select tenant_id from public.${webTable}`)).rows;
      assert.deepEqual(rows.map(row => row.tenant_id), ['alpha']);
      await assert.rejects(() => db.query(`insert into public.${webTable}(tenant_id,name,phone,email) values('alpha','No','+13035550199','no@example.com')`), /permission denied/);
    }
    await db.exec('reset role');
  } finally { await db.close(); }
});

test('Web Forms enforce required fields, matching groups, and unique submission identity', async () => {
  const db = await testDatabase();
  try {
    await business(db, 'alpha');
    const required = ['alpha', 'Alex', '+13035550154', 'alex@example.com'];
    await assert.rejects(() => db.query(`insert into public.sms_web_form_contact_submissions(tenant_id,name,phone,email)
      values($1,$2,$3,$4)`, ['alpha', ' ', ...required.slice(2)]), /check constraint/);
    await assert.rejects(() => db.query(`insert into public.sms_web_form_contact_submissions(tenant_id,name,phone,email)
      values($1,$2,$3,null)`, required.slice(0, 3)), /not-null constraint/);
    await assert.rejects(() => db.query(`insert into public.sms_web_form_contact_submissions(tenant_id,name,phone,email)
      values($1,$2,'123',$3)`, [required[0], required[1], required[3]]), /check constraint/);
    await assert.rejects(() => db.query(`insert into public.sms_web_form_contact_submissions(tenant_id,name,phone,email)
      values($1,$2,$3,'invalid')`, required.slice(0, 3)), /check constraint/);
    await assert.rejects(() => db.query(`insert into public.sms_web_form_contact_submissions(tenant_id,name,phone,email,details)
      values($1,$2,$3,$4,'[]'::jsonb)`, required), /check constraint/);
    await assert.rejects(() => db.query(`insert into public.sms_web_form_contact_submissions(tenant_id,name,phone,email,sms_opt_in)
      values($1,$2,$3,$4,true)`, required), /evidence required/);
    await assert.rejects(() => db.query(`insert into public.sms_web_form_booking_submissions(tenant_id,name,phone,email)
      values($1,$2,$3,$4)`, required), /not-null constraint/);
    await assert.rejects(() => db.query(`insert into public.sms_web_form_booking_submissions(tenant_id,name,phone,email,appointment_at)
      values($1,$2,$3,$4,now()-interval '1 day')`, required), /Future appointment required/);
    await assert.rejects(() => db.query(`insert into public.sms_web_form_contact_submissions(tenant_id,name,phone,email,automation_group_id)
      values($1,$2,$3,$4,'quote-requests')`, required), /does not match form type/);
    await assert.rejects(() => db.query(`insert into public.sms_web_form_contact_submissions(tenant_id,name,phone,email)
      values($1,$2,$3,$4)`, ['unknown', ...required.slice(1)]), /group is unavailable/);

    const id = 'b09df3f7-8da8-43d9-8072-f8f6ce8959cf';
    const inserted = (await db.query(`insert into public.sms_web_form_contact_submissions(tenant_id,id,name,phone,email)
      values($1,$2,$3,$4,$5) returning *`, ['alpha', id, ...required.slice(1)])).rows[0];
    assert.equal(inserted.id, id);
    await assert.rejects(() => db.query(`insert into public.sms_web_form_contact_submissions(tenant_id,id,name,phone,email)
      values($1,$2,$3,$4,$5)`, ['alpha', id, ...required.slice(1)]), /duplicate key/);
    assert.equal((await db.query("select count(*) from public.sms_automation_contacts where tenant_id='alpha' and source_record_id=$1", [id])).rows[0].count, 1);
  } finally { await db.close(); }
});

test('Web Forms consent and custom-field edits do not bypass opt-out or restart automation', async () => {
  const db = await testDatabase();
  try {
    await business(db, 'alpha');
    const phone = '+13035550155';
    await call(db, 'api_action', 'admin', 'alpha', 'contact', { phone, name: 'Alex', email: 'old@example.com' });
    await call(db, 'api_action', 'admin', 'alpha', 'consent', { phone, consent: true, evidence: 'Earlier opt-in' });
    const noConsent = (await db.query(`insert into public.sms_web_form_contact_submissions
      (tenant_id,name,phone,email,details) values('alpha','Alex',$1,'new@example.com','{"field":"original"}') returning *`, [phone])).rows[0];
    const firstIntake = (await db.query('select * from public.sms_automation_contacts where id=$1', [noConsent.automation_intake_id])).rows[0];
    assert.equal(firstIntake.skip_reason, 'CONSENT_REQUIRED');
    assert.equal(firstIntake.enrollment_id, null);
    assert.equal((await db.query('select email,marketing_consent from public.sms_contacts where tenant_id=$1 and phone=$2', ['alpha', phone])).rows[0].email, 'new@example.com');

    const optedIn = (await db.query(`insert into public.sms_web_form_quote_request_submissions
      (tenant_id,name,phone,email,details,sms_opt_in,consent_evidence)
      values('alpha','Alex',$1,'quote@example.com','{"service":"painting"}',true,'Quote form SMS checkbox') returning *`, [phone])).rows[0];
    const quoteIntake = (await db.query('select * from public.sms_automation_quote_requests where id=$1', [optedIn.automation_intake_id])).rows[0];
    assert.equal(quoteIntake.intake_state, 'enrolled');
    const enrollmentCount = (await db.query('select count(*) from public.sms_automation_enrollments where tenant_id=$1', ['alpha'])).rows[0].count;
    await db.query(`update public.sms_web_form_quote_request_submissions set details='{"service":"painting","extra":"yes"}'
      where tenant_id='alpha' and id=$1`, [optedIn.id]);
    assert.equal((await db.query('select count(*) from public.sms_automation_enrollments where tenant_id=$1', ['alpha'])).rows[0].count, enrollmentCount);
    assert.deepEqual((await db.query('select details from public.sms_automation_quote_requests where id=$1', [optedIn.automation_intake_id])).rows[0].details, { service: 'painting' });
    await assert.rejects(() => db.query(`update public.sms_web_form_quote_request_submissions set email='changed@example.com'
      where tenant_id='alpha' and id=$1`, [optedIn.id]), /fields other than details cannot change/);

    await call(db, 'api_action', 'admin', 'alpha', 'consent', { phone, consent: false, evidence: 'STOP' });
    const suppressed = (await db.query(`insert into public.sms_web_form_quote_request_submissions
      (tenant_id,name,phone,email,sms_opt_in,consent_evidence)
      values('alpha','Alex',$1,'after-stop@example.com',true,'Fresh checkbox') returning *`, [phone])).rows[0];
    assert.equal((await db.query('select skip_reason from public.sms_automation_quote_requests where id=$1', [suppressed.automation_intake_id])).rows[0].skip_reason, 'OPTED_OUT');
    assert.equal((await db.query('select opted_out from public.sms_contacts where tenant_id=$1 and phone=$2', ['alpha', phone])).rows[0].opted_out, true);

    const booking = (await db.query(`insert into public.sms_web_form_booking_submissions
      (tenant_id,name,phone,email,appointment_at) values('alpha','Blair','+13035550156','blair@example.com',now()+interval '2 days') returning *`)).rows[0];
    assert.equal(booking.sms_opt_in, false);
    assert.equal((await db.query('select intake_state from public.sms_automation_bookings where id=$1', [booking.automation_intake_id])).rows[0].intake_state, 'enrolled');
  } finally { await db.close(); }
});
