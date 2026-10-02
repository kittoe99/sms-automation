import { Router } from 'express';
import { emptyDataMiddleware, isDatabaseDisconnected, canManageLocalBusinesses } from '../lib/dataMode.js';
import { addLocalBusiness } from '../lib/localBusinesses.js';
import {
  categoryMessageCount,
  deliverabilitySummary,
  getContact,
  getConversation,
  getMessage,
  isOptedOut,
  listContacts,
  listConversations,
  listMessages,
  listOptOuts,
  markConversationRead,
  overviewStats,
  setAiPaused,
  setOptOutStatus,
} from '../lib/messageStore.js';
import { sendSms } from '../lib/twilioClient.js';
import {
  enrollContactInAutomation,
  listDirectoryContacts,
  listEnrollments,
  removeEnrollment,
  rescheduleCustomAutomationEnrollments,
  sendCustomContactMessage,
  syncBookingAutomations,
  toE164,
} from '../lib/supabaseContacts.js';
import { getSupabaseAdmin, isSupabaseConfigured } from '../lib/supabase.js';
import { requireApiKey } from '../lib/apiAuth.js';
import {
  getClerkPublishableKey,
  getClerkFrontendApiUrl,
  isCrmAuthConfigured,
  isLocalAuthDisabled,
  requireClerkSession,
  requireCrmAuth,
} from '../lib/crmAuth.js';
import { getAiConfig, isAiConfigured } from '../lib/ai/client.js';
import {
  getElevenLabsOutboundConfig,
  getOutboundPromptPresets,
  isElevenLabsOutboundConfigured,
  placeOutboundFollowUpCall,
} from '../lib/elevenlabsOutbound.js';
import { AUTOMATION_RULE_PRESETS } from '../lib/automations/rulePresets.js';
import { removeActiveEnrollmentsForPhone } from '../lib/automations/lifecycle.js';
import {
  CADENCE_PRESETS,
  createCustomAutomationGroup,
  deleteCustomAutomationGroup,
  getAutomationGroup,
  listAutomationGroups,
  updateCustomAutomationGroup,
} from '../lib/automations/customAutomations.js';
import {
  deleteGroupAiSettings,
  saveGroupAiSettings,
} from '../lib/automations/groupAiInstructions.js';
import {
  listVoiceConversationsForPhone,
  recordPendingOutboundCall,
  syncConversations,
} from '../lib/elevenlabsConversations.js';
import {
  listTenants,
  requireTenantDataIsolation,
  tenantContextMiddleware,
  tenantMatchesClerkAuth,
  TENANT_CAPABILITIES,
  toPublicTenant,
} from '../lib/tenantContext.js';
import { createRateLimiter } from '../lib/security.js';
import { enrichBusinessFromWebsite } from '../lib/websiteEnrich.js';

export const apiRouter = Router();
const asyncRoute = (handler) => (req, res, next) =>
  Promise.resolve(handler(req, res, next)).catch(next);
const authCheckLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  max: 300,
  key: (req) => `auth:${req.ip}`,
});
const serverActionLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  max: 120,
  key: () => 'server-actions',
});
const crmActionLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  max: 60,
  key: (req) => `crm:${req.crmUser?.userId || req.ip}`,
});
apiRouter.use(tenantContextMiddleware);
apiRouter.use((req, res, next) => {
  if (req.path === '/auth/config' || req.path === '/send' || req.path.startsWith('/internal/')) {
    return next();
  }
  return authCheckLimiter(req, res, next);
});

/** Public: the frontend needs Clerk's publishable key to initialize ClerkJS. */
apiRouter.get('/auth/config', (_req, res) => {
  const publishableKey = getClerkPublishableKey();
  res.json({
    mode: isLocalAuthDisabled() ? 'local' : 'clerk',
    manualBusinesses: canManageLocalBusinesses(),
    configured: isCrmAuthConfigured(),
    publishableKey: publishableKey || null,
    frontendApiUrl: getClerkFrontendApiUrl(),
  });
});

