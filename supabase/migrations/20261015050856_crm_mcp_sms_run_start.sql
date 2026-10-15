-- CRM-owned forward migration after pending SMS publication/enabling.
-- No existing grants, consent, runs or sending settings change on application.
-- Historical enrollment must use the same phone-before-form lock order as
-- public submissions and MCP starts; retain existing standalone run guards.
create or replace function sms_private.form_workspace(u text,t text,action text,fid uuid default null,p jsonb default '{}') returns jsonb
language plpgsql security definer set search_path='' as $$
declare r sms_private.form_runs; f public.sms_web_form_definitions; ph text;begin
 if action in ('pause','resume','stop') then
  perform sms_private.require_sms_reader(u,t);perform sms_private.require_admin(u);
  select * into r from sms_private.form_runs where tenant_id=t and form_id=fid and id=(p->>'runId')::uuid;
  perform sms_private.coordination_lock(t,r.phone);
  if action='resume' and exists(select from public.sms_contacts where tenant_id=t and phone=r.phone and (enquiry_blocked and r.appointment_at is null or opted_out)) then raise exception 'Contact follow-ups blocked or STOP suppressed';end if;
 elsif action='enroll' then
  perform sms_private.require_sms_reader(u,t);perform sms_private.require_admin(u);
  select * into f from public.sms_web_form_definitions where tenant_id=t and public_id=fid;
  if not found then raise exception 'Form unavailable' using errcode='42501';end if;
  execute format('select phone from public.%I where tenant_id=$1 and form_public_id=$2 and id=$3',sms_private.web_form_table(f.preset)) into ph using t,fid,(p->>'submissionId')::uuid;
  if ph is null then raise exception 'Submission unavailable' using errcode='42501';end if;
  perform sms_private.coordination_lock(t,ph);
 end if;
 return sms_private.form_workspace_before_direct(u,t,action,fid,p);
end $$;

create function sms_private.mcp_sms_run_summary(r sms_private.form_runs) returns jsonb
language sql immutable set search_path='' as $$
 select case when r.id is null then null else jsonb_build_object('id',r.id,'status',r.status,'generation',r.generation,'publishedVersion',r.version,'nextRunAt',r.next_run_at) end
$$;

