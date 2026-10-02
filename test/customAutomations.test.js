import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { normalizeCustomRule, computeCustomNextSendAt, computeCustomFirstSendAt,
  seedCustomDrip, advanceCustomDrip, createCustomAutomationGroup,
  deleteCustomAutomationGroup, listCustomAutomationGroups } from '../src/lib/automations/customAutomations.js';
import { runWithTenant } from '../src/lib/tenantContext.js';
import { AUTOMATION_RULE_PRESETS } from '../src/lib/automations/rulePresets.js';
import { groupRule } from '../supabase/functions/_shared/domain.js';
import { automationDue, normalizeSchedule } from '../src/lib/automations/schedule.js';

const schedule = { anchor: 'enrollment', firstDelayCount: 1, firstDelayUnit: 'day',
  intervalCount: 2, intervalUnit: 'day', repeatCount: 6, startHour: 0, endHour: 24 };

test('groups contain only schedule fields and reject stored copy or step rules', () => {
  const rule = normalizeCustomRule(schedule);
  assert.equal(rule.repeatCount, 6);
  for (const key of ['template', 'steps', 'deliveryMode', 'aiDraft', 'intent']) {
    assert.throws(() => normalizeCustomRule({ ...schedule, [key]: key === 'steps' ? [] : 'x' }), /scheduling fields only/);
  }
  assert.throws(() => groupRule({ ...schedule, startHour: 20, endHour: 9 }), /window/i);
  for (const preset of AUTOMATION_RULE_PRESETS) {
    assert.ok(preset.intent.length > 15);
    assert.equal(preset.rule.steps, undefined);
    assert.equal(preset.rule.template, undefined);
    assert.deepEqual(normalizeCustomRule(preset.rule), { ...preset.rule, leadHours: null });
  }
});

test('quote follow-up has six sends on days 0, 2, 4, 6, 8, 10', () => {
  const rule = normalizeCustomRule(AUTOMATION_RULE_PRESETS.find(p => p.id === 'quote-followup').rule);
  let date = new Date('2026-09-01T10:00:00Z');
  const days = [];
  for (let i = 0; i < rule.repeatCount; i++) {
    date = computeCustomNextSendAt(rule, date, 'UTC', i);
    days.push(date.getUTCDate());
  }
  assert.deepEqual(days, [1, 3, 5, 7, 9, 11]);
});

test('monthly intervals clamp month ends and daily intervals respect DST', () => {
  const monthly = normalizeCustomRule({ ...schedule, intervalCount: 1, intervalUnit: 'month' });
  assert.equal(computeCustomNextSendAt(monthly, new Date('2028-01-31T10:00:00Z'), 'UTC').toISOString(), '2028-02-29T10:00:00.000Z');
  const daily = normalizeCustomRule({ ...schedule, intervalCount: 1 });
  assert.equal(computeCustomNextSendAt(daily, new Date('2026-03-07T17:00:00Z'), 'America/Denver').toISOString(), '2026-03-08T16:00:00.000Z');
});

test('first delay and send count control a local drip without saved messages', () => {
  const group = { id: 'custom-test', updatedAt: '2026-09-01T00:00:00Z', rule: normalizeCustomRule({ ...schedule, repeatCount: 2 }) };
  const enrollment = { enrolled_at: '2026-09-01T10:00:00Z', metadata: {} };
  const first = computeCustomFirstSendAt(group.rule, new Date(enrollment.enrolled_at), new Date(enrollment.enrolled_at), 'UTC');
  assert.equal(first.toISOString(), '2026-09-02T10:00:00.000Z');
  const seeded = { ...enrollment, metadata: seedCustomDrip(enrollment, group, new Date(enrollment.enrolled_at)) };
  assert.equal(seeded.metadata.drip.stepIndex, 0);
  const afterFirst = advanceCustomDrip(seeded, group, new Date('2026-09-02T10:00:00Z'));
  assert.equal(afterFirst.completed, false);
  assert.equal(afterFirst.metadata.drip.stepIndex, 1);
  const afterSecond = advanceCustomDrip({ ...seeded, metadata: afterFirst.metadata }, group, new Date('2026-09-04T10:00:00Z'));
  assert.equal(afterSecond.completed, true);
});

test('appointment groups support one or several sends only before the appointment', () => {
  const single = normalizeSchedule({ anchor: 'appointment', leadHours: 24, repeatCount: 1 }, { allowAppointment: true });
  assert.equal(single.intervalUnit, 'hour');
  const multiple = normalizeSchedule({ anchor: 'appointment', leadHours: 24,
    intervalCount: 6, intervalUnit: 'hour', repeatCount: 3, startHour: 0, endHour: 24 }, { allowAppointment: true });
  const appointment_at = '2026-09-25T18:00:00Z';
  assert.equal(automationDue(multiple, { appointment_at, step_index: 0 }, 'UTC').toISOString(), '2026-09-24T18:00:00.000Z');
  assert.equal(automationDue(multiple, { appointment_at, step_index: 1,
    last_sent_at: '2026-09-24T18:00:00Z' }, 'UTC').toISOString(), '2026-09-25T00:00:00.000Z');
  assert.throws(() => normalizeSchedule({ anchor: 'appointment', leadHours: 24,
    intervalCount: 6, intervalUnit: 'hour', repeatCount: 5 }, { allowAppointment: true }), /fit before the appointment/);
  assert.throws(() => normalizeSchedule({ anchor: 'appointment', leadHours: 24,
    intervalCount: 1, intervalUnit: 'day', repeatCount: 2 }, { allowAppointment: true }), /hourly interval/);
});

test('file registry keeps one separate intent per tenant group', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'automation-schedule-'));
  const oldFile = process.env.AUTOMATION_RULES_FILE;
  const oldStore = process.env.AUTOMATION_RULES_STORE;
  process.env.AUTOMATION_RULES_FILE = path.join(directory, 'rules.json');
  process.env.AUTOMATION_RULES_STORE = 'file';
  try {
    const created = await runWithTenant({ id: 'alpha', timeZone: 'UTC' }, () =>
      createCustomAutomationGroup({ name: 'Check-in', intent: 'Ask about the original request.', rule: schedule }));
    assert.equal(created.intent, 'Ask about the original request.');
    assert.equal(created.rule.intent, undefined);
    await assert.rejects(() => runWithTenant({ id: 'beta', timeZone: 'UTC' }, () =>
      createCustomAutomationGroup({ name: 'No intent', rule: schedule })), /intent/i);
    const own = await runWithTenant({ id: 'alpha', timeZone: 'UTC' }, () => listCustomAutomationGroups());
    const other = await runWithTenant({ id: 'beta', timeZone: 'UTC' }, () => listCustomAutomationGroups());
    assert.equal(own.length, 1);
    assert.equal(other.length, 0);
    await runWithTenant({ id: 'alpha', timeZone: 'UTC' }, () => deleteCustomAutomationGroup(created.id));
    assert.equal((await runWithTenant({ id: 'alpha', timeZone: 'UTC' }, () => listCustomAutomationGroups())).length, 0);
  } finally {
    if (oldFile === undefined) delete process.env.AUTOMATION_RULES_FILE; else process.env.AUTOMATION_RULES_FILE = oldFile;
    if (oldStore === undefined) delete process.env.AUTOMATION_RULES_STORE; else process.env.AUTOMATION_RULES_STORE = oldStore;
    await rm(directory, { recursive: true, force: true });
  }
});
