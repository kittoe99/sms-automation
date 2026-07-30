import { getAiConfig, gradientChat, isAiConfigured } from './client.js';
import { executeTool } from './tools.js';
import { loadCustomerBookingContext } from './customerContext.js';
import { isOptedOut, getConversation, getContact } from '../messageStore.js';
import { getSupabaseAdmin, isSupabaseConfigured } from '../supabase.js';
import { phoneDigits } from '../messageDb.js';
import { sendSms } from '../twilioClient.js';

const processedInboundSids = new Set();
const OPT_OUT_START = /^(stop|stopall|unsubscribe|cancel|end|quit|start|unstop|yes)\b/i;
const BOOKING_RE = /^BOOKING_JSON:(.+)$/m;
const UPDATE_RE = /^UPDATE_BOOKING_JSON:(.+)$/m;
const ESCALATE_RE = /^ESCALATE:(.*)$/m;

/**
 * Background entrypoint after inbound is persisted.
 * Eligibility stays in App Platform; conversation runs on Gradient AI Agents.
 */
export async function handleInboundAi({ from, body, sid = null }) {
  try {
    if (!from) return { skipped: true, reason: 'missing_from' };
    if (!isAiConfigured()) return { skipped: true, reason: 'ai_disabled' };

    if (sid) {
      if (processedInboundSids.has(sid)) return { skipped: true, reason: 'duplicate_sid' };
      processedInboundSids.add(sid);
      if (processedInboundSids.size > 5000) {
        const first = processedInboundSids.values().next().value;
        processedInboundSids.delete(first);
      }
    }

    const text = String(body || '').trim();
    if (!text) return { skipped: true, reason: 'empty_body' };
    if (OPT_OUT_START.test(text)) return { skipped: true, reason: 'consent_keyword' };
    if (await isOptedOut(from)) return { skipped: true, reason: 'opted_out' };

    const eligibility = await checkEligibility(from);
    if (!eligibility.ok) return { skipped: true, reason: eligibility.reason };

    const cfg = getAiConfig();
    const result = await runAgentTurn({
      phone: from,
      inboundBody: text,
      inboundSid: sid,
      categoryId: eligibility.categoryId,
      contactName: eligibility.contactName,
      maxHistory: cfg.maxHistory,
      maxReplyChars: cfg.maxReplyChars,
    });

    return result;
  } catch (err) {
    console.error('[opek-sms] AI inbound handler failed', err);
    return { skipped: true, reason: 'error', detail: err.message || String(err) };
  }
}

export async function checkEligibility(phone) {
  const cfg = getAiConfig();
  if (!cfg.enabledCategories.length) {
    return { ok: false, reason: 'no_ai_categories' };
  }

  const contact = await getContact(phone).catch(() => null);
  if (contact?.aiPausedAt) {
    return { ok: false, reason: 'ai_paused' };
  }
  if (contact && contact.aiEnabled === false) {
    return { ok: false, reason: 'ai_disabled_thread' };
  }

  if (!isSupabaseConfigured()) {
    return { ok: false, reason: 'supabase_missing' };
  }

  const digits = phoneDigits(phone);
  if (!digits) return { ok: false, reason: 'invalid_phone' };

  const { data, error } = await getSupabaseAdmin()
    .from('sms_automation_enrollments')
    .select('category_id, name, status, phone, phone_digits')
    .eq('status', 'enrolled')
    .in('category_id', cfg.enabledCategories);

  if (error) throw error;

  const last10 = digits.slice(-10);
  const matches = (data || []).filter((row) => {
    const d = String(row.phone_digits || '').replace(/\D/g, '');
    return d === digits || d === last10 || d.endsWith(last10) || last10.endsWith(d.slice(-10));
  });

  if (!matches.length) {
    return { ok: false, reason: 'not_enrolled' };
  }

  const preferred =
    matches.find((m) => m.category_id === 'quote-requests') ||
    matches.find((m) => m.category_id === 'appointment-reminders') ||
    matches[0];

  return {
    ok: true,
    categoryId: preferred.category_id,
    contactName: preferred.name || contact?.name || null,
    enrollments: matches.map((m) => m.category_id),
  };
}

