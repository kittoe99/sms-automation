import { Router } from 'express';
import twilio from 'twilio';
import { recordInbound, updateDeliverability } from '../lib/messageStore.js';

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

webhooksRouter.post('/inbound', validateTwilio, (req, res) => {
  const from = req.body?.From;
  const to = req.body?.To;
  const body = (req.body?.Body || '').trim();
  const sid = req.body?.MessageSid || req.body?.SmsSid || null;

  console.log('[opek-sms] inbound', { from, to, sid, body });

  if (from) {
    recordInbound({ from, to, body, sid });
  }

  res.type('text/xml').send('<Response></Response>');
});

webhooksRouter.post('/status', validateTwilio, (req, res) => {
  const { MessageSid, MessageStatus, To, ErrorCode } = req.body || {};
  console.log('[opek-sms] status', { MessageSid, MessageStatus, To, ErrorCode });

  updateDeliverability(MessageSid, {
    status: MessageStatus,
    errorCode: ErrorCode || null,
    to: To || null,
  });

  res.sendStatus(204);
});
