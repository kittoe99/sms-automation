import { automationDue, calendarDelay } from '../lib/automations/schedule.js';

export { calendarDelay };

export function evaluateAutomation(context, now = new Date()) {
  const { enrollment: e, group: g, contact: c, business: b } = context;
  const rule = g.rule;
  if (e.step_index >= rule.repeatCount || (e.appointment_at && new Date(e.appointment_at) <= now)) {
    return { action: 'complete', group_version: g.version };
  }
  const scheduled = automationDue(rule, e, b.time_zone);
  if (!scheduled || Number.isNaN(scheduled.getTime())) throw new Error('Invalid automation schedule');
  if (rule.anchor === 'appointment' && scheduled >= new Date(e.appointment_at)) {
    return { action: 'complete', group_version: g.version };
  }
  const due = new Date(Math.max(scheduled.getTime(), new Date(e.next_run_at || 0).getTime()));
  if (due > now) return { action: 'schedule', due: due.toISOString(), group_version: g.version };
  return {
    action: 'send', phone: c.phone, purpose: g.kind === 'reminder' ? 'transactional' : 'marketing',
    category_id: g.id, enrollment_id: e.id, enrollment_generation: e.generation,
    group_version: g.version, step_index: e.step_index,
    start_hour: rule.startHour, end_hour: rule.endHour,
  };
}

export async function processAutomation(job, db, options = {}) {
  // All current automation jobs use immutable form sequences. Legacy AI jobs
  // cannot be resumed by a worker left running during the deployment.
  return db.call('process_form_automation', job.id, job.lease_token);
}

