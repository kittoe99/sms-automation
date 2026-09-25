import test from 'node:test';
import assert from 'node:assert/strict';
import { testDatabase, call } from './helpers/database.js';

test('existing businesses receive separate disabled email groups and shared provider bounces suppress both', async () => {
  const db = await testDatabase();
  try {
    for (const [id, name] of [['opek', 'Opek'], ['bello-moving', 'Bello Moving']]) {
      await call(db, 'api_action', 'admin', null, 'create_business',
        { id, name, timeZone: 'America/Denver' });
      const overview = await call(db, 'email_overview', 'admin', id);
      assert.equal(overview.configured, true);
      assert.equal(overview.groups.length, 4);
      assert.equal(overview.groups.every(group => !group.enabled), true);
    }
    const secret = (await db.query("select vault.create_secret(repeat('a',32)) as id")).rows[0].id;
    await db.query('insert into vault.secrets(id) values($1)', [secret]);
    await db.query("update sms_private.edge_config set enabled=true,secret_id=$1 where queue='automation_jobs'", [secret]);
    const group = (await call(db, 'email_overview', 'admin', 'opek')).groups.find(g => g.fixedType === 'contacts');
    await call(db, 'email_save_group', 'admin', 'opek', group.group_id, {
      enabled: true,
      rule: { ...group.rule, anchor: 'enrollment', firstDelayCount: 0, firstDelayUnit: 'hour' },
      intent: 'Follow up on service requests', systemPrompt: 'Write a short helpful email',
      businessContext: 'Opek provides junk removal', mailingAddress: '123 Main St, Denver, CO 80201',
    });
    await call(db, 'create_intake', 'admin', 'opek', 'contacts', {
      name: 'Alex', phone: '+13035550176', email: 'alex@example.com', emailOptIn: true,
      emailConsentEvidence: 'Alex opted in on a signed intake card', details: {},
    });
    assert.equal((await call(db, 'email_overview', 'admin', 'opek')).enrollments.length, 1);
    assert.equal((await call(db, 'email_overview', 'admin', 'bello-moving')).enrollments.length, 0);
    await call(db, 'email_record_provider_event', 'bounce-1', 'provider-1', 'email.bounced', 'alex@example.com');
    const suppressions = (await db.query(
      "select tenant_id from sms_private.email_suppressions where email='alex@example.com' order by tenant_id",
    )).rows.map(row => row.tenant_id);
    assert.deepEqual(suppressions, ['bello-moving', 'opek']);
    assert.equal((await call(db, 'email_overview', 'admin', 'opek')).enrollments[0].status, 'cancelled');
  } finally { await db.close(); }
});

async function setup(db) {
  await call(db, 'api_action', 'admin', null, 'create_business',
    { id: 'e2-local', name: 'E2 Local', timeZone: 'America/Denver' });
  const secret = (await db.query("select vault.create_secret(repeat('a',32)) as id")).rows[0].id;
  await db.query('insert into vault.secrets(id) values($1)', [secret]);
  await db.query("update sms_private.edge_config set enabled=true,secret_id=$1 where queue='automation_jobs'", [secret]);
  const overview = await call(db, 'email_overview', 'admin', 'e2-local');
  assert.equal(overview.groups.length, 4);
  const settings = overview.groups.find(group => group.fixedType === 'contacts');
  await call(db, 'email_save_group', 'admin', 'e2-local', settings.group_id, {
    enabled: true, rule: { ...settings.rule, anchor: 'enrollment', firstDelayCount: 0, firstDelayUnit: 'hour' },
    intent: 'Help the customer choose a next step', systemPrompt: 'Write a helpful email',
    businessContext: 'E2 Local offers local services', mailingAddress: '123 Main St, Denver, CO 80201',
  });
  return settings;
}

