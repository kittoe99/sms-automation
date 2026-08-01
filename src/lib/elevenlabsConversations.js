/**
 * ElevenLabs ConvAI conversation pull + Supabase persistence.
 * Stored for CRM / later agent history — not injected into SMS AI yet.
 */

import crypto from 'node:crypto';
import { getSupabaseAdmin, isSupabaseConfigured } from './supabase.js';
import { getElevenLabsOutboundConfig } from './elevenlabsOutbound.js';

const DEFAULT_OUTBOUND_AGENT_ID = 'agent_7801kwfn9rkcey5rn1wsrjdpnvvn';
const EL_BASE = 'https://api.elevenlabs.io/v1/convai';

export function phoneDigits(value) {
  return String(value || '').replace(/\D/g, '') || '';
}

function apiKey() {
  const key = getElevenLabsOutboundConfig().apiKey;
  if (!key) throw new Error('ELEVENLABS_API_KEY is not configured');
  return key;
}

async function elFetch(path, { method = 'GET', query = null } = {}) {
  const url = new URL(`${EL_BASE}${path}`);
  if (query && typeof query === 'object') {
    for (const [k, v] of Object.entries(query)) {
      if (v == null || v === '') continue;
      url.searchParams.set(k, String(v));
    }
  }
  const res = await fetch(url, {
    method,
    headers: {
      'xi-api-key': apiKey(),
      Accept: 'application/json',
    },
  });
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }
  if (!res.ok) {
    const detail = data?.detail || data?.message || text || res.statusText;
    const err = new Error(typeof detail === 'string' ? detail : JSON.stringify(detail));
    err.status = res.status;
    err.body = data;
    throw err;
  }
  return data;
}

export async function listElevenLabsConversations({
  agentId = DEFAULT_OUTBOUND_AGENT_ID,
  cursor = null,
  pageSize = 30,
  callStartAfterUnix = null,
  callStartBeforeUnix = null,
} = {}) {
  return elFetch('/conversations', {
    query: {
      agent_id: agentId || undefined,
      cursor: cursor || undefined,
      page_size: Math.min(Math.max(Number(pageSize) || 30, 1), 100),
      call_start_after_unix: callStartAfterUnix || undefined,
      call_start_before_unix: callStartBeforeUnix || undefined,
    },
  });
}

export async function getElevenLabsConversation(conversationId) {
  if (!conversationId) throw new Error('conversation_id is required');
  return elFetch(`/conversations/${encodeURIComponent(conversationId)}`);
}

/**
 * Normalize ElevenLabs get/webhook payload into a DB row.
 */
export function mapConversationToRow(payload, extras = {}) {
  const data = payload?.data && typeof payload.data === 'object' ? payload.data : payload;
  const conversationId =
    extras.conversationId ||
    data?.conversation_id ||
    data?.conversationId ||
    null;
  if (!conversationId) throw new Error('conversation_id missing from ElevenLabs payload');

  const phoneCall = data?.metadata?.phone_call || {};
  const dyn =
    data?.conversation_initiation_client_data?.dynamic_variables ||
    data?.dynamic_variables ||
    {};

  const phone =
    extras.phone ||
    dyn.customer_phone ||
    phoneCall.external_number ||
    phoneCall.to_number ||
    data?.metadata?.to_number ||
    null;

  const startedUnix =
    data?.metadata?.start_time_unix_secs ??
    data?.start_time_unix_secs ??
    null;
  const durationSecs =
    data?.metadata?.call_duration_secs ??
    data?.call_duration_secs ??
    null;

  const startedAt =
    startedUnix != null ? new Date(Number(startedUnix) * 1000).toISOString() : extras.startedAt || null;
  const endedAt =
    startedUnix != null && durationSecs != null
      ? new Date((Number(startedUnix) + Number(durationSecs)) * 1000).toISOString()
      : null;

  const analysis = data?.analysis && typeof data.analysis === 'object' ? data.analysis : {};
  const status =
    extras.status ||
    data?.status ||
    (Array.isArray(data?.transcript) && data.transcript.length ? 'done' : 'pending');

  return {
    conversation_id: conversationId,
    agent_id: extras.agentId || data?.agent_id || getElevenLabsOutboundConfig().agentId || null,
    call_sid:
      extras.callSid ||
      phoneCall.call_sid ||
      data?.metadata?.call_sid ||
      null,
    status,
    phone: phone ? String(phone) : null,
    phone_digits: phoneDigits(phone) || null,
    direction:
      extras.direction ||
      phoneCall.direction ||
      data?.direction ||
      'outbound',
    started_at: startedAt,
    ended_at: endedAt,
    duration_secs: durationSecs != null ? Number(durationSecs) : null,
    transcript: Array.isArray(data?.transcript) ? data.transcript : [],
    analysis,
    metadata: data?.metadata && typeof data.metadata === 'object' ? data.metadata : {},
    raw: data && typeof data === 'object' ? data : {},
    call_successful:
      analysis.call_successful ?? data?.call_successful ?? extras.callSuccessful ?? null,
    summary:
      analysis.transcript_summary ||
      data?.transcript_summary ||
      extras.summary ||
      null,
    updated_at: new Date().toISOString(),
  };
}

