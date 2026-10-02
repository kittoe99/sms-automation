import twilio from 'twilio';
import { getTenantTwilioConfig } from './tenantTwilio.js';

const clients = new Map();

export function getTwilioClient() {
  const { accountSid, authToken, apiKey, apiSecret } = getTenantTwilioConfig();
  const key = JSON.stringify([accountSid, authToken, apiKey, apiSecret]);
  if (clients.has(key)) return clients.get(key);

  if (apiKey && apiSecret && accountSid) {
    const client = twilio(apiKey, apiSecret, { accountSid });
    if (clients.size >= 100) clients.clear();
    clients.set(key, client);
    return client;
  }

  if (!accountSid || !authToken) {
    throw new Error(
      'Set TWILIO_ACCOUNT_SID with TWILIO_AUTH_TOKEN, or TWILIO_API_KEY + TWILIO_API_SECRET'
    );
  }

  const client = twilio(accountSid, authToken);
  if (clients.size >= 100) clients.clear();
  clients.set(key, client);
  return client;
}

/** Legacy HTTP paths are retired; the CRM Edge API creates durable SMS jobs. */
export async function sendSms() {
  throw Object.assign(new Error('Use the queued CRM send API; SMS submission is worker-only'), { status: 410, code: 'WORKER_REQUIRED' });
}
