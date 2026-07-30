/**
 * Supabase persistence for SMS CRM communications.
 * Service-role only tables: sms_messages, sms_thread_contacts.
 */

import { getSupabaseAdmin, isSupabaseConfigured } from './supabase.js';

export function canPersistMessages() {
  return isSupabaseConfigured();
}

export function phoneDigits(value) {
  return String(value || '').replace(/\D/g, '') || '';
}

export function messageToRow(msg) {
  const contactPhone = msg.contactPhone || msg.to || msg.from || 'unknown';
  return {
    id: msg.id,
    sid: msg.sid || null,
    direction: msg.direction,
    category_id: msg.categoryId || null,
    contact_phone: contactPhone,
    phone_digits: phoneDigits(contactPhone),
    to: msg.to || null,
    from: msg.from || null,
    body: msg.body || '',
    deliverability: msg.deliverability || 'queued',
    error_code: msg.errorCode || null,
    error_message: msg.errorMessage || null,
    contact_name: msg.contactName || null,
    status_history: msg.statusHistory || [],
    meta: msg.meta && typeof msg.meta === 'object' ? msg.meta : {},
    created_at: msg.createdAt,
    updated_at: msg.updatedAt,
  };
}

export function rowToMessage(row) {
  if (!row) return null;
  return {
    id: row.id,
    sid: row.sid,
    direction: row.direction,
    categoryId: row.category_id,
    contactPhone: row.contact_phone,
    to: row.to,
    from: row.from,
    body: row.body,
    deliverability: row.deliverability,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    contactName: row.contact_name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    statusHistory: row.status_history || [],
    meta: row.meta || {},
  };
}

