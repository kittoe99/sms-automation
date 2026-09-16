/**
 * SMS CRM store — in-memory cache + Supabase persistence (sms_messages /
 * sms_thread_contacts) so history survives deploys and multi-instance.
 */

import { CATEGORIES } from './categories.js';
import {
  canPersistMessages,
  dbCategoryMessageCount,
  dbDeliverabilitySummary,
  dbGetContact,
  dbGetMessage,
  dbInsertContactIfAbsent,
  dbInsertMessageIfAbsent,
  dbIsOptedOut,
  dbListContacts,
  dbListMessages,
  dbListThreadMessages,
  dbMarkConversationRead,
  dbOverviewExtras,
  dbUpsertContact,
  dbUpsertMessage,
  dbUpdateContactIfVersion,
  phoneDigits,
} from './messageDb.js';
import { publish } from './realtime.js';
import { getCurrentTenantId } from './tenantContext.js';
import { getTenantTwilioConfig } from './tenantTwilio.js';

const messages = [];
const bySid = new Map();
const byId = new Map();
/** @type {Map<string, object>} */
const contacts = new Map();

const OPT_OUT_KEYWORDS = new Set(['stop', 'stopall', 'unsubscribe', 'cancel', 'end', 'quit']);
const OPT_IN_KEYWORDS = new Set(['start', 'unstop', 'yes']);

const MAX = Number(process.env.MESSAGE_STORE_MAX || 50000);

export async function listMessages(opts = {}) {
  if (canPersistMessages()) {
    try {
      return await dbListMessages(opts);
    } catch (err) {
      console.error('[opek-sms] db listMessages failed', err.message);
      throw err;
    }
  }
  const size = clamp(opts.pageSize, 1, 250);
  const p = Math.max(1, Number(opts.page) || 1);
  const filtered = filterMessages(opts);
  const total = filtered.length;
  const start = (p - 1) * size;
  return {
    messages: filtered.slice(start, start + size).map(publicMessage),
    page: p,
    pageSize: size,
    total,
    totalPages: Math.max(1, Math.ceil(total / size)),
  };
}

export async function getMessage(idOrSid) {
  const mem = byId.get(idOrSid) || bySid.get(idOrSid) || null;
  if (mem) return publicMessage(mem);
  if (canPersistMessages()) {
    try {
      const row = await dbGetMessage(idOrSid);
      if (row) {
        cacheMessage(row);
        return publicMessage(row);
      }
    } catch (err) {
      console.error('[opek-sms] db getMessage failed', err.message);
      throw err;
    }
  }
  return null;
}

export async function listContacts({ q, status = null, page = 1, pageSize = 50 } = {}) {
  if (canPersistMessages()) {
    try {
      const pageData = await dbListContacts({ q, status, page, pageSize });
      const opted = await dbListContacts({ status: 'opted_out', page: 1, pageSize: 1 });
      const all = await dbListContacts({ page: 1, pageSize: 1 });
      return {
        contacts: pageData.contacts.map(publicContact),
        page: pageData.page,
        pageSize: pageData.pageSize,
        total: pageData.total,
        totalPages: pageData.totalPages,
        contactTotal: all.total,
        optedOutTotal: opted.total,
        activeTotal: Math.max(0, all.total - opted.total),
      };
    } catch (err) {
      console.error('[opek-sms] db listContacts failed', err.message);
      throw err;
    }
  }

  const size = clamp(pageSize, 1, 250);
  const p = Math.max(1, Number(page) || 1);
  let rows = [...contacts.values()].sort((a, b) =>
    String(b.lastMessageAt || '').localeCompare(String(a.lastMessageAt || ''))
  );

  if (status === 'opted_out') rows = rows.filter((c) => c.optedOut);
  if (status === 'active') rows = rows.filter((c) => !c.optedOut);

  if (q) {
    const needle = String(q).toLowerCase();
    rows = rows.filter(
      (c) =>
        c.phone.includes(needle) ||
        (c.name && c.name.toLowerCase().includes(needle)) ||
        (c.lastBody && c.lastBody.toLowerCase().includes(needle))
    );
  }

  const total = rows.length;
  const start = (p - 1) * size;
  const optedOutTotal = [...contacts.values()].filter((c) => c.optedOut).length;

  return {
    contacts: rows.slice(start, start + size).map(publicContact),
    page: p,
    pageSize: size,
    total,
    totalPages: Math.max(1, Math.ceil(total / size)),
    contactTotal: contacts.size,
    optedOutTotal,
    activeTotal: contacts.size - optedOutTotal,
  };
}

