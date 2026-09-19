import { AsyncLocalStorage } from 'node:async_hooks';
import { canManageLocalBusinesses } from './dataMode.js';

const tenantStorage = new AsyncLocalStorage();
let warnedAboutInvalidConfig = false;
let storedAccounts = [];

function cleanId(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

function normalizePhone(value) {
  return String(value || '').replace(/\D/g, '').slice(-10);
}

function normalizeAccount(value, fallback = {}) {
  if (!value || typeof value !== 'object') return null;
  const id = cleanId(value.id || fallback.id);
  if (!id) return null;

  const name = String(value.name || fallback.name || id).trim().slice(0, 100);
  const shortName = String(value.shortName || fallback.shortName || name)
    .trim()
    .slice(0, 40);
  const timeZone = String(value.timeZone || fallback.timeZone || 'America/Denver').trim();
  const sameAsFallback = id === fallback.id;
  const phoneNumbers = Array.isArray(value.phoneNumbers)
    ? value.phoneNumbers.map(normalizePhone).filter(Boolean)
    : sameAsFallback && Array.isArray(fallback.phoneNumbers)
      ? [...fallback.phoneNumbers]
      : [];

  return {
    id,
    name,
    shortName,
    timeZone,
    status: value.status && value.status !== 'active' ? 'inactive' : 'active',
    phoneNumbers,
    clerkOrganizationId: String(
      value.clerkOrganizationId || (sameAsFallback ? fallback.clerkOrganizationId : '') || ''
    ).trim() || null,
    clerkOrganizationSlug: String(
      value.clerkOrganizationSlug || (sameAsFallback ? fallback.clerkOrganizationSlug : '') || ''
    ).trim().toLowerCase() || null,
    twilio: value.twilio && typeof value.twilio === 'object' ? { ...value.twilio } : null,
    integrationApiKey: String(value.integrationApiKey || '').trim() || null,
  };
}

/** Server-only snapshot loaded from the encrypted business registry. */
export function setStoredTenantAccounts(accounts) {
  storedAccounts = accounts.map((account) => normalizeAccount(account)).filter(Boolean);
}

export function defaultTenantFromEnv(env = process.env) {
  return normalizeAccount({
    id: env.DEFAULT_TENANT_ID || 'opek',
    name: env.DEFAULT_TENANT_NAME || 'Opek Junk Removal',
    shortName: env.DEFAULT_TENANT_SHORT_NAME || 'Opek',
    timeZone: env.BUSINESS_TIME_ZONE || 'America/Denver',
    phoneNumbers: [env.TWILIO_FROM_NUMBER].filter(Boolean),
    clerkOrganizationId: env.DEFAULT_TENANT_CLERK_ORGANIZATION_ID,
    clerkOrganizationSlug: env.DEFAULT_TENANT_CLERK_ORGANIZATION_SLUG,
  });
}

export function parseTenantAccounts(raw, fallback = defaultTenantFromEnv()) {
  let configured = [];
  if (String(raw || '').trim()) {
    const decoded = JSON.parse(String(raw));
    if (!Array.isArray(decoded)) throw new Error('TENANT_ACCOUNTS_JSON must be a JSON array');
    configured = decoded.map((account) => normalizeAccount(account, fallback)).filter(Boolean);
  }

  const byId = new Map([[fallback.id, fallback]]);
  for (const account of configured) byId.set(account.id, account);
  return [...byId.values()].filter((account) => account.status === 'active');
}

export function listTenants() {
  try {
    const configured = parseTenantAccounts(process.env.TENANT_ACCOUNTS_JSON, defaultTenantFromEnv());
    const byId = new Map(configured.map((account) => [account.id, account]));
    for (const account of storedAccounts) {
      if (account.status === 'active') byId.set(account.id, account);
      else byId.delete(account.id);
    }
    return [...byId.values()];
  } catch (err) {
    if (!warnedAboutInvalidConfig) {
      warnedAboutInvalidConfig = true;
      console.error('[opek-sms] invalid tenant configuration; using the default account', err.message);
    }
    return [defaultTenantFromEnv()];
  }
}

export function toPublicTenant(tenant) {
  return {
    id: tenant.id,
    name: tenant.name,
    shortName: tenant.shortName,
    timeZone: tenant.timeZone,
    status: tenant.status,
  };
}

export function getDefaultTenant() {
  const fallbackId = defaultTenantFromEnv().id;
  const tenants = listTenants();
  return tenants.find((tenant) => tenant.id === fallbackId) || tenants[0];
}

export function findTenant(tenantId) {
  const id = cleanId(tenantId);
  if (!id) return null;
  return listTenants().find((tenant) => tenant.id === id) || null;
}

/**
 * Bind a business account to the active Clerk organization. A single legacy
 * account may omit the mapping; multiple accounts must each declare one.
 */
export function tenantMatchesClerkAuth(tenant, auth) {
  if (!tenant || !auth?.userId) return false;
  const expectedId = String(tenant.clerkOrganizationId || '').trim();
  const expectedSlug = String(tenant.clerkOrganizationSlug || '').trim().toLowerCase();
  if (expectedId && auth.orgId !== expectedId) return false;
  if (expectedSlug && String(auth.orgSlug || '').toLowerCase() !== expectedSlug) return false;
  if (expectedId || expectedSlug) return true;
  return listTenants().length === 1 && storedAccounts.length === 0 &&
    process.env.TENANT_REGISTRY_STORE !== 'supabase';
}

export function resolveTenantForPhone(phone) {
  const normalized = normalizePhone(phone);
  if (normalized) {
    const match = listTenants().find((tenant) => tenant.phoneNumbers.includes(normalized));
    if (match) return match;
  }
  return listTenants().length === 1 ? getDefaultTenant() : null;
}

/** AccountSid is Twilio's business boundary; never route unknown accounts by customer phone. */
export function resolveTenantForTwilioAccount(accountSid) {
  const sid = String(accountSid || '').trim();
  if (!sid) return null;
  const matches = listTenants().filter((tenant) => {
    const configuredSid = tenant.twilio?.accountSid ||
      (tenant.id === defaultTenantFromEnv().id ? process.env.TWILIO_ACCOUNT_SID : '');
    return configuredSid === sid;
  });
  return matches.length === 1 ? matches[0] : null;
}

export function runWithTenant(tenant, callback) {
  return tenantStorage.run({ tenant: tenant || getDefaultTenant() }, callback);
}

export function getCurrentTenant() {
  return tenantStorage.getStore()?.tenant || getDefaultTenant();
}

export function getCurrentTenantId() {
  return getCurrentTenant().id;
}

/**
 * Persisted message, contact, enrollment, and voice tables are still shared.
 * Refuse to activate multiple configured accounts until every data path and user
 * membership check is tenant-scoped; otherwise a request-selected tenant would
 * only change labels while exposing the same underlying records.
 */
export function isTenantDataAccessSafe() {
  // Multiple empty local workspaces have no customer records or provider actions.
  if (canManageLocalBusinesses()) return true;
  return listTenants().length <= 1 ||
    (TENANT_CAPABILITIES.databaseIsolation &&
      TENANT_CAPABILITIES.membershipAuthorization &&
      TENANT_CAPABILITIES.providerCredentialsPerTenant);
}

export function assertTenantDataAccessSafe() {
  if (isTenantDataAccessSafe()) return;
  const err = new Error(
    'Multiple business accounts cannot be activated until tenant database isolation, memberships, and provider credentials are implemented.'
  );
  err.code = 'TENANT_ISOLATION_REQUIRED';
  err.status = 503;
  throw err;
}

export function requireTenantDataIsolation(_req, res, next) {
  try {
    assertTenantDataAccessSafe();
    return next();
  } catch (err) {
    return res.status(err.status || 503).json({
      error: 'Multi-tenant data access is not ready',
      detail: err.message,
    });
  }
}

/**
 * Selects a configured tenant for this request. Clerk organization membership is
 * enforced by requireCrmAuth; database RLS and provider isolation remain deferred.
 */
export function tenantContextMiddleware(req, res, next) {
  const requestedId = String(req.get('X-Tenant-ID') || '').trim();
  const tenant = requestedId ? findTenant(requestedId) : getDefaultTenant();
  if (!tenant) {
    return res.status(400).json({
      error: 'Unknown business account',
      detail: `No configured tenant matches ${requestedId}.`,
    });
  }

  req.tenant = tenant;
  res.setHeader('X-Tenant-ID', tenant.id);
  return runWithTenant(tenant, next);
}

export const TENANT_CAPABILITIES = Object.freeze({
  accountSelection: true,
  requestContext: true,
  realtimeIsolation: true,
  databaseIsolation: false,
  membershipAuthorization: true,
  providerCredentialsPerTenant: false,
  twilioSubaccountProvisioning: true,
  twilioCredentialsPerTenant: true,
});
