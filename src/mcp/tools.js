import {aiDiagnosticsTools,aiDiagnosticsOutputs} from './aiDiagnosticsSchemas.js';
import {operationsTools,operationsOutputs} from './operationsSchemas.js';
import {websiteTools,websiteOutputs} from './websiteSchemas.js';
import {voiceTools,voiceOutputs} from './voiceSchemas.js';
import {emailTools,emailOutputs} from './emailSchemas.js';
import {knowledgeTools,knowledgeOutputs} from './knowledgeSchemas.js';
import {bookingTools,bookingOutputs} from './bookingSchemas.js';
import {formLifecycleTools,formLifecycleOutputs} from './formLifecycleSchemas.js';
import {z} from 'zod';
import {externalTools} from './toolPolicy.js';
import {contactTools,contactOutputs} from './contactSchemas.js';
import {activityTools,activityOutputs} from './activitySchemas.js';
import {conversationTools,conversationOutputs,conversationMarkReadTools,conversationMarkReadOutputs,conversationReplyPreviewTools,conversationReplyPreviewOutputs,conversationReplyTools,conversationReplyOutputs} from './conversationSchemas.js';
import {leadHandoffTools,leadHandoffOutputs,leadHandoffWriteTools,leadHandoffWriteOutputs} from './leadHandoffSchemas.js';
import {enquiryReadTools,enquiryReadOutputs} from './enquirySchemas.js';
import {enquiryStatusTools,enquiryStatusOutputs} from './enquiryStatusSchemas.js';
import {connectionPermissionNames} from '../../public/mcpPermissions.js';
import {smsReadTools,smsReadOutputs} from './smsSchemas.js';
import {smsDraftTools,smsDraftOutputs} from './smsDraftSchemas.js';
import {smsReleaseTools,smsReleaseOutputs} from './smsReleaseSchemas.js';
import {smsRunTools,smsRunOutputs} from './smsRunSchemas.js';
import {smsActivityTools,smsActivityOutputs} from './smsActivitySchemas.js';
import {formReadTools,formReadOutputs,formDraftTools,formDraftOutputs,formPreviewTools,formPreviewOutputs,formApplyTools,formApplyOutputs,formCollectionTools,formCollectionOutputs} from './formSchemas.js';
import {formPreviewResource} from './formPreview.js';
import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';