apiRouter.get('/auth/me', requireClerkSession, (req, res) => {
  const tenant = listTenants().find((item) => canManageLocalBusinesses() || tenantMatchesClerkAuth(item, req.crmUser));
  res.json({
    user: {
      id: req.crmUser.userId,
      organizationId: req.crmUser.orgId,
      organizationRole: req.crmUser.orgRole,
      organizationSlug: req.crmUser.orgSlug,
    },
    tenant: tenant ? toPublicTenant(tenant) : null,
    tenantCapabilities: TENANT_CAPABILITIES,
  });
});

apiRouter.get('/tenants', requireClerkSession, (req, res) => {
  const tenants = listTenants().filter((tenant) => canManageLocalBusinesses() || tenantMatchesClerkAuth(tenant, req.crmUser));
  const current = tenants.find((tenant) => tenant.id === req.tenant.id) || tenants[0] || null;
  res.json({
    tenants: tenants.map(toPublicTenant),
    currentTenant: current ? toPublicTenant(current) : null,
    capabilities: TENANT_CAPABILITIES,
  });
});

/**
 * Gate all CRM UI APIs behind a verified Clerk session.
 * Server-to-server routes (/send, /internal/*) keep API-key auth only.
 */
apiRouter.use((req, res, next) => {
  if (req.path === '/auth/config') return next();
  if (req.path === '/send') return next();
  if (req.path.startsWith('/internal/')) return next();
  if (req.path === '/auth/me' || req.path === '/tenants') return next();
  return requireCrmAuth(req, res, next);
});
apiRouter.use(requireTenantDataIsolation);

/**
 * Business-website enrichment for the Business context form.
 * Mirrors the Get Started site-read: Firecrawl when FIRECRAWL_API_KEY is set,
 * plain-HTML parsing otherwise. CRM-authenticated and read-only (stores
 * nothing), so it runs ahead of the empty-data guard.
 */
apiRouter.post('/enrich-website', crmActionLimiter, asyncRoute(async (req, res) => {
  const websiteUrl = String(req.body?.websiteUrl || '').trim().slice(0, 2048);
  if (!websiteUrl) return res.status(400).json({ error: 'Enter a website address.' });
  try {
    res.json(await enrichBusinessFromWebsite(websiteUrl, { apiKey: process.env.FIRECRAWL_API_KEY }));
  } catch (error) {
    res.status(error.status || 502).json({ error: error.message || 'That website could not be read.' });
  }
}));
apiRouter.post('/businesses', crmActionLimiter, asyncRoute(async (req, res) => {
  if (!canManageLocalBusinesses()) return res.status(403).json({ error: 'Manual local business setup is unavailable' });
  try {
    const business = await addLocalBusiness(req.body);
    res.status(201).json({ business: toPublicTenant(business) });
  } catch (error) {
    if ([400, 403, 409].includes(error.status)) return res.status(error.status).json({ error: error.message });
    throw error;
  }
}));
apiRouter.use(emptyDataMiddleware);

apiRouter.get('/calls', asyncRoute(async (req, res) => {
  const page = Math.max(1, Math.floor(Number(req.query.page) || 1));
  const pageSize = Math.max(1, Math.min(250, Math.floor(Number(req.query.pageSize) || 50)));
  if (!isSupabaseConfigured()) return res.json({ calls: [], total: 0, page: 1, pageSize, totalPages: 1 });
  const { data, count, error } = await getSupabaseAdmin()
    .from('sms_voice_conversations')
    .select('conversation_id, phone, direction, started_at, status, duration_secs', { count: 'exact' })
    .eq('direction', 'inbound')
    .order('started_at', { ascending: false, nullsFirst: false })
    .range((page - 1) * pageSize, page * pageSize - 1);
  if (error) throw error;
  res.json({ calls: data || [], total: count || 0, page, pageSize,
    totalPages: Math.max(1, Math.ceil((count || 0) / pageSize)) });
}));

