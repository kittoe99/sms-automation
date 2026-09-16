import { Router } from 'express';
import twilio from 'twilio';
import { recordInbound, updateDeliverability } from '../lib/messageStore.js';
import { processInboundAiJob } from '../lib/ai/inboundJobs.js';
import { handleInboundAutomationTrigger } from '../lib/automations/lifecycle.js';
import {
  requireTenantDataIsolation,
  resolveTenantForPhone,
  resolveTenantForTwilioAccount,
  listTenants,
  runWithTenant,
} from '../lib/tenantContext.js';
import { redactPhone } from '../lib/security.js';
import { getTenantTwilioConfig } from '../lib/tenantTwilio.js';

export const webhooksRouter = Router();
webhooksRouter.use(requireTenantDataIsolation);

webhooksRouter.use((req, res, next) => {
  const accountSid = req.body?.AccountSid;
  const tenant = accountSid
    ? resolveTenantForTwilioAccount(accountSid)
    : listTenants().length === 1
      ? resolveTenantForPhone(req.body?.To || req.body?.From)
      : null;
  if (!tenant) return res.status(403).type('text/plain').send('Unknown Twilio business account');
  req.tenant = tenant;
  return runWithTenant(tenant, next);
});

function validateTwilio(req, res, next) {
  const shouldValidate =
    process.env.NODE_ENV === 'production' || listTenants().length > 1 || process.env.TWILIO_VALIDATE_SIGNATURE !== 'false';
  if (!shouldValidate) return next();

  const authToken = getTenantTwilioConfig(req.tenant).authToken;
  if (!authToken) {
    console.error('[opek-sms] TWILIO_AUTH_TOKEN missing; rejecting webhook');
    return res.status(503).type('text/plain').send('Webhook verification unavailable');
  }

  const signature = req.get('X-Twilio-Signature') || '';
  const publicBase = String(process.env.PUBLIC_BASE_URL || '')
    .trim()
    .replace(/\/$/, '');
  if (process.env.NODE_ENV === 'production' && !publicBase) {
    console.error('[opek-sms] PUBLIC_BASE_URL missing; rejecting Twilio webhook');
    return res.status(503).type('text/plain').send('Webhook verification unavailable');
  }
  const url = publicBase
    ? `${publicBase}${req.originalUrl}`
    : `${req.protocol}://${req.get('host')}${req.originalUrl}`;
  const valid = twilio.validateRequest(authToken, signature, url, req.body || {});

  if (!valid) {
    console.warn('[opek-sms] invalid Twilio signature', { url });
    return res.status(403).type('text/plain').send('Forbidden');
  }

  return next();
}

webhooksRouter.post('/inbound', validateTwilio, async (req, res) => {
  const from = req.body?.From;
  const to = req.body?.To;
  const body = (req.body?.Body || '').trim();
  const sid = req.body?.MessageSid || req.body?.SmsSid || null;

  console.log('[opek-sms] inbound', {
    from: redactPhone(from),
    to: redactPhone(to),
    sid,
    bodyLength: body.length,
  });

  let message = null;
  try {
    if (from) {
      message = await recordInbound({ from, to, body, sid });
      await handleInboundAutomationTrigger({ phone: from, body });
    }
  } catch (err) {
    console.error('[opek-sms] inbound persistence/lifecycle failed', err);
    return res.status(500).type('text/plain').send('Temporary inbound processing failure');
  }

  // Fast ACK — AI runs in background so Twilio does not time out
  res.type('text/xml').send('<Response></Response>');

  if (from && message?.id) {
    setImmediate(() => {
      processInboundAiJob(message.id)
        .then((result) => {
          if (result?.skipped) {
            console.log('[opek-sms] AI skipped', {
              from: redactPhone(from),
              reason: result.reason,
            });
          } else if (result?.message) {
            console.log('[opek-sms] AI replied', {
              from: redactPhone(from),
              sid: result.message.sid,
              tools: result.toolsUsed?.map((t) => t.name),
            });
          }
        })
        .catch((err) => {
          console.error('[opek-sms] AI background failed', err);
        });
    });
  }
});

webhooksRouter.post('/status', validateTwilio, async (req, res) => {
  const { MessageSid, MessageStatus, To, ErrorCode } = req.body || {};
  console.log('[opek-sms] status', {
    MessageSid,
    MessageStatus,
    To: redactPhone(To),
    ErrorCode,
  });

  try {
    await updateDeliverability(MessageSid, {
      status: MessageStatus,
      errorCode: ErrorCode || null,
      to: To || null,
    });
  } catch (err) {
    console.error('[opek-sms] status persist failed', err);
  }

  res.sendStatus(204);
});
