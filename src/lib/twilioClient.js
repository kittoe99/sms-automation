import twilio from 'twilio';

let client;

export function getTwilioClient() {
  if (client) return client;

  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;

  if (!accountSid || !authToken) {
    throw new Error('TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN are required');
  }

  client = twilio(accountSid, authToken);
  return client;
}

/**
 * Send via Messaging Service when configured (preferred for compliance + pooling).
 * Outbound product features will call this later — not wired to public routes yet.
 */
export async function sendSms({ to, body }) {
  const messagingServiceSid = process.env.TWILIO_MESSAGING_SERVICE_SID;
  const from = process.env.TWILIO_FROM_NUMBER;

  const payload = { to, body };
  if (messagingServiceSid) {
    payload.messagingServiceSid = messagingServiceSid;
  } else if (from) {
    payload.from = from;
  } else {
    throw new Error('Set TWILIO_MESSAGING_SERVICE_SID or TWILIO_FROM_NUMBER');
  }

  return getTwilioClient().messages.create(payload);
}
