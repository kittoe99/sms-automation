import 'dotenv/config';
import { isDatabaseDisconnected } from './lib/dataMode.js';
import { loadLocalBusinesses } from './lib/localBusinesses.js';
import http from 'node:http';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import twilio from 'twilio';
import { clerkMiddleware } from '@clerk/express';
import { healthRouter } from './routes/health.js';
import { webhooksRouter } from './routes/webhooks.js';
import { elevenLabsWebhooksRouter } from './routes/elevenLabsWebhooks.js';
import { apiRouter } from './routes/api.js';
import { attachRealtime } from './lib/realtime.js';
import { securityHeaders } from './lib/security.js';
import { businessRegistryMiddleware } from './lib/businessAccounts.js';
import { platformRouter } from './routes/platform.js';
import {
  getClerkAuthorizedParties,
  getClerkPublishableKey,
  getClerkSecretKey,
  isCrmAuthConfigured,
  isLocalAuthDisabled,
} from './lib/crmAuth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, '..', 'public');
const app = express();
const port = Number(process.env.PORT || 8080);
if (process.env.NODE_ENV === 'production') {
  throw new Error('Production uses Supabase Edge APIs and bounded Edge workers. This server is a local preview only.');
}
await loadLocalBusinesses();

app.disable('x-powered-by');
app.set('trust proxy', 1);
if (isCrmAuthConfigured() && !isLocalAuthDisabled()) {
  app.use(
    clerkMiddleware({
      publishableKey: getClerkPublishableKey(),
      secretKey: getClerkSecretKey(),
      authorizedParties: getClerkAuthorizedParties(),
    })
  );
}
app.use(securityHeaders);
app.use(express.urlencoded({ extended: false, limit: '64kb', parameterLimit: 100 }));
app.use(
  express.json({
    limit: '256kb',
    verify: (req, _res, buf) => {
      if (req.originalUrl?.startsWith('/webhooks/elevenlabs')) {
        req.rawBody = buf.toString('utf8');
      }
    },
  })
);

app.use(healthRouter);
app.use('/webhooks', (_req, res, next) => {
  if (isDatabaseDisconnected()) return res.status(503).json({ error: 'Database disconnected' });
  next();
});
app.use('/api', businessRegistryMiddleware);
app.use('/webhooks', businessRegistryMiddleware);
app.use('/api/platform', platformRouter);
app.use('/api', apiRouter);
app.use('/webhooks/twilio', webhooksRouter);
app.use('/webhooks/elevenlabs', elevenLabsWebhooksRouter);
app.use(express.static(publicDir, { dotfiles: 'deny', index: false }));

app.get('*', (req, res, next) => {
  if (
    req.path.startsWith('/api') ||
    req.path.startsWith('/webhooks') ||
    req.path === '/health' ||
    req.path === '/ws'
  ) {
    return next();
  }
  res.sendFile(path.join(publicDir, 'index.html'));
});

app.use((err, _req, res, _next) => {
  const status = Number(err?.status);
  console.error('[opek-sms] request failed', {
    status: Number.isInteger(status) ? status : 500,
    type: String(err?.type || 'internal_error'),
    message: String(err?.message || 'Internal Server Error'),
  });
  if (status === 413) return res.status(413).type('text/plain').send('Payload Too Large');
  if (status === 400 && err?.type === 'entity.parse.failed') {
    return res.status(400).type('text/plain').send('Invalid JSON');
  }
  return res.status(500).type('text/plain').send('Internal Server Error');
});

const server = http.createServer(app);
server.headersTimeout = 15_000;
server.requestTimeout = 60_000;
server.keepAliveTimeout = 5_000;
server.maxHeadersCount = 100;
attachRealtime(server);

server.listen(port, isLocalAuthDisabled() ? '127.0.0.1' : undefined, () => {
  console.log(`[opek-sms] listening on :${port}`);
  console.log(`[opek-sms] UI http://localhost:${port}/`);
  console.log(`[opek-sms] messaging service: ${process.env.TWILIO_MESSAGING_SERVICE_SID || '(not set)'}`);
  console.log(`[opek-sms] supabase: ${process.env.SUPABASE_URL ? 'configured' : '(not set)'}`);
  console.log(`[opek-sms] clerk auth: ${isCrmAuthConfigured() ? 'configured' : '(not set)'}`);
});

export { app, server, twilio };

