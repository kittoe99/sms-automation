import { Router } from 'express';
import { isCrmAuthConfigured } from '../lib/crmAuth.js';
import { isTenantDataAccessSafe } from '../lib/tenantContext.js';
import { refreshBusinessRegistry } from '../lib/businessAccounts.js';
import { credentialEncryptionKey } from '../lib/credentialVault.js';

export const healthRouter = Router();

healthRouter.get('/health', async (_req, res) => {
  const required = [
    'TWILIO_ACCOUNT_SID',
    'TWILIO_AUTH_TOKEN',
    'SUPABASE_URL',
    'SUPABASE_SERVICE_ROLE_KEY',
    'CLERK_SECRET_KEY',
    'OPEK_SMS_API_KEY',
    'PUBLIC_BASE_URL',
  ];
  const missing =
    process.env.NODE_ENV === 'production'
      ? required.filter((key) => !String(process.env[key] || '').trim())
      : [];
  if (process.env.TENANT_REGISTRY_STORE === 'supabase') {
    try { await refreshBusinessRegistry(); } catch { missing.push('BUSINESS_REGISTRY'); }
    try { credentialEncryptionKey(); } catch { missing.push('TENANT_CREDENTIAL_ENCRYPTION_KEY'); }
    if (!String(process.env.PLATFORM_ADMIN_USER_IDS || '').trim()) missing.push('PLATFORM_ADMIN_USER_IDS');
    if (!String(process.env.TWILIO_PARENT_ACCOUNT_SID || '').trim()) missing.push('TWILIO_PARENT_ACCOUNT_SID');
    if (!String(process.env.TWILIO_PARENT_AUTH_TOKEN || '').trim()) missing.push('TWILIO_PARENT_AUTH_TOKEN');
    if (!String(process.env.DEFAULT_TENANT_CLERK_ORGANIZATION_ID || process.env.DEFAULT_TENANT_CLERK_ORGANIZATION_SLUG || '').trim()) {
      missing.push('DEFAULT_TENANT_CLERK_ORGANIZATION_BINDING');
    }
  }
  if (
    process.env.NODE_ENV === 'production' &&
    !String(process.env.TWILIO_MESSAGING_SERVICE_SID || process.env.TWILIO_FROM_NUMBER || '').trim()
  ) {
    missing.push('TWILIO_MESSAGING_SERVICE_SID_OR_FROM_NUMBER');
  }
  if (
    process.env.NODE_ENV === 'production' &&
    !String(
      process.env.CLERK_PUBLISHABLE_KEY || process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY || ''
    ).trim()
  ) {
    missing.push('CLERK_PUBLISHABLE_KEY');
  }
  if (
    process.env.NODE_ENV === 'production' &&
    String(process.env.CLERK_SECRET_KEY || '').trim() &&
    String(process.env.CLERK_PUBLISHABLE_KEY || process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY || '').trim() &&
    !isCrmAuthConfigured()
  ) {
    missing.push('CLERK_AUTH_ORIGIN_CONFIGURATION');
  }
  if (
    process.env.NODE_ENV === 'production' &&
    process.env.OPEK_SMS_API_KEY &&
    String(process.env.OPEK_SMS_API_KEY).length < 32
  ) {
    missing.push('OPEK_SMS_API_KEY_MIN_32_CHARS');
  }
  if (
    process.env.NODE_ENV === 'production' &&
    process.env.TWILIO_VALIDATE_SIGNATURE === 'false'
  ) {
    missing.push('TWILIO_SIGNATURE_VALIDATION');
  }
  if (process.env.NODE_ENV === 'production' && !isTenantDataAccessSafe()) {
    missing.push('TENANT_DATA_ISOLATION');
  }
  const ok = missing.length === 0;
  res.status(ok ? 200 : 503).json({
    ok,
    service: 'opek-sms',
    brand: 'Opek Junk Removal',
    ts: new Date().toISOString(),
    ...(missing.length ? { missingConfiguration: missing } : {}),
  });
});
