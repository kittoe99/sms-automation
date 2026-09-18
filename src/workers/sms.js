import { providerPost } from './providerHttp.js';
const fetchClient = (sid, token) => ({ messages: { create: async message => providerPost(
  `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}/Messages.json`,sid,token,
  {To:message.to,Body:message.body,StatusCallback:message.statusCallback,...(message.messagingServiceSid?{MessagingServiceSid:message.messagingServiceSid}:{From:message.from})}
) }});

export function classifySubmissionError(error) {
  // A timeout, disconnected socket, or 5xx may follow acceptance. Never replay it automatically.
  if (error.status === 429) return 'retry';
  if (error.status >= 400 && error.status < 500) return 'failed';
  return 'submission_unknown';
}

export async function processSms(job, db, { clientFactory = fetchClient, callbackBase = globalThis.Deno?.env.get('SMS_CALLBACK_URL') ?? globalThis.process?.env.SMS_CALLBACK_URL } = {}) {
  if (!callbackBase || new URL(callbackBase).protocol !== 'https:') throw new Error('HTTPS SMS_CALLBACK_URL required');
  const submission = await db.call('begin_submission', job.id, job.lease_token);
  if (!submission) return;
  const callback = new URL(callbackBase);
  callback.searchParams.set('attempt_id', submission.attempt_id);
  let response;
  try {
    response = await clientFactory(submission.account_sid, submission.auth_token).messages.create({
      to: submission.phone, body: submission.body, statusCallback: callback.href,
      ...(submission.messaging_service_sid ? { messagingServiceSid: submission.messaging_service_sid } : { from: submission.from_number }),
    });
  } catch (error) {
    await db.call('finish', job.id, job.lease_token, classifySubmissionError(error), String(error.code || 'TRANSPORT_UNKNOWN'), Math.min(3600, 30 * 2 ** (job.attempts - 1)) + Math.floor(Math.random() * 10));
    return;
  }
  // Persist acceptance separately: database failure MUST NOT turn an accepted SMS into a retry.
  try {
    await db.call('accept_submission', job.id, job.lease_token, submission.attempt_id, response.sid);
  } catch (error) {
    console.error(JSON.stringify({ event: 'acceptance_persistence_failed', jobId: job.id, attemptId: submission.attempt_id, sid: response.sid, code: error.code || 'DB_ERROR' }));
    // The callback can reconcile the exact attempt. Otherwise the expired submission is held.
  }
}
