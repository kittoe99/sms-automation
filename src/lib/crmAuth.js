/**
 * CRM UI auth: Supabase JWT + allowlist in public.crm_admins (invite-only).
 * Server-to-server routes keep using requireApiKey separately.
 */

import { getSupabaseAdmin, isSupabaseConfigured } from './supabase.js';

export function getSupabaseAnonKey() {
  return String(
    process.env.SUPABASE_ANON_KEY ||
      process.env.SUPABASE_PUBLISHABLE_KEY ||
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
      ''
  ).trim();
}

export function isCrmAuthConfigured() {
  return (
    isSupabaseConfigured() &&
    Boolean(String(process.env.SUPABASE_URL || '').trim()) &&
    Boolean(getSupabaseAnonKey())
  );
}

/**
 * @param {string} email
 */
export async function isAllowedCrmEmail(email) {
  const normalized = String(email || '')
    .trim()
    .toLowerCase();
  if (!normalized) return false;
  if (!isSupabaseConfigured()) return false;

  const { data, error } = await getSupabaseAdmin()
    .from('crm_admins')
    .select('email')
    .eq('email', normalized)
    .maybeSingle();

  if (error) {
    console.error('[opek-sms] crm_admins lookup failed', error.message);
    return false;
  }
  return Boolean(data?.email);
}

/**
 * Verify Bearer access token and allowlist membership.
 * @returns {Promise<{ userId: string, email: string, accessToken: string }|null>}
 */
export async function verifyCrmAccessToken(accessToken) {
  if (!accessToken || !isSupabaseConfigured()) return null;

  const admin = getSupabaseAdmin();
  const { data, error } = await admin.auth.getUser(accessToken);
  if (error || !data?.user?.email) return null;

  const email = String(data.user.email).trim().toLowerCase();
  if (!(await isAllowedCrmEmail(email))) return null;

  return {
    userId: data.user.id,
    email,
    accessToken,
  };
}

function extractBearer(req) {
  const auth = String(req.headers.authorization || '').trim();
  if (auth.toLowerCase().startsWith('bearer ')) {
    return auth.slice('bearer '.length).trim();
  }
  return '';
}

/**
 * Express middleware — requires invite-listed CRM user session.
 */
export async function requireCrmAuth(req, res, next) {
  try {
    if (!isCrmAuthConfigured()) {
      return res.status(503).json({
        error: 'CRM auth not configured',
        detail: 'Set SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, and SUPABASE_ANON_KEY.',
      });
    }

    const token = extractBearer(req);
    if (!token) {
      return res.status(401).json({ error: 'Unauthorized', detail: 'Sign in required' });
    }

    const user = await verifyCrmAccessToken(token);
    if (!user) {
      return res.status(403).json({
        error: 'Forbidden',
        detail: 'This account is not invited to the SMS CRM.',
      });
    }

    req.crmUser = user;
    return next();
  } catch (err) {
    console.error('[opek-sms] requireCrmAuth failed', err);
    return res.status(500).json({ error: 'Auth check failed' });
  }
}

/**
 * Invite an email: add to crm_admins + send Supabase invite email.
 */
export async function inviteCrmUser(email, { invitedBy = null } = {}) {
  const normalized = String(email || '')
    .trim()
    .toLowerCase();
  if (!normalized || !normalized.includes('@')) {
    const err = new Error('Valid email is required');
    err.status = 400;
    throw err;
  }

  const admin = getSupabaseAdmin();
  const { error: upsertErr } = await admin.from('crm_admins').upsert(
    { email: normalized },
    { onConflict: 'email' }
  );
  if (upsertErr) throw upsertErr;

  const redirectTo = String(process.env.PUBLIC_BASE_URL || '')
    .trim()
    .replace(/\/$/, '');

  const { data, error } = await admin.auth.admin.inviteUserByEmail(normalized, {
    redirectTo: redirectTo || undefined,
    data: {
      invited_by: invitedBy || null,
      app: 'opek-sms-crm',
    },
  });

  if (error) {
    // Already registered is OK — allowlist alone is enough for login.
    const msg = String(error.message || '').toLowerCase();
    if (msg.includes('already') || msg.includes('registered')) {
      return {
        email: normalized,
        invited: false,
        alreadyRegistered: true,
        message: 'Email already has an account; added to CRM allowlist.',
      };
    }
    throw error;
  }

  return {
    email: normalized,
    invited: true,
    alreadyRegistered: false,
    userId: data?.user?.id || null,
    message: 'Invite sent. They must accept the email to set a password.',
  };
}
