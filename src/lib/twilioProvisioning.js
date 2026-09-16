import twilio from 'twilio';
import { lookup } from 'node:dns/promises';
import { businessAccountStore, businessError, publicBusiness } from './businessAccounts.js';
import { credentialEncryptionKey, decryptTwilioCredentials, encryptTwilioCredentials } from './credentialVault.js';

export function twilioWebhookUrls(env = process.env) {
  let url;
  try { url = new URL(String(env.PUBLIC_BASE_URL || '')); } catch { throw businessError('A public HTTPS PUBLIC_BASE_URL is required for provisioning', 503); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash ||
      ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
    throw businessError('A public HTTPS PUBLIC_BASE_URL is required for provisioning', 503);
  }
  const base = url.toString().replace(/\/$/, '');
  return { inbound: `${base}/webhooks/twilio/inbound`, status: `${base}/webhooks/twilio/status` };
}

function parentCredentials(env) {
  const sid = String(env.TWILIO_PARENT_ACCOUNT_SID || '').trim();
  const token = String(env.TWILIO_PARENT_AUTH_TOKEN || '').trim();
  if (!/^AC[a-f0-9]{32}$/i.test(sid) || !token) {
    throw businessError('Set dedicated TWILIO_PARENT_ACCOUNT_SID and TWILIO_PARENT_AUTH_TOKEN for platform provisioning', 503);
  }
  return { sid, token };
}

export async function validateWebhookHost(url) {
  const hostname = new URL(url).hostname;
  try { await lookup(hostname); } catch {
    throw businessError('PUBLIC_BASE_URL does not resolve; restore the deployed webhook host before provisioning', 503);
  }
}

function providerErrorCode(error, fallback) {
  return /^\d{3,10}$/.test(String(error.code || '')) ? String(error.code) : fallback;
}

/** Durable checkpoints prevent concurrent requests or retries creating duplicate accounts. */
export async function provisionBusinessTwilio(id, {
  store = businessAccountStore,
  clientFactory = twilio,
  env = process.env,
  validateHost = validateWebhookHost,
} = {}) {
  let row = await store.get(id);
  if (!row) throw businessError('Business not found', 404);
  if (row.twilio_state === 'ready') return publicBusiness(row);
  if (!['not_provisioned', 'subaccount_created'].includes(row.twilio_state)) {
    throw businessError('Provisioning is in progress or needs manual reconciliation; do not create another subaccount', 409);
  }
  // Validate all prerequisites before any billable/provider resource is created.
  const key = credentialEncryptionKey(env);
  const urls = twilioWebhookUrls(env);
  const parent = parentCredentials(env);
  await validateHost(urls.inbound);
  if (row.twilio_state === 'not_provisioned') {
    row = await store.transition(id, 'not_provisioned', { twilio_state: 'subaccount_provisioning', twilio_error_code: null });
    try {
      const account = await clientFactory(parent.sid, parent.token).api.v2010.accounts.create({ friendlyName: `${row.name} [${row.id}]` });
      if (!/^AC[a-f0-9]{32}$/i.test(account.sid) || !account.authToken || account.sid === parent.sid || account.ownerAccountSid !== parent.sid) {
        throw businessError('Twilio did not return usable subaccount credentials', 502);
      }
      row = await store.transition(id, 'subaccount_provisioning', {
        twilio_state: 'subaccount_created',
        twilio_account_sid: account.sid,
        twilio_credentials_encrypted: encryptTwilioCredentials(id, account.sid, { authToken: account.authToken }, key),
      });
    } catch (error) {
      // A timeout can occur AFTER Twilio creates the account. Never retry blindly.
      await store.transition(id, 'subaccount_provisioning', {
        twilio_state: 'subaccount_unknown', twilio_error_code: providerErrorCode(error, 'SUBACCOUNT_RECONCILIATION_REQUIRED'),
      }).catch(() => {});
      throw businessError('Subaccount creation could not be confirmed; reconcile in Twilio before retrying', 502);
    }
  }

  const credentials = decryptTwilioCredentials(id, row.twilio_account_sid, row.twilio_credentials_encrypted, key);
  row = await store.transition(id, 'subaccount_created', { twilio_state: 'service_provisioning', twilio_error_code: null });
  try {
    // Messaging APIs require the subaccount's OWN credentials, not the parent's.
    const client = clientFactory(row.twilio_account_sid, credentials.authToken);
    const service = await client.messaging.v1.services.create({
      friendlyName: `${row.name} — SMS`,
      inboundRequestUrl: urls.inbound,
      inboundMethod: 'POST',
      statusCallback: urls.status,
      useInboundWebhookOnNumber: false,
    });
    if (!/^MG[a-f0-9]{32}$/i.test(service.sid)) throw businessError('Twilio did not return a Messaging Service SID', 502);
    row = await store.transition(id, 'service_provisioning', {
      twilio_state: 'ready', twilio_messaging_service_sid: service.sid,
    });
    // Still pending: no purchased sender, compliance approval, or tenant DB boundary yet.
    return publicBusiness(row);
  } catch (error) {
    await store.transition(id, 'service_provisioning', {
      twilio_state: 'service_unknown', twilio_error_code: providerErrorCode(error, 'SERVICE_RECONCILIATION_REQUIRED'),
    }).catch(() => {});
    throw businessError('Messaging Service creation could not be confirmed; reconcile before retrying', 502);
  }
}

