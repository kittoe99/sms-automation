import { getSupabaseAdmin, isSupabaseConfigured } from './supabase.js';
import { isOptedOut } from './messageStore.js';
import { sendSms } from './twilioClient.js';
import { publish } from './realtime.js';
import { seedDripOnEnrollment, needsQuoteRequestDripSeed } from './automations/dripState.js';
import {
  needsAppointmentDripSeed,
  seedAppointmentDripOnEnrollment,
} from './automations/appointmentDripState.js';
import {
  computeReminderSendAt,
  initialAppointmentDripMetadata,
} from './automations/appointmentRemindersSequence.js';
import { removeActiveEnrollmentsForPhone } from './automations/lifecycle.js';
import { getBusinessTimeZone } from './automations/timeRules.js';
import {
  computeCustomNextSendAt,
  getAutomationGroup,
  seedCustomDrip,
} from './automations/customAutomations.js';

export async function listDirectoryContacts({
  q = null,
  source = null,
  consentedOnly = false,
  page = 1,
  pageSize = 50,
} = {}) {
  if (!isSupabaseConfigured()) {
    return {
      configured: false,
      contacts: [],
      page: 1,
      pageSize: Number(pageSize) || 50,
      total: 0,
      totalPages: 1,
      error: 'Supabase is not configured. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.',
    };
  }

  const size = Math.min(Math.max(Number(pageSize) || 50, 1), 250);
  const p = Math.max(Number(page) || 1, 1);
  const offset = (p - 1) * size;

  // Fetch a wider window when filtering consented-only client-side
  const fetchLimit = consentedOnly ? Math.min(size * 5, 500) : size;
  const fetchOffset = consentedOnly ? 0 : offset;

  const { data, error } = await getSupabaseAdmin().rpc('sms_crm_list_contacts', {
    p_search: q || null,
    p_source: source || null,
    p_limit: fetchLimit,
    p_offset: fetchOffset,
  });

  if (error) throw error;

  let contacts = (data || []).map(normalizeDirectoryContact);
  if (consentedOnly) {
    contacts = contacts.filter((c) => c.smsMarketingConsent === true);
    const total = contacts.length;
    contacts = contacts.slice(offset, offset + size);
    return {
      configured: true,
      contacts,
      page: p,
      pageSize: size,
      total,
      totalPages: Math.max(1, Math.ceil(total / size)),
      consentedOnly: true,
    };
  }

  return {
    configured: true,
    contacts,
    page: p,
    pageSize: size,
    total:
      contacts.length < size && p === 1
        ? contacts.length
        : offset + contacts.length + (contacts.length === size ? 1 : 0),
    totalPages: contacts.length < size ? p : p + 1,
  };
}

function phonesMatch(a, b) {
  const left = normalizeDigits(a);
  const right = normalizeDigits(b);
  if (!left || !right) return false;
  if (left === right) return true;
  const left10 = left.slice(-10);
  const right10 = right.slice(-10);
  return left10.length === 10 && right10.length === 10 && left10 === right10;
}

export async function findDirectoryContact(phone) {
  const needle = normalizeDigits(phone);
  if (!needle) return null;

  const search = needle.length >= 10 ? needle.slice(-10) : phone;
  const { data, error } = await getSupabaseAdmin().rpc('sms_crm_list_contacts', {
    p_search: search,
    p_source: null,
    p_limit: 25,
    p_offset: 0,
  });
  if (error) throw error;

  const rows = (data || []).map(normalizeDirectoryContact);
  return rows.find((c) => phonesMatch(c.phoneDigits || c.phone, needle)) || null;
}

