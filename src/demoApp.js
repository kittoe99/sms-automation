// Deliberately standalone: never import live auth, database, Twilio, or AI modules.
import express from 'express';
import { fileURLToPath } from 'node:url';
import { CADENCE_PRESETS } from './lib/automations/rulePresets.js';

const tenants = [
  { id: 'demo-opek', name: 'Opek — Demo', shortName: 'Opek Demo' },
  { id: 'demo-acme', name: 'Acme Services — Demo', shortName: 'Acme Demo' },
];
const demoRule = (count, interval = 1) => ({ anchor: 'enrollment', firstDelayCount: 1,
  firstDelayUnit: 'day', intervalCount: interval, intervalUnit: 'day', repeatCount: count,
  startHour: 9, endHour: 19 });
const categories = [
  { id: 'sms-contact', name: 'Contact', fixedType: 'contacts', kind: 'contact', rule: demoRule(1), intent: 'Help with the inquiry.', description: 'New SMS leads', activeAutomation: true },
  { id: 'quote-requests', name: 'Quote Request', fixedType: 'quote_requests', kind: 'quote', rule: demoRule(6, 2), intent: 'Help with the quote request.', description: 'Quote inquiries', activeAutomation: true },
  { id: 'appointment-reminders', name: 'Bookings', fixedType: 'bookings', kind: 'reminder', rule: { anchor: 'appointment', firstDelayCount: 0, firstDelayUnit: 'day', intervalCount: 6, intervalUnit: 'hour', repeatCount: 1, leadHours: 24, startHour: 0, endHour: 24 }, intent: 'Remind about the appointment.', description: 'Confirmed bookings', activeAutomation: true },
  { id: 'sms-review', name: 'Reviews', fixedType: 'reviews', kind: 'review', rule: demoRule(1), intent: 'Invite feedback.', description: 'Completed services', activeAutomation: true },
];
const demoError = { demo: true, error: 'Read-only demo: SMS, calls, account provisioning, and changes are disabled.' };

function fixtures(tenant) {
  const acme = tenant.id === 'demo-acme';
  const names = acme ? ['Taylor Sample', 'Morgan Sample'] : ['Alex Example', 'Jamie Example', 'Sam Example'];
  const base = acme ? 110 : 100;
  const contacts = names.map((name, i) => ({
    phone: `+12025550${base + i}`, name, email: `${name.split(' ')[0].toLowerCase()}@example.com`,
    sources: [i === 0 ? 'booking' : 'prebooking'], primarySource: i === 0 ? 'booking' : 'prebooking',
    smsMarketingConsent: i !== 2, canEnroll: i !== 2, enrollments: i === 0 ? ['appointment-reminders'] : [],
    optedOut: i === 2, optOutKeyword: i === 2 ? 'STOP' : null, optOutSource: 'demo',
    optedOutAt: i === 2 ? '2026-09-15T18:00:00Z' : null,
    unreadCount: 0, messageCount: 2, lastDirection: 'inbound',
    lastBody: i === 2 ? 'STOP' : 'Thanks! That works for me. (Sample message)',
    lastMessageAt: '2026-09-16T16:10:00Z', latestAt: '2026-09-16T16:10:00Z',
    lastDeliverability: 'received', recordCount: 1,
  }));
  const messages = contacts.flatMap((c, i) => [
    { id: `${tenant.id}-${i}-out`, sid: `demo-${i}-out`, to: c.phone, from: '+12025550199',
      contactName: c.name, contactPhone: c.phone, direction: 'outbound',
      categoryId: i === 0 ? 'appointment-reminders' : 'quote-requests',
      body: `Hi ${c.name.split(' ')[0]}, this is a sample message from ${tenant.shortName}.`,
      deliverability: 'delivered', createdAt: '2026-09-16T16:00:00Z', updatedAt: '2026-09-16T16:00:05Z',
      statusHistory: [{ status: 'delivered', at: '2026-09-16T16:00:05Z' }], meta: {} },
    { id: `${tenant.id}-${i}-in`, sid: `demo-${i}-in`, to: '+12025550199', from: c.phone,
      contactName: c.name, contactPhone: c.phone, direction: 'inbound',
      categoryId: i === 0 ? 'appointment-reminders' : 'quote-requests',
      body: c.lastBody, deliverability: 'received', createdAt: c.lastMessageAt, updatedAt: c.lastMessageAt,
      statusHistory: [], meta: {} },
  ]);
  return { contacts, messages };
}

function summary(messages, contacts) {
  const counts = {};
  for (const m of messages) counts[m.deliverability] = (counts[m.deliverability] || 0) + 1;
  return { total: messages.length, counts, conversationCount: contacts.length, contactCount: contacts.length,
    optedOutTotal: contacts.filter(c => c.optedOut).length, deliveryRate: 100 };
}

function page(req, rows, key) {
  const q = String(req.query.q || '').toLowerCase();
  rows = rows.filter(row => !q || JSON.stringify(row).toLowerCase().includes(q));
  const pageSize = Math.max(1, Math.min(250, Number(req.query.pageSize) || 50));
  const totalPages = Math.max(1, Math.ceil(rows.length / pageSize));
  const pageNum = Math.max(1, Math.min(totalPages, Number(req.query.page) || 1));
  return { [key]: rows.slice((pageNum - 1) * pageSize, pageNum * pageSize), total: rows.length,
    page: pageNum, pageSize, totalPages };
}

