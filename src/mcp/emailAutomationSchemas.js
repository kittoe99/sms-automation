import {z} from 'zod';
import {validateEmailDefinition} from '../lib/emailTemplates.js';
const uuid=z.string().uuid(), revision=z.number().int().min(1).max(2147483647);
const span=z.object({text:z.string().max(10000),bold:z.boolean().optional(),italic:z.boolean().optional(),href:z.string().max(2000).optional()}).strict();
export const emailDefinition=z.object({name:z.string().max(120).optional(),purpose:z.enum(['marketing','service']),startHour:z.number().int().min(0).max(23),endHour:z.number().int().min(1).max(24),steps:z.array(z.object({subject:z.string().min(1).max(200),anchor:z.enum(['event','appointment']),offsetMinutes:z.number().int().min(-525600).max(525600),document:z.array(z.object({type:z.enum(['paragraph','heading','bullet']),content:z.array(span).max(1000)}).strict()).min(1).max(100)}).strict()).min(1).max(30)}).strict().superRefine((v,c)=>{try{validateEmailDefinition(v);}catch(e){c.addIssue({code:'custom',message:e.message});}});
const businessId=z.string().min(1).max(255),base={businessId},retry={...base,idempotencyKey:uuid},edit={...retry,id:uuid,revision},run={...retry,runId:uuid,revision,generation:revision};
export const emailAutomationPermissions=[
 ['email_automation_read','Read reusable email content, settings, contacts, consent status and delivery activity'],
 ['email_automation_edit','Create, edit, duplicate and archive reusable email templates'],
 ['email_automation_publish','Publish reusable email versions for future enrollments'],
 ['email_automation_connect','Configure email event connections and form consent switches'],
 ['email_automation_settings','Configure verified email sender settings and activate email sending'],
 ['email_automation_consent','Record email marketing consent or withdrawal; opt-in may start connected sequences'],
 ['email_automation_start','Start an eligible individual email sequence'],
 ['email_automation_control','Pause, resume, stop or retry reusable email sequences'],
];
export const emailAutomationTools=[
 ['crm_get_email_automation_workspace','Read reusable templates (including content), connections, sender settings, forms, up to 100 contacts with consent status, and a page of 25 runs/jobs. Separate from legacy AI email groups. Never returns provider credentials or unsubscribe tokens.',{...base,page:z.number().int().min(1).max(10000).default(1)}],
 ['crm_preview_email_template','Preview a current draft and its sequential schedule without enrolling or sending. Null times are skipped steps. Times assume prompt processing; delivery can be later.',{...base,id:uuid,revision,startAt:z.string().datetime({offset:true}),appointmentAt:z.string().datetime({offset:true}).nullable().default(null)}],
 ['crm_create_email_template','Create an unpublished reusable formatted email draft. No enrollment or send.',{...retry,name:z.string().trim().min(1).max(120),definition:emailDefinition},true],
 ['crm_save_email_template','Save a reusable draft at its current revision; published versions and existing runs remain unchanged.',{...edit,name:z.string().trim().min(1).max(120),definition:emailDefinition},true],
 ['crm_publish_email_template','Publish the current draft for future enrollments, including enabled event connections. Existing runs retain their version.',edit,true],
 ['crm_archive_email_template','Archive a template to prevent new enrollment. Existing runs continue; stop them separately when intended.',edit,true],
 ['crm_duplicate_email_template','Copy a template into a new unpublished draft.',edit,true],
 ['crm_set_email_automation_settings','Set business reply-to, mailing address and a previously verified sender. Enabling allows eligible queued email to proceed through Resend; no DNS changes.',{...retry,revision:z.number().int().min(0).max(2147483647),enabled:z.boolean(),replyTo:z.string().email().max(320),mailingAddress:z.string().max(300),domainId:uuid.nullable()},true],
 ['crm_connect_email_template','Create or update an event connection. Form events require formId; other events require null. Enabling affects future events only. replaceLegacy explicitly supersedes overlapping legacy routing.',{...retry,id:uuid.optional(),revision:revision.optional(),templateId:uuid,event:z.enum(['form.submitted','contact.opted_in','booking.confirmed','booking.changed','booking.cancelled']),formId:uuid.nullable(),enabled:z.boolean(),replaceLegacy:z.boolean()},true],
 ['crm_set_email_template_form_consent','Offer or remove separate email consent on a business form, preserving SMS and collection. No backfill.',{...retry,formId:uuid,revision,enabled:z.boolean()},true],
 ['crm_record_email_marketing_consent','Record explicit consent or withdrawal for the contact current email, with evidence. A new opt-in may start enabled contact.opted_in sequences. Never infer consent.',{...retry,contactId:uuid,contactRevision:revision,consent:z.boolean(),evidence:z.string().min(1).max(2000)},true],
 ['crm_start_email_template_run','Start one eligible contact on a published marketing sequence. Requires current consent and verified activation. Can schedule real email; no bulk enrollment.',{...retry,templateId:uuid,contactId:uuid,contactRevision:revision,request:z.string().max(1600).default('')},true],
 ...['pause','resume','stop','retry'].map(action=>['crm_'+action+'_email_template_run',action+' one reusable email run at its current revision and generation. Resume/retry recheck eligibility and may schedule real email; stop cannot recall an in-flight provider submission.',run,true]),
];
export const emailAutomationToolPermissions=Object.fromEntries(emailAutomationTools.map(([n])=>[n,n.includes('workspace')||n.includes('preview')?'email_automation_read':n.includes('publish')?'email_automation_publish':n.includes('settings')?'email_automation_settings':n.includes('connect')||n.includes('form_consent')?'email_automation_connect':n.includes('marketing_consent')?'email_automation_consent':n.includes('start_')?'email_automation_start':n.includes('_run')?'email_automation_control':'email_automation_edit']));
const row=z.record(z.unknown());
const receipt=z.object({businessId,databaseStatus:z.literal('committed'),id:uuid.nullable(),revision:revision.nullable(),generation:revision.nullable(),status:z.string().nullable()}).strict();
export const emailAutomationOutputs={...Object.fromEntries(emailAutomationTools.filter(t=>t[3]).map(([n])=>[n,receipt])),
 crm_get_email_automation_workspace:z.object({settings:row,sender:row.nullable(),domains:z.array(row),templates:z.array(row).max(100),connections:z.array(row).max(100),forms:z.array(row).max(100),contacts:z.array(row).max(100),runs:z.array(row).max(25),jobs:z.array(row).max(25),page:z.number().int()}).strict(),
 crm_preview_email_template:z.object({definition:emailDefinition,schedule:z.array(z.object({step:z.number().int(),dueAt:z.string().nullable()}).strict()).max(30),queued:z.literal(false)}).strict(),
};