export function contactToRow(c) {
  return {
    phone: c.phone,
    phone_digits: phoneDigits(c.phone),
    name: c.name || null,
    message_count: c.messageCount || 0,
    outbound_count: c.outboundCount || 0,
    inbound_count: c.inboundCount || 0,
    unread_count: c.unreadCount || 0,
    last_message_at: c.lastMessageAt || null,
    last_direction: c.lastDirection || null,
    last_body: c.lastBody || null,
    last_deliverability: c.lastDeliverability || null,
    category_ids: Array.isArray(c.categoryIds)
      ? c.categoryIds
      : [...(c.categoryIds || [])],
    opted_out: Boolean(c.optedOut),
    opted_out_at: c.optedOutAt || null,
    opted_in_at: c.optedInAt || null,
    opt_out_keyword: c.optOutKeyword || null,
    opt_out_source: c.optOutSource || null,
    ai_enabled: c.aiEnabled !== false,
    ai_paused_at: c.aiPausedAt || null,
    created_at: c.createdAt || new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
}

export function rowToContact(row) {
  if (!row) return null;
  return {
    phone: row.phone,
    name: row.name,
    messageCount: row.message_count || 0,
    outboundCount: row.outbound_count || 0,
    inboundCount: row.inbound_count || 0,
    unreadCount: row.unread_count || 0,
    lastMessageAt: row.last_message_at,
    lastDirection: row.last_direction,
    lastBody: row.last_body,
    lastDeliverability: row.last_deliverability,
    categoryIds: new Set(row.category_ids || []),
    optedOut: Boolean(row.opted_out),
    optedOutAt: row.opted_out_at,
    optedInAt: row.opted_in_at,
    optOutKeyword: row.opt_out_keyword,
    optOutSource: row.opt_out_source,
    aiEnabled: row.ai_enabled !== false,
    aiPausedAt: row.ai_paused_at || null,
    createdAt: row.created_at,
  };
}

export async function dbUpsertMessage(msg) {
  if (!canPersistMessages()) return;
  const { error } = await getSupabaseAdmin()
    .from('sms_messages')
    .upsert(messageToRow(msg), { onConflict: 'id' });
  if (error) throw error;
}

export async function dbUpsertContact(contact) {
  if (!canPersistMessages() || !contact?.phone) return;
  const { error } = await getSupabaseAdmin()
    .from('sms_thread_contacts')
    .upsert(contactToRow(contact), { onConflict: 'phone' });
  if (error) throw error;
}

export async function dbGetMessage(idOrSid) {
  if (!canPersistMessages() || !idOrSid) return null;
  const admin = getSupabaseAdmin();
  let { data, error } = await admin.from('sms_messages').select('*').eq('id', idOrSid).maybeSingle();
  if (error) throw error;
  if (!data) {
    ({ data, error } = await admin.from('sms_messages').select('*').eq('sid', idOrSid).maybeSingle());
    if (error) throw error;
  }
  return rowToMessage(data);
}

export async function dbGetContact(phone) {
  if (!canPersistMessages()) return null;
  const digits = phoneDigits(phone);
  if (!digits) return null;
  const admin = getSupabaseAdmin();
  let { data, error } = await admin
    .from('sms_thread_contacts')
    .select('*')
    .eq('phone', phone)
    .maybeSingle();
  if (error) throw error;
  if (!data && digits) {
    ({ data, error } = await admin
      .from('sms_thread_contacts')
      .select('*')
      .eq('phone_digits', digits)
      .maybeSingle());
    if (error) throw error;
  }
  return rowToContact(data);
}

export async function dbListMessages({
  categoryId,
  status,
  q,
  contact,
  page = 1,
  pageSize = 50,
} = {}) {
  if (!canPersistMessages()) return null;

  const size = Math.min(Math.max(Number(pageSize) || 50, 1), 250);
  const p = Math.max(1, Number(page) || 1);
  const from = (p - 1) * size;
  const to = from + size - 1;

  let query = getSupabaseAdmin()
    .from('sms_messages')
    .select('*', { count: 'exact' })
    .order('created_at', { ascending: false })
    .range(from, to);

  if (categoryId) query = query.eq('category_id', categoryId);
  if (status) query = query.eq('deliverability', String(status).toLowerCase());
  if (contact) {
    const digits = phoneDigits(contact);
    if (digits) query = query.eq('phone_digits', digits);
  }
  if (q) {
    const safe = String(q).trim().replace(/[%_,.()]/g, ' ').replace(/\s+/g, ' ').trim();
    if (safe) {
      const needle = `%${safe}%`;
      query = query.or(
        `body.ilike.${JSON.stringify(needle)},sid.ilike.${JSON.stringify(needle)},contact_phone.ilike.${JSON.stringify(needle)},contact_name.ilike.${JSON.stringify(needle)},to.ilike.${JSON.stringify(needle)},from.ilike.${JSON.stringify(needle)}`
      );
    }
  }

  const { data, error, count } = await query;
  if (error) throw error;

  const total = count || 0;
  return {
    messages: (data || []).map(rowToMessage),
    page: p,
    pageSize: size,
    total,
    totalPages: Math.max(1, Math.ceil(total / size)),
  };
}

export async function dbListContacts({
  q,
  status = null,
  unreadOnly = false,
  page = 1,
  pageSize = 50,
} = {}) {
  if (!canPersistMessages()) return null;

  const size = Math.min(Math.max(Number(pageSize) || 50, 1), 250);
  const p = Math.max(1, Number(page) || 1);
  const from = (p - 1) * size;
  const to = from + size - 1;

  let query = getSupabaseAdmin()
    .from('sms_thread_contacts')
    .select('*', { count: 'exact' })
    .order('last_message_at', { ascending: false, nullsFirst: false })
    .range(from, to);

  if (status === 'opted_out') query = query.eq('opted_out', true);
  if (status === 'active') query = query.eq('opted_out', false);
  if (unreadOnly) query = query.gt('unread_count', 0);
  if (q) {
    const needle = `%${String(q).trim()}%`;
    query = query.or(`phone.ilike.${needle},name.ilike.${needle},last_body.ilike.${needle}`);
  }

  const { data, error, count } = await query;
  if (error) throw error;

  const total = count || 0;
  return {
    contacts: (data || []).map(rowToContact),
    page: p,
    pageSize: size,
    total,
    totalPages: Math.max(1, Math.ceil(total / size)),
  };
}

export async function dbListThreadMessages(phone, { limit = 200 } = {}) {
  if (!canPersistMessages()) return null;
  const digits = phoneDigits(phone);
  if (!digits) return [];

  const { data, error } = await getSupabaseAdmin()
    .from('sms_messages')
    .select('*')
    .eq('phone_digits', digits)
    .order('created_at', { ascending: true })
    .limit(Math.min(Math.max(Number(limit) || 200, 1), 500));

  if (error) throw error;
  return (data || []).map(rowToMessage);
}

export async function dbMarkConversationRead(phone) {
  if (!canPersistMessages()) return null;
  const existing = await dbGetContact(phone);
  if (!existing) return null;
  existing.unreadCount = 0;
  await dbUpsertContact(existing);
  return existing;
}

export async function dbDeliverabilitySummary({ categoryId } = {}) {
  if (!canPersistMessages()) return null;

  let query = getSupabaseAdmin().from('sms_messages').select('deliverability');
  if (categoryId) query = query.eq('category_id', categoryId);

  const { data, error } = await query;
  if (error) throw error;

  const counts = {
    queued: 0,
    sending: 0,
    sent: 0,
    delivered: 0,
    undelivered: 0,
    failed: 0,
    receiving: 0,
    received: 0,
    accepted: 0,
    scheduled: 0,
    canceled: 0,
    read: 0,
    other: 0,
  };

  for (const row of data || []) {
    const key = counts[row.deliverability] !== undefined ? row.deliverability : 'other';
    counts[key] += 1;
  }

  const total = (data || []).length;
  const delivered = counts.delivered || 0;
  const failedish = (counts.undelivered || 0) + (counts.failed || 0);
  const terminal = delivered + failedish + (counts.canceled || 0);

  const { count: contactCount, error: cErr } = await getSupabaseAdmin()
    .from('sms_thread_contacts')
    .select('*', { count: 'exact', head: true });
  if (cErr) throw cErr;

  return {
    total,
    counts,
    contactCount: contactCount || 0,
    deliveryRate: terminal ? Math.round((delivered / terminal) * 1000) / 10 : null,
  };
}

export async function dbOverviewExtras() {
  if (!canPersistMessages()) return null;
  const admin = getSupabaseAdmin();

  const [{ count: conversationCount }, { count: inboundTotal }, opted] = await Promise.all([
    admin.from('sms_thread_contacts').select('*', { count: 'exact', head: true }),
    admin.from('sms_messages').select('*', { count: 'exact', head: true }).eq('direction', 'inbound'),
    admin.from('sms_thread_contacts').select('unread_count, opted_out'),
  ]);

  if (opted.error) throw opted.error;

  const rows = opted.data || [];
  return {
    conversationCount: conversationCount || 0,
    inboundTotal: inboundTotal || 0,
    unreadTotal: rows.reduce((n, r) => n + (r.unread_count || 0), 0),
    optedOutTotal: rows.filter((r) => r.opted_out).length,
  };
}

export async function dbCategoryMessageCount(categoryId) {
  if (!canPersistMessages() || !categoryId) return null;
  const { count, error } = await getSupabaseAdmin()
    .from('sms_messages')
    .select('*', { count: 'exact', head: true })
    .eq('category_id', categoryId);
  if (error) throw error;
  return count || 0;
}

export async function dbIsOptedOut(phone) {
  const c = await dbGetContact(phone);
  return Boolean(c?.optedOut);
}