export async function listOptOuts({ q, page = 1, pageSize = 50 } = {}) {
  return listContacts({ q, status: 'opted_out', page, pageSize });
}

export async function isOptedOut(phone) {
  if (canPersistMessages()) {
    try {
      return await dbIsOptedOut(normalizePhone(phone) || phone);
    } catch (err) {
      console.error('[opek-sms] db isOptedOut failed', err.message);
      const wrapped = new Error('Unable to verify SMS opt-out status');
      wrapped.code = 'CONSENT_CHECK_UNAVAILABLE';
      wrapped.cause = err;
      throw wrapped;
    }
  }
  const c = contacts.get(normalizePhone(phone));
  return Boolean(c?.optedOut);
}

export async function setOptOutStatus(phone, { optedOut, keyword = null, source = 'manual' } = {}) {
  const key = normalizePhone(phone);
  if (!key) return null;
  if (canPersistMessages()) {
    const saved = await mutatePersistentContact(key, (c) =>
      applyConsent(c, {
        optedOut: Boolean(optedOut),
        keyword,
        source,
        at: new Date().toISOString(),
      })
    );
    return publicContact(saved);
  }

  let c = contacts.get(key);
  const now = new Date().toISOString();
  if (!c) {
    c = blankContact(key);
    contacts.set(key, c);
  }

  applyConsent(c, {
    optedOut: Boolean(optedOut),
    keyword,
    source,
    at: now,
  });

  await safeUpsertContact(c);
  return publicContact(c);
}

/**
 * Pause or resume AI auto-replies for a thread.
 */
export async function setAiPaused(phone, paused = true, reason = null) {
  const key = normalizePhone(phone);
  if (!key) return null;
  if (canPersistMessages()) {
    const saved = await mutatePersistentContact(key, (c) => {
      c.aiPausedAt = paused ? new Date().toISOString() : null;
      if (paused === false) c.aiEnabled = true;
    });
    publish('thread', {
      event: 'upsert',
      record: publicContact(saved),
      source: 'ai_pause',
      reason: reason || null,
    });
    return publicContact(saved);
  }

  let c = contacts.get(key);
  if (!c) {
    c = blankContact(key);
    contacts.set(key, c);
  }

  c.aiPausedAt = paused ? new Date().toISOString() : null;
  if (paused === false) c.aiEnabled = true;
  await safeUpsertContact(c);
  publish('thread', {
    event: 'upsert',
    record: publicContact(c),
    source: 'ai_pause',
    reason: reason || null,
  });
  return publicContact(c);
}

export async function listConversations({ q, unreadOnly = false, page = 1, pageSize = 50 } = {}) {
  if (canPersistMessages()) {
    try {
      const pageData = await dbListContacts({ q, unreadOnly, page, pageSize });
      const extras = await dbOverviewExtras();
      return {
        conversations: pageData.contacts.map(publicContact),
        page: pageData.page,
        pageSize: pageData.pageSize,
        total: pageData.total,
        totalPages: pageData.totalPages,
        unreadTotal: extras?.unreadTotal || 0,
      };
    } catch (err) {
      console.error('[opek-sms] db listConversations failed', err.message);
      throw err;
    }
  }

  const size = clamp(pageSize, 1, 250);
  const p = Math.max(1, Number(page) || 1);
  let rows = [...contacts.values()].sort((a, b) =>
    String(b.lastMessageAt || '').localeCompare(String(a.lastMessageAt || ''))
  );

  if (unreadOnly) rows = rows.filter((c) => c.unreadCount > 0);
  if (q) {
    const needle = String(q).toLowerCase();
    rows = rows.filter(
      (c) =>
        c.phone.includes(needle) ||
        (c.name && c.name.toLowerCase().includes(needle)) ||
        (c.lastBody && c.lastBody.toLowerCase().includes(needle))
    );
  }

  const total = rows.length;
  const start = (p - 1) * size;

  return {
    conversations: rows.slice(start, start + size).map(publicContact),
    page: p,
    pageSize: size,
    total,
    totalPages: Math.max(1, Math.ceil(total / size)),
    unreadTotal: [...contacts.values()].reduce((n, c) => n + (c.unreadCount || 0), 0),
  };
}

