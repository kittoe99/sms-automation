import {z} from 'zod';
const businessId=z.string().min(1).max(255),uuid=z.string().uuid(),revision=z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),page={page:z.number().int().min(1).max(100000).default(1),pageSize:z.number().int().min(1).max(100).default(25)},retry={idempotencyKey:z.string().min(8).max(128)},scope={businessId,siteId:uuid};
export const websiteDetails=z.object({businessName:z.string().max(160).optional(),description:z.string().max(1500).optional(),contactEmail:z.string().max(254).optional(),contactPhone:z.string().max(40).optional(),services:z.array(z.string().min(1).max(1500)).max(100).optional(),serviceAreas:z.array(z.string().min(1).max(1000)).max(100).optional()}).strict();
export const websitePermissions=[['website_read','Read scoped existing websites and publication status'],['website_deployment_read','Read existing website deployment metadata'],['website_details_edit','Edit website name and customer-visible details'],['website_form_read','Read scoped website form connections'],['website_form_connect','Connect an existing enabled business form'],['website_form_disable','Disable an existing website form connection'],['website_request_read','Read scoped website update requests'],['website_request_edit','Update website request status and staff response'],['website_publish','Publish an existing ready website deployment'],['website_unpublish','Unpublish an existing website']];
export const websiteTools=[
 ['crm_list_websites','List existing websites linked to the permitted business. No ownership or global directory access.',{businessId,...page}],
 ['crm_get_website','Read scoped website details and current revision.',scope],
 ['crm_get_website_publication','Inspect authoritative website publication through the E2 adapter; unavailable is distinct from unpublished.',scope],
 ['crm_list_website_deployments','List bounded deployment metadata without source uploads, manifests or preview credentials.',{...scope,...page}],
 ['crm_get_website_deployment','Read metadata for a deployment belonging to the scoped site.',{...scope,deploymentId:uuid}],
 ['crm_update_website_details','Update an existing site name/details at its current revision, preserving ownership, business link, domain and publication.',{...scope,revision,name:z.string().min(1).max(100),details:websiteDetails,...retry},true],
 ['crm_list_website_form_connections','List scoped connections with form collection state. Connection state is separate from collection and follow-up activation.',{...scope,...page}],
 ['crm_connect_website_form','Connect an existing enabled form from the same business. Does not change collection, SMS follow-ups, website files or publication.',{...scope,revision,formId:uuid,formRevision:revision,...retry},true],
 ['crm_disable_website_form_connection','Disable only the selected existing connection using current connection/site revisions. Leaves the form and follow-up settings unchanged.',{...scope,revision,connectionId:uuid,connectionRevision:revision,...retry},true],
 ['crm_list_website_requests','List scoped customer website update requests.',{...scope,...page}],
 ['crm_get_website_request','Read a single request belonging to the scoped business/site.',{...scope,websiteRequestId:uuid}],
 ['crm_update_website_request','Update status and staff response at the current request revision. No email or SMS notification is sent.',{...scope,websiteRequestId:uuid,revision,status:z.enum(['received','in_progress','needs_info','completed']),response:z.string().max(2000),...retry},true],
 ['crm_publish_website','Publish an already ready deployment using current site/deployment revisions and durable operation identity. Unknown storage outcomes remain held for reconciliation; retries never blindly repeat publication.',{...scope,revision,deploymentId:uuid,deploymentRevision:revision,...retry},true],
 ['crm_unpublish_website','Unpublish the existing website using its current revision and durable hosting operation. Does not delete files or change customer service visibility.',{...scope,revision,...retry},true],
 ['crm_get_website_operation','Read the status of this connection’s website publication operation, without retrying external work.',{...scope,operationId:uuid}],
];
export const websiteToolPermissions=Object.fromEntries(websiteTools.map(([n])=>[n,n.includes('deployment')?'website_deployment_read':n==='crm_update_website_details'?'website_details_edit':n==='crm_list_website_form_connections'?'website_form_read':n==='crm_connect_website_form'?'website_form_connect':n==='crm_disable_website_form_connection'?'website_form_disable':n==='crm_update_website_request'?'website_request_edit':n==='crm_list_website_requests'||n==='crm_get_website_request'?'website_request_read':n==='crm_publish_website'?'website_publish':n==='crm_unpublish_website'?'website_unpublish':'website_read']));
const site=z.object({id:uuid,revision,name:z.string(),slug:z.string(),details:websiteDetails,createdAt:z.string(),detailsUpdatedAt:z.string().nullable()}).strict();
const deployment=z.object({id:uuid,revision,mode:z.string(),status:z.string(),sourceBytes:revision,createdAt:z.string(),builtAt:z.string().nullable()}).strict();
const connection=z.object({id:uuid,revision,formId:uuid,formRevision:revision,title:z.string(),enabled:z.boolean(),collectionEnabled:z.boolean()}).strict();
const request=z.object({id:uuid,revision,title:z.string(),category:z.string(),page:z.string(),description:z.string(),status:z.string(),response:z.string(),createdAt:z.string(),updatedAt:z.string()}).strict();
export const websiteOperation=z.object({id:uuid,state:z.enum(['pending','executing','completed','failed','attention']),kind:z.enum(['publish','unpublish']),siteRevision:revision,resultingRevision:revision.nullable(),deploymentId:uuid.nullable(),createdAt:z.string(),finishedAt:z.string().nullable()}).strict();
const receipt={...scope,previousRevision:revision,revision,databaseStatus:z.literal('committed')};
export const websiteOutputs={
 crm_list_websites:z.object({businessId,...page,total:revision,sites:z.array(site).max(100)}).strict(),crm_get_website:z.object({...scope,site}).strict(),
 crm_get_website_publication:z.object({...scope,status:z.enum(['published','unpublished','unavailable']),deploymentId:uuid.nullable(),checkedAt:z.string().nullable()}).strict(),
 crm_list_website_deployments:z.object({...scope,...page,total:revision,deployments:z.array(deployment).max(100)}).strict(),crm_get_website_deployment:z.object({...scope,deployment}).strict(),
 crm_update_website_details:z.object(receipt).strict(),
 crm_list_website_form_connections:z.object({...scope,...page,total:revision,connections:z.array(connection).max(100)}).strict(),
 crm_connect_website_form:z.object({...receipt,connectionId:uuid,connectionRevision:revision,formId:uuid}).strict(),crm_disable_website_form_connection:z.object({...receipt,connectionId:uuid,connectionRevision:revision,enabled:z.literal(false)}).strict(),
 crm_list_website_requests:z.object({...scope,...page,total:revision,requests:z.array(request).max(100)}).strict(),crm_get_website_request:z.object({...scope,request}).strict(),crm_update_website_request:z.object({...receipt,websiteRequestId:uuid,status:z.string()}).strict(),
 crm_publish_website:z.object({...receipt,operation:websiteOperation,providerWork:z.enum(['queued','completed','attention','failed'])}).strict(),crm_unpublish_website:z.object({...receipt,operation:websiteOperation,providerWork:z.enum(['queued','completed','attention','failed'])}).strict(),
 crm_get_website_operation:z.object({...scope,operation:websiteOperation}).strict(),
};
