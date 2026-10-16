import {z} from 'zod';

const businessId=z.string().trim().min(1).max(255), uuid=z.string().uuid();
const revision=z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const formPresetSchema=z.enum(['contacts','quote_requests','bookings']);
const fieldBase={key:z.string().regex(/^[a-z][a-z0-9_]{0,39}$/),label:z.string().min(1).max(100),required:z.boolean()};
export const formFieldSchema=z.discriminatedUnion('type',[
 ...['text','textarea','checkbox','date'].map(type=>z.object({...fieldBase,type:z.literal(type)}).strict()),
 z.object({...fieldBase,type:z.literal('select'),options:z.array(z.string().min(1).max(100)).min(1).max(20)}).strict(),
]);
export const formDefinitionSchema=z.object({title:z.string().min(1).max(120),description:z.string().max(500),
 buttonLabel:z.string().min(1).max(80),fields:z.array(formFieldSchema).max(20)}).strict();
const paging={page:z.number().int().min(1).max(100000).default(1),pageSize:z.number().int().min(1).max(100).default(25)};
export const formReadTools=[
 ['crm_list_forms','List scoped form definitions and collection states. Requires form_read; excludes archived forms by default. Does not read submissions, enroll, or send.',
  {businessId,...paging,q:z.string().max(100).default(''),preset:formPresetSchema.optional(),collectionEnabled:z.boolean().optional(),includeArchived:z.boolean().default(false)}],
 ['crm_get_form','Read a scoped applied definition and separate draft with both revisions. Requires form_read. draftStale flags an applied definition changed since the draft was based on it. No submissions or SMS rules are returned.',{businessId,formId:uuid}],
];
export const formSummarySchema=z.object({id:uuid,preset:formPresetSchema,title:z.string().min(1).max(120),revision,
 collectionEnabled:z.boolean(),archived:z.boolean(),legacyForm:z.boolean(),emailConsentEnabled:z.boolean()}).strict();
const context={businessId,timeZone:z.string()};
export const formDetailSchema=formSummarySchema.extend({definition:formDefinitionSchema,
 draft:formDefinitionSchema.nullable(),draftRevision:revision.nullable(),draftBaseRevision:revision.nullable(),draftStale:z.boolean(),
 fixedFields:z.array(z.enum(['name','phone','email','appointment_at','sms_opt_in','email_opt_in'])).max(6)}).strict();
