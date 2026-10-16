import {z} from 'zod';
const uuid=z.string().uuid(),businessId=z.string().min(1).max(255),revision=z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),count=z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const page={page:z.number().int().min(1).max(100000).default(1),pageSize:z.number().int().min(1).max(100).default(25)};
const retry={idempotencyKey:z.string().min(8).max(128)};
const conversation={businessId,conversationId:uuid,revision};
const run={businessId,runId:uuid,activityRevision:revision,generation:count};
const tagName=z.string().trim().min(1).max(40);
export const activityPermissions=[
 ['conversation_ai_pause','Pause AI for one conversation'],['conversation_ai_resume','Resume eligible conversation AI'],
 ['conversation_message_reassign','Reassign selected inbound messages'],['handoff_alert_retry','Retry eligible handoff alerts'],
 ['activity_report_read','Read scoped activity metrics and attribution metadata'],['activity_tag_manage','Create, edit and assign activity tags'],
 ['activity_attribution_update','Link existing same-customer bookings, responses and AI activity'],
];
export const activityTools=[
 ['crm_pause_conversation_ai','Pause AI for the explicit conversation at its current revision. Does not pause automation runs or mark messages read.',{...conversation,...retry},true],
 ['crm_resume_conversation_ai','Resume AI for the explicit conversation after revision and opt-out checks. Future inbound activity still requires business/AI readiness; does not enqueue a reply or resume automation runs.',{...conversation,...retry},true],
 ['crm_reassign_conversation_message','Move one inbound message to an existing same-contact conversation using both current revisions. Cancels stale related AI work and updates routing; never marks read or sends.',{...conversation,...retry,messageId:uuid,targetConversationId:uuid,targetRevision:revision},true],
 ['crm_retry_handoff_alert','Retry an eligible failed handoff alert with the current handoff revision. May queue an SMS staff alert; uncertain/already submitted outcomes must be reconciled, never blindly retried.',{businessId,handoffId:uuid,revision,...retry},true],
 ['crm_get_activity_report','Read scoped aggregate activity metrics, preserving accepted/delivered and enquiry/appointment/test distinctions. No message content or record changes.',{businessId,from:z.string().date(),to:z.string().date(),scope:z.enum(['enquiry','appointment','test','direct']).default('enquiry')}],
 ['crm_list_activity_tags','List bounded business activity tags, including their revisions.',{businessId,...page,includeArchived:z.boolean().default(false)}],
 ['crm_get_enquiry_attribution_context','Read a bounded page of same-customer attribution candidates without message content. Includes current run generation and activity revision; these are distinct from SMS lifecycle controls.',{businessId,runId:uuid,kind:z.enum(['bookings','responses','events','tags']),...page}],
 ['crm_create_activity_tag','Create an active business activity tag. Does not change runs or messaging.',{businessId,name:tagName,...retry},true],
 ['crm_update_activity_tag','Rename or archive an existing tag using its revision. Does not change SMS state.',{businessId,tagId:uuid,revision,name:tagName,archived:z.boolean(),...retry},true],
 ['crm_set_enquiry_tag','Assign or remove an active tag with current run/activity/tag revisions. Does not change SMS state.',{...run,tagId:uuid,tagRevision:revision,present:z.boolean(),...retry},true],
 ['crm_link_enquiry_booking','Attribute an existing same-business/customer booking to an enquiry. Requires current attribution and run revisions; does not create or cancel appointments.',{...run,bookingId:z.string().min(1).max(255),revision:count,...retry},true],
 ['crm_link_enquiry_response','Attribute an existing inbound response to the same-customer enquiry. Does not mark it read or change SMS state.',{...run,messageId:uuid,revision:count,...retry},true],
 ['crm_link_enquiry_activity','Attribute an existing AI activity event to the same-customer enquiry using current revisions. Does not execute AI or send.',{...run,eventId:z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),revision,...retry},true],
];
export const activityToolPermissions=Object.fromEntries(activityTools.map(([n])=>[n,n==='crm_pause_conversation_ai'?'conversation_ai_pause':n==='crm_resume_conversation_ai'?'conversation_ai_resume':n==='crm_reassign_conversation_message'?'conversation_message_reassign':n==='crm_retry_handoff_alert'?'handoff_alert_retry':n.startsWith('crm_link_')?'activity_attribution_update':['crm_create_activity_tag','crm_update_activity_tag','crm_set_enquiry_tag'].includes(n)?'activity_tag_manage':'activity_report_read']));
const receipt={businessId,databaseStatus:z.literal('committed')};
const control=z.object({...receipt,conversationId:uuid,previousRevision:revision,revision,aiPaused:z.boolean()}).strict();
const tag=z.object({id:uuid,name:tagName,archived:z.boolean(),revision}).strict();
const paging={total:count,...page};
const funnel=z.object({contacted:count,responded:count,booked:count,cancelled:count,responseRate:z.number().nullable(),conversionRate:z.number().nullable()}).strict();
export const activityOutputs={
 crm_pause_conversation_ai:control,crm_resume_conversation_ai:control,
 crm_reassign_conversation_message:z.object({...receipt,conversationId:uuid,previousRevision:revision,revision,targetConversationId:uuid,targetRevision:revision,messageId:uuid,changed:z.boolean()}).strict(),
 crm_retry_handoff_alert:z.object({...receipt,handoffId:uuid,previousRevision:revision,revision,jobId:uuid,deliveryStatus:z.literal('queued')}).strict(),
 crm_get_activity_report:z.object({businessId,timeZone:z.string(),reportingAt:z.string(),from:z.string(),to:z.string(),scope:z.string(),funnel,activity:z.object({accepted:count,delivered:count,responses:count,aiSent:count}).strict(),outcomes:z.object({linkedBookings:count,handoffs:count}).strict(),workload:z.object({active:count,quiet:count,paused:count,aiPaused:count,unresolvedHandoffs:count}).strict()}).strict(),
 crm_list_activity_tags:z.object({businessId,tags:z.array(tag).max(100),...paging}).strict(),
 crm_get_enquiry_attribution_context:z.object({...run,kind:z.enum(['bookings','responses','events','tags']),rows:z.array(z.object({id:z.string(),revision:count,linkedRunId:uuid.nullable(),label:z.string().max(100),present:z.boolean().nullable()}).strict()).max(100),...paging}).strict(),
 crm_create_activity_tag:z.object({...receipt,tagId:uuid,previousRevision:revision.nullable(),revision}).strict(),
 crm_update_activity_tag:z.object({...receipt,tagId:uuid,previousRevision:revision,revision}).strict(),
 ...Object.fromEntries(['crm_set_enquiry_tag','crm_link_enquiry_booking','crm_link_enquiry_response','crm_link_enquiry_activity'].map(n=>[n,z.object({...receipt,runId:uuid,generation:count,previousRevision:revision,revision,relatedRecord:z.object({kind:z.enum(['tag','booking','response','activity']),id:z.string(),previousRevision:count,revision:count}).strict()}).strict()])),
};
