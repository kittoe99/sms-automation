import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildAutomationDraftPrompt,
  draftAutomationMessage,
  usesAiAutomationDraft,
} from '../src/lib/automations/aiDraft.js';
import { processAutomation } from '../src/workers/automation.js';

const context = (kind = 'custom', rule = {}) => ({
  business: { name: 'Alpha Services', time_zone: 'America/Denver' },
  contact: { name: 'Alex', phone: '+13035550123' },
  enrollment: { metadata: { service: 'pickup' } },
  group: { id: 'followup', name: 'Follow-up', kind, rule },
  settings: { instructions: 'Sound friendly.' },
  history: [{ direction: 'inbound', body: 'Afternoons work best.' }],
});

test('AI drafting defaults on for non-reminder automations and can be disabled', () => {
  assert.equal(usesAiAutomationDraft(context()), true);
  assert.equal(usesAiAutomationDraft(context('custom', { aiDraft: false })), false);
  assert.equal(usesAiAutomationDraft(context('reminder')), false);
});

test('appointment reminders bypass AI and keep the exact template', async () => {
  let calls = 0;
  const result = await draftAutomationMessage(
    context('reminder'),
    'Your appointment is tomorrow.',
    { apiKey: 'test', fetchImpl: async () => { calls += 1; throw new Error('not called'); } }
  );
  assert.equal(calls, 0);
  assert.deepEqual(result, {
    body: 'Your appointment is tomorrow.',
    aiDrafted: false,
    reason: 'deterministic',
  });
});

test('non-reminder automations use an AI draft and preserve opt-out text', async () => {
  const fetchImpl = async (_url, request) => {
    const payload = JSON.parse(request.body);
    assert.match(payload.input, /Alpha Services/);
    return Response.json({
      status: 'completed',
      output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify({ message: 'Hi Alex, are afternoons still best for your pickup?' }) }] }],
    });
  };
  const result = await draftAutomationMessage(
    context(),
    'Checking in about your pickup. Reply STOP to opt out.',
    { apiKey: 'test', fetchImpl }
  );
  assert.equal(result.aiDrafted, true);
  assert.match(result.body, /Hi Alex/);
  assert.match(result.body, /Reply STOP to opt out\./);
});

test('AI drafting falls back safely when unavailable', async () => {
  const fallback = 'Saved and approved fallback.';
  const result = await draftAutomationMessage(context(), fallback, { apiKey: null });
  assert.equal(result.body, fallback);
  assert.equal(result.aiDrafted, false);
  assert.match(buildAutomationDraftPrompt(context(), fallback), /Approved fallback message/);
});

test('the automation worker sends the AI draft through the fenced completion path', async () => {
  const calls = [];
  const workerContext = {
    ...context(),
    enrollment: {
      id: 'enrollment-1',
      status: 'active',
      step_index: 0,
      generation: 1,
      created_at: '2026-09-19T10:00:00.000Z',
      next_run_at: '2026-09-19T10:00:00.000Z',
      metadata: {},
    },
    group: {
      id: 'followup',
      name: 'Follow-up',
      kind: 'custom',
      version: 3,
      rule: { startHour: 0, endHour: 24, aiDraft: true },
    },
    steps: [{ template: 'Saved fallback. Reply STOP to opt out.', delay_count: 0, delay_unit: 'day' }],
  };
  const db = {
    call: async (name, ...args) => {
      calls.push([name, ...args]);
      if (name === 'job_context') return workerContext;
      if (name === 'complete_automation') return args[2];
      throw new Error(`Unexpected call: ${name}`);
    },
  };
  const result = await processAutomation(
    { id: 'job-1', lease_token: 'lease-1' },
    db,
    {
      apiKey: 'test',
      fetchImpl: async () => Response.json({
        status: 'completed',
        output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify({ message: 'A personal follow-up for Alex.' }) }] }],
      }),
    }
  );
  assert.equal(result.action, 'send');
  assert.equal(result.ai_drafted, true);
  assert.equal(result.body, 'A personal follow-up for Alex. Reply STOP to opt out.');
  assert.equal(calls.at(-1)[0], 'complete_automation');
});
