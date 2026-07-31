/**
 * Drip metadata helpers for sms_automation_enrollments.metadata
 */

import {
  QUOTE_REQUESTS_CATEGORY_ID,
  QUOTE_REQUESTS_SEQUENCE_ID,
  computeNextSendAt,
  getQuoteRequestsStep,
  initialDripMetadata,
} from './quoteRequestsSequence.js';

export function getDrip(enrollment) {
  const drip = enrollment?.metadata?.drip;
  if (!drip || typeof drip !== 'object') return null;
  return drip;
}

export function needsQuoteRequestDripSeed(enrollment) {
  if (!enrollment || enrollment.category_id !== QUOTE_REQUESTS_CATEGORY_ID) return false;
  if (enrollment.status !== 'enrolled') return false;
  const drip = getDrip(enrollment);
  if (!drip) return true;
  if (drip.sequenceId !== QUOTE_REQUESTS_SEQUENCE_ID) return true;
  if (!drip.nextSendAt && drip.status === 'active') return true;
  return false;
}

export function seedDripOnEnrollment(enrollment) {
  const enrolledAt = enrollment?.enrolled_at || new Date().toISOString();
  const seeded = initialDripMetadata(enrolledAt);
  return {
    ...(enrollment.metadata && typeof enrollment.metadata === 'object' ? enrollment.metadata : {}),
    ...seeded,
  };
}

export function mergeDrip(enrollment, dripPatch) {
  const base =
    enrollment?.metadata && typeof enrollment.metadata === 'object' ? { ...enrollment.metadata } : {};
  const prev = base.drip && typeof base.drip === 'object' ? { ...base.drip } : {};
  return {
    ...base,
    drip: {
      sequenceId: QUOTE_REQUESTS_SEQUENCE_ID,
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

export function isDripDue(enrollment, now = new Date()) {
  const drip = getDrip(enrollment);
  if (!drip || drip.status !== 'active') return false;
  if (drip.nextSendAt == null) return false;
  const next = new Date(drip.nextSendAt);
  if (Number.isNaN(next.getTime())) return false;
  return next.getTime() <= now.getTime();
}

/**
 * After a successful send of current stepIndex, return metadata for next state.
 * If final step, returns { completed: true, metadata }.
 */
export function advanceAfterSend(enrollment, sentAt = new Date()) {
  const drip = getDrip(enrollment) || initialDripMetadata(enrollment.enrolled_at).drip;
  const currentIndex = Number(drip.stepIndex) || 0;
  const step = getQuoteRequestsStep(currentIndex);
  if (!step) {
    return {
      completed: true,
      metadata: mergeDrip(enrollment, {
        status: 'completed',
        lastSentAt: sentAt.toISOString(),
        nextSendAt: null,
        pauseReason: null,
      }),
    };
  }

  const nextIndex = currentIndex + 1;
  const hasMore = Boolean(getQuoteRequestsStep(nextIndex));
  if (!hasMore) {
    return {
      completed: true,
      metadata: mergeDrip(enrollment, {
        stepIndex: currentIndex,
        status: 'completed',
        lastSentAt: sentAt.toISOString(),
        nextSendAt: null,
        pauseReason: null,
      }),
    };
  }

  const nextSendAt = computeNextSendAt(nextIndex, sentAt);
  return {
    completed: false,
    metadata: mergeDrip(enrollment, {
      stepIndex: nextIndex,
      status: 'active',
      lastSentAt: sentAt.toISOString(),
      nextSendAt: nextSendAt ? nextSendAt.toISOString() : null,
      pauseReason: null,
    }),
  };
}

export function pauseDripMetadata(enrollment, reason = 'inbound_reply') {
  return mergeDrip(enrollment, {
    status: 'paused',
    pauseReason: reason,
  });
}
