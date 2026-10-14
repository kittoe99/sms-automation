import express from 'express';
import { verifyToken } from '@clerk/express';
import { createDemoApp } from './demoApp.js';

export function localPreviewConfig(env = process.env) {
  if (env.CRM_PREVIEW_MODE !== 'development') return null;
  if (env.NODE_ENV === 'production') throw new Error('Development preview cannot run in production');
  const publishableKey = String(env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY || '').trim();
  const secretKey = String(env.CLERK_SECRET_KEY || '').trim();
  if (!publishableKey.startsWith('pk_test_') || !secretKey.startsWith('sk_test_')) {
    throw new Error('Development preview requires matching Clerk test keys in .env.local');
  }
  const host = Buffer.from(publishableKey.slice(8), 'base64url').toString('utf8').replace(/\$$/, '');
  if (!/^[a-z0-9-]+\.clerk\.accounts\.dev$/.test(host)) throw new Error('Invalid development Clerk domain');
  const port = Number(env.PORT || 8080);
  return { publishableKey, secretKey, issuer: `https://${host}`,
    origins: [`http://localhost:${port}`, `http://127.0.0.1:${port}`] };
}

// Uses only sample records. Test identities never reach the shared database or providers.
export function createLocalPreviewApp(config, { distDir, verify = verifyToken } = {}) {
  const app = express();
  const samples = createDemoApp();
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.set({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY' });
    if (req.get('Origin') && !config.origins.includes(req.get('Origin'))) {
      return res.status(403).json({ error: 'Origin denied' });
    }
    if (!['GET', 'HEAD'].includes(req.method)) {
      return res.status(403).json({ error: 'Read-only development preview: changes, SMS, and calls are disabled.' });
    }
    next();
  });
  app.get('/config.js', (_req, res) => res.type('text/javascript').send(
    `globalThis.SMS_CONFIG=${JSON.stringify({ apiBase: '', supabaseUrl: '', supabasePublishableKey: '',
      formApiBase: '/functions/v1/web-form', embedBaseUrl: config.origins[0],
      hostingApiBase: '/hosting-preview', previewReadOnly: true })};\n`
  ));
  app.get('/api/auth/config', (_req, res) => res.json({
    mode: 'clerk', configured: true, manualBusinesses: false,
    publishableKey: config.publishableKey, frontendApiUrl: config.issuer,
  }));
  app.use('/api', async (req, res, next) => {
    const authorization = req.get('Authorization') || '';
    if (!authorization.startsWith('Bearer ')) return res.status(401).json({ error: 'Sign in required' });
    try {
      const claims = await verify(authorization.slice(7), {
        secretKey: config.secretKey, authorizedParties: config.origins,
      });
      if (claims.iss !== config.issuer || !config.origins.includes(claims.azp) ||
          typeof claims.sub !== 'string' || !claims.sub || typeof claims.sid !== 'string' || !claims.sid) {
        throw new Error('Untrusted development session');
      }
      req.previewUser = claims.sub;
      next();
    } catch {
      res.status(401).json({ error: 'Invalid development session' });
    }
  });
  app.get('/api/auth/me', (req, res) => res.json({
    user: { id: req.previewUser }, capabilities: { platformStaff: false }, preview: true,
  }));
  app.use((req, res, next) => {
    if (req.path === '/api' || req.path.startsWith('/api/') || req.path.startsWith('/functions/')) {
      return samples(req, res, next);
    }
    next();
  });
  app.use(['/webhooks', '/hosting-preview', '/ws'], (_req, res) =>
    res.status(403).json({ error: 'Unavailable in the development preview' }));
  app.use(express.static(distDir, { dotfiles: 'deny' }));
  app.get('*', (req, res) => {
    if (req.path.split('/').some(part => part.startsWith('.'))) return res.sendStatus(404);
    res.sendFile(`${distDir}/index.html`);
  });
  return app;
}
