/**
 * Quote Requests drip with reply-aware lifecycle controls in the runner.
 */

import { constrainToSendWindow, getBusinessTimeZone } from './timeRules.js';

export const QUOTE_REQUESTS_CATEGORY_ID = 'quote-requests';
export const QUOTE_REQUESTS_SEQUENCE_ID = 'quote-requests-v1';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/** Delays are measured from enroll (step 0) or from the previous successful send. */
export const QUOTE_REQUESTS_SEQUENCE = {
  id: QUOTE_REQUESTS_SEQUENCE_ID,
  categoryId: QUOTE_REQUESTS_CATEGORY_ID,
  name: 'Quote Request follow-up',
  description:
    'Six measured follow-ups over 14 days. Sends stay inside 9am–7pm business time, customer replies postpone the next touch, and a booking or opt-out ends the sequence.',
  steps: [
    {
      index: 0,
      id: 'day-1',
      label: 'Day 1 — 1 SMS, 24h after enroll',
      delayMs: 1 * DAY,
      intent: 'First quote follow-up: acknowledge the request and ask whether the customer needs clarification about the estimate or scope.',
    },
    {
      index: 1,
      id: 'day-2',
      label: 'Day 2 — 1 SMS, 24h after previous',
      delayMs: 1 * DAY,
      intent: 'Second quote follow-up: check whether scope or timing changed without repeating an answered question.',
    },
    {
      index: 2,
      id: 'day-3',
      label: 'Day 3 — 1 SMS, 24h after previous',
      delayMs: 1 * DAY,
      intent: 'Third quote follow-up: if the customer seems ready, invite a practical next step without claiming a booking.',
    },
    {
      index: 3,
      id: 'after-48h-1',
      label: '1 SMS, 48h after Day 3',
      delayMs: 2 * DAY,
      intent: 'Fourth quote follow-up: ask whether a concern is holding up the decision.',
    },
    {
      index: 4,
      id: 'after-48h-2',
      label: '1 SMS, 48h after previous',
      delayMs: 2 * DAY,
      intent: 'Fifth quote follow-up: offer to review changed project details if relevant.',
    },
    {
      index: 5,
      id: 'final-week',
      label: 'Final — 1 SMS, 7 days after previous',
      delayMs: 7 * DAY,
      intent: 'Final quote follow-up: close the sequence politely and invite a future reply.',
    },
  ],
};

export function getQuoteRequestsStep(stepIndex) {
  return QUOTE_REQUESTS_SEQUENCE.steps[stepIndex] || null;
}

/** True for Local Moving / Moving Labor (hourly) — never SMS a job total. */
export function isMovingService(serviceType) {
  const s = String(serviceType || '').toLowerCase();
  if (!s) return false;
  if (/\b(junk|cleanout|mattress|dumpster|disposal|hauling)\b/.test(s)) return false;
  return /\b(moving|movers?|local\s*move)\b/.test(s);
}

/** Junk removal and other fixed / itemized totals. */
export function isFixedPriceService(serviceType) {
  const s = String(serviceType || '').toLowerCase();
  if (!s) return false;
  return /\b(junk|cleanout|mattress|dumpster|disposal|removal|haul)\b/.test(s);
}

function looksHourlyRateText(raw) {
  return /\b(per\s*hour|hourly|\/\s*hr|helpers?|crew)\b/i.test(String(raw || ''));
}

function cleanMovingRatePhrase(raw) {
  let s = String(raw || '').trim();
  s = s.replace(/^(quoted\/?est\.?|quote|estimate|est\.?)\s*[:\-]?\s*/i, '');
  s = s.replace(/\s+/g, ' ').trim();
  return s || null;
}

/**
 * Normalize CRM price strings for drip SMS.
 * - Junk / fixed-price: short "$169" total (legacy behavior).
 * - Moving: keep hourly CRM phrasing; never collapse to a bare job total like "$693".
 */
export function formatQuotedPrice(value, serviceType = null) {
  if (value == null || value === '') return null;

  const moving =
    isMovingService(serviceType) ||
    (!isFixedPriceService(serviceType) && looksHourlyRateText(value));

  if (moving) {
    return formatMovingQuotedPrice(value);
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    return '$' + Math.round(value);
  }
  const raw = String(value).trim();
  if (!raw) return null;
  const match = raw.match(/\$?\s*([\d,]+(?:\.\d{1,2})?)/);
  if (match) {
    const n = Number(String(match[1]).replace(/,/g, ''));
    if (Number.isFinite(n)) return '$' + Math.round(n);
  }
  return raw;
}

/** Moving-only: hourly phrase or generic — never a job total. */
export function formatMovingQuotedPrice(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'number' && Number.isFinite(value)) {
    // Bare totals are not used for moving SMS.
    return 'your hourly moving rate';
  }
  const raw = String(value).trim();
  if (!raw) return null;
  if (looksHourlyRateText(raw)) {
    return cleanMovingRatePhrase(raw) || 'your hourly moving rate';
  }
  // CRM sometimes stores an estimated hours×rate total — do not surface it.
  return 'your hourly moving rate';
}

/**
 * @param {number} stepIndex - step about to be sent (0-based)
 * @param {Date|string|number} fromDate - enroll time for step 0, else last send time
 */
export function computeNextSendAt(
  stepIndex,
  fromDate = new Date(),
  timeZone = getBusinessTimeZone()
) {
  const step = getQuoteRequestsStep(stepIndex);
  if (!step) return null;
  const base = new Date(fromDate);
  if (Number.isNaN(base.getTime())) return null;
  return constrainToSendWindow(new Date(base.getTime() + step.delayMs), { timeZone });
}

export function initialDripMetadata(enrolledAt = new Date()) {
  const next = computeNextSendAt(0, enrolledAt);
  return {
    drip: {
      sequenceId: QUOTE_REQUESTS_SEQUENCE_ID,
      stepIndex: 0,
      nextSendAt: next ? next.toISOString() : null,
      lastSentAt: null,
      status: 'active',
      pauseReason: null,
    },
  };
}
