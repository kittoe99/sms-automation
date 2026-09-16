import test from 'node:test';
import assert from 'node:assert/strict';
import { computeReminderSendAt } from '../src/lib/automations/appointmentRemindersSequence.js';

test('schedules exactly 24 hours before the preferred Denver window', () => {
  const result = computeReminderSendAt(
    '2026-09-15',
    new Date('2026-09-01T00:00:00Z'),
    'morning 8-12',
    'America/Denver'
  );
  assert.equal(result.toISOString(), '2026-09-14T14:00:00.000Z');
});

test('uses 9am local when no preferred time exists', () => {
  const result = computeReminderSendAt(
    '2026-01-15',
    new Date('2026-01-01T00:00:00Z'),
    null,
    'America/Denver'
  );
  assert.equal(result.toISOString(), '2026-01-14T16:00:00.000Z');
});

test('rejects calendar dates that roll into another month', () => {
  assert.equal(
    computeReminderSendAt('2026-02-31', new Date('2026-01-01T00:00:00Z')),
    null
  );
});

test('does not schedule reminders for an appointment that already passed', () => {
  const now = new Date('2026-09-15T18:00:00Z');
  assert.equal(computeReminderSendAt('2026-09-15', now, 'morning 8-12', 'America/Denver'), null);
});

test('returns now when the reminder time passed but the appointment is upcoming', () => {
  const now = new Date('2026-09-15T18:00:00Z');
  assert.equal(
    computeReminderSendAt('2026-09-15', now, 'evening 4-7', 'America/Denver').toISOString(),
    now.toISOString()
  );
});
