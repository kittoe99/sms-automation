import { getSupabaseAdmin, isSupabaseConfigured } from '../supabase.js';
import { findDirectoryContact } from '../supabaseContacts.js';
import { phoneDigits } from '../messageDb.js';

/**
 * Load CRM/prebooking context for an SMS phone so the Gradient agent
 * can confirm existing details instead of re-collecting from scratch.
 */
export async function loadCustomerBookingContext(phone) {
  const digits = phoneDigits(phone);
  const last10 = digits ? digits.slice(-10) : '';
  const empty = {
    phone,
    directory: null,
    prebookings: [],
    bookings: [],
    agentBookings: [],
    proposed: null,
    missingFields: [],
    summaryText: 'No prior Opek records found for this phone.',
  };

  if (!isSupabaseConfigured() || !last10) return empty;

  const [directory, prebookings, bookings, agentBookings] = await Promise.all([
    findDirectoryContact(phone).catch(() => null),
    fetchJsonPhoneRows('Prebooking', last10, 'id, status, customer_info, booking_details, created_at').catch(
      (err) => {
        console.warn('[opek-sms] prebooking lookup failed', err.message);
        return [];
      }
    ),
    fetchJsonPhoneRows(
      'bookings',
      last10,
      'id, status, customer_info, location_info, booking_details, created_at'
    ).catch((err) => {
      console.warn('[opek-sms] booking lookup failed', err.message);
      return [];
    }),
    fetchAgentBookings(last10).catch((err) => {
      console.warn('[opek-sms] agent_bookings lookup failed', err.message);
      return [];
    }),
  ]);

  const proposed = buildProposedProfile({
    phone,
    directory,
    prebookings,
    bookings,
    agentBookings,
  });
  const missingFields = listMissingFields(proposed);

  return {
    phone,
    directory,
    prebookings,
    bookings,
    agentBookings,
    proposed,
    missingFields,
    summaryText: formatContextSummary({
      directory,
      prebookings,
      bookings,
      agentBookings,
      proposed,
      missingFields,
    }),
  };
}

async function fetchJsonPhoneRows(table, last10, select) {
  const pattern = phoneIlikePattern(last10);
  const { data, error } = await getSupabaseAdmin()
    .from(table)
    .select(select)
    .ilike('customer_info->>phone', pattern)
    .order('created_at', { ascending: false })
    .limit(8);
  if (error) throw error;
  return (data || []).filter((row) => phonesMatch(row.customer_info?.phone, last10));
}

async function fetchAgentBookings(last10) {
  const { data, error } = await getSupabaseAdmin()
    .from('agent_bookings')
    .select(
      'id, status, source, customer_name, customer_phone, customer_email, service_type, zip_code, service_address, preferred_date, preferred_time_window, quoted_price_summary, call_summary, details, created_at, updated_at'
    )
    .order('created_at', { ascending: false })
    .limit(40);
  if (error) throw error;
  return (data || []).filter((row) => phonesMatch(row.customer_phone, last10)).slice(0, 5);
}

function phoneIlikePattern(last10) {
  // Matches formats like (720) 842-9167, 720-842-9167, 7208429167
  return `%${last10.slice(0, 3)}%${last10.slice(3, 6)}%${last10.slice(6)}%`;
}

function buildProposedProfile({ phone, directory, prebookings, bookings, agentBookings }) {
  const latestPb = prebookings[0] || null;
  const latestBooking = bookings[0] || null;
  const latestAgent = agentBookings[0] || null;
  const ci = latestPb?.customer_info || latestBooking?.customer_info || {};
  const bd = latestPb?.booking_details || latestBooking?.booking_details || {};
  const loc = latestBooking?.location_info || {};

  const items = bd.estimated_items || bd.items || latestAgent?.details?.items || null;
  const notes =
    clean(bd.details) ||
    clean(bd.estimate_summary) ||
    clean(latestAgent?.details?.notes) ||
    clean(latestAgent?.call_summary) ||
    null;

  return {
    customer_name:
      clean(ci.name) || clean(directory?.name) || clean(latestAgent?.customer_name) || null,
    customer_phone: phone,
    customer_email:
      clean(ci.email) || clean(directory?.email) || clean(latestAgent?.customer_email) || null,
    service_type: clean(bd.service_type) || clean(latestAgent?.service_type) || null,
    zip_code:
      clean(bd.zip_code) ||
      clean(loc.zip) ||
      clean(loc.zip_code) ||
      clean(latestAgent?.zip_code) ||
      null,
    service_address:
      clean(loc.address) || clean(bd.address) || clean(latestAgent?.service_address) || null,
    preferred_date:
      clean(bd.preferred_date) || clean(bd.date) || clean(latestAgent?.preferred_date) || null,
    preferred_time_window:
      clean(bd.preferred_time_window) ||
      clean(bd.time_slot) ||
      clean(bd.time_window) ||
      clean(latestAgent?.preferred_time_window) ||
      null,
    quoted_price_summary:
      bd.price != null
        ? `Quoted/est. $${bd.price}`
        : clean(latestAgent?.quoted_price_summary) || clean(bd.estimate_summary) || null,
    notes,
    items: Array.isArray(items) ? items : null,
    moving_options: bd.moving_options || latestAgent?.details?.moving_options || null,
    source_records: {
      prebooking_id: latestPb?.id || null,
      booking_id: latestBooking?.id || null,
      agent_booking_id: latestAgent?.id || null,
      prebooking_status: latestPb?.status || null,
      booking_status: latestBooking?.status || null,
      agent_booking_status: latestAgent?.status || null,
    },
  };
}

