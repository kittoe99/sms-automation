export const CADENCE_PRESETS = Object.freeze({
  daily: { label: 'Daily', intervalCount: 1, intervalUnit: 'day' },
  every_other_day: { label: 'Every other day', intervalCount: 2, intervalUnit: 'day' },
  every_3_days: { label: 'Every 3 days', intervalCount: 3, intervalUnit: 'day' },
  weekly: { label: 'Weekly', intervalCount: 1, intervalUnit: 'week' },
  monthly: { label: 'Monthly', intervalCount: 1, intervalUnit: 'month' },
});

const rule = (firstDelayCount, firstDelayUnit, intervalCount, intervalUnit, repeatCount, startHour = 9, endHour = 19) => ({
  anchor: 'enrollment', firstDelayCount, firstDelayUnit, intervalCount, intervalUnit,
  repeatCount, startHour, endHour,
});

// An intent is saved once per automation; a preset never contains message copy.
export const AUTOMATION_RULE_PRESETS = Object.freeze([
  { id: 'new-lead-nurture', label: 'New lead nurture', defaultName: 'New Lead Nurture',
    description: 'Four touches for a new inquiry.',
    intent: 'Help the customer move forward with their original inquiry without repeating answered questions.',
    rule: rule(1, 'day', 4, 'day', 4) },
  { id: 'quote-followup', label: 'Quote follow-up', defaultName: 'Quote Follow-up',
    description: 'Six quote messages on days 0, 2, 4, 6, 8, and 10, within the send window.',
    intent: 'Follow up on the quote, answer relevant questions, and help with the next decision without implying acceptance or a confirmed booking.',
    rule: rule(0, 'day', 2, 'day', 6) },
  { id: 'missed-call', label: 'Missed-call recovery', defaultName: 'Missed-call Recovery',
    description: 'Three touches after a missed call.',
    intent: 'Acknowledge the missed call and offer a useful way to continue the conversation.',
    rule: rule(0, 'day', 1, 'day', 3, 8, 20) },
  { id: 'post-service-checkin', label: 'Post-service check-in', defaultName: 'Post-service Check-in',
    description: 'Two check-ins after a completed service.',
    intent: 'Ask how the completed service went and whether anything needs attention without presuming satisfaction.',
    rule: rule(1, 'day', 3, 'day', 2) },
  { id: 'review-request', label: 'Review request', defaultName: 'Review Request',
    description: 'Two review requests after a completed service.',
    intent: 'Invite a review only if the service was completed and no unresolved concern appears in the conversation.',
    rule: rule(1, 'day', 1, 'week', 2) },
  { id: 'customer-reengagement', label: 'Customer re-engagement', defaultName: 'Customer Re-engagement',
    description: 'Three check-ins with a past customer.',
    intent: 'Ask whether the past customer needs help with a related or new request without assuming one exists.',
    rule: rule(2, 'week', 4, 'week', 3) },
  { id: 'long-term-nurture', label: 'Long-term nurture', defaultName: 'Long-term Nurture',
    description: 'Three monthly check-ins.',
    intent: 'Ask whether the original request is still relevant and offer useful help without inventing new facts.',
    rule: rule(1, 'month', 1, 'month', 3) },
]);
