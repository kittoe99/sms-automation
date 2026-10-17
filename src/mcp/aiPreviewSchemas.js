import {z} from 'zod';
const revision=z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const aiPreviewPermissions=[['ai_reply_preview','Preview hypothetical AI replies using approved Business Info; calls the model but never sends']];
export const aiPreviewToolPermissions={crm_preview_ai_reply:'ai_reply_preview'};
export const aiPreviewTools=[['crm_preview_ai_reply','Generate a hypothetical reply using approved Business Info and current AI instructions. Calls the model; no customer history, supplementary knowledge, booking tools, CRM changes or SMS. Repeated calls may differ and incur model usage. Read current business and AI settings revisions first.',{
 businessId:z.string().trim().min(1).max(255),message:z.string().trim().min(1).max(4000),
 businessRevision:revision,settingsRevision:revision,profileVersionId:z.string().uuid(),
}]];
export const aiPreviewInput=z.object(aiPreviewTools[0][2]).strict();
export const aiPreviewOutputs={crm_preview_ai_reply:z.object({
 businessId:z.string(),businessRevision:revision,settingsRevision:revision,
 profileVersionId:z.string().uuid(),profileVersion:z.number().int().positive(),profileCapturedAt:z.string().datetime({offset:true}),
 profileVersionAvailability:z.literal('recorded'),reply:z.string().min(1).max(600),
 model:z.string(),promptVersion:z.literal('business-info-preview-v1'),previewOnly:z.literal(true),
 contextScope:z.literal('approved_business_info_only'),actionsExecuted:z.literal(false),messageQueued:z.literal(false),
}).strict()};
