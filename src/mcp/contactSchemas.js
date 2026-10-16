import {z} from 'zod';
const uuid=z.string().uuid(),businessId=z.string().min(1).max(255);
const revision=z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const page={page:z.number().int().min(1).max(100000).default(1),pageSize:z.number().int().min(1).max(100).default(25)};
const target={businessId,contactId:uuid},current={...target,revision},retry={idempotencyKey:z.string().min(8).max(128)};
const body=z.string().trim().min(1).max(1600),name=z.string().trim().max(200),email=z.string().trim().email().max(254).nullable();
export const contactPermissions=[
 ['contact_read','Read scoped contact identities'],['contact_create','Create contacts without consent or enrollment'],
 ['contact_edit','Edit contact names and email addresses'],['consent_read','Read SMS consent and evidence history'],
 ['consent_opt_in','Record evidenced SMS marketing opt-in'],['contact_suppress','Suppress SMS and stop affected work'],
 ['contact_automation_block','Block or unblock contact enquiry automations'],
 ['sms_message_preview','Preview individual marketing SMS eligibility'],['sms_message_send','Queue individual marketing SMS'],
];
export const contactTools=[
 ['crm_list_contacts','List scoped contact identities with bounded pagination. No consent evidence, message content, enrollment or sending.',{businessId,...page,q:z.string().max(100).default('')}],
 ['crm_get_contact','Read one scoped contact identity and current revision. Consent history requires consent_read.',target],
 ['crm_get_contact_consent','Read current SMS marketing consent, suppression and bounded evidence history. Does not grant consent.',{...target,...page}],
 ['crm_create_contact','Create a new contact without consent or enrollment. An existing normalized phone conflicts; use an explicit revision-checked edit.',{businessId,...retry,phone:z.string().regex(/^\+[1-9][0-9]{7,14}$/),name:name.default(''),email:email.default(null)},true],
 ['crm_update_contact','Edit only contact name/email using the current revision. Phone is immutable; does not change consent or enroll.',{...current,...retry,name:name.optional(),email:email.optional()},true],
 ['crm_record_contact_sms_opt_in','Record genuine SMS marketing opt-in evidence and provenance. Does not start or resume automations; never infer consent from an enquiry.',{...current,...retry,channel:z.literal('sms'),purpose:z.literal('marketing'),evidence:z.string().trim().min(1).max(2000),source:z.string().trim().min(1).max(100),observedAt:z.string().datetime({offset:true})},true],
 ['crm_suppress_contact_sms','Suppress SMS for the scoped contact using the current revision and a reason. Canonical suppression stops affected scheduled work; cannot recall an already submitted message.',{...current,...retry,reason:z.string().trim().min(1).max(1000)},true],
 ['crm_set_contact_automation_blocked','Block or unblock enquiry automations. Blocking stops applicable active/paused runs; unblocking restarts nothing. Does not change SMS consent.',{...current,...retry,blocked:z.boolean()},true],
 ['crm_preview_contact_sms','Preview one marketing SMS using the current contact revision. Rechecks consent and sender readiness; never queues or sends.',{...current,body}],
 ['crm_send_contact_sms','Queue one marketing SMS with fresh consent, sender and revision checks. Canonical staff sending pauses AI on the resulting thread; it does not mark messages read. Retry an uncertain response with the identical payload/key. Queued is not provider acceptance or delivery.',{...current,...retry,body},true],
];
export const contactToolPermissions={crm_list_contacts:'contact_read',crm_get_contact:'contact_read',crm_get_contact_consent:'consent_read',crm_create_contact:'contact_create',crm_update_contact:'contact_edit',crm_record_contact_sms_opt_in:'consent_opt_in',crm_suppress_contact_sms:'contact_suppress',crm_set_contact_automation_blocked:'contact_automation_block',crm_preview_contact_sms:'sms_message_preview',crm_send_contact_sms:'sms_message_send'};
const contact=z.object({id:uuid,name:z.string().max(200),phone:z.string().max(32),email:z.string().nullable(),revision}).strict();
const receipt=z.object({...target,previousRevision:revision.nullable(),revision,databaseStatus:z.literal('committed')}).strict();
const paging={total:z.number().int().nonnegative(),page:page.page,pageSize:page.pageSize};
export const contactOutputs={
 crm_list_contacts:z.object({businessId,contacts:z.array(contact).max(100),...paging}).strict(),
 crm_get_contact:z.object({businessId,contact}).strict(),
 crm_get_contact_consent:z.object({...current,channel:z.literal('sms'),purpose:z.literal('marketing'),optedOut:z.boolean(),marketingConsent:z.boolean(),enquiryBlocked:z.boolean(),events:z.array(z.object({id:uuid,consent:z.boolean(),source:z.string(),evidence:z.string(),createdAt:z.string()}).strict()).max(100),...paging}).strict(),
 ...Object.fromEntries(contactTools.filter(t=>t[3]).map(t=>[t[0],receipt])),
 crm_preview_contact_sms:z.object({...current,recipientPhone:z.string(),body,estimatedSegments:z.number().int().positive(),eligible:z.boolean(),blockers:z.array(z.enum(['CONTACT_OPTED_OUT','MARKETING_CONSENT_REQUIRED','BUSINESS_SENDING_DISABLED','SENDER_NOT_READY'])).max(4),queued:z.literal(false)}).strict(),
 crm_send_contact_sms:receipt.extend({messageId:uuid,jobId:uuid,deliveryStatus:z.literal('queued')}).strict(),
};
