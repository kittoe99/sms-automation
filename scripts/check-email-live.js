import { readFile } from 'node:fs/promises';
import { createHmac, randomUUID } from 'node:crypto';
import { parse } from 'dotenv';

const secrets = parse(await readFile(new URL('../data/edge-secrets.env', import.meta.url)));
const base = 'https://wxamwhfmelxqahkdtcci.supabase.co/functions/v1';
const worker = await fetch(`${base}/email-worker`, { method: 'POST' });
console.log('Worker without bearer:', worker.status);
const authorized = await fetch(`${base}/email-worker`, {
  method: 'POST', headers: { Authorization: `Bearer ${secrets.AUTOMATION_WORKER_SECRET}` },
});
console.log('Worker with bearer:', authorized.status, await authorized.text());

const body = JSON.stringify({ type: 'test.ping', data: {} });
const timestamp = String(Math.floor(Date.now() / 1000));
const id = `msg_${randomUUID()}`;
const signature = createHmac('sha256', Buffer.from(secrets.RESEND_WEBHOOK_SECRET.slice(6), 'base64'))
  .update(`${id}.${timestamp}.${body}`).digest('base64');
const headers = {
  'content-type': 'application/json',
  'svix-id': id,
  'svix-timestamp': timestamp,
  'svix-signature': `v1,${signature}`,
};
const webhook = await fetch(`${base}/email-webhook`, { method: 'POST', headers, body });
console.log('Webhook with valid signature:', webhook.status, await webhook.text());
const invalid = await fetch(`${base}/email-webhook`, {
  method: 'POST', headers: { ...headers, 'svix-signature': 'v1,bad' }, body,
});
console.log('Webhook with invalid signature:', invalid.status);
if (worker.status !== 401 || authorized.status !== 200 || webhook.status !== 200 || invalid.status !== 401) {
  process.exitCode = 1;
}