async function runAgentTurn({
  phone,
  inboundBody,
  inboundSid,
  categoryId,
  contactName,
  maxHistory,
  maxReplyChars,
}) {
  const [conversation, crmContext] = await Promise.all([
    getConversation(phone),
    loadCustomerBookingContext(phone),
  ]);
  const historyMsgs = (conversation?.messages || []).slice(-maxHistory);
  const knownName =
    contactName || conversation?.name || crmContext.proposed?.customer_name || null;

  const contextBlock = [
    'CRM CONTEXT (trusted — use to confirm, do not invent missing fields):',
    crmContext.summaryText,
    '',
    'Proposed booking draft JSON (merge customer corrections on top):',
    JSON.stringify(crmContext.proposed || {}, null, 0),
    '',
    `Customer SMS phone: ${phone}`,
    knownName ? `Known name: ${knownName}` : null,
    `Automation category: ${categoryId}`,
    'Ask only for missing fields. Prefer confirming the draft over re-asking known details.',
  ]
    .filter(Boolean)
    .join('\n');

  const messages = [
    { role: 'user', content: contextBlock },
    ...historyMsgs
      .filter((m) => m.body && String(m.body).trim())
      .map((m) => ({
        role: m.direction === 'inbound' ? 'user' : 'assistant',
        content: String(m.body).trim(),
      })),
  ];

  const last = messages[messages.length - 1];
  if (!last || last.role !== 'user' || last.content !== inboundBody) {
    messages.push({ role: 'user', content: inboundBody });
  }

  const completion = await gradientChat({ messages, maxTokens: 500 });
  const toolsUsed = [];
  const { reply, booking, updateBooking, escalateReason } = parseAgentActions(
    completion.content,
    phone,
    crmContext.proposed
  );

  if (escalateReason !== null) {
    const result = await executeTool(
      'escalate_to_human',
      { reason: escalateReason || 'customer_request' },
      { phone, inboundSid }
    );
    toolsUsed.push({ name: 'escalate_to_human', result });
  }

  if (updateBooking && Object.keys(updateBooking).length) {
    const result = await executeTool('update_agent_booking', updateBooking, {
      phone,
      inboundSid,
    });
    toolsUsed.push({ name: 'update_agent_booking', result });
  }

  if (booking && isUsableBooking(booking)) {
    if (crmContext.proposed?.source_records?.prebooking_id && !booking.prebooking_id) {
      booking.prebooking_id = crmContext.proposed.source_records.prebooking_id;
    }
    if (Array.isArray(crmContext.proposed?.items) && !booking.items) {
      booking.items = crmContext.proposed.items.join(', ');
    }
    if (crmContext.proposed?.quoted_price_summary && !booking.quoted_price_summary) {
      booking.quoted_price_summary = crmContext.proposed.quoted_price_summary;
    }
    const result = await executeTool('create_agent_booking', booking, { phone, inboundSid });
    toolsUsed.push({ name: 'create_agent_booking', result });
  }

  let finalText = truncateSms(reply, maxReplyChars);
  if (!finalText && escalateReason !== null) {
    finalText = 'Got it — a teammate from Opek will follow up shortly.';
  }
  if (!finalText) {
    return { skipped: true, reason: 'empty_model_reply', toolsUsed };
  }

  const message = await sendSms({
    to: phone,
    body: finalText,
    categoryId,
    contactName: knownName,
    meta: {
      role: 'assistant',
      provider: 'digitalocean-gradient',
      model: completion.model,
      tools: toolsUsed.map((t) => t.name),
      inboundSid: inboundSid || null,
      hadPrebooking: Boolean(crmContext.prebookings?.length),
    },
  });

  return {
    skipped: false,
    message,
    toolsUsed,
    reply: finalText,
    categoryId,
    model: completion.model,
  };
}

function parseAgentActions(raw, phone, proposed) {
  let text = String(raw || '').trim();
  let booking = null;
  let updateBooking = null;
  let escalateReason = null;

  const updateMatch = text.match(UPDATE_RE);
  if (updateMatch) {
    try {
      updateBooking = JSON.parse(updateMatch[1].trim());
    } catch (err) {
      console.warn('[opek-sms] UPDATE_BOOKING_JSON parse failed', err.message);
    }
    text = text.replace(UPDATE_RE, '').trim();
  }

  const bookingMatch = text.match(BOOKING_RE);
  if (bookingMatch) {
    try {
      booking = JSON.parse(bookingMatch[1].trim());
      booking = mergeProposed(booking, proposed, phone);
    } catch (err) {
      console.warn('[opek-sms] BOOKING_JSON parse failed', err.message);
    }
    text = text.replace(BOOKING_RE, '').trim();
  }

  const escalateMatch = text.match(ESCALATE_RE);
  if (escalateMatch) {
    escalateReason = String(escalateMatch[1] || '').trim() || 'customer_request';
    text = text.replace(ESCALATE_RE, '').trim();
  }

  return { reply: text, booking, updateBooking, escalateReason };
}

function mergeProposed(booking, proposed, phone) {
  const out = { ...(proposed || {}), ...(booking || {}) };
  out.customer_phone = out.customer_phone || phone;
  // Drop nested objects that agent_bookings insert doesn't want at top-level
  delete out.source_records;
  delete out.moving_options;
  if (Array.isArray(out.items)) out.items = out.items.join(', ');
  return out;
}

function isUsableBooking(booking) {
  const name = String(booking.customer_name || '').trim();
  if (!name || name === '...' || name.includes('...')) return false;
  // Prefer having service or address/zip before saving, but name+phone is the hard min
  return true;
}

function truncateSms(text, maxChars) {
  const s = String(text || '').trim();
  if (!s) return '';
  if (s.length <= maxChars) return s;
  return `${s.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}