const id=z.string().min(1).max(255), uuid=z.string().uuid();
const page={page:z.number().int().min(1).max(100000).default(1),pageSize:z.number().int().min(1).max(100).default(25)};
const business={businessId:id};
const write={...business,idempotencyKey:z.string().min(8).max(128)};
const profile={...write,revision:z.number().int().nonnegative(),profile:z.record(z.unknown())};
export const toolDefinitions=[
 ...aiDiagnosticsTools,
 ...operationsTools,...websiteTools,...voiceTools,...activityTools,...formLifecycleTools,...emailTools,
 ...knowledgeTools,
 ...bookingTools,
 ...contactTools,
 ...conversationTools,
 ...conversationMarkReadTools,
 ...conversationReplyPreviewTools,
 ...conversationReplyTools,
 ...leadHandoffTools,
 ...leadHandoffWriteTools,
 ...enquiryReadTools,
 ...enquiryStatusTools,
 ...formReadTools,
 ...formDraftTools,
 ...formPreviewTools,
 ...formApplyTools,
 ...formCollectionTools,
 ...smsReadTools,
 ...smsDraftTools,
 ...smsReleaseTools,
 ...smsRunTools,
 ...smsActivityTools,
 ['crm_get_access','Read connection status, grants and permitted businesses. Pending connections have no CRM data access.',{}],
 ['crm_search_customers','Search customers associated with allowed businesses. Global lookup requires a separate administrator grant.',{...page,q:z.string().max(100).default('')}],
 ['crm_get_customer','Read a customer and only their permitted businesses.',{accountId:uuid}],
 ['crm_list_businesses','List permitted businesses, with bounded pagination.',{...page,q:z.string().max(100).default('')}],
 ['crm_get_business','Read permitted business facts, draft, review state, services and current revisions.',business],
 ['crm_save_business_profile_draft','Save a business draft without approving it. Use the latest revision; reuse the idempotency key after an uncertain response.',profile,true],
 ['crm_review_business_profile','Approve operational business facts using the latest revision. Does not release services or enable sending.',profile,true],
 ['crm_add_business_service','Add a service. SMS may queue provider setup; this does not enable sending or release customer access. Websites must already be linked.',{...write,kind:z.enum(['website','sms','enquiries','bookings','voice']),siteId:uuid.optional(),siteRevision:z.number().int().nonnegative().optional()},true],
 ['crm_set_service_visibility','Set customer service visibility. Does not publish websites or activate messaging.',{...write,serviceId:uuid,revision:z.number().int().nonnegative(),visibility:z.enum(['draft','live'])},true],
];
const revision=z.number().int().nonnegative(), facts=z.record(z.unknown());
const summary=z.object({id,name:z.string()});
const customer=z.object({id:uuid,name:z.string().nullable(),email:z.string().nullable(),status:z.string(),onboardingCompletedAt:z.string().nullable(),businesses:z.array(summary)});
const serviceFields={id:uuid,kind:z.enum(['website','sms','enquiries','bookings','voice']),visibility:z.enum(['draft','live']),revision};
const serviceRecord=z.object({...serviceFields,tenant_id:id,site_id:uuid.nullable(),released_by:uuid.nullable(),released_at:z.string().nullable(),created_at:z.string()});
const setupRecord=z.object({tenant_id:id,draft:facts,revision,reviewed_profile_id:uuid.nullable(),reviewed_by:uuid.nullable(),reviewed_at:z.string().nullable()});
const providerSetup=z.object({state:z.string(),jobs:z.array(z.object({id:uuid,status:z.string()}))}).nullable();
const mutation=record=>z.object({record,businessId:id,databaseStatus:z.literal('committed'),providerSetup});
const paging={total:z.number().int().nonnegative(),page:z.number().int().positive(),pageSize:z.number().int().min(1).max(100)};
export const toolOutputs={
 ...aiDiagnosticsOutputs,
 ...operationsOutputs,...websiteOutputs,
 ...voiceOutputs,
 ...activityOutputs,...formLifecycleOutputs,...emailOutputs,
 ...knowledgeOutputs,
 ...bookingOutputs,
 ...contactOutputs,
 ...conversationOutputs,
 ...conversationMarkReadOutputs,
 ...conversationReplyPreviewOutputs,
 ...conversationReplyOutputs,
 ...leadHandoffOutputs,
 ...leadHandoffWriteOutputs,
 ...enquiryReadOutputs,
 ...enquiryStatusOutputs,
 ...formReadOutputs,
 ...formDraftOutputs,
 ...formPreviewOutputs,
 ...formApplyOutputs,
 ...formCollectionOutputs,
 ...smsReadOutputs,
 ...smsDraftOutputs,
 ...smsReleaseOutputs,
 ...smsRunOutputs,
 ...smsActivityOutputs,
 crm_get_access:z.object({connectionId:uuid,status:z.enum(['pending','active','disabled','revoked']),permissions:z.array(z.enum(connectionPermissionNames)),businessScope:z.enum(['none','selected','all']),businesses:z.array(summary)}),
 crm_search_customers:z.object({customers:z.array(customer),...paging}),
 crm_get_customer:z.object({customer}),
 crm_list_businesses:z.object({businesses:z.array(summary.extend({timeZone:z.string()})),...paging}),
 crm_get_business:z.object({business:z.object({id,name:z.string(),timeZone:z.string(),setup:z.object({draft:facts,revision,reviewedProfileId:uuid.nullable(),reviewedAt:z.string().nullable()}).nullable(),approvedProfile:facts.nullable(),services:z.array(z.object({...serviceFields,siteId:uuid.nullable()}))})}),
 crm_save_business_profile_draft:mutation(setupRecord),
 crm_review_business_profile:mutation(setupRecord),
 crm_add_business_service:mutation(serviceRecord),
 crm_set_service_visibility:mutation(serviceRecord),
};
const resultShape={ok:z.boolean(),requestId:z.string().uuid(),error:z.object({code:z.enum(['VALIDATION_ERROR','PERMISSION_DENIED','CONFLICT','TEMPORARY_FAILURE']),message:z.string(),retryable:z.boolean()}).optional()};
export function createMcpServer({invoke,identity,requestId}) {
 const server=new McpServer({name:'e2-crm',version:'0.1.0'});
 for(const [name,description,inputSchema,writing=false] of toolDefinitions) {
  const schema=z.object(inputSchema).strict();
  const outputSchema={...resultShape,data:toolOutputs[name].optional()};
  server.registerTool(name,{description,inputSchema:schema,outputSchema,annotations:{readOnlyHint:!writing,destructiveHint:writing,idempotentHint:true,openWorldHint:externalTools.has(name)}},async input=>{
   const data=await invoke(identity,name,schema.parse(input),requestId);
   const result=z.object(outputSchema).parse({...data,requestId});
   const content=[{type:'text',text:JSON.stringify(result)}];
   if(name==='crm_preview_form'&&result.ok)content.push(formPreviewResource(result.data));
   return {content,structuredContent:result,...(!result.ok?{isError:true}:{})};
  });
 }
 return server;
}
