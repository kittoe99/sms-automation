import { getSupabaseAdmin, isSupabaseConfigured } from '../supabase.js';
import { findDirectoryContact } from '../supabaseContacts.js';
import { listEnrollments } from '../supabaseContacts.js';
import { setAiPaused } from '../messageStore.js';

const FAQ = {
  business_name: 'Opek Junk Removal',
  hours: 'Typical crew hours Mon–Sat 8am–6pm local time; exact slots confirmed by the team.',
  service_area: 'We primarily serve the metro areas where Opek operates. Share your zip and we will confirm.',
  services: 'Junk removal, hauling, garage/estate cleanouts, and related light moving help.',
  booking_note: 'SMS bookings create a lead for our team — we confirm schedule and pricing before the job.',
  human_handoff: 'Reply that a teammate will follow up shortly.',
};

export const TOOL_DEFINITIONS = [
  {
    type: 'function',
    function: {
      name: 'lookup_contact',
      description: 'Look up the SMS contact in the Opek directory and their automation enrollments.',
      parameters: {
        type: 'object',
        properties: {
          phone: { type: 'string', description: 'E.164 or digits; defaults to the inbound From number' },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_business_hours_or_faq',
      description: 'Return Opek hours, service blurb, and booking policy for accurate answers.',
      parameters: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_agent_booking',
      description:
        'Create an SMS agent booking lead in Opek (agent_bookings). Requires customer_name. Use inbound phone if customer_phone omitted.',
      parameters: {
        type: 'object',
        properties: {
          customer_name: { type: 'string' },
          customer_phone: { type: 'string' },
          customer_email: { type: 'string' },
          service_type: { type: 'string' },
          zip_code: { type: 'string' },
          service_address: { type: 'string' },
          preferred_date: { type: 'string', description: 'Preferred date YYYY-MM-DD or natural language' },
          preferred_time_window: { type: 'string' },
          notes: { type: 'string', description: 'Junk items / access notes' },
          call_summary: { type: 'string', description: 'Short summary of the SMS conversation' },
        },
        required: ['customer_name'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'escalate_to_human',
      description: 'Pause AI auto-replies for this thread and note that a human should follow up.',
      parameters: {
        type: 'object',
        properties: {
          reason: { type: 'string' },
        },
        additionalProperties: false,
      },
    },
  },
];

/**
 * @param {string} name
 * @param {object} args
 * @param {{ phone: string, inboundSid?: string|null }} ctx
 */
export async function executeTool(name, args, ctx) {
  switch (name) {
    case 'lookup_contact':
      return lookupContact(args?.phone || ctx.phone);
    case 'get_business_hours_or_faq':
      return { ...FAQ };
    case 'create_agent_booking':
      return createAgentBooking(args || {}, ctx);
    case 'escalate_to_human':
      return escalateToHuman(ctx.phone, args?.reason || null);
    default:
      return { error: `Unknown tool: ${name}` };
  }
}

async function lookupContact(phone) {
  try {
    const contact = await findDirectoryContact(phone);
    let enrollments = [];
    try {
      const page = await listEnrollments({ page: 1, pageSize: 50 });
      const digits = String(phone || '').replace(/\D/g, '');
      enrollments = (page.enrollments || []).filter((e) => {
        const d = String(e.phone_digits || e.phone || '').replace(/\D/g, '');
        return d && (d === digits || d.endsWith(digits.slice(-10)) || digits.endsWith(d.slice(-10)));
      });
    } catch {
      /* optional */
    }
    return {
      found: Boolean(contact),
      contact: contact || null,
      enrollments,
    };
  } catch (err) {
    return { error: err.message || String(err) };
  }
}

async function createAgentBooking(args, ctx) {
  if (!isSupabaseConfigured()) {
    return { error: 'Supabase is not configured' };
  }
  const customerName = String(args.customer_name || '').trim();
  const customerPhone = String(args.customer_phone || ctx.phone || '').trim();
  if (!customerName || !customerPhone) {
    return { error: 'customer_name and customer_phone are required' };
  }

  const details = {};
  if (args.notes) details.notes = String(args.notes);

  const row = {
    customer_name: customerName,
    customer_phone: customerPhone,
    customer_email: args.customer_email ? String(args.customer_email).trim() : null,
    service_type: args.service_type ? String(args.service_type).trim() : null,
    zip_code: args.zip_code ? String(args.zip_code).trim() : null,
    service_address: args.service_address ? String(args.service_address).trim() : null,
    preferred_date: args.preferred_date ? String(args.preferred_date).trim() : null,
    preferred_time_window: args.preferred_time_window
      ? String(args.preferred_time_window).trim()
      : null,
    call_summary: args.call_summary
      ? String(args.call_summary).trim()
      : 'Booked via Opek SMS AI agent',
    conversation_id: ctx.inboundSid || null,
    agent_id: 'sms_ai_agent',
    details,
    raw_payload: { ...args, source: 'sms_agent', from: ctx.phone },
    source: 'sms_agent',
    status: 'new',
  };

  const { data, error } = await getSupabaseAdmin()
    .from('agent_bookings')
    .insert(row)
    .select('id, created_at, status')
    .single();

  if (error) {
    console.error('[opek-sms] create_agent_booking failed', error);
    return { error: error.message || 'Failed to save booking' };
  }

  return {
    ok: true,
    booking_id: data.id,
    status: data.status,
    created_at: data.created_at,
    message: 'Booking saved. Our team will confirm shortly.',
  };
}

async function escalateToHuman(phone, reason) {
  const contact = await setAiPaused(phone, true, reason);
  return {
    ok: true,
    paused: true,
    reason: reason || null,
    contact,
    customer_message_hint: FAQ.human_handoff,
  };
}
