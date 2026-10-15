import {z} from 'zod';
const uuid=z.string().uuid(),revision=z.number().int().nonnegative(),businessId=z.string().min(1).max(255);
const status=z.enum(['active','paused','stopped','completed']);
const page={page:z.number().int().min(1).max(100000).default(1),pageSize:z.number().int().min(1).max(100).default(25)};
const target={businessId,runId:uuid},write={...target,generation:revision,idempotencyKey:z.string().min(8).max(128)};
const run=z.object({id:uuid,status,generation:revision,publishedVersion:revision.nullable(),nextRunAt:z.string().nullable()}).strict();
const detail=run.extend({kind:z.enum(['form','contact']),automationId:uuid,contactId:uuid.nullable(),contactRevision:revision.nullable(),createdAt:z.string(),appointmentAt:z.string().nullable(),test:z.boolean()}).strict();
const paging={total:revision,page:page.page,pageSize:page.pageSize};
export const smsActivityTools=[
 ['crm_list_sms_runs','List scoped SMS runs with current generations and contact revisions. Requires automation_activity independently of automation_read. Filters and counts apply only to this business.',{businessId,...page,kind:z.enum(['form','contact']).optional(),automationId:uuid.optional(),contactId:uuid.optional(),status:status.optional()}],
 ['crm_get_sms_run','Inspect a scoped run and current contact revision before controlling it. Requires automation_activity. A stopped or completed run cannot be resumed; immutable published rules remain attached.',target],
 ['crm_get_sms_run_activity','Read paginated, newest-first run events and lifetime delivery counts. Requires automation_activity. Provider acceptance is separate from delivery; historical/simulated events are marked. No message bodies, submission answers or unlinked activity are returned.',{...target,...page}],
 ['crm_pause_sms_run','Pause an active or paused run with its current generation and a retry key. Requires automation_run_pause_stop. Invalidate queued work; already submitted messages may still arrive. Does not change consent, other runs or automation settings.',write,true],
 ['crm_stop_sms_run','Permanently stop an active or paused run with its current generation and a retry key. Requires automation_run_pause_stop. Already submitted messages may still arrive. Finished runs require a new enrollment.',write,true],
 ['crm_resume_sms_run','Resume a paused SMS run using its current generation and contactRevision. Requires automation_run_resume. Rechecks consent, STOP, sending, source settings and unresolved sends. Keeps the original published rules and other runs; workers enforce final delivery eligibility.',{...write,contactRevision:revision},true],
];
const mutation=z.object({businessId,run,databaseStatus:z.literal('committed'),effect:z.enum(['paused','stopped','resumed']),deliveryStatus:z.literal('not_sent_by_this_operation'),inFlightMayDeliver:z.boolean()}).strict();
export const smsActivityOutputs={
 crm_list_sms_runs:z.object({businessId,runs:z.array(detail).max(100),...paging}).strict(),
 crm_get_sms_run:z.object({businessId,run:detail}).strict(),
 crm_get_sms_run_activity:z.object({businessId,run,reportingAt:z.string(),events:z.array(z.object({id:z.string(),kind:z.string(),occurredAt:z.string().nullable(),recordedAt:z.string(),historical:z.boolean(),simulated:z.boolean(),revision,fromStatus:status.nullable(),status:status.nullable(),operation:z.enum(['pause','resume','stop']).nullable()}).strict()).max(100),...paging,counts:z.object({providerAccepted:revision,delivered:revision,failed:revision,unresolvedSends:revision,responses:revision}).strict()}).strict(),
 crm_pause_sms_run:mutation,crm_stop_sms_run:mutation,crm_resume_sms_run:mutation,
};
