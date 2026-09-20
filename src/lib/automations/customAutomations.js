import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { CATEGORIES, getCategory } from '../categories.js';
import {
  getBusinessTimeZone,
  constrainToSendWindow,
  getZonedParts,
  zonedDateTimeToUtc,
} from './timeRules.js';
import { getCurrentTenantId } from '../tenantContext.js';
import { getSupabaseAdmin } from '../supabase.js';
import { getGroupAiSettings, listGroupAiSettings } from './groupAiInstructions.js';
import { automationStoreError, usesSharedAutomationStore } from './automationStore.js';
import { CADENCE_PRESETS } from './rulePresets.js';

export { CADENCE_PRESETS } from './rulePresets.js';

const MAX_GROUPS_PER_TENANT = 100;
const DEFAULT_RULES_FILE = path.join(process.cwd(), 'data', 'automation-groups.json');
let writeQueue = Promise.resolve();

function rulesFile() {
  return path.resolve(process.env.AUTOMATION_RULES_FILE || DEFAULT_RULES_FILE);
}

function clean(value, max = 200) {
  return String(value || '').trim().slice(0, max);
}

function slugify(value) {
  return clean(value, 80)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

function inputError(message) {
  const err = new Error(message);
  err.status = 400;
  return err;
}

function integerInRange(value, fallback, min, max) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw inputError(`Value must be a whole number between ${min} and ${max}`);
  }
  return parsed;
}

export function normalizeCustomRule(input = {}) {
  if (input.cadence && !CADENCE_PRESETS[input.cadence]) {
    throw inputError(`Unknown cadence: ${input.cadence}`);
  }
  const cadence = CADENCE_PRESETS[input.cadence] ? input.cadence : 'daily';
  const preset = CADENCE_PRESETS[cadence];
  const intervalCount =
    cadence === 'custom'
      ? integerInRange(input.intervalCount, 1, 1, 365)
      : preset.intervalCount;
  const intervalUnit =
    cadence === 'custom'
      ? input.intervalUnit || 'day'
      : preset.intervalUnit;
  if (!['day', 'week', 'month'].includes(intervalUnit)) {
    throw inputError('Custom interval unit must be day, week, or month');
  }
  const repeatCount = integerInRange(
    input.repeatCount,
    Array.isArray(input.steps) && input.steps.length ? input.steps.length : 1,
    1,
    30
  );
  const template = clean(input.template || input.steps?.[0]?.template, 1600);
  if (!template) throw inputError('At least one message template is required');

  const startHour = integerInRange(input.startHour, 9, 0, 23);
  const endHour = integerInRange(input.endHour, 19, 1, 24);
  if (endHour <= startHour) throw inputError('Send window end must be after its start');

  let firstSendAt = null;
  if (clean(input.firstSendAt, 80)) {
    const rawFirstSend = clean(input.firstSendAt, 80);
    const localMatch = rawFirstSend.match(
      /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::\d{2})?$/
    );
    const parsed = localMatch
      ? zonedDateTimeToUtc(
          {
            y: Number(localMatch[1]),
            m: Number(localMatch[2]),
            d: Number(localMatch[3]),
            hour: Number(localMatch[4]),
            minute: Number(localMatch[5]),
          },
          getBusinessTimeZone()
        )
      : new Date(rawFirstSend);
    if (!parsed || Number.isNaN(parsed.getTime())) {
      throw inputError('First send date and time is invalid');
    }
    if (localMatch) {
      const observed = getZonedParts(parsed, getBusinessTimeZone());
      if (
        !observed ||
        observed.year !== Number(localMatch[1]) ||
        observed.month !== Number(localMatch[2]) ||
        observed.day !== Number(localMatch[3]) ||
        observed.hour !== Number(localMatch[4]) ||
        observed.minute !== Number(localMatch[5])
      ) {
        throw inputError('First send date and time is invalid in the business timezone');
      }
    }
    firstSendAt = parsed.toISOString();
  }

  const sourceSteps = Array.isArray(input.steps) && input.steps.length
    ? input.steps.slice(0, 30)
    : Array.from({ length: repeatCount }, () => ({
        template,
        delayCount: intervalCount,
        delayUnit: intervalUnit,
      }));
  const steps = sourceSteps.map((step, index) => {
    const stepTemplate = clean(step?.template || template, 1600);
    if (!stepTemplate) throw inputError(`Message ${index + 1} cannot be empty`);
    const delayUnit = step?.delayUnit || intervalUnit;
    if (!['day', 'week', 'month'].includes(delayUnit)) {
      throw inputError(`Message ${index + 1} delay unit must be day, week, or month`);
    }
    return {
      id: clean(step?.id, 60) || `send-${index + 1}`,
      template: stepTemplate,
      delayCount: integerInRange(step?.delayCount, intervalCount, 0, 365),
      delayUnit,
    };
  });

  return {
    cadence,
    intervalCount,
    intervalUnit,
    repeatCount: steps.length,
    aiDraft: input.aiDraft !== false,
    template,
    startHour,
    endHour,
    firstSendAt,
    steps,
  };
}

