-- CRM-owned maintenance. Retain evidence and dedupe keys; never requeue or send.
alter table sms_private.jobs add column archived_at timestamptz;
alter table sms_private.remote_operations add column archived_at timestamptz;
alter table sms_private.jobs add constraint jobs_archive_terminal check(archived_at is null or (status in ('failed','cancelled') and leased_until is null));
alter table sms_private.remote_operations add constraint operations_archive_terminal check(archived_at is null or state='failed');

create function sms_private.guard_archived_operation_record() returns trigger
language plpgsql set search_path='' as $$ begin
 if old.archived_at is not null then raise exception 'Archived operational evidence is immutable' using errcode='40001';end if;
 return new;
end $$;
create trigger guard_archived before update on sms_private.jobs for each row execute function sms_private.guard_archived_operation_record();
create trigger guard_archived before update on sms_private.remote_operations for each row execute function sms_private.guard_archived_operation_record();

-- The worker owns the job lock before updating its operation. Only operations
-- with no uncertain external side effect can be concluded from a terminal job.
create function sms_private.sync_failed_compliance_operation(jid uuid,actor text default 'worker:compliance_lifecycle') returns void
language plpgsql set search_path='' as $$
declare j sms_private.jobs;o sms_private.remote_operations;before_revision bigint;
begin
 select * into j from sms_private.jobs where id=jid for update;
 if j.queue is distinct from 'compliance_jobs' or j.status not in ('failed','cancelled') or j.archived_at is not null then return;end if;
 select * into o from sms_private.remote_operations where tenant_id=j.tenant_id and id::text=j.payload->>'operation_id' for update;
 if o.id is null or o.state<>'pending' or o.archived_at is not null or o.provider_resource_sid is not null then return;end if;
 if o.operation='refresh_status' and coalesce(o.request->>'reconcile','false')<>'false' then return;end if;
 if o.operation not in ('activation_canary','refresh_status') then return;end if;
 if o.operation='activation_canary' and (
  exists(select from public.sms_messages where tenant_id=j.tenant_id and meta->>'operationId'=o.id::text)
  or exists(select from sms_private.jobs where tenant_id=j.tenant_id and queue='sms_send_jobs' and dedupe_key='activation-canary:'||o.id)) then return;end if;
 before_revision:=o.operations_revision;
 update sms_private.remote_operations set state='failed',error_code=coalesce(j.error_code,'JOB_'||upper(j.status)),updated_at=now() where id=o.id returning * into o;
 insert into sms_private.audit(tenant_id,actor,action,detail) values(j.tenant_id,actor,'compliance_operation_failed',
  jsonb_build_object('jobId',j.id,'operationId',o.id,'jobRevision',j.operations_revision,'previousRevision',before_revision,'revision',o.operations_revision,'previousState','pending','state','failed','errorCode',o.error_code));
end $$;
create function sms_private.finish_compliance_operation() returns trigger
language plpgsql set search_path='' as $$ begin
 perform sms_private.sync_failed_compliance_operation(new.id);return new;
end $$;
create trigger finish_compliance_operation after update of status on sms_private.jobs for each row
 when(old.status is distinct from new.status and new.status in ('failed','cancelled') and new.queue='compliance_jobs')
 execute function sms_private.finish_compliance_operation();

