import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { generateKeyPair, SignJWT, jwtVerify } from 'jose';
import { createLocalPreviewApp, localPreviewConfig } from '../src/localPreviewApp.js';

const env = { NODE_ENV: 'development', CRM_PREVIEW_MODE: 'development',
  NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: `pk_test_${Buffer.from('preview-fixture.clerk.accounts.dev$').toString('base64url')}`,
  CLERK_SECRET_KEY: 'sk_test_fixture' };

test('development preview requires explicit selection and test keys, and refuses production', () => {
  assert.equal(localPreviewConfig({}), null);
  for (const override of [{ NODE_ENV: 'production' }, { NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: 'pk_live_fixture' },
    { CLERK_SECRET_KEY: 'sk_live_fixture' }, { NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: 'pk_test_invalid' }]) {
    assert.throws(() => localPreviewConfig({ ...env, ...override }));
  }
});

test('development preview verifies sessions, isolates sample records and keeps secrets server-side', async t => {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const foreign = await generateKeyPair('RS256');
  const config = localPreviewConfig(env);
  const server = createLocalPreviewApp(config, {
    distDir: fileURLToPath(new URL('../public', import.meta.url)),
    verify: async (token, options) => {
      assert.equal(options.secretKey, env.CLERK_SECRET_KEY);
      assert.deepEqual(options.authorizedParties, config.origins);
      return (await jwtVerify(token, publicKey, { algorithms: ['RS256'] })).payload;
    },
  }).listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const token = (overrides = {}, key = privateKey) => new SignJWT({ sub: 'test-user', sid: 'test-session',
    azp: 'http://localhost:8080', iss: config.issuer, exp: Math.floor(Date.now() / 1000) + 300,
    iat: Math.floor(Date.now() / 1000), ...overrides }).setProtectedHeader({ alg: 'RS256' }).sign(key);
  const response = async (path, jwt, options = {}) => fetch(`${base}${path}`, {
    ...options, headers: { ...(jwt ? { Authorization: `Bearer ${jwt}` } : {}), ...options.headers },
  });
  const cfg = await (await response('/api/auth/config')).json();
  assert.equal(cfg.mode, 'clerk');
  assert.equal(cfg.configured, true);
  assert.equal(cfg.demo, undefined);
  assert.equal(cfg.publishableKey, env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY);
  assert.equal(JSON.stringify(cfg).includes(env.CLERK_SECRET_KEY), false);
  const browserConfig = await (await response('/config.js')).text();
  assert.match(browserConfig, /"previewReadOnly":true/);
  assert.doesNotMatch(browserConfig, /supabase\.co|e2local\.com|sk_test_/);
  for (const path of ['/api/auth/me', '/api/tenants', '/api/directory']) {
    assert.equal((await response(path)).status, 401, path);
  }
  const valid = await token();
  assert.equal((await (await response('/api/auth/me', valid)).json()).user.id, 'test-user');
  const tenants = await (await response('/api/tenants', valid)).json();
  assert.equal(tenants.tenants.length, 2);
  const directory = await (await response('/api/directory', valid)).json();
  assert.ok(directory.contacts.every(contact => contact.email.endsWith('@example.com')));
  for (const invalid of [await token({ iss: 'https://clerk.crm.e2local.com' }),
    await token({ azp: 'https://other.example.test' }), await token({ sid: '' }),
    await token({ sub: '' }), await token({ exp: 1 }), await token({}, foreign.privateKey), 'tampered']) {
    assert.equal((await response('/api/auth/me', invalid)).status, 401);
  }
  assert.equal((await response('/api/tenants', valid, { headers: { Origin: 'https://other.example.test' } })).status, 403);
  assert.equal((await response('/api/directory', valid, { headers: { 'X-Tenant-ID': 'production-business' } })).status, 403);
  for (const path of ['/api/send', '/api/platform/businesses', '/webhooks/twilio', '/hosting-preview', '/ws']) {
    assert.equal((await response(path, valid, { method: 'POST' })).status, 403);
  }
  assert.equal((await response('/.env.local')).status, 404);
  assert.equal((await response('/')).status, 200);
});
