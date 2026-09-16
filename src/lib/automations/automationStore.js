import { isSupabaseConfigured } from '../supabase.js';

export function usesSharedAutomationStore() {
  return process.env.AUTOMATION_RULES_STORE === 'supabase' && isSupabaseConfigured();
}

export function automationStoreError(area, error) {
  const err = new Error(
    `Shared ${area} registry is unavailable: ${error.message}. Apply supabase/migrations/20260910_sms_automation_groups.sql.`
  );
  err.status = 503;
  return err;
}
