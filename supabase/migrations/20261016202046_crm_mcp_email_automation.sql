-- CRM-owned existing email workflows only; no backfill, composition or sending.
alter table sms_private.email_group_settings add column revision bigint not null default 1 check(revision between 1 and 9007199254740991);
alter table sms_private.email_enrollments add column revision bigint not null default 1 check(revision between 1 and 9007199254740991);
alter table sms_private.email_jobs add column revision bigint not null default 1 check(revision between 1 and 9007199254740991);
create function sms_private.email_shared_revision() returns trigger language plpgsql set search_path='' as $$ begin
 if tg_table_name='email_jobs' then
  if new.id<>old.id or new.enrollment_id<>old.enrollment_id then raise exception 'Immutable email job identity';end if;
 elsif tg_table_name='email_enrollments' then
  if new.tenant_id<>old.tenant_id or new.id<>old.id then raise exception 'Immutable email enrollment identity';end if;
 else
  if new.tenant_id<>old.tenant_id or new.group_id<>old.group_id then raise exception 'Immutable email group identity';end if;
 end if;
 new.revision:=old.revision+1;return new;
end $$;
create trigger email_group_shared_revision before update on sms_private.email_group_settings for each row execute function sms_private.email_shared_revision();
create trigger email_enrollment_shared_revision before update on sms_private.email_enrollments for each row execute function sms_private.email_shared_revision();
create trigger email_job_shared_revision before update on sms_private.email_jobs for each row execute function sms_private.email_shared_revision();
revoke all on function sms_private.email_shared_revision() from public,anon,authenticated,service_role,sms_api,crm_mcp;

