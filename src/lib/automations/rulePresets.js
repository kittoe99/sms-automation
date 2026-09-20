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
        { template: `Hi {{first_name}}, just checking in on your request. Is there anything I can help clarify? ${optOut}`, delayCount: 1, delayUnit: 'day' },
        { template: `Hi {{first_name}}, I wanted to make sure you have what you need to move forward. ${optOut}`, delayCount: 2, delayUnit: 'day' },
        { template: `Hi {{first_name}}, are you still looking for help with your request? ${optOut}`, delayCount: 4, delayUnit: 'day' },
        { template: `Hi {{first_name}}, this is my final check-in for now. Reach out anytime if we can help. ${optOut}`, delayCount: 7, delayUnit: 'day' },
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
        { template: `Hi {{first_name}}, do you have any questions about your quote? ${optOut}`, delayCount: 1, delayUnit: 'day' },
        { template: `Hi {{first_name}}, checking whether you'd like help with the next step on your quote. ${optOut}`, delayCount: 2, delayUnit: 'day' },
        { template: `Hi {{first_name}}, is timing, scope, or something else holding up your decision? ${optOut}`, delayCount: 3, delayUnit: 'day' },
        { template: `Hi {{first_name}}, I'll close the loop for now. Reply anytime if you'd like to revisit your quote. ${optOut}`, delayCount: 7, delayUnit: 'day' },
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
        { template: `Hi {{first_name}}, sorry we missed your call. What can we help you with? ${optOut}`, delayCount: 0, delayUnit: 'day' },
        { template: `Hi {{first_name}}, following up on your call. Is there a good time or way to help? ${optOut}`, delayCount: 1, delayUnit: 'day' },
        { template: `Hi {{first_name}}, one last check-in after your call. Reply whenever you're ready. ${optOut}`, delayCount: 3, delayUnit: 'day' },
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
        { template: `Hi {{first_name}}, thanks for choosing us. How did everything go with your service? ${optOut}`, delayCount: 1, delayUnit: 'day' },
        { template: `Hi {{first_name}}, just making sure everything was handled to your satisfaction. ${optOut}`, delayCount: 3, delayUnit: 'day' },
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
        { template: `Hi {{first_name}}, thank you for working with us. Would you be willing to share a quick review? ${optOut}`, delayCount: 1, delayUnit: 'day' },
        { template: `Hi {{first_name}}, a quick review would mean a lot to us. No worries if now isn't a good time. ${optOut}`, delayCount: 1, delayUnit: 'week' },
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
        { template: `Hi {{first_name}}, it's been a while. Is there anything we can help you with? ${optOut}`, delayCount: 2, delayUnit: 'week' },
        { template: `Hi {{first_name}}, checking in to see whether you have any upcoming service needs. ${optOut}`, delayCount: 4, delayUnit: 'week' },
        { template: `Hi {{first_name}}, we're here whenever you need us. ${optOut}`, delayCount: 4, delayUnit: 'week' },
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
        { template: `Hi {{first_name}}, checking in to see whether your plans have changed or you need any help. ${optOut}`, delayCount: 1, delayUnit: 'month' },
        { template: `Hi {{first_name}}, is your project still on the horizon? We're happy to answer questions. ${optOut}`, delayCount: 1, delayUnit: 'month' },
        { template: `Hi {{first_name}}, we're available whenever the timing is right for you. ${optOut}`, delayCount: 1, delayUnit: 'month' },
      ],
    },
  },
]);