test('email group activation is separate from SMS and requires recorded staff consent', async () => {
  const db = await testDatabase();
  try {
    const settings = await setup(db);
    const original = (await db.query('select rule from public.sms_automation_groups where tenant_id=$1 and id=$2',
      ['e2-local',settings.group_id])).rows[0].rule;
    assert.notDeepEqual((await call(db, 'email_overview', 'admin', 'e2-local')).groups.find(g => g.group_id === settings.group_id).rule, original);
    await call(db, 'create_intake', 'admin', 'e2-local', 'contacts', {
      name: 'No consent', phone: '+13035550161', email: 'no@example.com', emailOptIn: false, details: {},
    });
    assert.equal((await call(db, 'email_overview', 'admin', 'e2-local')).enrollments.length, 0);
    const intake = await call(db, 'create_intake', 'admin', 'e2-local', 'contacts', {
      name: 'Alex', phone: '+13035550162', email: 'Alex@example.com', emailOptIn: true,
      emailConsentEvidence: 'Alex opted in on a signed intake card today', details: { service: 'moving' },
    });
    const overview = await call(db, 'email_overview', 'admin', 'e2-local');
    assert.equal(overview.enrollments.length, 1);
    assert.equal(overview.enrollments[0].email, 'alex@example.com');
    assert.equal(overview.enrollments[0].source_type, 'contacts');
    const token = (await db.query('select unsubscribe_token from sms_private.email_enrollments where source_id=$1', [intake.id])).rows[0].unsubscribe_token;
    await call(db, 'email_unsubscribe', token);
    assert.equal((await call(db, 'email_overview', 'admin', 'e2-local')).enrollments[0].status, 'unsubscribed');
    assert.equal((await db.query("select count(*)::integer as n from sms_private.email_suppressions where email='alex@example.com'")).rows[0].n, 1);
  } finally { await db.close(); }
});

test('public form requires its own switch and separate unchecked email consent', async () => {
  const db = await testDatabase();
  try {
    await setup(db);
    const form = (await call(db, 'list_web_forms', 'admin', 'e2-local')).forms.find(f => f.preset === 'contacts');
    const base = { title: 'Contact', description: '', buttonLabel: 'Send', enabled: true, fields: [] };
    const saved = await call(db, 'save_web_form', 'admin', 'e2-local', 'contacts', { ...base, emailEnabled: true });
    assert.equal(saved.email_enabled, true);
    assert.equal((await call(db, 'public_web_form', form.public_id)).emailEnabled, true);
    const payload = { submissionId: crypto.randomUUID(), name: 'Sam', phone: '+13035550163',
      email: 'sam@example.com', smsOptIn: false, emailOptIn: false, details: {} };
    await call(db, 'submit_web_form', form.public_id, payload);
    assert.equal((await call(db, 'email_overview', 'admin', 'e2-local')).enrollments.length, 0);
    await call(db, 'submit_web_form', form.public_id, { ...payload, submissionId: crypto.randomUUID(),
      phone: '+13035550164', email: 'other@example.com', emailOptIn: true });
    assert.equal((await call(db, 'email_overview', 'admin', 'e2-local')).enrollments.length, 1);
    await call(db, 'save_web_form', 'admin', 'e2-local', 'contacts', { ...base, emailEnabled: false });
    assert.equal((await call(db, 'email_overview', 'admin', 'e2-local')).enrollments[0].status, 'cancelled');
  } finally { await db.close(); }
});

test('unsubscribe after drafting cancels the job at the final database guard', async () => {
  const db = await testDatabase();
  try {
    await setup(db);
    const intake = await call(db, 'create_intake', 'admin', 'e2-local', 'contacts', {
      name: 'Dana', phone: '+13035550165', email: 'dana@example.com', emailOptIn: true,
      emailConsentEvidence: 'Dana checked the email consent box at the desk', details: {},
    });
    const enrollment = (await db.query('select * from sms_private.email_enrollments where source_id=$1', [intake.id])).rows[0];
    await db.query("update sms_private.email_enrollments set next_run_at=now()-interval '1 minute' where id=$1", [enrollment.id]);
    assert.equal(await call(db, 'dispatch_email_edge'), 1);
    const job = await call(db, 'email_claim');
    assert.ok(job.id);
    await call(db, 'email_save_draft', job.id, job.lease_token, 'Your next step', 'Hello Dana, we can help with your request.');
    await call(db, 'email_save_payload', job.id, job.lease_token, {
      from: 'E2 Local <hello@e2local.com>', to: 'dana@example.com',
      reply_to: 'hello@e2local.com', subject: 'Your next step',
      text: 'Hello Dana. E2 Local 123 Main St, Denver, CO 80201',
      html: '<p>Hello Dana, we can help with your request. E2 Local 123 Main St, Denver, CO 80201. Unsubscribe here.</p>',
    });
    await call(db, 'email_unsubscribe', enrollment.unsubscribe_token);
    assert.equal(await call(db, 'email_before_send', job.id, job.lease_token), null);
    assert.equal((await db.query('select status from sms_private.email_jobs where id=$1', [job.id])).rows[0].status, 'cancelled');
  } finally { await db.close(); }
});

