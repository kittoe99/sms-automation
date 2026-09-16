import { Router } from 'express';
import { requireClerkSession } from '../lib/crmAuth.js';
import { businessAccountStore, publicBusiness } from '../lib/businessAccounts.js';
import { provisionBusinessTwilio, reconcileBusinessTwilio } from '../lib/twilioProvisioning.js';
import { createRateLimiter } from '../lib/security.js';

/** A business/org admin is NOT a platform admin and cannot create billable accounts. */
export function requirePlatformAdmin(req, res, next) {
  const allowed = String(process.env.PLATFORM_ADMIN_USER_IDS || '').split(',').map(v => v.trim()).filter(Boolean);
  if (!allowed.length) return res.status(503).json({ error: 'Platform administrators are not configured' });
  if (!req.crmUser?.userId || !allowed.includes(req.crmUser.userId)) return res.status(403).json({ error: 'Platform administrator access required' });
  return next();
}

export function createPlatformRouter({ store = businessAccountStore, provision = provisionBusinessTwilio, reconcile = reconcileBusinessTwilio, authenticate = requireClerkSession } = {}) {
  const router = Router();
  const limited = createRateLimiter({ windowMs: 60_000, max: 10, key: req => `platform:${req.crmUser?.userId || req.ip}` });
  router.use(authenticate, requirePlatformAdmin, limited);
  const handle = fn => async (req, res) => {
    try { await fn(req, res); } catch (error) {
      const status = error.expose && [400, 404, 409, 502, 503].includes(error.status) ? error.status : 500;
      res.status(status).json({ error: status === 500 ? 'Platform operation failed' : error.message });
    }
  };
  router.get('/businesses', handle(async (_req, res) => res.json({ businesses: (await store.list()).map(publicBusiness) })));
  router.post('/businesses', handle(async (req, res) => res.status(201).json({ business: publicBusiness(await store.create(req.body)) })));
  router.post('/businesses/:id/twilio/provision', handle(async (req, res) =>
    res.json({ business: await provision(req.params.id, { store }) })
  ));
  router.post('/businesses/:id/twilio/reconcile', handle(async (req, res) =>
    res.json({ business: await reconcile(req.params.id, req.body, { store }) })
  ));
  return router;
}

export const platformRouter = createPlatformRouter();
