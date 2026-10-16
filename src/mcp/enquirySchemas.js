import {z} from 'zod';

const businessId=z.string().trim().min(1).max(255),uuid=z.string().uuid();
const preset=z.enum(['contacts','quote_requests','bookings']);
const instant=z.string().datetime({offset:true});
const page={page:z.number().int().min(1).max(100000).default(1),pageSize:z.number().int().min(1).max(100).default(25)};
export const enquiryReadTools=[
 ['crm_list_enquiries','List saved form submissions in one explicit business. Requires enquiry_read. Includes retained inactive/archived form history; excludes answers, SMS state and outcomes. submittedFrom is inclusive and submittedBefore exclusive (ISO timestamps with timezone).',
  {businessId,...page,formId:uuid.optional(),preset:preset.optional(),submittedFrom:instant.optional(),submittedBefore:instant.optional()}],
 ['crm_get_enquiry','Read one saved form submission and historical answer labels. Requires enquiry_read. Recorded consent is not current sending eligibility; appointment time is a request, not a confirmed booking. No enrollment or sending.',
  {businessId,formId:uuid,submissionId:uuid}],
];
const summary=z.object({id:uuid,formId:uuid,formName:z.string(),preset,submittedAt:z.string(),name:z.string(),phone:z.string(),email:z.string().nullable()}).strict();
const context={businessId,timeZone:z.string(),reportingAt:z.string()};
const answer=z.object({key:z.string().max(200),label:z.string().max(500),value:z.union([z.string().max(4000),z.number(),z.boolean(),z.null()]),truncated:z.boolean()}).strict();
export const enquiryReadOutputs={
 crm_list_enquiries:z.object({...context,enquiries:z.array(summary).max(100),total:z.number().int().nonnegative(),page:z.number().int().positive(),pageSize:z.number().int().min(1).max(100)}).strict(),
 crm_get_enquiry:z.object({...context,enquiry:summary.extend({formRevision:z.number().int().nonnegative(),submittedFormVersion:z.number().int().nonnegative().nullable(),smsConsent:z.boolean().nullable(),emailConsent:z.boolean().nullable(),appointmentAt:z.string().nullable(),answers:z.array(answer).max(100),answersTruncated:z.boolean()}).strict()}).strict(),
};
