import test from 'node:test';
import assert from 'node:assert/strict';
import { testDatabase, call } from './helpers/database.js';
import { setupCoordination, addRun, tenant, phone } from './helpers/coordination.js';
import { createEmailWorkerHandler } from '../supabase/functions/email-worker/handler.js';

async function emailFixture(db, count = 1) {
  await call(db, 'api_action', 'admin', null, 'create_business', { id: 'email-review', name: 'Email', timeZone: 'UTC' });
  await db.exec(`update sms_private.runtime set edge_enabled=true;
    insert into vault.secrets(id) values('00000000-0000-0000-0000-000000000077');
    insert into vault.decrypted_secrets values('00000000-0000-0000-0000-000000000077','synthetic-secret');
    update sms_private.edge_config set enabled=true,secret_id='00000000-0000-0000-0000-000000000077' where queue='automation_jobs';
    update sms_private.email_group_settings set enabled=true where tenant_id='email-review';`);
  await db.query(`insert into sms_private.email_enrollments(tenant_id,group_id,source_type,source_id,email,name,rule_snapshot,next_run_at)
    select 'email-review',g.group_id,'contacts',gen_random_uuid(),'person-'||n||'@example.com','Test',
      g.rule||' {"startHour":0,"endHour":24}'::jsonb,now()-interval '2 hours'+make_interval(secs=>n)
    from generate_series(1,$1::integer)n cross join (select group_id,rule from sms_private.email_group_settings where tenant_id='email-review' order by group_id limit 1)g`, [count]);
}

test('email cron recovers a lone expired lease without replaying an old provider submission', async () => {
  const db = await testDatabase();
  try {
    await emailFixture(db);
    assert.equal(await call(db, 'dispatch_email_edge'), 1);
    const job = await call(db, 'email_claim');
    await db.query("update sms_private.email_jobs set lease_until=now()-interval '1 minute' where id=$1", [job.id]);
    assert.equal(await call(db, 'dispatch_email_edge'), 1);
    const next = await call(db, 'email_claim');
    assert.equal(next.id, job.id);
    assert.notEqual(next.lease_token, job.lease_token);
    await db.query("update sms_private.email_jobs set lease_until=now()-interval '1 minute',send_started_at=now()-interval '24 hours' where id=$1", [job.id]);
    assert.equal(await call(db, 'dispatch_email_edge'), 0);
    assert.equal((await db.query('select status from sms_private.email_jobs where id=$1', [job.id])).rows[0].status, 'uncertain');
    assert.equal((await db.query('select status from sms_private.email_enrollments where id=$1', [job.enrollment_id])).rows[0].status, 'paused');
    assert.equal(await call(db, 'email_claim'), null);
  } finally { await db.close(); }
});

test('100 failed email jobs do not starve later enrollments and admission respects the shared cap', async () => {
  const db = await testDatabase();
  try {
    await emailFixture(db, 101);
    await db.exec(`insert into sms_private.email_jobs(enrollment_id,step_index,generation,due_at,status)
      select id,step_index,generation,next_run_at,'failed' from sms_private.email_enrollments order by next_run_at limit 100`);
    assert.equal(await call(db, 'dispatch_email_edge'), 1);
    assert.equal((await db.query("select count(*)::integer n from sms_private.email_jobs where status='pending'")).rows[0].n, 1);
    assert.equal((await db.query("select count(*)::integer n from sms_private.email_enrollments where status='paused'")).rows[0].n, 100);
    await call(db, 'dispatch_email_edge');
    assert.equal((await db.query('select count(*)::integer n from sms_private.email_jobs')).rows[0].n, 101);
    await db.exec("update sms_private.edge_config set max_concurrency=1 where queue='automation_jobs'");
    const slot = await call(db, 'edge_enter', 'automation_jobs', 'other-work');
    assert.ok(slot);
    assert.equal(await call(db, 'dispatch_email_edge'), 0);
    await call(db, 'edge_exit', 'automation_jobs', slot);
    await db.exec('update sms_private.runtime set edge_enabled=false');
    assert.equal(await call(db, 'dispatch_email_edge'), 0);
  } finally { await db.close(); }
});

