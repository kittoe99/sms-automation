import test from 'node:test';
import assert from 'node:assert/strict';
import { testDatabase, call } from './helpers/database.js';
import { createCrmHandler } from '../supabase/functions/crm-api/handler.js';
import { createWebFormHandler } from '../supabase/functions/web-form/handler.js';
import { embedSnippet } from '../public/formBuilder.js';

async function addBusiness(db, id) {
  await call(db, 'api_action', 'admin', null, 'create_business', { id, name: id, timeZone: 'America/Denver' });
}

test('Web Form presets seed for every business and editor permissions stay tenant scoped', async () => {
  const db = await testDatabase();
  try {
    await addBusiness(db, 'alpha'); await addBusiness(db, 'beta');
    const alpha = await call(db, 'list_web_forms', 'admin', 'alpha');
    const beta = await call(db, 'list_web_forms', 'admin', 'beta');
    assert.deepEqual(alpha.forms.map(f => f.preset), ['bookings', 'contacts', 'quote_requests']);
    assert.equal(new Set([...alpha.forms, ...beta.forms].map(f => f.public_id)).size, 6);
    await db.exec("insert into public.sms_business_memberships(tenant_id,clerk_user_id,role) values('alpha','alpha-admin','admin'),('alpha','alpha-viewer','viewer')");
    assert.equal((await call(db, 'list_web_forms', 'alpha-admin', 'alpha')).canEdit, true);
    assert.equal((await call(db, 'list_web_forms', 'alpha-viewer', 'alpha')).canEdit, false);
    await assert.rejects(() => call(db, 'list_web_forms', 'alpha-viewer', 'beta'), /Business access required/);
    const fields = [
      { key: 'project_type', label: 'Project type', type: 'select', required: true, options: ['Moving', 'Painting'] },
      { key: 'notes', label: 'Details', type: 'textarea', required: false },
      { key: 'urgent', label: 'Urgent', type: 'checkbox', required: false },
      { key: 'preferred_day', label: 'Preferred day', type: 'date', required: false },
    ];
    const payload = { title: 'Get a quote', description: 'Tell us about the project.', buttonLabel: 'Send request', enabled: true, fields };
    await assert.rejects(() => call(db, 'save_web_form', 'alpha-viewer', 'alpha', 'quote_requests', payload), /Business admin access required/);
    const saved = await call(db, 'save_web_form', 'alpha-admin', 'alpha', 'quote_requests', payload);
    assert.equal(saved.version, 2);
    assert.equal(saved.public_id, alpha.forms.find(f => f.preset === 'quote_requests').public_id);
    assert.deepEqual(saved.fields, fields);
    assert.equal((await call(db, 'public_web_form', saved.public_id)).title, 'Get a quote');
    assert.equal((await call(db, 'list_web_forms', 'admin', 'beta')).forms.find(f => f.preset === 'quote_requests').version, 1);
    await assert.rejects(() => call(db, 'save_web_form', 'alpha-admin', 'beta', 'contacts', payload), /Business admin access required/);
    await assert.rejects(() => call(db, 'save_web_form', 'alpha-admin', 'alpha', 'contacts', { ...payload, fields: [{ ...fields[0], key: 'name' }] }), /unique and safe/);
    const disabled = await call(db, 'save_web_form', 'admin', 'alpha', 'quote_requests', { ...payload, enabled: false });
    assert.equal(await call(db, 'public_web_form', disabled.public_id), null);
    assert.match(embedSnippet(saved, { embedBaseUrl: 'https://forms.example.com' }), /https:\/\/forms\.example\.com\/embed\.html\?form=/);
  } finally { await db.close(); }
});