test('confirmed bookings enroll and cancellation stops their email sequence', async () => {
  const db = await testDatabase();
  try {
    await setup(db);
    const bookingGroup = (await call(db, 'email_overview', 'admin', 'e2-local')).groups.find(g => g.fixedType === 'bookings');
    await call(db, 'email_save_group', 'admin', 'e2-local', bookingGroup.group_id, {
      enabled: true, rule: { ...bookingGroup.rule, anchor: 'appointment', leadHours: 24 },
      intent: 'Remind the customer about the appointment', systemPrompt: 'Write a concise reminder',
      businessContext: 'E2 Local offers local services', mailingAddress: '123 Main St, Denver, CO 80201',
    });
    const booking = await call(db, 'create_intake', 'admin', 'e2-local', 'bookings', {
      name: 'Pat', phone: '+13035550166', email: 'pat@example.com', emailOptIn: true,
      emailConsentEvidence: 'Pat agreed to marketing email at booking', status: 'requested', details: {},
    });
    assert.equal((await call(db, 'email_overview', 'admin', 'e2-local')).enrollments.length, 0);
    const appointmentAt = new Date(Date.now() + 72 * 3600000).toISOString();
    await call(db, 'update_intake_booking', 'admin', 'e2-local', booking.id,
      { status: 'confirmed', appointmentAt });
    const enrollment = (await call(db, 'email_overview', 'admin', 'e2-local')).enrollments[0];
    assert.equal(enrollment.source_type, 'bookings');
    assert.equal(enrollment.status, 'active');
    await call(db, 'update_intake_booking', 'admin', 'e2-local', booking.id, { status: 'cancelled' });
    assert.equal((await call(db, 'email_overview', 'admin', 'e2-local')).enrollments[0].status, 'cancelled');
  } finally { await db.close(); }
});

test('booking form consent remains tied to its form switch after an appointment change', async () => {
  const db = await testDatabase();
  try {
    await setup(db);
    const group = (await call(db, 'email_overview', 'admin', 'e2-local')).groups.find(g => g.fixedType === 'bookings');
    await call(db, 'email_save_group', 'admin', 'e2-local', group.group_id, {
      enabled: true, rule: { ...group.rule, anchor: 'appointment', leadHours: 24 },
      intent: 'Remind the customer about the appointment', systemPrompt: 'Write a concise reminder',
      businessContext: 'E2 Local offers local services', mailingAddress: '123 Main St, Denver, CO 80201',
    });
    const form = (await call(db, 'list_web_forms', 'admin', 'e2-local')).forms.find(f => f.preset === 'bookings');
    const formSettings = { title: 'Book', description: '', buttonLabel: 'Send', enabled: true, emailEnabled: true, fields: [] };
    await call(db, 'save_web_form', 'admin', 'e2-local', 'bookings', formSettings);
    const appointmentAt = new Date(Date.now() + 72 * 3600000).toISOString();
    await call(db, 'submit_web_form', form.public_id, { submissionId: crypto.randomUUID(),
      name: 'Lee', phone: '+13035550167', email: 'lee@example.com',
      smsOptIn: false, emailOptIn: true, appointmentAt, details: {} });
    const intake = (await db.query("select id,status from public.sms_automation_bookings where email='lee@example.com'")).rows[0];
    assert.equal(intake.status, 'confirmed');
    await call(db, 'update_intake_booking', 'admin', 'e2-local', intake.id,
      { appointmentAt: new Date(Date.now() + 96 * 3600000).toISOString() });
    const enrollment = (await db.query('select status,form_public_id from sms_private.email_enrollments where source_id=$1', [intake.id])).rows[0];
    assert.equal(enrollment.form_public_id, form.public_id);
    await call(db, 'save_web_form', 'admin', 'e2-local', 'bookings', { ...formSettings, emailEnabled: false });
    assert.equal((await db.query('select status from sms_private.email_enrollments where source_id=$1', [intake.id])).rows[0].status, 'cancelled');
  } finally { await db.close(); }
});
