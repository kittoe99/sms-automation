/**
 * Require OPEK_SMS_API_KEY for server-to-server calls.
 * Accepts X-API-Key or Authorization: Bearer <key>.
 */
export function requireApiKey(req, res, next) {
  const expected = process.env.OPEK_SMS_API_KEY;
  if (!expected) {
    return res.status(503).json({
      error: 'API key not configured',
      detail: 'Set OPEK_SMS_API_KEY on the SMS server.',
    });
  }

  const headerKey = String(req.headers['x-api-key'] || '').trim();
  const auth = String(req.headers.authorization || '').trim();
  const bearer = auth.toLowerCase().startsWith('bearer ')
    ? auth.slice('bearer '.length).trim()
    : '';

  if (headerKey !== expected && bearer !== expected) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  return next();
}
