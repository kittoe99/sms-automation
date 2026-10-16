import {z} from 'zod';
const businessId=z.string().trim().min(1).max(255),uuid=z.string().uuid(),count=z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const page={page:z.number().int().min(1).max(100000).default(1),pageSize:z.number().int().min(1).max(100).default(25)};
const status=z.enum(['queued','processing','retry','completed','failed','cancelled','unknown']);
export const aiDiagnosticsPermissions=[['ai_reply_read','Read scoped AI reply run diagnostics'],['ai_reply_content_read','Read recorded AI replies and linked message text']];
export const aiDiagnosticsToolPermissions={crm_list_ai_reply_runs:'ai_reply_read',crm_get_ai_reply_run:'ai_reply_read'};
export const aiDiagnosticsTools=[
 ['crm_list_ai_reply_runs','List scoped inbound SMS agent jobs, including unfinished, failed and cancelled runs. Run IDs are job IDs. Counts and optional conversation filters are business-scoped; excludes archived jobs. No message content, read marks, retries or sends.',{businessId,...page,conversationId:uuid.optional(),status:status.optional()}],
 ['crm_get_ai_reply_run','Read one scoped AI reply run, safe tool summaries, recorded metrics and linked delivery outcomes. includeContent additionally requires ai_reply_content_read. Profile provenance is explicitly unavailable when not recorded; never inferred from the current profile. No raw prompts, tool arguments, provider payloads, read marks or sends.',{businessId,runId:uuid,includeContent:z.boolean().default(false)}],
];
const time=z.string().datetime({offset:true});
const run=z.object({id:uuid,conversationId:uuid.nullable(),status,attempts:count,createdAt:time,updatedAt:time,
 recordedAt:time.nullable(),mode:z.enum(['live','shadow']).nullable(),resultRecorded:z.boolean(),archived:z.boolean(),
 settingsRevision:count.nullable(),errorCode:z.string().max(64).nullable()}).strict();
const delivery=z.object({messageId:uuid,status:z.enum(['queued','accepted','sent','delivered','failed','undelivered','cancelled','submission_unknown','unknown']),providerAcceptedAt:time.nullable(),updatedAt:time}).strict();
const message=z.object({messageId:uuid,body:z.string().max(4000),truncated:z.boolean()}).strict();
const context={businessId,reportingAt:time};
export const aiDiagnosticsOutputs={
 crm_list_ai_reply_runs:z.object({...context,...page,total:count,runs:z.array(run).max(100)}).strict(),
 crm_get_ai_reply_run:z.object({...context,run,profileVersionId:z.null(),profileVersionAvailability:z.literal('not_recorded'),
  metrics:z.object({model:z.string().max(64).nullable(),promptVersion:z.string().max(64).nullable(),inputTokens:count.nullable(),cachedInputTokens:count.nullable(),outputTokens:count.nullable(),latencyMs:count.nullable(),estimatedCostMicros:count.nullable(),toolCount:count.nullable()}).strict(),
  actions:z.object({total:count,truncated:z.boolean(),rows:z.array(z.object({name:z.enum(['lookup_bookings','check_availability','prepare_booking','confirm_booking','request_staff_help','close_enquiry','unknown']),createdAt:time,simulated:z.boolean().nullable(),outcome:z.enum(['confirmed','prepared','missing_fields','handoff','closed','unavailable','stale','recorded'])}).strict()).max(20)}).strict(),
  delivery:z.object({total:count,truncated:z.boolean(),messages:z.array(delivery).max(20)}).strict(),
  content:z.object({inbound:message.nullable(),recordedReply:z.string().max(4000).nullable(),replyTruncated:z.boolean(),outbound:z.array(message).max(20)}).strict().nullable(),
 }).strict(),
};
