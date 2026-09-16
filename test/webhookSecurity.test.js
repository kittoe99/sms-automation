import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import express from 'express';
import twilio from 'twilio';
import { webhooksRouter } from '../src/routes/webhooks.js';
import { elevenLabsWebhooksRouter } from '../src/routes/elevenLabsWebhooks.js';
import { healthRouter } from '../src/routes/health.js';

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

test('Twilio webhooks fail closed when verification cannot be configured', async () => {
  process.env.TWILIO_VALIDATE_SIGNATURE = 'true';
  delete process.env.TWILIO_AUTH_TOKEN;
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
});

test('Twilio signatures are checked against the configured public URL', async () => {
  const token = 'test_auth_token';
  const publicBase = 'https://hooks.example.test';
  const path = '/webhooks/twilio/status';
  const params = {
    MessageSid: 'SM_test_status_1',
    MessageStatus: 'delivered',
    To: '+17205550123',
  };
  process.env.TWILIO_VALIDATE_SIGNATURE = 'true';
  process.env.TWILIO_AUTH_TOKEN = token;
  process.env.PUBLIC_BASE_URL = publicBase;
  const signature = twilio.getExpectedTwilioSignature(token, `${publicBase}${path}`, params);
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.use('/webhooks/twilio', webhooksRouter);

  await withServer(app, async (base) => {
    const response = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'X-Twilio-Signature': signature,
      },
      body: new URLSearchParams(params),
    });
    assert.equal(response.status, 204);
  });
});

test('ElevenLabs webhooks fail closed without an HMAC secret', async () => {
  delete process.env.ELEVENLABS_WEBHOOK_SECRET;
  const app = express();
  app.use(express.json());
  app.use('/webhooks/elevenlabs', elevenLabsWebhooksRouter);

  await withServer(app, async (base) => {
    const response = await fetch(`${base}/webhooks/elevenlabs/post-call`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    assert.equal(response.status, 503);
  });
});

test('production health is unhealthy when required configuration is absent', async () => {
  process.env.NODE_ENV = 'production';
  for (const key of [
    'TWILIO_ACCOUNT_SID',
    'TWILIO_AUTH_TOKEN',
    'TWILIO_MESSAGING_SERVICE_SID',
    'TWILIO_FROM_NUMBER',
    'SUPABASE_URL',
    'SUPABASE_SERVICE_ROLE_KEY',
    'CLERK_PUBLISHABLE_KEY',
    'NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY',
    'CLERK_SECRET_KEY',
    'OPEK_SMS_API_KEY',
  ]) {
    delete process.env[key];
  }
  const app = express();
  app.use(healthRouter);

  await withServer(app, async (base) => {
    const response = await fetch(`${base}/health`);
    const body = await response.json();
    assert.equal(response.status, 503);
    assert.equal(body.ok, false);
    assert.ok(body.missingConfiguration.includes('TWILIO_AUTH_TOKEN'));
    assert.ok(body.missingConfiguration.includes('CLERK_PUBLISHABLE_KEY'));
    assert.ok(body.missingConfiguration.includes('CLERK_SECRET_KEY'));
  });
});
