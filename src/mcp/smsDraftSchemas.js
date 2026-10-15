import {z} from 'zod';
import {smsSequenceSchema,smsAutomationSummary} from './smsSchemas.js';

const uuid=z.string().uuid(),revision=z.number().int().nonnegative();
const businessId=z.string().min(1).max(255),kind=z.enum(['form','contact']);
const localTime=z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
const target={businessId,kind,automationId:uuid,revision,formRevision:revision.optional()};
const draft={businessId,kind,sequence:smsSequenceSchema,idempotencyKey:z.string().min(8).max(128),name:z.string().trim().min(1).max(100).optional(),formRevision:revision.optional()};
const sample=z.object({name:z.string().max(200),phone:z.string().regex(/^\+[1-9]\d{7,14}$/),email:z.string().max(320),smsOptIn:z.boolean(),
 details:z.record(z.string().max(40),z.union([z.string().max(2000),z.boolean(),z.null()])).optional(),appointmentLocal:localTime.optional()}).strict();
export const smsDraftTools=[
 ['crm_create_sms_automation','Create an unpublished contact template (name required) or the first draft on an existing form (automationId and formRevision required). Never creates a public form or enables follow-ups.',{...draft,automationId:uuid.optional()},true],
 ['crm_save_sms_automation_draft','Replace a draft using its current revision. Form drafts also require formRevision; contact templates require name. Published versions and existing runs remain unchanged.',{...draft,automationId:uuid,revision},true],
 ['crm_preview_sms_automation','Simulate draft, published, or unsaved input rules; never send or enroll. Requires current revision, explicit business-local submittedLocal and formRevision for forms. Use sample for forms; contacts use either sample or contactId plus contactRevision. sequence is allowed only for source=input.',
  {...target,source:z.enum(['draft','published','input']).default('draft'),sequence:smsSequenceSchema.optional(),sample:sample.optional(),contactId:uuid.optional(),contactRevision:revision.optional(),
   context:z.string().max(2500).optional(),submittedLocal:localTime,scenario:z.enum(['none','reply','opt_out']).default('none')}],
];
const mutation=z.object({businessId,automation:smsAutomationSummary,databaseStatus:z.literal('committed')}).strict();
export const smsDraftOutputs={
 crm_create_sms_automation:mutation,
 crm_save_sms_automation_draft:mutation,
 crm_preview_sms_automation:z.object({businessId,simulation:z.literal(true),timeZone:z.string(),submittedAt:z.string(),
  source:z.object({kind,automationId:uuid,revision,formRevision:revision.nullable(),publishedVersion:revision.nullable(),contactRevision:revision.nullable(),mode:z.enum(['draft','published','input'])}).strict(),
  fingerprint:z.string().regex(/^[a-f0-9]{64}$/),rows:z.array(z.object({message:z.number().int().positive(),repeat:z.number().int().positive(),at:z.string(),body:z.string().max(1600)}).strict()).max(200),
  totalSends:z.number().int().min(0).max(50000),limit:z.number().int().min(1).max(200),truncated:z.boolean(),warnings:z.array(z.string()),outcome:z.string(),
  readiness:z.object({blockers:z.array(z.string()),recipientChecksRequired:z.literal(true)}).strict()}).strict(),
};