export function cadenceLabel(rule) {
  if (!rule) return 'Not configured';
  if (rule.cadence !== 'custom') return CADENCE_PRESETS[rule.cadence]?.label || 'Custom';
  const unit = rule.intervalUnit === 'day' ? 'day' : rule.intervalUnit;
  return `Every ${rule.intervalCount} ${unit}${rule.intervalCount === 1 ? '' : 's'}`;
}

/** Compute the next calendar-aware send time, then apply the tenant's send window. */
export function computeCustomNextSendAt(
  rule,
  fromDate = new Date(),
  timeZone = getBusinessTimeZone(),
  stepIndex = null
) {
  const from = new Date(fromDate);
  if (!rule || Number.isNaN(from.getTime())) return null;
  const step = stepIndex == null ? null : rule.steps?.[stepIndex];
  const count = Math.max(Number(step?.delayCount ?? rule.intervalCount) || 0, 0);
  const intervalUnit = step?.delayUnit || rule.intervalUnit;
  const local = getZonedParts(from, timeZone);
  if (!local) return null;
  let target;

  if (intervalUnit === 'month') {
    const targetMonth = new Date(Date.UTC(local.year, local.month - 1 + count, 1));
    const endOfTargetMonth = new Date(
      Date.UTC(targetMonth.getUTCFullYear(), targetMonth.getUTCMonth() + 1, 0)
    ).getUTCDate();
    target = {
      y: targetMonth.getUTCFullYear(),
      m: targetMonth.getUTCMonth() + 1,
      d: Math.min(local.day, endOfTargetMonth),
      hour: local.hour,
      minute: local.minute,
    };
  } else {
    const days = intervalUnit === 'week' ? count * 7 : count;
    const targetDay = new Date(Date.UTC(local.year, local.month - 1, local.day + days));
    target = {
      y: targetDay.getUTCFullYear(),
      m: targetDay.getUTCMonth() + 1,
      d: targetDay.getUTCDate(),
      hour: local.hour,
      minute: local.minute,
    };
  }

  const next = zonedDateTimeToUtc(target, timeZone);
  if (!next) return null;

  return constrainToSendWindow(next, {
    timeZone,
    startHour: rule.startHour,
    endHour: rule.endHour,
  });
}

export function computeCustomFirstSendAt(
  rule,
  enrolledAt = new Date(),
  now = new Date(),
  timeZone = getBusinessTimeZone()
) {
  const enrolled = new Date(enrolledAt);
  const current = new Date(now);
  if (Number.isNaN(enrolled.getTime()) || Number.isNaN(current.getTime())) return null;
  let first;
  if (rule.firstSendAt) {
    const scheduled = new Date(rule.firstSendAt);
    if (Number.isNaN(scheduled.getTime())) return null;
    first = scheduled.getTime() > current.getTime() ? scheduled : current;
  } else {
    first = computeCustomNextSendAt(rule, enrolled, timeZone, 0);
  }
  return constrainToSendWindow(first, {
    timeZone,
    startHour: rule.startHour,
    endHour: rule.endHour,
  });
}

export function seedCustomDrip(enrollment, group, now = new Date()) {
  const enrolledAt = enrollment?.enrolled_at || enrollment?.created_at || now;
  const next = computeCustomFirstSendAt(group.rule, enrolledAt, now);
  return {
    ...(enrollment?.metadata || {}),
    drip: {
      ...(enrollment?.metadata?.drip || {}),
      sequenceId: group.id,
      ruleVersion: group.updatedAt,
      stepIndex: 0,
      nextSendAt: next?.toISOString() || null,
      lastSentAt: null,
      status: 'active',
      pauseReason: null,
    },
  };
}

