import {z} from 'zod';
import {smsAutomationSummary} from './smsSchemas.js';
const uuid=z.string().uuid(),revision=z.number().int().nonnegative();
const target={businessId:z.string().min(1).max(255),kind:z.enum(['form','contact']),automationId:uuid,contactId:uuid.optional(),submissionId:uuid.optional()};
const overlap=z.object({id:uuid,generation:revision}).strict();
const run=z.object({id:uuid,status:z.enum(['active','paused','stopped','completed']),generation:revision,publishedVersion:revision,nextRunAt:z.string().nullable()}).strict();
export const smsRunTools=[
 ['crm_get_sms_run_start_context','Read current source/contact revisions and complete overlap references before starting a run. Requires automation_read. Contact templates require contactId; forms require historical submissionId. Returns no submission answers. This is not a delivery or eligibility guarantee.',target],
 ['crm_start_sms_automation_run','Schedule a real SMS run from published rules for an existing contact or historical form submission. Requires automation_run_start, current revisions, overlaps and explicit overlapChoice. Form starts also require formRevision and submissionFingerprint. stop_selected additionally requires automation_run_pause_stop. Never grants consent or resumes an existing run; successful retries return the original result.',
  {...target,revision,formRevision:revision.optional(),contactRevision:revision.nullable(),submissionFingerprint:z.string().regex(/^[a-f0-9]{64}$/).optional(),overlaps:z.array(overlap).max(100),overlapChoice:z.enum(['keep','stop_selected']),stopRunIds:z.array(uuid).max(100).default([]),context:z.string().max(2500).optional(),startAt:z.string().datetime({offset:true}).optional(),idempotencyKey:z.string().min(8).max(128)},true],
];
export const smsRunOutputs={
 crm_get_sms_run_start_context:z.object({businessId:target.businessId,automation:smsAutomationSummary,contactId:uuid.nullable(),contactRevision:revision.nullable(),submissionFingerprint:z.string().nullable(),overlaps:z.array(overlap).max(100),existingRun:run.nullable()}).strict(),
 crm_start_sms_automation_run:z.object({businessId:target.businessId,run,databaseStatus:z.literal('committed'),effect:z.enum(['run_scheduled','already_enrolled']),stoppedRuns:z.array(overlap).max(100),deliveryStatus:z.literal('not_sent_by_this_operation')}).strict(),
};
