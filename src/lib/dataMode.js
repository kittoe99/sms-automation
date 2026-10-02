export function isDatabaseDisconnected(env = process.env) {
  return env.CRM_DATA_MODE === 'empty';
}

export function canManageLocalBusinesses(env = process.env) {
  return isDatabaseDisconnected(env) && env.NODE_ENV === 'development' && env.CRM_AUTH_DISABLED === 'true';
}

/** Empty record responses; automation definitions remain on their existing routes. */
export function emptyDataMiddleware(req, res, next) {
  if (!isDatabaseDisconnected()) return next();
  const path = req.path;
  if (path.startsWith('/auth/') || path === '/tenants' ||
      path === '/categories' || path.startsWith('/categories/') ||
      path.startsWith('/automations/') || path.startsWith('/automation-groups')) return next();
  const summary = { total: 0, counts: {}, conversationCount: 0, contactCount: 0,
    optedOutTotal: 0, deliveryRate: null, byCategory: [] };
  const page = { total: 0, page: 1, pageSize: Math.max(1, Math.min(250, Number(req.query?.pageSize) || 50)), totalPages: 1 };
  if (!['GET', 'HEAD'].includes(req.method)) {
    return res.status(503).json({ error: 'Database disconnected. Connect it before sending or updating customer records.' });
  }
  res.set('Cache-Control', 'no-store');
  if (path === '/overview' || path === '/deliverability') return res.json(summary);
  if (path === '/messages') return res.json({ ...page, messages: [], summary });
  if (['/contacts', '/directory', '/opt-outs'].includes(path)) {
    return res.json({ ...page, contacts: [], configured: true, disconnected: true,
      contactTotal: 0, activeTotal: 0, optedOutTotal: 0 });
  }
  if (path === '/conversations') return res.json({ ...page, conversations: [], unreadTotal: 0 });
  if (path === '/enrollments') return res.json({ ...page, enrollments: [] });
  if (path === '/calls') return res.json({ ...page, calls: [] });
  if (/^\/conversations\/[^/]+\/calls$/.test(path)) return res.json({ calls: [] });
  if (path === '/ai/outbound-call') return res.json({ configured: false, from: '', presets: [] });
  return res.status(404).json({ error: 'No records yet.' });
}