export function advanceCustomDrip(enrollment, group, sentAt = new Date()) {
  const metadata = enrollment?.metadata || {};
  const drip = metadata.drip || {};
  const nextStep = (Number(drip.stepIndex) || 0) + 1;
  if (nextStep >= group.rule.repeatCount) {
    return {
      completed: true,
      metadata: {
        ...metadata,
        drip: {
          ...drip,
          ruleVersion: group.updatedAt,
          stepIndex: nextStep,
          nextSendAt: null,
          lastSentAt: sentAt.toISOString(),
          status: 'completed',
          completedReason: 'sequence_finished',
        },
      },
    };
  }

  return {
    completed: false,
    metadata: {
      ...metadata,
      drip: {
        ...drip,
        ruleVersion: group.updatedAt,
        stepIndex: nextStep,
        nextSendAt:
          computeCustomNextSendAt(group.rule, sentAt, getBusinessTimeZone(), nextStep)?.toISOString() ||
          null,
        lastSentAt: sentAt.toISOString(),
        status: 'active',
      },
    },
  };
}

function normalizeStoredGroup(group) {
  if (!group || typeof group !== 'object') return null;
  try {
    const name = clean(group.name, 100);
    const id = clean(group.id, 100);
    const tenantId = clean(group.tenantId || group.tenant_id, 64);
    if (!name || !id || !tenantId || !id.startsWith('custom-')) return null;
    return {
      id,
      tenantId,
      name,
      description: clean(group.description, 300),
      activeAutomation: (group.activeAutomation ?? group.active) !== false,
      custom: true,
      system: false,
      rule: normalizeCustomRule(group.rule),
      createdAt: group.createdAt || group.created_at || new Date().toISOString(),
      updatedAt: group.updatedAt || group.updated_at || new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

async function readRegistry() {
  if (usesSharedAutomationStore()) {
    const { data, error } = await getSupabaseAdmin()
      .from('sms_automation_groups')
      .select('*')
      .order('created_at', { ascending: true });
    if (error) throw automationStoreError('automation', error);
    return {
      version: 1,
      groups: (data || []).map(normalizeStoredGroup).filter(Boolean),
    };
  }
  try {
    const parsed = JSON.parse(await readFile(rulesFile(), 'utf8'));
    return {
      version: 1,
      groups: (Array.isArray(parsed?.groups) ? parsed.groups : [])
        .map(normalizeStoredGroup)
        .filter(Boolean),
    };
  } catch (err) {
    if (err.code === 'ENOENT') return { version: 1, groups: [] };
    throw new Error(`Automation rule registry could not be read: ${err.message}`);
  }
}

async function writeRegistry(registry, changedGroup = null) {
  if (usesSharedAutomationStore()) {
    const groups = changedGroup ? [changedGroup] : registry.groups;
    const rows = groups.map((group) => ({
      tenant_id: group.tenantId,
      id: group.id,
      name: group.name,
      description: group.description || '',
      active: group.activeAutomation,
      rule: group.rule,
      created_at: group.createdAt,
      updated_at: group.updatedAt,
    }));
    if (!rows.length) return;
    const { error } = await getSupabaseAdmin()
      .from('sms_automation_groups')
      .upsert(rows, { onConflict: 'tenant_id,id' });
    if (error) throw automationStoreError('automation', error);
    return;
  }
  const file = rulesFile();
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(registry, null, 2)}\n`, 'utf8');
}

async function deleteStoredGroup(group, registry) {
  if (usesSharedAutomationStore()) {
    const { error } = await getSupabaseAdmin()
      .from('sms_automation_groups')
      .delete()
      .eq('tenant_id', group.tenantId)
      .eq('id', group.id);
    if (error) throw automationStoreError('automation', error);
    return;
  }
  await writeRegistry(registry);
}

function serializeWrite(operation) {
  const result = writeQueue.then(operation, operation);
  writeQueue = result.catch(() => {});
  return result;
}

export async function listCustomAutomationGroups({ tenantId = getCurrentTenantId() } = {}) {
  const registry = await readRegistry();
  return registry.groups.filter((group) => group.tenantId === tenantId);
}

export async function listAllActiveCustomAutomationGroups() {
  const registry = await readRegistry();
  return registry.groups.filter((group) => group.activeAutomation);
}

export async function listAutomationGroups() {
  const [custom, aiSettings] = await Promise.all([
    listCustomAutomationGroups(),
    listGroupAiSettings(),
  ]);
  const groups = [
    ...CATEGORIES.map((group) => ({ ...group, custom: false, system: true, rule: null })),
    ...custom,
  ];
  return groups.map((group) => ({
    ...group,
    ai:
      aiSettings.find((setting) => setting.groupId === group.id) || {
        enabled: false,
        instructions: '',
        updatedAt: null,
      },
  }));
}

export async function getAutomationGroup(id) {
  const system = getCategory(id);
  if (system) {
    return {
      ...system,
      custom: false,
      system: true,
      rule: null,
      ai: await getGroupAiSettings(id),
    };
  }
  const custom = await listCustomAutomationGroups();
  const group = custom.find((item) => item.id === id);
  return group ? { ...group, ai: await getGroupAiSettings(id) } : null;
}

export async function createCustomAutomationGroup(input = {}) {
  return serializeWrite(async () => {
    const registry = await readRegistry();
    const tenantId = getCurrentTenantId();
    const tenantGroups = registry.groups.filter((group) => group.tenantId === tenantId);
    if (tenantGroups.length >= MAX_GROUPS_PER_TENANT) {
      throw inputError(`A business account can have at most ${MAX_GROUPS_PER_TENANT} custom groups`);
    }
    const name = clean(input.name, 100);
    if (!name) throw inputError('Group name is required');
    const base = slugify(name) || 'automation';
    const id = `custom-${tenantId}-${base}-${randomUUID().slice(0, 8)}`;
    const now = new Date().toISOString();
    const rule = normalizeCustomRule(input.rule);
    const group = normalizeStoredGroup({
      id,
      tenantId,
      name,
      description: input.description,
      activeAutomation: input.activeAutomation !== false,
      rule,
      createdAt: now,
      updatedAt: now,
    });
    registry.groups.push(group);
    await writeRegistry(registry, group);
    return group;
  });
}

export async function updateCustomAutomationGroup(id, input = {}) {
  return serializeWrite(async () => {
    const registry = await readRegistry();
    const tenantId = getCurrentTenantId();
    const index = registry.groups.findIndex(
      (group) => group.id === id && group.tenantId === tenantId
    );
    if (index < 0) {
      const err = new Error('Custom automation group not found');
      err.status = 404;
      throw err;
    }
    const current = registry.groups[index];
    const name = clean(input.name ?? current.name, 100);
    if (!name) throw inputError('Group name is required');
    const rule = normalizeCustomRule(input.rule ?? current.rule);
    const next = normalizeStoredGroup({
      ...current,
      name,
      description: input.description ?? current.description,
      activeAutomation: input.activeAutomation ?? current.activeAutomation,
      rule,
      updatedAt: new Date().toISOString(),
    });
    registry.groups[index] = next;
    await writeRegistry(registry, next);
    return next;
  });
}

export async function deleteCustomAutomationGroup(id) {
  return serializeWrite(async () => {
    const registry = await readRegistry();
    const tenantId = getCurrentTenantId();
    const index = registry.groups.findIndex(
      (group) => group.id === id && group.tenantId === tenantId
    );
    if (index < 0) {
      const err = new Error('Custom automation group not found');
      err.status = 404;
      throw err;
    }
    const [removed] = registry.groups.splice(index, 1);
    await deleteStoredGroup(removed, registry);
    return removed;
  });
}

export function customGroupToSequence(group) {
  if (!group?.rule) return null;
  return {
    id: group.id,
    categoryId: group.id,
    name: group.name,
    description: `${group.rule.firstSendAt ? 'Scheduled start' : cadenceLabel(group.rule)} · ${group.rule.repeatCount} send${
      group.rule.repeatCount === 1 ? '' : 's'
    } · ${group.rule.startHour}:00–${group.rule.endHour}:00`,
    custom: true,
    rule: group.rule,
    steps: group.rule.steps.map((step, index) => ({
      index,
      id: step.id || `send-${index + 1}`,
      label: `${index === 0 && group.rule.firstSendAt ? 'Scheduled' : `After ${step.delayCount} ${step.delayUnit}${step.delayCount === 1 ? '' : 's'}`} · send ${index + 1} of ${group.rule.repeatCount}`,
      template: step.template,
      delayCount: step.delayCount,
      delayUnit: step.delayUnit,
    })),
  };
}
