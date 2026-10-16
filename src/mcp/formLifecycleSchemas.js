import {z} from 'zod';
import {smsSequenceSchema} from './smsSchemas.js';
const uuid=z.string().uuid(),businessId=z.string().min(1).max(255),revision=z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),zero=revision.or(z.literal(0));
const retry={idempotencyKey:z.string().min(8).max(128)},form={businessId,formId:uuid,revision,draftRevision:zero};
const page={page:z.number().int().min(1).max(100000).default(1),pageSize:z.number().int().min(1).max(100).default(25)};
export const formLifecyclePermissions=[['form_duplicate','Duplicate an applied form into inactive collection'],['form_archive','Archive forms and stop associated follow-ups'],['form_restore','Restore forms with collection disabled'],['automation_archive','Archive direct SMS templates'],['automation_preset_read','Read saved SMS sequence presets'],['automation_preset_save','Save an existing form SMS draft as a preset']];
export const formLifecycleTools=[
 ['crm_duplicate_form','Copy the applied form and saved SMS draft into a new inactive form. Requires current form, draft and automation revisions. Copies no submissions or runs; does not publish or enable anything.',{...form,automationRevision:zero,...retry},true],
 ['crm_archive_form','Archive the explicit form, disable collection/follow-ups, stop its active/paused SMS runs and cancel active/paused email enrollments. Requires current revisions. Previously submitted provider work may still deliver.',{...form,...retry},true],
 ['crm_restore_form','Restore an archived form with collection disabled. Does not enable follow-ups or resume stopped/cancelled work.',{...form,...retry},true],
 ['crm_archive_sms_template','Archive an existing direct-contact SMS template using its revision. Existing runs retain their saved sequence and are not stopped by this operation.',{businessId,automationId:uuid,revision,...retry},true],
 ['crm_list_sms_presets','List a bounded page of immutable saved form SMS preset metadata within one business.',{businessId,...page}],
 ['crm_get_sms_preset','Read one immutable saved form SMS preset. Applying it still requires a separate draft edit and validation against the target form.',{businessId,presetId:uuid}],
 ['crm_save_sms_preset','Save the reviewed existing form SMS draft as a new immutable preset. Requires current form and automation revisions; does not edit, publish or enable the source.',{businessId,formId:uuid,revision,automationRevision:revision,name:z.string().trim().min(1).max(100),...retry},true],
];
export const formLifecycleToolPermissions=Object.fromEntries(formLifecycleTools.map(([n])=>[n,({crm_duplicate_form:'form_duplicate',crm_archive_form:'form_archive',crm_restore_form:'form_restore',crm_archive_sms_template:'automation_archive',crm_list_sms_presets:'automation_preset_read',crm_get_sms_preset:'automation_preset_read',crm_save_sms_preset:'automation_preset_save'})[n]]));
const receipt={businessId,databaseStatus:z.literal('committed')};
const metadata=z.object({id:uuid,name:z.string(),createdAt:z.string(),revision:z.literal(1)}).strict();
const state=z.object({...receipt,formId:uuid,previousRevision:revision.nullable(),revision,draftRevision:zero,collectionEnabled:z.literal(false),archived:z.boolean(),stoppedSmsRuns:zero,cancelledEmailEnrollments:zero,inFlightMayDeliver:z.boolean()}).strict();
export const formLifecycleOutputs={crm_duplicate_form:state,crm_archive_form:state,crm_restore_form:state,
 crm_archive_sms_template:z.object({...receipt,automationId:uuid,previousRevision:revision,revision,archived:z.literal(true),existingRunsChanged:z.literal(false)}).strict(),
 crm_list_sms_presets:z.object({businessId,presets:z.array(metadata).max(100),total:zero,...page}).strict(),
 crm_get_sms_preset:z.object({businessId,preset:metadata.extend({sequence:smsSequenceSchema}).strict()}).strict(),
 crm_save_sms_preset:z.object({...receipt,presetId:uuid,revision:z.literal(1),formId:uuid,sourceRevision:revision,sourceAutomationRevision:revision}).strict(),
};
