import { isAiConfigured } from './client.js';
import { handleInboundAi } from './agent.js';
import { getMessage } from '../messageStore.js';
import {
  canPersistMessages,
  dbGetMessage,
  dbListInboundAiCandidates,
  dbUpdateInboundAiState,
} from '../messageDb.js';
import { findTenant, getDefaultTenant, runWithTenant } from '../tenantContext.js';

const LOCK_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 6;

function isDue(message, now = new Date()) {
  const ai = message?.meta?.ai || {};
  if (ai.state === 'completed' || ai.state === 'dead') return false;
  if (Number(ai.attempts || 0) >= MAX_ATTEMPTS) return false;
  if (ai.state === 'processing') {
    const lockedAt = new Date(ai.lockedAt || 0).getTime();
    return !Number.isFinite(lockedAt) || lockedAt + LOCK_TIMEOUT_MS <= now.getTime();
  }
  const availableAt = new Date(ai.availableAt || 0).getTime();
  return !Number.isFinite(availableAt) || availableAt <= now.getTime();
}

async function loadMessage(id) {
  if (canPersistMessages()) return dbGetMessage(id);
  return getMessage(id);
}

async function setState(message, ai) {
  if (!canPersistMessages()) {
    message.meta = { ...(message.meta || {}), ai };
    return message;
  }
  return dbUpdateInboundAiState(message, ai);
}

export async function processInboundAiJob(id, { now = new Date() } = {}) {
  if (!isAiConfigured()) return { skipped: true, reason: 'ai_disabled' };
  const message = await loadMessage(id);
  if (!message || message.direction !== 'inbound') {
    return { skipped: true, reason: 'message_not_found' };
  }
  if (!isDue(message, now)) return { skipped: true, reason: 'not_due' };

  const previous = message.meta?.ai || {};
  const attempts = Number(previous.attempts || 0) + 1;
  const claimed = await setState(message, {
    ...previous,
    state: 'processing',
    attempts,
    lockedAt: now.toISOString(),
    lastError: null,
  });
  if (!claimed) return { skipped: true, reason: 'already_claimed' };

  try {
    const tenant = findTenant(claimed.meta?.tenantId) || getDefaultTenant();
    const result = await runWithTenant(tenant, () =>
      handleInboundAi({
        from: claimed.from || claimed.contactPhone,
        body: claimed.body,
        sid: claimed.sid || claimed.id,
      })
    );
    if (result?.reason === 'error') {
      throw new Error(result.detail || 'AI processing failed');
    }
    await setState(claimed, {
      ...(claimed.meta?.ai || {}),
      state: 'completed',
      completedAt: new Date().toISOString(),
      result: result?.reason || 'replied',
      lockedAt: null,
      availableAt: null,
    });
    return result;
  } catch (err) {
    const dead = attempts >= MAX_ATTEMPTS;
    const retryDelayMs = Math.min(2 ** attempts * 30_000, 30 * 60 * 1000);
    await setState(claimed, {
      ...(claimed.meta?.ai || {}),
      state: dead ? 'dead' : 'failed',
      lockedAt: null,
      availableAt: dead ? null : new Date(Date.now() + retryDelayMs).toISOString(),
      lastError: err.message || String(err),
    });
    throw err;
  }
}

export async function drainInboundAiJobs({ limit = 25, now = new Date() } = {}) {
  const summary = { processed: 0, completed: 0, skipped: 0, errors: [] };
  if (!isAiConfigured()) return { ...summary, skipped: 1, reason: 'ai_disabled' };
  if (!canPersistMessages()) {
    return { ...summary, skipped: 1, reason: 'persistent_store_unavailable' };
  }

  const candidates = (await dbListInboundAiCandidates({ limit: Math.max(limit * 8, 100) }))
    .filter((message) => isDue(message, now))
    .slice(0, limit);

  for (const message of candidates) {
    try {
      const result = await processInboundAiJob(message.id, { now });
      if (result?.reason === 'already_claimed' || result?.reason === 'not_due') {
        summary.skipped += 1;
      } else {
        summary.processed += 1;
        summary.completed += 1;
      }
    } catch (err) {
      summary.processed += 1;
      summary.errors.push({ messageId: message.id, error: err.message || String(err) });
    }
  }
  return summary;
}
