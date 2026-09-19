/**
 * CRM UI authentication through Clerk.
 *
 * Clerk verifies the session; tenantContext maps the active Clerk organization
 * to the business account selected for the request.
 */

import { getAuth, verifyToken } from '@clerk/express';
import { tenantMatchesClerkAuth } from './tenantContext.js';

export function isLocalAuthDisabled(env = process.env) {
  return env.NODE_ENV === 'development' && env.CRM_AUTH_DISABLED === 'true';
}

function localUser() {
  return toCrmUser({ userId: 'local-developer', sessionId: 'local-development' });
}

export function getClerkPublishableKey(env = process.env) {
  return String(
    env.CLERK_PUBLISHABLE_KEY || env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY || ''
  ).trim();
}

export function getClerkSecretKey(env = process.env) {
  return String(env.CLERK_SECRET_KEY || '').trim();
}

export function getClerkFrontendApiUrl(env = process.env) {
  const explicit = String(env.CLERK_FRONTEND_API_URL || '').trim();
  if (explicit) {
    try {
      const url = new URL(explicit);
      return url.protocol === 'https:' ? url.origin : null;
    } catch {
      return null;
    }
  }

  const encoded = getClerkPublishableKey(env).split('_').slice(2).join('_');
  if (!encoded) return null;
  try {
    const host = Buffer.from(encoded, 'base64url').toString('utf8').replace(/\$$/, '');
    return new URL(`https://${host}`).origin;
  } catch {
    return null;
  }
}

export function isCrmAuthConfigured(env = process.env) {
  return Boolean(
    getClerkPublishableKey(env) &&
      getClerkSecretKey(env) &&
      getClerkFrontendApiUrl(env) &&
      (env.NODE_ENV !== 'production' || getClerkAuthorizedParties(env).length)
  );
}

/**
 * Restrict Clerk session tokens to this application's origins. This prevents a
 * token minted for another first-party frontend from being replayed here.
 */
export function getClerkAuthorizedParties(env = process.env) {
  const origins = new Set();
  const configuredBase = String(env.PUBLIC_BASE_URL || '').trim();
  if (configuredBase) {
    try {
      const url = new URL(configuredBase);
      if (env.NODE_ENV !== 'production' || url.protocol === 'https:') origins.add(url.origin);
    } catch {
      // The production health check reports invalid deployment config separately.
    }
  }

  if (env.NODE_ENV !== 'production') {
    const port = Number(env.PORT || 8080);
    origins.add(`http://localhost:${port}`);
    origins.add(`http://127.0.0.1:${port}`);
  }
  return [...origins];
}

function toCrmUser(auth, accessToken = null) {
  return {
    userId: auth.userId,
    sessionId: auth.sessionId || null,
    orgId: auth.orgId || null,
    orgRole: auth.orgRole || null,
    orgSlug: auth.orgSlug || null,
    accessToken,
  };
}

function authFromVerifiedClaims(claims) {
  const activeOrg = claims?.o && typeof claims.o === 'object' ? claims.o : null;
  return {
    userId: String(claims?.sub || '').trim() || null,
    sessionId: String(claims?.sid || '').trim() || null,
    orgId: String(activeOrg?.id || claims?.org_id || '').trim() || null,
    orgRole: String(activeOrg?.rol || claims?.org_role || '').trim() || null,
    orgSlug: String(activeOrg?.slg || claims?.org_slug || '').trim() || null,
  };
}

/** Verify a raw Clerk session token, used by the WebSocket upgrade path. */
export async function verifyCrmAccessToken(accessToken, { tenant = null } = {}) {
  if (isLocalAuthDisabled()) return localUser();
  if (!accessToken || !isCrmAuthConfigured()) return null;

  try {
    const claims = await verifyToken(accessToken, {
      secretKey: getClerkSecretKey(),
      authorizedParties: getClerkAuthorizedParties(),
    });
    const auth = authFromVerifiedClaims(claims);
    if (!auth.userId || !auth.sessionId || (tenant && !tenantMatchesClerkAuth(tenant, auth))) {
      return null;
    }
    return toCrmUser(auth, accessToken);
  } catch {
    return null;
  }
}

/** Express middleware requiring a verified Clerk user session. */
export function requireClerkSession(req, res, next) {
  if (isLocalAuthDisabled()) {
    req.crmUser = { ...localUser(), tenantId: req.tenant?.id || null };
    return next();
  }
  try {
    if (!isCrmAuthConfigured()) {
      return res.status(503).json({
        error: 'CRM auth not configured',
        detail: 'Set CLERK_PUBLISHABLE_KEY and CLERK_SECRET_KEY.',
      });
    }

    const auth = getAuth(req, { acceptsToken: 'session_token' });
    if (!auth?.isAuthenticated || !auth.userId) {
      return res.status(401).json({ error: 'Unauthorized', detail: 'Sign in required' });
    }
    req.crmUser = {
      ...toCrmUser(auth),
      tenantId: req.tenant?.id || null,
    };
    return next();
  } catch (err) {
    console.error('[opek-sms] Clerk auth check failed', err?.message || err);
    return res.status(401).json({ error: 'Unauthorized', detail: 'Session verification failed' });
  }
}

/** Express middleware requiring both a Clerk session and tenant membership. */
export function requireCrmAuth(req, res, next) {
  if (isLocalAuthDisabled()) return requireClerkSession(req, res, next);
  return requireClerkSession(req, res, () => {
    if (!tenantMatchesClerkAuth(req.tenant, req.crmUser)) {
      return res.status(403).json({
        error: 'Forbidden',
        detail: 'Select the Clerk organization linked to this business account.',
      });
    }
    return next();
  });
}
