import {z} from 'zod';
const businessId=z.string().trim().min(1).max(255),uuid=z.string().uuid();
const status=z.enum(['open','assigned','resolved','closed']);
const page={page:z.number().int().min(1).max(100000).default(1),pageSize:z.number().int().min(1).max(100).default(25)};
const filters={businessId,...page,status:status.optional(),contactId:uuid.optional(),q:z.string().max(100).default('')};
export const leadHandoffTools=[
 ['crm_list_leads','List existing leads in one business under lead_read. Owner is a text label, not a staff identity. No submission answers or SMS controls.',filters],
 ['crm_get_lead','Read one existing lead under lead_read, with its explicitly recorded enquiry reference if valid. No inferred sales stage or phone-based association. Returns the shared record revision.',{businessId,leadId:uuid}],
 ['crm_list_handoffs','List existing handoffs in one business under handoff_read. No lead contents, alert credentials or message bodies.',filters],
 ['crm_get_handoff','Read one existing handoff under handoff_read, with its explicitly recorded enquiry reference if valid. Does not retry alerts or change follow-ups. Returns the shared record revision.',{businessId,handoffId:uuid}],
];
const timestamp=z.string().datetime({offset:true});
const common={id:uuid,status,owner:z.string().max(200).nullable(),priority:z.enum(['low','normal','high','urgent']),
 createdAt:timestamp,updatedAt:timestamp,revision:z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
 contact:z.object({id:uuid,name:z.string().max(200).nullable(),phone:z.string().max(32)}).strict(),textTruncated:z.boolean()};
const lead=z.object({...common,summary:z.string().max(4000)}).strict();
const handoff=z.object({...common,reason:z.string().max(1000)}).strict();
const enquiry=z.object({runId:uuid,origin:z.enum(['form','direct']),formId:uuid.nullable(),submissionId:uuid.nullable()}).strict().nullable();
const context={businessId,timeZone:z.string(),reportingAt:timestamp};
const paging={total:z.number().int().nonnegative(),page:z.number().int().positive(),pageSize:z.number().int().min(1).max(100)};
export const leadHandoffOutputs={
 crm_list_leads:z.object({...context,...paging,leads:z.array(lead).max(100)}).strict(),
 crm_get_lead:z.object({...context,lead:lead.extend({enquiry}).strict()}).strict(),
 crm_list_handoffs:z.object({...context,...paging,handoffs:z.array(handoff).max(100)}).strict(),
 crm_get_handoff:z.object({...context,handoff:handoff.extend({enquiry}).strict()}).strict(),
};
const write={businessId,revision:z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),idempotencyKey:z.string().min(8).max(128)};
export const leadHandoffWriteTools=[
 ['crm_assign_lead','Set or clear a lead owner text label under lead_assign. Does not change status or establish staff identity. Requires the current revision; reuse the same idempotency key after an uncertain response.',{...write,leadId:uuid,owner:z.string().max(200).nullable()},true],
 ['crm_set_lead_status','Set lead status under lead_status_update. Preserves its owner and all SMS, booking and handoff state. Requires the current revision and an idempotency key.',{...write,leadId:uuid,status},true],
 ['crm_assign_handoff','Set or clear a handoff owner text label under handoff_assign. Does not change status, retry alerts or establish staff identity. Requires the current revision and an idempotency key.',{...write,handoffId:uuid,owner:z.string().max(200).nullable()},true],
 ['crm_set_handoff_status','Set handoff status under handoff_status_update. Preserves its owner and all lead, SMS and booking state. Does not retry alerts. Requires the current revision and an idempotency key.',{...write,handoffId:uuid,status},true],
];
const receipt=field=>z.object({businessId,databaseStatus:z.literal('committed'),
 record:z.object({id:uuid,revision:write.revision,updatedAt:timestamp}).strict(),
 previousRevision:write.revision,changedFields:z.array(z.literal(field)).max(1)}).strict();
export const leadHandoffWriteOutputs=Object.fromEntries(leadHandoffWriteTools.map(([name])=>[name,receipt(name.includes('assign')?'owner':'status')]));
