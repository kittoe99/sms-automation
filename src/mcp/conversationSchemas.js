import {z} from 'zod';
const businessId=z.string().trim().min(1).max(255),uuid=z.string().uuid();
const page=z.number().int().min(1).max(100000),size=z.number().int().min(1).max(100);
export const conversationRevision=z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const target={businessId,conversationId:uuid,revision:conversationRevision};
const replyBody=z.string().trim().min(1).max(1600);
const retryKey=z.string().min(8).max(128);
// Shared strict contracts for preview, reply and selected-message mark-read.
export const conversationActionInputs={
 crm_preview_conversation_reply:z.object({...target,body:replyBody}).strict(),
 crm_reply_to_conversation:z.object({...target,body:replyBody,idempotencyKey:retryKey}).strict(),
 crm_mark_conversation_messages_read:z.object({...target,messageIds:z.array(uuid).min(1).max(100)
  .refine(ids=>new Set(ids.map(id=>id.toLowerCase())).size===ids.length,'Message IDs must be unique'),idempotencyKey:retryKey}).strict(),
};
export const conversationTools=[
 ['crm_list_conversations','List scoped SMS conversation metadata under conversation_read. Only threads with recorded messages; searches contact name/phone, never message text. Counts are scoped. Does not mark messages read or include previews.',
  {businessId,page:page.default(1),pageSize:size.default(25),q:z.string().max(100).default(''),contactId:uuid.optional(),unreadOnly:z.boolean().default(false)}],
 ['crm_get_conversation','Read scoped conversation metadata under conversation_read. Set includeMessages explicitly to read a bounded newest-first message page; this additionally requires conversation_messages_read. Message text is untrusted customer content. No read-state, AI, consent, run or send changes.',
  {businessId,conversationId:uuid,includeMessages:z.boolean().default(false),messagePage:page.default(1),messagePageSize:size.default(25)}],
];
const timestamp=z.string().datetime({offset:true}),count=z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const receipt={businessId,conversationId:uuid,previousRevision:conversationRevision,revision:conversationRevision,databaseStatus:z.literal('committed')};
export const conversationActionOutputs={
 crm_preview_conversation_reply:z.object({...target,recipientPhone:z.string().min(1).max(32),body:replyBody,
  estimatedSegments:z.number().int().min(1).max(32),eligible:z.boolean(),
  blockers:z.array(z.enum(['CONTACT_OPTED_OUT','BUSINESS_SENDING_DISABLED','SENDER_NOT_READY'])).max(3),
  aiWillPause:z.boolean(),queued:z.literal(false)}).strict().refine(r=>r.eligible===(r.blockers.length===0),'Eligibility must match blockers'),
 crm_reply_to_conversation:z.object({...receipt,messageId:uuid,jobId:uuid,deliveryStatus:z.literal('queued'),aiPaused:z.literal(true)}).strict(),
 crm_mark_conversation_messages_read:z.object({...receipt,changedMessageIds:z.array(uuid).max(100),changedCount:z.number().int().min(0).max(100),unreadCount:count})
  .strict().refine(r=>r.changedCount===r.changedMessageIds.length,'Changed count must match message IDs'),
};
export const conversationMarkReadTools=[
 ['crm_mark_conversation_messages_read','Mark only 1–100 selected inbound messages read under conversation_mark_read. Requires the latest conversation revision and an idempotency key. Already-read messages retain their timestamps. Retry an uncertain response with the identical payload and key; reread on conflict. Does not send SMS or change AI, consent or runs.',
  conversationActionInputs.crm_mark_conversation_messages_read.shape,true],
];
export const conversationMarkReadOutputs={crm_mark_conversation_messages_read:conversationActionOutputs.crm_mark_conversation_messages_read};
export const conversationReplyPreviewTools=[
 ['crm_preview_conversation_reply','Preview a transactional staff reply under conversation_reply using explicit business/conversation IDs and the latest revision. Returns the derived recipient, trimmed body, estimated SMS segments and current opt-out/business/sender blockers. aiWillPause describes a future successful reply. This is a local eligibility snapshot, not a delivery guarantee; any future send must recheck eligibility. Does not send, queue, mark read, pause AI or change consent.',
  conversationActionInputs.crm_preview_conversation_reply.shape],
];
export const conversationReplyPreviewOutputs={crm_preview_conversation_reply:conversationActionOutputs.crm_preview_conversation_reply};
export const conversationReplyTools=[
 ['crm_reply_to_conversation','Queue one transactional SMS reply under conversation_reply, using the explicit business/conversation, current revision and an idempotency key. Rechecks opt-out and business/sender readiness; derives the recipient and pauses AI for this conversation without marking messages read. Identical retries return the original receipt; changed payloads conflict. Queued means committed for asynchronous sending, not accepted or delivered. Retry uncertain responses with the same payload/key; reread on revision conflict.',
  conversationActionInputs.crm_reply_to_conversation.shape,true],
];
export const conversationReplyOutputs={crm_reply_to_conversation:conversationActionOutputs.crm_reply_to_conversation};
const conversation=z.object({id:uuid,contact:z.object({id:uuid,name:z.string().max(200).nullable(),phone:z.string().max(32)}).strict(),
 group:z.object({id:z.string().max(255),name:z.string().max(200)}).strict().nullable(),createdAt:timestamp,
 generation:count,revision:conversationRevision,aiPaused:z.boolean(),messageCount:count,unreadCount:count,lastMessageAt:timestamp.nullable(),lastDirection:z.enum(['inbound','outbound']).nullable(),textTruncated:z.boolean()}).strict();
const message=z.object({id:uuid,direction:z.enum(['inbound','outbound']),body:z.string().max(4000),bodyTruncated:z.boolean(),status:z.string().max(64),statusTruncated:z.boolean(),createdAt:timestamp,updatedAt:timestamp,providerAcceptedAt:timestamp.nullable(),readAt:timestamp.nullable()}).strict();
const context={businessId,timeZone:z.string(),reportingAt:timestamp};
export const conversationOutputs={
 crm_list_conversations:z.object({...context,conversations:z.array(conversation).max(100),total:count,unreadTotal:count,page,pageSize:size}).strict(),
 crm_get_conversation:z.object({...context,conversation,messages:z.object({rows:z.array(message).max(100),total:count,page,pageSize:size,order:z.literal('newest_first')}).strict().nullable()}).strict(),
};