/**
 * Transactional outbound SMS (quotes, booking updates, etc.).
 * Auth: X-API-Key or Authorization Bearer matching OPEK_SMS_API_KEY.
 * Does not require marketing consent; still respects STOP opt-outs.
 */
apiRouter.post('/send', requireApiKey, serverActionLimiter, async (req, res) => {
  const body = String(req.body?.body || '').trim();
  const phoneRaw = String(req.body?.phone || '').trim();
  const categoryId = req.body?.categoryId ? String(req.body.categoryId) : null;
  const contactName = req.body?.name ? String(req.body.name).trim() : null;

  if (!phoneRaw) return res.status(400).json({ error: 'phone is required' });
  if (!body) return res.status(400).json({ error: 'body is required' });
  if (body.length > 1600) {
    return res.status(400).json({ error: 'body is too long (max 1600 characters)' });
  }
  try {
    if (categoryId && !(await getAutomationGroup(categoryId))) {
      return res.status(400).json({ error: `Unknown category: ${categoryId}` });
    }
  } catch (err) {
    return res.status(err.status || 500).json({ error: 'Automation registry unavailable', detail: err.message });
  }

  const to = toE164(phoneRaw);
  if (!to || to.length < 12) {
    return res.status(400).json({ error: 'Invalid phone number' });
  }

  try {
    if (await isOptedOut(to)) {
      return res.status(403).json({
        error: 'Contact opted out',
        detail: 'This number has opted out of SMS.',
      });
    }
    const message = await sendSms({
      to,
      body,
      categoryId,
      contactName,
    });
    res.status(201).json({ message, to });
  } catch (err) {
    console.error('[opek-sms] transactional send failed', err);
    const status =
      err.code === 'OPTED_OUT'
        ? 403
        : err.code === 'CONSENT_CHECK_UNAVAILABLE'
          ? 503
          : 502;
    res.status(status).json({
      error: 'Failed to send message',
      detail: err.message || String(err),
    });
  }
});

apiRouter.get('/overview', async (_req, res) => {
  try {
    const data = await overviewStats();
    const existing = new Set((data.byCategory || []).map((category) => category.id));
    for (const group of await listAutomationGroups()) {
      if (existing.has(group.id)) continue;
      data.byCategory.push({
        id: group.id,
        name: group.name,
        ...(await deliverabilitySummary({ categoryId: group.id })),
      });
    }
    return res.json(data);
  } catch (err) {
    return res.status(err.status || 500).json({ error: 'Failed to load overview', detail: err.message });
  }
});

apiRouter.get('/categories', async (_req, res) => {
  try {
    const categories = [];
    for (const c of await listAutomationGroups()) {
      categories.push({
        ...c,
        automations: automationsForGroup(c),
        messageCount: isDatabaseDisconnected() ? 0 : await categoryMessageCount(c.id),
        summary: isDatabaseDisconnected() ? { total: 0, counts: {}, deliveryRate: null } : await deliverabilitySummary({ categoryId: c.id }),
      });
    }
    return res.json({
      categories,
      cadences: Object.entries(CADENCE_PRESETS).map(([id, value]) => ({ id, ...value })),
      rulePresets: AUTOMATION_RULE_PRESETS,
    });
  } catch (err) {
    return res.status(err.status || 500).json({ error: 'Failed to load automation groups', detail: err.message });
  }
});

apiRouter.get('/categories/:id', async (req, res) => {
  try {
    const category = await getAutomationGroup(req.params.id);
    if (!category) return res.status(404).json({ error: 'Category not found' });
    const page = await listMessages({
      categoryId: category.id,
      page: req.query.page,
      pageSize: req.query.pageSize || 50,
      status: req.query.status,
      q: req.query.q,
    });
    return res.json({
      category: {
        ...category,
        automations: automationsForGroup(category),
        summary: await deliverabilitySummary({ categoryId: category.id }),
      },
      ...page,
    });
  } catch (err) {
    return res.status(err.status || 500).json({ error: 'Failed to load automation group', detail: err.message });
  }
});

