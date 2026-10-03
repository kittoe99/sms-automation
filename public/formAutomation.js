// Shared by the browser editor and server validation. No model calls.
export const TIME_UNITS = ['minute', 'hour', 'day', 'week', 'month'];
export const emptySequence = () => ({ trigger: 'submission', leadHours: 24, replyPolicy: 'pause', startHour: 9, endHour: 19, steps: [] });
export const newMessage = (body = '') => ({ body, delayCount: 0, delayUnit: 'day', sendCount: 1, intervalCount: 1, intervalUnit: 'day' });
export const BUILTIN_PRESETS = [
  { id: 'acknowledgment', name: 'Submission acknowledgment', sequence: { ...emptySequence(), steps: [newMessage('Hi {{first_name}}, thanks for contacting {{business_name}}. We have received your request.')] } },
  { id: 'follow-up', name: 'Acknowledge and follow up', sequence: { ...emptySequence(), steps: [newMessage('Hi {{first_name}}, {{business_name}} has received your request. Thank you!'), { ...newMessage('Hi {{first_name}}, are you still interested in your request with {{business_name}}? Reply here to let us know.'), delayCount: 2, sendCount: 2, intervalCount: 3 }] } },
  { id: 'appointment', name: 'Appointment reminder', sequence: { ...emptySequence(), trigger: 'appointment', steps: [newMessage('Hi {{first_name}}, a reminder of your appointment with {{business_name}} on {{appointment_at}}. Reply here if you need help.')] } },
];
export function validateSequence(value, fields = [], { appointmentAllowed = true } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('A message sequence is required.');
  const whole = (n, min, max, label) => { if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${label} must be a whole number from ${min} to ${max}.`); return n; };
  if (!['submission', 'appointment'].includes(value.trigger) || (value.trigger === 'appointment' && !appointmentAllowed)) throw new Error('Appointment rules require a booking form.');
  if (!['pause', 'continue'].includes(value.replyPolicy)) throw new Error('Choose how replies affect this sequence.');
  const result = { trigger: value.trigger, leadHours: whole(value.leadHours ?? 24, 1, 8760, 'Appointment lead time'), replyPolicy: value.replyPolicy,
    startHour: whole(value.startHour, 0, 23, 'Window start'), endHour: whole(value.endHour, 1, 24, 'Window end'), steps: [] };
  if (result.endHour <= result.startHour) throw new Error('The sending window must end after it starts.');
  if (!Array.isArray(value.steps) || value.steps.length < 1 || value.steps.length > 50) throw new Error('Add between 1 and 50 messages.');
  const allowed = new Set(['first_name', 'name', 'phone', 'email', 'business_name', ...(value.trigger === 'appointment' ? ['appointment_at'] : []), ...fields.map(f => `field.${f.key}`)]);
  result.steps = value.steps.map((step, index) => {
    const body = typeof step.body === 'string' ? step.body.trim() : '';
    if (!body || body.length > 1600) throw new Error(`Message ${index + 1} needs 1–1,600 characters.`);
    for (const match of body.matchAll(/\{\{([^{}]+)\}\}/g)) if (!allowed.has(match[1])) throw new Error(`Unknown field: ${match[1]}`);
    if (/[{}]/.test(body.replace(/\{\{([^{}]+)\}\}/g, ''))) throw new Error('Use the insert-field menu for placeholders.');
    if (!TIME_UNITS.includes(step.delayUnit) || !TIME_UNITS.includes(step.intervalUnit)) throw new Error('Choose a valid time unit.');
    return { body, delayCount: whole(step.delayCount, 0, 365, 'Delay'), delayUnit: step.delayUnit,
      sendCount: whole(step.sendCount, 1, 1000, 'Total sends'), intervalCount: whole(step.intervalCount, 1, 365, 'Repeat interval'), intervalUnit: step.intervalUnit };
  });
  return result;
}
export function sequenceSummary(sequence) {
  return (sequence.steps || []).map((s, i) => `Message ${i + 1}: wait ${s.delayCount} ${s.delayUnit}${s.delayCount === 1 ? '' : 's'}, send ${s.sendCount} time${s.sendCount === 1 ? '' : 's'}${s.sendCount > 1 ? `, every ${s.intervalCount} ${s.intervalUnit}${s.intervalCount === 1 ? '' : 's'}` : ''}`).join(' → ');
}