test('email guards defer closed-window sends without consuming attempts and recheck idempotency age', async () => {
  const db = await testDatabase();
  try {
    await emailFixture(db);
    await call(db, 'dispatch_email_edge');
    let job = await call(db, 'email_claim');
    const hour = (await db.query("select extract(hour from now() at time zone 'UTC')::integer h")).rows[0].h;
    const start = (hour + 1) % 24;
    await db.query("update sms_private.email_enrollments set rule_snapshot=rule_snapshot||jsonb_build_object('startHour',$1::integer,'endHour',$2::integer)", [start, start + 1]);
    await db.query("update sms_private.email_jobs set subject='Hello',body='Test email',provider_payload='{}' where id=$1", [job.id]);
    assert.equal(await call(db, 'email_before_send', job.id, job.lease_token), null);
    let state = (await db.query("select *,extract(hour from due_at at time zone 'UTC')::integer h from sms_private.email_jobs where id=$1", [job.id])).rows[0];
    assert.equal(state.status, 'pending');
    assert.equal(state.attempts, 0);
    assert.equal(state.h, start);
    assert.equal(state.send_started_at, null);
    await db.query('update sms_private.email_jobs set due_at=now() where id=$1', [job.id]);
    job = await call(db, 'email_claim');
    await call(db, 'email_finish', job.id, job.lease_token, 'retry', null, 'TEST_RETRY');
    state = (await db.query("select extract(hour from due_at at time zone 'UTC')::integer h from sms_private.email_jobs where id=$1", [job.id])).rows[0];
    assert.equal(state.h, start);
    await db.query("update sms_private.email_jobs set due_at=now(),send_started_at=now()-interval '24 hours' where id=$1", [job.id]);
    assert.equal(await call(db, 'email_claim'), null);
  } finally { await db.close(); }
});

test('worker heartbeats and operational responses are bounded by queue rather than invocation count', async () => {
  const db = await testDatabase();
  try {
    await call(db, 'api_action', 'admin', null, 'create_business', { id: 'health-review', name: 'Health', timeZone: 'UTC' });
    for (let i = 0; i < 50; i++) await call(db, 'claim', 'sms_send_jobs', `invocation-${i}`);
    assert.equal((await db.query('select count(*)::integer n from sms_private.heartbeats')).rows[0].n, 1);
    let ops = await call(db, 'api_read', 'admin', 'health-review', 'operations', {});
    assert.equal(ops.workers.length, 1);
    await db.exec("update sms_private.heartbeats set seen_at=now()-interval '2 days'");
    ops = await call(db, 'api_read', 'admin', 'health-review', 'operations', {});
    assert.equal(ops.workers.length, 0);
    await call(db, 'tick');
    assert.equal((await db.query('select count(*)::integer n from sms_private.heartbeats')).rows[0].n, 0);
  } finally { await db.close(); }
});

test('email failures pause only their matching generation and safe retries restore that enrollment', async () => {
  const db = await testDatabase();
  try {
    await emailFixture(db);
    await call(db, 'dispatch_email_edge');
    let job = await call(db, 'email_claim');
    await call(db, 'email_finish', job.id, job.lease_token, 'failed', null, 'RECIPIENT_REJECTED');
    let state = (await db.query('select * from sms_private.email_enrollments where id=$1', [job.enrollment_id])).rows[0];
    assert.equal(state.status, 'paused');
    assert.equal(state.pause_reason, 'RECIPIENT_REJECTED');
    await call(db, 'email_retry', 'admin', 'email-review', job.id);
    assert.equal((await db.query('select status from sms_private.email_enrollments where id=$1', [job.enrollment_id])).rows[0].status, 'active');
    job = await call(db, 'email_claim');
    await db.query('update sms_private.email_enrollments set generation=generation+1 where id=$1', [job.enrollment_id]);
    await call(db, 'email_finish', job.id, job.lease_token, 'failed', null, 'OLD_RUN_FAILED');
    await call(db, 'recover_email_jobs');
    state = (await db.query('select * from sms_private.email_enrollments where id=$1', [job.enrollment_id])).rows[0];
    assert.equal(state.status, 'active');
    await assert.rejects(call(db, 'email_retry', 'admin', 'email-review', job.id), /cannot be retried safely/);
  } finally { await db.close(); }
});

test('email claims rotate tenants despite one older backlog', async () => {
  const db = await testDatabase();
  try {
    await emailFixture(db, 3);
    await call(db, 'api_action', 'admin', null, 'create_business', { id: 'z-second', name: 'Second', timeZone: 'UTC' });
    await db.exec(`update sms_private.email_group_settings set enabled=true where tenant_id='z-second';
      insert into sms_private.email_enrollments(tenant_id,group_id,source_type,source_id,email,name,rule_snapshot,next_run_at)
      select tenant_id,group_id,'contacts',gen_random_uuid(),'second@example.com','Second',rule,now()-interval '1 minute'
      from sms_private.email_group_settings where tenant_id='z-second' order by group_id limit 1;`);
    await call(db, 'dispatch_email_edge');
    const first = await call(db, 'email_claim');
    const second = await call(db, 'email_claim');
    const owner = async job => (await db.query('select tenant_id from sms_private.email_enrollments where id=$1', [job.enrollment_id])).rows[0].tenant_id;
    assert.equal(await owner(first), 'email-review');
    assert.equal(await owner(second), 'z-second');
  } finally { await db.close(); }
});

