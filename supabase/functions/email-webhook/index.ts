import { database, env, json } from '../_shared/http.js';
import { verifyResendWebhook } from '../../../src/lib/resendWebhook.js';

const db = database('SMS_AUTOMATION_DATABASE_URL');
const allowed = new Set(['email.sent','email.delivered','email.delivery_delayed',
  'email.bounced','email.complained','email.failed','email.suppressed']);
// Engagement is recorded separately; it never changes consent or suppression.
const engagement = new Set(['email.opened','email.clicked']);
Deno.serve(async request => {
  if (request.method !== 'POST') return json({ error: 'POST required' }, 405);
  let secret = env('RESEND_WEBHOOK_SECRET');
  if (!secret) {
    try { secret = await db.call('email_secret_value', 'resend_webhook'); }
    catch { return json({ error: 'Webhook unavailable' }, 503); }
  }
  if (!secret) return json({ error: 'Webhook unavailable' }, 503);
  const raw = await request.text();
  if (raw.length > 65536 || !await verifyResendWebhook(raw, request.headers, secret)) {
    return json({ error: 'Invalid signature' }, 401);
  }
  try {
    const event = JSON.parse(raw);
    if (engagement.has(event.type)) {
      if (typeof event.data?.email_id === 'string') await db.call('email_record_engagement', request.headers.get('svix-id'),
        event.data.email_id, event.type, typeof event.data?.click?.link === 'string' ? event.data.click.link : null);
      return json({ ok: true });
    }
    if (!allowed.has(event.type)) return json({ ok: true });
    const address = Array.isArray(event.data?.to) ? event.data.to[0] : null;
    await db.call('email_record_provider_event', request.headers.get('svix-id'),
      event.data?.email_id || null, event.type, address);
    return json({ ok: true });
  } catch (error) {
    console.error(JSON.stringify({ event: 'email_webhook_failed', code: error.code || 'WEBHOOK_ERROR' }));
    return json({ error: 'Webhook temporarily unavailable' }, 503);
  }
});
