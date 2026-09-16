/**
 * Live CRM updates:
 * - Browser clients connect to /ws
 * - Each app instance also listens to Supabase Realtime so multi-instance
 *   deploys still fan out inbound/status events to every open CRM tab.
 */

import { WebSocketServer } from 'ws';
import { getSupabaseAdmin, isSupabaseConfigured } from './supabase.js';
import { verifyCrmAccessToken } from './crmAuth.js';
import {
  findTenant,
  getCurrentTenantId,
  getDefaultTenant,
  isTenantDataAccessSafe,
} from './tenantContext.js';

/** @type {Set<import('ws').WebSocket>} */
const clients = new Set();
let started = false;
let supabaseChannel = null;

export function publish(event, payload = {}, options = {}) {
  const tenantId =
    options.tenantId ||
    payload.tenantId ||
    payload.record?.tenantId ||
    payload.record?.tenant_id ||
    payload.record?.meta?.tenantId ||
    getCurrentTenantId();
  const message = JSON.stringify({
    type: event,
    at: new Date().toISOString(),
    tenantId,
    ...payload,
  });
  for (const ws of clients) {
    if (ws.readyState === 1 && ws.tenantId === tenantId) {
      try {
        ws.send(message);
      } catch (err) {
        console.warn('[opek-sms] ws send failed', err.message);
      }
    }
  }
}

export function attachRealtime(server) {
  if (started) return;
  started = true;

  const wss = new WebSocketServer({
    server,
    path: '/ws',
    clientTracking: false,
    perMessageDeflate: false,
    maxPayload: 4096,
    handleProtocols(protocols) {
      return protocols.has('opek-sms-v1') ? 'opek-sms-v1' : false;
    },
  });
  wss.on('connection', async (ws, req) => {
    try {
      if (!isTenantDataAccessSafe()) {
        ws.close(1013, 'Tenant isolation required');
        return;
      }
      if (!isAllowedWebSocketOrigin(req)) {
        ws.close(4403, 'Forbidden origin');
        return;
      }
      const url = new URL(req.url || '/ws', 'http://localhost');
      const requestedTenantId = String(url.searchParams.get('tenant_id') || '').trim();
      const tenant = requestedTenantId ? findTenant(requestedTenantId) : getDefaultTenant();
      if (!tenant) {
        ws.close(4404, 'Unknown business account');
        return;
      }
      const token = extractWebSocketToken(req.headers['sec-websocket-protocol']);
      const user = token ? await verifyCrmAccessToken(token, { tenant }) : null;
      if (!user) {
        ws.close(4401, 'Unauthorized');
        return;
      }
      ws.crmUser = user;
      ws.tenantId = tenant.id;
    } catch (err) {
      console.warn('[opek-sms] ws auth failed', err.message);
      ws.close(4401, 'Unauthorized');
      return;
    }

    clients.add(ws);
    ws.send(
      JSON.stringify({
        type: 'connected',
        at: new Date().toISOString(),
        clients: clients.size,
        tenantId: ws.tenantId,
      })
    );
    ws.on('close', () => clients.delete(ws));
    ws.on('error', () => clients.delete(ws));
    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(String(raw));
        if (msg?.type === 'ping') {
          ws.send(JSON.stringify({ type: 'pong', at: new Date().toISOString() }));
        }
      } catch {
        /* ignore malformed */
      }
    });
  });

  startSupabaseBridge();
  console.log('[opek-sms] websocket hub on /ws (CRM auth required)');
}

export function extractWebSocketToken(protocolHeader) {
  const authProtocol = String(protocolHeader || '')
    .split(',')
    .map((value) => value.trim())
    .find((value) => value.startsWith('auth.'));
  const token = authProtocol?.slice('auth.'.length) || '';
  return token.length <= 8192 ? token : '';
}

export function isAllowedWebSocketOrigin(req) {
  const origin = String(req.headers.origin || '').trim();
  if (!origin) return process.env.NODE_ENV !== 'production';

  const configuredBase = String(process.env.PUBLIC_BASE_URL || '').trim();
  try {
    if (configuredBase) return origin === new URL(configuredBase).origin;
    const proto = String(req.headers['x-forwarded-proto'] || 'http').split(',')[0].trim();
    const host = String(req.headers['x-forwarded-host'] || req.headers.host || '')
      .split(',')[0]
      .trim();
    return process.env.NODE_ENV !== 'production' && origin === `${proto}://${host}`;
  } catch {
    return false;
  }
}

function startSupabaseBridge() {
  if (!isSupabaseConfigured()) {
    console.warn('[opek-sms] supabase realtime bridge skipped (not configured)');
    return;
  }

  try {
    const admin = getSupabaseAdmin();
    supabaseChannel = admin
      .channel('opek-sms-crm-bridge')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'sms_messages' },
        (payload) => {
          publish('message', {
            event: String(payload.eventType || '').toLowerCase(),
            record: mapMessage(payload.new || payload.old),
          });
        }
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'sms_thread_contacts' },
        (payload) => {
          publish('thread', {
            event: String(payload.eventType || '').toLowerCase(),
            record: mapThread(payload.new || payload.old),
          });
        }
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'sms_automation_enrollments' },
        (payload) => {
          publish('enrollment', {
            event: String(payload.eventType || '').toLowerCase(),
            record: payload.new || payload.old || null,
          });
        }
      )
      .subscribe((status) => {
        if (status === 'SUBSCRIBED') {
          console.log('[opek-sms] supabase realtime bridge subscribed');
        } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
          console.warn('[opek-sms] supabase realtime bridge status', status);
        }
      });
  } catch (err) {
    console.error('[opek-sms] failed to start supabase realtime bridge', err.message || err);
  }
}

function mapMessage(row) {
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
    contactName: row.contact_name,
    meta: row.meta || {},
    tenantId: row.tenant_id || row.meta?.tenantId || getDefaultTenant().id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapThread(row) {
  if (!row) return null;
  return {
    phone: row.phone,
    name: row.name,
    messageCount: row.message_count,
    unreadCount: row.unread_count,
    lastMessageAt: row.last_message_at,
    lastDirection: row.last_direction,
    lastBody: row.last_body,
    lastDeliverability: row.last_deliverability,
    optedOut: row.opted_out,
    tenantId: row.tenant_id || getDefaultTenant().id,
  };
}
