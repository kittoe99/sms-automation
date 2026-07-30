import dotenv from 'dotenv';
dotenv.config({ override: true });
import http from 'node:http';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import twilio from 'twilio';
import { healthRouter } from './routes/health.js';
import { webhooksRouter } from './routes/webhooks.js';
import { apiRouter } from './routes/api.js';
import { attachRealtime } from './lib/realtime.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, '..', 'public');

const app = express();
const port = Number(process.env.PORT || 8080);

app.use(express.urlencoded({ extended: false }));
app.use(express.json());

app.use(healthRouter);
app.use('/api', apiRouter);
app.use('/webhooks/twilio', webhooksRouter);
app.use(express.static(publicDir));

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
  console.error('[opek-sms]', err);
  res.status(500).type('text/plain').send('Internal Server Error');
});

const server = http.createServer(app);
attachRealtime(server);

server.listen(port, () => {
  console.log(`[opek-sms] listening on :${port}`);
  console.log(`[opek-sms] UI http://localhost:${port}/`);
  console.log(`[opek-sms] messaging service: ${process.env.TWILIO_MESSAGING_SERVICE_SID || '(not set)'}`);
  console.log(`[opek-sms] supabase: ${process.env.SUPABASE_URL ? 'configured' : '(not set)'}`);
});

export { app, server, twilio };
