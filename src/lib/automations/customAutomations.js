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
import { CADENCE_PRESETS, AUTOMATION_RULE_PRESETS } from './rulePresets.js';
import { normalizeSchedule, calendarDelay } from './schedule.js';

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
  try { return normalizeSchedule(input); }
  catch (error) { throw inputError(error.message); }
}

export function cadenceLabel(rule) {
  if (!rule) return 'Not configured';
  return `Every ${rule.intervalCount} ${rule.intervalUnit}${rule.intervalCount === 1 ? '' : 's'}`;
}
export function computeCustomNextSendAt(rule, fromDate = new Date(), timeZone = getBusinessTimeZone(), stepIndex = null) {
  const first = stepIndex === 0;
  const count = first ? rule.firstDelayCount : rule.intervalCount;
  const unit = first ? rule.firstDelayUnit : rule.intervalUnit;
  const due = calendarDelay(fromDate, count, unit, timeZone);
  return constrainToSendWindow(due, { timeZone, startHour: rule.startHour, endHour: rule.endHour });
}

export function computeCustomFirstSendAt(rule, enrolledAt = new Date(), now = new Date(), timeZone = getBusinessTimeZone()) {
  const first = computeCustomNextSendAt(rule, enrolledAt, timeZone, 0);
  return first && first > now ? first : constrainToSendWindow(now, {
    timeZone, startHour: rule.startHour, endHour: rule.endHour,
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
      intent: clean(group.intent, 1600),
      activeAutomation: (group.activeAutomation ?? group.active) !== false && Boolean(clean(group.intent, 1600)),
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
    const [groups, intents] = await Promise.all([
      getSupabaseAdmin().from('sms_automation_groups').select('*').order('created_at', { ascending: true }),
      getSupabaseAdmin().from('sms_automation_intents').select('tenant_id,group_id,intent'),
    ]);
    if (groups.error || intents.error) throw automationStoreError('automation', groups.error || intents.error);
    const intentMap = new Map((intents.data || []).map(row => [`${row.tenant_id}:${row.group_id}`, row.intent]));
    return {
      version: 1,
      groups: (groups.data || []).map(row => normalizeStoredGroup({ ...row, intent: intentMap.get(`${row.tenant_id}:${row.id}`) })).filter(Boolean),
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
    const { error: intentError } = await getSupabaseAdmin().from('sms_automation_intents')
      .upsert(groups.map(group => ({ tenant_id: group.tenantId, group_id: group.id, intent: group.intent })), { onConflict: 'tenant_id,group_id' });
    if (intentError) throw automationStoreError('automation', intentError);
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
  const quotePreset = AUTOMATION_RULE_PRESETS.find(preset => preset.id === 'quote-followup');
  const groups = [
    ...CATEGORIES.map((group) => ({
      ...group, custom: false, system: true,
      intent: group.kind === 'quote' ? quotePreset.intent : group.kind === 'reminder' ?
        'Remind the customer of the confirmed appointment using its actual local date and time.' : null,
      rule: group.kind === 'quote' ? quotePreset.rule : group.kind === 'reminder' ? {
        anchor: 'appointment', firstDelayCount: 0, firstDelayUnit: 'day', intervalCount: 6,
        intervalUnit: 'hour', repeatCount: 1, leadHours: 24, startHour: 0, endHour: 24,
      } : null,
    })),
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
    return (await listAutomationGroups()).find(group => group.id === id) || null;
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
    const intent = clean(input.intent, 1600);
    if (!intent || /\{\{/.test(intent)) throw inputError('One automation intent is required');
    const group = normalizeStoredGroup({
      id,
      tenantId,
      name,
      description: input.description,
      intent,
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
    const intent = clean(input.intent ?? current.intent, 1600);
    if (!intent || /\{\{/.test(intent)) throw inputError('One automation intent is required');
    const next = normalizeStoredGroup({
      ...current,
      name,
      description: input.description ?? current.description,
      intent,
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
    description: `${cadenceLabel(group.rule)} · ${group.rule.repeatCount} send${
      group.rule.repeatCount === 1 ? '' : 's'
    } · ${group.rule.startHour}:00–${group.rule.endHour}:00`,
    custom: true,
    intent: group.intent,
    rule: group.rule,
  };
}