-- Owner-only maintenance, deliberately not an MCP tool or browser action.
-- Explicit scoped IDs/revisions and canonical staff authorization are required.
create function sms_private.archive_obsolete_provider_job(u text,t text,jid uuid,jrev bigint,orev bigint default null) returns jsonb
language plpgsql set search_path='' as $$
declare j sms_private.jobs;o sms_private.remote_operations;r public.sms_twilio_registrations;pr sms_private.providers;old_o_revision bigint;
begin
 perform sms_private.require_admin(u);
 if not sms_private.can_access(t,u) then raise exception 'Business access denied' using errcode='42501';end if;
 select * into j from sms_private.jobs where tenant_id=t and id=jid for update nowait;
 if j.id is null then raise exception 'Job access denied' using errcode='42501';end if;
 if j.operations_revision is distinct from jrev then raise exception 'Job changed; reread revision' using errcode='40001';end if;
 if j.archived_at is not null then return jsonb_build_object('jobId',j.id,'jobRevision',j.operations_revision,'archivedAt',j.archived_at);end if;
 if j.status not in ('failed','cancelled') or j.leased_until is not null or j.updated_at>now()-interval '1 day' then raise exception 'Only old terminal unleased jobs can be archived' using errcode='22023';end if;
 select * into pr from sms_private.providers where tenant_id=t for share nowait;
 select * into r from public.sms_twilio_registrations where tenant_id=t for share nowait;
 if j.queue='compliance_jobs' and j.status='failed' then
  select * into o from sms_private.remote_operations where tenant_id=t and id::text=j.payload->>'operation_id' for update nowait;
  if o.id is null or o.operation<>'activation_canary' or o.state not in ('pending','failed') or o.provider_resource_sid is not null then raise exception 'Only obsolete preflight canaries can be archived' using errcode='22023';end if;
  if o.operations_revision is distinct from orev then raise exception 'Operation changed; reread revision' using errcode='40001';end if;
  old_o_revision:=o.operations_revision;
  if exists(select from public.sms_messages where tenant_id=t and meta->>'operationId'=o.id::text)
   or exists(select from sms_private.jobs where tenant_id=t and queue='sms_send_jobs' and dedupe_key='activation-canary:'||o.id)
   or r.state is distinct from 'ready'
   or not exists(select from public.sms_messages where tenant_id=t and id=r.canary_message_id and status='delivered')
   or not exists(select from sms_private.remote_operations where tenant_id=t and operation='activation_canary' and state='completed' and created_at>o.created_at and archived_at is null)
   or exists(select from sms_private.jobs where tenant_id=t and id<>j.id and payload->>'operation_id'=o.id::text and status not in ('failed','cancelled'))
   then raise exception 'Canary has sending evidence or no verified replacement' using errcode='22023';end if;
  perform sms_private.sync_failed_compliance_operation(j.id,u);
  update sms_private.remote_operations set archived_at=now(),updated_at=now() where id=o.id returning * into o;
 elsif j.queue='provisioning_jobs' and j.status='cancelled' and j.error_code='EXISTING_TWILIO_CONNECTION' and not (j.payload ? 'operation_id') and orev is null then
  if pr.provisioning_state is distinct from 'configured' or pr.phone_number_sid is null or pr.messaging_service_sid is null then raise exception 'A configured replacement connection is required' using errcode='22023';end if;
 else raise exception 'Job is not an obsolete canary or replaced bootstrap' using errcode='22023';end if;
 update sms_private.jobs set archived_at=now(),updated_at=now() where id=j.id returning * into j;
 insert into sms_private.audit(tenant_id,actor,action,detail) values(t,u,'obsolete_provider_job_archived',
  jsonb_build_object('jobId',j.id,'previousRevision',jrev,'revision',j.operations_revision,'operationId',o.id,'previousOperationRevision',old_o_revision,'operationRevision',o.operations_revision,'archivedAt',j.archived_at));
 return jsonb_build_object('jobId',j.id,'jobRevision',j.operations_revision,'operationId',o.id,'operationRevision',o.operations_revision,'archivedAt',j.archived_at);
end $$;
revoke all on function sms_private.guard_archived_operation_record(),sms_private.sync_failed_compliance_operation(uuid,text),sms_private.finish_compliance_operation(),sms_private.archive_obsolete_provider_job(text,text,uuid,bigint,bigint)
 from public,anon,authenticated,service_role,sms_api,crm_mcp,sms_sender,sms_webhook,sms_ai,sms_automation;

-- Filter archives before counts and pagination. Scoped detail-by-ID retains history.
create or replace function sms_private.mcp_job_retry_eligible(j sms_private.jobs) returns boolean language sql stable set search_path='' as $$
 select j.archived_at is null and j.queue='compliance_jobs' and j.status='failed' and j.leased_until is null and exists(
  select from sms_private.remote_operations o where o.archived_at is null and o.tenant_id=j.tenant_id and o.id::text=j.payload->>'operation_id'
   and o.operation='refresh_status' and o.state in ('pending','failed') and coalesce(o.request->>'reconcile','false')='false')
$$;

