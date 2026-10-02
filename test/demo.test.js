import test from 'node:test';
import assert from 'node:assert/strict';
import { createDemoApp } from '../src/demoApp.js';

test('standalone demo is unauthenticated, synthetic, tenant-scoped, and read-only', async t => {
  const server = createDemoApp().listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const cfg = await fetch(`${base}/api/auth/config`).then(r => r.json());
  assert.equal(cfg.mode, 'demo');
  assert.equal(cfg.configured, false);
  assert.equal(cfg.publishableKey, undefined);
  const tenants = await fetch(`${base}/api/tenants`).then(r => r.json());
  assert.equal(tenants.tenants.length, 2);
  const data = [];
  for (const tenant of tenants.tenants) {
    const headers = { 'X-Tenant-ID': tenant.id };
    const overview = await fetch(`${base}/api/overview`, { headers }).then(r => r.json());
    assert.equal(overview.demo, true);
    assert.ok(overview.total > 0);
    const directory = await fetch(`${base}/api/directory`, { headers }).then(r => r.json());
    assert.ok(directory.contacts.every(c => c.email.endsWith('@example.com')));
    data.push(directory.contacts);
    const inbox = await fetch(`${base}/api/conversations`, { headers }).then(r => r.json());
    assert.ok(inbox.conversations.every(c => c.id && c.phone));
    const phone = inbox.conversations[0].id;
    const thread = await fetch(`${base}/api/conversations/${encodeURIComponent(phone)}`, { headers }).then(r => r.json());
    assert.equal(thread.conversation.messages.length, 2);
    const bookings = await fetch(`${base}/api/bookings`, { headers }).then(r => r.json());
    assert.equal(bookings.bookings.length, 1);
    assert.equal((await fetch(`${base}/api/bookings/${bookings.bookings[0].id}`, { headers })).status, 200);
    const bookingSettings = await fetch(`${base}/api/booking-settings`, { headers }).then(r => r.json());
    assert.equal(bookingSettings.enabled, true);
    for (const path of ['/categories', '/messages', '/conversations', '/contacts', '/opt-outs', '/deliverability', '/automations/quote-requests', '/enrollments', '/ai/outbound-call', '/web-forms']) {
      assert.equal((await fetch(`${base}/api${path}`, { headers })).status, 200, path);
    }
  }
  for (const id of ['00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000003']) {
    const form = await fetch(`${base}/functions/v1/web-form/${id}`).then(r => r.json());
    assert.match(form.form.consentText, /Opek — Demo/);
    assert.equal((await fetch(`${base}/functions/v1/web-form/${id}`, { method: 'POST' })).status, 403);
  }
  assert.equal(data[0].some(a => data[1].some(b => a.phone === b.phone)), false);
  assert.equal((await fetch(`${base}/api/conversations/${encodeURIComponent(data[0][0].phone)}`, {
    headers: { 'X-Tenant-ID': tenants.tenants[1].id },
  })).status, 404);
  assert.equal((await fetch(`${base}/api/overview`, { headers: { 'X-Tenant-ID': 'live-account' } })).status, 403);
  for (const path of ['/api/send', '/api/platform/businesses', '/api/internal/tick', '/api/auth/me', '/api/unknown', '/webhooks/twilio/inbound']) {
    assert.equal((await fetch(`${base}${path}`)).status, 403, path);
  }
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
    for (const path of ['/', '/api/overview', '/api/directory/message', '/api/conversations/sample/call', '/webhooks/incoming']) {
      assert.equal((await fetch(`${base}${path}`, { method })).status, 403, `${method} ${path}`);
    }
  }
  assert.equal((await fetch(`${base}/`)).status, 200);
  assert.equal((await fetch(`${base}/.env`)).status, 404);
  assert.equal((await fetch(`${base}/src/index.js`)).status, 404);
  assert.equal((await fetch(`${base}/api/overview`, { method: 'HEAD' })).status, 200);
});