create function sms_private.mcp_sms_start_context(u text,t text,p jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare x record; f public.sms_web_form_definitions; c public.sms_contacts; r sms_private.form_runs;
 row_data jsonb; cfg jsonb; ph text; appt timestamptz; v_overlaps jsonb; fingerprint text;
begin
 perform sms_private.require_sms_reader(u,t);
 if jsonb_typeof(p) is distinct from 'object' or coalesce(p->>'kind','') not in ('form','contact') then raise exception 'Choose a run kind'; end if;
 if exists(select from jsonb_object_keys(p) n where not n=any(array['businessId','kind','automationId','contactId','submissionId'])) then raise exception 'Unexpected input field'; end if;
 select * into x from sms_private.mcp_sms_catalog(t) v where v.kind=p->>'kind' and v.id=(p->>'automationId')::uuid;
 if not found then raise exception 'Automation unavailable' using errcode='42501'; end if;
 if x.kind='contact' then
  if p ? 'submissionId' then raise exception 'Contact starts require contactId only'; end if;
  select * into c from public.sms_contacts where tenant_id=t and id=(p->>'contactId')::uuid;
  if not found then raise exception 'Contact unavailable' using errcode='42501'; end if;
  ph:=c.phone;
 else
  if p ? 'contactId' then raise exception 'Form starts require submissionId only'; end if;
  select * into f from public.sms_web_form_definitions where tenant_id=t and public_id=x.id;
  execute format('select to_jsonb(s) from public.%I s where tenant_id=$1 and form_public_id=$2 and id=$3',sms_private.web_form_table(f.preset)) into row_data using t,f.public_id,(p->>'submissionId')::uuid;
  if row_data is null then raise exception 'Submission unavailable' using errcode='42501'; end if;
  fingerprint:=encode(sha256(convert_to(row_data::text,'UTF8')),'hex');ph:=row_data->>'phone';
  select * into c from public.sms_contacts where tenant_id=t and phone=ph;
  select sequence into cfg from sms_private.form_sequence_versions where tenant_id=t and form_id=f.public_id and version=x.published_version;
  if cfg->>'trigger'='appointment' then appt:=(row_data->>'appointment_at')::timestamptz; end if;
  select * into r from sms_private.form_runs where tenant_id=t and form_id=f.public_id and submission_id=(p->>'submissionId')::uuid and origin='form';
 end if;
 select coalesce(jsonb_agg(jsonb_build_object('id',v.id,'generation',v.generation) order by v.id),'[]') into v_overlaps
 from (select id,generation from sms_private.form_runs where tenant_id=t and phone=ph and appointment_at is not distinct from appt and status in ('active','paused') order by id limit 101) v;
 if jsonb_array_length(v_overlaps)>100 then raise exception 'Too many overlapping runs; manage them in the CRM first'; end if;
 return jsonb_build_object('businessId',t,'automation',sms_private.mcp_sms_summary(to_jsonb(x)),'contactId',c.id,'contactRevision',c.revision,
  'submissionFingerprint',fingerprint,'overlaps',v_overlaps,'existingRun',sms_private.mcp_sms_run_summary(r));
end $$;

create function sms_private.mcp_sms_start(u text,t text,p jsonb,connection uuid,can_stop boolean) returns jsonb
language plpgsql security definer set search_path='' as $$
declare f public.sms_web_form_definitions; c public.sms_contacts; d sms_private.direct_templates; s sms_private.form_sequences; r sms_private.form_runs;
 info jsonb; target jsonb; row_data jsonb; cfg jsonb; ph text; inner_key text; appt timestamptz; existing jsonb; selected uuid;
 stopped jsonb:='[]'; result jsonb; expected_overlaps jsonb; entry jsonb; n text;
begin
 perform sms_private.require_sms_reader(u,t);perform sms_private.require_admin(u);
 if jsonb_typeof(p) is distinct from 'object' or coalesce(p->>'kind','') not in ('form','contact') then raise exception 'Choose a run kind'; end if;
 if exists(select from jsonb_object_keys(p) key_name where not key_name=any(array['businessId','kind','automationId','contactId','submissionId','revision','formRevision','contactRevision','submissionFingerprint','overlaps','overlapChoice','stopRunIds','context','startAt','idempotencyKey'])) then raise exception 'Unexpected input field'; end if;
 foreach n in array array['revision','contactRevision'] loop
  if n='contactRevision' and p->'contactRevision'='null' then continue; end if;
  if jsonb_typeof(p->n) is distinct from 'number' then raise exception 'Current revisions required'; end if;
  if (p->>n)::numeric<0 or (p->>n)::numeric<>trunc((p->>n)::numeric) then raise exception 'Invalid revision'; end if;
 end loop;
 if jsonb_typeof(p->'overlaps') is distinct from 'array' or jsonb_typeof(coalesce(p->'stopRunIds','[]')) is distinct from 'array' then raise exception 'Overlap references required'; end if;
 if jsonb_array_length(p->'overlaps')>100 or jsonb_array_length(coalesce(p->'stopRunIds','[]'))>100 then raise exception 'Too many overlap references'; end if;
 for entry in select value from jsonb_array_elements(p->'overlaps') loop
  if jsonb_typeof(entry) is distinct from 'object' or not entry ?& array['id','generation'] or exists(select from jsonb_object_keys(entry) key_name where key_name not in ('id','generation')) then raise exception 'Invalid overlap reference'; end if;
  if jsonb_typeof(entry->'id') is distinct from 'string' or jsonb_typeof(entry->'generation') is distinct from 'number' then raise exception 'Invalid overlap reference'; end if;
  perform (entry->>'id')::uuid;
  if (entry->>'generation')::numeric<0 or (entry->>'generation')::numeric<>trunc((entry->>'generation')::numeric) then raise exception 'Invalid overlap generation'; end if;
 end loop;
 if (select count(distinct v->>'id') from jsonb_array_elements(p->'overlaps') v)<>jsonb_array_length(p->'overlaps') then raise exception 'Duplicate overlap references'; end if;
 select coalesce(jsonb_agg(v order by v->>'id'),'[]') into expected_overlaps from jsonb_array_elements(p->'overlaps') v;
 if coalesce(p->>'overlapChoice','') not in ('keep','stop_selected') then raise exception 'Explicit overlap choice required'; end if;
 if p->>'overlapChoice'='keep' and coalesce(p->'stopRunIds','[]')<>'[]' then raise exception 'Keep cannot stop runs'; end if;
 if p->>'overlapChoice'='stop_selected' and (not can_stop or can_stop is null) then raise exception 'Stopping overlapping runs is not granted' using errcode='42501'; end if;
 if p->>'overlapChoice'='stop_selected' and jsonb_array_length(coalesce(p->'stopRunIds','[]'))=0 then raise exception 'Select runs to stop'; end if;
 for entry in select value from jsonb_array_elements(coalesce(p->'stopRunIds','[]')) loop
  if jsonb_typeof(entry) is distinct from 'string' then raise exception 'Invalid stop reference'; end if;perform (entry #>> '{}')::uuid;
 end loop;
 if (select count(distinct v) from jsonb_array_elements(coalesce(p->'stopRunIds','[]')) v)<>jsonb_array_length(coalesce(p->'stopRunIds','[]')) then raise exception 'Duplicate stop references'; end if;
 if p ? 'context' and (jsonb_typeof(p->'context')<>'string' or length(p->>'context')>2500) then raise exception 'Invalid context'; end if;
 if p ? 'startAt' then
  if jsonb_typeof(p->'startAt')<>'string' or p->>'startAt' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]+)?(Z|[+-][0-9]{2}:[0-9]{2})$' then raise exception 'Use an explicit start timestamp with timezone'; end if;
  perform (p->>'startAt')::timestamptz;
 end if;
 target:=jsonb_build_object('businessId',t,'kind',p->>'kind','automationId',p->'automationId')||case when p->>'kind'='form' then jsonb_build_object('submissionId',p->'submissionId') else jsonb_build_object('contactId',p->'contactId') end;
 info:=sms_private.mcp_sms_start_context(u,t,target);
 if p->>'kind'='contact' then
  if p ?| array['formRevision','submissionId','submissionFingerprint'] then raise exception 'Invalid contact start fields'; end if;
  select phone into ph from public.sms_contacts where tenant_id=t and id=(p->>'contactId')::uuid;
  inner_key:='mcp:'||connection::text||':'||encode(sha256(convert_to(p->>'idempotencyKey','UTF8')),'hex');
  perform pg_advisory_xact_lock(hashtextextended(t||':direct-operation:'||inner_key,419));
 else
  if p ?| array['contactId','context','startAt'] then raise exception 'Form starts use recorded submission values and canonical scheduling'; end if;
  select * into f from public.sms_web_form_definitions where tenant_id=t and public_id=(p->>'automationId')::uuid;
  execute format('select to_jsonb(v) from public.%I v where tenant_id=$1 and form_public_id=$2 and id=$3',sms_private.web_form_table(f.preset)) into row_data using t,f.public_id,(p->>'submissionId')::uuid;ph:=row_data->>'phone';
 end if;
 -- Match canonical enrollment: phone coordination precedes contact and source locks.
 perform sms_private.coordination_lock(t,ph);
 select * into c from public.sms_contacts where tenant_id=t and phone=ph for update;
 if p->>'kind'='contact' then
  select * into d from sms_private.direct_templates where tenant_id=t and id=(p->>'automationId')::uuid for share;
 else
  select * into f from public.sms_web_form_definitions where tenant_id=t and public_id=f.public_id for update;
  select * into s from sms_private.form_sequences where tenant_id=t and form_id=f.public_id for update;
  execute format('select to_jsonb(v) from public.%I v where tenant_id=$1 and form_public_id=$2 and id=$3 for share',sms_private.web_form_table(f.preset)) into row_data using t,f.public_id,(p->>'submissionId')::uuid;
  if row_data->>'phone' is distinct from ph then raise exception 'Submission changed; reread start context' using errcode='40001'; end if;
 end if;
 info:=sms_private.mcp_sms_start_context(u,t,target);
 if (info->'automation'->>'revision')::numeric is distinct from (p->>'revision')::numeric or info->'contactRevision' is distinct from p->'contactRevision' then raise exception 'Source or contact changed; reread start context' using errcode='40001'; end if;
 if p->>'kind'='form' then
  if jsonb_typeof(p->'formRevision') is distinct from 'number' or jsonb_typeof(p->'submissionFingerprint') is distinct from 'string' then raise exception 'Form revision and submission fingerprint required'; end if;
  if (p->>'formRevision')::numeric is distinct from f.version::numeric or p->>'submissionFingerprint' is distinct from info->>'submissionFingerprint' then raise exception 'Form or submission changed; reread start context' using errcode='40001'; end if;
 end if;
 if coalesce((info->'automation'->>'archived')::boolean,true) or info->'automation'->'publishedVersion'='null' then raise exception 'Published active automation required'; end if;
 -- Serialize overlapping run generations against canonical staff/run workers.
 perform 1 from sms_private.form_runs where tenant_id=t and phone=ph and id in (select (v->>'id')::uuid from jsonb_array_elements(info->'overlaps') v) order by id for update;
 info:=sms_private.mcp_sms_start_context(u,t,target);
 if info->'overlaps'<>expected_overlaps then raise exception 'Existing automations changed; review overlaps' using errcode='40001'; end if;
 if p->>'kind'='form' and info->'existingRun'<>'null' then
  return jsonb_build_object('businessId',t,'run',info->'existingRun','databaseStatus','committed','effect','already_enrolled','stoppedRuns','[]'::jsonb,'deliveryStatus','not_sent_by_this_operation');
 end if;
 if c.id is not null and (c.opted_out or not c.marketing_consent) then raise exception 'Recorded SMS consent required; STOP cannot be overridden'; end if;
 if not exists(select from public.sms_businesses where tenant_id=t and sending_enabled and status='active') then raise exception 'Business sending is disabled or inactive'; end if;
 if p->>'kind'='form' then
  if not f.enabled or not coalesce(s.enabled,false) then raise exception 'Enable the form and follow-ups first'; end if;
  if not coalesce((row_data->>'sms_opt_in')::boolean,false) then raise exception 'Submission SMS consent required'; end if;
  select sequence into cfg from sms_private.form_sequence_versions where tenant_id=t and form_id=f.public_id and version=s.published_version;
  perform sms_private.mcp_sms_validate_sequence(cfg,'form',f.fields,f.preset);
  if cfg->>'trigger'='appointment' then
   appt:=(row_data->>'appointment_at')::timestamptz;
   if appt is null or appt<=now() then raise exception 'Appointment must still be in the future'; end if;
  elsif coalesce(c.enquiry_blocked,false) then raise exception 'Contact enquiry follow-ups are blocked'; end if;
 end if;
 for selected in select value::uuid from jsonb_array_elements_text(coalesce(p->'stopRunIds','[]')) loop
  if not exists(select from jsonb_array_elements(info->'overlaps') v where v->>'id'=selected::text) then raise exception 'Run outside overlap scope' using errcode='42501'; end if;
 end loop;
 if p->>'kind'='contact' then
  result:=sms_private.contact_automations(u,t,'enroll',jsonb_build_object('contactId',c.id,'contactRevision',c.revision,'templateId',d.id,'templateRevision',d.revision,
   'overlaps',expected_overlaps,'overlapChoice',p->'overlapChoice','stopRunIds',coalesce(p->'stopRunIds','[]'),'context',coalesce(p->>'context',''),'idempotencyKey',inner_key)
   ||case when p ? 'startAt' then jsonb_build_object('startAt',p->'startAt') else '{}'::jsonb end);
  select * into r from sms_private.form_runs where tenant_id=t and id=(result->'run'->>'id')::uuid;
 else
  -- A same-form active/paused run would make canonical enrollment skip; surface
  -- that conflict before stopping anything unless the caller explicitly replaces it.
  if exists(select from sms_private.form_runs where tenant_id=t and form_id=f.public_id and phone=ph and appointment_at is not distinct from appt and test_sequence is null and status in ('active','paused') and not id=any(array(select value::uuid from jsonb_array_elements_text(coalesce(p->'stopRunIds','[]'))))) then raise exception 'This form already has a run for the recipient; select it for replacement or use the existing run' using errcode='40001'; end if;
  update sms_private.form_runs set status='stopped',reason='REPLACED_BY_STAFF',generation=generation+1,next_run_at=null where tenant_id=t and id=any(array(select value::uuid from jsonb_array_elements_text(coalesce(p->'stopRunIds','[]'))));
  perform sms_private.form_workspace(u,t,'enroll',f.public_id,jsonb_build_object('submissionId',p->'submissionId'));
  select * into r from sms_private.form_runs where tenant_id=t and form_id=f.public_id and submission_id=(p->>'submissionId')::uuid and origin='form';
  if not found then raise exception 'Enrollment conditions changed; reread start context' using errcode='40001'; end if;
 end if;
 select coalesce(jsonb_agg(jsonb_build_object('id',v.id,'generation',v.generation) order by v.id),'[]') into stopped from sms_private.form_runs v where v.tenant_id=t and v.id=any(array(select value::uuid from jsonb_array_elements_text(coalesce(p->'stopRunIds','[]'))));
 return jsonb_build_object('businessId',t,'run',sms_private.mcp_sms_run_summary(r),'databaseStatus','committed','effect','run_scheduled','stoppedRuns',stopped,'deliveryStatus','not_sent_by_this_operation');
