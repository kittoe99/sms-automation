import { env } from '../_shared/http.js';

export async function emailOverview(db, user, tenant) {
  const data = await db.call('email_overview', user, tenant);
  const providerReady = await db.call('email_provider_ready', user, tenant);
  return { ...data, providerReady: Boolean(providerReady && env('OPENAI_API_KEY')) };
}

export async function saveEmailGroup(db, user, tenant, groupId, input) {
  if (input?.enabled && (!env('OPENAI_API_KEY') || !await db.call('email_provider_ready', user, tenant))) {
    throw Object.assign(new Error('Configure Resend and OpenAI before activating email'), { status: 409 });
  }
  return db.call('email_save_group', user, tenant, groupId, input);
}
