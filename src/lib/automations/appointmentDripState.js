/**
 * Appointment reminder drip metadata helpers.
 */

import {
  APPOINTMENT_REMINDERS_CATEGORY_ID,
  APPOINTMENT_REMINDERS_SEQUENCE_ID,
  computeReminderSendAt,
  initialAppointmentDripMetadata,
} from './appointmentRemindersSequence.js';

export function getAppointmentDrip(enrollment) {
  const drip = enrollment?.metadata?.drip;
  if (!drip || typeof drip !== 'object') return null;
  return drip;
}

export function needsAppointmentDripSeed(enrollment) {
  if (!enrollment || enrollment.category_id !== APPOINTMENT_REMINDERS_CATEGORY_ID) return false;
  if (enrollment.status !== 'enrolled') return false;
  const drip = getAppointmentDrip(enrollment);
  if (!drip) return true;
  if (drip.sequenceId !== APPOINTMENT_REMINDERS_SEQUENCE_ID) return true;
  if (drip.status && drip.status !== 'active' && drip.status !== 'paused') return true;
  if (!drip.nextSendAt && (drip.status === 'active' || drip.status === 'paused')) return true;
  return false;
}

export function seedAppointmentDripOnEnrollment(enrollment, extras = {}) {
  const preferredDate =
    extras.preferredDate ||
    enrollment?.metadata?.appointmentDate ||
    enrollment?.metadata?.preferred_date ||
    null;
  const seeded = initialAppointmentDripMetadata({
    preferredDate,
    preferredTime: extras.preferredTime || enrollment?.metadata?.preferredTime || null,
    serviceType: extras.serviceType || enrollment?.metadata?.serviceType || null,
    serviceAddress: extras.serviceAddress || enrollment?.metadata?.serviceAddress || null,
    bookingId: extras.bookingId || enrollment?.record_id || enrollment?.metadata?.bookingId || null,
  });
  const prev =
    enrollment.metadata && typeof enrollment.metadata === 'object' ? { ...enrollment.metadata } : {};
  delete prev.removedReason;
  delete prev.removedByBookingId;
  delete prev.removedBySource;
  delete prev.drip;
  return {
    ...prev,
    ...seeded,
  };
}

export function mergeAppointmentDrip(enrollment, dripPatch, extras = {}) {
  const base =
    enrollment?.metadata && typeof enrollment.metadata === 'object' ? { ...enrollment.metadata } : {};
  const prev = base.drip && typeof base.drip === 'object' ? { ...base.drip } : {};
  return {
    ...base,
    ...(extras.appointmentDate != null ? { appointmentDate: extras.appointmentDate } : {}),
    ...(extras.preferredTime != null ? { preferredTime: extras.preferredTime } : {}),
    ...(extras.serviceType != null ? { serviceType: extras.serviceType } : {}),
    ...(extras.serviceAddress != null ? { serviceAddress: extras.serviceAddress } : {}),
    ...(extras.bookingId != null ? { bookingId: extras.bookingId } : {}),
    drip: {
      sequenceId: APPOINTMENT_REMINDERS_SEQUENCE_ID,
      stepIndex: 0,
      nextSendAt: null,
      lastSentAt: null,
      status: 'active',
      pauseReason: null,
      ...prev,
      ...dripPatch,
    },
  };
}

export function isAppointmentDripDue(enrollment, now = new Date()) {
  const drip = getAppointmentDrip(enrollment);
  // Enrolled contacts keep receiving reminders unless removed from the group.
  if (!drip || (drip.status && drip.status !== 'active' && drip.status !== 'paused')) {
    return false;
  }
  if (drip.nextSendAt == null) return false;
  const next = new Date(drip.nextSendAt);
  if (Number.isNaN(next.getTime())) return false;
  return next.getTime() <= now.getTime();
}

/** Single-step sequence: after send, always complete. */
export function completeAppointmentAfterSend(enrollment, sentAt = new Date()) {
  return {
    completed: true,
    metadata: mergeAppointmentDrip(enrollment, {
      stepIndex: 0,
      status: 'completed',
      lastSentAt: sentAt.toISOString(),
      nextSendAt: null,
      pauseReason: null,
    }),
  };
}

export function rescheduleAppointmentDrip(enrollment, preferredDate, now = new Date()) {
  const next = computeReminderSendAt(preferredDate, now);
  return mergeAppointmentDrip(
    enrollment,
    {
      status: 'active',
      nextSendAt: next ? next.toISOString() : null,
      pauseReason: null,
      stepIndex: 0,
    },
    { appointmentDate: preferredDate }
  );
}
