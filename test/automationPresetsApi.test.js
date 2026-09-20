import test from 'node:test';
import assert from 'node:assert/strict';
import { createCrmHandler } from '../supabase/functions/crm-api/handler.js';

test('production categories API exposes ready-made rules and expanded cadences', async () => {
  process.env.CRM_ALLOWED_ORIGINS = 'https://crm.example.com';
  const db = {
    call: async (name, _user, _tenant, resource) => {
      assert.equal(name, 'api_read');
      if (resource === 'groups' || resource === 'ai_settings') return { rows: [] };
      throw new Error(`Unexpected resource: ${resource}`);
    },
  };
  const handler = createCrmHandler(db, async () => 'admin');
  const response = await handler(new Request('https://example.com/functions/v1/crm-api/categories', {
    headers: { Origin: 'https://crm.example.com', 'X-Tenant-ID': 'alpha' },
  }));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.ok(body.rulePresets.length >= 7);
  assert.ok(body.cadences.some((item) => item.id === 'every_5_days'));
  assert.ok(body.cadences.some((item) => item.id === 'every_2_weeks'));
  assert.ok(body.cadences.some((item) => item.id === 'quarterly'));
  delete process.env.CRM_ALLOWED_ORIGINS;
});
