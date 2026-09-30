import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { createWebFormHandler } from '../supabase/functions/web-form/handler.js';

const fid = '00000000-0000-4000-8000-000000000001';
const cid = '00000000-0000-4000-8000-000000000002';
const url = `https://example.supabase.co/functions/v1/web-form/${fid}`;
const post = (target, payload = {}) => new Request(target, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ submissionId: crypto.randomUUID(), smsOptIn: false, details: {}, ...payload }) });

test('website GET/POST route only through validated connection RPCs; legacy routes remain available', async () => {
  const calls = [];
  const handler = createWebFormHandler({ call: async (name, ...args) => {
    calls.push([name, ...args]);
    if (name.startsWith('public_')) return { preset: 'contacts', timeZone: 'America/Denver' };
    if (name === 'claim_web_form_rate') return true;
    return { ok: true, duplicate: false };
  } }, { ipHashKey: 'x'.repeat(32) });
  assert.equal((await handler(new Request(`${url}?connection=${cid}`))).status, 200);
  assert.equal((await handler(post(`${url}?connection=${cid}`))).status, 201);
  assert.ok(calls.some(([name, form, connection]) => name === 'submit_website_form' && form === fid && connection === cid));
  assert.equal(calls.some(([name]) => name === 'submit_web_form'), false);
  assert.equal((await handler(post(url))).status, 201);
  assert.ok(calls.some(([name]) => name === 'submit_web_form'));
});

test('invalid and disabled website connections fail without fallback or submissions', async () => {
  const calls = [];
  const handler = createWebFormHandler({ call: async (name) => { calls.push(name); return null; } }, { ipHashKey: 'x'.repeat(32) });
  for (const connection of ['', 'not-a-uuid']) assert.equal((await handler(post(`${url}?connection=${connection}`))).status, 400);
  assert.deepEqual(calls, []);
  assert.equal((await handler(new Request(`${url}?connection=${cid}`))).status, 404);
  assert.equal((await handler(post(`${url}?connection=${cid}`))).status, 404);
  assert.equal((await handler(post(`${url}?connection=${cid}`, { website: 'honeypot' }))).status, 404);
  assert.ok(calls.every((name) => name === 'public_website_form'));
});

test('resize events require the actual frame, origin, form, and website connection', async () => {
  const source = await readFile(new URL('../public/embed-resize.js', import.meta.url), 'utf8');
  let resize;
  const frame = { src: `https://crm.e2local.com/embed.html?form=${fid}&connection=${cid}`, contentWindow: {}, style: {} };
  runInNewContext(source, { URL, document: { baseURI: 'https://site.e2local.com/', querySelectorAll: () => [frame] }, window: { addEventListener: (_name, callback) => { resize = callback; } } });
  const event = { origin: 'https://crm.e2local.com', source: frame.contentWindow, data: { type: 'sms-web-form:resize', formId: fid, connectionId: cid, height: 400 } };
  resize({ ...event, source: {} }); resize({ ...event, origin: 'https://wrong.example' }); resize({ ...event, data: { ...event.data, connectionId: null } });
  assert.equal(frame.style.height, undefined);
  resize(event); assert.equal(frame.style.height, '400px');
  frame.src = `https://crm.e2local.com/embed.html?form=${fid}`;
  resize({ ...event, data: { ...event.data, connectionId: null, height: 450 } }); assert.equal(frame.style.height, '450px');
});
