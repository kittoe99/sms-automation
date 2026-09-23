import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAutomationDraftPrompt, draftAutomationMessage } from '../src/lib/automations/aiDraft.js';
import { processAutomation } from '../src/workers/automation.js';

const context = (kind = 'quote') => ({
  business: { name: 'Alpha Services', time_zone: 'America/Denver' },
  profile: { facts: { services: ['gutter cleaning'] } },
  contact: { name: 'Alex', phone: '+13035550123' },
  enrollment: { metadata: { service: 'gutter cleaning' }, appointment_at: null, step_index: 0 },
  group: { id: 'followup', name: 'Follow-up', kind, rule: {} },
  settings: { instructions: 'Sound friendly.' },
  history: [
    { direction: 'outbound', body: 'Would Tuesday work?', created_at: '2026-09-19T10:00:00Z' },
    { direction: 'inbound', body: 'Afternoons work best.', created_at: '2026-09-19T11:00:00Z' },
  ],
});

const aiResponse = (message) => Response.json({
  status: 'completed',
  output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify({ message }) }] }],
});

test('the AI prompt includes the current conversation and one automation intent', () => {
  const prompt = buildAutomationDraftPrompt(context(), 'Ask about timing.');
  assert.match(prompt, /Automation intent: "Ask about timing\."/);
  assert.match(prompt, /Alpha Services/);
  assert.match(prompt, /gutter cleaning/);
  assert.ok(prompt.indexOf('Would Tuesday work?') < prompt.indexOf('Afternoons work best.'));
  assert.doesNotMatch(prompt, /Approved fallback message/);
});

test('quote messages are drafted from thread context with opt-out text', async () => {
  const draft = await draftAutomationMessage(context(), 'Ask about timing.', {
    apiKey: 'test',
    fetchImpl: async (_url, request) => {
      assert.match(JSON.parse(request.body).input, /Afternoons work best/);
      return aiResponse('Hi Alex, Alpha Services here. Are afternoons still best for gutter cleaning?');
    },
  });
  assert.equal(draft.aiDrafted, true);
  assert.match(draft.body, /afternoons still best/i);
  assert.match(draft.body, /Reply STOP to opt out\./);
});

test('appointment reminders also require a fresh AI draft', async () => {
  const reminder = context('reminder');
  reminder.enrollment.appointment_at = '2026-09-25T17:00:00Z';
  const draft = await draftAutomationMessage(reminder, 'Remind about the appointment.', {
    apiKey: 'test',
    fetchImpl: async () => aiResponse('Alpha Services: your appointment is September 25 at 11 AM. Reply if you need to reschedule.'),
  });
  assert.equal(draft.aiDrafted, true);
  assert.match(draft.body, /September 25/);
});

test('missing AI configuration and invalid output never fall back to a stored message', async () => {
  await assert.rejects(draftAutomationMessage(context(), 'Ask about timing.', { apiKey: null }), /AI_NOT_CONFIGURED/);
  await assert.rejects(draftAutomationMessage(context(), 'Ask about timing.', {
    apiKey: 'test', fetchImpl: async () => aiResponse(''),
  }), /INVALID_DRAFT/);
});

test('refusals and incomplete responses are never delivered', async () => {
  await assert.rejects(draftAutomationMessage(context(), 'Ask about timing.', {
    apiKey: 'test', fetchImpl: async () => Response.json({ status: 'completed', output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'Unable to draft safely.' }] }] }),
  }), /AI_REFUSED/);
  await assert.rejects(draftAutomationMessage(context(), 'Ask about timing.', {
    apiKey: 'test', fetchImpl: async () => Response.json({ status: 'incomplete', output: [] }),
  }), /AI_INCOMPLETE/);
});

test('the worker submits only a fresh draft and the observed thread generation', async () => {
  const workerContext = {
    ...context(),
    thread: { generation: 7 },
    enrollment: {
      id: 'enrollment-1', status: 'active', step_index: 0, generation: 1,
      created_at: '2026-09-19T10:00:00.000Z', next_run_at: '2026-09-19T10:00:00.000Z', metadata: {},
    },
    group: { id: 'followup', name: 'Follow-up', kind: 'custom', version: 3,
      rule: { anchor: 'enrollment', firstDelayCount: 0, firstDelayUnit: 'day', intervalCount: 1,
        intervalUnit: 'day', repeatCount: 1, startHour: 0, endHour: 24 } },
    intent: 'Ask a useful timing question.',
  };
  const calls = [];
  const db = { call: async (name, ...args) => {
    calls.push([name, ...args]);
    if (name === 'job_context') return workerContext;
    if (name === 'complete_automation') return args[2];
    throw new Error(`Unexpected call: ${name}`);
  } };
  const result = await processAutomation({ id: 'job-1', lease_token: 'lease-1' }, db, {
    apiKey: 'test',
    fetchImpl: async () => aiResponse('Alpha Services checking in, Alex. Do afternoons still work?'),
  });
  assert.equal(result.action, 'send');
  assert.equal(result.ai_drafted, true);
  assert.equal(result.thread_generation, 7);
  assert.equal(result.intent, undefined);
  assert.match(result.body, /Reply STOP to opt out\./);
  assert.equal(calls.at(-1)[0], 'complete_automation');
});

test('the worker leaves the job unsent when AI drafting fails', async () => {
  const workerContext = {
    ...context(),
    enrollment: { status: 'active', step_index: 0, created_at: '2026-09-19T10:00:00Z', next_run_at: '2026-09-19T10:00:00Z', metadata: {} },
    group: { id: 'followup', kind: 'custom', version: 1,
      rule: { anchor: 'enrollment', firstDelayCount: 0, firstDelayUnit: 'day', intervalCount: 1,
        intervalUnit: 'day', repeatCount: 1, startHour: 0, endHour: 24 } },
    intent: 'Ask a timing question.',
  };
  const calls = [];
  const db = { call: async (name) => {
    calls.push(name);
    if (name === 'job_context') return workerContext;
    throw new Error('No completion should occur');
  } };
  await assert.rejects(processAutomation({ id: 'job-1', lease_token: 'lease-1' }, db, { apiKey: null }), /AI_NOT_CONFIGURED/);
  assert.deepEqual(calls, ['job_context']);
});