function listMissingFields(proposed) {
  if (!proposed) {
    return [
      'customer_name',
      'service_type',
      'service_address_or_zip',
      'preferred_date',
      'preferred_time_window',
      'notes',
    ];
  }
  const missing = [];
  if (!proposed.customer_name) missing.push('customer_name');
  if (!proposed.service_type) missing.push('service_type');
  if (!proposed.service_address && !proposed.zip_code) missing.push('service_address_or_zip');
  if (!proposed.preferred_date) missing.push('preferred_date');
  if (!proposed.preferred_time_window) missing.push('preferred_time_window');
  if (!proposed.notes && !(proposed.items && proposed.items.length)) missing.push('notes_or_items');
  return missing;
}

function formatContextSummary({
  directory,
  prebookings,
  bookings,
  agentBookings,
  proposed,
  missingFields,
}) {
  const lines = [];
  if (directory) {
    lines.push(
      `Directory: ${directory.name || 'unknown'} · consent=${directory.smsMarketingConsent === true} · sources=${(directory.sources || []).join(',') || 'n/a'}`
    );
  } else {
    lines.push('Directory: not found');
  }

  if (prebookings[0]) {
    const p = prebookings[0];
    const bd = p.booking_details || {};
    lines.push(
      `Latest prebooking (${p.status}): service=${bd.service_type || 'n/a'}; zip=${bd.zip_code || 'n/a'}; items=${summarizeItems(bd)}; price=${bd.price ?? 'n/a'}; created=${p.created_at}`
    );
  } else {
    lines.push('Latest prebooking: none');
  }

  if (bookings[0]) {
    const b = bookings[0];
    lines.push(
      `Latest website booking (${b.status}): address=${b.location_info?.address || 'n/a'}; date=${b.booking_details?.preferred_date || b.booking_details?.date || 'n/a'}`
    );
  } else {
    lines.push('Latest website booking: none');
  }

  if (agentBookings[0]) {
    const a = agentBookings[0];
    lines.push(
      `Latest agent booking ${a.id} (${a.status}): ${a.customer_name}; ${a.service_type || 'service n/a'}; ${a.service_address || a.zip_code || 'address n/a'}; ${a.preferred_date || 'date n/a'} ${a.preferred_time_window || ''}`
    );
  } else {
    lines.push('Latest agent booking: none');
  }

  if (proposed) {
    lines.push(
      `Proposed confirm profile: name=${proposed.customer_name || 'missing'}; email=${proposed.customer_email || 'n/a'}; service=${proposed.service_type || 'missing'}; zip=${proposed.zip_code || 'n/a'}; address=${proposed.service_address || 'n/a'}; date=${proposed.preferred_date || 'missing'}; window=${proposed.preferred_time_window || 'missing'}; notes=${proposed.notes || (proposed.items || []).join(', ') || 'missing'}`
    );
    lines.push(
      missingFields.length
        ? `Still missing before booking: ${missingFields.join(', ')}`
        : 'All core booking fields present — confirm with customer then emit BOOKING_JSON.'
    );
  }

  return lines.join('\n');
}

function summarizeItems(bd) {
  const items = bd.estimated_items || bd.items;
  if (Array.isArray(items) && items.length) return items.slice(0, 6).join('; ');
  if (bd.details) return String(bd.details).slice(0, 120);
  return 'n/a';
}

function phonesMatch(a, bLast10) {
  const d = String(a || '').replace(/\D/g, '');
  if (!d || !bLast10) return false;
  return d === bLast10 || d.endsWith(bLast10) || bLast10.endsWith(d.slice(-10));
}

function clean(v) {
  if (v == null) return null;
  const s = String(v).trim();
  return s ? s : null;
}