/** Read-only provider reconciliation for ambiguous creation/timeouts; never creates resources. */
export async function reconcileBusinessTwilio(id, input = {}, {
  store = businessAccountStore, clientFactory = twilio, env = process.env,
} = {}) {
  const row = await store.get(id);
  if (!row) throw businessError('Business not found', 404);
  if (!['subaccount_unknown', 'service_unknown'].includes(row.twilio_state)) {
    throw businessError('Only an ambiguous provisioning attempt can be reconciled', 409);
  }
  const accountSid = String(input.accountSid || row.twilio_account_sid || '').trim();
  const serviceSid = String(input.messagingServiceSid || '').trim();
  if (!/^AC[a-f0-9]{32}$/i.test(accountSid) || (serviceSid && !/^MG[a-f0-9]{32}$/i.test(serviceSid))) {
    throw businessError('Valid Twilio account and Messaging Service SIDs are required');
  }
  if (row.twilio_account_sid && row.twilio_account_sid !== accountSid) throw businessError('Cannot replace this business\'s subaccount', 409);
  if (row.twilio_state === 'service_unknown' && !serviceSid) throw businessError('Provide the created Messaging Service SID; do not create another service');
  const key = credentialEncryptionKey(env);
  const urls = twilioWebhookUrls(env);
  const parent = parentCredentials(env);
  const account = await clientFactory(parent.sid, parent.token).api.v2010.accounts(accountSid).fetch();
  if (account.sid === parent.sid || account.ownerAccountSid !== parent.sid ||
      account.status !== 'active' || account.friendlyName !== `${row.name} [${row.id}]` || !account.authToken) {
    throw businessError('Subaccount ownership, business identity, or credentials could not be verified', 409);
  }
  if (serviceSid) {
    const service = await clientFactory(accountSid, account.authToken).messaging.v1.services(serviceSid).fetch();
    if (service.accountSid !== accountSid || service.inboundRequestUrl !== urls.inbound ||
        service.inboundMethod !== 'POST' || service.statusCallback !== urls.status || service.useInboundWebhookOnNumber !== false) {
      throw businessError('Messaging Service ownership or webhook settings do not match this business', 409);
    }
  }
  const updated = await store.transition(id, row.twilio_state, {
    twilio_account_sid: accountSid,
    twilio_credentials_encrypted: encryptTwilioCredentials(id, accountSid, { authToken: account.authToken }, key),
    twilio_messaging_service_sid: serviceSid || null,
    twilio_state: serviceSid ? 'ready' : 'subaccount_created',
    twilio_error_code: null,
  });
  return publicBusiness(updated);
}
