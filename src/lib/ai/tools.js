import { getSupabaseAdmin, isSupabaseConfigured } from '../supabase.js';
import { listEnrollments } from '../supabaseContacts.js';
import { setAiPaused } from '../messageStore.js';
import { loadCustomerBookingContext } from './customerContext.js';

const FAQ = {
  business_name: 'Opek Junk Removal',
  website: 'https://opekjunkremoval.com',
  hours: '7 days a week, 7am–8pm local time; exact slots confirmed by the team.',
  service_area: 'Nationwide coverage across all 50 states. Share your zip and we will confirm crew availability.',
  services: 'Junk removal, dumpster rentals, property cleanouts, local moving/labor, mattress disposal.',
  support_email: 'Support@opekjunkremoval.com',
  support_phone: '(831) 318-7139',
  links: {
    booking: 'https://opekjunkremoval.com/booking',
    quote: 'https://opekjunkremoval.com/quote',
    track: 'https://opekjunkremoval.com/track-order',
    in_home_estimate: 'https://opekjunkremoval.com/in-home-estimate',
    contact: 'https://opekjunkremoval.com/contact',
  },
  booking_note:
    'SMS bookings create an agent_bookings lead — team confirms schedule and final pricing. No payment over SMS.',
  reschedule: 'Date/time changes are free if requested at least 24 hours in advance when possible.',
  insurance: 'Fully licensed and insured. Final price may adjust on site if the load differs.',
  hazardous:
    'We cannot take hazardous materials, chemicals, wet paint, gasoline, motor oil, asbestos, propane tanks, or biological hazards.',
  moving_rates: '1 helper $79/hr, 2 helpers $119/hr, truck fee $99 (no truck fee for rearrange). Never quote a full moving job total.',
  junk_minimum: 'Junk estimates use item catalog + $169 minimum before 10% online discount.',
  dumpster: '10yd $350, 15 $400, 20 $450, 30 $550 for 7 days; +$25/day after; 14+ days 10% off.',
  mattress: 'Online: 1 item $138, 2 $169, 3+ $227 (after discount).',
  human_handoff: 'Got it — a teammate from Opek will follow up shortly.',
};

export const TOOL_DEFINITIONS = [
  {
    type: 'function',
    function: {
      name: 'lookup_customer_context',
      description:
        'Load directory + latest Prebooking/booking/agent_booking details for this phone to confirm before booking.',
      parameters: {
        type: 'object',
        properties: {
          phone: { type: 'string' },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_business_hours_or_faq',
      description: 'Return Opek hours, services, reschedule policy, and booking notes.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_agent_booking',
      description:
        'Create an SMS agent booking lead in agent_bookings after the customer confirms details.',
      parameters: {
        type: 'object',
        properties: {
          customer_name: { type: 'string' },
          customer_phone: { type: 'string' },
          customer_email: { type: 'string' },
          service_type: { type: 'string' },
          zip_code: { type: 'string' },
          service_address: { type: 'string' },
          preferred_date: { type: 'string' },
          preferred_time_window: { type: 'string' },
          quoted_price_summary: { type: 'string' },
          notes: { type: 'string' },
          items: { type: 'string', description: 'Comma-separated junk/moving items summary' },
          call_summary: { type: 'string' },
          prebooking_id: { type: 'string' },
        },
        required: ['customer_name'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'update_agent_booking',
      description:
        'Update an existing agent_bookings row (reschedule date/window, address, notes). Defaults to latest open booking for this phone.',
      parameters: {
        type: 'object',
        properties: {
          booking_id: { type: 'string' },
          preferred_date: { type: 'string' },
          preferred_time_window: { type: 'string' },
          service_address: { type: 'string' },
          zip_code: { type: 'string' },
          service_type: { type: 'string' },
          notes: { type: 'string' },
          call_summary: { type: 'string' },
          status: { type: 'string', description: 'new|reviewed|confirmed|cancelled' },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'escalate_to_human',
      description: 'Pause AI auto-replies for this thread so a human can follow up.',
      parameters: {
        type: 'object',
        properties: { reason: { type: 'string' } },
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
    case 'lookup_customer_context':
    case 'lookup_contact':
      return lookupCustomerContext(args?.phone || ctx.phone);
    case 'get_business_hours_or_faq':
      return { ...FAQ };
    case 'create_agent_booking':
      return createAgentBooking(args || {}, ctx);
    case 'update_agent_booking':
      return updateAgentBooking(args || {}, ctx);
    case 'escalate_to_human':
      return escalateToHuman(ctx.phone, args?.reason || null);
    default:
      return { error: `Unknown tool: ${name}` };
  }
}

async function lookupCustomerContext(phone) {
  try {
    const context = await loadCustomerBookingContext(phone);
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
      found: Boolean(context.directory || context.prebookings.length || context.agentBookings.length),
      context,
      enrollments,
      faq: FAQ,
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
  if (args.items) details.items = String(args.items);
  if (args.prebooking_id) details.prebooking_id = String(args.prebooking_id);
  if (args.moving_options) details.moving_options = args.moving_options;

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
    quoted_price_summary: args.quoted_price_summary
      ? String(args.quoted_price_summary).trim()
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

async function updateAgentBooking(args, ctx) {
  if (!isSupabaseConfigured()) {
    return { error: 'Supabase is not configured' };
  }

  let bookingId = args.booking_id ? String(args.booking_id).trim() : null;
  if (!bookingId) {
    const ctxData = await loadCustomerBookingContext(ctx.phone);
    bookingId = ctxData.agentBookings.find((b) => b.status !== 'cancelled')?.id || null;
  }
  if (!bookingId) {
    return { error: 'No existing agent booking found to update' };
  }

  const patch = {};
  for (const key of [
    'preferred_date',
    'preferred_time_window',
    'service_address',
    'zip_code',
    'service_type',
    'call_summary',
    'status',
  ]) {
    if (args[key] != null && String(args[key]).trim()) {
      patch[key] = String(args[key]).trim();
    }
  }

  if (args.notes) {
    const { data: existing } = await getSupabaseAdmin()
      .from('agent_bookings')
      .select('details')
      .eq('id', bookingId)
      .maybeSingle();
    patch.details = {
      ...(existing?.details && typeof existing.details === 'object' ? existing.details : {}),
      notes: String(args.notes),
      updated_via: 'sms_agent',
    };
  }

  if (!Object.keys(patch).length) {
    return { error: 'No update fields provided' };
  }

  const { data, error } = await getSupabaseAdmin()
    .from('agent_bookings')
    .update(patch)
    .eq('id', bookingId)
    .select(
      'id, status, preferred_date, preferred_time_window, service_address, zip_code, service_type, updated_at'
    )
    .single();

  if (error) {
    console.error('[opek-sms] update_agent_booking failed', error);
    return { error: error.message || 'Failed to update booking' };
  }

  return {
    ok: true,
    booking: data,
    message: 'Booking updated. Our team will confirm the change.',
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
