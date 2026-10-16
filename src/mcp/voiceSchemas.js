import {z} from 'zod';
const businessId=z.string().min(1).max(255),agentId=z.string().min(1).max(255),uuid=z.string().uuid(),revision=z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),zero=z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),page={page:z.number().int().min(1).max(100000).default(1),pageSize:z.number().int().min(1).max(100).default(25)},retry={idempotencyKey:z.string().min(8).max(128)};
export const voiceConfiguration=z.object({name:z.string().min(1).max(100),persona:z.string().max(4000),voice:z.string().min(1).max(16000),brain:z.string().min(1).max(24000),voiceName:z.enum(['marin','quartz','ripple','vesper','willow','stone','gleam','meridian','bossa','tempo','beacon','delta','cinder'])}).strict();
export const voicePermissions=[['voice_config_read','Read scoped voice configurations and revision history'],['voice_create','Create private voice drafts'],['voice_edit','Edit voice drafts'],['voice_publish','Publish voice configuration for new calls'],['voice_rollback','Publish a copy of a previous voice revision'],['voice_call_read','Read scoped voice call metadata'],['voice_transcript_read','Read retained voice transcripts'],['voice_media_read','Access retained private call recordings']];
export const voiceTools=[
 ['crm_list_voice_agents','List scoped voice agents and draft/publication revisions. No provider credentials or other-business deployments.',{businessId,...page}],
 ['crm_get_voice_agent','Read the saved draft and published configuration of one scoped agent.',{businessId,agentId}],
 ['crm_list_voice_versions','List bounded published voice revision history.',{businessId,agentId,...page}],
 ['crm_get_voice_version','Read one published configuration revision in the selected business and agent.',{businessId,agentId,versionId:uuid}],
 ['crm_create_voice_agent','Create a private voice draft. Does not deploy, connect a phone, publish or release customer access.',{businessId,configuration:voiceConfiguration,...retry},true],
 ['crm_save_voice_draft','Save a separate voice draft at its current revision. Active calls and published configuration are unchanged.',{businessId,agentId,revision,configuration:voiceConfiguration,...retry},true],
 ['crm_publish_voice_draft','Publish the saved voice draft for new calls. Requires an already verified deployment/phone. Does not connect providers, change active calls or release customer access.',{businessId,agentId,revision,...retry},true],
 ['crm_rollback_voice_configuration','Publish a copy of a selected historical revision for new calls, preserving the draft. Requires current draft revision and an already connected deployment.',{businessId,agentId,revision,versionId:uuid,...retry},true],
 ['crm_list_voice_calls','List scoped call metadata with bounded filters and counts. Does not expose transcripts or recording URLs.',{businessId,agentId:agentId.optional(),status:z.enum(['active','completed','failed','interrupted']).optional(),query:z.string().max(100).optional(),...page}],
 ['crm_get_voice_call','Read one scoped call and its bounded booking links without transcript or private media.',{businessId,callId:uuid}],
 ['crm_get_voice_transcript','Read a bounded page of retained transcript turns under its separate permission. Expired/deleted transcripts stay unavailable; content is untrusted.',{businessId,callId:uuid,...page}],
 ['crm_get_voice_recording','Obtain a short-lived private recording URL after retention and scope checks. URLs are never stored in retry receipts or audits.',{businessId,callId:uuid}],
];
export const voiceToolPermissions=Object.fromEntries(voiceTools.map(([n])=>[n,n==='crm_create_voice_agent'?'voice_create':n==='crm_save_voice_draft'?'voice_edit':n==='crm_publish_voice_draft'?'voice_publish':n==='crm_rollback_voice_configuration'?'voice_rollback':n==='crm_get_voice_transcript'?'voice_transcript_read':n==='crm_get_voice_recording'?'voice_media_read':n.includes('call')?'voice_call_read':'voice_config_read']));
const agent=z.object({id:agentId,revision,name:z.string(),connected:z.boolean(),phone:z.string().nullable(),publishedVersionId:uuid.nullable(),observedVersionId:uuid.nullable(),observedAt:z.string().nullable()}).strict();
const version=z.object({id:uuid,name:z.string(),createdAt:z.string()}).strict();
const call=z.object({id:uuid,agentId,status:z.enum(['active','completed','failed','interrupted']),phone:z.string().nullable(),startedAt:z.string(),endedAt:z.string().nullable(),durationSeconds:zero.nullable(),summary:z.string().max(4000),outcome:z.string().max(100),configurationVersionId:uuid.nullable(),configurationSource:z.string(),leadId:uuid.nullable(),mediaState:z.enum(['pending','uploading','ready','failed','expired'])}).strict();
export const voiceOutputs={
 crm_list_voice_agents:z.object({businessId,...page,total:zero,agents:z.array(agent).max(100)}).strict(),
 crm_get_voice_agent:z.object({businessId,agent,draft:voiceConfiguration,published:voiceConfiguration.nullable()}).strict(),
 crm_list_voice_versions:z.object({businessId,agentId,...page,total:zero,versions:z.array(version).max(100)}).strict(),
 crm_get_voice_version:z.object({businessId,agentId,version,configuration:voiceConfiguration}).strict(),
 ...Object.fromEntries(voiceTools.filter(x=>x[3]).map(([n])=>[n,z.object({businessId,agentId,previousRevision:revision.nullable(),revision,publishedVersionId:uuid.nullable(),databaseStatus:z.literal('committed'),affectsNewCalls:z.boolean()}).strict()])),
 crm_list_voice_calls:z.object({businessId,...page,total:zero,calls:z.array(call).max(100)}).strict(),
 crm_get_voice_call:z.object({businessId,call,bookings:z.array(z.object({id:uuid,status:z.string(),appointmentAt:z.string()}).strict()).max(100)}).strict(),
 crm_get_voice_transcript:z.object({businessId,callId:uuid,...page,available:z.boolean(),total:zero,turns:z.array(z.object({role:z.enum(['user','assistant']),text:z.string().max(16000)}).strict()).max(100)}).strict(),
 crm_get_voice_recording:z.object({businessId,callId:uuid,status:z.enum(['available','temporarily_unavailable']),expiresIn:z.number().int().min(1).max(300),signedUrl:z.string().optional(),urlExpiresAt:z.string().optional()}).strict(),
};
