import { Router } from 'express';
import twilio from 'twilio';

export const webhooksRouter = Router();

function validateTwilio(req, res, next) {
  const shouldValidate = process.env.TWILIO_VALIDATE_SIGNATURE !== 'false';
  if (!shouldValidate) return next();

  const authToken = process.env.TWILIO_AUTH_TOKEN;
  if (!authToken) {
    console.warn('[opek-sms] TWILIO_AUTH_TOKEN missing; skipping signature check');
    return next();
  }

  const signature = req.get('X-Twilio-Signature') || '';
  const url = `${req.protocol}://${req.get('host')}${req.originalUrl}`;
  const valid = twilio.validateRequest(authToken, signature, url, req.body || {});

  if (!valid) {
    console.warn('[opek-sms] invalid Twilio signature', { url });
    return res.status(403).type('text/plain').send('Forbidden');
  }

  return next();
}

/**
 * Inbound SMS webhook.
 * Foundation stub: acknowledge STOP/HELP with empty TwiML (Twilio Advanced Opt-Out
 * can also handle keywords at the Messaging Service layer).
 * Feature wiring (automation, marketing replies) comes next.
 */
webhooksRouter.post('/inbound', validateTwilio, (req, res) => {
  const from = req.body?.From;
  const body = (req.body?.Body || '').trim();
  console.log('[opek-sms] inbound', { from, body });

  res.type('text/xml').send('<Response></Response>');
});

/**
 * Delivery status callback.
 * Foundation stub: log only. Persistence / retries come later.
 */
webhooksRouter.post('/status', validateTwilio, (req, res) => {
  const { MessageSid, MessageStatus, To, ErrorCode } = req.body || {};
  console.log('[opek-sms] status', { MessageSid, MessageStatus, To, ErrorCode });
  res.sendStatus(204);
});