export async function getConversation(phone) {
  const key = normalizePhone(phone);
  if (!key) return null;

  if (canPersistMessages()) {
    try {
      const c = (await dbGetContact(key)) || contacts.get(key);
      if (!c) return null;
      const thread = await dbListThreadMessages(key);
      contacts.set(key, c);
      return {
        ...publicContact(c),
        messages: thread.map(publicMessage),
      };
    } catch (err) {
      console.error('[opek-sms] db getConversation failed', err.message);
      throw err;
    }
  }

  const c = contacts.get(key);
  if (!c) return null;
  const thread = messages
    .filter((m) => contactPhoneOf(m) === key)
    .slice()
    .reverse()
    .map(publicMessage);

  return {
    ...publicContact(c),
    messages: thread,
  };
}

export async function markConversationRead(phone) {
  const key = normalizePhone(phone);
  if (!key) return null;

  if (canPersistMessages()) {
    try {
      const c = await dbMarkConversationRead(key);
      if (c) {
        contacts.set(key, c);
        return publicContact(c);
      }
    } catch (err) {
      console.error('[opek-sms] db markConversationRead failed', err.message);
      throw err;
    }
  }

  const c = contacts.get(key);
  if (!c) return null;
  c.unreadCount = 0;
  return publicContact(c);
}

export async function getContact(phone) {
  const key = normalizePhone(phone);
  if (!key) return null;

  if (canPersistMessages()) {
    try {
      const c = await dbGetContact(key);
      if (!c) return null;
      const msgs = await dbListThreadMessages(key, { limit: 100 });
      contacts.set(key, c);
      return {
        ...publicContact(c),
        messages: msgs
          .slice()
          .reverse()
          .map(publicMessage),
      };
    } catch (err) {
      console.error('[opek-sms] db getContact failed', err.message);
      throw err;
    }
  }

  const c = contacts.get(key);
  if (!c) return null;
  const msgs = filterMessages({ contact: key }).slice(0, 100).map(publicMessage);
  return {
    ...publicContact(c),
    messages: msgs,
  };
}

export async function recordOutbound({
  categoryId = null,
  to,
  body,
  sid = null,
  status = 'queued',
  errorCode = null,
  errorMessage = null,
  contactName = null,
  meta = null,
}) {
  const now = new Date().toISOString();
  const id = sid || `local_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const phone = normalizePhone(to);
  const row = {
    id,
    sid: sid || null,
    direction: 'outbound',
    categoryId,
    contactPhone: phone || to,
    to: phone || to,
    from: getTenantTwilioConfig().fromNumber || null,
    body: body || '',
    deliverability: normalizeStatus(status),
    errorCode: errorCode || null,
    errorMessage: errorMessage || null,
    contactName: contactName || null,
    meta: {
      ...(meta && typeof meta === 'object' ? meta : {}),
      tenantId: getCurrentTenantId(),
    },
    createdAt: now,
    updatedAt: now,
    statusHistory: [{ status: normalizeStatus(status), at: now, errorCode: errorCode || null }],
  };

  return persistMessage(row);
}

export async function recordInbound({
  from,
  to = null,
  body,
  sid = null,
  contactName = null,
}) {
  const now = new Date().toISOString();
  const phone = normalizePhone(from);
  const id = sid || `local_in_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const row = {
    id,
    sid: sid || null,
    direction: 'inbound',
    categoryId: null,
    contactPhone: phone || from,
    to: normalizePhone(to) || getTenantTwilioConfig().fromNumber || null,
    from: phone || from,
    body: body || '',
    deliverability: 'received',
    errorCode: null,
    errorMessage: null,
    contactName: contactName || null,
    meta: {
      tenantId: getCurrentTenantId(),
      ai: {
        state: 'pending',
        attempts: 0,
        availableAt: now,
      },
    },
    createdAt: now,
    updatedAt: now,
    statusHistory: [{ status: 'received', at: now, errorCode: null }],
  };

  const saved = await persistMessage(row, { requirePersistence: canPersistMessages() });
  await maybeApplyConsentFromInbound(phone || from, body, now, {
    requirePersistence: canPersistMessages(),
  });
  return saved;
}

