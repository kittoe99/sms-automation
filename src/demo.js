import { createDemoApp } from './demoApp.js';

// Loopback only: use a temporary tunnel for device testing.
const port = Number(process.env.DEMO_PORT || 8081);
const server = createDemoApp().listen(port, '127.0.0.1', () => {
  console.log(`Read-only sample CRM ready on http://127.0.0.1:${port}`);
});
server.on('upgrade', (_req, socket) => socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'));
