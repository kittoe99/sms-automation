import assert from 'node:assert/strict';
import test from 'node:test';

import {
  defaultTenantFromEnv,
  parseTenantAccounts,
  runWithTenant,
  getCurrentTenantId,
  toPublicTenant,
} from '../src/lib/tenantContext.js';

test('tenant registry always includes the default and deduplicates configured accounts', () => {
  const fallback = defaultTenantFromEnv({
    DEFAULT_TENANT_ID: 'opek',
    DEFAULT_TENANT_NAME: 'Opek Junk Removal',
    DEFAULT_TENANT_SHORT_NAME: 'Opek',
    BUSINESS_TIME_ZONE: 'America/Denver',
  });
  const tenants = parseTenantAccounts(
    JSON.stringify([
      { id: 'opek', name: 'Opek Updated' },
      { id: 'Acme Co', name: 'Acme Company', shortName: 'Acme' },
    ]),
    fallback
  );

  assert.deepEqual(tenants.map((tenant) => tenant.id), ['opek', 'acme-co']);
  assert.equal(tenants[0].name, 'Opek Updated');
  assert.deepEqual(tenants[0].phoneNumbers, fallback.phoneNumbers);
});

test('tenant context remains available across asynchronous work', async () => {
  const tenant = { id: 'acme' };
  await runWithTenant(tenant, async () => {
    await Promise.resolve();
    assert.equal(getCurrentTenantId(), 'acme');
  });
});

test('public tenant data excludes routing phone numbers', () => {
  const publicTenant = toPublicTenant({
    id: 'acme',
    name: 'Acme Company',
    shortName: 'Acme',
    timeZone: 'America/Denver',
    status: 'active',
    phoneNumbers: ['5551234567'],
  });

  assert.equal(publicTenant.id, 'acme');
  assert.equal('phoneNumbers' in publicTenant, false);
});