export async function updateDeliverability(sid, { status, errorCode = null, to = null } = {}) {
  if (!sid) return null;

  let row = bySid.get(sid);
  if (!row && canPersistMessages()) {
    try {
      row = await dbGetMessage(sid);
      if (row) cacheMessage(row);
    } catch (err) {
      console.error('[opek-sms] db updateDeliverability lookup failed', err.message);
      throw err;
    }
  }

  if (!row) {
    return recordOutbound({
      to: to || 'unknown',
      body: '',
      sid,
      status: status || 'unknown',
      errorCode,
    });
  }

  const next = normalizeStatus(status);
  const now = new Date().toISOString();
  row.deliverability = next;
  row.updatedAt = now;
  if (errorCode) row.errorCode = String(errorCode);
  if (to && row.to === 'unknown') {
    row.to = normalizePhone(to);
    if (!row.contactPhone || row.contactPhone === 'unknown') {
      row.contactPhone = normalizePhone(to);
    }
  }
  row.statusHistory = [
    ...(row.statusHistory || []),
    {
      status: next,
      at: now,
      errorCode: errorCode ? String(errorCode) : null,
    },
  ];
  cacheMessage(row);
  await refreshContactMeta(row);
  await safeUpsertMessage(row);
  return publicMessage(row);
}

export async function deliverabilitySummary({ categoryId } = {}) {
  if (canPersistMessages()) {
    try {
      return await dbDeliverabilitySummary({ categoryId });
    } catch (err) {
      console.error('[opek-sms] db deliverabilitySummary failed', err.message);
      throw err;
    }
  }

  const counts = blankCounts();
  const source = categoryId
    ? messages.filter((m) => m.categoryId === categoryId)
    : messages;

  for (const m of source) {
    const key = counts[m.deliverability] !== undefined ? m.deliverability : 'other';
    counts[key] += 1;
  }

  const total = source.length;
  const delivered = counts.delivered || 0;
  const failedish = (counts.undelivered || 0) + (counts.failed || 0);
  const terminal = delivered + failedish + (counts.canceled || 0);

  return {
    total,
    counts,
    contactCount: contacts.size,
    deliveryRate: terminal ? Math.round((delivered / terminal) * 1000) / 10 : null,
  };
}

export async function overviewStats() {
  const summary = await deliverabilitySummary();
  const byCategory = [];
  for (const c of CATEGORIES) {
    byCategory.push({
      id: c.id,
      name: c.name,
      ...(await deliverabilitySummary({ categoryId: c.id })),
    });
  }

  if (canPersistMessages()) {
    try {
      const extras = await dbOverviewExtras();
      return {
        ...summary,
        ...extras,
        byCategory,
      };
    } catch (err) {
      console.error('[opek-sms] db overviewStats failed', err.message);
      throw err;
    }
  }

  return {
    ...summary,
    conversationCount: contacts.size,
    unreadTotal: [...contacts.values()].reduce((n, c) => n + (c.unreadCount || 0), 0),
    inboundTotal: messages.filter((m) => m.direction === 'inbound').length,
    optedOutTotal: [...contacts.values()].filter((c) => c.optedOut).length,
    byCategory,
  };
}

export async function categoryMessageCount(categoryId) {
  if (canPersistMessages()) {
    try {
      const n = await dbCategoryMessageCount(categoryId);
      if (n != null) return n;
    } catch (err) {
      console.error('[opek-sms] db categoryMessageCount failed', err.message);
      throw err;
    }
  }
  return messages.reduce((n, m) => (m.categoryId === categoryId ? n + 1 : n), 0);
}

