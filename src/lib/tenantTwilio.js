import { defaultTenantFromEnv, getCurrentTenant } from './tenantContext.js';

/** Legacy environment credentials belong exclusively to the default business. */
export function getTenantTwilioConfig(tenant = getCurrentTenant(), env = process.env) {
  const config = tenant?.twilio || {};
  const legacy = tenant?.id === defaultTenantFromEnv(env).id &&
    (!config.accountSid || config.accountSid === env.TWILIO_ACCOUNT_SID);
  const value = (name, envName) => String(config[name] || (legacy ? env[envName] : '') || '').trim();
  return {
    accountSid: value('accountSid', 'TWILIO_ACCOUNT_SID'),
    authToken: value('authToken', 'TWILIO_AUTH_TOKEN'),
    apiKey: value('apiKey', 'TWILIO_API_KEY'),
    apiSecret: value('apiSecret', 'TWILIO_API_SECRET'),
    messagingServiceSid: value('messagingServiceSid', 'TWILIO_MESSAGING_SERVICE_SID'),
    fromNumber: value('fromNumber', 'TWILIO_FROM_NUMBER'),
    statusCallbackUrl: value('statusCallbackUrl', 'TWILIO_STATUS_CALLBACK_URL'),
  };
}
