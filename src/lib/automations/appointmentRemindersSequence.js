/**
 * Appointment Reminders: one SMS ~24 hours before appointment date, then unenroll.
 */

import { getBusinessTimeZone, zonedDateTimeToUtc } from './timeRules.js';

export const APPOINTMENT_REMINDERS_CATEGORY_ID = 'appointment-reminders';
export const APPOINTMENT_REMINDERS_SEQUENCE_ID = 'appointment-reminders-v1';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

export const APPOINTMENT_REMINDERS_SEQUENCE = {
  id: APPOINTMENT_REMINDERS_SEQUENCE_ID,
  categoryId: APPOINTMENT_REMINDERS_CATEGORY_ID,
  name: 'Appointment reminder (24h before)',
  description:
    'One transactional SMS about 24 hours before an upcoming appointment. Booking changes reschedule it; cancellations, expired appointments, and successful sends remove it.',
  steps: [
    {
      index: 0,
      id: 'reminder-24h',
      label: '1 SMS · ~24 hours before appointment date',
      delayMs: 1 * DAY,
      intent: 'Remind the customer about the confirmed appointment using its actual local date and time. Invite a reply if they need to reschedule; never imply an unconfirmed change is booked.',
    },
  ],
};

export function getAppointmentReminderStep(stepIndex = 0) {
  return APPOINTMENT_REMINDERS_SEQUENCE.steps[stepIndex] || null;
}

/**
 * Reminder becomes due 24h before the appointment in the business timezone.
 * If the reminder time has passed but the appointment is still upcoming, send ASAP.
 * Expired appointments never receive a reminder.
 */
export function computeReminderSendAt(
  preferredDate,
  now = new Date(),
  preferredTime = null,
  timeZone = getBusinessTimeZone()
) {
  const appointment = computeAppointmentAt(preferredDate, preferredTime, timeZone);
  if (!appointment) return null;
  if (appointment.getTime() <= now.getTime()) return null;
  const sendAt = new Date(appointment.getTime() - DAY);
  if (sendAt.getTime() <= now.getTime()) return new Date(now);
  return sendAt;
}

export function computeAppointmentAt(
  preferredDate,
  preferredTime = null,
  timeZone = getBusinessTimeZone()
) {
  const ymd = parseYmd(preferredDate);
  if (!ymd) return null;
  const { hour, minute } = parsePreferredTime(preferredTime);
  return zonedDateTimeToUtc({ ...ymd, hour, minute }, timeZone);
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

export function initialAppointmentDripMetadata({
  preferredDate,
  preferredTime = null,
  serviceType = null,
  serviceAddress = null,
  bookingId = null,
  now = new Date(),
} = {}) {
  const next = computeReminderSendAt(preferredDate, now, preferredTime);
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
      status: 'active',
      pauseReason: null,
    },
  };
}

function parseYmd(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value || '').trim());
  if (!m) return null;
  const parsed = { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) };
  const check = new Date(Date.UTC(parsed.y, parsed.m - 1, parsed.d));
  if (
    check.getUTCFullYear() !== parsed.y ||
    check.getUTCMonth() !== parsed.m - 1 ||
    check.getUTCDate() !== parsed.d
  ) {
    return null;
  }
  return parsed;
}

function parsePreferredTime(value) {
  const text = String(value || '').trim().toLowerCase();
  if (!text) return { hour: 9, minute: 0 };
  const match = text.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/);
  if (!match) {
    if (/evening/.test(text)) return { hour: 16, minute: 0 };
    if (/midday|afternoon/.test(text)) return { hour: 12, minute: 0 };
    return { hour: 9, minute: 0 };
  }
  let hour = Number(match[1]);
  const minute = Math.min(Number(match[2] || 0), 59);
  const meridiem = match[3];
  if (meridiem === 'pm' && hour < 12) hour += 12;
  if (meridiem === 'am' && hour === 12) hour = 0;
  if (!meridiem && /evening|afternoon/.test(text) && hour < 12) hour += 12;
  if (hour > 23) return { hour: 9, minute: 0 };
  return { hour, minute };
}

function clean(v) {
  if (v == null) return null;
  const s = String(v).trim();
  return s || null;
}