async function persistMessage(row, { requirePersistence = false } = {}) {
  let existing = byId.get(row.id) || (row.sid ? bySid.get(row.sid) : null);
  if (!existing && canPersistMessages()) {
    try {
      existing = await dbGetMessage(row.id);
    } catch (err) {
      console.error('[opek-sms] duplicate message lookup failed', err.message || err);
      if (requirePersistence) throw err;
    }
  }

  // Twilio retries webhook events. A repeated SID represents the same message and
  // must not increment thread counters or overwrite a newer delivery status.
  if (existing) {
    const merged = mergeDuplicateMessage(existing, row);
    cacheMessage(merged);
    await safeUpsertMessage(merged, { requirePersistence });
    await refreshContactMeta(merged);
    return publicMessage(merged);
  }

  let insertedInDb = false;
  if (canPersistMessages()) {
    try {
      const inserted = await dbInsertMessageIfAbsent(row);
      if (!inserted) {
        existing = await dbGetMessage(row.id);
        if (existing) {
          const merged = mergeDuplicateMessage(existing, row);
          cacheMessage(merged);
          await safeUpsertMessage(merged, { requirePersistence });
          await refreshContactMeta(merged);
          return publicMessage(merged);
        }
      } else {
        insertedInDb = true;
      }
    } catch (err) {
      console.error('[opek-sms] failed to insert message', err.message || err);
      if (requirePersistence) throw err;
    }
  }

  cacheMessage(row);
  await upsertContact(row, { requirePersistence });
  if (insertedInDb) {
    publish('message', { event: 'insert', record: publicMessage(row), source: 'local' });
  } else {
    await safeUpsertMessage(row, { requirePersistence });
  }

  while (messages.length > MAX) {
    const dropped = messages.pop();
    if (!dropped) break;
    if (dropped.sid) bySid.delete(dropped.sid);
    byId.delete(dropped.id);
  }

  return publicMessage(row);
}

function mergeDuplicateMessage(existing, incoming) {
  const existingStatus = normalizeStatus(existing.deliverability);
  const keepExistingStatus = existingStatus !== 'other';
  return {
    ...incoming,
    ...existing,
    body: existing.body || incoming.body || '',
    categoryId: existing.categoryId || incoming.categoryId || null,
    contactName: existing.contactName || incoming.contactName || null,
    contactPhone: existing.contactPhone || incoming.contactPhone,
    to: existing.to && existing.to !== 'unknown' ? existing.to : incoming.to,
    from: existing.from || incoming.from,
    deliverability: keepExistingStatus ? existingStatus : normalizeStatus(incoming.deliverability),
    errorCode: existing.errorCode || incoming.errorCode || null,
    errorMessage: existing.errorMessage || incoming.errorMessage || null,
    meta: { ...(incoming.meta || {}), ...(existing.meta || {}) },
    createdAt: existing.createdAt || incoming.createdAt,
    updatedAt: existing.updatedAt || incoming.updatedAt,
    statusHistory:
      Array.isArray(existing.statusHistory) && existing.statusHistory.length
        ? existing.statusHistory
        : incoming.statusHistory || [],
  };
}

function cacheMessage(row) {
  const existingIdx = messages.findIndex((m) => m.id === row.id || (row.sid && m.sid === row.sid));
  if (existingIdx >= 0) {
    messages[existingIdx] = row;
  } else {
    messages.unshift(row);
  }
  if (row.sid) bySid.set(row.sid, row);
  byId.set(row.id, row);
}

async function safeUpsertMessage(row, { requirePersistence = false } = {}) {
  if (!canPersistMessages()) {
    publish('message', { event: 'insert', record: publicMessage(row), source: 'memory' });
    return;
  }
  try {
    await dbUpsertMessage(row);
    publish('message', { event: 'upsert', record: publicMessage(row), source: 'local' });
  } catch (err) {
    console.error('[opek-sms] failed to persist message', err.message || err);
    if (requirePersistence) throw err;
  }
}

async function safeUpsertContact(c, { requirePersistence = false } = {}) {
  if (!canPersistMessages()) {
    publish('thread', { event: 'upsert', record: publicContact(c), source: 'memory' });
    return;
  }
  try {
    await dbUpsertContact(c);
    publish('thread', { event: 'upsert', record: publicContact(c), source: 'local' });
  } catch (err) {
    console.error('[opek-sms] failed to persist contact', err.message || err);
    if (requirePersistence) throw err;
  }
}

function filterMessages({ categoryId, status, q, contact, direction } = {}) {
  let rows = messages;

  if (categoryId) rows = rows.filter((m) => m.categoryId === categoryId);
  if (direction) rows = rows.filter((m) => m.direction === direction);
  if (status) {
    const s = String(status).toLowerCase();
    rows = rows.filter((m) => m.deliverability === s);
  }
  if (contact) {
    const phone = normalizePhone(contact);
    rows = rows.filter((m) => contactPhoneOf(m) === phone);
  }
  if (q) {
    const needle = String(q).toLowerCase();
    rows = rows.filter(
      (m) =>
        (m.to && m.to.includes(needle)) ||
        (m.from && m.from.includes(needle)) ||
        (m.contactPhone && m.contactPhone.includes(needle)) ||
        (m.body && m.body.toLowerCase().includes(needle)) ||
        (m.sid && m.sid.toLowerCase().includes(needle)) ||
        (m.contactName && m.contactName.toLowerCase().includes(needle)) ||
        (m.deliverability && m.deliverability.includes(needle))
    );
  }

  return rows;
}

