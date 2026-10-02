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
  const context = await db.call('job_context', job.id, job.lease_token);
  if (!context?.enrollment || !context.group || context.enrollment.status !== 'active') {
    return db.call('finish', job.id, job.lease_token, 'cancelled', 'INACTIVE', 0);
  }
  const result = evaluateAutomation(context);
  if (result.action === 'send') {
    if (!String(context.automationAi?.systemPrompt || '').trim()
      || !String(context.automationAi?.businessContext || '').trim()) {
      return db.call('finish', job.id, job.lease_token, 'cancelled', 'AI_CONFIG_REQUIRED', 0);
    }
    if (context.enrollment.source_id) {
      context.source = await db.call('intake_context', job.id, job.lease_token);
      if (!context.source) throw Object.assign(new Error('Automation source record is missing'), { code: 'SOURCE_MISSING', permanent: true });
      if (context.enrollment.source_type === 'bookings' && context.source.status !== 'confirmed') {
        return db.call('finish', job.id, job.lease_token, 'cancelled', 'BOOKING_NOT_CONFIRMED', 0);
      }
    }
    const intent = String(context.intent || '').trim();
    if (!intent) throw Object.assign(new Error('Automation intent is missing'), { code: 'MISSING_AUTOMATION_INTENT', permanent: true });
    const draft = await draftAutomationMessage(context, intent, options);
    result.body = draft.body;
    result.ai_drafted = draft.aiDrafted;
    result.thread_generation = context.thread?.generation ?? 0;
    result.conversation_id = context.conversation?.id;
    result.scope_generation = context.conversation?.generation;
  }
  return db.call('complete_automation', job.id, job.lease_token, result);
}