create or replace function sms_private.mcp_operations_action(u text,t text,tool text,p jsonb,cid uuid,rid uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
#variable_conflict use_column
declare b public.sms_businesses;pr sms_private.providers;r public.sms_twilio_registrations;j sms_private.jobs;o sms_private.remote_operations;target sms_private.remote_operations;items jsonb;result jsonb;ready jsonb;total bigint;oldrev bigint;oldjobrev bigint;pg integer:=coalesce((p->>'page')::integer,1);sz integer:=coalesce((p->>'pageSize')::integer,25);
begin
 perform sms_private.mcp_validate_input(tool,p);
 if tool='crm_get_operations_summary' then
  select coalesce(jsonb_agg(to_jsonb(q) order by queue,status),'[]') into items from (select queue,status,count(*) count from sms_private.jobs where tenant_id=t and archived_at is null group by queue,status) q;
  return jsonb_build_object('businessId',t,'queues',items);
 elsif tool='crm_list_operational_jobs' then
  select count(*) into total from sms_private.jobs where tenant_id=t and archived_at is null;
  select coalesce(jsonb_agg(sms_private.mcp_job_projection(q) order by q.created_at desc,q.id),'[]') into items from (select * from sms_private.jobs where tenant_id=t and archived_at is null order by created_at desc,id limit sz offset (pg-1)*sz) q;
  return jsonb_build_object('businessId',t,'page',pg,'pageSize',sz,'total',total,'jobs',items);
 elsif tool='crm_get_operational_job' then
  select * into j from sms_private.jobs where tenant_id=t and id=(p->>'jobId')::uuid;
  if j.id is null then raise exception 'Job access denied' using errcode='42501';end if;
  return jsonb_build_object('businessId',t,'job',sms_private.mcp_job_projection(j));
 elsif tool='crm_list_provider_operations' then
  select count(*) into total from sms_private.remote_operations where tenant_id=t and archived_at is null;
  select coalesce(jsonb_agg(sms_private.mcp_operation_projection(q) order by q.created_at desc,q.id),'[]') into items from (select * from sms_private.remote_operations where tenant_id=t and archived_at is null order by created_at desc,id limit sz offset (pg-1)*sz) q;
  return jsonb_build_object('businessId',t,'page',pg,'pageSize',sz,'total',total,'operations',items);
 elsif tool='crm_get_provider_operation' then
  select * into o from sms_private.remote_operations where tenant_id=t and id=(p->>'operationId')::uuid;
  if o.id is null then raise exception 'Operation access denied' using errcode='42501';end if;
  return jsonb_build_object('businessId',t,'operation',sms_private.mcp_operation_projection(o));
 end if;
 if tool in ('crm_get_provider_readiness','crm_get_provider_inventory') then
  select * into b from public.sms_businesses where tenant_id=t;select * into pr from sms_private.providers where tenant_id=t;select * into r from public.sms_twilio_registrations where tenant_id=t;
  result:=jsonb_build_object('businessId',t,'revision',b.operations_revision,'providerRevision',pr.operations_revision,'registrationRevision',r.operations_revision);
  if tool='crm_get_provider_inventory' then return result||jsonb_build_object('source','saved_connection','lastCheckedAt',r.last_checked_at,'sender',case when pr.tenant_id is not null then jsonb_build_object('phoneNumber',pr.from_number,'phoneNumberSid',pr.phone_number_sid,'messagingServiceSid',pr.messaging_service_sid,'senderType',r.sender_type,'provisioningState',pr.provisioning_state,'registrationState',r.state) end);end if;
  ready:=sms_private.activation_readiness(u,t);
  if r.state is distinct from 'ready' then ready:=ready||jsonb_build_object('ready',false,'reasons',(ready->'reasons')||'"delivered_canary_required"'::jsonb);end if;
  return result||ready;
 end if;
 -- NOWAIT avoids deadlocks with workers that lock jobs before provider rows.
 select * into b from public.sms_businesses where tenant_id=t for update nowait;
 select * into pr from sms_private.providers where tenant_id=t for update nowait;
 select * into r from public.sms_twilio_registrations where tenant_id=t for update nowait;
 if pr.tenant_id is null or r.tenant_id is null then raise exception 'Configured SMS provider and registration required' using errcode='22023';end if;
 if b.operations_revision is distinct from (p->>'revision')::bigint or pr.operations_revision is distinct from (p->>'providerRevision')::bigint or r.operations_revision is distinct from (p->>'registrationRevision')::bigint then raise exception 'Provider state changed; reread revisions' using errcode='40001';end if;
 oldrev:=b.operations_revision;
 if tool='crm_activate_sms_sending' then
  if exists(select from sms_private.jobs where tenant_id=t and queue in ('compliance_jobs','provisioning_jobs') and status in ('queued','retry','processing','submitting','submission_unknown')) then raise exception 'Provider work is pending; reread after completion' using errcode='40001';end if;
  if r.state<>'ready' or not coalesce((sms_private.activation_readiness(u,t)->>'ready')::boolean,false) then raise exception 'Verified sender and delivered canary required' using errcode='22023';end if;
  perform sms_private.activate_twilio(u,t);
 elsif tool in ('crm_refresh_provider_status','crm_reconcile_provider_status') then
  if pr.auth_secret_id is null or pr.account_sid is null then raise exception 'Provider credentials are not configured' using errcode='22023';end if;
  if exists(select from sms_private.jobs where tenant_id=t and queue='compliance_jobs' and status in ('queued','retry','processing','submitting')) then raise exception 'Provider check already pending' using errcode='40001';end if;
  if tool='crm_reconcile_provider_status' then
   select * into target from sms_private.remote_operations where tenant_id=t and id=(p->>'operationId')::uuid for update nowait;
   if target.id is null then raise exception 'Operation access denied' using errcode='42501';end if;
   if target.operations_revision is distinct from (p->>'operationRevision')::bigint then raise exception 'Operation changed' using errcode='40001';end if;
   if target.state<>'submission_unknown' or target.operation not in ('refresh_status','submit_registration') or r.state<>'submission_unknown' then raise exception 'This operation requires CRM reconciliation' using errcode='22023';end if;
   if target.id is distinct from (select id from sms_private.remote_operations where tenant_id=t and state='submission_unknown' order by updated_at desc limit 1) then raise exception 'A newer uncertain operation requires review' using errcode='40001';end if;
  end if;
  result:=sms_private.queue_registration_refresh(u,t,tool='crm_reconcile_provider_status');
  update sms_private.remote_operations set request=request||jsonb_build_object('mcpStatusOnly',true,'targetOperationId',target.id,'targetRevision',target.operations_revision) where id=(result->>'operationId')::uuid returning * into o;
  select * into j from sms_private.jobs where id=(result->>'jobId')::uuid;
 elsif tool='crm_retry_operational_job' then
  select * into j from sms_private.jobs where tenant_id=t and id=(p->>'jobId')::uuid for update nowait;
  if j.id is null then raise exception 'Job access denied' using errcode='42501';end if;
  select * into o from sms_private.remote_operations where tenant_id=t and id::text=j.payload->>'operation_id' for update nowait;
  if j.operations_revision is distinct from (p->>'jobRevision')::bigint or o.operations_revision is distinct from (p->>'operationRevision')::bigint then raise exception 'Job or operation changed' using errcode='40001';end if;
  if not sms_private.mcp_job_retry_eligible(j) then raise exception 'Job is not eligible for safe status retry' using errcode='22023';end if;
  if exists(select from sms_private.jobs where tenant_id=t and queue='compliance_jobs' and status in ('queued','retry','processing','submitting')) then raise exception 'Provider check already pending' using errcode='40001';end if;
  oldjobrev:=j.operations_revision;
  perform sms_private.api_action(u,t,'retry_job',jsonb_build_object('id',j.id));
  select * into j from sms_private.jobs where id=(p->>'jobId')::uuid;
 else raise exception 'Unsupported operations tool' using errcode='22023';end if;
 select * into b from public.sms_businesses where tenant_id=t;
 result:=jsonb_build_object('businessId',t,'previousRevision',oldrev,'revision',b.operations_revision,'providerRevision',pr.operations_revision,'registrationRevision',r.operations_revision,'databaseStatus','committed');
 if tool='crm_activate_sms_sending' then return result||jsonb_build_object('sendingEnabled',true);end if;
 insert into sms_private.mcp_activity(connection_id,actor_id,tool,target,request_id,outcome,revision,previous_revision)
 select cid,c.account_id,tool||':job',j.id::text,rid,'success',j.operations_revision,oldjobrev from sms_private.mcp_connections c where c.id=cid;
 if tool<>'crm_retry_operational_job' then
  insert into sms_private.mcp_activity(connection_id,actor_id,tool,target,request_id,outcome,revision)
  select cid,c.account_id,tool||':operation',o.id::text,rid,'success',o.operations_revision from sms_private.mcp_connections c where c.id=cid;
 end if;
 return result||jsonb_build_object('operationId',o.id,'operationRevision',o.operations_revision,'jobId',j.id,'jobRevision',j.operations_revision,'providerWork','queued');
end $$;

create or replace function sms_private.api_read(u text,t text,resource text,p jsonb default '{}') returns jsonb
language plpgsql security definer set search_path='' as $$
declare base jsonb; thread_count bigint; begin
 if resource='operations' then
  perform sms_private.require_admin(u);
  if not exists(select from public.sms_businesses where tenant_id=t) then raise exception 'Unknown business'; end if;
  return jsonb_build_object(
   'jobs',coalesce((select jsonb_agg(s) from (select queue,status,count(*) count,min(created_at) oldest from sms_private.jobs where tenant_id=t and archived_at is null and status not in ('completed','cancelled') group by queue,status)s),'[]'),
   'workers',coalesce((select jsonb_agg(h) from (select distinct on(queue) queue,worker_id,seen_at from sms_private.heartbeats where seen_at>now()-interval '2 minutes' order by queue,seen_at desc limit 32)h),'[]'),
   'scheduler',(select to_jsonb(r) from sms_private.runtime r),
   'problems',coalesce((select jsonb_agg(s) from (select id,queue,status,error_code,created_at from sms_private.jobs where tenant_id=t and archived_at is null and status in ('failed','submission_unknown') order by created_at desc limit 50)s),'[]'),
   'automationFailures',coalesce((select jsonb_agg(s) from (select j.id,j.error_code,j.created_at,e.id enrollment_id,e.pause_reason,g.name group_name
    from sms_private.jobs j left join public.sms_automation_enrollments e on e.tenant_id=j.tenant_id and e.id=(j.payload->>'enrollment_id')::uuid
    left join public.sms_automation_groups g on g.tenant_id=e.tenant_id and g.id=e.category_id
    where j.tenant_id=t and j.archived_at is null and j.queue='automation_jobs' and j.status='failed' order by j.created_at desc limit 50)s),'[]'));
 end if;
 base:=sms_private.api_read_before_conversations(u,t,resource,p);
 if resource<>'overview' then return base; end if;
 select count(*) into thread_count from public.sms_conversations c where c.tenant_id=t
  and exists(select from public.sms_messages m where m.tenant_id=c.tenant_id and m.conversation_id=c.id);
 return base||jsonb_build_object('conversationCount',thread_count);
end $$;

create or replace function sms_private.grounded_operations(u text,t text) returns jsonb
language plpgsql security definer set search_path='' as $$
begin
 if not sms_private.can_access(t,u) then raise exception 'Tenant access denied' using errcode='42501'; end if;
 return jsonb_build_object(
  'queues',(select coalesce(jsonb_agg(x),'[]') from (select queue,count(*) filter(where status in ('queued','retry')) backlog,extract(epoch from now()-min(created_at) filter(where status in ('queued','retry')))::integer oldest_age_seconds,count(*) filter(where status='failed') failed from sms_private.jobs where tenant_id=t and archived_at is null and queue in ('knowledge_ingest_jobs','embedding_jobs','handoff_alert_jobs','compliance_jobs','ai_reply_jobs') group by queue order by queue)x),
  'ingestionFailures',(select count(*) from public.sms_knowledge_sources where tenant_id=t and status='failed'),
  'retrievalMisses',(select count(*) from public.sms_ai_runs where tenant_id=t and disposition='handoff' and cardinality(citation_ids)=0 and created_at>now()-interval '30 days'),
  'aiValidationFailures',(select count(*) from public.sms_ai_runs where tenant_id=t and validation_error is not null and created_at>now()-interval '30 days'),
  'handoffRate',(select case when count(*)=0 then 0 else round(count(*) filter(where disposition='handoff')::numeric/count(*),4) end from public.sms_ai_runs where tenant_id=t and created_at>now()-interval '30 days'),
  'responseLatencyP95Ms',(select coalesce(percentile_cont(0.95) within group(order by latency_ms),0)::integer from public.sms_ai_runs where tenant_id=t and latency_ms is not null and created_at>now()-interval '30 days'),
  'deliveryFailures',(select count(*) from public.sms_messages where tenant_id=t and status in ('failed','undelivered') and created_at>now()-interval '30 days'),
  'aiUsage',(select jsonb_build_object('inputTokens',coalesce(sum(input_tokens),0),'outputTokens',coalesce(sum(output_tokens),0),'runs',count(*),'estimatedCostMicros',sum(estimated_cost_micros)) from public.sms_ai_runs where tenant_id=t and created_at>date_trunc('month',now())),
  'smsUsage',(select jsonb_build_object('segments',coalesce(sum(case when meta->>'smsSegments'~'^[0-9]+$' then (meta->>'smsSegments')::integer else 0 end),0),'estimatedCostMicros',sum(case when meta->>'estimatedCostMicros'~'^[0-9]+$' then (meta->>'estimatedCostMicros')::bigint end)) from public.sms_messages where tenant_id=t and direction='outbound' and created_at>date_trunc('month',now())),
  'registration',(select jsonb_build_object('state',state,'ageSeconds',extract(epoch from now()-updated_at)::integer,'rejectionCode',rejection_code,'rejectionReason',rejection_reason) from public.sms_twilio_registrations where tenant_id=t));
end $$;
