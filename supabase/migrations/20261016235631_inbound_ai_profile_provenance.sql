-- CRM-owned provenance for new inbound AI contexts/results only. No backfill.
-- Requires unified SMS context, AI diagnostics and the paired released baseline.
-- Does not change E2 profile ownership/review contracts or enable any sending.
create table sms_private.inbound_ai_profile_contexts (
 job_id uuid primary key references sms_private.jobs(id),
 tenant_id text not null,
 lease_token uuid not null,
 profile_version_id uuid,
 profile_version integer,
 profile_facts jsonb,
 captured_at timestamptz not null default clock_timestamp(),
 foreign key(tenant_id,profile_version_id) references public.sms_business_profile_versions(tenant_id,id),
 check ((profile_version_id is null and profile_version is null and profile_facts is null)
  or (profile_version_id is not null and profile_version is not null and profile_version > 0 and profile_facts is not null and jsonb_typeof(profile_facts)='object'))
);
create index inbound_ai_profile_contexts_profile on sms_private.inbound_ai_profile_contexts(tenant_id,profile_version_id);
alter table sms_private.inbound_ai_profile_contexts enable row level security;
revoke all on sms_private.inbound_ai_profile_contexts from public,anon,authenticated,service_role,sms_api,sms_ai,sms_webhook,sms_sender,sms_automation,crm_mcp;

alter table sms_private.inbound_ai_runs
 add column profile_version_id uuid,
 add column profile_version integer,
 add column profile_captured_at timestamptz,
 add constraint inbound_ai_runs_profile_fk foreign key(tenant_id,profile_version_id) references public.sms_business_profile_versions(tenant_id,id),
 add constraint inbound_ai_runs_profile_shape check (
  (profile_version_id is null and profile_version is null)
  or (profile_version_id is not null and profile_version is not null and profile_version > 0 and profile_captured_at is not null));
create index inbound_ai_runs_profile on sms_private.inbound_ai_runs(tenant_id,profile_version_id);

