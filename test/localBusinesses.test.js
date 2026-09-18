import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { addLocalBusiness, loadLocalBusinesses } from '../src/lib/localBusinesses.js';
import { listTenants, setStoredTenantAccounts, isTenantDataAccessSafe } from '../src/lib/tenantContext.js';

test('manual business creation persists without registration and stays limited to empty local workspaces', async () => {
  const keys = ['NODE_ENV', 'CRM_AUTH_DISABLED', 'CRM_DATA_MODE', 'LOCAL_BUSINESSES_FILE'];
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  const directory = await mkdtemp(path.join(os.tmpdir(), 'manual-business-'));
  Object.assign(process.env, { NODE_ENV: 'development', CRM_AUTH_DISABLED: 'true', CRM_DATA_MODE: 'empty', LOCAL_BUSINESSES_FILE: path.join(directory, 'businesses.json') });
  try {
    await assert.rejects(addLocalBusiness({ name: '' }), /business name/);
    await assert.rejects(addLocalBusiness({ name: 'Invalid zone', timeZone: 'Invalid' }), /time zone/);
    const business = await addLocalBusiness({ name: 'Example Studio', timeZone: 'America/Denver' });
    assert.equal(business.id, 'example-studio');
    assert.equal(JSON.parse(await readFile(process.env.LOCAL_BUSINESSES_FILE, 'utf8'))[0].name, business.name);
    await assert.rejects(addLocalBusiness({ name: 'example studio' }), /already exists/);
    setStoredTenantAccounts([]);
    await loadLocalBusinesses();
    assert.ok(listTenants().some(b => b.id === business.id));
    assert.equal(isTenantDataAccessSafe(), true);
    process.env.CRM_DATA_MODE = '';
    assert.equal(isTenantDataAccessSafe(), false);
    await assert.rejects(addLocalBusiness({ name: 'Another Studio' }), /unavailable/);
    process.env.CRM_DATA_MODE = 'empty';
    process.env.NODE_ENV = 'production';
    await assert.rejects(addLocalBusiness({ name: 'Another Studio' }), /unavailable/);
  } finally {
    setStoredTenantAccounts([]);
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
    await rm(directory, { recursive: true, force: true });
  }
});
