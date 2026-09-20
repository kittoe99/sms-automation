const optOut = 'Reply STOP to opt out.';

export const CADENCE_PRESETS = Object.freeze({
  daily: { label: 'Daily', intervalCount: 1, intervalUnit: 'day' },
  every_other_day: { label: 'Every other day', intervalCount: 2, intervalUnit: 'day' },
  every_3_days: { label: 'Every 3 days', intervalCount: 3, intervalUnit: 'day' },
  every_5_days: { label: 'Every 5 days', intervalCount: 5, intervalUnit: 'day' },
  every_10_days: { label: 'Every 10 days', intervalCount: 10, intervalUnit: 'day' },
  weekly: { label: 'Weekly', intervalCount: 1, intervalUnit: 'week' },
  every_2_weeks: { label: 'Every 2 weeks', intervalCount: 2, intervalUnit: 'week' },
  monthly: { label: 'Monthly', intervalCount: 1, intervalUnit: 'month' },
  quarterly: { label: 'Every 3 months', intervalCount: 3, intervalUnit: 'month' },
  custom: { label: 'Custom interval', intervalCount: 1, intervalUnit: 'day' },
});

export const AUTOMATION_RULE_PRESETS = Object.freeze([
  {
    id: 'new-lead-nurture',
    label: 'New lead nurture',
    description: 'Four helpful touches over two weeks for a new inquiry.',
    defaultName: 'New Lead Nurture',
    rule: {
      cadence: 'custom', intervalCount: 1, intervalUnit: 'day', startHour: 9, endHour: 19, aiDraft: true,
      steps: [
        { template: `Hi {{first_name}}, {{business_name}} here about your {{service_name}}. What can we clarify so you have the information you need? ${optOut}`, delayCount: 1, delayUnit: 'day' },
        { template: `Hi {{first_name}}, following up from {{business_name}} about your {{service_name}}. Do you have questions about scope, timing, or next steps? ${optOut}`, delayCount: 2, delayUnit: 'day' },
        { template: `Hi {{first_name}}, are you still looking for help from {{business_name}} with your {{service_name}}? Reply with what you need and we will help. ${optOut}`, delayCount: 4, delayUnit: 'day' },
        { template: `Hi {{first_name}}, final follow-up from {{business_name}} about your {{service_name}} for now. You can reply anytime to pick this back up. ${optOut}`, delayCount: 7, delayUnit: 'day' },
      ],
    },
  },
  {
    id: 'quote-followup',
    label: 'Quote follow-up',
    description: 'A balanced sequence for customers who received an estimate or quote.',
    defaultName: 'Quote Follow-up',
    rule: {
      cadence: 'custom', intervalCount: 1, intervalUnit: 'day', startHour: 9, endHour: 19, aiDraft: true,
      steps: [
        { template: `Hi {{first_name}}, {{business_name}} here about the quote for your {{service_name}}. What questions can we answer about the estimate? ${optOut}`, delayCount: 1, delayUnit: 'day' },
        { template: `Hi {{first_name}}, following up from {{business_name}} on your {{service_name}} quote. Would you like help with the next step? ${optOut}`, delayCount: 2, delayUnit: 'day' },
        { template: `Hi {{first_name}}, is timing, scope, or another concern holding up your {{service_name}} quote with {{business_name}}? ${optOut}`, delayCount: 3, delayUnit: 'day' },
        { template: `Hi {{first_name}}, final quote follow-up from {{business_name}} about your {{service_name}}. Reply anytime if you would like to revisit it. ${optOut}`, delayCount: 7, delayUnit: 'day' },
      ],
    },
  },
  {
    id: 'missed-call',
    label: 'Missed-call recovery',
    description: 'Respond immediately, then follow up twice if the customer stays quiet.',
    defaultName: 'Missed-call Recovery',
    rule: {
      cadence: 'custom', intervalCount: 1, intervalUnit: 'day', startHour: 8, endHour: 20, aiDraft: true,
      steps: [
        { template: `Hi {{first_name}}, {{business_name}} here. Sorry we missed your call about your {{service_name}}. What can we help with? ${optOut}`, delayCount: 0, delayUnit: 'day' },
        { template: `Hi {{first_name}}, following up from {{business_name}} about your call and {{service_name}}. Is there a good time or way to help? ${optOut}`, delayCount: 1, delayUnit: 'day' },
        { template: `Hi {{first_name}}, final callback from {{business_name}} about your {{service_name}}. Reply whenever you are ready and we will help. ${optOut}`, delayCount: 3, delayUnit: 'day' },
      ],
    },
  },
  {
    id: 'post-service-checkin',
    label: 'Post-service check-in',
    description: 'Confirm satisfaction and offer help after a completed service.',
    defaultName: 'Post-service Check-in',
    rule: {
      cadence: 'custom', intervalCount: 1, intervalUnit: 'day', startHour: 9, endHour: 19, aiDraft: true,
      steps: [
        { template: `Hi {{first_name}}, thanks for choosing {{business_name}} for your {{service_name}}. How did everything go? ${optOut}`, delayCount: 1, delayUnit: 'day' },
        { template: `Hi {{first_name}}, {{business_name}} checking that your {{service_name}} was completed to your satisfaction. Is there anything we should address? ${optOut}`, delayCount: 3, delayUnit: 'day' },
      ],
    },
  },
  {
    id: 'review-request',
    label: 'Review request',
    description: 'A polite two-touch review request after a successful job.',
    defaultName: 'Review Request',
    rule: {
      cadence: 'weekly', intervalCount: 1, intervalUnit: 'week', startHour: 9, endHour: 19, aiDraft: true,
      steps: [
        { template: `Hi {{first_name}}, thank you for choosing {{business_name}} for your {{service_name}}. Would you be willing to share a quick review? ${optOut}`, delayCount: 1, delayUnit: 'day' },
        { template: `Hi {{first_name}}, a review of your {{service_name}} experience would mean a lot to the {{business_name}} team. No worries if now is not a good time. ${optOut}`, delayCount: 1, delayUnit: 'week' },
      ],
    },
  },
  {
    id: 'customer-reengagement',
    label: 'Customer re-engagement',
    description: 'Three light check-ins for past customers over roughly ten weeks.',
    defaultName: 'Customer Re-engagement',
    rule: {
      cadence: 'custom', intervalCount: 2, intervalUnit: 'week', startHour: 9, endHour: 19, aiDraft: true,
      steps: [
        { template: `Hi {{first_name}}, {{business_name}} here. Do you need any more help with your {{service_name}} or a related project? ${optOut}`, delayCount: 2, delayUnit: 'week' },
        { template: `Hi {{first_name}}, checking in from {{business_name}} about your previous {{service_name}}. Do you have another project coming up? ${optOut}`, delayCount: 4, delayUnit: 'week' },
        { template: `Hi {{first_name}}, the {{business_name}} team is here whenever you need help with your {{service_name}} or another service request. ${optOut}`, delayCount: 4, delayUnit: 'week' },
      ],
    },
  },
  {
    id: 'long-term-nurture',
    label: 'Long-term nurture',
    description: 'Monthly value-focused check-ins for leads with a longer decision cycle.',
    defaultName: 'Long-term Nurture',
    rule: {
      cadence: 'monthly', intervalCount: 1, intervalUnit: 'month', startHour: 9, endHour: 19, aiDraft: true,
      steps: [
        { template: `Hi {{first_name}}, {{business_name}} checking in about your {{service_name}}. Have your plans changed, or can we answer anything? ${optOut}`, delayCount: 1, delayUnit: 'month' },
        { template: `Hi {{first_name}}, is your {{service_name}} still on the horizon? The {{business_name}} team is happy to answer questions about scope or timing. ${optOut}`, delayCount: 1, delayUnit: 'month' },
        { template: `Hi {{first_name}}, {{business_name}} is available whenever the timing is right for your {{service_name}}. Reply if you would like to restart the conversation. ${optOut}`, delayCount: 1, delayUnit: 'month' },
      ],
    },
  },
]);
