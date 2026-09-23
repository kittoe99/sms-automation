import { constrainToSendWindow, getZonedParts, zonedDateTimeToUtc } from './timeRules.js';

const units = new Set(['hour', 'day', 'week', 'month']);

function whole(value, fallback, min, max, label) {
  const n = value == null || value === '' ? fallback : Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`Invalid ${label}`);
  return n;
}

export function normalizeSchedule(input = {}, { allowAppointment = false } = {}) {
  if (['template', 'steps', 'deliveryMode', 'aiDraft', 'intent', 'firstSendAt'].some(key => key in input)) {
    throw new Error('Automation groups accept scheduling fields only');
  }
  const anchor = input.anchor || 'enrollment';
  if (anchor !== 'enrollment' && !(allowAppointment && anchor === 'appointment')) throw new Error('Invalid schedule anchor');
  const firstDelayUnit = input.firstDelayUnit || 'day';
  const intervalUnit = input.intervalUnit || (anchor === 'appointment' ? 'hour' : 'day');
  if (!units.has(firstDelayUnit) || !units.has(intervalUnit)) throw new Error('Invalid schedule unit');
  const startHour = whole(input.startHour, 9, 0, 23, 'send window');
  const endHour = whole(input.endHour, 19, 1, 24, 'send window');
  if (endHour <= startHour) throw new Error('Send window end must follow its start');
  const repeatCount = whole(input.repeatCount, 1, 1, 30, 'send count');
  const intervalCount = whole(input.intervalCount, anchor === 'appointment' ? 6 : 1, 1, 365, 'repeat interval');
  const leadHours = anchor === 'appointment' ? whole(input.leadHours, 24, 1, 720, 'appointment lead') : null;
  if (anchor === 'appointment' && (intervalUnit !== 'hour' || (repeatCount - 1) * intervalCount >= leadHours)) {
    throw new Error('Appointment sends must use an hourly interval and fit before the appointment');
  }
  return {
    anchor,
    firstDelayCount: whole(input.firstDelayCount, 1, 0, 365, 'first delay'),
    firstDelayUnit,
    intervalCount,
    intervalUnit,
    repeatCount,
    leadHours,
    startHour,
    endHour,
  };
}

export function calendarDelay(value, count, unit, timeZone) {
  const p = getZonedParts(value, timeZone);
  if (!p || !Number.isInteger(count) || count < 0 || !units.has(unit)) throw new Error('Invalid schedule');
  if (unit === 'hour') return new Date(new Date(value).getTime() + count * 3600000);
  const date = new Date(Date.UTC(p.year, p.month - 1, p.day));
  if (unit === 'month') {
    date.setUTCDate(1);
    date.setUTCMonth(date.getUTCMonth() + count);
    const last = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
    date.setUTCDate(Math.min(p.day, last));
  } else date.setUTCDate(date.getUTCDate() + count * (unit === 'week' ? 7 : 1));
  return zonedDateTimeToUtc({ y: date.getUTCFullYear(), m: date.getUTCMonth() + 1, d: date.getUTCDate(), hour: p.hour, minute: p.minute }, timeZone);
}

export function automationDue(rule, enrollment, timeZone) {
  if (rule.anchor === 'appointment') {
    if (!enrollment.appointment_at) return null;
    if (enrollment.step_index === 0) {
      return new Date(new Date(enrollment.appointment_at).getTime() - rule.leadHours * 3600000);
    }
    if (!enrollment.last_sent_at) return null;
    return constrainToSendWindow(
      calendarDelay(enrollment.last_sent_at, rule.intervalCount, rule.intervalUnit, timeZone),
      { timeZone, startHour: rule.startHour, endHour: rule.endHour }
    );
  }
  const first = enrollment.step_index === 0;
  const from = first ? enrollment.created_at : enrollment.last_sent_at;
  if (!from) return null;
  const due = calendarDelay(from, first ? rule.firstDelayCount : rule.intervalCount,
    first ? rule.firstDelayUnit : rule.intervalUnit, timeZone);
  return constrainToSendWindow(due, { timeZone, startHour: rule.startHour, endHour: rule.endHour });
}
