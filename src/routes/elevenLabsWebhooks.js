/**
 * ElevenLabs post-call webhooks (transcription).
 */

import { Router } from 'express';
import {
  ingestPostCallWebhook,
  verifyElevenLabsWebhookSignature,
} from '../lib/elevenlabsConversations.js';

export const elevenLabsWebhooksRouter = Router();

elevenLabsWebhooksRouter.post('/post-call', async (req, res) => {
  const secret = String(process.env.ELEVENLABS_WEBHOOK_SECRET || '').trim();
  const signature =
    req.get('ElevenLabs-Signature') || req.get('elevenlabs-signature') || '';

  const rawBody =
    typeof req.rawBody === 'string'
      ? req.rawBody
      : typeof req.body === 'string'
        ? req.body
        : Buffer.isBuffer(req.body)
          ? req.body.toString('utf8')
          : JSON.stringify(req.body || {});

  if (secret) {
    const verified = verifyElevenLabsWebhookSignature(rawBody, signature, secret);
    if (!verified.ok) {
      console.warn('[opek-sms] elevenlabs webhook auth failed', verified.error);
      return res.status(401).json({ error: verified.error || 'Unauthorized' });
    }
  } else {
    console.warn(
      '[opek-sms] ELEVENLABS_WEBHOOK_SECRET not set; accepting post-call webhook without HMAC'
    );
  }

  let event;
  try {
    event = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body;
    if (!event || typeof event !== 'object') {
      event = JSON.parse(rawBody || '{}');
    }
  } catch {
    return res.status(400).json({ error: 'Invalid JSON body' });
  }

  try {
    const result = await ingestPostCallWebhook(event);
    console.log('[opek-sms] elevenlabs post-call', {
      type: event?.type,
      conversationId: result.conversationId || null,
      skipped: result.skipped || false,
    });
    return res.status(200).json({ ok: true, ...result });
  } catch (err) {
    console.error('[opek-sms] elevenlabs post-call failed', err);
    // Still 200 for repeated poison payloads? Prefer 500 so ElevenLabs retries.
    return res.status(500).json({
      error: 'Failed to store conversation',
      detail: err.message || String(err),
    });
  }
});
