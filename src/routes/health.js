import { Router } from 'express';

export const healthRouter = Router();

healthRouter.get('/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'opek-sms',
    brand: 'Opek Junk Removal',
    ts: new Date().toISOString(),
  });
});