-- Browser edits carry their read revision; internal historical callers retain
-- the canonical signature. The HTTP adapter requires the revision field.
alter function sms_private.email_save_group(text,text,text,jsonb) rename to email_save_group_before_mcp;
create function sms_private.email_save_group(u text,t text,gid text,p jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare current_revision bigint;begin
 perform sms_private.require_web_form_editor(u,t);
 select revision into current_revision from sms_private.email_group_settings where tenant_id=t and group_id=gid for update;
 if p ? 'revision' and (jsonb_typeof(p->'revision') is distinct from 'number' or (p->>'revision')::bigint is distinct from current_revision) then raise exception 'Email settings changed; reread' using errcode='23505';end if;
 return sms_private.email_save_group_before_mcp(u,t,gid,p);
end $$;
revoke all on function sms_private.email_save_group(text,text,text,jsonb),sms_private.email_save_group_before_mcp(text,text,text,jsonb) from public,anon,authenticated,service_role,sms_api,crm_mcp;
grant execute on function sms_private.email_save_group(text,text,text,jsonb) to sms_api;

-- The Edge adapter checks its own OpenAI configuration before a group write.
-- Tickets bind the exact input hash, actor, tool and request; never store input
-- content or OAuth/storage credentials. Only sms_api can attest readiness.
create table sms_private.mcp_email_tickets(
 token_hash text primary key,connection_id uuid not null references sms_private.mcp_connections(id),
 tool text not null check(tool in ('crm_save_email_group','crm_set_email_group_enabled')),
 input_hash text not null,request_id uuid not null unique,expires_at timestamptz not null default now()+interval '60 seconds',
 openai_ready boolean not null default false
);
alter table sms_private.mcp_email_tickets enable row level security;
revoke all on sms_private.mcp_email_tickets from public,anon,authenticated,service_role,sms_api,crm_mcp;
create index mcp_email_tickets_connection on sms_private.mcp_email_tickets(connection_id);
create function crm_mcp.email_action_ticket(u text,client text,tool_name text,p jsonb,rid uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare c sms_private.mcp_connections;actor uuid;token text;permission text;code text;
begin
 perform pg_advisory_xact_lock(hashtextextended('platform:privileges',0));
 begin
  actor:=sms_private.platform_actor(u);
  select * into c from sms_private.mcp_connections where issuer=sms_private.login_issuer() and subject=u and client_id=client for update;
  permission:=case tool_name when 'crm_save_email_group' then 'email_config_edit' when 'crm_set_email_group_enabled' then 'email_enable' end;
  if actor is null or not sms_private.platform_staff(actor) or c.account_id is distinct from actor or c.status is distinct from 'active' or permission is null or not permission=any(c.permissions)
   or not(c.all_businesses or p->>'businessId'=any(c.business_ids)) or not exists(select from public.sms_businesses where tenant_id=p->>'businessId') then raise exception 'Access denied' using errcode='42501';end if;
  perform sms_private.mcp_validate_input(tool_name,p);
  token:=gen_random_uuid()::text||gen_random_uuid()::text;
  delete from sms_private.mcp_email_tickets where expires_at<=now();
  insert into sms_private.mcp_email_tickets(token_hash,connection_id,tool,input_hash,request_id) values(encode(sha256(convert_to(token,'UTF8')),'hex'),c.id,tool_name,encode(sha256(convert_to(p::text,'UTF8')),'hex'),rid);
  return jsonb_build_object('ok',true,'ticket',token);
 exception when others then
  code:=case when sqlstate='42501' then 'PERMISSION_DENIED' when sqlstate in ('22023','22P02') then 'VALIDATION_ERROR' else 'TEMPORARY_FAILURE' end;
  insert into sms_private.mcp_activity(connection_id,actor_id,tool,target,request_id,outcome,code) values(c.id,actor,tool_name,left(p->>'groupId',255),rid,'denied',code);
  return jsonb_build_object('ok',false,'error',jsonb_build_object('code',code,'message','Email action authorization failed','retryable',code='TEMPORARY_FAILURE'));
 end;
end $$;
revoke all on function crm_mcp.email_action_ticket(text,text,text,jsonb,uuid) from public,anon,authenticated,service_role,sms_api;
grant execute on function crm_mcp.email_action_ticket(text,text,text,jsonb,uuid) to crm_mcp;
create function sms_private.mcp_execute_email_action(token text,p jsonb,ready boolean) returns jsonb
language plpgsql security definer set search_path='' as $$
declare ticket sms_private.mcp_email_tickets;c sms_private.mcp_connections;result jsonb;
begin
 perform pg_advisory_xact_lock(hashtextextended('platform:privileges',0));
 if length(token)<>72 then raise exception 'Email action access denied' using errcode='42501';end if;
 select * into ticket from sms_private.mcp_email_tickets where token_hash=encode(sha256(convert_to(token,'UTF8')),'hex') and expires_at>now() for update;
 if ticket.token_hash is null or ticket.input_hash<>encode(sha256(convert_to(p::text,'UTF8')),'hex') then raise exception 'Email action access denied' using errcode='42501';end if;
 select * into c from sms_private.mcp_connections where id=ticket.connection_id;
 if c.issuer is distinct from sms_private.login_issuer() then raise exception 'CRM identity required' using errcode='42501';end if;
 update sms_private.mcp_email_tickets set openai_ready=coalesce(ready,false) where token_hash=ticket.token_hash;
 result:=sms_private.mcp_invoke(c.subject,c.client_id,ticket.tool,p,ticket.request_id);
 delete from sms_private.mcp_email_tickets where token_hash=ticket.token_hash;
 return result;
end $$;
revoke all on function sms_private.mcp_execute_email_action(text,jsonb,boolean) from public,anon,authenticated,service_role,crm_mcp;
grant execute on function sms_private.mcp_execute_email_action(text,jsonb,boolean) to sms_api;

create function sms_private.mcp_email_rule(r jsonb) returns jsonb language sql immutable set search_path='' as $$
 select jsonb_build_object('anchor',r->>'anchor','repeatCount',(r->>'repeatCount')::integer,'intervalCount',(r->>'intervalCount')::integer,'intervalUnit',r->>'intervalUnit','startHour',(r->>'startHour')::integer,'endHour',(r->>'endHour')::integer,'firstDelayCount',coalesce((r->>'firstDelayCount')::integer,0),'firstDelayUnit',coalesce(r->>'firstDelayUnit','hour'),'leadHours',coalesce((r->>'leadHours')::integer,24)) $$;
create function sms_private.mcp_email_group(s sms_private.email_group_settings,g public.sms_automation_groups,tz text) returns jsonb language sql stable set search_path='' as $$
 select jsonb_build_object('id',s.group_id,'revision',s.revision,'name',g.name,'kind',g.fixed_type,'enabled',s.enabled,'configuration',jsonb_build_object('rule',sms_private.mcp_email_rule(s.rule),'intent',s.intent,'systemPrompt',s.system_prompt,'businessContext',s.business_context,'mailingAddress',s.mailing_address),'sender',s.sender,'replyTo',s.reply_to,'timeZone',tz) $$;
create function sms_private.mcp_email_enrollment(e sms_private.email_enrollments) returns jsonb language sql immutable set search_path='' as $$
 select jsonb_build_object('id',e.id,'groupId',e.group_id,'revision',e.revision,'generation',e.generation,'status',e.status,'pauseReason',e.pause_reason,'name',e.name,'email',e.email,'stepIndex',e.step_index,'nextRunAt',e.next_run_at,'sourceType',e.source_type,'sourceId',e.source_id,'formId',e.form_public_id,'enrolledAt',e.enrolled_at) $$;
create function sms_private.mcp_email_job(j sms_private.email_jobs) returns jsonb language sql immutable set search_path='' as $$
 select jsonb_build_object('id',j.id,'enrollmentId',j.enrollment_id,'revision',j.revision,'generation',j.generation,'status',j.status,'stepIndex',j.step_index,'attempts',j.attempts,'dueAt',j.due_at,'providerStatus',j.provider_status,'errorCode',j.error_code,'sendStartedAt',j.send_started_at,'providerAccepted',j.provider_id is not null) $$;

create function sms_private.mcp_email_action(u text,t text,tool text,p jsonb,cid uuid,rid uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
#variable_conflict use_column
declare f public.sms_web_form_definitions;d sms_private.mcp_form_drafts;cancelled integer:=0;s sms_private.email_group_settings;g public.sms_automation_groups;e sms_private.email_enrollments;j sms_private.email_jobs;
 pg integer:=coalesce((p->>'page')::integer,1);sz integer:=coalesce((p->>'pageSize')::integer,25);rows jsonb;total bigint;tz text;prev bigint;eprev bigint;desired boolean;source_opted boolean;source_table text;args jsonb;affected jsonb;due timestamptz;appt timestamptz;times jsonb:='[]';i integer;
begin
 perform sms_private.mcp_validate_input(tool,p);
 select time_zone into tz from public.sms_businesses where tenant_id=t;
 if tool='crm_set_form_email_enabled' then
  select * into f from public.sms_web_form_definitions where tenant_id=t and public_id=(p->>'formId')::uuid for update nowait;
  if f.public_id is null then raise exception 'Form access denied' using errcode='42501';end if;
  select * into d from sms_private.mcp_form_drafts where tenant_id=t and form_id=f.public_id for update nowait;
  if f.version<>(p->>'revision')::bigint or coalesce(d.revision,0)<>(p->>'draftRevision')::bigint then raise exception 'Form or draft changed; reread' using errcode='23505';end if;
  if f.archived or not f.legacy_form then raise exception 'An unarchived legacy email-connected form is required' using errcode='22023';end if;
  desired:=(p->>'enabled')::boolean;
  if desired and exists(select from jsonb_array_elements(f.fields||coalesce(d.definition->'fields','[]')) field where field->>'key'='email_opt_in') then raise exception 'Remove the conflicting custom email consent field first' using errcode='22023';end if;
  perform 1 from sms_private.email_enrollments where tenant_id=t and form_public_id=f.public_id and status in ('active','paused') for update nowait;
  select coalesce(jsonb_object_agg(id::text,revision),'{}') into affected from sms_private.email_enrollments where tenant_id=t and form_public_id=f.public_id and status in ('active','paused');
  prev:=f.version;
  if f.email_enabled<>desired then
   update public.sms_web_form_definitions set email_enabled=desired,updated_at=now() where tenant_id=t and public_id=f.public_id;
   update sms_private.mcp_form_drafts set base_revision=prev+1,revision=revision+1,updated_by=sms_private.platform_actor(u),connection_id=cid,updated_at=now() where tenant_id=t and form_id=f.public_id and base_revision=prev;
  end if;
  if not desired then update sms_private.email_enrollments set status='cancelled',pause_reason=null,next_run_at=null,generation=generation+1,updated_at=now() where tenant_id=t and form_public_id=f.public_id and status in ('active','paused');end if;
  insert into sms_private.mcp_activity(connection_id,actor_id,tool,target,request_id,outcome,previous_revision,revision)
  select cid,sms_private.platform_actor(u),tool||':enrollment',q.id::text,rid,'success',(affected->>q.id::text)::bigint,q.revision from sms_private.email_enrollments q where q.tenant_id=t and affected ? q.id::text and q.revision<>(affected->>q.id::text)::bigint;
  get diagnostics cancelled=row_count;
  select * into f from public.sms_web_form_definitions where tenant_id=t and public_id=f.public_id;
  select * into d from sms_private.mcp_form_drafts where tenant_id=t and form_id=f.public_id;
  return jsonb_build_object('businessId',t,'formId',f.public_id,'previousRevision',prev,'revision',f.version,'draftRevision',coalesce(d.revision,0),'emailConsentEnabled',f.email_enabled,'collectionEnabled',f.enabled,'cancelledEnrollments',cancelled,'databaseStatus','committed');
 elsif tool='crm_list_email_groups' then
  select count(*) into total from sms_private.email_group_settings s0 join public.sms_automation_groups g0 on g0.tenant_id=s0.tenant_id and g0.id=s0.group_id where s0.tenant_id=t;
  select coalesce(jsonb_agg(q.value order by q.id),'[]') into rows from (select s0.group_id id,sms_private.mcp_email_group(s0,g0,tz) value from sms_private.email_group_settings s0 join public.sms_automation_groups g0 on g0.tenant_id=s0.tenant_id and g0.id=s0.group_id where s0.tenant_id=t order by s0.group_id limit sz offset(pg-1)*sz) q;
  return jsonb_build_object('businessId',t,'groups',rows,'total',total,'page',pg,'pageSize',sz);
 elsif tool='crm_list_email_enrollments' then
  if p ? 'groupId' and not exists(select from sms_private.email_group_settings where tenant_id=t and group_id=p->>'groupId') then raise exception 'Group access denied' using errcode='42501';end if;
  select count(*) into total from sms_private.email_enrollments where tenant_id=t and(not p ? 'groupId' or group_id=p->>'groupId');
  select coalesce(jsonb_agg(sms_private.mcp_email_enrollment(q) order by q.enrolled_at desc,q.id),'[]') into rows from (select * from sms_private.email_enrollments where tenant_id=t and(not p ? 'groupId' or group_id=p->>'groupId') order by enrolled_at desc,id limit sz offset(pg-1)*sz) q;
  return jsonb_build_object('businessId',t,'enrollments',rows,'total',total,'page',pg,'pageSize',sz);
 elsif tool='crm_list_email_jobs' then
  if p ? 'enrollmentId' and not exists(select from sms_private.email_enrollments where tenant_id=t and id=(p->>'enrollmentId')::uuid) then raise exception 'Enrollment access denied' using errcode='42501';end if;
  select count(*) into total from sms_private.email_jobs j0 join sms_private.email_enrollments e0 on e0.id=j0.enrollment_id where e0.tenant_id=t and(not p ? 'enrollmentId' or e0.id=(p->>'enrollmentId')::uuid);
  select coalesce(jsonb_agg(sms_private.mcp_email_job(q) order by q.created_at desc,q.id),'[]') into rows from (select j0.* from sms_private.email_jobs j0 join sms_private.email_enrollments e0 on e0.id=j0.enrollment_id where e0.tenant_id=t and(not p ? 'enrollmentId' or e0.id=(p->>'enrollmentId')::uuid) order by j0.created_at desc,j0.id limit sz offset(pg-1)*sz) q;
  return jsonb_build_object('businessId',t,'jobs',rows,'total',total,'page',pg,'pageSize',sz);
 elsif tool in ('crm_get_email_group','crm_save_email_group','crm_set_email_group_enabled','crm_preview_email_schedule') then
  select * into s from sms_private.email_group_settings where tenant_id=t and group_id=p->>'groupId';
  select * into g from public.sms_automation_groups where tenant_id=t and id=s.group_id;
  if s.group_id is null or g.id is null then raise exception 'Group access denied' using errcode='42501';end if;
  if tool='crm_get_email_group' then return jsonb_build_object('businessId',t,'group',sms_private.mcp_email_group(s,g,tz));end if;
  if tool<>'crm_preview_email_schedule' then select * into s from sms_private.email_group_settings where tenant_id=t and group_id=s.group_id for update nowait;end if;
  prev:=s.revision;if prev<>(p->>'revision')::bigint then raise exception 'Email settings changed; reread' using errcode='23505';end if;
  if tool='crm_preview_email_schedule' then
   appt:=(p->>'appointmentAt')::timestamptz;
   if g.fixed_type='bookings' and (appt is null or appt<=(p->>'startAt')::timestamptz) then raise exception 'Future appointment required for booking preview' using errcode='22023';end if;
   due:=sms_private.automation_due(case when g.fixed_type='bookings' then appt else (p->>'startAt')::timestamptz end,s.rule,tz,true);
   for i in 1..least(30,(s.rule->>'repeatCount')::integer) loop
    due:=sms_private.form_due(greatest(due,(p->>'startAt')::timestamptz),0,'minute',tz,(s.rule->>'startHour')::integer,(s.rule->>'endHour')::integer);
    exit when due is null or (g.fixed_type='bookings' and due>=appt);
    times:=times||to_jsonb(due);due:=sms_private.automation_due(due,s.rule,tz,false);
   end loop;
   return jsonb_build_object('businessId',t,'groupId',s.group_id,'revision',s.revision,'timeZone',tz,'enabled',s.enabled,'hypothetical',true,'messageTextAvailable',false,'requiresEmailConsent',true,'times',times);
  end if;
  desired:=case when tool='crm_set_email_group_enabled' then (p->>'enabled')::boolean else s.enabled end;
  if desired and (not exists(select from sms_private.mcp_email_tickets x where x.connection_id=cid and x.request_id=rid and x.tool=mcp_email_action.tool and x.input_hash=encode(sha256(convert_to(p::text,'UTF8')),'hex') and x.expires_at>now() and x.openai_ready) or not sms_private.email_provider_ready(u,t)) then raise exception 'Configure email provider and AI before activation; use the verified CRM adapter' using errcode='22023';end if;
  args:=case when tool='crm_save_email_group' then p->'configuration' else jsonb_build_object('rule',s.rule,'intent',s.intent,'systemPrompt',s.system_prompt,'businessContext',s.business_context,'mailingAddress',s.mailing_address) end;
  if not desired then
   perform 1 from sms_private.email_enrollments where tenant_id=t and group_id=s.group_id and status in ('active','paused') for update nowait;
   select coalesce(jsonb_object_agg(id::text,revision),'{}') into affected from sms_private.email_enrollments where tenant_id=t and group_id=s.group_id and status in ('active','paused');
  end if;
  perform sms_private.email_save_group(u,t,s.group_id,args||jsonb_build_object('enabled',desired,'revision',prev));
  select * into s from sms_private.email_group_settings where tenant_id=t and group_id=s.group_id;
  insert into sms_private.mcp_activity(connection_id,actor_id,tool,target,request_id,outcome,previous_revision,revision)
  select cid,sms_private.platform_actor(u),tool||':enrollment',q.id::text,rid,'success',(affected->>q.id::text)::bigint,q.revision from sms_private.email_enrollments q where q.tenant_id=t and affected ? q.id::text;
  return jsonb_build_object('businessId',t,'groupId',s.group_id,'previousRevision',prev,'revision',s.revision,'enabled',s.enabled,'databaseStatus','committed','enrolledPastSubmissions',false);
 else
  if tool in ('crm_get_email_job','crm_retry_email_job') then
   select j0.* into j from sms_private.email_jobs j0 join sms_private.email_enrollments e0 on e0.id=j0.enrollment_id where e0.tenant_id=t and j0.id=(p->>'jobId')::uuid;
   if j.id is null then raise exception 'Job access denied' using errcode='42501';end if;
   select * into e from sms_private.email_enrollments where tenant_id=t and id=j.enrollment_id;
  else select * into e from sms_private.email_enrollments where tenant_id=t and id=(p->>'enrollmentId')::uuid;end if;
  if e.id is null then raise exception 'Enrollment access denied' using errcode='42501';end if;
  if tool='crm_get_email_enrollment' then return jsonb_build_object('businessId',t,'enrollment',sms_private.mcp_email_enrollment(e));end if;
  if tool='crm_get_email_job' then
   if p->'includeContent'='true'::jsonb and not exists(select from sms_private.mcp_connections where id=cid and 'email_content_read'=any(permissions)) then raise exception 'Email content is not granted' using errcode='42501';end if;
   return jsonb_build_object('businessId',t,'job',sms_private.mcp_email_job(j),'content',case when p->'includeContent'='true'::jsonb then jsonb_build_object('subject',j.subject,'body',j.body) end);
  end if;
  perform pg_advisory_xact_lock(hashtext(t||':'||e.email));
  if tool='crm_retry_email_job' then select * into j from sms_private.email_jobs where id=j.id for update nowait;end if;
  select * into e from sms_private.email_enrollments where tenant_id=t and id=e.id for update nowait;
  if e.id<>(p->>'enrollmentId')::uuid then raise exception 'Enrollment access denied' using errcode='42501';end if;
  if e.generation<>(p->>'generation')::integer or e.revision<>coalesce((p->>'enrollmentRevision')::bigint,(p->>'revision')::bigint) then raise exception 'Enrollment changed; reread' using errcode='23505';end if;
  eprev:=e.revision;
  if tool='crm_resolve_email_enrollment' then
   perform sms_private.email_resolve(u,t,e.id);select * into e from sms_private.email_enrollments where tenant_id=t and id=e.id;
   return jsonb_build_object('businessId',t,'enrollmentId',e.id,'previousRevision',eprev,'revision',e.revision,'generation',e.generation,'status',e.status,'databaseStatus','committed');
  elsif tool='crm_retry_email_job' then
   prev:=j.revision;if prev<>(p->>'revision')::bigint then raise exception 'Email job changed; reread' using errcode='23505';end if;
   if not exists(select from sms_private.email_consent_events c where c.tenant_id=t and c.source_type=e.source_type and c.source_id=e.source_id and lower(btrim(c.email))=e.email and length(btrim(c.evidence))>0) then raise exception 'Recorded email consent is required' using errcode='22023';end if;
   source_table:=sms_private.intake_table(e.source_type);
   if source_table is null then raise exception 'Unsupported email source' using errcode='22023';end if;
   execute format('select email_opt_in and lower(btrim(email))=$3 from public.%I where tenant_id=$1 and id=$2 for share nowait',source_table) into source_opted using t,e.source_id,e.email;
   if source_opted is distinct from true then raise exception 'Current email consent and address must match the enrollment' using errcode='22023';end if;
   perform sms_private.email_retry(u,t,j.id);
   select * into j from sms_private.email_jobs where id=j.id;select * into e from sms_private.email_enrollments where tenant_id=t and id=e.id;
   insert into sms_private.mcp_activity(connection_id,actor_id,tool,target,request_id,outcome,previous_revision,revision) values(cid,sms_private.platform_actor(u),tool||':enrollment',e.id::text,rid,'success',eprev,e.revision);
   return jsonb_build_object('businessId',t,'jobId',j.id,'enrollmentId',e.id,'previousRevision',prev,'revision',j.revision,'enrollmentRevision',e.revision,'generation',e.generation,'status',j.status,'providerWork','queued','databaseStatus','committed');
  end if;
 end if;
 raise exception 'Unsupported email tool' using errcode='22023';
end $$;
revoke all on function sms_private.mcp_email_rule(jsonb),sms_private.mcp_email_group(sms_private.email_group_settings,public.sms_automation_groups,text),sms_private.mcp_email_enrollment(sms_private.email_enrollments),sms_private.mcp_email_job(sms_private.email_jobs),sms_private.mcp_email_action(text,text,text,jsonb,uuid,uuid) from public,anon,authenticated,service_role,sms_api,crm_mcp;


-- GENERATED MCP CONTRACTS
insert into sms_private.mcp_input_schemas values('crm_set_form_email_enabled','{"type":"object","properties":{"businessId":{"type":"string","minLength":1,"maxLength":255},"formId":{"type":"string","format":"uuid"},"revision":{"type":"integer","minimum":1,"maximum":9007199254740991},"draftRevision":{"type":"integer","minimum":0,"maximum":9007199254740991},"enabled":{"type":"boolean"},"idempotencyKey":{"type":"string","minLength":8,"maxLength":128}},"required":["businessId","formId","revision","draftRevision","enabled","idempotencyKey"],"additionalProperties":false,"$schema":"http://json-schema.org/draft-07/schema#"}'::jsonb);
insert into sms_private.mcp_input_schemas values('crm_list_email_groups','{"type":"object","properties":{"businessId":{"type":"string","minLength":1,"maxLength":255},"page":{"type":"integer","minimum":1,"maximum":100000,"default":1},"pageSize":{"type":"integer","minimum":1,"maximum":100,"default":25}},"required":["businessId"],"additionalProperties":false,"$schema":"http://json-schema.org/draft-07/schema#"}'::jsonb);
insert into sms_private.mcp_input_schemas values('crm_get_email_group','{"type":"object","properties":{"businessId":{"type":"string","minLength":1,"maxLength":255},"groupId":{"type":"string","minLength":1,"maxLength":255}},"required":["businessId","groupId"],"additionalProperties":false,"$schema":"http://json-schema.org/draft-07/schema#"}'::jsonb);
insert into sms_private.mcp_input_schemas values('crm_list_email_enrollments','{"type":"object","properties":{"businessId":{"type":"string","minLength":1,"maxLength":255},"groupId":{"type":"string","minLength":1,"maxLength":255},"page":{"type":"integer","minimum":1,"maximum":100000,"default":1},"pageSize":{"type":"integer","minimum":1,"maximum":100,"default":25}},"required":["businessId"],"additionalProperties":false,"$schema":"http://json-schema.org/draft-07/schema#"}'::jsonb);
insert into sms_private.mcp_input_schemas values('crm_get_email_enrollment','{"type":"object","properties":{"businessId":{"type":"string","minLength":1,"maxLength":255},"enrollmentId":{"type":"string","format":"uuid"}},"required":["businessId","enrollmentId"],"additionalProperties":false,"$schema":"http://json-schema.org/draft-07/schema#"}'::jsonb);
insert into sms_private.mcp_input_schemas values('crm_list_email_jobs','{"type":"object","properties":{"businessId":{"type":"string","minLength":1,"maxLength":255},"enrollmentId":{"type":"string","format":"uuid"},"page":{"type":"integer","minimum":1,"maximum":100000,"default":1},"pageSize":{"type":"integer","minimum":1,"maximum":100,"default":25}},"required":["businessId"],"additionalProperties":false,"$schema":"http://json-schema.org/draft-07/schema#"}'::jsonb);
insert into sms_private.mcp_input_schemas values('crm_get_email_job','{"type":"object","properties":{"businessId":{"type":"string","minLength":1,"maxLength":255},"jobId":{"type":"string","format":"uuid"},"includeContent":{"type":"boolean","default":false}},"required":["businessId","jobId"],"additionalProperties":false,"$schema":"http://json-schema.org/draft-07/schema#"}'::jsonb);
insert into sms_private.mcp_input_schemas values('crm_preview_email_schedule','{"type":"object","properties":{"businessId":{"type":"string","minLength":1,"maxLength":255},"groupId":{"type":"string","minLength":1,"maxLength":255},"revision":{"type":"integer","minimum":1,"maximum":9007199254740991},"startAt":{"type":"string","format":"date-time"},"appointmentAt":{"anyOf":[{"type":"string","format":"date-time"},{"type":"null"}],"default":null}},"required":["businessId","groupId","revision","startAt"],"additionalProperties":false,"$schema":"http://json-schema.org/draft-07/schema#"}'::jsonb);
insert into sms_private.mcp_input_schemas values('crm_save_email_group','{"type":"object","properties":{"businessId":{"type":"string","minLength":1,"maxLength":255},"groupId":{"type":"string","minLength":1,"maxLength":255},"revision":{"type":"integer","minimum":1,"maximum":9007199254740991},"configuration":{"type":"object","properties":{"rule":{"type":"object","properties":{"anchor":{"type":"string","enum":["enrollment","appointment"]},"repeatCount":{"type":"integer","minimum":1,"maximum":30},"intervalCount":{"type":"integer","minimum":1,"maximum":365},"intervalUnit":{"type":"string","enum":["hour","day","week","month"]},"startHour":{"type":"integer","minimum":0,"maximum":23},"endHour":{"type":"integer","minimum":1,"maximum":24},"firstDelayCount":{"type":"integer","minimum":0,"maximum":365},"firstDelayUnit":{"type":"string","enum":["hour","day","week","month"]},"leadHours":{"type":"integer","minimum":1,"maximum":720}},"required":["anchor","repeatCount","intervalCount","intervalUnit","startHour","endHour","firstDelayCount","firstDelayUnit","leadHours"],"additionalProperties":false},"intent":{"type":"string","maxLength":1600},"systemPrompt":{"type":"string","maxLength":6000},"businessContext":{"type":"string","maxLength":10000},"mailingAddress":{"type":"string","maxLength":300}},"required":["rule","intent","systemPrompt","businessContext","mailingAddress"],"additionalProperties":false},"idempotencyKey":{"type":"string","minLength":8,"maxLength":128}},"required":["businessId","groupId","revision","configuration","idempotencyKey"],"additionalProperties":false,"$schema":"http://json-schema.org/draft-07/schema#"}'::jsonb);
insert into sms_private.mcp_input_schemas values('crm_set_email_group_enabled','{"type":"object","properties":{"businessId":{"type":"string","minLength":1,"maxLength":255},"groupId":{"type":"string","minLength":1,"maxLength":255},"revision":{"type":"integer","minimum":1,"maximum":9007199254740991},"enabled":{"type":"boolean"},"idempotencyKey":{"type":"string","minLength":8,"maxLength":128}},"required":["businessId","groupId","revision","enabled","idempotencyKey"],"additionalProperties":false,"$schema":"http://json-schema.org/draft-07/schema#"}'::jsonb);
insert into sms_private.mcp_input_schemas values('crm_resolve_email_enrollment','{"type":"object","properties":{"businessId":{"type":"string","minLength":1,"maxLength":255},"enrollmentId":{"type":"string","format":"uuid"},"revision":{"type":"integer","minimum":1,"maximum":9007199254740991},"generation":{"type":"integer","minimum":1,"maximum":9007199254740991},"idempotencyKey":{"type":"string","minLength":8,"maxLength":128}},"required":["businessId","enrollmentId","revision","generation","idempotencyKey"],"additionalProperties":false,"$schema":"http://json-schema.org/draft-07/schema#"}'::jsonb);
insert into sms_private.mcp_input_schemas values('crm_retry_email_job','{"type":"object","properties":{"businessId":{"type":"string","minLength":1,"maxLength":255},"enrollmentId":{"type":"string","format":"uuid"},"enrollmentRevision":{"type":"integer","minimum":1,"maximum":9007199254740991},"generation":{"type":"integer","minimum":1,"maximum":9007199254740991},"jobId":{"type":"string","format":"uuid"},"revision":{"type":"integer","minimum":1,"maximum":9007199254740991},"idempotencyKey":{"type":"string","minLength":8,"maxLength":128}},"required":["businessId","enrollmentId","enrollmentRevision","generation","jobId","revision","idempotencyKey"],"additionalProperties":false,"$schema":"http://json-schema.org/draft-07/schema#"}'::jsonb);
alter table sms_private.mcp_connections drop constraint mcp_connections_permissions_check;
alter table sms_private.mcp_connections add constraint mcp_connections_permissions_check check(permissions <@ array['email_form_enable','email_read','email_preview','email_config_edit','email_enable','email_resolve','email_retry','email_content_read','knowledge_read','knowledge_upload','knowledge_create','knowledge_refresh','knowledge_archive','knowledge_approve','ai_config_read','ai_config_edit','ai_activate','booking_read','booking_intake_read','booking_schedule_read','booking_schedule_edit','booking_schedule_enable','booking_preview','booking_intake_edit','booking_cancel','form_duplicate','form_archive','form_restore','automation_archive','automation_preset_read','automation_preset_save','conversation_ai_pause','conversation_ai_resume','conversation_message_reassign','handoff_alert_retry','activity_report_read','activity_tag_manage','activity_attribution_update','read','draft','review','service_add','visibility','global_customer_lookup','automation_read','automation_draft','automation_preview','automation_publish','automation_enable','automation_run_start','automation_run_resume','automation_run_pause_stop','automation_activity','form_read','form_create','form_edit','form_preview','form_publish','form_activate','enquiry_read','enquiry_status_read','lead_read','lead_status_update','lead_assign','handoff_read','handoff_status_update','handoff_assign','conversation_read','conversation_messages_read','conversation_reply','conversation_mark_read','contact_read','contact_create','contact_edit','consent_read','consent_opt_in','contact_suppress','contact_automation_block','sms_message_preview','sms_message_send']::text[]);
create or replace function sms_private.mcp_admin(u text,action text,p jsonb default '{}') returns jsonb
language plpgsql security definer set search_path='' as $$
declare aid uuid; c sms_private.mcp_connections; result jsonb; perms text[]; businesses text[];
 pg integer:=greatest(1,least(coalesce((p->>'page')::integer,1),100000)); total integer;
begin
 -- Match the platform's privilege/ownership lock order; grants cannot race a write.
 perform pg_advisory_xact_lock(hashtextextended('platform:privileges',0));
 aid:=sms_private.platform_actor(u);
 if aid is null or not sms_private.platform_staff(aid) then raise exception 'CRM staff required' using errcode='42501'; end if;
 if action='list' then
  select count(*) into total from sms_private.mcp_connections;
  select coalesce(jsonb_agg(to_jsonb(x) order by x.created_at desc,x.id),'[]') into result from (
   select listed.*,a.clerk_display_name as staff_name,
    coalesce((select jsonb_object_agg(b.tenant_id,b.name) from public.sms_businesses b where b.tenant_id=any(listed.business_ids)),'{}') as business_labels
    from sms_private.mcp_connections listed
    left join public.dashboard_accounts a on a.id=listed.account_id order by listed.created_at desc,listed.id limit 25 offset (pg-1)*25) x;
  return jsonb_build_object('connections',result,'page',pg,'total',total,'totalPages',greatest(1,ceil(total/25.0)));
 elsif action='activity' then
  select count(*) into total from sms_private.mcp_activity where connection_id=(p->>'connectionId')::uuid;
  select coalesce(jsonb_agg(to_jsonb(x) order by x.id desc),'[]') into result from (
   select * from sms_private.mcp_activity where connection_id=(p->>'connectionId')::uuid order by id desc limit 50 offset (pg-1)*50) x;
  return jsonb_build_object('activity',result,'page',pg,'total',total,'totalPages',greatest(1,ceil(total/50.0)));
 elsif action='save' then
  select * into c from sms_private.mcp_connections where id=(p->>'connectionId')::uuid for update;
  if c.id is null then raise exception 'Connection not found'; end if;
  if c.revision is distinct from (p->>'revision')::bigint then raise exception 'Connection changed; refresh and retry' using errcode='40001'; end if;
  if c.status='revoked' then raise exception 'Revoked connections cannot be reactivated' using errcode='42501'; end if;
  if coalesce(p->>'status','') not in ('active','disabled','revoked') then raise exception 'Invalid connection status'; end if;
  if jsonb_typeof(p->'permissions') is distinct from 'array' or jsonb_typeof(p->'businessIds') is distinct from 'array' then raise exception 'Permissions and businesses are required'; end if;
  select coalesce(array_agg(distinct x),'{}') into perms from jsonb_array_elements_text(p->'permissions') x;
  select coalesce(array_agg(distinct x),'{}') into businesses from jsonb_array_elements_text(p->'businessIds') x;
  if not perms <@ array['email_form_enable','email_read','email_preview','email_config_edit','email_enable','email_resolve','email_retry','email_content_read','knowledge_read','knowledge_upload','knowledge_create','knowledge_refresh','knowledge_archive','knowledge_approve','ai_config_read','ai_config_edit','ai_activate','booking_read','booking_intake_read','booking_schedule_read','booking_schedule_edit','booking_schedule_enable','booking_preview','booking_intake_edit','booking_cancel','form_duplicate','form_archive','form_restore','automation_archive','automation_preset_read','automation_preset_save','conversation_ai_pause','conversation_ai_resume','conversation_message_reassign','handoff_alert_retry','activity_report_read','activity_tag_manage','activity_attribution_update','read','draft','review','service_add','visibility','global_customer_lookup','automation_read','automation_draft','automation_preview','automation_publish','automation_enable','automation_run_start','automation_run_resume','automation_run_pause_stop','automation_activity','form_read','form_create','form_edit','form_preview','form_publish','form_activate','enquiry_read','enquiry_status_read','lead_read','lead_status_update','lead_assign','handoff_read','handoff_status_update','handoff_assign','conversation_read','conversation_messages_read','conversation_reply','conversation_mark_read','contact_read','contact_create','contact_edit','consent_read','consent_opt_in','contact_suppress','contact_automation_block','sms_message_preview','sms_message_send']::text[] or cardinality(businesses)>500
   or exists(select from unnest(businesses) t where not exists(select from public.sms_businesses b where b.tenant_id=t)) then raise exception 'Invalid connection grants'; end if;
  if p->>'status'='active' and not sms_private.platform_staff(c.account_id) then raise exception 'Connection owner must be active CRM staff' using errcode='42501'; end if;
  if p ? 'allBusinesses' and jsonb_typeof(p->'allBusinesses')<>'boolean' then raise exception 'Invalid business scope'; end if;
  update sms_private.mcp_connections set status=p->>'status',permissions=perms,business_ids=businesses,all_businesses=coalesce((p->>'allBusinesses')::boolean,false),revision=revision+1 where id=c.id returning to_jsonb(mcp_connections.*) into result;
  insert into sms_private.mcp_activity(connection_id,actor_id,tool,target,request_id,outcome,revision)
   values(c.id,aid,'connection_'||(p->>'status'),c.id::text,gen_random_uuid(),'success',(result->>'revision')::bigint);
  return jsonb_build_object('connection',result);
 end if;
 raise exception 'Unknown connection action';
end $$;
create or replace function sms_private.mcp_invoke(u text,client text,tool text,p jsonb,request_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare aid uuid; c sms_private.mcp_connections; result jsonb; data jsonb; required_permission text; action text;
 t text:=p->>'businessId'; target text:=coalesce(p->>'groupId',p->>'enrollmentId',p->>'jobId',p->>'sourceId',p->>'uploadId',p->>'tagId',p->>'eventId',p->>'contactId',p->>'conversationId',p->>'leadId',p->>'handoffId',p->>'submissionId',p->>'runId',p->>'automationId',p->>'formId',p->>'businessId',p->>'accountId');
 pg integer; size integer; total integer; key text:=p->>'idempotencyKey'; fingerprint text; prior sms_private.mcp_requests;
 error_code text; error_message text; state text; replay boolean:=false; allowed_keys text[];
begin
 perform pg_advisory_xact_lock(hashtextextended('platform:privileges',0));
 -- Failure responses are returned, not raised, so denied attempts are audited.
 begin
  aid:=sms_private.platform_actor(u);
  if aid is null or not sms_private.platform_staff(aid) then raise exception 'Active CRM staff required' using errcode='42501'; end if;
  if client is null or length(client) not between 1 and 2048 then raise exception 'Invalid OAuth client'; end if;
  insert into sms_private.mcp_connections(issuer,subject,account_id,client_id)
   values(sms_private.login_issuer(),u,aid,client) on conflict(issuer,subject,client_id) do nothing;
 exception when others then
  insert into sms_private.mcp_activity(actor_id,tool,target,request_id,outcome,code)
   values(aid,left(tool,100),left(target,255),request_id,'denied','PERMISSION_DENIED');
  return jsonb_build_object('ok',false,'error',jsonb_build_object('code','PERMISSION_DENIED','message','Active CRM staff required','retryable',false));
 end;
 select * into c from sms_private.mcp_connections where issuer=sms_private.login_issuer() and subject=u and client_id=client for update;
 begin
  if c.id is null or c.account_id is distinct from aid then raise exception 'Connection identity mismatch' using errcode='42501'; end if;
  update sms_private.mcp_connections set last_used_at=now() where id=c.id;
  if tool='crm_get_access' then
   data:=jsonb_build_object('connectionId',c.id,'status',c.status,'permissions',case when c.status='active' then to_jsonb(c.permissions) else '[]'::jsonb end,
    'businessScope',case when c.status<>'active' then 'none' when c.all_businesses then 'all' else 'selected' end,
    'businesses',case when c.status='active' then coalesce((select jsonb_agg(jsonb_build_object('id',tenant_id,'name',name) order by tenant_id) from (select tenant_id,name from public.sms_businesses where c.all_businesses or tenant_id=any(c.business_ids) order by tenant_id limit 100) b),'[]') else '[]'::jsonb end);
  else
   if c.status<>'active' then raise exception 'Connection is not active' using errcode='42501'; end if;
   required_permission:=case tool when 'crm_set_form_email_enabled' then 'email_form_enable' when 'crm_list_email_groups' then 'email_read' when 'crm_get_email_group' then 'email_read' when 'crm_list_email_enrollments' then 'email_read' when 'crm_get_email_enrollment' then 'email_read' when 'crm_list_email_jobs' then 'email_read' when 'crm_get_email_job' then 'email_read' when 'crm_preview_email_schedule' then 'email_preview' when 'crm_save_email_group' then 'email_config_edit' when 'crm_set_email_group_enabled' then 'email_enable' when 'crm_resolve_email_enrollment' then 'email_resolve' when 'crm_retry_email_job' then 'email_retry' when 'crm_list_knowledge_sources' then 'knowledge_read' when 'crm_get_knowledge_source' then 'knowledge_read' when 'crm_list_knowledge_versions' then 'knowledge_read' when 'crm_get_knowledge_version' then 'knowledge_read' when 'crm_prepare_knowledge_upload' then 'knowledge_upload' when 'crm_create_knowledge_source' then 'knowledge_create' when 'crm_refresh_knowledge_source' then 'knowledge_refresh' when 'crm_archive_knowledge_source' then 'knowledge_archive' when 'crm_approve_knowledge_version' then 'knowledge_approve' when 'crm_get_ai_configuration' then 'ai_config_read' when 'crm_save_ai_configuration' then 'ai_config_edit' when 'crm_set_ai_mode' then 'ai_activate' when 'crm_list_bookings' then 'booking_read' when 'crm_get_booking' then 'booking_read' when 'crm_list_booking_intakes' then 'booking_intake_read' when 'crm_get_booking_intake' then 'booking_intake_read' when 'crm_list_booking_schedules' then 'booking_schedule_read' when 'crm_get_booking_schedule' then 'booking_schedule_read' when 'crm_create_booking_schedule' then 'booking_schedule_edit' when 'crm_update_booking_schedule' then 'booking_schedule_edit' when 'crm_set_booking_schedule_enabled' then 'booking_schedule_enable' when 'crm_preview_booking_availability' then 'booking_preview' when 'crm_update_booking_intake' then 'booking_intake_edit' when 'crm_cancel_booking' then 'booking_cancel' when 'crm_duplicate_form' then 'form_duplicate' when 'crm_archive_form' then 'form_archive' when 'crm_restore_form' then 'form_restore' when 'crm_archive_sms_template' then 'automation_archive' when 'crm_list_sms_presets' then 'automation_preset_read' when 'crm_get_sms_preset' then 'automation_preset_read' when 'crm_save_sms_preset' then 'automation_preset_save' when 'crm_pause_conversation_ai' then 'conversation_ai_pause' when 'crm_resume_conversation_ai' then 'conversation_ai_resume' when 'crm_reassign_conversation_message' then 'conversation_message_reassign' when 'crm_retry_handoff_alert' then 'handoff_alert_retry' when 'crm_get_activity_report' then 'activity_report_read' when 'crm_list_activity_tags' then 'activity_report_read' when 'crm_get_enquiry_attribution_context' then 'activity_report_read' when 'crm_create_activity_tag' then 'activity_tag_manage' when 'crm_update_activity_tag' then 'activity_tag_manage' when 'crm_set_enquiry_tag' then 'activity_tag_manage' when 'crm_link_enquiry_booking' then 'activity_attribution_update' when 'crm_link_enquiry_response' then 'activity_attribution_update' when 'crm_link_enquiry_activity' then 'activity_attribution_update' when 'crm_list_contacts' then 'contact_read' when 'crm_get_contact' then 'contact_read' when 'crm_get_contact_consent' then 'consent_read' when 'crm_create_contact' then 'contact_create' when 'crm_update_contact' then 'contact_edit' when 'crm_record_contact_sms_opt_in' then 'consent_opt_in' when 'crm_suppress_contact_sms' then 'contact_suppress' when 'crm_set_contact_automation_blocked' then 'contact_automation_block' when 'crm_preview_contact_sms' then 'sms_message_preview' when 'crm_send_contact_sms' then 'sms_message_send' when 'crm_reply_to_conversation' then 'conversation_reply' when 'crm_preview_conversation_reply' then 'conversation_reply' when 'crm_mark_conversation_messages_read' then 'conversation_mark_read' when 'crm_list_conversations' then 'conversation_read' when 'crm_get_conversation' then 'conversation_read' when 'crm_assign_lead' then 'lead_assign' when 'crm_set_lead_status' then 'lead_status_update' when 'crm_assign_handoff' then 'handoff_assign' when 'crm_set_handoff_status' then 'handoff_status_update' when 'crm_list_leads' then 'lead_read' when 'crm_get_lead' then 'lead_read' when 'crm_list_handoffs' then 'handoff_read' when 'crm_get_handoff' then 'handoff_read' when 'crm_get_enquiry_status' then 'enquiry_status_read' when 'crm_list_enquiries' then 'enquiry_read' when 'crm_get_enquiry' then 'enquiry_read' when 'crm_set_form_collection_enabled' then 'form_activate' when 'crm_apply_form_draft' then 'form_publish' when 'crm_preview_form' then 'form_preview' when 'crm_create_form' then 'form_create' when 'crm_save_form_draft' then 'form_edit' when 'crm_list_forms' then 'form_read' when 'crm_get_form' then 'form_read' when 'crm_search_customers' then 'read' when 'crm_get_customer' then 'read'
    when 'crm_create_sms_automation' then 'automation_draft' when 'crm_save_sms_automation_draft' then 'automation_draft'
    when 'crm_list_sms_runs' then 'automation_activity' when 'crm_get_sms_run' then 'automation_activity' when 'crm_get_sms_run_activity' then 'automation_activity'
    when 'crm_resume_sms_run' then 'automation_run_resume' when 'crm_pause_sms_run' then 'automation_run_pause_stop' when 'crm_stop_sms_run' then 'automation_run_pause_stop'
    when 'crm_get_sms_run_start_context' then 'automation_read' when 'crm_start_sms_automation_run' then 'automation_run_start'
    when 'crm_preview_sms_automation' then 'automation_preview'
    when 'crm_publish_sms_automation' then 'automation_publish' when 'crm_set_form_followups_enabled' then 'automation_enable'
    when 'crm_list_sms_automations' then 'automation_read' when 'crm_get_sms_automation' then 'automation_read'
    when 'crm_search_sms_contacts' then 'automation_read' when 'crm_list_form_submissions' then 'automation_read'
    when 'crm_list_businesses' then 'read' when 'crm_get_business' then 'read'
    when 'crm_save_business_profile_draft' then 'draft' when 'crm_review_business_profile' then 'review'
    when 'crm_add_business_service' then 'service_add' when 'crm_set_service_visibility' then 'visibility' end;
   if required_permission is null or not required_permission=any(c.permissions) then raise exception 'Action is not granted' using errcode='42501'; end if;
   if tool in ('crm_set_form_email_enabled','crm_list_email_groups','crm_get_email_group','crm_list_email_enrollments','crm_get_email_enrollment','crm_list_email_jobs','crm_get_email_job','crm_preview_email_schedule','crm_save_email_group','crm_set_email_group_enabled','crm_resolve_email_enrollment','crm_retry_email_job','crm_list_knowledge_sources','crm_get_knowledge_source','crm_list_knowledge_versions','crm_get_knowledge_version','crm_prepare_knowledge_upload','crm_create_knowledge_source','crm_refresh_knowledge_source','crm_archive_knowledge_source','crm_approve_knowledge_version','crm_get_ai_configuration','crm_save_ai_configuration','crm_set_ai_mode','crm_list_bookings','crm_get_booking','crm_list_booking_intakes','crm_get_booking_intake','crm_list_booking_schedules','crm_get_booking_schedule','crm_create_booking_schedule','crm_update_booking_schedule','crm_set_booking_schedule_enabled','crm_preview_booking_availability','crm_update_booking_intake','crm_cancel_booking','crm_duplicate_form','crm_archive_form','crm_restore_form','crm_archive_sms_template','crm_list_sms_presets','crm_get_sms_preset','crm_save_sms_preset','crm_pause_conversation_ai','crm_resume_conversation_ai','crm_reassign_conversation_message','crm_retry_handoff_alert','crm_get_activity_report','crm_list_activity_tags','crm_get_enquiry_attribution_context','crm_create_activity_tag','crm_update_activity_tag','crm_set_enquiry_tag','crm_link_enquiry_booking','crm_link_enquiry_response','crm_link_enquiry_activity','crm_list_contacts','crm_get_contact','crm_get_contact_consent','crm_create_contact','crm_update_contact','crm_record_contact_sms_opt_in','crm_suppress_contact_sms','crm_set_contact_automation_blocked','crm_preview_contact_sms','crm_send_contact_sms','crm_reply_to_conversation','crm_preview_conversation_reply','crm_mark_conversation_messages_read','crm_list_conversations','crm_get_conversation','crm_assign_lead','crm_set_lead_status','crm_assign_handoff','crm_set_handoff_status','crm_list_leads','crm_get_lead','crm_list_handoffs','crm_get_handoff','crm_get_enquiry_status','crm_list_enquiries','crm_get_enquiry','crm_set_form_collection_enabled','crm_apply_form_draft','crm_preview_form','crm_create_form','crm_save_form_draft','crm_list_forms','crm_get_form','crm_list_sms_runs','crm_get_sms_run','crm_get_sms_run_activity','crm_resume_sms_run','crm_pause_sms_run','crm_stop_sms_run','crm_get_sms_run_start_context','crm_start_sms_automation_run','crm_publish_sms_automation','crm_set_form_followups_enabled','crm_create_sms_automation','crm_save_sms_automation_draft','crm_preview_sms_automation','crm_list_sms_automations','crm_get_sms_automation','crm_search_sms_contacts','crm_list_form_submissions','crm_get_business','crm_save_business_profile_draft','crm_review_business_profile','crm_add_business_service','crm_set_service_visibility')
    and (t is null or (not c.all_businesses and not t=any(c.business_ids)) or not exists(select from public.sms_businesses where tenant_id=t)) then raise exception 'Business access denied' using errcode='42501'; end if;
   if tool='crm_start_sms_automation_run' and p->>'overlapChoice'='stop_selected' and not 'automation_run_pause_stop'=any(c.permissions) then raise exception 'Stopping overlapping runs is not granted' using errcode='42501'; end if;
   if tool='crm_get_conversation' and p->'includeMessages'='true'::jsonb and not 'conversation_messages_read'=any(c.permissions) then raise exception 'Message content is not granted' using errcode='42501'; end if;
   if tool in ('crm_list_email_groups','crm_get_email_group','crm_list_email_enrollments','crm_get_email_enrollment','crm_list_email_jobs','crm_get_email_job','crm_preview_email_schedule') then
    data:=sms_private.mcp_email_action(u,t,tool,p,c.id,request_id);
   elsif tool in ('crm_list_knowledge_sources','crm_get_knowledge_source','crm_list_knowledge_versions','crm_get_knowledge_version','crm_get_ai_configuration') then
    data:=sms_private.mcp_knowledge_action(u,t,tool,p,c.id,request_id);
   elsif tool in ('crm_list_bookings','crm_get_booking','crm_list_booking_intakes','crm_get_booking_intake','crm_list_booking_schedules','crm_get_booking_schedule','crm_preview_booking_availability') then
    data:=sms_private.mcp_booking_action(u,t,tool,p,c.id,request_id);
   elsif tool in ('crm_list_sms_presets','crm_get_sms_preset') then
    data:=sms_private.mcp_form_lifecycle(u,t,tool,p,c.id,request_id);
   elsif tool in ('crm_get_activity_report','crm_list_activity_tags','crm_get_enquiry_attribution_context') then
    data:=sms_private.mcp_activity_action(u,t,tool,p,c.id);
   elsif tool in ('crm_list_contacts','crm_get_contact','crm_get_contact_consent','crm_preview_contact_sms') then
    data:=sms_private.mcp_contact_action(u,t,tool,p,c.id);
   elsif tool='crm_preview_conversation_reply' then
    data:=sms_private.mcp_conversation_reply_preview(u,t,p);
   elsif tool in ('crm_list_conversations','crm_get_conversation') then
    data:=sms_private.mcp_conversation_read(u,t,tool,p);
   elsif tool in ('crm_list_leads','crm_get_lead','crm_list_handoffs','crm_get_handoff') then
    data:=sms_private.mcp_lead_handoff_read(u,t,tool,p);
   elsif tool='crm_get_enquiry_status' then
    data:=sms_private.mcp_enquiry_status(u,t,p);
   elsif tool in ('crm_list_enquiries','crm_get_enquiry') then
    data:=sms_private.mcp_enquiry_read(u,t,tool,p);
   elsif tool='crm_preview_form' then
    data:=sms_private.mcp_form_preview(u,t,p);
   elsif tool in ('crm_list_forms','crm_get_form') then
    data:=sms_private.mcp_form_read(u,t,tool,p);
   elsif tool in ('crm_list_sms_runs','crm_get_sms_run','crm_get_sms_run_activity') then
    data:=sms_private.mcp_sms_activity(u,t,tool,p);
   elsif tool='crm_get_sms_run_start_context' then
    data:=sms_private.mcp_sms_start_context(u,t,p);
   elsif tool='crm_preview_sms_automation' then
    data:=sms_private.mcp_sms_preview(u,t,p);
   elsif tool in ('crm_list_sms_automations','crm_get_sms_automation','crm_search_sms_contacts','crm_list_form_submissions') then
    data:=sms_private.mcp_sms_read(u,t,tool,p);
   elsif tool='crm_get_business' then
    data:=jsonb_build_object('business',sms_private.mcp_business(t));
   elsif tool='crm_list_businesses' then
    pg:=greatest(1,least(coalesce((p->>'page')::integer,1),100000));size:=greatest(1,least(coalesce((p->>'pageSize')::integer,25),100));
    select count(*) into total from public.sms_businesses where (c.all_businesses or tenant_id=any(c.business_ids)) and name ilike '%'||left(coalesce(p->>'q',''),100)||'%';
    select coalesce(jsonb_agg(jsonb_build_object('id',x.tenant_id,'name',x.name,'timeZone',x.time_zone) order by x.tenant_id),'[]') into result
     from(select tenant_id,name,time_zone from public.sms_businesses where (c.all_businesses or tenant_id=any(c.business_ids)) and name ilike '%'||left(coalesce(p->>'q',''),100)||'%' order by tenant_id limit size offset (pg-1)*size)x;
    data:=jsonb_build_object('businesses',result,'total',total,'page',pg,'pageSize',size);
   elsif tool in ('crm_search_customers','crm_get_customer') then
    pg:=greatest(1,least(coalesce((p->>'page')::integer,1),100000));size:=greatest(1,least(coalesce((p->>'pageSize')::integer,25),100));
    with eligible as materialized (
     select a.id,a.clerk_display_name,a.clerk_primary_email,a.status,a.onboarding_completed_at from public.dashboard_accounts a
     where exists(select from public.platform_account_identities i cross join public.platform_runtime r where i.account_id=a.id and i.issuer=r.customer_issuer and i.deleted_at is null)
      and ('global_customer_lookup'=any(c.permissions) or exists(select from public.platform_business_memberships m where m.account_id=a.id and m.enabled and (c.all_businesses or m.tenant_id=any(c.business_ids))))
      and (tool<>'crm_get_customer' or a.id=(p->>'accountId')::uuid)
      and (tool<>'crm_search_customers' or concat_ws(' ',a.clerk_display_name,a.clerk_primary_email) ilike '%'||left(coalesce(p->>'q',''),100)||'%')
    ), page_rows as(select * from eligible order by id limit size offset (pg-1)*size)
    select (select count(*) from eligible),coalesce(jsonb_agg(jsonb_build_object('id',a.id,'name',a.clerk_display_name,'email',a.clerk_primary_email,'status',a.status,
     'onboardingCompletedAt',a.onboarding_completed_at,'businesses',coalesce((select jsonb_agg(jsonb_build_object('id',b.tenant_id,'name',b.name) order by b.tenant_id) from public.sms_businesses b
      where (c.all_businesses or b.tenant_id=any(c.business_ids)) and exists(select from public.platform_business_memberships m where m.tenant_id=b.tenant_id and m.account_id=a.id and m.enabled)),'[]')) order by a.id),'[]')
     into total,result from page_rows a;
    if tool='crm_get_customer' and total=0 then raise exception 'Customer unavailable' using errcode='42501'; end if;
    data:=case when tool='crm_get_customer' then jsonb_build_object('customer',result->0) else jsonb_build_object('customers',result,'total',total,'page',pg,'pageSize',size) end;
   else
    if jsonb_typeof(p->'idempotencyKey') is distinct from 'string' or key is null or length(key) not between 8 and 128 then raise exception 'An idempotency key of 8 to 128 characters is required'; end if;
    fingerprint:=encode(sha256(convert_to((p-'idempotencyKey')::text,'UTF8')),'hex');
    select * into prior from sms_private.mcp_requests where connection_id=c.id and idempotency_key=key;
    if found then
     if prior.tool<>tool or prior.fingerprint<>fingerprint then raise exception 'Idempotency key was used for a different request' using errcode='40001'; end if;
     data:=prior.result;replay:=true;
    else
     if tool in ('crm_set_form_email_enabled','crm_save_email_group','crm_set_email_group_enabled','crm_resolve_email_enrollment','crm_retry_email_job') then
      data:=sms_private.mcp_email_action(u,t,tool,p,c.id,request_id);
     elsif tool in ('crm_prepare_knowledge_upload','crm_create_knowledge_source','crm_refresh_knowledge_source','crm_archive_knowledge_source','crm_approve_knowledge_version','crm_save_ai_configuration','crm_set_ai_mode') then
      data:=sms_private.mcp_knowledge_action(u,t,tool,p,c.id,request_id);
     elsif tool in ('crm_create_booking_schedule','crm_update_booking_schedule','crm_set_booking_schedule_enabled','crm_update_booking_intake','crm_cancel_booking') then
      data:=sms_private.mcp_booking_action(u,t,tool,p,c.id,request_id);
     elsif tool in ('crm_duplicate_form','crm_archive_form','crm_restore_form','crm_archive_sms_template','crm_save_sms_preset') then
      data:=sms_private.mcp_form_lifecycle(u,t,tool,p,c.id,request_id);
     elsif tool in ('crm_pause_conversation_ai','crm_resume_conversation_ai','crm_reassign_conversation_message','crm_retry_handoff_alert','crm_create_activity_tag','crm_update_activity_tag','crm_set_enquiry_tag','crm_link_enquiry_booking','crm_link_enquiry_response','crm_link_enquiry_activity') then
      data:=sms_private.mcp_activity_action(u,t,tool,p,c.id);
     elsif tool in ('crm_create_contact','crm_update_contact','crm_record_contact_sms_opt_in','crm_suppress_contact_sms','crm_set_contact_automation_blocked','crm_send_contact_sms') then
      data:=sms_private.mcp_contact_action(u,t,tool,p,c.id);
     elsif tool='crm_reply_to_conversation' then
      data:=sms_private.mcp_conversation_reply(u,t,p,c.id);
     elsif tool='crm_mark_conversation_messages_read' then
      data:=sms_private.mcp_conversation_mark_read(u,t,p);
     elsif tool in ('crm_assign_lead','crm_set_lead_status','crm_assign_handoff','crm_set_handoff_status') then
      data:=sms_private.mcp_lead_handoff_write(u,t,tool,p);
     elsif tool='crm_set_form_collection_enabled' then
      data:=sms_private.mcp_form_collection(u,t,p,c.id,request_id);
     elsif tool='crm_apply_form_draft' then
      data:=sms_private.mcp_form_apply(u,t,p,c.id);
     elsif tool in ('crm_create_form','crm_save_form_draft') then
      data:=sms_private.mcp_form_draft(u,t,tool,p,c.id);
     elsif tool in ('crm_resume_sms_run','crm_pause_sms_run','crm_stop_sms_run') then
      data:=sms_private.mcp_sms_control(u,t,tool,p,c.id);
     elsif tool='crm_start_sms_automation_run' then
      data:=sms_private.mcp_sms_start(u,t,p,c.id,'automation_run_pause_stop'=any(c.permissions));
     elsif tool in ('crm_publish_sms_automation','crm_set_form_followups_enabled') then
      data:=sms_private.mcp_sms_release(u,t,tool,p,c.id);
     elsif tool in ('crm_create_sms_automation','crm_save_sms_automation_draft') then
      data:=sms_private.mcp_sms_draft(u,t,tool,p,c.id);
     else
     action:=case tool when 'crm_save_business_profile_draft' then 'business_profile_draft' when 'crm_review_business_profile' then 'business_profile_review'
      when 'crm_add_business_service' then 'service_add' when 'crm_set_service_visibility' then 'service_visibility' end;
     allowed_keys:=case when action in ('business_profile_draft','business_profile_review') then array['businessId','idempotencyKey','revision','profile']
      when action='service_add' then array['businessId','idempotencyKey','kind','siteId','siteRevision'] else array['businessId','idempotencyKey','serviceId','revision','visibility'] end;
     if exists(select from jsonb_object_keys(p) key_name where not key_name=any(allowed_keys)) then raise exception 'Unexpected input field'; end if;
     if action='service_add' and p->>'kind'='website' and not exists(select from public.hosting_sites where id=(p->>'siteId')::uuid and sms_tenant_id=t)
      then raise exception 'Website must already be linked to the permitted business' using errcode='42501'; end if;
     if action='service_visibility' and not exists(select from public.platform_business_services where id=(p->>'serviceId')::uuid and tenant_id=t)
      then raise exception 'Service access denied' using errcode='42501'; end if;
     result:=sms_private.platform_action(u,action,(p-'businessId'-'idempotencyKey')||jsonb_build_object('tenantId',t));
     data:=jsonb_build_object('record',result,'businessId',t,'databaseStatus','committed',
      'providerSetup',case when action='service_add' and p->>'kind'='sms' then
       jsonb_build_object('state',(select provisioning_state from sms_private.providers where tenant_id=t),
        'jobs',coalesce((select jsonb_agg(jsonb_build_object('id',j.id,'status',j.status) order by j.created_at desc,j.id) from
         (select id,status,created_at from sms_private.jobs where tenant_id=t and queue='provisioning_jobs' order by created_at desc,id limit 20) j),'[]'))
       else null end);
     end if;
     insert into sms_private.mcp_requests(connection_id,idempotency_key,tool,fingerprint,result) values(c.id,key,tool,fingerprint,data);
    end if;
   end if;
  end if;
  result:=jsonb_build_object('ok',true,'data',data);
 exception when others then
  get stacked diagnostics state=returned_sqlstate,error_message=message_text;
  error_code:=case when state='42501' then 'PERMISSION_DENIED' when state in ('23505','40001') then 'CONFLICT' when left(state,2)='22' or state in ('P0001','23514','23502','P0002') then 'VALIDATION_ERROR' else 'TEMPORARY_FAILURE' end;
  if error_code='TEMPORARY_FAILURE' then error_message:='Service temporarily unavailable. Retry with the same idempotency key.'; end if;
  result:=jsonb_build_object('ok',false,'error',jsonb_build_object('code',error_code,'message',error_message,'retryable',error_code='TEMPORARY_FAILURE'));
 end;
 insert into sms_private.mcp_activity(connection_id,actor_id,tool,target,request_id,outcome,code,revision,draft_revision,previous_revision,changed_fields,affected_message_ids,affected_message_count)
  values(c.id,aid,left(tool,100),left(coalesce(data->>'bookingId',data->>'intakeId',data->>'scheduleId',data->>'formId',data->>'presetId',data->>'automationId',data->>'tagId',data->>'runId',data->>'handoffId',data->>'conversationId',data->>'contactId',data->'contact'->>'id',data->'conversation'->>'id',data->'lead'->>'id',data->'handoff'->>'id',data->'enquiry'->>'id',data->'form'->>'id',data->'run'->>'id',data->'automation'->>'id',target),255),request_id,case when error_code is not null then 'denied' when replay then 'replayed' else 'success' end,error_code,
   case when error_code is null then coalesce((data->>'revision')::bigint,(data->'contact'->>'revision')::bigint,(data->'conversation'->>'revision')::bigint,(data->'lead'->>'revision')::bigint,(data->'handoff'->>'revision')::bigint,(data->'enquiryStatus'->'sms'->>'generation')::bigint,(data->'enquiryStatus'->>'submittedFormVersion')::bigint,(data->'enquiry'->>'submittedFormVersion')::bigint,(data->'form'->>'revision')::bigint,(data->'run'->>'generation')::bigint,(data->'source'->>'revision')::bigint,(data->'automation'->>'revision')::bigint,(data->'record'->>'revision')::bigint,(data->'business'->'setup'->>'revision')::bigint) end,
   case when error_code is null then coalesce(nullif(data->>'draftRevision','0'),data->'form'->>'draftRevision')::bigint end,
   case when error_code is null and tool in ('crm_set_form_email_enabled','crm_save_email_group','crm_set_email_group_enabled','crm_resolve_email_enrollment','crm_retry_email_job','crm_prepare_knowledge_upload','crm_create_knowledge_source','crm_refresh_knowledge_source','crm_archive_knowledge_source','crm_approve_knowledge_version','crm_save_ai_configuration','crm_set_ai_mode','crm_create_booking_schedule','crm_update_booking_schedule','crm_set_booking_schedule_enabled','crm_update_booking_intake','crm_cancel_booking','crm_duplicate_form','crm_archive_form','crm_restore_form','crm_archive_sms_template','crm_save_sms_preset','crm_pause_conversation_ai','crm_resume_conversation_ai','crm_reassign_conversation_message','crm_retry_handoff_alert','crm_create_activity_tag','crm_update_activity_tag','crm_set_enquiry_tag','crm_link_enquiry_booking','crm_link_enquiry_response','crm_link_enquiry_activity','crm_create_contact','crm_update_contact','crm_record_contact_sms_opt_in','crm_suppress_contact_sms','crm_set_contact_automation_blocked','crm_send_contact_sms','crm_reply_to_conversation','crm_mark_conversation_messages_read','crm_assign_lead','crm_set_lead_status','crm_assign_handoff','crm_set_handoff_status') then (data->>'previousRevision')::bigint end,
   case when error_code is null and tool in ('crm_assign_lead','crm_set_lead_status','crm_assign_handoff','crm_set_handoff_status') then array(select jsonb_array_elements_text(data->'changedFields')) end,
   case when error_code is null and tool in ('crm_reply_to_conversation','crm_send_contact_sms') then array[(data->>'messageId')::uuid] when error_code is null and tool='crm_mark_conversation_messages_read' then array(select x::uuid from jsonb_array_elements_text(data->'changedMessageIds') x) end,
   case when error_code is null and tool in ('crm_reply_to_conversation','crm_send_contact_sms') then 1 when error_code is null and tool='crm_mark_conversation_messages_read' then (data->>'changedCount')::integer end);
 if error_code is null and tool='crm_start_sms_automation_run' then
  insert into sms_private.mcp_activity(connection_id,actor_id,tool,target,request_id,outcome,revision)
   select c.id,aid,'crm_start_sms_automation_run:replace',v->>'id',request_id,case when replay then 'replayed' else 'success' end,(v->>'generation')::bigint from jsonb_array_elements(data->'stoppedRuns') v;
 end if;
 if error_code is null and data ? 'relatedRecord' then
  insert into sms_private.mcp_activity(connection_id,actor_id,tool,target,request_id,outcome,revision,previous_revision)
   values(c.id,aid,tool||':related',data->'relatedRecord'->>'id',request_id,case when replay then 'replayed' else 'success' end,(data->'relatedRecord'->>'revision')::bigint,(data->'relatedRecord'->>'previousRevision')::bigint);
 end if;
 if error_code is null and tool='crm_reassign_conversation_message' then
  insert into sms_private.mcp_activity(connection_id,actor_id,tool,target,request_id,outcome,revision,previous_revision,affected_message_ids,affected_message_count)
   values(c.id,aid,tool||':target',data->>'targetConversationId',request_id,case when replay then 'replayed' else 'success' end,(data->>'targetRevision')::bigint,(p->>'targetRevision')::bigint,array[(data->>'messageId')::uuid],case when (data->>'changed')::boolean then 1 else 0 end);
 end if;
 return result;
end $$;
