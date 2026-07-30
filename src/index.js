import express from 'express';
import twilio from 'twilio';
import { healthRouter } from './routes/health.js';
import { webhooksRouter } from './routes/webhooks.js';

const app = express();
const port = Number(process.env.PORT || 8080);

// Twilio posts application/x-www-form-urlencoded
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

app.use(healthRouter);
app.use('/webhooks/twilio', webhooksRouter);

app.use((err, _req, res, _next) => {
  console.error('[opek-sms]', err);
  res.status(500).type('text/plain').send('Internal Server Error');
});

app.listen(port, () => {
  console.log(`[opek-sms] listening on :${port}`);
  console.log(`[opek-sms] messaging service: ${process.env.TWILIO_MESSAGING_SERVICE_SID || '(not set)'}`);
});

export { app, twilio };