export async function enrollContactInAutomation({
  phone,
  categoryId,
  name = null,
  email = null,
  source = null,
  bookingId = null,
  appointmentDate = null,
  preferredTime = null,
  serviceType = null,
  serviceAddress = null,
}) {
  if (!isSupabaseConfigured()) {
    throw new Error('Supabase is not configured');
  }
  const category = await getAutomationGroup(categoryId);
  if (!category) {
    throw new Error(`Unknown automation group: ${categoryId}`);
  }
  if (category.activeAutomation === false) {
    throw new Error(`No active automation is configured for ${category.name}`);
  }
  if (
    categoryId === 'appointment-reminders' &&
    !computeReminderSendAt(appointmentDate, new Date(), preferredTime)
  ) {
    throw new Error('A valid appointmentDate is required in YYYY-MM-DD format');
  }
  if (await isOptedOut(phone)) {
    throw new Error('Contact has opted out of SMS (STOP)');
  }

  const contact = await findDirectoryContact(phone);
  if (!contact) {
    throw new Error('Contact not found in Supabase directory');
  }
  // Appointment reminders are transactional; other drips require marketing consent.
  if (categoryId !== 'appointment-reminders' && contact.smsMarketingConsent !== true) {
    throw new Error('Contact has not consented to SMS marketing');
  }

  const { data, error } = await getSupabaseAdmin().rpc('sms_crm_enroll_contact', {
    p_phone: contact.phone || phone,
    p_category_id: categoryId,
    p_name: name || contact.name,
    p_email: email || contact.email,
    p_source: source || contact.primarySource,
    p_record_id: bookingId || null,
  });

  if (error) throw error;

  let enrollment = data;
  if (categoryId === 'quote-requests' && enrollment?.id) {
    enrollment = await ensureQuoteRequestDripSeeded(enrollment);
  }
  if (categoryId === 'appointment-reminders' && enrollment?.id) {
    enrollment = await ensureAppointmentReminderDripSeeded(enrollment, {
      preferredDate: appointmentDate,
      preferredTime,
      serviceType,
      serviceAddress,
      bookingId,
    });
  }
  if (category.custom && enrollment?.id) {
    enrollment = await ensureCustomDripSeeded(enrollment, category);
  }

  publish('enrollment', { event: 'insert', record: enrollment });
  return enrollment;
}

export async function removeEnrollment({ phone, categoryId, enrollmentId = null }) {
  if (!isSupabaseConfigured()) {
    throw new Error('Supabase is not configured');
  }

  const admin = getSupabaseAdmin();
  const now = new Date().toISOString();

  if (enrollmentId) {
    const { data, error } = await admin
      .from('sms_automation_enrollments')
      .update({ status: 'removed', updated_at: now })
      .eq('id', enrollmentId)
      .eq('status', 'enrolled')
      .select()
      .maybeSingle();
    if (error) throw error;
    if (!data) throw new Error('Enrollment not found');
    publish('enrollment', { event: 'update', record: data });
    return data;
  }

  if (!(await getAutomationGroup(categoryId))) {
    throw new Error(`Unknown automation group: ${categoryId}`);
  }

  const digits = normalizeDigits(phone);
  if (!digits) throw new Error('phone is required');

  const { data, error } = await admin
    .from('sms_automation_enrollments')
    .update({ status: 'removed', updated_at: now })
    .eq('phone_digits', digits)
    .eq('category_id', categoryId)
    .eq('status', 'enrolled')
    .select()
    .maybeSingle();

  if (error) throw error;
  if (!data) throw new Error('Enrollment not found');
  publish('enrollment', { event: 'update', record: data });
  return data;
}

/**
 * Move a customer from quote nurture into the correct booking reminder state.
 * This is shared by the SMS agent and server-to-server booking event endpoint.
 */