export async function upsertVoiceConversation(row) {
  if (!isSupabaseConfigured()) {
    throw new Error('Supabase is not configured');
  }
  if (!row?.conversation_id) throw new Error('conversation_id is required');

  const admin = getSupabaseAdmin();
  const { data: existing } = await admin
    .from('sms_voice_conversations')
    .select('*')
    .eq('conversation_id', row.conversation_id)
    .maybeSingle();

  const merged = {
    ...(existing || {}),
    ...row,
    // Prefer existing phone if new payload lacks one
    phone: row.phone || existing?.phone || null,
    phone_digits: row.phone_digits || existing?.phone_digits || null,
    call_sid: row.call_sid || existing?.call_sid || null,
    agent_id: row.agent_id || existing?.agent_id || null,
    transcript:
      Array.isArray(row.transcript) && row.transcript.length
        ? row.transcript
        : existing?.transcript || [],
    analysis:
      row.analysis && Object.keys(row.analysis).length
        ? row.analysis
        : existing?.analysis || {},
    metadata:
      row.metadata && Object.keys(row.metadata).length
        ? row.metadata
        : existing?.metadata || {},
    raw: row.raw && Object.keys(row.raw).length ? row.raw : existing?.raw || {},
    summary: row.summary || existing?.summary || null,
    call_successful: row.call_successful ?? existing?.call_successful ?? null,
    created_at: existing?.created_at || row.created_at || new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  const { data, error } = await admin
    .from('sms_voice_conversations')
    .upsert(merged, { onConflict: 'conversation_id' })
    .select()
    .maybeSingle();

  if (error) throw error;
  return data;
}

export async function recordPendingOutboundCall({
  conversationId,
  phone,
  callSid = null,
  agentId = null,
}) {
  if (!conversationId) return null;
  if (!isSupabaseConfigured()) {
    console.warn('[opek-sms] voice pending skip: Supabase not configured');
    return null;
  }
  try {
    return await upsertVoiceConversation({
      conversation_id: conversationId,
      agent_id: agentId || getElevenLabsOutboundConfig().agentId || DEFAULT_OUTBOUND_AGENT_ID,
      call_sid: callSid || null,
      status: 'pending',
      phone: phone || null,
      phone_digits: phoneDigits(phone) || null,
      direction: 'outbound',
      started_at: new Date().toISOString(),
      transcript: [],
      analysis: {},
      metadata: {},
      raw: { source: 'place_outbound_call' },
      call_successful: null,
      summary: null,
    });
  } catch (err) {
    console.warn('[opek-sms] voice pending upsert failed', err.message || err);
    return null;
  }
}

export async function listVoiceConversationsForPhone(phone, { limit = 50 } = {}) {
  if (!isSupabaseConfigured()) return [];
  const digits = phoneDigits(phone).slice(-10);
  if (digits.length < 10) return [];

  const { data, error } = await getSupabaseAdmin()
    .from('sms_voice_conversations')
    .select(
      'conversation_id, agent_id, call_sid, status, phone, direction, started_at, ended_at, duration_secs, call_successful, summary, transcript, created_at, updated_at'
    )
    .ilike('phone_digits', `%${digits}`)
    .order('started_at', { ascending: false, nullsFirst: false })
    .limit(Math.min(Math.max(Number(limit) || 50, 1), 200));

  if (error) throw error;
  return data || [];
}

/**
 * Pull conversations from ElevenLabs and upsert into Supabase.
 */
export async function syncConversations({
  agentId = DEFAULT_OUTBOUND_AGENT_ID,
  sinceUnix = null,
  maxPages = 20,
  pageSize = 30,
} = {}) {
  const summary = {
    agentId,
    pages: 0,
    listed: 0,
    upserted: 0,
    errors: [],
  };

  if (!isSupabaseConfigured()) {
    summary.errors.push({ error: 'Supabase is not configured' });
    return summary;
  }

  let cursor = null;
  for (let page = 0; page < maxPages; page += 1) {
    const listed = await listElevenLabsConversations({
      agentId,
      cursor,
      pageSize,
      callStartAfterUnix: sinceUnix,
    });
    summary.pages += 1;
    const items = listed?.conversations || listed?.items || [];
    summary.listed += items.length;

    for (const item of items) {
      const id = item.conversation_id || item.conversationId;
      if (!id) continue;
      try {
        const full = await getElevenLabsConversation(id);
        const row = mapConversationToRow(full);
        await upsertVoiceConversation(row);
        summary.upserted += 1;
      } catch (err) {
        summary.errors.push({ conversationId: id, error: err.message || String(err) });
      }
    }

    cursor = listed?.next_cursor || listed?.cursor || null;
    const hasMore = Boolean(listed?.has_more ?? cursor);
    if (!hasMore || !items.length) break;
  }

  return summary;
}

/**
 * Verify ElevenLabs webhook HMAC signature.
 * Header format: t=timestamp,v0=hexdigest
 * Signed payload: `${timestamp}.${rawBody}`
 */
export function verifyElevenLabsWebhookSignature(rawBody, signatureHeader, secret) {
  if (!secret) {
    return { ok: false, error: 'ELEVENLABS_WEBHOOK_SECRET is not configured' };
  }
  if (!signatureHeader) {
    return { ok: false, error: 'Missing ElevenLabs-Signature header' };
  }

  const parts = Object.fromEntries(
    String(signatureHeader)
      .split(',')
      .map((p) => p.trim().split('='))
      .filter((kv) => kv.length === 2)
  );
  const timestamp = parts.t;
  const signature = parts.v0;
  if (!timestamp || !signature) {
    return { ok: false, error: 'Invalid ElevenLabs-Signature format' };
  }

  const ageSec = Math.abs(Date.now() / 1000 - Number(timestamp));
  if (!Number.isFinite(Number(timestamp)) || ageSec > 30 * 60) {
    return { ok: false, error: 'ElevenLabs webhook timestamp out of range' };
  }

  const signedPayload = `${timestamp}.${rawBody}`;
  const expected = crypto.createHmac('sha256', secret).update(signedPayload).digest('hex');

  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(String(signature), 'utf8');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return { ok: false, error: 'Invalid ElevenLabs webhook signature' };
  }
  return { ok: true };
}

export async function ingestPostCallWebhook(event) {
  const type = event?.type || event?.event || null;
  if (type && type !== 'post_call_transcription' && type !== 'transcript') {
    return { skipped: true, reason: `ignored_event:${type}` };
  }

  const payload = event?.data || event;
  const row = mapConversationToRow(payload, {
    status: payload?.status || 'done',
  });
  const saved = await upsertVoiceConversation(row);
  return { ok: true, conversationId: saved?.conversation_id || row.conversation_id, saved };
}
