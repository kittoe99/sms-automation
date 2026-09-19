import { constrainToSendWindow, getZonedParts, zonedDateTimeToUtc } from '../lib/automations/timeRules.js';

export function calendarDelay(value, count, unit, timeZone) {
  const p = getZonedParts(value, timeZone);
  if (!p || !Number.isInteger(count) || count < 0 || !['day','week','month'].includes(unit)) throw new Error('Invalid schedule');
  const date = new Date(Date.UTC(p.year, p.month - 1, p.day));
  if (unit === 'month') {
    date.setUTCDate(1); date.setUTCMonth(date.getUTCMonth() + count);
    const last = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
    date.setUTCDate(Math.min(p.day, last));
  } else date.setUTCDate(date.getUTCDate() + count * (unit === 'week' ? 7 : 1));
  return zonedDateTimeToUtc({ y: date.getUTCFullYear(), m: date.getUTCMonth()+1, d: date.getUTCDate(), hour:p.hour, minute:p.minute }, timeZone);
}
export function renderBusinessTemplate(template, { contact, business, enrollment }) {
  const vars = { ...enrollment.metadata, name:contact.name || 'there', first_name:contact.name?.split(/\s+/)[0] || 'there', phone:contact.phone,
    business_name:business.name, appointment_date:enrollment.appointment_at ? new Date(enrollment.appointment_at).toLocaleString('en-US',{timeZone:business.time_zone}) : '' };
  const body = String(template).replace(/\{\{#(\w+)\}\}([\s\S]*?)\{\{\/\1\}\}/g,(_,k,s)=>vars[k] ? s : '')
    .replace(/\{\{\s*(\w+)\s*\}\}/g,(_,k)=>String(vars[k] ?? '')).trim();
  if (!body || body.length > 1600) throw new Error('Rendered message must contain 1–1600 characters');
  return body;
}
export function evaluateAutomation(context, now = new Date()) {
  const { enrollment:e, group:g, contact:c, business:b, steps } = context;
  const step = steps?.[e.step_index];
  if (!step || (e.appointment_at && new Date(e.appointment_at)<=now)) return { action:'complete',group_version:g.version };
  const window = { timeZone:b.time_zone,startHour:g.rule.startHour ?? 9,endHour:g.rule.endHour ?? 19 };
  const constrain = d => g.kind==='reminder' ? d : constrainToSendWindow(d,window);
  const delay = (from,s) => g.kind==='quote'
    ? new Date(new Date(from).getTime()+s.delay_count*86400000)
    : calendarDelay(from,s.delay_count,s.delay_unit,b.time_zone);
  let due;
  if (g.kind==='reminder') due = new Date(new Date(e.appointment_at).getTime()-86400000);
  else if (e.step_index===0 && g.rule.firstSendAt) due = constrain(new Date(g.rule.firstSendAt));
  else due = constrain(delay(e.last_sent_at || e.created_at,step));
  due = new Date(Math.max(due.getTime(), new Date(e.next_run_at).getTime()));
  due = constrain(due);
  if (due > now) return { action:'schedule',due:due.toISOString(),group_version:g.version };
  const next = steps[e.step_index+1];
  return { action:'send',phone:c.phone,body:renderBusinessTemplate(step.template,context),purpose:g.kind==='reminder'?'transactional':'marketing',category_id:g.id,
    enrollment_id:e.id,enrollment_generation:e.generation,group_version:g.version,step_index:e.step_index,
    start_hour:window.startHour,end_hour:window.endHour,
    next_run_at:next ? constrain(delay(now,next)).toISOString() : null };
}
export async function processAutomation(job,db) {
  const context = await db.call('job_context',job.id,job.lease_token);
  if (!context?.enrollment || !context.group || context.enrollment.status!=='active') return db.call('finish',job.id,job.lease_token,'cancelled','INACTIVE',0);
  return db.call('complete_automation',job.id,job.lease_token,evaluateAutomation(context));
}
