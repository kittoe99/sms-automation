import {z} from 'zod';
const uuid=z.string().uuid(),revision=z.number().int().nonnegative(),count=revision;
const timestamp=z.string().datetime({offset:true});
export const enquiryStatusTools=[
 ['crm_get_enquiry_status','Read one scoped submission status under enquiry_status_read. SMS state, recorded response links, booking counts and handoff counts are independent facts, not sales stages. Zero linked outcomes does not prove none exist. No answers, contact details, message bodies, enrollment or sending.',
  {businessId:z.string().trim().min(1).max(255),formId:uuid,submissionId:uuid}],
];
export const enquiryStatusOutputs={
 crm_get_enquiry_status:z.object({businessId:z.string(),timeZone:z.string(),reportingAt:timestamp,
  enquiryStatus:z.object({submissionId:uuid,formId:uuid,preset:z.enum(['contacts','quote_requests','bookings']),submittedAt:timestamp,
   submittedFormVersion:revision.nullable(),requestedAppointmentAt:timestamp.nullable(),
   intake:z.object({state:z.enum(['pending','enrolled','skipped','waiting_confirmation','cancelled','unknown']),
    skipReason:z.enum(['OPTED_OUT','CONSENT_REQUIRED','RULE_UNAVAILABLE','INVALID_PHONE','FUTURE_APPOINTMENT_REQUIRED']).nullable()}).strict(),
   sms:z.object({source:z.enum(['form_run','legacy_enrollment','intake','none']),state:z.enum(['active','paused','completed','stopped','cancelled','skipped','received','unknown']),
    runId:uuid.nullable(),legacyEnrollmentId:uuid.nullable(),generation:revision.nullable(),publishedVersion:revision.nullable(),nextRunAt:timestamp.nullable()}).strict(),
   attribution:z.literal('recorded_links_only'),
   responses:z.object({linked:count}).strict(),
   bookings:z.object({linked:count,confirmed:count,cancelled:count,requested:count}).strict(),
   handoffs:z.object({linked:count,open:count,assigned:count,resolved:count,closed:count}).strict(),
  }).strict(),
 }).strict(),
};
