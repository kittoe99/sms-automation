import test from 'node:test';
import assert from 'node:assert/strict';
import { AUTOMATION_SYSTEM_PROMPT, buildAutomationDraftPrompt, draftAutomationMessage } from '../src/lib/automations/aiDraft.js';
import { processAutomation } from '../src/workers/automation.js';

const context = (kind = 'quote') => ({
  business: { name: 'Alpha Services', time_zone: 'America/Denver' },
  profile: { facts: { forbiddenLegacyFact: 'Do not use this account-wide fact.' } },
  automationAi: {
    systemPrompt: 'Use a warm and direct tone. Ask one useful question.',
    businessContext: 'Alpha Services provides gutter cleaning in Denver.',
  },
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

test('the AI prompt includes the group context, current conversation, and purpose', () => {
  const prompt = buildAutomationDraftPrompt(context(), 'Ask about timing.');
  assert.match(prompt, /Automation purpose: "Ask about timing\."/);
  assert.match(prompt, /Alpha Services/);
  assert.match(prompt, /gutter cleaning/);
  assert.doesNotMatch(prompt, /forbiddenLegacyFact|account-wide fact/);
  assert.ok(prompt.indexOf('Would Tuesday work?') < prompt.indexOf('Afternoons work best.'));
  assert.doesNotMatch(prompt, /Approved fallback message/);
});

test('a table-triggered send uses its exact intake row, not another request from the contact', () => {
  const current = context('quote');
  current.enrollment.source_type = 'quote_requests';
  current.source = { name: 'Alex', phone: '+13035550123', details: { service: 'painting' }, created_at: '2026-09-22T10:00:00Z' };
  current.quote = { details: { service: 'stale roofing quote' } };
  const prompt = buildAutomationDraftPrompt(current, 'Help with the quote request.');
  assert.match(prompt, /painting/);
  assert.doesNotMatch(prompt, /stale roofing quote/);
  assert.match(prompt, /Exact SMS intake record/);
});

test('conflicting quote and booking produce a neutral short clarification',async()=>{
 const current=context('quote');
 current.enrollment.source_type='quote_requests';
 current.source={name:'New customer',created_at:'2026-09-23T10:00:00Z',details:{service_address:'New street',property_access:'Stairs'}};
 current.booking={customer_name:'Old customer',service_address:'Old street'};
 const prompt=buildAutomationDraftPrompt(current,'Help with the quote request.');
 assert.match(prompt,/Request conflict: true/);
 assert.doesNotMatch(prompt,/New street|Old street|Old customer|New customer/);
 const draft=await draftAutomationMessage(current,'Help with the quote request.',{
  apiKey:'test',fetchImpl:async()=>aiResponse('Alpha Services received a new quote request from this number. Would you like to continue it?'),
 });
 assert.ok(draft.body.length<=300);
 assert.match(draft.body,/Reply STOP to opt out/);
 await assert.rejects(draftAutomationMessage(current,'Help with the quote request.',{
  apiKey:'test',fetchImpl:async()=>aiResponse('Hi New customer, what is the access at New street?'),
 }),/CONTEXT_CONFLICT/);
});

test('a quote draft cannot ask whether access is stairs or elevator when intake answered stairs',async()=>{
 const current=context('quote');
 current.enrollment.source_type='quote_requests';
 current.source={name:'Alex',created_at:'2026-09-23T10:00:00Z',details:{property_access:'Stairs'}};
 await assert.rejects(draftAutomationMessage(current,'Help with the quote request.',{
  apiKey:'test',fetchImpl:async()=>aiResponse('Alpha Services here. Is there an elevator or just stairs?'),
 }),/REDUNDANT_QUESTION/);
});

test('quote messages are drafted from thread context with opt-out text', async () => {
  const draft = await draftAutomationMessage(context(), 'Ask about timing.', {
    apiKey: 'test',
    fetchImpl: async (_url, request) => {
      const body = JSON.parse(request.body);
      assert.ok(body.instructions.startsWith(AUTOMATION_SYSTEM_PROMPT));
      assert.match(body.instructions, /Use a warm and direct tone/);
      assert.match(body.instructions, /The scheduling system—not you—decides when and how often to send/);
      assert.match(body.input, /Afternoons work best/);
      assert.match(body.input, /Alpha Services provides gutter cleaning in Denver/);
      assert.doesNotMatch(body.instructions + body.input, /forbiddenLegacyFact|account-wide fact/);
      return aiResponse('Hi Alex, Alpha Services here. Are afternoons still best for gutter cleaning?');
    },
  });
  assert.equal(draft.aiDrafted, true);
  assert.match(draft.body, /afternoons still best/i);
  assert.match(draft.body, /Reply STOP to opt out\./);
});

test('one-time automation is framed as a single purposeful send, not a follow-up', async () => {
  const single = context('custom');
  single.group.rule = { repeatCount: 1 };
  const draft = await draftAutomationMessage(single, 'Notify Alex that their quote is ready for review.', {
    apiKey: 'test',
    fetchImpl: async (_url, request) => {
      const body = JSON.parse(request.body);
      assert.match(body.input, /"sendNumber":1,"maxSends":1/);
      assert.match(body.input, /quote is ready for review/);
      assert.match(body.instructions, /A one-time message should deliver its purpose/);
      return aiResponse('Alpha Services: your gutter cleaning quote is ready to review. Would you like us to send the details?');
    },
  });
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
  const missing = context();
  missing.automationAi.businessContext = '';
  await assert.rejects(draftAutomationMessage(missing, 'Ask about timing.', {
    apiKey: 'test', fetchImpl: async () => { throw new Error('API must not be called'); },
  }), /AI_CONFIG_REQUIRED/);
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

test('the worker cancels an old due job when its group context is incomplete', async () => {
  const workerContext = {
    ...context(),
    automationAi: { systemPrompt: '', businessContext: '' },
    enrollment: { status: 'active', step_index: 0, created_at: '2026-09-19T10:00:00Z', next_run_at: '2026-09-19T10:00:00Z', metadata: {} },
    group: { id: 'followup', kind: 'custom', version: 1,
      rule: { anchor: 'enrollment', firstDelayCount: 0, firstDelayUnit: 'day', intervalCount: 1,
        intervalUnit: 'day', repeatCount: 1, startHour: 0, endHour: 24 } },
  };
  const calls = [];
  await processAutomation({ id: 'job-1', lease_token: 'lease-1' }, { call: async (name, ...args) => {
    calls.push([name, ...args]);
    if (name === 'job_context') return workerContext;
    if (name === 'finish') return null;
    throw new Error(`Unexpected call: ${name}`);
  } }, { apiKey: 'test', fetchImpl: async () => { throw new Error('API must not be called'); } });
  assert.deepEqual(calls.map(([name]) => name), ['job_context', 'finish']);
  assert.equal(calls[1][4], 'AI_CONFIG_REQUIRED');
});

