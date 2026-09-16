import test from 'node:test';
import assert from 'node:assert/strict';
import { CATEGORIES } from '../src/lib/categories.js';
import {
  classifyInboundAutomationTrigger,
  snoozeQuoteDripMetadata,
} from '../src/lib/automations/lifecycle.js';
import { computeNextSendAt } from '../src/lib/automations/quoteRequestsSequence.js';
import { constrainToSendWindow } from '../src/lib/automations/timeRules.js';

test('contractor SMS is no longer an automation category', () => {
  assert.equal(CATEGORIES.some((category) => category.id === 'contractor-sms'), false);
  assert.equal(
    CATEGORIES.find((category) => category.id === 'followup-automations')?.activeAutomation,
    false
  );
});

test('inbound automation triggers distinguish consent from customer replies', () => {
  assert.equal(classifyInboundAutomationTrigger('STOP please'), 'opt_out');
  assert.equal(classifyInboundAutomationTrigger('start'), 'opt_in');
  assert.equal(classifyInboundAutomationTrigger('Can you do Friday?'), 'customer_reply');
  assert.equal(classifyInboundAutomationTrigger('   '), 'none');
});

test('customer replies postpone a near-term quote touch for at least 24 hours', () => {
  const now = new Date('2026-09-10T18:00:00Z');
  const metadata = snoozeQuoteDripMetadata(
    { metadata: { drip: { stepIndex: 2, nextSendAt: '2026-09-11T00:00:00.000Z' } } },
    now
  );
  assert.equal(metadata.drip.stepIndex, 2);
  assert.equal(metadata.drip.nextSendAt, '2026-09-11T18:00:00.000Z');
  assert.equal(metadata.drip.lastCustomerReplyAt, now.toISOString());
});

test('customer replies do not move an already-later quote touch earlier', () => {
  const metadata = snoozeQuoteDripMetadata(
    { metadata: { drip: { nextSendAt: '2026-09-15T18:00:00.000Z' } } },
    new Date('2026-09-10T18:00:00Z')
  );
  assert.equal(metadata.drip.nextSendAt, '2026-09-15T18:00:00.000Z');
});

test('marketing times are deferred into the 9am-7pm Denver window', () => {
  assert.equal(
    constrainToSendWindow('2026-09-10T14:00:00.000Z', {
      timeZone: 'America/Denver',
    }).toISOString(),
    '2026-09-10T15:00:00.000Z'
  );
  assert.equal(
    constrainToSendWindow('2026-09-11T01:30:00.000Z', {
      timeZone: 'America/Denver',
    }).toISOString(),
    '2026-09-11T15:00:00.000Z'
  );
});

test('new quote steps are scheduled inside the business send window', () => {
  assert.equal(
    computeNextSendAt(0, '2026-09-10T01:00:00.000Z', 'America/Denver').toISOString(),
    '2026-09-11T15:00:00.000Z'
  );
});
