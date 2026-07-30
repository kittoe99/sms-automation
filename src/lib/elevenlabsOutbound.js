/**
 * ElevenLabs Twilio outbound calls for SMS CRM follow-up.
 */

import { loadCustomerBookingContext } from './ai/customerContext.js';
import { toE164 } from './supabaseContacts.js';

const DEFAULT_AGENT_ID = 'agent_7801kwfn9rkcey5rn1wsrjdpnvvn';
const DEFAULT_PHONE_NUMBER_ID = 'phnum_1601ktscp7y1e27b3apd0swmz55j';
const MAX_HISTORY_CHARS = 3500;

export function isElevenLabsOutboundConfigured() {
  return Boolean(String(process.env.ELEVENLABS_API_KEY || '').trim());
}

export function getElevenLabsOutboundConfig() {
  return {
    apiKey: String(process.env.ELEVENLABS_API_KEY || '').trim(),
    agentId: String(process.env.ELEVENLABS_OUTBOUND_AGENT_ID || DEFAULT_AGENT_ID).trim(),
    agentPhoneNumberId: String(
      process.env.ELEVENLABS_AGENT_PHONE_NUMBER_ID || DEFAULT_PHONE_NUMBER_ID
    ).trim(),
  };
}

/**
 * Build dynamic variables + place the outbound call.
 * @param {{ phone: string, conversation?: object|null, name?: string|null }} opts
 */
export async function placeOutboundFollowUpCall({ phone, conversation = null, name = null }) {
  const cfg = getElevenLabsOutboundConfig();
  if (!cfg.apiKey) throw new Error('ELEVENLABS_API_KEY is not configured');

  const toNumber = toE164(phone);
  if (!toNumber || toNumber.length < 12) {
    throw new Error('Invalid phone number for outbound call');
  }

  const crm = await loadCustomerBookingContext(toNumber).catch(() => null);
  const proposed = crm?.proposed || {};
  const displayName =
    clean(name) ||
    clean(conversation?.name) ||
    clean(proposed.customer_name) ||
    'there';

  const historyText = formatSmsHistory(conversation?.messages || []);
  const dynamicVariables = {
    customer_name: displayName,
    customer_phone: toNumber,
    service_type: clean(proposed.service_type) || 'junk removal',
    quote_amount:
      clean(proposed.quoted_price_summary) ||
      'the estimate from your texts',
    quote_summary:
      clean(proposed.notes) ||
      (Array.isArray(proposed.items) ? proposed.items.join(', ') : null) ||
      'details from your SMS conversation',
    preferred_date: clean(proposed.preferred_date) || 'not set yet',
    preferred_time_window: clean(proposed.preferred_time_window) || 'not set yet',
    service_address:
      clean(proposed.service_address) ||
      clean(proposed.zip_code) ||
      'not set yet',
    sms_conversation_history: historyText,
  };

  const firstMessage =
    displayName && displayName !== 'there'
      ? `Hi, is this ${displayName}? This is Macy calling from Opek Junk Removal.`
      : 'Hi, this is Macy calling from Opek Junk Removal — did I catch you at a good time?';

  const body = {
    agent_id: cfg.agentId,
    agent_phone_number_id: cfg.agentPhoneNumberId,
    to_number: toNumber,
    call_recording_enabled: true,
    conversation_initiation_client_data: {
      dynamic_variables: dynamicVariables,
      conversation_config_override: {
        agent: {
          first_message: firstMessage,
        },
      },
    },
  };

  const res = await fetch('https://api.elevenlabs.io/v1/convai/twilio/outbound-call', {
    method: 'POST',
    headers: {
      'xi-api-key': cfg.apiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
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
    const err = new Error(
      typeof detail === 'string' ? detail : JSON.stringify(detail)
    );
    err.status = res.status;
    err.body = data;
    throw err;
  }

  return {
    ok: true,
    to: toNumber,
    agentId: cfg.agentId,
    conversationId: data.conversation_id || data.conversationId || null,
    callSid: data.callSid || data.call_sid || null,
    success: data.success !== false,
    message: data.message || 'Outbound call initiated',
    dynamicVariables,
  };
}

function formatSmsHistory(messages) {
  const lines = (messages || [])
    .filter((m) => m?.body && String(m.body).trim())
    .slice(-40)
    .map((m) => {
      const who = m.direction === 'inbound' ? 'Customer' : m.meta?.role === 'assistant' ? 'SMS AI' : 'Opek';
      const when = m.createdAt ? String(m.createdAt).slice(0, 16).replace('T', ' ') : '';
      return `${when} ${who}: ${String(m.body).trim()}`;
    });

  if (!lines.length) {
    return 'No prior SMS messages in this thread. Treat as a warm outbound follow-up and discover needs.';
  }

  let joined = lines.join('\n');
  if (joined.length > MAX_HISTORY_CHARS) {
    joined = `…(earlier messages truncated)…\n${joined.slice(-MAX_HISTORY_CHARS)}`;
  }
  return joined;
}

function clean(v) {
  if (v == null) return null;
  const s = String(v).trim();
  return s && s !== '...' ? s : null;
}