apiRouter.get('/automations/:id', async (req, res) => {
  try {
    const group = await getAutomationGroup(req.params.id);
    if (!group) return res.status(404).json({ error: 'Automation group not found' });
    return res.json({ sequence: automationsForGroup(group)[0] || null, group });
  } catch (err) {
    return res.status(err.status || 500).json({ error: 'Failed to load automation', detail: err.message });
  }
});

apiRouter.post('/automation-groups', async (req, res) => {
  try {
    let group = await createCustomAutomationGroup(req.body || {});
    group = await getAutomationGroup(group.id);
    return res.status(201).json({ group });
  } catch (err) {
    return res.status(err.status || 500).json({
      error: 'Failed to create automation group',
      detail: err.message || String(err),
    });
  }
});

apiRouter.put('/automation-groups/:id', async (req, res) => {
  try {
    let group = await updateCustomAutomationGroup(req.params.id, req.body || {});
    group = await getAutomationGroup(group.id);
    const rescheduled = await rescheduleCustomAutomationEnrollments(group);
    return res.json({ group, rescheduled });
  } catch (err) {
    return res.status(err.status || 500).json({
      error: 'Failed to update automation group',
      detail: err.message || String(err),
    });
  }
});

apiRouter.put('/automation-groups/:id/ai-instructions', async (req, res) => {
  try {
    const group = await getAutomationGroup(req.params.id);
    if (!group) return res.status(404).json({ error: 'Automation group not found' });
    const ai = await saveGroupAiSettings(group.id, req.body || {});
    return res.json({ group: { ...group, ai } });
  } catch (err) {
    return res.status(err.status || 500).json({
      error: 'Failed to update group AI instructions',
      detail: err.message || String(err),
    });
  }
});

apiRouter.delete('/automation-groups/:id', async (req, res) => {
  try {
    const existing = await getAutomationGroup(req.params.id);
    if (!existing?.custom) {
      return res.status(404).json({ error: 'Custom automation group not found' });
    }
    if (isSupabaseConfigured()) {
      const { error } = await getSupabaseAdmin()
        .from('sms_automation_enrollments')
        .update({ status: 'removed', updated_at: new Date().toISOString() })
        .eq('category_id', req.params.id)
        .eq('status', 'enrolled');
      if (error) throw error;
    }
    const group = await deleteCustomAutomationGroup(req.params.id);
    await deleteGroupAiSettings(req.params.id);
    return res.json({ group });
  } catch (err) {
    return res.status(err.status || 500).json({
      error: 'Failed to delete automation group',
      detail: err.message || String(err),
    });
  }
});

function automationsForGroup(group) {
  return group ? [{ ...group, steps: undefined }] : [];
}

/**
 * Server-to-server lifecycle trigger for quotes and bookings.
 * Supported events: quote.created, booking.created, booking.updated,
 * booking.confirmed, booking.cancelled.
 */