test('scheduler rotates past quiet candidates and shares its bounded work across tenants', async () => {
  const db = await setupCoordination();
  try {
    const quiet = await addRun(db);
    await db.query(`insert into sms_private.form_runs(tenant_id,form_id,version,submission_id,phone,context,next_run_at)
      select r.tenant_id,r.form_id,r.version,gen_random_uuid(),r.phone,r.context,now()-interval '1 hour'
      from sms_private.form_runs r cross join generate_series(1,80) where r.id=$1`, [quiet.id]);
    await db.query("insert into public.sms_messages(tenant_id,contact_phone,direction,body,status) values($1,$2,'inbound','Still deciding','received')", [tenant, phone]);
    await call(db, 'api_action', 'admin', null, 'create_business', { id: 'another-tenant', name: 'Other', timeZone: 'UTC' });
    await db.exec("update public.sms_businesses set sending_enabled=true,status='active' where tenant_id='another-tenant'");
    const other = await addRun(db, { business: 'another-tenant' });
    assert.equal(await call(db, 'enqueue_due_automations'), 1);
    assert.equal((await db.query("select count(*)::integer n from sms_private.jobs where payload->>'form_run_id'=$1", [other.id])).rows[0].n, 1);
    const eligible = await addRun(db, { customer: '+13035550999' });
    await call(db, 'enqueue_due_automations');
    assert.equal((await db.query("select count(*)::integer n from sms_private.jobs where payload->>'form_run_id'=$1", [eligible.id])).rows[0].n, 1);
  } finally { await db.close(); }
});

test('activity hydrates only its current page; historical completed runs do not invoke quiet evaluation', async () => {
  const db = await setupCoordination();
  try {
    const current = await addRun(db);
    await db.query("update sms_private.form_runs set status='completed',next_run_at=null where id=$1", [current.id]);
    await db.query(`insert into sms_private.form_runs(tenant_id,form_id,version,submission_id,phone,context,status,created_at)
      select r.tenant_id,r.form_id,r.version,gen_random_uuid(),r.phone,r.context,'completed',now()-interval '2 years'
      from sms_private.form_runs r cross join generate_series(1,80) where r.id=$1`, [current.id]);
    await db.query(`insert into public.sms_messages(tenant_id,contact_phone,direction,body,status,provider_accepted_at,meta)
      select tenant_id,phone,'outbound','Historical','accepted',created_at,jsonb_build_object('form_run_id',id::text)
      from sms_private.form_runs where tenant_id=$1 and id<>$2`, [tenant, current.id]);
    await db.exec(`create table public.review_quiet_calls(n integer);
      create or replace function sms_private.run_quiet_until(r sms_private.form_runs) returns timestamptz language plpgsql as $$ begin insert into public.review_quiet_calls values(1); return null; end $$;`);
    const report = await call(db, 'automation_activity', 'admin', tenant, 'report', { pageSize: 1 });
    assert.equal(report.total, 1);
    assert.equal(report.rows.length, 1);
    const evaluations = (await db.query('select count(*)::integer n from public.review_quiet_calls')).rows[0].n;
    assert.ok(evaluations <= 1, `Expected at most one page hydration, observed ${evaluations}`);
    await db.query("insert into public.sms_messages(tenant_id,contact_phone,direction,body,status,provider_accepted_at,meta) values($1,$2,'outbound','Accepted','accepted',now(),jsonb_build_object('form_run_id',$3::text))", [tenant, phone, current.id]);
    assert.equal((await db.query('select count(*)::integer n from sms_private.activity_first_contacts where run_id=$1', [current.id])).rows[0].n, 1);
    assert.equal((await call(db, 'automation_activity', 'admin', tenant, 'report', {})).funnel.contacted, 1);
  } finally { await db.close(); }
});

