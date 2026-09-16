import assert from 'node:assert/strict';
import test from 'node:test';
import { once } from 'node:events';
import express from 'express';
import twilio from 'twilio';
import { encryptTwilioCredentials, decryptTwilioCredentials, credentialEncryptionKey } from '../src/lib/credentialVault.js';
import { getTenantTwilioConfig } from '../src/lib/tenantTwilio.js';
import { getTwilioClient } from '../src/lib/twilioClient.js';
import { defaultTenantFromEnv, parseTenantAccounts, resolveTenantForTwilioAccount, runWithTenant, setStoredTenantAccounts, listTenants, tenantMatchesClerkAuth } from '../src/lib/tenantContext.js';
import { normalizeNewBusiness, publicBusiness } from '../src/lib/businessAccounts.js';
import { provisionBusinessTwilio, reconcileBusinessTwilio, twilioWebhookUrls } from '../src/lib/twilioProvisioning.js';
import { createPlatformRouter } from '../src/routes/platform.js';
import { requireApiKey } from '../src/lib/apiAuth.js';
import { webhooksRouter } from '../src/routes/webhooks.js';

const parentSid = `AC${'1'.repeat(32)}`;
const childSid = `AC${'2'.repeat(32)}`;
const otherSid = `AC${'3'.repeat(32)}`;
const serviceSid = `MG${'4'.repeat(32)}`;
const key = Buffer.alloc(32, 7);
const env = {
  TWILIO_PARENT_ACCOUNT_SID: parentSid,
  TWILIO_PARENT_AUTH_TOKEN: 'parent-secret',
  TENANT_CREDENTIAL_ENCRYPTION_KEY: key.toString('base64'),
  PUBLIC_BASE_URL: 'https://sms.example.test',
};

function memoryStore(initial = {}) {
  let row = { id: 'acme', name: 'Acme', short_name: 'Acme', clerk_organization_id: 'org_acme', status: 'pending', twilio_state: 'not_provisioned', ...initial };
  return {
    async get(id) { return id === row.id ? { ...row } : null; },
    async list() { return [{ ...row }]; },
    async transition(id, state, changes) {
      if (id !== row.id || row.twilio_state !== state) throw Object.assign(new Error('Concurrent operation'), { status: 409 });
      row = { ...row, ...changes };
      return { ...row };
    },
  };
}

function providerMock({ failAccount = false, failService = false } = {}) {
  const calls = [];
  const factory = (sid, token) => {
    calls.push({ operation: 'client', sid, token });
    const accounts = accountSid => ({ async fetch() {
      return { sid: accountSid, ownerAccountSid: parentSid, authToken: 'child-secret', status: 'active', friendlyName: 'Acme [acme]' };
    } });
    accounts.create = async options => {
      calls.push({ operation: 'createAccount', options });
      if (failAccount) throw new Error('Provider timed out');
      return { sid: childSid, ownerAccountSid: parentSid, authToken: 'child-secret' };
    };
    const services = selectedSid => ({ async fetch() {
      return { sid: selectedSid, accountSid: sid, inboundRequestUrl: `${env.PUBLIC_BASE_URL}/webhooks/twilio/inbound`, inboundMethod: 'POST', statusCallback: `${env.PUBLIC_BASE_URL}/webhooks/twilio/status`, useInboundWebhookOnNumber: false };
    } });
    services.create = async options => {
      calls.push({ operation: 'createService', options });
      if (failService) throw new Error('Provider timed out');
      return { sid: serviceSid };
    };
    return { api: { v2010: { accounts } }, messaging: { v1: { services } } };
  };
  return { factory, calls };
}

async function withServer(app, run) {
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try { await run(`http://127.0.0.1:${server.address().port}`); }
  finally { await new Promise(resolve => server.close(resolve)); }
}