apiRouter.post('/internal/automation-event', requireApiKey, serverActionLimiter, async (req, res) => {
  const type = String(req.body?.type || '').trim().toLowerCase();
  const phone = String(req.body?.phone || '').trim();
  if (!phone || !type) {
    return res.status(400).json({ error: 'type and phone are required' });
  }

  try {
    if (type === 'quote.created') {
      const enrollment = await enrollContactInAutomation({
        phone,
        categoryId: 'quote-requests',
        name: req.body?.name || null,
        email: req.body?.email || null,
        source: req.body?.source || 'quote_event',
        bookingId: req.body?.recordId || null,
      });
      return res.status(201).json({ ok: true, type, enrollment });
    }

    const bookingEvents = new Set([
      'booking.created',
      'booking.updated',
      'booking.confirmed',
      'booking.cancelled',
    ]);
    if (!bookingEvents.has(type)) {
      return res.status(400).json({ error: 'Unknown automation event type' });
    }

    const result = await syncBookingAutomations({
      phone,
      bookingId: req.body?.bookingId || req.body?.recordId || null,
      status:
        type === 'booking.cancelled'
          ? 'cancelled'
          : type === 'booking.confirmed'
            ? 'confirmed'
            : req.body?.status || 'new',
      appointmentDate: req.body?.appointmentDate || req.body?.preferredDate || null,
      preferredTime: req.body?.preferredTime || req.body?.preferredTimeWindow || null,
      serviceType: req.body?.serviceType || null,
      serviceAddress: req.body?.serviceAddress || null,
      name: req.body?.name || null,
      email: req.body?.email || null,
      source: req.body?.source || 'booking_event',
    });
    return res.json({ ok: true, type, ...result });
  } catch (err) {
    const message = err.message || String(err);
    const status = /required|Unknown|valid appointment|consent|opted out|not found/i.test(message)
      ? 400
      : 502;
    return res.status(status).json({ error: 'Automation event failed', detail: message });
  }
});

/**
 * Pull ElevenLabs conversations into sms_voice_conversations. Requires OPEK_SMS_API_KEY.
 */
apiRouter.post('/internal/voice-sync', requireApiKey, serverActionLimiter, async (req, res) => {
  try {
    const agentId =
      req.body?.agentId ||
      getElevenLabsOutboundConfig().agentId ||
      'agent_7801kwfn9rkcey5rn1wsrjdpnvvn';
    const sinceUnix =
      req.body?.sinceUnix != null ? Number(req.body.sinceUnix) : null;
    const maxPages =
      req.body?.maxPages != null ? Number(req.body.maxPages) : 20;
    const summary = await syncConversations({
      agentId,
      sinceUnix: Number.isFinite(sinceUnix) ? sinceUnix : null,
      maxPages: Number.isFinite(maxPages) ? maxPages : 20,
    });
    console.log('[opek-sms] voice sync', summary);
    res.json({ ok: true, summary });
  } catch (err) {
    console.error('[opek-sms] voice sync failed', err);
    res.status(500).json({ error: 'Voice sync failed', detail: err.message || String(err) });
  }
});

apiRouter.get('/messages', asyncRoute(async (req, res) => {
  const page = await listMessages({
    categoryId: req.query.category || undefined,
    status: req.query.status || undefined,
    q: req.query.q || undefined,
    contact: req.query.contact || undefined,
    page: req.query.page,
    pageSize: req.query.pageSize,
  });

  res.json({
    ...page,
    summary: await deliverabilitySummary({
      categoryId: req.query.category || undefined,
    }),
  });
}));

apiRouter.get('/messages/:id', asyncRoute(async (req, res) => {
  const message = await getMessage(req.params.id);
  if (!message) return res.status(404).json({ error: 'Message not found' });
  res.json({ message });
}));

apiRouter.get('/contacts', asyncRoute(async (req, res) => {
  res.json(
    await listContacts({
      q: req.query.q,
      status: req.query.status || null,
      page: req.query.page,
      pageSize: req.query.pageSize,
    })
  );
}));

apiRouter.get('/directory', async (req, res) => {
  try {
    const categories = await listAutomationGroups();
    const data = await listDirectoryContacts({
      q: req.query.q || null,
      source: req.query.source || null,
      consentedOnly: req.query.consented === '1' || req.query.consented === 'true',
      page: req.query.page,
      pageSize: req.query.pageSize,
    });
    if (data.configured === false) {
      return res.json({
        ...data,
        categories,
        supabaseConfigured: false,
      });
    }
    res.json({
      ...data,
      categories,
      supabaseConfigured: true,
    });
  } catch (err) {
    console.error('[opek-sms] directory failed', err);
    res.status(502).json({ error: 'Failed to load Supabase contacts', detail: err.message });
  }
});

