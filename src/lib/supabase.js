import { createClient } from '@supabase/supabase-js';
import { isDatabaseDisconnected } from './dataMode.js';

let client;

export function isSupabaseConfigured() {
  if (isDatabaseDisconnected()) return false;
  const url = String(process.env.SUPABASE_URL || '').trim();
  const key = String(process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
  return Boolean(url && key && !key.includes('your-') && key.length > 20);
}

export function getSupabaseAdmin() {
  if (isDatabaseDisconnected()) throw new Error('Database disconnected');
  if (client) return client;

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required');
  }

  client = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return client;
}