export function createDemoApp() {
  const app = express();
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.set({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY' });
    if (!['GET', 'HEAD'].includes(req.method)) return res.status(403).json(demoError);
    next();
  });
  app.get('/api/auth/config', (_req, res) => res.json({ mode: 'demo', demo: true, configured: false }));
  app.get('/config.js', (_req, res) => res.type('text/javascript').send(
    "globalThis.SMS_CONFIG={apiBase:'',supabaseUrl:'',formApiBase:'',embedBaseUrl:''};"
  ));
  app.get('/api/tenants', (_req, res) => res.json({ demo: true, tenants, currentTenant: tenants[0] }));
  app.use('/api', (req, res) => {
    const tenant = tenants.find(t => t.id === (req.get('X-Tenant-ID') || tenants[0].id));
    if (!tenant) return res.status(403).json({ demo: true, error: 'Unknown demo business' });
    const { contacts, messages } = fixtures(tenant);
    const stats = summary(messages, contacts);
    let result;
    const path = req.path;
    if (path === '/categories') result = { categories, cadences: Object.entries(CADENCE_PRESETS).map(([id, value]) => ({ id, ...value })), rulePresets: [] };
    else if (path === '/overview' || path === '/deliverability') result = { ...stats,
      byCategory: categories.map(c => ({ id: c.id, ...summary(messages.filter(m => m.categoryId === c.id), contacts) })) };
    else if (path === '/messages') {
      const rows = messages.filter(m => (!req.query.category || m.categoryId === req.query.category) &&
        (!req.query.status || m.deliverability === req.query.status));
      result = { ...page(req, rows, 'messages'), summary: summary(rows, contacts) };
    } else if (path === '/directory' || path === '/contacts' || path === '/opt-outs') {
      const rows = contacts.filter(c => (path !== '/opt-outs' || c.optedOut) &&
        (!req.query.consented || c.smsMarketingConsent) && (!req.query.source || c.sources.includes(req.query.source)));
      result = { ...page(req, rows, 'contacts'), configured: true, supabaseConfigured: false,
        contactTotal: contacts.length, activeTotal: contacts.filter(c => !c.optedOut).length, optedOutTotal: stats.optedOutTotal };
    } else if (path === '/conversations') {
      result = { ...page(req, req.query.unread ? [] : contacts, 'conversations'), unreadTotal: 0 };
    } else if (/^\/conversations\/[^/]+(?:\/calls)?$/.test(path)) {
      const phone = decodeURIComponent(path.split('/')[2]);
      const contact = contacts.find(c => c.phone === phone);
      if (!contact) return res.status(404).json({ demo: true, error: 'Sample conversation not found' });
      result = path.endsWith('/calls') ? { calls: [] } : {
        conversation: { ...contact, messages: messages.filter(m => m.contactPhone === phone) } };
    } else if (path === '/calls') result = { ...page(req, [], 'calls') };
    else if (path === '/enrollments') result = { ...page(req, [], 'enrollments') };
    else if (path.startsWith('/automation-intake/')) result = { rows: [], total: 0, page: 1, pageSize: 50, totalPages: 1 };
    else if (path === '/web-forms') result = { canEdit: false, timeZone: 'America/Denver',
      consentText: `I agree to receive SMS updates and follow-ups from ${tenant.name} at the number provided. Consent is optional. Message frequency varies. Message and data rates may apply. Reply STOP to opt out.`, forms: [
      { preset: 'contacts', public_id: '00000000-0000-4000-8000-000000000001', title: 'Contact us', description: '', button_label: 'Send message', enabled: true, fields: [] },
      { preset: 'quote_requests', public_id: '00000000-0000-4000-8000-000000000002', title: 'Request a quote', description: '', button_label: 'Request quote', enabled: true, fields: [] },
      { preset: 'bookings', public_id: '00000000-0000-4000-8000-000000000003', title: 'Book an appointment', description: '', button_label: 'Book appointment', enabled: true, fields: [] },
    ] };
    else if (/^\/web-forms\/(contacts|quote_requests|bookings)\/submissions$/.test(path)) result = { rows: [], total: 0, page: 1, pageSize: 50, totalPages: 1 };
    else if (/^\/automations\/[^/]+$/.test(path)) {
      const category = categories.find(c => c.id === path.split('/')[2]);
      if (!category) return res.status(404).json({ demo: true, error: 'Sample group not found' });
      result = { group: category, sequence: { name: category.name, description: category.description,
        steps: [{ id: 'sample-reminder', label: 'Sample reminder', intent: 'Remind the customer of their upcoming appointment using confirmed details.' }] } };
    } else if (path === '/ai/outbound-call') result = { configured: false, from: '+12025550199', presets: [] };
    else return res.status(403).json(demoError);
    res.json({ ...result, demo: true });
  });
  app.use('/webhooks', (_req, res) => res.status(403).json(demoError));
  app.use(express.static(fileURLToPath(new URL('../public/', import.meta.url)), { dotfiles: 'deny', etag: false, maxAge: 0 }));
  app.use((_req, res) => res.status(404).json({ demo: true, error: 'Demo page not found' }));
  app.use((_err, _req, res, _next) => res.status(400).json({ demo: true, error: 'Invalid demo request' }));
  return app;
}