apiRouter.post('/directory/enroll', crmActionLimiter, async (req, res) => {
  const phone = String(req.body?.phone || '').trim();
  const categoryId = String(req.body?.categoryId || '').trim();
  if (!phone || !categoryId) {
    return res.status(400).json({ error: 'phone and categoryId are required' });
  }

  try {
    const enrollment = await enrollContactInAutomation({
      phone,
      categoryId,
      name: req.body?.name || null,
      email: req.body?.email || null,
      source: req.body?.source || null,
      bookingId: req.body?.bookingId || null,
      appointmentDate: req.body?.appointmentDate || null,
      preferredTime: req.body?.preferredTime || null,
      serviceType: req.body?.serviceType || null,
      serviceAddress: req.body?.serviceAddress || null,
    });
    res.status(201).json({ enrollment });
  } catch (err) {
    console.error('[opek-sms] enroll failed', err);
    const msg = err.message || String(err);
    const status = /valid appointment|required|No active automation|Unknown automation/i.test(msg)
      ? 400
      : /consent|opted out|not found/i.test(msg)
        ? 403
        : 502;
    res.status(status).json({ error: 'Failed to enroll contact', detail: msg });
  }
});

apiRouter.post('/directory/unenroll', async (req, res) => {
  const phone = String(req.body?.phone || '').trim();
  const categoryId = String(req.body?.categoryId || '').trim();
  const enrollmentId = req.body?.enrollmentId || null;
  if (!enrollmentId && (!phone || !categoryId)) {
    return res.status(400).json({ error: 'phone and categoryId (or enrollmentId) are required' });
  }

  try {
    const enrollment = await removeEnrollment({ phone, categoryId, enrollmentId });
    res.json({ enrollment });
  } catch (err) {
    console.error('[opek-sms] unenroll failed', err);
    const msg = err.message || String(err);
    const status = /not found|Unknown automation|required/i.test(msg) ? 404 : 502;
    res.status(status).json({ error: 'Failed to remove enrollment', detail: msg });
  }
});

apiRouter.delete('/enrollments/:id', async (req, res) => {
  try {
    const enrollment = await removeEnrollment({ enrollmentId: req.params.id });
    res.json({ enrollment });
  } catch (err) {
    console.error('[opek-sms] unenroll by id failed', err);
    const msg = err.message || String(err);
    const status = /not found/i.test(msg) ? 404 : 502;
    res.status(status).json({ error: 'Failed to remove enrollment', detail: msg });
  }
});

apiRouter.post('/directory/message', crmActionLimiter, async (req, res) => {
  const phone = String(req.body?.phone || '').trim();
  const body = String(req.body?.body || '').trim();
  const categoryId = req.body?.categoryId ? String(req.body.categoryId).trim() : null;
  if (!phone || !body) {
    return res.status(400).json({ error: 'phone and body are required' });
  }

  try {
    const result = await sendCustomContactMessage({
      phone,
      body,
      categoryId,
      name: req.body?.name || null,
    });
    res.status(201).json(result);
  } catch (err) {
    console.error('[opek-sms] custom message failed', err);
    const msg = err.message || String(err);
    const status = /consent|opted out|not found|required|too long|Invalid phone|Unknown automation/i.test(
      msg
    )
      ? 403
      : 502;
    res.status(status).json({ error: 'Failed to send message', detail: msg });
  }
});

apiRouter.get('/enrollments', async (req, res) => {
  try {
    const data = await listEnrollments({
      categoryId: req.query.category || null,
      page: req.query.page,
      pageSize: req.query.pageSize,
    });
    res.json(data);
  } catch (err) {
    console.error('[opek-sms] enrollments failed', err);
    res.status(502).json({ error: 'Failed to load enrollments', detail: err.message });
  }
});

apiRouter.get('/contacts/:phone', asyncRoute(async (req, res) => {
  const contact = await getContact(req.params.phone);
  if (!contact) return res.status(404).json({ error: 'Contact not found' });
  res.json({ contact });
}));

