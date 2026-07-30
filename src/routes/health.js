import { Router } from 'express';

export const healthRouter = Router();

healthRouter.get('/', (_req, res) => {
  res.type('text/plain').send('opek-sms ok');
});

healthRouter.get('/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'opek-sms',
    brand: 'Opek Junk Removal',
    ts: new Date().toISOString(),
  });
});
