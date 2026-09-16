import { getSupabaseAdmin, isSupabaseConfigured } from '../supabase.js';
import { publish } from '../realtime.js';
import { QUOTE_REQUESTS_CATEGORY_ID } from './quoteRequestsSequence.js';

const DAY = 24 * 60 * 60 * 1000;
const OPT_OUT_KEYWORDS = new Set(['stop', 'stopall', 'unsubscribe', 'cancel', 'end', 'quit']);
const OPT_IN_KEYWORDS = new Set(['start', 'unstop', 'yes']);

export function classifyInboundAutomationTrigger(body) {
  const first = String(body || '')
    .trim()
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .trim()
    .split(/\s+/)[0];
  if (!first) return 'none';
  if (OPT_OUT_KEYWORDS.has(first)) return 'opt_out';
  if (OPT_IN_KEYWORDS.has(first)) return 'opt_in';
  return 'customer_reply';
}

export function snoozeQuoteDripMetadata(enrollment, now = new Date()) {
  const metadata =
    enrollment?.metadata && typeof enrollment.metadata === 'object'
      ? { ...enrollment.metadata }
      : {};
  const drip = metadata.drip && typeof metadata.drip === 'object' ? { ...metadata.drip } : {};
  const replyFloor = new Date(now.getTime() + DAY);
  const current = new Date(drip.nextSendAt || 0);
  const next = Number.isNaN(current.getTime()) || current < replyFloor ? replyFloor : current;
  return {
    ...metadata,
    drip: {
      ...drip,
      status: 'active',
      pauseReason: null,
      nextSendAt: next.toISOString(),
      lastCustomerReplyAt: now.toISOString(),
    },
  };
}

export async function handleInboundAutomationTrigger({ phone, body, now = new Date() }) {
  const trigger = classifyInboundAutomationTrigger(body);
  if (!isSupabaseConfigured() || trigger === 'none' || trigger === 'opt_in') {
    return { trigger, updated: 0 };
  }
  if (trigger === 'opt_out') {
    const updated = await removeActiveEnrollmentsForPhone(phone, {
      reason: 'sms_opt_out',
      source: 'inbound',
      now,
    });
    return { trigger, updated };
  }

  const updated = await snoozeQuoteRequestDripsForPhone(phone, { now });
  return { trigger, updated };
}

export async function snoozeQuoteRequestDripsForPhone(phone, { now = new Date() } = {}) {
  const rows = await findActiveEnrollments(phone, QUOTE_REQUESTS_CATEGORY_ID);
  let updated = 0;
  for (const enrollment of rows) {
    const metadata = snoozeQuoteDripMetadata(enrollment, now);
    const saved = await updateEnrollment(enrollment.id, metadata, now);
    if (saved) updated += 1;
  }
  return updated;
}

export async function removeActiveEnrollmentsForPhone(
  phone,
  {
    categoryId = null,
    reason = 'lifecycle_transition',
    source = 'system',
    bookingId = null,
    now = new Date(),
  } = {}
) {
  if (!isSupabaseConfigured()) return 0;
  const rows = await findActiveEnrollments(phone, categoryId);
  let updated = 0;
  for (const enrollment of rows) {
    const metadata = {
      ...(enrollment.metadata || {}),
      removedReason: reason,
      removedBySource: source,
      ...(bookingId ? { removedByBookingId: bookingId } : {}),
      drip: {
        ...(enrollment.metadata?.drip || {}),
        status: 'completed',
        nextSendAt: null,
        pauseReason: null,
      },
    };
    const { data, error } = await getSupabaseAdmin()
      .from('sms_automation_enrollments')
      .update({ status: 'removed', metadata, updated_at: now.toISOString() })
      .eq('id', enrollment.id)
      .eq('status', 'enrolled')
      .select()
      .maybeSingle();
    if (error) throw error;
    if (data) {
      updated += 1;
      publish('enrollment', { event: 'update', record: data });
    }
  }
  return updated;
}

async function findActiveEnrollments(phone, categoryId = null) {
  if (!isSupabaseConfigured()) return [];
  const digits = normalizeDigits(phone);
  if (!digits) return [];
  const phoneSuffix = digits.length >= 10 ? digits.slice(-10) : digits;
  let query = getSupabaseAdmin()
    .from('sms_automation_enrollments')
    .select('*')
    .like('phone_digits', `%${phoneSuffix}`)
    .eq('status', 'enrolled');
  if (categoryId) query = query.eq('category_id', categoryId);
  const { data, error } = await query;
  if (error) throw error;
  return data || [];
}

async function updateEnrollment(id, metadata, now) {
  const { data, error } = await getSupabaseAdmin()
    .from('sms_automation_enrollments')
    .update({ metadata, updated_at: now.toISOString() })
    .eq('id', id)
    .eq('status', 'enrolled')
    .select()
    .maybeSingle();
  if (error) throw error;
  if (data) publish('enrollment', { event: 'update', record: data });
  return data;
}

function normalizeDigits(value) {
  return String(value || '').replace(/\D/g, '') || '';
}
