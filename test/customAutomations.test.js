import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  advanceCustomDrip,
  computeCustomFirstSendAt,
  computeCustomNextSendAt,
  normalizeCustomRule,
  seedCustomDrip,
  createCustomAutomationGroup,
  deleteCustomAutomationGroup,
  listCustomAutomationGroups,
} from '../src/lib/automations/customAutomations.js';
import { runWithTenant } from '../src/lib/tenantContext.js';
import {
  getGroupAiSettings,
  saveGroupAiSettings,
} from '../src/lib/automations/groupAiInstructions.js';

test('normalizes the common manual cadence presets', () => {
  const everyOtherDay = normalizeCustomRule({
    cadence: 'every_other_day',
    repeatCount: 3,
    template: 'Hi {{first_name}}',
  });
  assert.equal(everyOtherDay.intervalCount, 2);
  assert.equal(everyOtherDay.intervalUnit, 'day');
  assert.equal(everyOtherDay.repeatCount, 3);

  const custom = normalizeCustomRule({
    cadence: 'custom',
    intervalCount: 5,
    intervalUnit: 'week',
    repeatCount: 2,
    template: 'Checking in',
  });
  assert.equal(custom.intervalCount, 5);
  assert.equal(custom.intervalUnit, 'week');
  assert.equal(
    normalizeCustomRule({ cadence: 'daily', template: 'Midnight', startHour: 0 }).startHour,
    0
  );
  assert.throws(
    () => normalizeCustomRule({ cadence: 'sometimes', template: 'Hello' }),
    /Unknown cadence/
  );
});

test('monthly cadence clamps dates to the end of a shorter month', () => {
  const rule = normalizeCustomRule({
    cadence: 'monthly',
    repeatCount: 2,
    template: 'Monthly note',
    startHour: 0,
    endHour: 24,
  });
  const next = computeCustomNextSendAt(rule, new Date('2028-01-31T10:00:00.000Z'), 'UTC');
  assert.equal(next.toISOString(), '2028-02-29T10:00:00.000Z');
});

test('daily cadence preserves business-local time across daylight saving changes', () => {
  const rule = normalizeCustomRule({
    cadence: 'daily',
    repeatCount: 2,
    template: 'Daily note',
    startHour: 0,
    endHour: 24,
  });
  const next = computeCustomNextSendAt(
    rule,
    new Date('2026-03-07T17:00:00.000Z'),
    'America/Denver'
  );
  assert.equal(next.toISOString(), '2026-03-08T16:00:00.000Z');
});

test('supports a scheduled first send and different messages per step', () => {
  const rule = normalizeCustomRule({
    cadence: 'daily',
    firstSendAt: '2026-10-02T16:00:00.000Z',
    template: 'First',
    startHour: 0,
    endHour: 24,
    steps: [
      { template: 'First message', delayCount: 0, delayUnit: 'day' },
      { template: 'Second message', delayCount: 2, delayUnit: 'week' },
    ],
  });
  assert.equal(rule.repeatCount, 2);
  assert.equal(rule.steps[1].template, 'Second message');
  assert.equal(rule.steps[1].delayCount, 2);
  assert.equal(
    computeCustomFirstSendAt(
      rule,
      new Date('2026-09-10T00:00:00.000Z'),
      new Date('2026-09-10T00:00:00.000Z'),
      'UTC'
    ).toISOString(),
    '2026-10-02T16:00:00.000Z'
  );
  const denverLocal = runWithTenant({ id: 'opek', timeZone: 'America/Denver' }, () =>
    normalizeCustomRule({
      cadence: 'daily',
      firstSendAt: '2026-10-02T10:00',
      template: 'Local schedule',
    })
  );
  assert.equal(denverLocal.firstSendAt, '2026-10-02T16:00:00.000Z');
});

test('custom drip advances and completes after the configured sends', () => {
  const group = {
    id: 'custom-opek-review-followup-test',
    updatedAt: '2026-09-10T00:00:00.000Z',
    rule: normalizeCustomRule({
      cadence: 'daily',
      repeatCount: 2,
      template: 'Hi {{first_name}}',
      startHour: 0,
      endHour: 24,
    }),
  };
  const enrollment = {
    enrolled_at: '2026-09-10T10:00:00.000Z',
    metadata: {},
  };
  const seeded = { ...enrollment, metadata: seedCustomDrip(enrollment, group) };
  assert.equal(seeded.metadata.drip.stepIndex, 0);

  const first = advanceCustomDrip(seeded, group, new Date('2026-09-11T10:00:00.000Z'));
  assert.equal(first.completed, false);
  assert.equal(first.metadata.drip.stepIndex, 1);

  const second = advanceCustomDrip(
    { ...seeded, metadata: first.metadata },
    group,
    new Date('2026-09-12T10:00:00.000Z')
  );
  assert.equal(second.completed, true);
  assert.equal(second.metadata.drip.nextSendAt, null);
});

test('file registry creates, isolates, and deletes tenant groups', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'opek-automation-rules-'));
  const previousFile = process.env.AUTOMATION_RULES_FILE;
  const previousStore = process.env.AUTOMATION_RULES_STORE;
  const previousAiFile = process.env.AUTOMATION_AI_SETTINGS_FILE;
  process.env.AUTOMATION_RULES_FILE = path.join(directory, 'rules.json');
  process.env.AUTOMATION_AI_SETTINGS_FILE = path.join(directory, 'ai-settings.json');
  process.env.AUTOMATION_RULES_STORE = 'file';

  try {
    const opekGroup = await runWithTenant({ id: 'opek', timeZone: 'UTC' }, () =>
      createCustomAutomationGroup({
        name: 'Review request',
        rule: { cadence: 'weekly', repeatCount: 2, template: 'Hi {{first_name}}' },
      })
    );
    await runWithTenant({ id: 'acme', timeZone: 'UTC' }, () =>
      createCustomAutomationGroup({
        name: 'Acme check-in',
        rule: { cadence: 'daily', repeatCount: 1, template: 'Hello' },
      })
    );

    const opekGroups = await runWithTenant({ id: 'opek', timeZone: 'UTC' }, () =>
      listCustomAutomationGroups()
    );
    assert.deepEqual(opekGroups.map((group) => group.name), ['Review request']);

    await runWithTenant({ id: 'opek', timeZone: 'UTC' }, () =>
      saveGroupAiSettings(opekGroup.id, {
        enabled: true,
        instructions: 'Ask for a review only after confirming satisfaction.',
      })
    );
    const ai = await runWithTenant({ id: 'opek', timeZone: 'UTC' }, () =>
      getGroupAiSettings(opekGroup.id)
    );
    assert.equal(ai.enabled, true);
    assert.match(ai.instructions, /confirming satisfaction/);

    await runWithTenant({ id: 'opek', timeZone: 'UTC' }, () =>
      deleteCustomAutomationGroup(opekGroup.id)
    );
    const afterDelete = await runWithTenant({ id: 'opek', timeZone: 'UTC' }, () =>
      listCustomAutomationGroups()
    );
    assert.equal(afterDelete.length, 0);
  } finally {
    if (previousFile === undefined) delete process.env.AUTOMATION_RULES_FILE;
    else process.env.AUTOMATION_RULES_FILE = previousFile;
    if (previousStore === undefined) delete process.env.AUTOMATION_RULES_STORE;
    else process.env.AUTOMATION_RULES_STORE = previousStore;
    if (previousAiFile === undefined) delete process.env.AUTOMATION_AI_SETTINGS_FILE;
    else process.env.AUTOMATION_AI_SETTINGS_FILE = previousAiFile;
    await rm(directory, { recursive: true, force: true });
  }
});
