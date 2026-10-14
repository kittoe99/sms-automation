import 'dotenv/config';
import dotenv from 'dotenv';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.env.NODE_ENV !== 'production') dotenv.config({ path: '.env.local', override: true, quiet: true });
const port = Number(process.env.PORT || 8080);
const distDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const { localPreviewConfig, createLocalPreviewApp } = await import('../src/localPreviewApp.js');
const localConfig = localPreviewConfig();
const app = localConfig ? createLocalPreviewApp(localConfig, { distDir }) : express();

if (!localConfig) {
  app.disable('x-powered-by');
  app.use(['/api', '/functions', '/webhooks'], (_req, res) => {
    res.status(404).json({ error: 'Local preview uses WPacquisition Edge APIs; check /config.js.' });
  });
  app.use(express.static(distDir, { dotfiles: 'deny' }));
  app.get('*', (_req, res) => res.sendFile(path.join(distDir, 'index.html')));
}

app.listen(port, '127.0.0.1', () => {
  console.log(`[crm-preview] http://localhost:${port}/ (${localConfig ? 'test Clerk login, read-only sample data' : 'WPacquisition static frontend'})`);
});