test('public submissions validate custom answers and preserve their schema snapshot', async () => {
  const db = await testDatabase();
  try {
    await addBusiness(db, 'alpha');
    const original = (await call(db, 'list_web_forms', 'admin', 'alpha')).forms.find(f => f.preset === 'contacts');
    const fields = [{ key: 'service', label: 'Service wanted', type: 'select', required: true, options: ['Moving', 'Packing'] }];
    await call(db, 'save_web_form', 'admin', 'alpha', 'contacts', {
      title: 'Contact', description: '', buttonLabel: 'Send', enabled: true, fields,
    });
    const base = { submissionId: '3e516548-7779-46a6-849b-7b0ac44538a8', name: 'Alex', phone: '+13035550160',
      email: 'alex@example.com', smsOptIn: true, details: { service: 'Moving' } };
    await assert.rejects(() => call(db, 'submit_web_form', original.public_id, { ...base, details: {} }), /Required custom field missing/);
    await assert.rejects(() => call(db, 'submit_web_form', original.public_id, { ...base, details: { service: 'Other' } }), /Invalid select answer/);
    await assert.rejects(() => call(db, 'submit_web_form', original.public_id, { ...base, details: { other: 'value' } }), /Unknown custom field/);
    const first = await call(db, 'submit_web_form', original.public_id, base);
    assert.equal(first.duplicate, false);
    assert.equal((await call(db, 'submit_web_form', original.public_id, base)).duplicate, true);
    await assert.rejects(() => call(db, 'submit_web_form', original.public_id, { ...base, name: 'Different' }), /Submission ID already used/);
    const record = (await call(db, 'list_web_form_submissions', 'admin', 'alpha', 'contacts', 1, 50)).rows[0];
    assert.equal(record.form_version, 2);
    assert.deepEqual(record.field_snapshot, fields);
    assert.equal(record.intake_state, 'enrolled');
    assert.match(record.consent_evidence, /I agree to receive SMS updates/);
    assert.equal((await db.query("select email from public.sms_contacts where tenant_id='alpha' and phone='+13035550160'")).rows[0].email, 'alex@example.com');
    await call(db, 'save_web_form', 'admin', 'alpha', 'contacts', {
      title: 'Contact', description: '', buttonLabel: 'Send', enabled: true,
      fields: [{ ...fields[0], label: 'New label' }],
    });
    assert.equal((await call(db, 'list_web_form_submissions', 'admin', 'alpha', 'contacts', 1, 50)).rows[0].field_snapshot[0].label, 'Service wanted');
    await assert.rejects(() => call(db, 'list_web_form_submissions', 'unknown', 'alpha', 'contacts', 1, 50), /Business access required/);
  } finally { await db.close(); }
});

test('public endpoint allows arbitrary origins, handles honeypots, and converts booking local time', async () => {
  const calls = [];
  const db = { call: async (name, ...args) => {
    calls.push({ name, args });
    if (name === 'public_web_form') return { preset: 'bookings', timeZone: 'America/Denver' };
    if (name === 'claim_web_form_rate') return true;
    if (name === 'submit_web_form') return { ok: true, submissionId: args[1].submissionId, duplicate: false };
  } };
  const handler = createWebFormHandler(db, { ipHashKey: 'x'.repeat(32) });
  const id = 'c9ed9f9f-9aa7-4467-82f5-46808a2af8f7';
  const url = `https://example.supabase.co/functions/v1/web-form/${id}`;
  const preflight = await handler(new Request(url, { method: 'OPTIONS', headers: { Origin: 'https://unrelated.example.org' } }));
  assert.equal(preflight.headers.get('Access-Control-Allow-Origin'), '*');
  const body = { submissionId: crypto.randomUUID(), name: 'Alex', phone: '+13035550161', email: 'alex@example.com',
    appointmentAt: '2027-01-15T10:30', details: {}, smsOptIn: false };
  const submitted = await handler(new Request(url, { method: 'POST', headers: { Origin: 'https://anywhere.example',
    'Content-Type': 'application/json', 'x-forwarded-for': '203.0.113.10' }, body: JSON.stringify(body) }));
  assert.equal(submitted.status, 201);
  assert.equal(submitted.headers.get('Access-Control-Allow-Origin'), '*');
  assert.equal(calls.find(x => x.name === 'submit_web_form').args[1].appointmentAt, '2027-01-15T17:30:00.000Z');
  const count = calls.length;
  const trapped = await handler(new Request(url, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...body, website: 'spam.example' }) }));
  assert.equal(trapped.status, 201);
  assert.equal(calls.length, count);
  const oversized = await handler(new Request(url, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...body, details: { message: '🟩'.repeat(5000) } }) }));
  assert.equal(oversized.status, 413);
  assert.equal(calls.length, count);
});

test('rate buckets count failed attempts but allow a saved submission to retry', async () => {
  const db = await testDatabase();
  try {
    await addBusiness(db, 'alpha');
    const form = (await call(db, 'list_web_forms', 'admin', 'alpha')).forms.find(f => f.preset === 'contacts');
    const hash = 'b'.repeat(64);
    const submissionId = crypto.randomUUID();
    assert.equal(await call(db, 'claim_web_form_rate', form.public_id, submissionId, hash), true);
    await call(db, 'submit_web_form', form.public_id, { submissionId, name: 'Alex', phone: '+13035550162',
      email: 'alex@example.com', details: {}, smsOptIn: false });
    assert.equal(await call(db, 'claim_web_form_rate', form.public_id, submissionId, hash), true);
    for (let i = 0; i < 9; i++) {
      assert.equal(await call(db, 'claim_web_form_rate', form.public_id, crypto.randomUUID(), hash), true);
    }
    assert.equal(await call(db, 'claim_web_form_rate', form.public_id, crypto.randomUUID(), hash), false);
    const counts = (await db.query("select attempts from sms_private.web_form_rate_buckets where form_public_id=$1 and bucket=$2", [form.public_id, `ip:${hash}`])).rows;
    assert.equal(counts[0].attempts, 11);
    await db.query("update sms_private.web_form_rate_buckets set attempts=100 where form_public_id=$1 and bucket='form'", [form.public_id]);
    assert.equal(await call(db, 'claim_web_form_rate', form.public_id, crypto.randomUUID(), 'c'.repeat(64)), false);
  } finally { await db.close(); }
});

