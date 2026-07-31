/**
 * Appointment Reminders: one SMS ~24 hours before appointment date, then unenroll.
 */

export const APPOINTMENT_REMINDERS_CATEGORY_ID = 'appointment-reminders';
export const APPOINTMENT_REMINDERS_SEQUENCE_ID = 'appointment-reminders-v1';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

export const APPOINTMENT_REMINDERS_SEQUENCE = {
  id: APPOINTMENT_REMINDERS_SEQUENCE_ID,
  categoryId: APPOINTMENT_REMINDERS_CATEGORY_ID,
  name: 'Appointment reminder (24h before)',
  description:
    'One transactional SMS about 24 hours before the scheduled junk removal or moving appointment, then automatic removal from the group.',
  steps: [
    {
      index: 0,
      id: 'reminder-24h',
      label: '1 SMS · ~24 hours before appointment date',
      delayMs: 1 * DAY,
      template:
        'Hi {{first_name}}, reminder from Opek: your {{service_type}} is scheduled for {{appointment_date}}{{#preferred_time}} ({{preferred_time}}){{/preferred_time}}.{{#service_address}} Address: {{service_address}}.{{/service_address}} Reply if you need to reschedule. Reply STOP to opt out.',
    },
  ],
};

export function getAppointmentReminderStep(stepIndex = 0) {
  return APPOINTMENT_REMINDERS_SEQUENCE.steps[stepIndex] || null;
}

/**
 * Reminder becomes due 24h before the appointment calendar date (date-only).
 * If that time is already past, return `now` so the next tick can send ASAP.
 */
export function computeReminderSendAt(preferredDate, now = new Date()) {
  const ymd = parseYmd(preferredDate);
  if (!ymd) return null;
  const apptUtcMidnight = Date.UTC(ymd.y, ymd.m - 1, ymd.d, 0, 0, 0);
  let sendAt = new Date(apptUtcMidnight - DAY);
  if (sendAt.getTime() <= now.getTime()) return new Date(now);
  return sendAt;
}

export function formatAppointmentDateLabel(preferredDate) {
  const ymd = parseYmd(preferredDate);
  if (!ymd) return clean(preferredDate) || 'your scheduled day';
  try {
    return new Date(Date.UTC(ymd.y, ymd.m - 1, ymd.d, 12, 0, 0)).toLocaleDateString('en-US', {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      timeZone: 'UTC',
    });
  } catch {
    return `${ymd.y}-${String(ymd.m).padStart(2, '0')}-${String(ymd.d).padStart(2, '0')}`;
  }
}

export function renderAppointmentTemplate(template, vars = {}) {
  const preferredTime = clean(vars.preferred_time);
  const serviceAddress = clean(vars.service_address);
  const map = {
    name: clean(vars.name) || 'there',
    first_name: clean(vars.first_name) || firstName(vars.name) || 'there',
    phone: clean(vars.phone) || '',
    service_type: clean(vars.service_type) || 'appointment',
    appointment_date: formatAppointmentDateLabel(vars.appointment_date || vars.preferred_date),
    preferred_time: preferredTime || '',
    service_address: serviceAddress || '',
  };

  let out = String(template || '');
  // Simple optional blocks {{#key}}...{{/key}}
  out = out.replace(/\{\{#(\w+)\}\}([\s\S]*?)\{\{\/\1\}\}/g, (_, key, inner) => {
    return map[key] ? inner : '';
  });
  out = out.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, key) => map[key] ?? '');
  return out.replace(/\s{2,}/g, ' ').trim();
}

export function initialAppointmentDripMetadata({
  preferredDate,
  preferredTime = null,
  serviceType = null,
  serviceAddress = null,
  bookingId = null,
  now = new Date(),
} = {}) {
  const next = computeReminderSendAt(preferredDate, now);
  return {
    appointmentDate: preferredDate || null,
    preferredTime: preferredTime || null,
    serviceType: serviceType || null,
    serviceAddress: serviceAddress || null,
    bookingId: bookingId || null,
    drip: {
      sequenceId: APPOINTMENT_REMINDERS_SEQUENCE_ID,
      stepIndex: 0,
      nextSendAt: next ? next.toISOString() : null,
      lastSentAt: null,
      status: next ? 'active' : 'paused',
      pauseReason: next ? null : 'missing_appointment_date',
    },
  };
}

function parseYmd(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value || '').trim());
  if (!m) return null;
  return { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) };
}

function firstName(name) {
  const s = clean(name);
  if (!s) return null;
  return s.split(/\s+/)[0] || null;
}

function clean(v) {
  if (v == null) return null;
  const s = String(v).trim();
  return s || null;
}