async function upsertContact(row, { requirePersistence = false } = {}) {
  const phone = contactPhoneOf(row);
  if (!phone || phone === 'unknown') return;

  if (canPersistMessages()) {
    try {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const current = await dbGetContact(phone);
        const next = current || blankContact(phone);
        next.messageCount += 1;
        if (row.direction === 'inbound') {
          next.inboundCount += 1;
          next.unreadCount += 1;
        } else {
          next.outboundCount += 1;
        }
        applyContactMeta(next, row);

        const saved = current
          ? await dbUpdateContactIfVersion(next, current.updatedAt)
          : await dbInsertContactIfAbsent(next);
        if (saved) {
          contacts.set(phone, saved);
          publish('thread', { event: 'upsert', record: publicContact(saved), source: 'local' });
          return;
        }
      }
      throw new Error('Contact update conflicted too many times');
    } catch (err) {
      console.error('[opek-sms] atomic contact update failed', err.message || err);
      if (requirePersistence) throw err;
      return;
    }
  }

  let c = contacts.get(phone);
  if (!c) {
    c = blankContact(phone);
    contacts.set(phone, c);
  }

  c.messageCount += 1;
  if (row.direction === 'inbound') {
    c.inboundCount += 1;
    c.unreadCount += 1;
  } else {
    c.outboundCount += 1;
  }
  applyContactMeta(c, row);
  await safeUpsertContact(c, { requirePersistence });
}

function blankContact(phone) {
  const now = new Date().toISOString();
  return {
    phone,
    name: null,
    messageCount: 0,
    outboundCount: 0,
    inboundCount: 0,
    unreadCount: 0,
    lastMessageAt: null,
    lastDirection: null,
    lastBody: null,
    lastDeliverability: null,
    categoryIds: new Set(),
    optedOut: false,
    optedOutAt: null,
    optedInAt: null,
    optOutKeyword: null,
    optOutSource: null,
    aiEnabled: true,
    aiPausedAt: null,
    createdAt: now,
  };
}

async function maybeApplyConsentFromInbound(
  phone,
  body,
  at,
  { requirePersistence = false } = {}
) {
  const keyword = parseConsentKeyword(body);
  if (!keyword) return;
  const key = normalizePhone(phone);
  if (!key) return;
  if (canPersistMessages()) {
    try {
      await mutatePersistentContact(key, (c) =>
        applyConsent(c, {
          optedOut: OPT_OUT_KEYWORDS.has(keyword),
          keyword,
          source: 'inbound',
          at,
        })
      );
      return;
    } catch (err) {
      if (requirePersistence) throw err;
      console.error('[opek-sms] consent update failed', err.message || err);
      return;
    }
  }
  let c = contacts.get(key);
  if (!c) {
    c = blankContact(key);
    contacts.set(key, c);
  }
  applyConsent(c, {
    optedOut: OPT_OUT_KEYWORDS.has(keyword),
    keyword,
    source: 'inbound',
    at,
  });
  await safeUpsertContact(c, { requirePersistence });
}

async function mutatePersistentContact(phone, mutate) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const current = (await dbGetContact(phone)) || blankContact(phone);
    mutate(current);
    const saved = current.updatedAt
      ? await dbUpdateContactIfVersion(current, current.updatedAt)
      : await dbInsertContactIfAbsent(current);
    if (saved) {
      contacts.set(phone, saved);
      publish('thread', { event: 'upsert', record: publicContact(saved), source: 'local' });
      return saved;
    }
  }
  throw new Error('Contact update conflicted too many times');
}

function parseConsentKeyword(body) {
  const text = String(body || '')
    .trim()
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return null;
  const first = text.split(' ')[0];
  if (OPT_OUT_KEYWORDS.has(first) || OPT_IN_KEYWORDS.has(first)) return first;
  if (OPT_OUT_KEYWORDS.has(text) || OPT_IN_KEYWORDS.has(text)) return text;
  return null;
}

