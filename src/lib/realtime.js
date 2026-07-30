/**
 * Live CRM updates:
 * - Browser clients connect to /ws
 * - Each app instance also listens to Supabase Realtime so multi-instance
 *   deploys still fan out inbound/status events to every open CRM tab.
 */

import { WebSocketServer } from 'ws';
import { getSupabaseAdmin, isSupabaseConfigured } from './supabase.js';

/** @type {Set<import('ws').WebSocket>} */
const clients = new Set();
let started = false;
let supabaseChannel = null;

export function publish(event, payload = {}) {
  const message = JSON.stringify({
    type: event,
    at: new Date().toISOString(),
    ...payload,
  });
  for (const ws of clients) {
    if (ws.readyState === 1) {
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

  const wss = new WebSocketServer({ server, path: '/ws' });
  wss.on('connection', (ws) => {
    clients.add(ws);
    ws.send(
      JSON.stringify({
        type: 'connected',
        at: new Date().toISOString(),
        clients: clients.size,
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
  console.log('[opek-sms] websocket hub on /ws');
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
  };
}
