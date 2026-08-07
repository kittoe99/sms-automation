/**
 * Quote Requests drip: 1 SMS/day × 3 days → 1 after 48h → 1 after 48h → 1 after 7d → unenroll.
 */

export const QUOTE_REQUESTS_CATEGORY_ID = 'quote-requests';
export const QUOTE_REQUESTS_SEQUENCE_ID = 'quote-requests-v1';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/** Delays are measured from enroll (step 0) or from the previous send (later steps). */
export const QUOTE_REQUESTS_SEQUENCE = {
  id: QUOTE_REQUESTS_SEQUENCE_ID,
  categoryId: QUOTE_REQUESTS_CATEGORY_ID,
  name: 'Quote Request follow-up',
  description:
    'One SMS every 24 hours for 3 days, then one after 48 hours, another after 48 hours, then a final SMS 7 days later — then automatic removal from the group. Never more than one text per send.',
  steps: [
    {
      index: 0,
      id: 'day-1',
      label: 'Day 1 — 1 SMS, 24h after enroll',
      delayMs: 1 * DAY,
      template:
        'Hi {{first_name}} — Opek here. Your quote is {{quoted_price}}. Ready to book? Reply with a day/time or book online: https://opekjunkremoval.com/booking Reply STOP to opt out.',
    },
    {
      index: 1,
      id: 'day-2',
      label: 'Day 2 — 1 SMS, 24h after previous',
      delayMs: 1 * DAY,
      template:
        '{{first_name}}, still interested in {{quoted_price}}? Text a preferred day or book here: https://opekjunkremoval.com/booking Reply STOP to opt out.',
    },
    {
      index: 2,
      id: 'day-3',
      label: 'Day 3 — 1 SMS, 24h after previous',
      delayMs: 1 * DAY,
      template:
        'Quick reminder from Opek — your quote is {{quoted_price}}. Reply with a day/time to book, or schedule online: https://opekjunkremoval.com/booking Reply STOP to opt out.',
    },
    {
      index: 3,
      id: 'after-48h-1',
      label: '1 SMS, 48h after Day 3',
      delayMs: 2 * DAY,
      template:
        '{{first_name}}, we can lock in {{quoted_price}} this week. Text a day/time or book: https://opekjunkremoval.com/booking Reply STOP to opt out.',
    },
    {
      index: 4,
      id: 'after-48h-2',
      label: '1 SMS, 48h after previous',
      delayMs: 2 * DAY,
      template:
        'Last nudge — your Opek quote is still {{quoted_price}}. Text a day to schedule, or book now: https://opekjunkremoval.com/booking Reply STOP to opt out.',
    },
    {
      index: 5,
      id: 'final-week',
      label: 'Final — 1 SMS, 7 days after previous',
      delayMs: 7 * DAY,
      template:
        'Final note from Opek: your quote is {{quoted_price}}. When you\'re ready, reply here or book: https://opekjunkremoval.com/booking Reply STOP to opt out.',
    },
  ],
};

export function getQuoteRequestsStep(stepIndex) {
  return QUOTE_REQUESTS_SEQUENCE.steps[stepIndex] || null;
}

export function renderTemplate(template, vars = {}) {
  const map = {
    name: clean(vars.name) || 'there',
    first_name: clean(vars.first_name) || firstName(vars.name) || 'there',
    phone: clean(vars.phone) || '',
    quoted_price:
      formatQuotedPrice(vars.quoted_price, vars.service_type) || 'the estimate we sent you',
  };
  return String(template || '').replace(
    /\{\{\s*(name|first_name|phone|quoted_price)\s*\}\}/gi,
    (_, key) => map[String(key).toLowerCase()] ?? ''
  );
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

export function computeNextSendAt(stepIndex, fromDate = new Date()) {
  const step = getQuoteRequestsStep(stepIndex);
  if (!step) return null;
  const base = new Date(fromDate);
  if (Number.isNaN(base.getTime())) return null;
  return new Date(base.getTime() + step.delayMs);
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