apiRouter.post('/contacts/:phone/opt-out', async (req, res) => {
  try {
    const contact = await setOptOutStatus(req.params.phone, {
      optedOut: true,
      keyword: req.body?.keyword || 'manual',
      source: 'manual',
    });
    if (!contact) return res.status(400).json({ error: 'Invalid phone' });
    const removedEnrollments = await removeActiveEnrollmentsForPhone(req.params.phone, {
      reason: 'manual_opt_out',
      source: 'crm',
    });
    return res.json({ contact, removedEnrollments });
  } catch (err) {
    return res.status(502).json({
      error: 'Failed to opt out contact',
      detail: err.message || String(err),
    });
  }
});

apiRouter.post('/contacts/:phone/opt-in', asyncRoute(async (req, res) => {
  const contact = await setOptOutStatus(req.params.phone, {
    optedOut: false,
    keyword: req.body?.keyword || 'manual',
    source: 'manual',
  });
  if (!contact) return res.status(400).json({ error: 'Invalid phone' });
  res.json({ contact });
}));

apiRouter.get('/opt-outs', asyncRoute(async (req, res) => {
  res.json(await listOptOuts({ q: req.query.q, page: req.query.page, pageSize: req.query.pageSize }));
}));

apiRouter.get('/conversations', asyncRoute(async (req, res) => {
  res.json(
    await listConversations({
      q: req.query.q,
      unreadOnly: req.query.unread === '1' || req.query.unread === 'true',
      page: req.query.page,
      pageSize: req.query.pageSize,
    })
  );
}));

apiRouter.get('/conversations/:phone', asyncRoute(async (req, res) => {
  const conversation = await getConversation(req.params.phone);
  if (!conversation) return res.status(404).json({ error: 'Conversation not found' });
  res.json({ conversation });
}));

apiRouter.get('/conversations/:phone/calls', async (req, res) => {
  try {
    const calls = await listVoiceConversationsForPhone(req.params.phone, {
      limit: req.query.pageSize || req.query.limit || 50,
    });
    res.json({ calls, total: calls.length });
  } catch (err) {
    console.error('[opek-sms] list voice calls failed', err);
    res.status(500).json({
      error: 'Failed to list voice calls',
      detail: err.message || String(err),
    });
  }
});

apiRouter.post('/conversations/:phone/read', asyncRoute(async (req, res) => {
  const conversation = await markConversationRead(req.params.phone);
  if (!conversation) return res.status(404).json({ error: 'Conversation not found' });
  res.json({ conversation });
}));

apiRouter.post('/conversations/:phone/reply', crmActionLimiter, async (req, res) => {
  const phone = req.params.phone;
  const body = String(req.body?.body || '').trim();
  if (!body) return res.status(400).json({ error: 'body is required' });

  try {
    if (await isOptedOut(phone)) {
      return res.status(403).json({
        error: 'Contact opted out',
        detail: 'This number has opted out of SMS. Opt them back in before sending.',
      });
    }
    const message = await sendSms({ to: phone, body });
    await markConversationRead(phone);
    const conversation = await getConversation(phone);
    res.status(201).json({ message, conversation });
  } catch (err) {
    console.error('[opek-sms] reply failed', err);
    res.status(err.code === 'CONSENT_CHECK_UNAVAILABLE' ? 503 : 502).json({
      error: 'Failed to send reply',
      detail: err.message || String(err),
    });
  }
});

/**
 * Trigger ElevenLabs outbound call with SMS thread + CRM context for follow-up/close.
 * Optional body: name, systemPrompt, firstMessage, includeSmsHistory, pauseAi
 * pauseAi defaults to false — SMS AI stays on unless explicitly paused.
 */