create or replace function sms_private.inbound_ai_context(jid uuid,token uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare j sms_private.jobs; result jsonb; captured sms_private.inbound_ai_profile_contexts; begin
 perform sms_private.coordination_job_lock(jid);
 j:=sms_private.lease(jid,token);
 if not sms_private.inbound_ai_eligible(j,exists(select from public.sms_handoffs where tenant_id=j.tenant_id and ai_job_id=jid)) then return null; end if;
 select jsonb_build_object('settings',to_jsonb(s),'business',jsonb_build_object('name',b.name,'timeZone',b.time_zone),
  '_profile',(select jsonb_build_object('id',v.id,'version',v.version,'facts',v.facts) from public.sms_business_profile_versions v where v.tenant_id=b.tenant_id and v.id=b.active_profile_version_id and v.status='approved'),
  'latestMessage',(select body from public.sms_messages where tenant_id=j.tenant_id and id=(j.payload->>'message_id')::uuid),
  'history',coalesce((select jsonb_agg(x order by x.occurred_at,x.id) from (
   select * from (
    (select m.id,m.direction,m.body,m.created_at,m.created_at as occurred_at
     from public.sms_messages m
     where m.tenant_id=j.tenant_id and m.contact_phone=j.payload->>'phone' and m.direction='inbound'
      and m.created_at <= (select created_at from public.sms_messages where tenant_id=j.tenant_id and id=(j.payload->>'message_id')::uuid)
     order by m.created_at desc,m.id desc limit 30)
    union all
    (select m.id,m.direction,m.body,m.created_at,m.provider_accepted_at as occurred_at
     from public.sms_messages m
     where m.tenant_id=j.tenant_id and m.contact_phone=j.payload->>'phone' and m.direction='outbound'
      and m.provider_accepted_at is not null
      and m.provider_accepted_at <= (select created_at from public.sms_messages where tenant_id=j.tenant_id and id=(j.payload->>'message_id')::uuid)
     order by m.provider_accepted_at desc,m.id desc limit 30)
   ) recent order by occurred_at desc,id desc limit 30)x),'[]'),
  'session',(select jsonb_build_object('draft',draft,'summary',summary,'awaitingConfirmation',hold_id is not null and summary_message_id is not null)
   from sms_private.inbound_ai_sessions where tenant_id=j.tenant_id and conversation_id=(j.payload->>'conversation_id')::uuid),
  'automation',sms_private.inbound_automation_context(j),
  'requests',coalesce((select jsonb_agg(x) from (select form_public_id,name,details,submitted_at from (
    select tenant_id,phone,form_public_id,name,details,submitted_at from public.sms_web_form_contact_submissions
    union all select tenant_id,phone,form_public_id,name,details,submitted_at from public.sms_web_form_quote_request_submissions
    union all select tenant_id,phone,form_public_id,name,details,submitted_at from public.sms_web_form_booking_submissions
   ) submissions where tenant_id=j.tenant_id and phone=j.payload->>'phone' order by submitted_at desc limit 3)x),'[]'),
  'services',coalesce((select jsonb_agg(jsonb_build_object('service',service,'timeZone',time_zone)) from public.sms_voice_service_rules where tenant_id=j.tenant_id and enabled),'[]'),
  'recoveredReply',(select a.result->>'customerReply' from sms_private.inbound_ai_actions a where a.job_id=jid and a.name in ('confirm_booking','request_staff_help','close_enquiry') order by a.created_at desc limit 1)) into result
 from public.sms_businesses b join sms_private.inbound_ai_settings s using(tenant_id) where b.tenant_id=j.tenant_id;
 -- Completed historical results must never acquire provenance on a later call.
 if result is null or exists(select from sms_private.inbound_ai_runs where job_id=jid) then
  return (result-'_profile')||jsonb_build_object('profile',result->'_profile'->'facts');
 end if;
 select * into captured from sms_private.inbound_ai_profile_contexts where job_id=jid and tenant_id=j.tenant_id;
 -- Repeat context reads in one lease return the same facts. A new attempt may
 -- load a newer version, except when recovering an already committed tool reply.
 if captured.job_id is null and result->>'recoveredReply' is not null then
  return (result-'_profile')||jsonb_build_object('profile',null);
 elsif captured.job_id is null or (captured.lease_token<>token and result->>'recoveredReply' is null) then
  insert into sms_private.inbound_ai_profile_contexts(job_id,tenant_id,lease_token,profile_version_id,profile_version,profile_facts)
  values(jid,j.tenant_id,token,(result->'_profile'->>'id')::uuid,(result->'_profile'->>'version')::integer,result->'_profile'->'facts')
  on conflict(job_id) do update set lease_token=excluded.lease_token,profile_version_id=excluded.profile_version_id,
   profile_version=excluded.profile_version,profile_facts=excluded.profile_facts,captured_at=clock_timestamp()
  where inbound_ai_profile_contexts.tenant_id=excluded.tenant_id
  returning * into captured;
 elsif captured.lease_token<>token then
  update sms_private.inbound_ai_profile_contexts set lease_token=token where job_id=jid and tenant_id=j.tenant_id returning * into captured;
 end if;
 return (result-'_profile')||jsonb_build_object('profile',captured.profile_facts,
  'profileVersionId',captured.profile_version_id,'profileVersion',captured.profile_version,'profileCapturedAt',captured.captured_at);
end $$;

-- Only server-captured context supplies provenance, never result JSON from a worker.
-- An old worker finishing without a context remains explicitly not recorded.
create function sms_private.attach_inbound_ai_profile() returns trigger
language plpgsql security definer set search_path='' as $$
declare captured sms_private.inbound_ai_profile_contexts;
begin
 select c.* into captured from sms_private.inbound_ai_profile_contexts c
 join sms_private.jobs j on j.id=c.job_id and j.tenant_id=c.tenant_id and j.lease_token=c.lease_token
 where c.job_id=new.job_id and c.tenant_id=new.tenant_id;
 new.profile_version_id:=captured.profile_version_id;
 new.profile_version:=captured.profile_version;
 new.profile_captured_at:=captured.captured_at;
 return new;
end $$;
create trigger inbound_ai_run_profile before insert on sms_private.inbound_ai_runs
 for each row execute function sms_private.attach_inbound_ai_profile();
revoke all on function sms_private.attach_inbound_ai_profile() from public,anon,authenticated,service_role,sms_api,sms_ai,sms_webhook,sms_sender,sms_automation,crm_mcp;

create function sms_private.mcp_ai_profile_projection(t text,vid uuid,v integer,captured timestamptz) returns jsonb
language sql stable set search_path='' as $$
 select case
 when captured is null then jsonb_build_object('profileVersionId',null,'profileVersion',null,'profileCapturedAt',null,'profileVersionAvailability','not_recorded')
 when vid is null then jsonb_build_object('profileVersionId',null,'profileVersion',null,'profileCapturedAt',captured,'profileVersionAvailability','no_approved_profile')
 when exists(select from public.sms_business_profile_versions where tenant_id=t and id=vid and version=v)
  then jsonb_build_object('profileVersionId',vid,'profileVersion',v,'profileCapturedAt',captured,'profileVersionAvailability','recorded')
 else jsonb_build_object('profileVersionId',null,'profileVersion',null,'profileCapturedAt',null,'profileVersionAvailability','not_recorded') end
$$;
revoke all on function sms_private.mcp_ai_profile_projection(text,uuid,integer,timestamptz) from public,anon,authenticated,service_role,sms_api,sms_ai,sms_webhook,sms_sender,sms_automation,crm_mcp;

create or replace function sms_private.mcp_ai_run_projection(j sms_private.jobs) returns jsonb
language sql stable set search_path='' as $$
 select jsonb_build_object('id',j.id,'conversationId',c.id,
 'status',case when j.status in ('queued','processing','retry','completed','failed','cancelled') then j.status else 'unknown' end,
 'attempts',j.attempts,'createdAt',j.created_at,'updatedAt',j.updated_at,'recordedAt',r.created_at,
 'mode',case when r.mode in ('live','shadow') then r.mode end,'resultRecorded',r.job_id is not null,'archived',j.archived_at is not null,
 'settingsRevision',sms_private.mcp_ai_metric(j.payload->'settings_revision'),
 'errorCode',sms_private.mcp_ai_error(coalesce(r.result->>'code',j.error_code)))
 || sms_private.mcp_ai_profile_projection(j.tenant_id,r.profile_version_id,r.profile_version,r.profile_captured_at)
 from (select 1) anchor
 left join public.sms_conversations c on c.tenant_id=j.tenant_id and c.id::text=j.payload->>'conversation_id' and c.phone=j.payload->>'phone'
 left join sms_private.inbound_ai_runs r on r.job_id=j.id and r.tenant_id=j.tenant_id
$$;
create or replace function sms_private.mcp_ai_reply_read(u text,t text,tool text,p jsonb,cid uuid) returns jsonb
language plpgsql security invoker set search_path='' as $$
#variable_conflict use_column
declare j sms_private.jobs; r sms_private.inbound_ai_runs; c public.sms_conversations; items jsonb; actions jsonb; delivery jsonb; content jsonb; inbound jsonb; outbound jsonb;
 total bigint; action_total bigint; message_total bigint; pg integer; sz integer; allowed_content boolean; summary jsonb;
begin
 perform sms_private.mcp_validate_input(tool,p);
 -- Defense in depth: this helper is private and reached through the audited gateway.
 if not exists(select from sms_private.mcp_connections mc where mc.id=cid and mc.account_id=sms_private.platform_actor(u)
  and sms_private.platform_staff(mc.account_id) and mc.status='active' and 'ai_reply_read'=any(mc.permissions)
  and (mc.all_businesses or t=any(mc.business_ids))) then raise exception 'AI diagnostics access denied' using errcode='42501';end if;
 allowed_content:=coalesce((p->>'includeContent')::boolean,false);
 if allowed_content and not exists(select from sms_private.mcp_connections where id=cid and 'ai_reply_content_read'=any(permissions)) then raise exception 'AI reply content is not granted' using errcode='42501';end if;
 if tool='crm_list_ai_reply_runs' then
  pg:=coalesce((p->>'page')::integer,1);sz:=coalesce((p->>'pageSize')::integer,25);
  if p ? 'conversationId' and not exists(select from public.sms_conversations where tenant_id=t and id=(p->>'conversationId')::uuid) then raise exception 'Conversation access denied' using errcode='42501';end if;
  select count(*) into total from sms_private.jobs q where q.tenant_id=t and q.queue='ai_reply_jobs' and q.payload->>'agent_version'='sms-agent-v1' and q.archived_at is null
   and (not p ? 'status' or (case when q.status in ('queued','processing','retry','completed','failed','cancelled') then q.status else 'unknown' end)=p->>'status')
   and (not p ? 'conversationId' or exists(select from public.sms_conversations cv where cv.tenant_id=t and cv.id::text=p->>'conversationId' and cv.id::text=q.payload->>'conversation_id' and cv.phone=q.payload->>'phone'));
  select coalesce(jsonb_agg(sms_private.mcp_ai_run_projection(q) order by q.created_at desc,q.id),'[]') into items from (
   select q.* from sms_private.jobs q where q.tenant_id=t and q.queue='ai_reply_jobs' and q.payload->>'agent_version'='sms-agent-v1' and q.archived_at is null
    and (not p ? 'status' or (case when q.status in ('queued','processing','retry','completed','failed','cancelled') then q.status else 'unknown' end)=p->>'status')
    and (not p ? 'conversationId' or exists(select from public.sms_conversations cv where cv.tenant_id=t and cv.id::text=p->>'conversationId' and cv.id::text=q.payload->>'conversation_id' and cv.phone=q.payload->>'phone'))
   order by q.created_at desc,q.id limit sz offset (pg-1)*sz) q;
  return jsonb_build_object('businessId',t,'reportingAt',statement_timestamp(),'page',pg,'pageSize',sz,'total',total,'runs',items);
 elsif tool<>'crm_get_ai_reply_run' then raise exception 'Unknown AI diagnostic tool' using errcode='22023';end if;
 select * into j from sms_private.jobs where tenant_id=t and id=(p->>'runId')::uuid and queue='ai_reply_jobs' and payload->>'agent_version'='sms-agent-v1';
 if j.id is null then raise exception 'AI run access denied' using errcode='42501';end if;
 select * into r from sms_private.inbound_ai_runs where job_id=j.id and tenant_id=t;
 select * into c from public.sms_conversations where tenant_id=t and id::text=j.payload->>'conversation_id' and phone=j.payload->>'phone';
 summary:=sms_private.mcp_ai_run_projection(j);
 select count(*) into action_total from sms_private.inbound_ai_actions where job_id=j.id;
 select coalesce(jsonb_agg(jsonb_build_object('name',case when a.name in ('lookup_bookings','check_availability','prepare_booking','confirm_booking','request_staff_help','close_enquiry') then a.name else 'unknown' end,
  'createdAt',a.created_at,'simulated',case when jsonb_typeof(a.result->'simulated')='boolean' then (a.result->>'simulated')::boolean when r.mode='shadow' then true when r.mode='live' then false end,
  'outcome',case when a.result->>'stale'='true' then 'stale' when a.result->>'handoff'='true' then 'handoff' when a.result->>'status' in ('confirmed','prepared','missing_fields','closed','unavailable') then a.result->>'status' else 'recorded' end) order by a.created_at,a.action_key),'[]') into actions
 from (select * from sms_private.inbound_ai_actions where job_id=j.id order by created_at,action_key limit 20) a;
 select count(*) into message_total from public.sms_messages m where m.tenant_id=t and m.direction='outbound' and m.meta->>'agent_version'='sms-agent-v1'
  and m.meta->>'agent_job_id'=j.id::text and m.conversation_id=c.id and m.contact_phone=c.phone and m.category_id is not distinct from c.group_id;
 select coalesce(jsonb_agg(jsonb_build_object('messageId',m.id,'status',case when m.status in ('queued','accepted','sent','delivered','failed','undelivered','cancelled','submission_unknown') then m.status else 'unknown' end,
  'providerAcceptedAt',m.provider_accepted_at,'updatedAt',m.updated_at) order by m.created_at,m.id),'[]'),
  case when allowed_content then coalesce(jsonb_agg(jsonb_build_object('messageId',m.id,'body',left(coalesce(m.body,''),4000),'truncated',length(coalesce(m.body,''))>4000) order by m.created_at,m.id),'[]') end
 into delivery,outbound from (select m.* from public.sms_messages m where m.tenant_id=t and m.direction='outbound' and m.meta->>'agent_version'='sms-agent-v1'
  and m.meta->>'agent_job_id'=j.id::text and m.conversation_id=c.id and m.contact_phone=c.phone and m.category_id is not distinct from c.group_id order by m.created_at,m.id limit 20) m;
 if allowed_content then
  select jsonb_build_object('messageId',m.id,'body',left(coalesce(m.body,''),4000),'truncated',length(coalesce(m.body,''))>4000) into inbound
   from public.sms_messages m where m.tenant_id=t and m.direction='inbound' and m.id::text=j.payload->>'message_id' and m.conversation_id=c.id and m.contact_phone=c.phone and m.category_id is not distinct from c.group_id;
  content:=jsonb_build_object('inbound',inbound,'recordedReply',case when jsonb_typeof(r.result->'reply')='string' then left(r.result->>'reply',4000) end,
   'replyTruncated',coalesce(length(r.result->>'reply')>4000,false),'outbound',outbound);
 end if;
 return jsonb_build_object('businessId',t,'reportingAt',statement_timestamp(),'run',summary,
  'profileVersionId',summary->'profileVersionId','profileVersion',summary->'profileVersion',
  'profileCapturedAt',summary->'profileCapturedAt','profileVersionAvailability',summary->'profileVersionAvailability',
  'metrics',jsonb_build_object('model',case when r.result->>'model'='gpt-6.1-sol' then r.result->>'model' end,
   'promptVersion',case when r.result->>'promptVersion' in ('business-info-v1','sms-inbound-v1','sms-agent-v1') then r.result->>'promptVersion' end,
   'inputTokens',sms_private.mcp_ai_metric(r.result->'inputTokens'),'cachedInputTokens',sms_private.mcp_ai_metric(r.result->'cachedInputTokens'),
   'outputTokens',sms_private.mcp_ai_metric(r.result->'outputTokens'),'latencyMs',sms_private.mcp_ai_metric(r.result->'latencyMs'),
   'estimatedCostMicros',sms_private.mcp_ai_metric(r.result->'estimatedCostMicros'),'toolCount',sms_private.mcp_ai_metric(r.result->'toolCount')),
  'actions',jsonb_build_object('total',action_total,'truncated',action_total>20,'rows',actions),
  'delivery',jsonb_build_object('total',message_total,'truncated',message_total>20,'messages',delivery),'content',content);
end $$;
