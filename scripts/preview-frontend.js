import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const app = express();
const port = Number(process.env.PORT || 8080);
const distDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist');

app.disable('x-powered-by');
app.use(['/api', '/functions', '/webhooks'], (_req, res) => {
  res.status(404).json({ error: 'Local preview uses WPacquisition Edge APIs; check /config.js.' });
});
app.use(express.static(distDir, { dotfiles: 'deny' }));
app.get('*', (_req, res) => res.sendFile(path.join(distDir, 'index.html')));

app.listen(port, '127.0.0.1', () => {
  console.log(`[crm-preview] http://localhost:${port}/ (WPacquisition static frontend)`);
});