function applyConsent(c, { optedOut, keyword, source, at }) {
  c.optedOut = Boolean(optedOut);
  c.optOutKeyword = keyword || null;
  c.optOutSource = source || null;
  if (c.optedOut) {
    c.optedOutAt = at;
  } else {
    c.optedInAt = at;
    c.optedOutAt = null;
  }
}

async function refreshContactMeta(row) {
  const phone = contactPhoneOf(row);
  if (!phone || phone === 'unknown') return;

  if (canPersistMessages()) {
    try {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const current = await dbGetContact(phone);
        if (!current) {
          await upsertContact(row);
          return;
        }
        applyContactMeta(current, row);
        const saved = await dbUpdateContactIfVersion(current, current.updatedAt);
        if (saved) {
          contacts.set(phone, saved);
          publish('thread', { event: 'upsert', record: publicContact(saved), source: 'local' });
          return;
        }
      }
      throw new Error('Contact metadata update conflicted too many times');
    } catch (err) {
      console.error('[opek-sms] contact metadata update failed', err.message || err);
      return;
    }
  }

  let c = contacts.get(phone);
  if (!c) {
    await upsertContact(row);
    return;
  }
  applyContactMeta(c, row);
  await safeUpsertContact(c);
}

function applyContactMeta(c, row) {
  if (row.contactName) c.name = row.contactName;
  const at = row.updatedAt || row.createdAt;
  if (!c.lastMessageAt || String(at) >= String(c.lastMessageAt)) {
    c.lastMessageAt = at;
    c.lastDirection = row.direction;
    if (row.body) c.lastBody = row.body;
    c.lastDeliverability = row.deliverability;
  } else if (row.deliverability) {
    c.lastDeliverability = row.deliverability;
  }
  if (row.categoryId) {
    if (!(c.categoryIds instanceof Set)) c.categoryIds = new Set(c.categoryIds || []);
    c.categoryIds.add(row.categoryId);
  }
}

function contactPhoneOf(row) {
  if (row.contactPhone) return normalizePhone(row.contactPhone);
  if (row.direction === 'inbound') return normalizePhone(row.from);
  return normalizePhone(row.to);
}

function publicContact(c) {
  const categoryIds =
    c.categoryIds instanceof Set ? [...c.categoryIds] : [...(c.categoryIds || [])];
  return {
    phone: c.phone,
    name: c.name,
    messageCount: c.messageCount,
    outboundCount: c.outboundCount || 0,
    inboundCount: c.inboundCount || 0,
    unreadCount: c.unreadCount || 0,
    lastMessageAt: c.lastMessageAt,
    lastDirection: c.lastDirection,
    lastBody: c.lastBody,
    lastDeliverability: c.lastDeliverability,
    categoryIds,
    optedOut: Boolean(c.optedOut),
    optedOutAt: c.optedOutAt || null,
    optedInAt: c.optedInAt || null,
    optOutKeyword: c.optOutKeyword || null,
    optOutSource: c.optOutSource || null,
    consentStatus: c.optedOut ? 'opted_out' : 'active',
    aiEnabled: c.aiEnabled !== false,
    aiPausedAt: c.aiPausedAt || null,
    createdAt: c.createdAt || null,
  };
}

function publicMessage(row) {
  return {
    id: row.id,
    sid: row.sid,
    direction: row.direction,
    categoryId: row.categoryId,
    contactPhone: contactPhoneOf(row),
    to: row.to,
    from: row.from,
    body: row.body,
    deliverability: row.deliverability,
    errorCode: row.errorCode,
    errorMessage: row.errorMessage,
    contactName: row.contactName,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    statusHistory: row.statusHistory,
    meta: row.meta || {},
    tenantId: row.tenantId || row.meta?.tenantId || getCurrentTenantId(),
  };
}

function blankCounts() {
  return {
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
}

function normalizeStatus(status) {
  const s = String(status || 'unknown').toLowerCase();
  const allowed = new Set(Object.keys(blankCounts()));
  return allowed.has(s) ? s : 'other';
}

function normalizePhone(value) {
  if (!value) return '';
  const raw = String(value).trim();
  if (raw.startsWith('+')) {
    const digits = phoneDigits(raw);
    return digits ? `+${digits}` : '';
  }
  const digits = phoneDigits(raw);
  if (!digits) return '';
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return `+${digits}`;
}

function clamp(n, min, max) {
  const v = Number(n);
  if (!Number.isFinite(v)) return min;
  return Math.min(Math.max(v, min), max);
}
