import { database, env } from '../_shared/http.js';
import { localDateTime } from '../_shared/domain.js';

const headers = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Cache-Control': 'no-store',
};
const maxPayloadBytes = 16384;

function response(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...headers, 'Content-Type': 'application/json' },
  });
}

async function readLimitedBody(request) {
  const declared = Number(request.headers.get('Content-Length'));
  if (Number.isFinite(declared) && declared > maxPayloadBytes) throw new Error('PAYLOAD_TOO_LARGE');
  if (!request.body) return '';
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let raw = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxPayloadBytes) throw new Error('PAYLOAD_TOO_LARGE');
      raw += decoder.decode(value, { stream: true });
    }
    return raw + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

async function hashIp(request, secret) {
  const forwarded = request.headers.get('x-forwarded-for')?.split(',').at(-1)?.trim();
  const ip = forwarded || request.headers.get('x-real-ip') || 'unknown';
  const data = new TextEncoder().encode(`${secret}:${ip}`);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', data));
  return Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('');
}

export function createWebFormHandler(db = database('WEB_FORM_DATABASE_URL'), options = {}) {
  const secret = options.ipHashKey ?? env('WEB_FORM_IP_HASH_KEY');
  return async request => {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
    const path = new URL(request.url).pathname;
    const match = path.match(/\/web-form\/([0-9a-f-]{36})\/?$/i);
    if (!match) return response({ error: 'Form not found' }, 404);
    const formId = match[1];
    try {
      if (request.method === 'GET') {
        const form = await db.call('public_web_form', formId);
        return form ? response({ form }) : response({ error: 'Form not found' }, 404);
      }
      if (request.method !== 'POST') return response({ error: 'Method not allowed' }, 405);
      if (!request.headers.get('Content-Type')?.toLowerCase().startsWith('application/json')) {
        return response({ error: 'JSON body required' }, 415);
      }
      const raw = await readLimitedBody(request);
      let payload;
      try { payload = JSON.parse(raw); } catch { return response({ error: 'Invalid JSON' }, 400); }
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        return response({ error: 'Invalid form payload' }, 400);
      }
      if (payload.website) {
        return response({ ok: true, submissionId: payload.submissionId || null }, 201);
      }
      if (!secret || secret.length < 32) return response({ error: 'Form submission unavailable' }, 503);
      const form = await db.call('public_web_form', formId);
      if (!form) return response({ error: 'Form not found' }, 404);
      const allowed = await db.call('claim_web_form_rate', formId, payload.submissionId || '', await hashIp(request, secret));
      if (!allowed) return new Response(JSON.stringify({ error: 'Too many submissions. Try again later.' }), {
        status: 429, headers: { ...headers, 'Content-Type': 'application/json', 'Retry-After': '600' },
      });
      if (form.preset === 'bookings' && payload.appointmentAt) {
        try { payload.appointmentAt = localDateTime(payload.appointmentAt, form.timeZone).toISOString(); }
        catch { return response({ error: 'Invalid appointment date or time' }, 400); }
      }
      const result = await db.call('submit_web_form', formId, payload);
      return response(result, result.duplicate ? 200 : 201);
    } catch (error) {
      if (error.message === 'PAYLOAD_TOO_LARGE') return response({ error: 'Form payload too large' }, 413);
      if (error.message === 'RATE_LIMITED') {
        return new Response(JSON.stringify({ error: 'Too many submissions. Try again later.' }), {
          status: 429,
          headers: { ...headers, 'Content-Type': 'application/json', 'Retry-After': '600' },
        });
      }
      if (error.message === 'Form unavailable') return response({ error: 'Form not found' }, 404);
      if (error.code === 'P0001' || ['22P02','23514','23502'].includes(error.code)) {
        return response({ error: error.message }, 400);
      }
      console.error(JSON.stringify({ event: 'web_form_failed', code: error.code || 'REQUEST_ERROR' }));
      return response({ error: 'Form temporarily unavailable' }, 503);
    }
  };
}
