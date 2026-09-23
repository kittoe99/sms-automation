import { automationDue, calendarDelay } from '../lib/automations/schedule.js';
import { draftAutomationMessage } from '../lib/automations/aiDraft.js';

export { calendarDelay };

export function evaluateAutomation(context, now = new Date()) {
  const { enrollment: e, group: g, contact: c, business: b } = context;
  const rule = g.rule;
  if (e.step_index >= rule.repeatCount || (e.appointment_at && new Date(e.appointment_at) <= now)) {
    return { action: 'complete', group_version: g.version };
  }
  const scheduled = automationDue(rule, e, b.time_zone);
  if (!scheduled || Number.isNaN(scheduled.getTime())) throw new Error('Invalid automation schedule');
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
  const context = await db.call('job_context', job.id, job.lease_token);
  if (!context?.enrollment || !context.group || context.enrollment.status !== 'active') {
    return db.call('finish', job.id, job.lease_token, 'cancelled', 'INACTIVE', 0);
  }
  const result = evaluateAutomation(context);
  if (result.action === 'send') {
    const intent = String(context.intent || '').trim();
    if (!intent) throw Object.assign(new Error('Automation intent is missing'), { code: 'MISSING_AUTOMATION_INTENT', permanent: true });
    const draft = await draftAutomationMessage(context, intent, options);
    result.body = draft.body;
    result.ai_drafted = draft.aiDrafted;
    result.thread_generation = context.thread?.generation ?? 0;
  }
  return db.call('complete_automation', job.id, job.lease_token, result);
}