apiRouter.post('/conversations/:phone/call', crmActionLimiter, async (req, res) => {
  const phone = req.params.phone;
  if (!isElevenLabsOutboundConfigured()) {
    return res.status(503).json({
      error: 'Outbound calling is not configured',
      detail: 'Set ELEVENLABS_API_KEY on the app.',
    });
  }

  try {
    if (await isOptedOut(phone)) {
      return res.status(403).json({
        error: 'Contact opted out',
        detail: 'This number has opted out of SMS. Do not place marketing follow-up calls.',
      });
    }
    const conversation = await getConversation(phone);
    const includeSmsHistory = req.body?.includeSmsHistory !== false;
    const result = await placeOutboundFollowUpCall({
      phone,
      conversation,
      name: req.body?.name || conversation?.name || null,
      systemPrompt: req.body?.systemPrompt || null,
      firstMessage: req.body?.firstMessage || null,
      includeSmsHistory,
    });

    if (result?.conversationId) {
      await recordPendingOutboundCall({
        conversationId: result.conversationId,
        phone: result.to || phone,
        callSid: result.callSid || null,
        agentId: result.agentId || null,
      });
    }

    // SMS AI stays active unless the caller explicitly requests pauseAi: true
    // (manual Pause AI in Messaging is the normal control).
    const pauseAi = req.body?.pauseAi === true;
    let contact = null;
    if (pauseAi) {
      contact = await setAiPaused(phone, true, 'outbound_call');
    }

    res.status(201).json({
      call: result,
      contact,
      aiPaused: Boolean(pauseAi && contact),
    });
  } catch (err) {
    console.error('[opek-sms] outbound call failed', err);
    const status =
      err.code === 'CONSENT_CHECK_UNAVAILABLE'
        ? 503
        : err.status && err.status < 600
          ? err.status
          : 502;
    res.status(status).json({
      error: 'Failed to start outbound call',
      detail: err.message || String(err),
    });
  }
});

apiRouter.get('/ai/outbound-call', async (_req, res) => {
  const presets = getOutboundPromptPresets();
  res.json({
    configured: isElevenLabsOutboundConfigured(),
    from: '+18313187139',
    ...presets,
  });
});

apiRouter.get('/deliverability', asyncRoute(async (req, res) => {
  res.json(
    await deliverabilitySummary({
      categoryId: req.query.category || undefined,
    })
  );
}));

/**
 * AI SMS agent: Gradient™ AI Agents for conversation; App Platform for Twilio + eligibility.
 * Supabase is data-only: enrollments, messages, agent_bookings.
 */
apiRouter.get('/ai/config', async (_req, res) => {
  const cfg = getAiConfig();
  res.json({
    configured: isAiConfigured(),
    enabled: cfg.enabled,
    provider: cfg.provider,
    model: cfg.model,
    enabledCategories: cfg.enabledCategories,
    maxHistory: cfg.maxHistory,
    maxReplyChars: cfg.maxReplyChars,
    host: 'digitalocean-gradient+app-platform',
    dataStore: isSupabaseConfigured() ? 'supabase' : 'memory',
  });
});

apiRouter.get('/ai/eligibility/:phone', async (req, res) => {
  try {
    const contact = await getContact(req.params.phone);
    res.json({
      contact: contact || null,
      eligibility: {eligible:false,reason:'supabase_worker_only'},
      aiConfigured: isAiConfigured(),
    });
  } catch (err) {
    console.error('[opek-sms] AI eligibility failed', err);
    res.status(502).json({ error: 'Failed to check AI eligibility', detail: err.message });
  }
});

apiRouter.post('/conversations/:phone/ai/pause', asyncRoute(async (req, res) => {
  const contact = await setAiPaused(req.params.phone, true, req.body?.reason || 'crm_pause');
  if (!contact) return res.status(400).json({ error: 'Invalid phone' });
  res.json({ contact, aiPaused: true });
}));

apiRouter.post('/conversations/:phone/ai/resume', asyncRoute(async (req, res) => {
  const contact = await setAiPaused(req.params.phone, false);
  if (!contact) return res.status(400).json({ error: 'Invalid phone' });
  res.json({ contact, aiPaused: false });
}));
