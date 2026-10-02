import { database, json, env } from '../_shared/http.js';
import { constantTimeToken } from '../_shared/workerAuth.js';
import { processEmailJob } from '../../../src/workers/email.js';

const db = database('SMS_AUTOMATION_DATABASE_URL');
Deno.serve(async request => {
  if (request.method !== 'POST') return json({ error: 'POST required' }, 405);
  const secret = env('AUTOMATION_WORKER_SECRET');
  if (!secret || secret.length < 32) return json({ error: 'Worker not configured' }, 503);
  if (!constantTimeToken(request.headers.get('Authorization'), `Bearer ${secret}`)) return json({ error: 'Unauthorized' }, 401);
  let processed = 0;
  const started = Date.now();
  try {
    while (processed < 10 && Date.now() - started < 30000) {
      const job = await db.call('email_claim');
      if (!job) break;
      await processEmailJob(job, db);
      processed++;
    }
    return json({ processed });
  } catch (error) {
    console.error(JSON.stringify({ event: 'email_worker_failed', code: error.code || 'WORKER_ERROR' }));
    return json({ error: 'Worker temporarily unavailable', processed }, 503);
  }
});
