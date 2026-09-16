import { getSupabaseAdmin, isSupabaseConfigured } from './supabase.js';
import { decryptTwilioCredentials } from './credentialVault.js';
import { defaultTenantFromEnv, findTenant, setStoredTenantAccounts } from './tenantContext.js';

export function businessError(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  error.expose = true;
  return error;
}

export function normalizeNewBusiness(input = {}) {
  const id = String(input.id || '').trim();
  const name = String(input.name || '').trim();
  const organizationId = String(input.clerkOrganizationId || '').trim();
  const timeZone = String(input.timeZone || 'America/Denver').trim();
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(id)) throw businessError('A lowercase business id (1–64 letters, numbers, _ or -) is required');
  if (!name || name.length > 100) throw businessError('Business name must contain 1–100 characters');
  if (!/^org_[A-Za-z0-9]+$/.test(organizationId)) throw businessError('A Clerk organization id is required');
  if (id === defaultTenantFromEnv().id || findTenant(id)) throw businessError('Business id is already configured', 409);
  try { new Intl.DateTimeFormat('en-US', { timeZone }); } catch { throw businessError('A valid IANA time zone is required'); }
  return {
    id,
    name,
    short_name: String(input.shortName || name).trim().slice(0, 40),
    time_zone: timeZone,
    clerk_organization_id: organizationId,
    // Provisioning is allowed before registration/data isolation; operations are not.
    status: 'pending',
    twilio_state: 'not_provisioned',
  };
}

export function publicBusiness(row) {
  return {
    id: row.id,
    name: row.name,
    shortName: row.short_name,
    timeZone: row.time_zone,
    clerkOrganizationId: row.clerk_organization_id,
    status: row.status,
    twilio: {
      state: row.twilio_state,
      accountSid: row.twilio_account_sid || null,
      messagingServiceSid: row.twilio_messaging_service_sid || null,
      fromNumber: row.twilio_from_number || null,
      lastErrorCode: row.twilio_error_code || null,
    },
  };
}

function registryAdmin() {
  if (process.env.TENANT_REGISTRY_STORE !== 'supabase' || !isSupabaseConfigured()) {
    throw businessError('Set TENANT_REGISTRY_STORE=supabase and apply the business registry migration', 503);
  }
  return getSupabaseAdmin();
}

function checkError(error) {
  if (!error) return;
  if (error.code === '23505') throw businessError('Business, Clerk organization, or Twilio account already exists', 409);
  throw businessError('Business registry unavailable; apply supabase/migrations/20260916_sms_business_accounts.sql', 503);
}

/** Used only by platform administrators; never return these raw rows to a browser. */
export const businessAccountStore = {
  async list() {
    const rows = [];
    // Explicit pagination avoids silently losing tenants at PostgREST's row cap.
    for (let offset = 0; ; offset += 500) {
      const { data, error } = await registryAdmin().from('sms_business_accounts')
        .select('*').order('id').range(offset, offset + 499);
      checkError(error);
      rows.push(...(data || []));
      if (!data || data.length < 500) return rows;
    }
  },
  async get(id) {
    const { data, error } = await registryAdmin().from('sms_business_accounts').select('*').eq('id', id).maybeSingle();
    checkError(error);
    return data;
  },
  async create(input) {
    const { data, error } = await registryAdmin().from('sms_business_accounts').insert(normalizeNewBusiness(input)).select('*').single();
    checkError(error);
    return data;
  },
  async transition(id, expectedState, changes) {
    const { data, error } = await registryAdmin().from('sms_business_accounts')
      .update({ ...changes, updated_at: new Date().toISOString() })
      .eq('id', id).eq('twilio_state', expectedState).select('*').maybeSingle();
    checkError(error);
    if (!data) throw businessError('Provisioning state changed; refresh before retrying', 409);
    return data;
  },
};

let refreshPromise;
let refreshedAt = 0;

export async function refreshBusinessRegistry({ force = false } = {}) {
  if (process.env.TENANT_REGISTRY_STORE !== 'supabase') return;
  if (refreshPromise) return refreshPromise;
  if (!force && Date.now() - refreshedAt < 10_000) return;
  refreshPromise = (async () => {
    const rows = await businessAccountStore.list();
    const accounts = rows.map((row) => ({
      id: row.id,
      name: row.name,
      shortName: row.short_name,
      timeZone: row.time_zone,
      status: row.status,
      clerkOrganizationId: row.clerk_organization_id,
      phoneNumbers: [row.twilio_from_number].filter(Boolean),
      twilio: row.status === 'active' && row.twilio_credentials_encrypted ? {
        ...decryptTwilioCredentials(row.id, row.twilio_account_sid, row.twilio_credentials_encrypted),
        accountSid: row.twilio_account_sid,
        messagingServiceSid: row.twilio_messaging_service_sid,
        fromNumber: row.twilio_from_number,
      } : null,
    }));
    setStoredTenantAccounts(accounts);
    refreshedAt = Date.now();
  })();
  try { await refreshPromise; } finally { refreshPromise = null; }
}

export function businessRegistryMiddleware(_req, res, next) {
  refreshBusinessRegistry().then(() => next()).catch(() =>
    res.status(503).json({ error: 'Business registry unavailable' })
  );
}
