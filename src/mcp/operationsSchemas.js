import {z} from 'zod';
const businessId=z.string().min(1).max(255),uuid=z.string().uuid(),revision=z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),count=z.number().int().nonnegative(),page={page:z.number().int().min(1).max(100000).default(1),pageSize:z.number().int().min(1).max(100).default(25)},retry={idempotencyKey:z.string().min(8).max(128)},versions={revision,providerRevision:revision,registrationRevision:revision};
export const operationsPermissions=[['operations_read','Read scoped job diagnostics and provider operations'],['provider_read','Read assigned sender inventory and activation readiness'],['provider_refresh','Queue provider status refresh without setup or sends'],['provider_reconcile','Queue safe status-only provider reconciliation'],['operations_retry','Retry failed status-refresh jobs only'],['sending_activate','Activate an already verified SMS sender; queued eligible sends may proceed']];
export const operationsTools=[
 ['crm_get_operations_summary','Read business-scoped queue/status counts. Does not expose global worker infrastructure.',{businessId}],
 ['crm_list_operational_jobs','List bounded scoped job metadata, without payloads, credentials or message content.',{businessId,...page}],
 ['crm_get_operational_job','Read scoped job metadata and whether this tool can retry it. SMS/email sends and purchases cannot be retried here.',{businessId,jobId:uuid}],
 ['crm_list_provider_operations','List scoped provider operation metadata without private requests or provider responses.',{businessId,...page}],
 ['crm_get_provider_operation','Read one scoped provider operation and its revision.',{businessId,operationId:uuid}],
 ['crm_get_provider_readiness','Read current business/provider/registration revisions and activation blockers. No refresh, canary or activation is performed.',{businessId}],
 ['crm_get_provider_inventory','Read cached inventory assigned to this business, with last-check time. No parent-account or other-business resource discovery.',{businessId}],
 ['crm_refresh_provider_status','Queue the existing status-only provider check at current revisions. No purchases, registration submission, sender binding or SMS.',{businessId,...versions,...retry},true],
 ['crm_reconcile_provider_status','Queue safe status inspection of an uncertain refresh/registration submission. Purchase and sender-binding reconciliation remain in CRM.',{businessId,...versions,operationId:uuid,operationRevision:revision,...retry},true],
 ['crm_retry_operational_job','Retry a failed non-reconciliation provider status-refresh job using current job/operation/provider revisions. Never retries a send, purchase, or uncertain operation.',{businessId,...versions,jobId:uuid,jobRevision:revision,operationRevision:revision,...retry},true],
 ['crm_activate_sms_sending','Activate SMS sending only after the existing approved profile, sender, registration and delivered canary checks pass. May release already queued eligible sends; does not create or enroll contacts.',{businessId,...versions,...retry},true],
];
export const operationsToolPermissions=Object.fromEntries(operationsTools.map(([n])=>[n,n==='crm_activate_sms_sending'?'sending_activate':n==='crm_retry_operational_job'?'operations_retry':n==='crm_reconcile_provider_status'?'provider_reconcile':n==='crm_refresh_provider_status'?'provider_refresh':n==='crm_get_provider_readiness'||n==='crm_get_provider_inventory'?'provider_read':'operations_read']));
const job=z.object({id:uuid,revision,queue:z.string(),status:z.string(),attempts:count,availableAt:z.string(),createdAt:z.string(),updatedAt:z.string(),retryEligible:z.boolean()}).strict();
const operation=z.object({id:uuid,revision,provider:z.literal('twilio'),kind:z.string(),state:z.string(),createdAt:z.string(),updatedAt:z.string()}).strict();
const readVersions={revision,providerRevision:revision.nullable(),registrationRevision:revision.nullable()};
const receipt={businessId,previousRevision:revision,revision,providerRevision:revision,registrationRevision:revision,databaseStatus:z.literal('committed')};
export const operationsOutputs={
 crm_get_operations_summary:z.object({businessId,queues:z.array(z.object({queue:z.string(),status:z.string(),count}).strict())}).strict(),
 crm_list_operational_jobs:z.object({businessId,...page,total:count,jobs:z.array(job).max(100)}).strict(),crm_get_operational_job:z.object({businessId,job}).strict(),
 crm_list_provider_operations:z.object({businessId,...page,total:count,operations:z.array(operation).max(100)}).strict(),crm_get_provider_operation:z.object({businessId,operation}).strict(),
 crm_get_provider_readiness:z.object({businessId,...readVersions,ready:z.boolean(),reasons:z.array(z.string()),registrationState:z.string().nullable(),sendingEnabled:z.boolean()}).strict(),
 crm_get_provider_inventory:z.object({businessId,...readVersions,source:z.literal('saved_connection'),lastCheckedAt:z.string().nullable(),sender:z.object({phoneNumber:z.string().nullable(),phoneNumberSid:z.string().nullable(),messagingServiceSid:z.string().nullable(),senderType:z.string().nullable(),provisioningState:z.string(),registrationState:z.string().nullable()}).strict().nullable()}).strict(),
 crm_refresh_provider_status:z.object({...receipt,operationId:uuid,operationRevision:revision,jobId:uuid,jobRevision:revision,providerWork:z.literal('queued')}).strict(),
 crm_reconcile_provider_status:z.object({...receipt,operationId:uuid,operationRevision:revision,jobId:uuid,jobRevision:revision,providerWork:z.literal('queued')}).strict(),
 crm_retry_operational_job:z.object({...receipt,operationId:uuid,operationRevision:revision,jobId:uuid,jobRevision:revision,providerWork:z.literal('queued')}).strict(),
 crm_activate_sms_sending:z.object({...receipt,sendingEnabled:z.literal(true)}).strict(),
};