export async function syncBookingAutomations({
  phone,
  bookingId = null,
  status = 'new',
  appointmentDate = null,
  preferredTime = null,
  serviceType = null,
  serviceAddress = null,
  name = null,
  email = null,
  source = 'booking',
  now = new Date(),
}) {
  if (!isSupabaseConfigured()) throw new Error('Supabase is not configured');
  if (!normalizeDigits(phone)) throw new Error('phone is required');

  const normalizedStatus = String(status || 'new').trim().toLowerCase();
  const quoteRemoved = await removeActiveEnrollmentsForPhone(phone, {
    categoryId: 'quote-requests',
    reason: normalizedStatus === 'cancelled' ? 'booking_cancelled' : 'booking_created',
    source,
    bookingId,
    now,
  });

  if (normalizedStatus === 'cancelled') {
    const remindersRemoved = await removeActiveEnrollmentsForPhone(phone, {
      categoryId: 'appointment-reminders',
      reason: 'booking_cancelled',
      source,
      bookingId,
      now,
    });
    return { quoteRemoved, remindersRemoved, reminder: null };
  }

  if (!computeReminderSendAt(appointmentDate, now, preferredTime)) {
    return { quoteRemoved, remindersRemoved: 0, reminder: null };
  }

  let enrollment = await enrollContactInAutomation({
    phone,
    categoryId: 'appointment-reminders',
    name,
    email,
    source,
    bookingId,
    appointmentDate,
    preferredTime,
    serviceType,
    serviceAddress,
  });

  const metadata = {
    ...(enrollment.metadata || {}),
    ...initialAppointmentDripMetadata({
      preferredDate: appointmentDate,
      preferredTime,
      serviceType,
      serviceAddress,
      bookingId,
      now,
    }),
  };
  const { data, error } = await getSupabaseAdmin()
    .from('sms_automation_enrollments')
    .update({ metadata, updated_at: now.toISOString() })
    .eq('id', enrollment.id)
    .eq('status', 'enrolled')
    .select()
    .maybeSingle();
  if (error) throw error;
  enrollment = data || enrollment;
  if (data) publish('enrollment', { event: 'update', record: data });

  return { quoteRemoved, remindersRemoved: 0, reminder: enrollment };
}

export async function listEnrollments({ categoryId = null, page = 1, pageSize = 50 } = {}) {
  if (!isSupabaseConfigured()) {
    return { configured: false, enrollments: [], total: 0 };
  }

  const size = Math.min(Math.max(Number(pageSize) || 50, 1), 250);
  const p = Math.max(Number(page) || 1, 1);
  const from = (p - 1) * size;
  const to = from + size - 1;

  let query = getSupabaseAdmin()
    .from('sms_automation_enrollments')
    .select('*', { count: 'exact' })
    .eq('status', 'enrolled')
    .order('enrolled_at', { ascending: false })
    .range(from, to);

  if (categoryId) query = query.eq('category_id', categoryId);

  const { data, error, count } = await query;
  if (error) throw error;

  return {
    configured: true,
    enrollments: data || [],
    page: p,
    pageSize: size,
    total: count || 0,
    totalPages: Math.max(1, Math.ceil((count || 0) / size)),
  };
}

/** Apply custom rule edits to the next unsent step without replaying prior sends. */
export async function rescheduleCustomAutomationEnrollments(group, now = new Date()) {
  if (!isSupabaseConfigured() || !group?.custom) return { updated: 0, completed: 0 };
  const admin = getSupabaseAdmin();
  const { data: rows, error } = await admin
    .from('sms_automation_enrollments')
    .select('*')
    .eq('category_id', group.id)
    .eq('status', 'enrolled')
    .limit(1000);
  if (error) throw error;

  const summary = { updated: 0, completed: 0 };
  const timeZone = getBusinessTimeZone();
  for (const enrollment of rows || []) {
    const drip = enrollment.metadata?.drip || {};
    const stepIndex = Number(drip.stepIndex) || 0;
    if (stepIndex >= group.rule.repeatCount) {
      const { data, error: updateError } = await admin
        .from('sms_automation_enrollments')
        .update({ status: 'removed', updated_at: now.toISOString() })
        .eq('id', enrollment.id)
        .eq('status', 'enrolled')
        .select()
        .maybeSingle();
      if (updateError) throw updateError;
      if (data) {
        summary.completed += 1;
        publish('enrollment', { event: 'update', record: data });
      }
      continue;
    }

    const metadata =
      stepIndex === 0 && !drip.lastSentAt
        ? seedCustomDrip(enrollment, group, now)
        : {
            ...(enrollment.metadata || {}),
            drip: {
              ...drip,
              ruleVersion: group.updatedAt,
              status: 'active',
              nextSendAt:
                computeCustomNextSendAt(
                  group.rule,
                  drip.lastSentAt || now,
                  timeZone,
                  stepIndex
                )?.toISOString() || null,
            },
          };
    const { data, error: updateError } = await admin
      .from('sms_automation_enrollments')
      .update({ metadata, updated_at: now.toISOString() })
      .eq('id', enrollment.id)
      .eq('status', 'enrolled')
      .select()
      .maybeSingle();
    if (updateError) throw updateError;
    if (data) {
      summary.updated += 1;
      publish('enrollment', { event: 'update', record: data });
    }
  }
  return summary;
}