test('CRM Web Forms routes allow business admins to edit and viewers to list submissions', async () => {
  const db = await testDatabase();
  const previousOrigins = process.env.CRM_ALLOWED_ORIGINS;
  process.env.CRM_ALLOWED_ORIGINS = 'https://crm.example.com';
  try {
    await addBusiness(db, 'alpha');
    await db.exec("insert into public.sms_business_memberships(tenant_id,clerk_user_id,role) values('alpha','viewer','viewer'),('alpha','manager','admin')");
    const handler = createCrmHandler({ call: (name, ...args) => call(db, name, ...args) }, async request => request.headers.get('X-Test-User'));
    const base = 'https://crm.example.com/functions/v1/crm-api/web-forms';
    const headers = { Origin: 'https://crm.example.com', 'X-Tenant-ID': 'alpha', 'X-Test-User': 'viewer' };
    const listed = await handler(new Request(base, { headers }));
    assert.equal(listed.status, 200);
    assert.equal((await listed.json()).canEdit, false);
    const submissions = await handler(new Request(`${base}/contacts/submissions`, { headers }));
    assert.equal(submissions.status, 200);
    const payload = { title: 'New contact title', description: '', buttonLabel: 'Send', enabled: true, fields: [] };
    const denied = await handler(new Request(`${base}/contacts`, { method: 'PUT',
      headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }));
    assert.equal(denied.status, 403);
    const saved = await handler(new Request(`${base}/contacts`, { method: 'PUT',
      headers: { ...headers, 'X-Test-User': 'manager', 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }));
    assert.equal(saved.status, 200);
    assert.equal((await saved.json()).form.title, 'New contact title');
  } finally {
    if (previousOrigins === undefined) delete process.env.CRM_ALLOWED_ORIGINS;
    else process.env.CRM_ALLOWED_ORIGINS = previousOrigins;
    await db.close();
  }
});

test('public role can use only the public form RPCs and booking submits without SMS opt-in', async () => {
  const db = await testDatabase();
  try {
    await addBusiness(db, 'alpha');
    const booking = (await call(db, 'list_web_forms', 'admin', 'alpha')).forms.find(f => f.preset === 'bookings');
    const contact = (await call(db, 'list_web_forms', 'admin', 'alpha')).forms.find(f => f.preset === 'contacts');
    const appointmentAt = new Date(Date.now() + 3 * 86400000).toISOString();
    await db.exec('set role sms_form_public');
    assert.equal((await call(db, 'public_web_form', booking.public_id)).preset, 'bookings');
    assert.equal((await db.query("select has_function_privilege(current_user,'sms_private.save_web_form(text,text,text,jsonb)','execute') allowed")).rows[0].allowed, false);
    await assert.rejects(() => db.query('select * from public.sms_web_form_definitions'), /permission denied/);
    await assert.rejects(() => db.query('select * from public.sms_web_form_booking_submissions'), /permission denied/);
    const submitted = await call(db, 'submit_web_form', booking.public_id, {
      submissionId: crypto.randomUUID(), name: 'Blair', phone: '+13035550182',
      email: 'blair@example.com', appointmentAt, details: {}, smsOptIn: false,
    });
    await db.exec('reset role');
    const row = (await call(db, 'list_web_form_submissions', 'admin', 'alpha', 'bookings', 1, 50)).rows[0];
    assert.equal(row.id, submitted.submissionId);
    assert.equal(row.intake_state, 'enrolled');
    assert.equal(row.sms_opt_in, false);
    assert.equal(new Date(row.appointment_at).toISOString(), appointmentAt);
    const noConsent = await call(db, 'submit_web_form', contact.public_id, {
      submissionId: crypto.randomUUID(), name: 'Casey', phone: '+13035550183',
      email: 'casey@example.com', details: {}, smsOptIn: false,
    });
    const savedContact = (await call(db, 'list_web_form_submissions', 'admin', 'alpha', 'contacts', 1, 50)).rows[0];
    assert.equal(savedContact.id, noConsent.submissionId);
    assert.equal(savedContact.skip_reason, 'CONSENT_REQUIRED');
    await call(db, 'api_action', 'admin', 'alpha', 'consent', {
      phone: '+13035550183', consent: false, evidence: 'STOP',
    });
    await call(db, 'submit_web_form', contact.public_id, {
      submissionId: crypto.randomUUID(), name: 'Casey', phone: '+13035550183',
      email: 'casey@example.com', details: {}, smsOptIn: true,
    });
    assert.equal((await call(db, 'list_web_form_submissions', 'admin', 'alpha', 'contacts', 1, 50)).rows[0].skip_reason, 'OPTED_OUT');
  } finally { await db.close(); }
});
