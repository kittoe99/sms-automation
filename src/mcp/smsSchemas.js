import {z} from 'zod';

const uuid=z.string().uuid(), revision=z.number().int().nonnegative();
const kind=z.enum(['form','contact']);
const page={page:z.number().int().min(1).max(100000).default(1),pageSize:z.number().int().min(1).max(100).default(25)};
const business={businessId:z.string().min(1).max(255)};
const q=z.string().max(100).default('');
export const smsReadTools=[
 ['crm_list_sms_automations','List forms (including unconfigured follow-ups) and contact templates in an explicit business. Does not enroll or send.',{...business,...page,q,kind:kind.optional(),includeArchived:z.boolean().default(false)}],
 ['crm_get_sms_automation','Read the saved draft, published version, revisions and readiness snapshot. Readiness is not recipient eligibility or a promise of delivery.',{...business,kind,automationId:uuid}],
 ['crm_search_sms_contacts','Find business SMS contacts and current consent/blocking facts. These are SMS contacts, not CRM customer accounts. Does not grant consent.',{...business,...page,q}],
 ['crm_list_form_submissions','List scoped submission references and enrollment state for one form. Consent and sending eligibility must be rechecked when starting a run.',{...business,...page,formId:uuid}],
];
const unit=z.enum(['minute','hour','day','week','month']);
export const smsSequenceSchema=z.object({
 aiRepliesEnabled:z.boolean().optional().describe("Defaults to true. False disables automatic AI replies associated with this automation; it does not change scheduled reply policies or business-wide sending checks."),
 instantAcknowledgment:z.boolean().optional().describe('Form submission only: send the zero-delay first acknowledgment outside sending hours. Repeats and later messages keep the sending window; consent is still required.'),
 trigger:z.enum(['submission','appointment']),leadHours:z.number().int().min(1).max(8760),
 replyPolicy:z.enum(['pause','continue','stop']),startHour:z.number().int().min(0).max(23),endHour:z.number().int().min(1).max(24),
 steps:z.array(z.object({body:z.string().min(1).max(1600),delayCount:z.number().int().min(0).max(365),delayUnit:unit,
  sendCount:z.number().int().min(1).max(1000),intervalCount:z.number().int().min(1).max(365),intervalUnit:unit}).strict()).min(1).max(50),
}).strict();
export const smsAutomationSummary=z.object({id:uuid,kind,name:z.string(),archived:z.boolean(),revision,publishedVersion:revision.nullable(),
 enabled:z.boolean().nullable(),formEnabled:z.boolean().nullable(),formRevision:revision.nullable(),preset:z.enum(['contacts','quote_requests','bookings']).nullable()}).strict();
const paging={total:z.number().int().nonnegative(),page:z.number().int().positive(),pageSize:z.number().int().min(1).max(100)};
const context={businessId:business.businessId,timeZone:z.string()};
const run=z.object({id:uuid,status:z.enum(['active','paused','completed','stopped']),generation:revision}).strict();
export const smsReadOutputs={
 crm_list_sms_automations:z.object({...context,automations:z.array(smsAutomationSummary).max(100),...paging}).strict(),
 crm_get_sms_automation:z.object({...context,automation:smsAutomationSummary.extend({draft:smsSequenceSchema.nullable(),published:smsSequenceSchema.nullable(),supportedFields:z.array(z.string())}).strict(),
  readiness:z.object({blockers:z.array(z.enum(['ARCHIVED','UNPUBLISHED','FORM_DISABLED','AUTOMATION_DISABLED','BUSINESS_INACTIVE','SENDING_DISABLED','SENDER_NOT_CONNECTED','DIRECT_RUNTIME_DISABLED'])),recipientChecksRequired:z.literal(true)}).strict()}).strict(),
 crm_search_sms_contacts:z.object({...context,contacts:z.array(z.object({id:uuid,name:z.string().nullable(),phone:z.string(),email:z.string().nullable(),revision,
  marketingConsent:z.boolean(),optedOut:z.boolean(),enquiryBlocked:z.boolean()}).strict()).max(100),...paging}).strict(),
 crm_list_form_submissions:z.object({...context,formId:uuid,submissions:z.array(z.object({id:uuid,name:z.string(),phone:z.string(),email:z.string().nullable(),
  submittedAt:z.string(),smsConsent:z.boolean(),appointmentAt:z.string().nullable(),contactId:uuid.nullable(),contactRevision:revision.nullable(),run:run.nullable()}).strict()).max(100),...paging}).strict(),
};
