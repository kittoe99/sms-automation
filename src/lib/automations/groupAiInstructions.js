import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { getSupabaseAdmin } from '../supabase.js';
import { getCurrentTenantId } from '../tenantContext.js';
import { automationStoreError, usesSharedAutomationStore } from './automationStore.js';

const DEFAULT_FILE = path.join(process.cwd(), 'data', 'automation-ai-instructions.json');
let writeQueue = Promise.resolve();

function settingsFile() {
  return path.resolve(process.env.AUTOMATION_AI_SETTINGS_FILE || DEFAULT_FILE);
}

function normalize(row) {
  if (!row) return null;
  const tenantId = String(row.tenantId || row.tenant_id || '').trim();
  const groupId = String(row.groupId || row.group_id || '').trim();
  if (!tenantId || !groupId) return null;
  return {
    tenantId,
    groupId,
    enabled: row.enabled === true,
    instructions: String(row.instructions || '').trim().slice(0, 6000),
    updatedAt: row.updatedAt || row.updated_at || null,
  };
}

async function readAll() {
  if (usesSharedAutomationStore()) {
    const { data, error } = await getSupabaseAdmin()
      .from('sms_automation_group_ai_settings')
      .select('*');
    if (error) throw automationStoreError('AI instruction', error);
    return (data || []).map(normalize).filter(Boolean);
  }
  try {
    const parsed = JSON.parse(await readFile(settingsFile(), 'utf8'));
    return (Array.isArray(parsed?.settings) ? parsed.settings : []).map(normalize).filter(Boolean);
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw new Error(`AI instruction registry could not be read: ${err.message}`);
  }
}

export async function listGroupAiSettings({ tenantId = getCurrentTenantId() } = {}) {
  return (await readAll()).filter((item) => item.tenantId === tenantId);
}

export async function getGroupAiSettings(groupId) {
  const settings = await listGroupAiSettings();
  return (
    settings.find((item) => item.groupId === groupId) || {
      tenantId: getCurrentTenantId(),
      groupId,
      enabled: false,
      instructions: '',
      updatedAt: null,
    }
  );
}

export function normalizeGroupAiSettingsInput(input = {}) {
  const rawInstructions = String(input.instructions || '').trim();
  if (rawInstructions.length > 6000) {
    const err = new Error('AI instructions cannot exceed 6000 characters');
    err.status = 400;
    throw err;
  }
  const instructions = rawInstructions;
  const enabled = input.enabled === true;
  if (enabled && !instructions) {
    const err = new Error('AI instructions are required when group AI is enabled');
    err.status = 400;
    throw err;
  }
  return { enabled, instructions };
}

export async function saveGroupAiSettings(groupId, input = {}) {
  const { enabled, instructions } = normalizeGroupAiSettingsInput(input);
  const setting = {
    tenantId: getCurrentTenantId(),
    groupId: String(groupId || '').trim(),
    enabled,
    instructions,
    updatedAt: new Date().toISOString(),
  };
  if (!setting.groupId) {
    const err = new Error('Group id is required');
    err.status = 400;
    throw err;
  }

  if (usesSharedAutomationStore()) {
    const { error } = await getSupabaseAdmin()
      .from('sms_automation_group_ai_settings')
      .upsert(
        {
          tenant_id: setting.tenantId,
          group_id: setting.groupId,
          enabled: setting.enabled,
          instructions: setting.instructions,
          updated_at: setting.updatedAt,
        },
        { onConflict: 'tenant_id,group_id' }
      );
    if (error) throw automationStoreError('AI instruction', error);
    return setting;
  }

  const operation = async () => {
    const all = await readAll();
    const index = all.findIndex(
      (item) => item.tenantId === setting.tenantId && item.groupId === setting.groupId
    );
    if (index >= 0) all[index] = setting;
    else all.push(setting);
    const file = settingsFile();
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, `${JSON.stringify({ version: 1, settings: all }, null, 2)}\n`, 'utf8');
    return setting;
  };
  const result = writeQueue.then(operation, operation);
  writeQueue = result.catch(() => {});
  return result;
}

export async function deleteGroupAiSettings(groupId) {
  const tenantId = getCurrentTenantId();
  if (usesSharedAutomationStore()) {
    const { error } = await getSupabaseAdmin()
      .from('sms_automation_group_ai_settings')
      .delete()
      .eq('tenant_id', tenantId)
      .eq('group_id', groupId);
    if (error) throw automationStoreError('AI instruction', error);
    return;
  }
  const operation = async () => {
    const all = await readAll();
    const remaining = all.filter(
      (item) => !(item.tenantId === tenantId && item.groupId === groupId)
    );
    const file = settingsFile();
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, `${JSON.stringify({ version: 1, settings: remaining }, null, 2)}\n`, 'utf8');
  };
  const result = writeQueue.then(operation, operation);
  writeQueue = result.catch(() => {});
  return result;
}
