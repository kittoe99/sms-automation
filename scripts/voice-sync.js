#!/usr/bin/env node
/**
 * One-shot / cron-friendly sync of ElevenLabs conversations into Supabase.
 * Usage: node scripts/voice-sync.js
 * Env: ELEVENLABS_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 * Optional: ELEVENLABS_OUTBOUND_AGENT_ID, VOICE_SYNC_SINCE_UNIX, VOICE_SYNC_MAX_PAGES
 */

import dotenv from 'dotenv';
dotenv.config({ override: true });

import { syncConversations } from '../src/lib/elevenlabsConversations.js';

const agentId =
  process.env.ELEVENLABS_OUTBOUND_AGENT_ID || 'agent_7801kwfn9rkcey5rn1wsrjdpnvvn';
const sinceUnix = process.env.VOICE_SYNC_SINCE_UNIX
  ? Number(process.env.VOICE_SYNC_SINCE_UNIX)
  : null;
const maxPages = process.env.VOICE_SYNC_MAX_PAGES
  ? Number(process.env.VOICE_SYNC_MAX_PAGES)
  : 20;

const summary = await syncConversations({
  agentId,
  sinceUnix: Number.isFinite(sinceUnix) ? sinceUnix : null,
  maxPages: Number.isFinite(maxPages) ? maxPages : 20,
});

console.log(JSON.stringify({ ok: true, summary }, null, 2));
if (summary.errors?.length) process.exitCode = 1;
