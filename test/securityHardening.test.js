import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import express from 'express';

import { requireApiKey } from '../src/lib/apiAuth.js';
import {
  getClerkAuthorizedParties,
  getClerkFrontendApiUrl,
  isCrmAuthConfigured,
} from '../src/lib/crmAuth.js';
import { searchNeedle } from '../src/lib/messageDb.js';
import { extractWebSocketToken } from '../src/lib/realtime.js';
import { constantTimeEqual, createRateLimiter, securityHeaders } from '../src/lib/security.js';
import { toE164 } from '../src/lib/supabaseContacts.js';
import {
  assertTenantDataAccessSafe,
  isTenantDataAccessSafe,
  parseTenantAccounts,
  tenantMatchesClerkAuth,
} from '../src/lib/tenantContext.js';
import { webhooksRouter } from '../src/routes/webhooks.js';

async function withServer(app, run) {
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const { port } = server.address();
    return await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve()))
    );
  }
}

function restoreEnv(name, value) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

test('secret comparison is exact and API keys must be strong in production', async () => {
  assert.equal(constantTimeEqual('same-secret', 'same-secret'), true);
  assert.equal(constantTimeEqual('same-secret', 'different-secret'), false);

  const previousNodeEnv = process.env.NODE_ENV;
  const previousKey = process.env.OPEK_SMS_API_KEY;
  process.env.NODE_ENV = 'production';
  process.env.OPEK_SMS_API_KEY = 'short';
  try {
    const app = express();
    app.get('/protected', requireApiKey, (_req, res) => res.json({ ok: true }));
    await withServer(app, async (base) => {
      const response = await fetch(`${base}/protected`, {
        headers: { 'X-API-Key': 'short' },
      });
      assert.equal(response.status, 503);
    });
  } finally {
    restoreEnv('NODE_ENV', previousNodeEnv);
    restoreEnv('OPEK_SMS_API_KEY', previousKey);
  }
});

test('raw PostgREST filter syntax is removed from search input', () => {
  const needle = searchNeedle('alice%,name.eq.admin_(x):"\\');
  assert.equal(needle.startsWith('%'), true);
  assert.equal(needle.endsWith('%'), true);
  assert.equal(/[_,.():"\\]/.test(needle.slice(1, -1)), false);
  assert.ok(searchNeedle('a'.repeat(500)).length <= 162);
});

test('phone normalization rejects invalid E.164 lengths', () => {
  assert.equal(toE164('(720) 555-0123'), '+17205550123');
  assert.equal(toE164('+442071838750'), '+442071838750');
  assert.equal(toE164('+1234567890123456'), '');
  assert.equal(toE164('12345'), '');
});

test('multiple configured tenants fail closed until isolation is implemented', () => {
  const previous = process.env.TENANT_ACCOUNTS_JSON;
  process.env.TENANT_ACCOUNTS_JSON = JSON.stringify([{ id: 'acme', name: 'Acme' }]);
  try {
    assert.equal(isTenantDataAccessSafe(), false);
    assert.throws(assertTenantDataAccessSafe, { code: 'TENANT_ISOLATION_REQUIRED' });
  } finally {
    restoreEnv('TENANT_ACCOUNTS_JSON', previous);
  }
});

test('Clerk organization claims authorize only their mapped tenant', () => {
  const tenant = parseTenantAccounts(
    JSON.stringify([{ id: 'opek', name: 'Opek', clerkOrganizationId: 'org_opek' }])
  )[0];
  assert.equal(tenantMatchesClerkAuth(tenant, { userId: 'user_1', orgId: 'org_opek' }), true);
  assert.equal(tenantMatchesClerkAuth(tenant, { userId: 'user_1', orgId: 'org_other' }), false);
  assert.equal(tenantMatchesClerkAuth(tenant, { userId: null, orgId: 'org_opek' }), false);
});

test('Clerk configuration derives and restricts the tenant-specific origins', () => {
  const clerkHost = 'steady-otter.clerk.accounts.dev';
  const env = {
    NODE_ENV: 'production',
    PUBLIC_BASE_URL: 'https://sms.example.com/path',
    CLERK_PUBLISHABLE_KEY: `pk_test_${Buffer.from(`${clerkHost}$`).toString('base64url')}`,
    CLERK_SECRET_KEY: 'sk_test_example',
  };
  assert.equal(getClerkFrontendApiUrl(env), `https://${clerkHost}`);
  assert.deepEqual(getClerkAuthorizedParties(env), ['https://sms.example.com']);
  assert.equal(isCrmAuthConfigured(env), true);
  assert.equal(isCrmAuthConfigured({ ...env, PUBLIC_BASE_URL: 'http://sms.example.com' }), false);
});

test('browser security headers block framing and third-party scripts', async () => {
  const app = express();
  app.use(securityHeaders);
  app.get('/', (_req, res) => res.send('ok'));
  app.get('/embed.html', (_req, res) => res.send('embed'));

  await withServer(app, async (base) => {
    const response = await fetch(base);
    assert.equal(response.headers.get('x-frame-options'), 'DENY');
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    const policy = response.headers.get('content-security-policy');
    assert.match(policy, /script-src 'self'/);
    assert.doesNotMatch(policy, /esm\.sh/);
    const embed = await fetch(`${base}/embed.html`);
    assert.equal(embed.status, 200);
    assert.equal(embed.headers.get('x-frame-options'), null);
    assert.doesNotMatch(embed.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  });
});

test('WebSocket authentication is read from a subprotocol, not a URL token', () => {
  assert.equal(extractWebSocketToken('opek-sms-v1, auth.header.payload.signature'), 'header.payload.signature');
  assert.equal(extractWebSocketToken('opek-sms-v1'), '');
});

test('sensitive action limiter returns 429 after its configured budget', async () => {
  const app = express();
  app.use(createRateLimiter({ windowMs: 60_000, max: 2, key: () => 'test' }));
  app.get('/', (_req, res) => res.send('ok'));

  await withServer(app, async (base) => {
    assert.equal((await fetch(base)).status, 200);
    assert.equal((await fetch(base)).status, 200);
    const blocked = await fetch(base);
    assert.equal(blocked.status, 429);
    assert.ok(Number(blocked.headers.get('retry-after')) >= 1);
  });
});

test('production cannot disable Twilio webhook verification', async () => {
  const previousNodeEnv = process.env.NODE_ENV;
  const previousValidation = process.env.TWILIO_VALIDATE_SIGNATURE;
  const previousToken = process.env.TWILIO_AUTH_TOKEN;
  const previousTenants = process.env.TENANT_ACCOUNTS_JSON;
  process.env.NODE_ENV = 'production';
  process.env.TWILIO_VALIDATE_SIGNATURE = 'false';
  delete process.env.TWILIO_AUTH_TOKEN;
  delete process.env.TENANT_ACCOUNTS_JSON;
  try {
    const app = express();
    app.use(express.urlencoded({ extended: false }));
    app.use('/webhooks/twilio', webhooksRouter);
    await withServer(app, async (base) => {
      const response = await fetch(`${base}/webhooks/twilio/inbound`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'From=%2B17205550123&Body=hello',
      });
      assert.equal(response.status, 503);
    });
  } finally {
    restoreEnv('NODE_ENV', previousNodeEnv);
    restoreEnv('TWILIO_VALIDATE_SIGNATURE', previousValidation);
    restoreEnv('TWILIO_AUTH_TOKEN', previousToken);
    restoreEnv('TENANT_ACCOUNTS_JSON', previousTenants);
  }
});
