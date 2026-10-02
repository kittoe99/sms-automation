const clean = value => String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');

export function requestConflictsWithBooking(request, booking) {
  if (!request || !booking) return false;
  const requestName = clean(request.name);
  const bookingName = clean(booking.customer_name);
  const requestAddress = clean(request.details?.service_address);
  const bookingAddress = clean(booking.service_address);
  return Boolean((requestName && bookingName && requestName !== bookingName)
    || (requestAddress && bookingAddress && requestAddress !== bookingAddress));
}

export function currentRequestHistory(context) {
  const createdAt = context.active_request?.created_at || context.source?.created_at;
  if (!createdAt) return context.history || [];
  return (context.history || []).filter(message => String(message.created_at || '') >= String(createdAt));
}

export function requestConflict(context) {
  const request = context.active_request || context.source;
  const booking = context.booking_session || context.recent_booking || context.booking;
  return requestConflictsWithBooking(request, booking);
}

export function hasClarifiedCurrentRequest(context) {
  const history = currentRequestHistory(context);
  const clarification = history.findLastIndex(message => message.direction === 'outbound'
    && /new quote request from this number/i.test(String(message.body || '')));
  if (clarification < 0) return false;
  return history.slice(clarification + 1).some(message => message.direction === 'inbound'
    && /^(yes|yep|yeah|correct|the new (quote|request)|new quote|that one)\b/i.test(String(message.body || '').trim()));
}