test('email worker authenticates before shared admission and always releases its slot', async () => {
  const secret = 's'.repeat(32);
  const calls = [];
  let slots = true;
  const db = { call: async (name, ...args) => {
    calls.push([name, ...args]);
    if (name === 'edge_enter') return slots ? 'slot' : null;
    if (name === 'email_claim') return { id: 'job', lease_token: 'token' };
  } };
  const request = token => new Request('https://example.com', { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
  const handler = createEmailWorkerHandler({ db, secret, processJob: async () => { throw new Error('Crash'); } });
  assert.equal((await handler(request('invalid'))).status, 401);
  assert.equal(calls.length, 0);
  assert.equal((await handler(request(secret))).status, 503);
  assert.deepEqual(calls.at(-1), ['edge_exit', 'automation_jobs', 'slot']);
  slots = false;
  assert.deepEqual(await (await handler(request(secret))).json(), { status: 'paused_or_busy', processed: 0 });
});

async function pauseEmail(db, enrollment) {
  const job = (await db.query("insert into sms_private.email_jobs(enrollment_id,step_index,generation,due_at,status) values($1,$2,$3,now(),'failed') returning *", [enrollment.id, enrollment.step_index, enrollment.generation])).rows[0];
  await call(db, 'recover_email_jobs');
  assert.equal((await db.query('select status from sms_private.email_enrollments where id=$1', [enrollment.id])).rows[0].status, 'paused');
  return job;
}

async function consentedContact(db, address, customer) {
  const intake = await call(db, 'create_intake', 'admin', 'email-review', 'contacts', {
    name: 'Customer', phone: customer, email: address, emailOptIn: true,
    emailConsentEvidence: 'Customer signed the email consent card', details: {},
  });
  return (await db.query('select * from sms_private.email_enrollments where source_id=$1', [intake.id])).rows[0];
}

test('intake escalation terminates paused email and fences the obsolete job generation', async () => {
  const db = await testDatabase();
  try {
    await emailFixture(db, 0);
    const enrollment = await consentedContact(db, 'escalation@example.com', '+13035550801');
    const job = await pauseEmail(db, enrollment);
    await call(db, 'create_intake', 'admin', 'email-review', 'quote_requests', {
      name: 'Customer', phone: '+13035550801', email: 'escalation@example.com', emailOptIn: false, details: {},
    });
    const state = (await db.query('select * from sms_private.email_enrollments where id=$1', [enrollment.id])).rows[0];
    assert.equal(state.status, 'cancelled');
    assert.equal(state.generation, enrollment.generation + 1);
    assert.equal(state.pause_reason, null);
    await assert.rejects(call(db, 'email_retry', 'admin', 'email-review', job.id), /cannot be retried safely/);
  } finally { await db.close(); }
});

test('manual email retry cannot create another active sequence for the same address', async () => {
  const db = await testDatabase();
  try {
    await emailFixture(db, 0);
    const old = await consentedContact(db, 'shared@example.com', '+13035550802');
    const job = await pauseEmail(db, old);
    const current = await consentedContact(db, 'shared@example.com', '+13035550803');
    assert.equal(current.status, 'active');
    await assert.rejects(call(db, 'email_retry', 'admin', 'email-review', job.id), /cannot be retried safely/);
    assert.equal((await db.query("select count(*)::integer n from sms_private.email_enrollments where email='shared@example.com' and status='active'")).rows[0].n, 1);
    assert.equal((await db.query('select status from sms_private.email_enrollments where id=$1', [old.id])).rows[0].status, 'paused');
  } finally { await db.close(); }
});

test('unsubscribe, provider suppression, form and group shutdown terminate paused email', async () => {
  const db = await testDatabase({ legacyFormFixtures: true });
  try {
    await emailFixture(db, 0);
    const outcomes = [];
    for (const [i, kind] of ['unsubscribe', 'provider', 'form', 'group'].entries()) {
      const e = await consentedContact(db, kind+'@example.com', '+1303555081'+i);
      if (kind === 'form') {
        const form = (await call(db, 'list_web_forms', 'admin', 'email-review')).forms.find(f => f.preset === 'contacts');
        const settings = { title: 'Contact', description: '', buttonLabel: 'Send', enabled: true, emailEnabled: true, fields: [] };
        await call(db, 'save_web_form', 'admin', 'email-review', 'contacts', settings);
        await db.query('update sms_private.email_enrollments set form_public_id=$1 where id=$2', [form.public_id, e.id]);
        await pauseEmail(db, e);
        await call(db, 'save_web_form', 'admin', 'email-review', 'contacts', { ...settings, emailEnabled: false });
      } else {
        await pauseEmail(db, e);
        if (kind === 'unsubscribe') await call(db, 'email_unsubscribe', e.unsubscribe_token);
        if (kind === 'provider') await call(db, 'email_record_provider_event', 'paused-bounce', 'provider-paused', 'email.bounced', e.email);
        if (kind === 'group') {
          const group = (await call(db, 'email_overview', 'admin', 'email-review')).groups.find(g => g.group_id === e.group_id);
          await call(db, 'email_save_group', 'admin', 'email-review', group.group_id, {
            enabled: false, rule: group.rule, intent: '', systemPrompt: '', businessContext: '', mailingAddress: '',
          });
        }
      }
      outcomes.push((await db.query('select status,generation,pause_reason from sms_private.email_enrollments where id=$1', [e.id])).rows[0]);
    }
    assert.deepEqual(outcomes.map(e => e.status), ['unsubscribed', 'cancelled', 'cancelled', 'cancelled']);
    assert.ok(outcomes.every(e => e.generation === 2 && e.pause_reason === null));
  } finally { await db.close(); }
});
