import {z} from 'zod';
// Email campaigns and saved segments. Same canonical workflow as the CRM Campaigns
// page (sms_private.email_campaign_apply); consent, unsubscribe and provider
// suppression are enforced by the database for every message.
const uuid=z.string().uuid(), revision=z.number().int().min(1).max(2147483647);
const businessId=z.string().min(1).max(255),base={businessId},retry={...base,idempotencyKey:uuid},edit={...retry,id:uuid,revision};
const rule=z.discriminatedUnion('field',[
 z.object({field:z.literal('source'),value:z.string().trim().min(1).max(60)}).strict(),
 z.object({field:z.literal('createdWithinDays'),value:z.number().int().min(1).max(3650)}).strict(),
 z.object({field:z.literal('createdOlderThanDays'),value:z.number().int().min(1).max(3650)}).strict(),
 z.object({field:z.literal('emailDomain'),value:z.string().regex(/^[A-Za-z0-9.-]{1,253}$/)}).strict(),
]);
export const segmentDefinition=z.object({match:z.enum(['all','any']),rules:z.array(rule).max(20)}).strict();
export const emailCampaignPermissions=[
 ['email_campaign_read','Read email campaigns, saved segments and reports, including recipient email addresses'],
 ['email_campaign_edit','Create and edit saved segments and draft email campaigns'],
 ['email_campaign_send','Start or resume an email campaign; sends real email to opted-in contacts'],
 ['email_campaign_control','Pause or cancel email campaigns'],
];
export const emailCampaignTools=[
 ['crm_get_email_campaign_workspace','Read saved segments, up to 50 campaigns with aggregate delivery counts, publishable marketing templates, contact sources and sender readiness. No recipient list.',base],
 ['crm_get_email_campaign','Read one campaign report: delivery, open and click counts, skip reasons, top links and a page of 100 recipients with their email addresses and delivery state.',{...base,campaignId:uuid,page:z.number().int().min(1).max(10000).default(1)}],
 ['crm_preview_email_segment','Count contacts a saved or unsaved segment matches, how many can receive marketing email, why the rest are skipped, and a sample of up to 10 eligible addresses. Pass exactly one of segmentId or definition. Never sends.',{...base,segmentId:uuid.optional(),definition:segmentDefinition.optional()}],
 ['crm_preview_email_campaign','Check a campaign\'s current recipients and skip reasons before starting it. Never sends.',{...base,id:uuid}],
 ['crm_save_email_segment','Create a saved segment, or update one at its current revision (pass id and revision together). Rules are data, never SQL. Consent is always checked separately.',{...retry,id:uuid.optional(),revision:revision.optional(),name:z.string().trim().min(1).max(120),definition:segmentDefinition},true],
 ['crm_archive_email_segment','Archive a saved segment. Refused while a draft, scheduled or paused campaign uses it.',edit,true],
 ['crm_save_email_campaign','Create a draft campaign, or edit a draft at its current revision (pass id and revision together). Templates must be published marketing templates with event timing. Saving never sends.',{...retry,id:uuid.optional(),revision:revision.optional(),name:z.string().trim().min(1).max(120),templateId:uuid.nullable().optional(),segmentId:uuid.nullable().optional(),scheduledAt:z.string().datetime({offset:true}).nullable().optional()},true],
 ['crm_start_email_campaign','Start a draft campaign: snapshot the segment (up to 50,000), skip addresses without consent or that are unsubscribed or suppressed, and queue real email now or at its scheduled time. Requires business email sending to be enabled with a verified sender.',edit,true],
 ['crm_pause_email_campaign','Pause a scheduled or sending campaign. A batch already submitted to the provider can still be delivered.',edit,true],
 ['crm_resume_email_campaign','Resume a paused campaign. Every remaining message is re-checked for consent and suppression; this can send real email.',edit,true],
 ['crm_cancel_email_campaign','Cancel a campaign, or discard a draft. Messages not yet sent are not sent; an in-flight provider submission cannot be recalled.',edit,true],
];
export const emailCampaignToolPermissions=Object.fromEntries(emailCampaignTools.map(([n])=>[n,
 n.startsWith('crm_get_')||n.startsWith('crm_preview_')?'email_campaign_read':n.includes('_start_')||n.includes('_resume_')?'email_campaign_send':n.includes('_pause_')||n.includes('_cancel_')?'email_campaign_control':'email_campaign_edit']));
const row=z.record(z.unknown());
const preview=z.object({total:z.number().int(),eligible:z.number().int(),skipped:z.record(z.number().int()),sample:z.array(z.object({name:z.string().nullable(),email:z.string()}).strict()).max(10)}).strict();
const receipt=z.object({businessId,databaseStatus:z.literal('committed'),id:uuid,revision,status:z.string(),counts:row.nullable()}).strict();
export const emailCampaignOutputs={...Object.fromEntries(emailCampaignTools.filter(t=>t[3]).map(([n])=>[n,receipt])),
 crm_get_email_campaign_workspace:z.object({segments:z.array(row).max(100),campaigns:z.array(row).max(50),templates:z.array(row),sources:z.array(z.string()),sender:row.nullable()}).strict(),
 crm_get_email_campaign:z.object({campaign:row,links:z.array(z.object({url:z.string(),clicks:z.number().int()}).strict()).max(10),recipients:z.array(row).max(100)}).strict(),
 crm_preview_email_segment:preview,
 crm_preview_email_campaign:preview.extend({queued:z.literal(false)}),
};
