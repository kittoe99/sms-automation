import { constantTimeToken, json } from '../_shared/workerAuth.js';
import { processEmailBatch, processEmailJob } from '../../../src/workers/email.js';

export function createEmailWorkerHandler({ db, secret, processJob = processEmailJob, processBatch = processEmailBatch, now = Date.now, maxBatches = 6 }) {
  return async request => {
    if (request.method !== 'POST') return json({ error: 'POST required' }, 405);
    if (!secret || secret.length < 32) return json({ error: 'Worker not configured' }, 503);
    if (!constantTimeToken(request.headers.get('Authorization'), `Bearer ${secret}`)) return json({ error: 'Unauthorized' }, 401);
    let slot;
    let processed = 0;
    try {
      // Email and SMS automation share the same scoped login and admission cap.
      // Provider-specific recovery remains in email_claim/email_finish.
      slot = await db.call('edge_enter', 'automation_jobs', `email:${crypto.randomUUID()}`);
      if (!slot) return json({ status: 'paused_or_busy', processed });
      const started = now();
      while (processed < 5 && now() - started < 20000) {
        const job = await db.call('email_claim');
        if (!job) break;
        await processJob(job, db);
        processed++;
      }
      // Individual drip/booking messages go first; campaign batches use the rest
      // of the budget. A batch already claimed is always completed.
      let batches = 0;
      while (batches < maxBatches && now() - started < 20000) {
        const claim = await db.call('email_claim_batch');
        if (!claim) break;
        await processBatch(claim, db);
        batches++;
        processed += claim.jobs?.length || 0;
      }
      return json({ processed, batches });
    } catch (error) {
      console.error(JSON.stringify({ event: 'email_worker_failed', code: error.code || 'WORKER_ERROR' }));
      return json({ error: 'Worker temporarily unavailable', processed }, 503);
    } finally {
      if (slot) await db.call('edge_exit', 'automation_jobs', slot).catch(() => {});
    }
  };
}
