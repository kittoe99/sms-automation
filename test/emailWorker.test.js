import test from 'node:test';
import assert from 'node:assert/strict';
import { renderEmailMessage } from '../src/lib/resendEmail.js';
import { processEmailJob, draftEmail } from '../src/workers/email.js';
import { verifyResendWebhook } from '../src/lib/resendWebhook.js';

const job = { id: '01a0d955-fe85-70ab-bb56-a715e31632da', lease_token: 'lease' };
const settings = { enabled: true, intent: 'Help the customer plan the next step',
  system_prompt: 'Be concise', business_context: 'We provide local services',
  mailing_address: '123 Main St, Denver, CO 80201', sender: 'E2 Local <hello@e2local.com>',
  reply_to: 'hello@e2local.com' };
const enrollment = { email: 'alex@example.com', name: 'Alex', step_index: 0,
  unsubscribe_token: '01a0d955-fe85-70ab-bb56-a715e31632db', rule_snapshot: { repeatCount: 2 } };
const context = { settings, enrollment, source: { details: { service: 'moving' } },
  business: { name: 'E2 Local', timeZone: 'America/Denver' }, group: { name: 'Contacts', fixedType: 'contacts' } };

test('email rendering escapes customer text and includes a physical address and unsubscribe', () => {
  const rendered = renderEmailMessage('<script>hello</script>', 'E2 Local', settings.mailing_address, 'https://example.com/unsubscribe');
  assert.doesNotMatch(rendered.html, /<script>/);
  assert.match(rendered.html, /&lt;script&gt;/);
  assert.match(rendered.text, /123 Main St/);
  assert.match(rendered.text, /Unsubscribe:/);
});

test('AI draft uses email-specific group context and validates response', async () => {
  let request;
  const result = await draftEmail(context, { apiKey: 'test', fetchImpl: async (_, options) => {
    request = JSON.parse(options.body);
    return new Response(JSON.stringify({ status: 'completed', output: [{ type: 'message', content: [
      { type: 'output_text', text: JSON.stringify({ subject: 'Your next step', body: 'Hi Alex, how can we help?' }) },
    ] }] }), { status: 200 });
  } });
  assert.equal(result.subject, 'Your next step');
  assert.match(request.instructions, /Be concise/);
  assert.match(request.input, /local services/);
  assert.match(request.input, /moving/);
});

test('worker sends one idempotent Resend email only after the database guard', async () => {
  const calls = [], requests = [];
  let providerPayload;
  const db = { call: async (name, ...args) => {
    calls.push(name);
    if (name === 'email_job_context') return context;
    if (name === 'email_save_payload') providerPayload = args[2];
    if (name === 'email_before_send') return { settings, enrollment, job: { provider_payload: providerPayload } };
    if (name === 'email_finish') assert.deepEqual(args.slice(2), ['sent', 'provider-id', null]);
  } };
  await processEmailJob(job, db, { apiKey: 'test', draft: async () => ({ subject: 'Hello', body: 'Hi Alex' }),
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return new Response(JSON.stringify({ id: 'provider-id' }), { status: 200 });
    } });
  assert.deepEqual(calls, ['email_job_context','email_save_draft','email_save_payload','email_before_send','email_finish']);
  assert.equal(requests[0].options.headers['Idempotency-Key'], job.id);
  const message = JSON.parse(requests[0].options.body);
  assert.equal(message.to, 'alex@example.com');
  assert.match(message.html, /email-unsubscribe\.html\?token=/);
  assert.match(message.headers['List-Unsubscribe'], /web-form\/email\/unsubscribe\?token=/);
});

test('database guard cancels an ineligible job without a provider call', async () => {
  const calls = [];
  const db = { call: async name => {
    calls.push(name);
    if (name === 'email_job_context') return context;
    if (name === 'email_before_send') return null;
  } };
  await processEmailJob(job, db, { apiKey: 'test', draft: async () => ({ subject: 'Hello', body: 'Hi Alex' }),
    fetchImpl: () => { throw new Error('No send expected'); } });
  assert.deepEqual(calls, ['email_job_context','email_save_draft','email_save_payload','email_before_send']);
});

test('Resend webhook signature checks raw payload and timestamp', async () => {
  const secret = `whsec_${btoa('test-signing-secret')}`;
  const raw = '{"type":"email.bounced"}';
  const id = 'evt_123', timestamp = String(Math.floor(Date.now() / 1000));
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode('test-signing-secret'),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const bytes = new Uint8Array(await crypto.subtle.sign('HMAC', key,
    new TextEncoder().encode(`${id}.${timestamp}.${raw}`)));
  const signature = btoa(String.fromCharCode(...bytes));
  const headers = new Headers({ 'svix-id': id, 'svix-timestamp': timestamp, 'svix-signature': `v1,${signature}` });
  assert.equal(await verifyResendWebhook(raw, headers, secret), true);
  assert.equal(await verifyResendWebhook(`${raw} `, headers, secret), false);
  assert.equal(await verifyResendWebhook(raw, headers, secret, Date.now() + 600000), false);
});