export const formReadOutputs={
 crm_list_forms:z.object({...context,forms:z.array(formSummarySchema).max(100),total:z.number().int().nonnegative(),
  page:z.number().int().min(1).max(100000),pageSize:z.number().int().min(1).max(100)}).strict(),
 crm_get_form:z.object({...context,form:formDetailSchema}).strict(),
};
const reserved=new Set(['name','phone','email','appointment_at','sms_opt_in','email_opt_in','consent_evidence']);
export const formDraftDefinitionSchema=formDefinitionSchema.superRefine((value,ctx)=>{
 const keys=new Set();
 if(!value.title.trim()||!value.buttonLabel.trim())ctx.addIssue({code:z.ZodIssueCode.custom,message:'Form title and button label cannot be blank'});
 for(const [i,field] of value.fields.entries()){
  if(reserved.has(field.key)||keys.has(field.key)||!field.label.trim())ctx.addIssue({code:z.ZodIssueCode.custom,path:['fields',i],message:'Use unique, nonreserved field keys and nonblank labels'});
  keys.add(field.key);
  if(field.type==='select'&&(field.options.some(x=>!x.trim())||new Set(field.options).size!==field.options.length))ctx.addIssue({code:z.ZodIssueCode.custom,path:['fields',i,'options'],message:'Use unique, nonblank options'});
 }
});
const write={businessId,idempotencyKey:z.string().min(8).max(128),definition:formDraftDefinitionSchema};
export const formDraftTools=[
 ['crm_create_form','Create an inactive form and its separate draft. Requires form_create. Does not activate collection, create SMS rules or send. Reuse the idempotency key after an uncertain response.',{...write,preset:formPresetSchema},true],
 ['crm_save_form_draft','Save a separate draft without changing the applied form or collection. Requires form_edit, current form revision and draftRevision (0 when absent). Stale bases conflict; reread, never automatically rebase. Reuse the idempotency key after an uncertain response.',{...write,formId:uuid,revision,draftRevision:revision},true],
];
const mutation=z.object({...context,form:formDetailSchema,databaseStatus:z.literal('committed')}).strict();
export const formDraftOutputs={crm_create_form:mutation,crm_save_form_draft:mutation};
export const formApplyTools=[
 ['crm_apply_form_draft','Explicitly apply the saved draft to the canonical form, preserving its current collection state. Requires form_publish, current applied/draft revisions and an idempotency key. Does not activate collection, publish SMS rules, enroll or send. Stale draft bases and incompatible SMS field references are rejected; never automatically overwrite newer changes.',
  {businessId,formId:uuid,revision:revision.min(1),draftRevision:revision.min(1),idempotencyKey:z.string().min(8).max(128)},true],
];
export const formApplyOutputs={crm_apply_form_draft:mutation.extend({previousRevision:revision.min(1),appliedDraftRevision:revision.min(1)}).strict()};
export const formCollectionTools=[
 ['crm_set_form_collection_enabled','Activate or deactivate collection using the applied definition. Requires form_activate, current form/draft revisions (draftRevision 0 when absent) and an idempotency key. Does not apply drafts, enable SMS follow-ups, resume runs or send. Activation rejects enabled follow-ups or active form SMS runs. Deactivation pauses active form SMS runs and cancels active or paused form email enrollments. Already in-flight SMS may still deliver. Fresh draft metadata advances; stale drafts remain stale.',
  {businessId,formId:uuid,revision:revision.min(1),draftRevision:revision,enabled:z.boolean(),idempotencyKey:z.string().min(8).max(128)},true],
];
export const formCollectionOutputs={crm_set_form_collection_enabled:mutation.extend({previousRevision:revision.min(1),
 effect:z.enum(['activated','deactivated','unchanged']),pausedSmsRuns:z.number().int().nonnegative(),cancelledEmailEnrollments:z.number().int().nonnegative(),
 deliveryStatus:z.literal('not_sent_by_this_operation'),inFlightMayDeliver:z.boolean()}).strict()};
export const formPreviewTools=[
 ['crm_preview_form','Preview a saved form draft without submitting, activating collection, or sending. Requires form_preview, explicit business/form IDs and current applied/draft revisions. Returns a display-only HTML resource and structured fields. Stale bases and archived forms are marked; preview does not establish publish readiness.',
  {businessId,formId:uuid,revision:revision.min(1),draftRevision:revision.min(1)}],
];
const consentChoice=z.object({text:z.string(),required:z.literal(false),checked:z.literal(false)}).strict();
export const formPreviewOutputs={
 crm_preview_form:z.object({...context,mode:z.literal('saved_draft'),submittable:z.literal(false),
  form:z.object({id:uuid,preset:formPresetSchema,revision,draftRevision:revision,draftBaseRevision:revision,
   draftStale:z.boolean(),collectionEnabled:z.boolean(),archived:z.boolean(),definition:formDefinitionSchema}).strict(),
  fixedFields:z.array(z.object({key:z.enum(['name','phone','email','appointment_at']),label:z.string(),
   type:z.enum(['text','tel','email','datetime-local']),required:z.literal(true)}).strict()).min(3).max(4),
  consent:z.object({sms:consentChoice,email:consentChoice.nullable()}).strict(),
  warnings:z.array(z.enum(['DRAFT_BASE_CHANGED','FORM_ARCHIVED'])).max(2),
 }).strict(),
};
