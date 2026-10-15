import {z} from 'zod';
import {smsAutomationSummary} from './smsSchemas.js';

const revision=z.number().int().nonnegative();
const target={businessId:z.string().min(1).max(255),automationId:z.string().uuid(),revision,idempotencyKey:z.string().min(8).max(128)};
export const smsReleaseTools=[
 ['crm_publish_sms_automation','Publish the saved draft at its current revision. Requires automation_publish. Form publication also requires formRevision. Preserves enabled state and existing run snapshots; enabled forms use the new version for future submissions. Does not accept replacement content or start runs.',{...target,kind:z.enum(['form','contact']),formRevision:revision.optional()},true],
 ['crm_set_form_followups_enabled','Enable or disable published form follow-ups using current sequence and form revisions. Requires automation_enable. Enabling requires an active collecting form and published rules; it does not start historical runs or resume paused runs. Disabling pauses active runs for this form.',{...target,formRevision:revision,enabled:z.boolean()},true],
];
const result=z.object({businessId:target.businessId,automation:smsAutomationSummary,databaseStatus:z.literal('committed'),
 effect:z.enum(['published_version_created','form_followups_enabled','form_followups_disabled'])}).strict();
export const smsReleaseOutputs={crm_publish_sms_automation:result,crm_set_form_followups_enabled:result};