exception when invalid_datetime_format or datetime_field_overflow then raise exception 'Invalid run start date';
end $$;

revoke all on function sms_private.mcp_sms_run_summary(sms_private.form_runs),sms_private.mcp_sms_start_context(text,text,jsonb),sms_private.mcp_sms_start(text,text,jsonb,uuid,boolean) from public,anon,authenticated,sms_api,crm_mcp;

create or replace function sms_private.mcp_invoke(u text,client text,tool text,p jsonb,request_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare aid uuid; c sms_private.mcp_connections; result jsonb; data jsonb; required_permission text; action text;
 t text:=p->>'businessId'; target text:=coalesce(p->>'automationId',p->>'formId',p->>'businessId',p->>'accountId');
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
   required_permission:=case tool when 'crm_search_customers' then 'read' when 'crm_get_customer' then 'read'
    when 'crm_create_sms_automation' then 'automation_draft' when 'crm_save_sms_automation_draft' then 'automation_draft'
    when 'crm_get_sms_run_start_context' then 'automation_read' when 'crm_start_sms_automation_run' then 'automation_run_start'
    when 'crm_preview_sms_automation' then 'automation_preview'
    when 'crm_publish_sms_automation' then 'automation_publish' when 'crm_set_form_followups_enabled' then 'automation_enable'
    when 'crm_list_sms_automations' then 'automation_read' when 'crm_get_sms_automation' then 'automation_read'
    when 'crm_search_sms_contacts' then 'automation_read' when 'crm_list_form_submissions' then 'automation_read'
    when 'crm_list_businesses' then 'read' when 'crm_get_business' then 'read'
    when 'crm_save_business_profile_draft' then 'draft' when 'crm_review_business_profile' then 'review'
    when 'crm_add_business_service' then 'service_add' when 'crm_set_service_visibility' then 'visibility' end;
   if required_permission is null or not required_permission=any(c.permissions) then raise exception 'Action is not granted' using errcode='42501'; end if;
   if tool in ('crm_get_sms_run_start_context','crm_start_sms_automation_run','crm_publish_sms_automation','crm_set_form_followups_enabled','crm_create_sms_automation','crm_save_sms_automation_draft','crm_preview_sms_automation','crm_list_sms_automations','crm_get_sms_automation','crm_search_sms_contacts','crm_list_form_submissions','crm_get_business','crm_save_business_profile_draft','crm_review_business_profile','crm_add_business_service','crm_set_service_visibility')
    and (t is null or (not c.all_businesses and not t=any(c.business_ids)) or not exists(select from public.sms_businesses where tenant_id=t)) then raise exception 'Business access denied' using errcode='42501'; end if;
   if tool='crm_start_sms_automation_run' and p->>'overlapChoice'='stop_selected' and not 'automation_run_pause_stop'=any(c.permissions) then raise exception 'Stopping overlapping runs is not granted' using errcode='42501'; end if;
   if tool='crm_get_sms_run_start_context' then
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
     if tool='crm_start_sms_automation_run' then
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
  error_code:=case when state='42501' then 'PERMISSION_DENIED' when state in ('23505','40001') then 'CONFLICT' when state in ('P0001','22P02','22023','23514','23502','P0002') then 'VALIDATION_ERROR' else 'TEMPORARY_FAILURE' end;
  if error_code='TEMPORARY_FAILURE' then error_message:='Service temporarily unavailable. Retry with the same idempotency key.'; end if;
  result:=jsonb_build_object('ok',false,'error',jsonb_build_object('code',error_code,'message',error_message,'retryable',error_code='TEMPORARY_FAILURE'));
 end;
 insert into sms_private.mcp_activity(connection_id,actor_id,tool,target,request_id,outcome,code,revision)
  values(c.id,aid,left(tool,100),left(coalesce(data->'run'->>'id',data->'automation'->>'id',target),255),request_id,case when error_code is not null then 'denied' when replay then 'replayed' else 'success' end,error_code,
   case when error_code is null then coalesce((data->'run'->>'generation')::bigint,(data->'source'->>'revision')::bigint,(data->'automation'->>'revision')::bigint,(data->'record'->>'revision')::bigint,(data->'business'->'setup'->>'revision')::bigint) end);
 if error_code is null and tool='crm_start_sms_automation_run' then
  insert into sms_private.mcp_activity(connection_id,actor_id,tool,target,request_id,outcome,revision)
   select c.id,aid,'crm_start_sms_automation_run:replace',v->>'id',request_id,case when replay then 'replayed' else 'success' end,(v->>'generation')::bigint from jsonb_array_elements(data->'stoppedRuns') v;
 end if;
 return result;
end $$;