async function withEnv(values, run) {
  const previous = Object.fromEntries(Object.keys(values).map(k => [k, process.env[k]]));
  for (const [k, v] of Object.entries(values)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  try { return await run(); }
  finally { for (const [k, v] of Object.entries(previous)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
}

test('credentials are authenticated, randomized and bound to their business/account', () => {
  const encrypted = encryptTwilioCredentials('acme', childSid, { authToken: 'private-secret' }, key);
  assert.equal(encrypted.includes('private-secret'), false);
  assert.deepEqual(decryptTwilioCredentials('acme', childSid, encrypted, key), { authToken: 'private-secret' });
  assert.notEqual(encrypted, encryptTwilioCredentials('acme', childSid, { authToken: 'private-secret' }, key));
  assert.throws(() => decryptTwilioCredentials('other', childSid, encrypted, key));
  assert.throws(() => decryptTwilioCredentials('acme', otherSid, encrypted, key));
  assert.throws(() => decryptTwilioCredentials('acme', childSid, encrypted, Buffer.alloc(32, 8)));
  assert.throws(() => decryptTwilioCredentials('acme', childSid, encrypted.slice(0, -4), key));
  assert.throws(() => credentialEncryptionKey({ TENANT_CREDENTIAL_ENCRYPTION_KEY: 'short' }), { status: 503 });
});

test('new businesses never inherit legacy Twilio secrets or phone/org mappings', () => {
  const legacy = { DEFAULT_TENANT_ID: 'opek', TWILIO_ACCOUNT_SID: parentSid, TWILIO_AUTH_TOKEN: 'legacy-secret', TWILIO_FROM_NUMBER: '+17205550123', DEFAULT_TENANT_CLERK_ORGANIZATION_ID: 'org_opek' };
  assert.equal(getTenantTwilioConfig({ id: 'opek' }, legacy).authToken, 'legacy-secret');
  assert.equal(getTenantTwilioConfig({ id: 'acme' }, legacy).authToken, '');
  assert.equal(getTenantTwilioConfig({ id: 'opek', twilio: { accountSid: childSid } }, legacy).authToken, '');
  const tenant = parseTenantAccounts(JSON.stringify([{ id: 'acme', name: 'Acme' }]), defaultTenantFromEnv(legacy))[1];
  assert.deepEqual(tenant.phoneNumbers, []);
  assert.equal(tenant.clerkOrganizationId, null);
});

test('Twilio clients are isolated by business credentials and rotate with secrets', async () => {
  const a = { id: 'acme', twilio: { accountSid: childSid, authToken: 'a' } };
  const b = { id: 'other', twilio: { accountSid: otherSid, authToken: 'b' } };
  const [ca, cb] = await Promise.all([runWithTenant(a, async () => { await Promise.resolve(); return getTwilioClient(); }), runWithTenant(b, async () => getTwilioClient())]);
  assert.notEqual(ca, cb);
  assert.equal(ca.accountSid, childSid);
  assert.equal(cb.accountSid, otherSid);
  assert.notEqual(ca, runWithTenant({ ...a, twilio: { ...a.twilio, authToken: 'rotated' } }, getTwilioClient));
  assert.throws(() => runWithTenant({ id: 'unconfigured' }, getTwilioClient));
});

test('AccountSid routing rejects unknown or duplicate accounts, and pending businesses are not active', async () => {
  await withEnv({ TWILIO_ACCOUNT_SID: parentSid, TENANT_ACCOUNTS_JSON: '[]' }, async () => {
    setStoredTenantAccounts([{ id: 'acme', name: 'Acme', status: 'active', twilio: { accountSid: childSid, authToken: 'a' } }, { id: 'pending', status: 'pending', twilio: { accountSid: otherSid } }]);
    try {
      assert.equal(resolveTenantForTwilioAccount(childSid).id, 'acme');
      assert.equal(resolveTenantForTwilioAccount(parentSid).id, 'opek');
      assert.equal(resolveTenantForTwilioAccount(otherSid), null);
      assert.equal(listTenants().some(t => t.id === 'pending'), false);
      setStoredTenantAccounts([{ id: 'duplicate', status: 'active', twilio: { accountSid: parentSid } }]);
      assert.equal(resolveTenantForTwilioAccount(parentSid), null);
    } finally { setStoredTenantAccounts([]); }
  });
});

test('business creation validates ids, org binding, timezone and ignores requested activation/secrets', () => {
  const input = { id: 'acme', name: 'Acme', clerkOrganizationId: 'org_acme', timeZone: 'America/Denver', status: 'active', twilio: { authToken: 'malicious' } };
  const row = normalizeNewBusiness(input);
  assert.equal(row.status, 'pending');
  assert.equal(row.twilio, undefined);
  assert.throws(() => normalizeNewBusiness({ ...input, id: 'Acme!' }), { status: 400 });
  assert.throws(() => normalizeNewBusiness({ ...input, id: 'opek' }), { status: 409 });
  assert.throws(() => normalizeNewBusiness({ ...input, clerkOrganizationId: '' }), { status: 400 });
  assert.throws(() => normalizeNewBusiness({ ...input, timeZone: 'Not/AZone' }), { status: 400 });
});

test('pending businesses and registry mode cannot grant new users legacy default-business access', async () => {
  await withEnv({ TENANT_REGISTRY_STORE: undefined, TENANT_ACCOUNTS_JSON: '[]' }, async () => {
    const legacy = { id: 'opek' };
    const user = { userId: 'user_new', orgId: 'org_acme' };
    assert.equal(tenantMatchesClerkAuth(legacy, user), true);
    setStoredTenantAccounts([{ id: 'acme', status: 'pending', clerkOrganizationId: 'org_acme' }]);
    try { assert.equal(tenantMatchesClerkAuth(legacy, user), false); }
    finally { setStoredTenantAccounts([]); }
    await withEnv({ TENANT_REGISTRY_STORE: 'supabase' }, async () => {
      assert.equal(tenantMatchesClerkAuth(legacy, user), false);
      assert.equal(tenantMatchesClerkAuth({ id: 'opek', clerkOrganizationId: 'org_opek' }, user), false);
      assert.equal(tenantMatchesClerkAuth({ id: 'opek', clerkOrganizationId: 'org_opek' }, { userId: 'user_opek', orgId: 'org_opek' }), true);
    });
  });
});

test('provisioning creates one subaccount and service using child credentials; never activates or exposes secrets', async () => {
  const store = memoryStore();
  const mock = providerMock();
  const options = { store, clientFactory: mock.factory, env, validateHost: async () => {} };
  const result = await provisionBusinessTwilio('acme', options);
  assert.equal(result.twilio.state, 'ready');
  assert.equal(result.status, 'pending');
  assert.equal(JSON.stringify(result).includes('secret'), false);
  const serviceCall = mock.calls.find(c => c.operation === 'createService');
  assert.equal(serviceCall.options.useInboundWebhookOnNumber, false);
  assert.equal(serviceCall.options.inboundRequestUrl, `${env.PUBLIC_BASE_URL}/webhooks/twilio/inbound`);
  assert.equal(serviceCall.options.statusCallback, `${env.PUBLIC_BASE_URL}/webhooks/twilio/status`);
  assert.equal(mock.calls.filter(c => c.operation === 'client')[1].sid, childSid);
  assert.equal(mock.calls.filter(c => c.operation === 'client')[1].token, 'child-secret');
  const row = await store.get('acme');
  assert.equal(row.twilio_credentials_encrypted.includes('child-secret'), false);
  assert.deepEqual(decryptTwilioCredentials('acme', childSid, row.twilio_credentials_encrypted, key), { authToken: 'child-secret' });
  assert.deepEqual(await provisionBusinessTwilio('acme', options), result);
  assert.equal(mock.calls.filter(c => c.operation === 'createAccount').length, 1);
});

test('concurrent provisioning cannot create duplicate accounts', async () => {
  const store = memoryStore();
  const mock = providerMock();
  const options = { store, clientFactory: mock.factory, env, validateHost: async () => {} };
  const results = await Promise.allSettled([provisionBusinessTwilio('acme', options), provisionBusinessTwilio('acme', options)]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(mock.calls.filter(c => c.operation === 'createAccount').length, 1);
});

test('invalid encryption config, localhost, unresolved callback host or missing parent credentials create no resources', async () => {
  const mock = providerMock();
  for (const changed of [{ TENANT_CREDENTIAL_ENCRYPTION_KEY: '' }, { PUBLIC_BASE_URL: 'http://localhost:8080' }, { TWILIO_PARENT_AUTH_TOKEN: '' }]) {
    await assert.rejects(provisionBusinessTwilio('acme', { store: memoryStore(), clientFactory: mock.factory, env: { ...env, ...changed }, validateHost: async () => {} }), { status: 503 });
  }
  await assert.rejects(provisionBusinessTwilio('acme', { store: memoryStore(), clientFactory: mock.factory, env, validateHost: async () => { throw Object.assign(new Error('Unresolved'), { status: 503 }); } }), { status: 503 });
  assert.equal(mock.calls.length, 0);
  assert.throws(() => twilioWebhookUrls({ PUBLIC_BASE_URL: 'https://user:password@example.com' }), { status: 503 });
});

test('ambiguous Twilio responses require reconciliation instead of blind retries', async () => {
  for (const stage of ['account', 'service']) {
    const store = memoryStore();
    const mock = providerMock({ failAccount: stage === 'account', failService: stage === 'service' });
    const options = { store, clientFactory: mock.factory, env, validateHost: async () => {} };
    await assert.rejects(provisionBusinessTwilio('acme', options), { status: 502 });
    assert.equal((await store.get('acme')).twilio_state, stage === 'account' ? 'subaccount_unknown' : 'service_unknown');
    await assert.rejects(provisionBusinessTwilio('acme', options), { status: 409 });
    assert.equal(mock.calls.filter(c => c.operation === 'createAccount').length, 1);
  }
});

test('reconciliation verifies ownership and adopts existing resources without creating any', async () => {
  const store = memoryStore({ twilio_state: 'subaccount_unknown' });
  const mock = providerMock();
  const result = await reconcileBusinessTwilio('acme', { accountSid: childSid, messagingServiceSid: serviceSid }, { store, clientFactory: mock.factory, env });
  assert.equal(result.twilio.state, 'ready');
  assert.equal(result.status, 'pending');
  assert.equal(mock.calls.some(c => c.operation.startsWith('create')), false);
  assert.equal(JSON.stringify(result).includes('child-secret'), false);
  await assert.rejects(reconcileBusinessTwilio('acme', { accountSid: childSid }, { store, clientFactory: mock.factory, env }), { status: 409 });
  const another = memoryStore({ twilio_state: 'service_unknown', twilio_account_sid: childSid });
  await assert.rejects(reconcileBusinessTwilio('acme', { accountSid: otherSid, messagingServiceSid: serviceSid }, { store: another, clientFactory: mock.factory, env }), { status: 409 });
});

test('platform routes reject business admins and whitelist public fields', async () => {
  await withEnv({ PLATFORM_ADMIN_USER_IDS: 'user_platform' }, async () => {
    const store = memoryStore({ twilio_credentials_encrypted: 'private-ciphertext' });
    let provisionCalls = 0;
    const app = express();
    app.use(express.json());
    app.use('/api/platform', createPlatformRouter({ store, authenticate: (req, _res, next) => { req.crmUser = { userId: req.get('X-Test-User'), orgRole: 'org:admin' }; next(); }, provision: async () => { provisionCalls++; return publicBusiness(await store.get('acme')); } }));
    await withServer(app, async base => {
      const denied = await fetch(`${base}/api/platform/businesses/acme/twilio/provision`, { method: 'POST', headers: { 'X-Test-User': 'user_business' } });
      assert.equal(denied.status, 403);
      assert.equal(provisionCalls, 0);
      const allowed = await fetch(`${base}/api/platform/businesses`, { headers: { 'X-Test-User': 'user_platform' } });
      assert.equal(allowed.status, 200);
      assert.equal((await allowed.text()).includes('private-ciphertext'), false);
      const created = await fetch(`${base}/api/platform/businesses/acme/twilio/provision`, { method: 'POST', headers: { 'X-Test-User': 'user_platform' } });
      assert.equal(created.status, 200);
      assert.equal(provisionCalls, 1);
    });
  });
});

test('default integration key cannot authorize another business via a tenant header', async () => {
  await withEnv({ OPEK_SMS_API_KEY: 'legacy-key', NODE_ENV: 'test' }, async () => {
    const app = express();
    app.get('/send', (req, _res, next) => { req.tenant = { id: 'acme', integrationApiKey: 'acme-key' }; next(); }, requireApiKey, (_req, res) => res.json({ ok: true }));
    await withServer(app, async base => {
      assert.equal((await fetch(`${base}/send`, { headers: { 'X-API-Key': 'legacy-key' } })).status, 401);
      assert.equal((await fetch(`${base}/send`, { headers: { 'X-API-Key': 'acme-key' } })).status, 200);
    });
  });
});

test('unknown AccountSid webhooks are rejected even when signed with the default token', async () => {
  await withEnv({ TWILIO_ACCOUNT_SID: parentSid, TWILIO_AUTH_TOKEN: 'legacy-token', PUBLIC_BASE_URL: 'https://sms.example.test', TWILIO_VALIDATE_SIGNATURE: 'true', TENANT_ACCOUNTS_JSON: '[]' }, async () => {
    const params = { AccountSid: otherSid, MessageSid: 'SM_test_unknown', MessageStatus: 'delivered', To: '+17205550123' };
    const path = '/webhooks/twilio/status';
    const signature = twilio.getExpectedTwilioSignature('legacy-token', `${env.PUBLIC_BASE_URL}${path}`, params);
    const app = express();
    app.use(express.urlencoded({ extended: false }));
    app.use('/webhooks/twilio', webhooksRouter);
    await withServer(app, async base => {
      const response = await fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Twilio-Signature': signature }, body: new URLSearchParams(params) });
      assert.equal(response.status, 403);
    });
  });
});
