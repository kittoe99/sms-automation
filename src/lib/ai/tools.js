import { getSupabaseAdmin, isSupabaseConfigured } from '../supabase.js';
import { listEnrollments, syncBookingAutomations } from '../supabaseContacts.js';
import { setAiPaused } from '../messageStore.js';
import { loadCustomerBookingContext } from './customerContext.js';

const FAQ = { booking_note: 'Use the business profile in the AI worker. A booking request requires staff confirmation.' };

export const TOOL_DEFINITIONS = [
  {
    type: 'function',
    function: {
      name: 'lookup_customer_context',
      description:
        'Load directory + latest Prebooking/booking/agent_booking details for this phone to confirm before booking.',
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
      name: 'get_business_hours_or_faq',
      description: 'Business profile context is managed by the dedicated AI worker.',
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
      return lookupCustomerContext(ctx.phone);
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
  // Identity comes from the verified Twilio webhook, never from model output.
  const customerPhone = String(ctx.phone || '').trim();
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

  let automations = null;
  try {
    automations = await syncBookingAutomations({
      phone: customerPhone,
      bookingId: data.id,
      status: data.status,
      appointmentDate: row.preferred_date,
      preferredTime: row.preferred_time_window,
      serviceType: row.service_type,
      serviceAddress: row.service_address,
      name: row.customer_name,
      email: row.customer_email,
      source: 'sms_agent',
    });
  } catch (automationError) {
    console.error('[opek-sms] booking automation sync failed', automationError);
  }

  return {
    ok: true,
    booking_id: data.id,
    status: data.status,
    created_at: data.created_at,
    automations,
    message: 'Booking saved. Our team will confirm shortly.',
  };
}

async function updateAgentBooking(args, ctx) {
  if (!isSupabaseConfigured()) {
    return { error: 'Supabase is not configured' };
  }

  const ctxData = await loadCustomerBookingContext(ctx.phone);
  const requestedId = args.booking_id ? String(args.booking_id).trim() : null;
  const booking = requestedId
    ? ctxData.agentBookings.find((b) => String(b.id) === requestedId)
    : ctxData.agentBookings.find((b) => b.status !== 'cancelled');
  if (!booking) {
    return { error: 'No existing agent booking found to update' };
  }
  const bookingId = booking.id;

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
      const value = String(args[key]).trim();
      if (key === 'status' && !['new', 'reviewed', 'confirmed', 'cancelled'].includes(value)) {
        continue;
      }
      patch[key] = value;
    }
  }

  if (args.notes) {
    const { data: existing } = await getSupabaseAdmin()
      .from('agent_bookings')
      .select('details')
      .eq('id', bookingId)
      .eq('customer_phone', booking.customer_phone)
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
    .eq('customer_phone', booking.customer_phone)
    .select(
      'id, status, preferred_date, preferred_time_window, service_address, zip_code, service_type, updated_at'
    )
    .single();

  if (error) {
    console.error('[opek-sms] update_agent_booking failed', error);
    return { error: error.message || 'Failed to update booking' };
  }

  let automations = null;
  try {
    automations = await syncBookingAutomations({
      phone: ctx.phone,
      bookingId: data.id,
      status: data.status,
      appointmentDate: data.preferred_date,
      preferredTime: data.preferred_time_window,
      serviceType: data.service_type,
      serviceAddress: data.service_address,
      name: booking.customer_name,
      email: booking.customer_email,
      source: 'sms_agent',
    });
  } catch (automationError) {
    console.error('[opek-sms] booking automation reschedule failed', automationError);
  }

  return {
    ok: true,
    booking: data,
    automations,
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
