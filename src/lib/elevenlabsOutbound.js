/**
 * ElevenLabs Twilio outbound calls for SMS CRM follow-up.
 */

import { loadCustomerBookingContext } from './ai/customerContext.js';
import { toE164 } from './supabaseContacts.js';
import {
  OUTBOUND_DEFAULT_FIRST_MESSAGE,
  OUTBOUND_DEFAULT_PROMPT,
} from './outboundDefaultPrompt.js';

const DEFAULT_AGENT_ID = 'agent_7801kwfn9rkcey5rn1wsrjdpnvvn';
const DEFAULT_PHONE_NUMBER_ID = 'phnum_1601ktscp7y1e27b3apd0swmz55j';
const SUBMIT_AGENT_BOOKING_TOOL_ID = 'tool_4601kyd0dyjmfegvahahhwvkv6zh';
const MAX_HISTORY_CHARS = 5000;
const MAX_PROMPT_CHARS = 50000;

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

export function getOutboundPromptPresets() {
  return {
    presets: [
      {
        id: 'macy-outbound',
        name: 'Macy outbound (default)',
        description:
          'Current Opek outbound Macy prompt — booking follow-up from SMS/CRM context.',
        firstMessage: OUTBOUND_DEFAULT_FIRST_MESSAGE,
        prompt: OUTBOUND_DEFAULT_PROMPT,
      },
    ],
    defaultPresetId: 'macy-outbound',
  };
}

/**
 * Build dynamic variables + place the outbound call.
 * @param {{
 *   phone: string,
 *   conversation?: object|null,
 *   name?: string|null,
 *   systemPrompt?: string|null,
 *   firstMessage?: string|null,
 *   includeSmsHistory?: boolean,
 * }} opts
 */
export async function placeOutboundFollowUpCall({
  phone,
  conversation = null,
  name = null,
  systemPrompt = null,
  firstMessage = null,
  includeSmsHistory = true,
}) {
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

  const historyText = includeSmsHistory
    ? formatSmsHistory(conversation?.messages || [])
    : 'SMS history was not included for this call. Rely on CALL CONTEXT and what the customer says.';

  const pipelineStatus = deriveBookingPipelineStatus(crm);
  const missingFields = Array.isArray(crm?.missingFields) ? crm.missingFields : [];
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
    booking_pipeline_status: pipelineStatus,
    missing_booking_fields: missingFields.length
      ? missingFields.join(', ')
      : 'none listed in CRM — still verify from SMS before treating as booked',
    sms_conversation_history: historyText,
  };

  const promptOverride = cleanPrompt(systemPrompt);
  const firstMessageOverride =
    clean(firstMessage) ||
    (displayName && displayName !== 'there'
      ? `Hello, Macy with Opek Junk Removal, Is this ${displayName}?`
      : OUTBOUND_DEFAULT_FIRST_MESSAGE.replace('{{customer_name}}', displayName));

  const agentOverride = {
    first_message: firstMessageOverride,
  };
  if (promptOverride) {
    agentOverride.prompt = {
      prompt: promptOverride,
      tool_ids: [SUBMIT_AGENT_BOOKING_TOOL_ID],
    };
  }

  const body = {
    agent_id: cfg.agentId,
    agent_phone_number_id: cfg.agentPhoneNumberId,
    to_number: toNumber,
    call_recording_enabled: true,
    conversation_initiation_client_data: {
      dynamic_variables: dynamicVariables,
      conversation_config_override: {
        agent: agentOverride,
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
    usedCustomPrompt: Boolean(promptOverride),
    firstMessage: firstMessageOverride,
    dynamicVariables,
  };
}

function cleanPrompt(v) {
  if (v == null) return null;
  const s = String(v).trim();
  if (!s) return null;
  if (s.length > MAX_PROMPT_CHARS) {
    throw new Error(`System prompt is too long (max ${MAX_PROMPT_CHARS} characters)`);
  }
  return s;
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

/**
 * CRM hint for the voice agent — SMS transcript still wins if they conflict.
 */
function deriveBookingPipelineStatus(crm) {
  if (!crm) return 'unknown — read SMS carefully; default to needs_finishing';

  const src = crm.proposed?.source_records || {};
  const missing = Array.isArray(crm.missingFields) ? crm.missingFields : [];
  const statuses = [
    src.booking_status,
    src.agent_booking_status,
    src.prebooking_status,
  ]
    .filter(Boolean)
    .map((s) => String(s).toLowerCase());

  const confirmedLike = ['confirmed', 'scheduled', 'booked', 'paid', 'active', 'completed'];
  const hasConfirmedRecord =
    Boolean(src.booking_id || src.agent_booking_id) &&
    statuses.some((s) => confirmedLike.some((c) => s.includes(c)));

  if (hasConfirmedRecord && missing.length === 0) {
    return 'likely_confirmed — still verify from SMS that customer agreed; do not re-book unless updating';
  }
  if (src.prebooking_id || src.booking_id || src.agent_booking_id || crm.proposed) {
    if (missing.length) {
      return `needs_finishing — missing: ${missing.join(', ')}`;
    }
    return 'details_present_unconfirmed — treat as needs_finishing until SMS shows explicit book confirmation';
  }
  return 'quote_or_early — no booking record; help schedule if interested';
}

function clean(v) {
  if (v == null) return null;
  const s = String(v).trim();
  return s && s !== '...' ? s : null;
}