function normalizeDirectoryContact(row) {
  const enrollments = row.enrollments || [];
  return {
    phone: row.phone,
    phoneDigits: row.phone_digits,
    name: row.name,
    email: row.email,
    sources: row.sources || [],
    primarySource: row.primary_source,
    smsMarketingConsent: row.sms_marketing_consent,
    canEnroll: row.sms_marketing_consent === true,
    latestAt: row.latest_at,
    recordCount: Number(row.record_count || 0),
    enrollments: Array.isArray(enrollments) ? enrollments : [],
  };
}

function normalizeDigits(value) {
  return String(value || '').replace(/\D/g, '') || '';
}

/** Normalize US-centric numbers to E.164 for Twilio. */
export function toE164(phone) {
  const digits = normalizeDigits(phone);
  if (!digits) return '';
  if (String(phone).trim().startsWith('+') && digits.length >= 10 && digits.length <= 15) {
    return `+${digits}`;
  }
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return '';
}

export async function sendCustomContactMessage({
  phone,
  body,
  categoryId = null,
  name = null,
}) {
  const text = String(body || '').trim();
  if (!text) throw new Error('Message body is required');
  if (text.length > 1600) throw new Error('Message is too long (max 1600 characters)');

  if (categoryId && !(await getAutomationGroup(categoryId))) {
    throw new Error(`Unknown automation group: ${categoryId}`);
  }
  if (await isOptedOut(phone)) {
    throw new Error('Contact has opted out of SMS (STOP)');
  }

  const contact = await findDirectoryContact(phone);
  if (!contact) {
    throw new Error('Contact not found in Supabase directory');
  }
  if (contact.smsMarketingConsent !== true) {
    throw new Error('Contact has not consented to SMS marketing');
  }

  const to = toE164(contact.phone || phone);
  if (!to || to.length < 11) throw new Error('Invalid phone number');

  const message = await sendSms({
    to,
    body: text,
    categoryId: categoryId || null,
    contactName: name || contact.name || null,
  });

  return { message, contact, to };
}

async function ensureQuoteRequestDripSeeded(enrollment) {
  if (!needsQuoteRequestDripSeed(enrollment)) return enrollment;
  const metadata = seedDripOnEnrollment(enrollment);
  const { data, error } = await getSupabaseAdmin()
    .from('sms_automation_enrollments')
    .update({ metadata, updated_at: new Date().toISOString() })
    .eq('id', enrollment.id)
    .eq('status', 'enrolled')
    .select()
    .maybeSingle();
  if (error) {
    console.warn('[opek-sms] drip seed on enroll failed', error.message);
    return enrollment;
  }
  return data || enrollment;
}

async function ensureAppointmentReminderDripSeeded(enrollment, extras = {}) {
  if (!needsAppointmentDripSeed(enrollment)) return enrollment;
  const metadata = seedAppointmentDripOnEnrollment(enrollment, extras);
  const { data, error } = await getSupabaseAdmin()
    .from('sms_automation_enrollments')
    .update({ metadata, updated_at: new Date().toISOString() })
    .eq('id', enrollment.id)
    .eq('status', 'enrolled')
    .select()
    .maybeSingle();
  if (error) {
    console.warn('[opek-sms] appointment drip seed on enroll failed', error.message);
    return enrollment;
  }
  return data || enrollment;
}

async function ensureCustomDripSeeded(enrollment, group) {
  const metadata = seedCustomDrip(enrollment, group);
  const { data, error } = await getSupabaseAdmin()
    .from('sms_automation_enrollments')
    .update({ metadata, updated_at: new Date().toISOString() })
    .eq('id', enrollment.id)
    .eq('status', 'enrolled')
    .select()
    .maybeSingle();
  if (error) {
    console.warn('[opek-sms] custom drip seed on enroll failed', error.message);
    return enrollment;
  }
  return data || enrollment;
}
