import test from 'node:test';
import assert from 'node:assert/strict';
import { createCrmHandler } from '../supabase/functions/crm-api/handler.js';

test('production categories API exposes only the four fixed SMS automation types', async () => {
  process.env.CRM_ALLOWED_ORIGINS = 'https://crm.example.com';
  const db = {
    call: async (name, _user, _tenant, resource) => {
      assert.equal(name, 'api_read');
      if (resource === 'groups') return { rows: [
        { id: 'sms-contact', fixed_type: 'contacts', kind: 'contact', rule: { repeatCount: 1 }, intent: 'Help with the inquiry.' },
        { id: 'quote-requests', fixed_type: 'quote_requests', kind: 'quote', rule: { repeatCount: 6 }, intent: 'Help with a quote request.' },
        { id: 'appointment-reminders', fixed_type: 'bookings', kind: 'reminder', rule: { repeatCount: 1 }, intent: 'Remind about the booking.' },
        { id: 'sms-review', fixed_type: 'reviews', kind: 'review', rule: { repeatCount: 1 }, intent: 'Invite feedback.' },
        { id: 'legacy-custom', fixed_type: null, kind: 'custom', rule: {}, intent: null },
      ] };
      if (resource === 'ai_settings') return { rows: [] };
      throw new Error(`Unexpected resource: ${resource}`);
    },
  };
  const handler = createCrmHandler(db, async () => 'admin');
  const response = await handler(new Request('https://example.com/functions/v1/crm-api/categories', {
    headers: { Origin: 'https://crm.example.com', 'X-Tenant-ID': 'alpha' },
  }));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body.categories.map(item => item.fixedType), ['contacts', 'quote_requests', 'bookings', 'reviews']);
  assert.deepEqual(body.rulePresets, []);
  delete process.env.CRM_ALLOWED_ORIGINS;
});
