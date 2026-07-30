import { Router } from 'express';
import { CATEGORIES, getCategory } from '../lib/categories.js';
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
  setOptOutStatus,
} from '../lib/messageStore.js';
import { sendSms } from '../lib/twilioClient.js';
import {
  enrollContactInAutomation,
  listDirectoryContacts,
  listEnrollments,
  removeEnrollment,
  sendCustomContactMessage,
} from '../lib/supabaseContacts.js';
import { isSupabaseConfigured } from '../lib/supabase.js';

export const apiRouter = Router();

apiRouter.get('/overview', (_req, res) => {
  res.json(overviewStats());
});

apiRouter.get('/categories', (_req, res) => {
  const categories = CATEGORIES.map((c) => ({
    ...c,
    automations: [],
    messageCount: categoryMessageCount(c.id),
    summary: deliverabilitySummary({ categoryId: c.id }),
  }));
  res.json({ categories });
});

apiRouter.get('/categories/:id', (req, res) => {
  const category = getCategory(req.params.id);
  if (!category) return res.status(404).json({ error: 'Category not found' });

  const page = listMessages({
    categoryId: category.id,
    page: req.query.page,
    pageSize: req.query.pageSize || 50,
    status: req.query.status,
    q: req.query.q,
  });

  res.json({
    category: {
      ...category,
      automations: [],
      summary: deliverabilitySummary({ categoryId: category.id }),
    },
    ...page,
  });
});

apiRouter.get('/messages', (req, res) => {
  const page = listMessages({
    categoryId: req.query.category || undefined,
    status: req.query.status || undefined,
    q: req.query.q || undefined,
    contact: req.query.contact || undefined,
    page: req.query.page,
    pageSize: req.query.pageSize,
  });

  res.json({
    ...page,
    summary: deliverabilitySummary({
      categoryId: req.query.category || undefined,
    }),
  });
});

apiRouter.get('/messages/:id', (req, res) => {
  const message = getMessage(req.params.id);
  if (!message) return res.status(404).json({ error: 'Message not found' });
  res.json({ message });
});

apiRouter.get('/contacts', (req, res) => {
  res.json(
    listContacts({
      q: req.query.q,
      status: req.query.status || null,
      page: req.query.page,
      pageSize: req.query.pageSize,
    })
  );
});

apiRouter.get('/directory', async (req, res) => {
  try {
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
        categories: CATEGORIES,
        supabaseConfigured: false,
      });
    }
    res.json({
      ...data,
      categories: CATEGORIES,
      supabaseConfigured: true,
    });
  } catch (err) {
    console.error('[opek-sms] directory failed', err);
    res.status(502).json({ error: 'Failed to load Supabase contacts', detail: err.message });
  }
});

apiRouter.post('/directory/enroll', async (req, res) => {
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
    });
    res.status(201).json({ enrollment });
  } catch (err) {
    console.error('[opek-sms] enroll failed', err);
    const msg = err.message || String(err);
    const status =
      /consent|opted out|not found|Unknown automation/i.test(msg) ? 403 : 502;
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

apiRouter.post('/directory/message', async (req, res) => {
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

apiRouter.get('/contacts/:phone', (req, res) => {
  const contact = getContact(req.params.phone);
  if (!contact) return res.status(404).json({ error: 'Contact not found' });
  res.json({ contact });
});

apiRouter.post('/contacts/:phone/opt-out', (req, res) => {
  const contact = setOptOutStatus(req.params.phone, {
    optedOut: true,
    keyword: req.body?.keyword || 'manual',
    source: 'manual',
  });
  if (!contact) return res.status(400).json({ error: 'Invalid phone' });
  res.json({ contact });
});

apiRouter.post('/contacts/:phone/opt-in', (req, res) => {
  const contact = setOptOutStatus(req.params.phone, {
    optedOut: false,
    keyword: req.body?.keyword || 'manual',
    source: 'manual',
  });
  if (!contact) return res.status(400).json({ error: 'Invalid phone' });
  res.json({ contact });
});

apiRouter.get('/opt-outs', (req, res) => {
  res.json(listOptOuts({ q: req.query.q, page: req.query.page, pageSize: req.query.pageSize }));
});

apiRouter.get('/conversations', (req, res) => {
  res.json(
    listConversations({
      q: req.query.q,
      unreadOnly: req.query.unread === '1' || req.query.unread === 'true',
      page: req.query.page,
      pageSize: req.query.pageSize,
    })
  );
});

apiRouter.get('/conversations/:phone', (req, res) => {
  const conversation = getConversation(req.params.phone);
  if (!conversation) return res.status(404).json({ error: 'Conversation not found' });
  res.json({ conversation });
});

apiRouter.post('/conversations/:phone/read', (req, res) => {
  const conversation = markConversationRead(req.params.phone);
  if (!conversation) return res.status(404).json({ error: 'Conversation not found' });
  res.json({ conversation });
});

apiRouter.post('/conversations/:phone/reply', async (req, res) => {
  const phone = req.params.phone;
  const body = String(req.body?.body || '').trim();
  if (!body) return res.status(400).json({ error: 'body is required' });

  if (isOptedOut(phone)) {
    return res.status(403).json({
      error: 'Contact opted out',
      detail: 'This number has opted out of SMS. Opt them back in before sending.',
    });
  }

  try {
    const message = await sendSms({ to: phone, body });
    markConversationRead(phone);
    const conversation = getConversation(phone);
    res.status(201).json({ message, conversation });
  } catch (err) {
    console.error('[opek-sms] reply failed', err);
    res.status(502).json({
      error: 'Failed to send reply',
      detail: err.message || String(err),
    });
  }
});

apiRouter.get('/deliverability', (req, res) => {
  res.json(
    deliverabilitySummary({
      categoryId: req.query.category || undefined,
    })
  );
});
