import twilio from 'twilio';
import { isOptedOut, recordOutbound } from './messageStore.js';

let client;

export function getTwilioClient() {
  if (client) return client;

  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const apiKey = process.env.TWILIO_API_KEY;
  const apiSecret = process.env.TWILIO_API_SECRET;

  if (apiKey && apiSecret && accountSid) {
    client = twilio(apiKey, apiSecret, { accountSid });
    return client;
  }

  if (!accountSid || !authToken) {
    throw new Error(
      'Set TWILIO_ACCOUNT_SID with TWILIO_AUTH_TOKEN, or TWILIO_API_KEY + TWILIO_API_SECRET'
    );
  }

  client = twilio(accountSid, authToken);
  return client;
}

/**
 * Send via Messaging Service when configured (preferred for compliance + pooling).
 * Records the message so the UI can show deliverability status.
 */
export async function sendSms({
  to,
  body,
  categoryId = null,
  contactName = null,
  statusCallback = null,
  meta = null,
}) {
  if (await isOptedOut(to)) {
    const err = new Error('Contact has opted out of SMS');
    err.code = 'OPTED_OUT';
    await recordOutbound({
      categoryId,
      to,
      body,
      status: 'canceled',
      errorCode: 'OPTED_OUT',
      errorMessage: 'Blocked: contact opted out',
      contactName,
      meta,
    });
    throw err;
  }
  const messagingServiceSid = process.env.TWILIO_MESSAGING_SERVICE_SID;
  const from = process.env.TWILIO_FROM_NUMBER;
  const publicBase = (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '');
  const rawCallback =
    statusCallback ||
    process.env.TWILIO_STATUS_CALLBACK_URL ||
    (publicBase ? `${publicBase}/webhooks/twilio/status` : undefined);
  // Twilio rejects non-public URLs (localhost/http). Skip callback rather than fail the send.
  const callback =
    rawCallback && /^https:\/\//i.test(String(rawCallback)) ? String(rawCallback) : undefined;

  const payload = { to, body };
  if (messagingServiceSid) {
    payload.messagingServiceSid = messagingServiceSid;
  } else if (from) {
    payload.from = from;
  } else {
    throw new Error('Set TWILIO_MESSAGING_SERVICE_SID or TWILIO_FROM_NUMBER');
  }
  if (callback) payload.statusCallback = callback;

  try {
    const msg = await getTwilioClient().messages.create(payload);
    return await recordOutbound({
      categoryId,
      to,
      body,
      sid: msg.sid,
      status: msg.status || 'queued',
      errorCode: msg.errorCode || null,
      errorMessage: msg.errorMessage || null,
      contactName,
      meta,
    });
  } catch (err) {
    await recordOutbound({
      categoryId,
      to,
      body,
      status: 'failed',
      errorCode: err.code || null,
      errorMessage: err.message || String(err),
      contactName,
      meta,
    });
    throw err;
  }
}
