import { constantTimeEqual } from './security.js';
import { defaultTenantFromEnv, getCurrentTenant } from './tenantContext.js';

/**
 * Require OPEK_SMS_API_KEY for server-to-server calls.
 * Accepts X-API-Key or Authorization: Bearer <key>.
 */
export function requireApiKey(req, res, next) {
  const tenant = req.tenant || getCurrentTenant();
  const expected = tenant.id === defaultTenantFromEnv().id
    ? process.env.OPEK_SMS_API_KEY
    : tenant.integrationApiKey;
  if (!expected) {
    return res.status(503).json({
      error: 'API key not configured',
      detail: 'Set OPEK_SMS_API_KEY on the SMS server.',
    });
  }
  if (process.env.NODE_ENV === 'production' && expected.length < 32) {
    return res.status(503).json({
      error: 'API key is not securely configured',
      detail: 'OPEK_SMS_API_KEY must contain at least 32 characters.',
    });
  }

  const headerKey = String(req.headers['x-api-key'] || '').trim();
  const auth = String(req.headers.authorization || '').trim();
  const bearer = auth.toLowerCase().startsWith('bearer ')
    ? auth.slice('bearer '.length).trim()
    : '';

  if (!constantTimeEqual(headerKey, expected) && !constantTimeEqual(bearer, expected)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  return next();
}
