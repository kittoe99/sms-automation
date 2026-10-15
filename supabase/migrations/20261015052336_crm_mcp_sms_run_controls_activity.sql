-- CRM-owned step 5; follows the four pending SMS MCP migrations in timestamp order.
-- No new customer grants. Private helpers are reachable only through mcp_invoke.
create index mcp_runs_business_created on sms_private.form_runs(tenant_id,created_at desc,id desc);
create index mcp_messages_run on public.sms_messages(tenant_id,(meta->>'form_run_id')) where direction='outbound';
create function sms_private.mcp_sms_run_detail(r sms_private.form_runs) returns jsonb
language sql stable set search_path='' as $$
 select sms_private.mcp_sms_run_summary(r)||jsonb_build_object(
  'kind',case when r.origin='direct' then 'contact' else 'form' end,
  'automationId',coalesce(r.direct_template_id,r.form_id),'contactId',c.id,'contactRevision',c.revision,
  'createdAt',r.created_at,'appointmentAt',r.appointment_at,'test',r.test_sequence is not null)
 from (select 1) seed left join public.sms_contacts c on c.tenant_id=r.tenant_id and c.phone=r.phone;
$$;

create function sms_private.mcp_sms_activity(u text,t text,tool text,p jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare r sms_private.form_runs; pg integer; size integer; total bigint; items jsonb; counts jsonb; allowed text[];
begin
 perform sms_private.require_sms_reader(u,t);
 allowed:=case when tool='crm_list_sms_runs' then array['businessId','page','pageSize','kind','automationId','contactId','status']
  when tool='crm_get_sms_run' then array['businessId','runId'] else array['businessId','runId','page','pageSize'] end;
 if jsonb_typeof(p) is distinct from 'object' or exists(select from jsonb_object_keys(p) k where not k=any(allowed)) then raise exception 'Unexpected input field'; end if;
 foreach items in array array[p->'page',p->'pageSize'] loop
  if items is not null and (jsonb_typeof(items)<>'number' or items::numeric<>trunc(items::numeric)) then raise exception 'Invalid pagination'; end if;
 end loop;
 pg:=coalesce((p->>'page')::integer,1);size:=coalesce((p->>'pageSize')::integer,25);
 if pg not between 1 and 100000 or size not between 1 and 100 then raise exception 'Pagination out of range'; end if;
 if tool='crm_list_sms_runs' then
  if p ? 'kind' and coalesce(p->>'kind','') not in ('form','contact') or p ? 'status' and coalesce(p->>'status','') not in ('active','paused','stopped','completed') then raise exception 'Invalid run filter'; end if;
  if p ? 'automationId' and not p ? 'kind' then raise exception 'An automation filter also requires kind'; end if;
  if p ? 'automationId' and not exists(select from sms_private.mcp_sms_catalog(t) where kind=p->>'kind' and id=(p->>'automationId')::uuid) then raise exception 'Automation unavailable' using errcode='42501'; end if;
  if p ? 'contactId' and not exists(select from public.sms_contacts where tenant_id=t and id=(p->>'contactId')::uuid) then raise exception 'Contact unavailable' using errcode='42501'; end if;
  with eligible as materialized (
   select v.* from sms_private.form_runs v where v.tenant_id=t
    and (not p ? 'kind' or v.origin=case p->>'kind' when 'contact' then 'direct' else 'form' end)
    and (not p ? 'automationId' or coalesce(v.direct_template_id,v.form_id)=(p->>'automationId')::uuid)
    and (not p ? 'contactId' or exists(select from public.sms_contacts c where c.tenant_id=t and c.id=(p->>'contactId')::uuid and c.phone=v.phone))
    and (not p ? 'status' or v.status=p->>'status')
  ), page_rows as(select * from eligible order by created_at desc,id desc limit size offset (pg-1)*size)
  select (select count(*) from eligible),coalesce(jsonb_agg(sms_private.mcp_sms_run_detail(v::sms_private.form_runs) order by v.created_at desc,v.id desc),'[]') into total,items from page_rows v;
  return jsonb_build_object('businessId',t,'runs',items,'total',total,'page',pg,'pageSize',size);
 end if;
 select * into r from sms_private.form_runs where tenant_id=t and id=(p->>'runId')::uuid;
 if r.id is null then raise exception 'Run unavailable' using errcode='42501'; end if;
 if tool='crm_get_sms_run' then return jsonb_build_object('businessId',t,'run',sms_private.mcp_sms_run_detail(r)); end if;
 if tool<>'crm_get_sms_run_activity' then raise exception 'Unknown activity tool'; end if;
 select count(*) into total from sms_private.activity_events where tenant_id=t and run_id=r.id;
 select coalesce(jsonb_agg(jsonb_build_object('id',e.id::text,'kind',e.kind,'occurredAt',e.occurred_at,'recordedAt',e.recorded_at,
  'historical',e.historical,'simulated',e.simulated,'revision',e.revision,
  'fromStatus',case when e.details->>'from' in ('active','paused','stopped','completed') then e.details->>'from' end,
  'status',case when e.details->>'status' in ('active','paused','stopped','completed') then e.details->>'status' end,
  'operation',case when e.details->>'operation' in ('pause','resume','stop') then e.details->>'operation' end) order by e.recorded_at desc,e.id desc),'[]')
 into items from(select * from sms_private.activity_events where tenant_id=t and run_id=r.id order by recorded_at desc,id desc limit size offset (pg-1)*size)e;
 select jsonb_build_object('providerAccepted',count(*) filter(where provider_accepted_at is not null),
  'delivered',count(*) filter(where status='delivered'),'failed',count(*) filter(where status in ('failed','undelivered')),
  'unresolvedSends',(select count(*) from sms_private.jobs j where j.tenant_id=t and j.queue='sms_send_jobs' and j.payload->'request'->>'form_run_id'=r.id::text and j.status in ('submitting','submission_unknown')),
  'responses',(select count(*) from sms_private.activity_responses a join public.sms_messages m on m.tenant_id=a.tenant_id and m.id=a.message_id where a.tenant_id=t and a.run_id=r.id and m.contact_phone=r.phone and m.direction='inbound'))
 into counts from public.sms_messages where tenant_id=t and contact_phone=r.phone and direction='outbound' and meta->>'form_run_id'=r.id::text;
 return jsonb_build_object('businessId',t,'run',sms_private.mcp_sms_run_summary(r),'reportingAt',statement_timestamp(),'events',items,'total',total,'page',pg,'pageSize',size,'counts',counts);
end $$;

create function sms_private.mcp_sms_control(u text,t text,tool text,p jsonb,connection uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare r sms_private.form_runs; c public.sms_contacts; operation text; inner_key text; allowed text[]; ph text; in_flight boolean;
begin
 perform sms_private.require_sms_reader(u,t);perform sms_private.require_admin(u);
 operation:=case tool when 'crm_pause_sms_run' then 'pause' when 'crm_stop_sms_run' then 'stop' when 'crm_resume_sms_run' then 'resume' end;
 if operation is null then raise exception 'Unknown run operation'; end if;
 allowed:=array['businessId','runId','generation','idempotencyKey']||case when operation='resume' then array['contactRevision'] else array[]::text[] end;
 if jsonb_typeof(p) is distinct from 'object' or exists(select from jsonb_object_keys(p) k where not k=any(allowed)) then raise exception 'Unexpected input field'; end if;
 if jsonb_typeof(p->'generation') is distinct from 'number' then raise exception 'Current generation required'; end if;
 if (p->>'generation')::numeric<0 or (p->>'generation')::numeric<>trunc((p->>'generation')::numeric) then raise exception 'Invalid generation'; end if;
 if operation='resume' then
  if jsonb_typeof(p->'contactRevision') is distinct from 'number' then raise exception 'Current contact revision required'; end if;
  if (p->>'contactRevision')::numeric<0 or (p->>'contactRevision')::numeric<>trunc((p->>'contactRevision')::numeric) then raise exception 'Invalid contact revision'; end if;
 end if;
 select * into r from sms_private.form_runs where tenant_id=t and id=(p->>'runId')::uuid;
 if r.id is null then raise exception 'Run unavailable' using errcode='42501'; end if;
 inner_key:='mcp:'||connection::text||':'||encode(sha256(convert_to(p->>'idempotencyKey','UTF8')),'hex');
 -- Same order as canonical direct operations. Form state changes lock source
 -- rows before runs; acquire them before the run to avoid lock inversion.
 perform pg_advisory_xact_lock(hashtextextended(t||':direct-operation:'||inner_key,419));
 ph:=r.phone;perform sms_private.coordination_lock(t,ph);
 select * into c from public.sms_contacts where tenant_id=t and phone=ph for update;
 if r.origin='form' then
  perform 1 from public.sms_web_form_definitions where tenant_id=t and public_id=r.form_id for update;
  perform 1 from sms_private.form_sequences where tenant_id=t and form_id=r.form_id for update;
 end if;
 select * into r from sms_private.form_runs where tenant_id=t and id=r.id for update;
 if r.phone is distinct from ph or r.generation is distinct from (p->>'generation')::numeric then raise exception 'Run changed; reread before controlling it' using errcode='40001'; end if;
 if r.status not in ('active','paused') then raise exception 'Finished runs require a new enrollment'; end if;
 if operation='resume' then
  if c.id is null then raise exception 'A current contact with SMS consent is required'; end if;
  if c.revision is distinct from (p->>'contactRevision')::numeric then raise exception 'Contact changed; reread before resuming' using errcode='40001'; end if;
  if r.status<>'paused' then raise exception 'Only paused runs can be resumed'; end if;
  if c.opted_out or not c.marketing_consent then raise exception 'Recorded SMS consent required; STOP cannot be overridden'; end if;
  if not exists(select from public.sms_businesses where tenant_id=t and status='active' and sending_enabled) then raise exception 'Business sending is disabled or inactive'; end if;
  if r.appointment_at is not null and r.appointment_at<=now() then raise exception 'Appointment must still be in the future'; end if;
 end if;
 if c.id is not null then
  -- Canonical run action supports both origins, checks run_enabled and uncertain
  -- provider work, increments generation and retains the original snapshot.
  perform sms_private.contact_automations(u,t,'run',jsonb_build_object('contactId',c.id,'runId',r.id,'generation',r.generation,'operation',operation,'idempotencyKey',inner_key));
 elsif r.origin='form' then
  -- Historical form recipients without a contact can still be paused/stopped.
  perform sms_private.form_workspace(u,t,operation,r.form_id,jsonb_build_object('runId',r.id));
 else raise exception 'Run contact unavailable' using errcode='42501'; end if;
 select * into r from sms_private.form_runs where tenant_id=t and id=r.id;
 select exists(select from sms_private.jobs where tenant_id=t and queue='sms_send_jobs' and payload->'request'->>'form_run_id'=r.id::text and status in ('submitting','submission_unknown'))
  or exists(select from public.sms_messages where tenant_id=t and contact_phone=r.phone and direction='outbound' and meta->>'form_run_id'=r.id::text and provider_accepted_at is not null and status not in ('delivered','failed','undelivered','canceled')) into in_flight;
 return jsonb_build_object('businessId',t,'run',sms_private.mcp_sms_run_summary(r),'databaseStatus','committed',
  'effect',case operation when 'resume' then 'resumed' when 'pause' then 'paused' else 'stopped' end,
  'deliveryStatus','not_sent_by_this_operation','inFlightMayDeliver',in_flight);
end $$;

revoke all on function sms_private.mcp_sms_run_detail(sms_private.form_runs),sms_private.mcp_sms_activity(text,text,text,jsonb),sms_private.mcp_sms_control(text,text,text,jsonb,uuid) from public,anon,authenticated,service_role,crm_mcp;

create or replace function sms_private.mcp_invoke(u text,client text,tool text,p jsonb,request_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare aid uuid; c sms_private.mcp_connections; result jsonb; data jsonb; required_permission text; action text;
 t text:=p->>'businessId'; target text:=coalesce(p->>'runId',p->>'automationId',p->>'formId',p->>'businessId',p->>'accountId');
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
   if tool in ('crm_list_sms_runs','crm_get_sms_run','crm_get_sms_run_activity','crm_resume_sms_run','crm_pause_sms_run','crm_stop_sms_run','crm_get_sms_run_start_context','crm_start_sms_automation_run','crm_publish_sms_automation','crm_set_form_followups_enabled','crm_create_sms_automation','crm_save_sms_automation_draft','crm_preview_sms_automation','crm_list_sms_automations','crm_get_sms_automation','crm_search_sms_contacts','crm_list_form_submissions','crm_get_business','crm_save_business_profile_draft','crm_review_business_profile','crm_add_business_service','crm_set_service_visibility')
    and (t is null or (not c.all_businesses and not t=any(c.business_ids)) or not exists(select from public.sms_businesses where tenant_id=t)) then raise exception 'Business access denied' using errcode='42501'; end if;
   if tool='crm_start_sms_automation_run' and p->>'overlapChoice'='stop_selected' and not 'automation_run_pause_stop'=any(c.permissions) then raise exception 'Stopping overlapping runs is not granted' using errcode='42501'; end if;
   if tool in ('crm_list_sms_runs','crm_get_sms_run','crm_get_sms_run_activity') then
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
     if tool in ('crm_resume_sms_run','crm_pause_sms_run','crm_stop_sms_run') then
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
