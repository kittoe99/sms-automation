-- CRM-owned. After lead/handoff MCP reads and existing paired E2 contracts.
-- Apply before the matching frontend/MCP release; old unversioned edits fail closed.
alter table public.sms_leads add column revision bigint not null default 1 check(revision between 1 and 9007199254740991);
alter table public.sms_handoffs add column revision bigint not null default 1 check(revision between 1 and 9007199254740991);

-- All writers (including workers/upserts) share this counter. Timestamps alone
-- and repeated identical updates are not changes. Callers cannot set the counter.
create function sms_private.lead_handoff_revision() returns trigger
language plpgsql set search_path='' as $$
begin
 if tg_op='INSERT' then
  new.revision:=1;
 else
  if new.revision is distinct from old.revision then raise exception 'Revision is database managed' using errcode='23514'; end if;
  if (to_jsonb(new)-'revision'-'updated_at') is distinct from (to_jsonb(old)-'revision'-'updated_at') then
   new.revision:=old.revision+1;new.updated_at:=clock_timestamp();
  else
   new.revision:=old.revision;new.updated_at:=old.updated_at;
  end if;
 end if;
 return new;
end $$;
revoke all on function sms_private.lead_handoff_revision() from public,anon,authenticated,service_role,sms_api,crm_mcp;
create trigger lead_revision before insert or update on public.sms_leads for each row execute function sms_private.lead_handoff_revision();
create trigger handoff_revision before insert or update on public.sms_handoffs for each row execute function sms_private.lead_handoff_revision();

create or replace function sms_private.update_lead_handoff(u text,t text,resource text,rid uuid,input jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare current_revision bigint; expected bigint; result jsonb; tab text;
begin
 perform pg_advisory_xact_lock(hashtextextended('platform:privileges',0));
 perform sms_private.require_admin(u);
 perform sms_private.require_sms_reader(u,t);
 if resource not in ('lead','handoff') or resource is null then raise exception 'Unknown resource'; end if;
 if jsonb_typeof(input) is distinct from 'object' then raise exception 'Invalid edit'; end if;
 if exists(select from jsonb_object_keys(input) keys(key) where keys.key not in ('revision','status','owner')) then raise exception 'Unexpected input field'; end if;
 if jsonb_typeof(input->'revision') is distinct from 'number' or input->>'revision' !~ '^[0-9]+$'
  or (input->>'revision')::numeric not between 1 and 9007199254740991 then raise exception 'Current revision required'; end if;
 expected:=(input->>'revision')::bigint;
 if not (input ? 'status' or input ? 'owner') then raise exception 'An editable field is required'; end if;
 if input ? 'status' and (jsonb_typeof(input->'status') is distinct from 'string' or input->>'status' not in ('open','assigned','resolved','closed')) then raise exception 'Invalid status'; end if;
 if input ? 'owner' and (jsonb_typeof(input->'owner') not in ('string','null') or length(input->>'owner')>200) then raise exception 'Invalid owner label'; end if;
 tab:=case resource when 'lead' then 'sms_leads' else 'sms_handoffs' end;
 -- Identifier is fixed above; all values are bound. Lock then compare so a worker
 -- commit or competing staff edit is observed before a stale request can write.
 execute format('select revision from public.%I where tenant_id=$1 and id=$2 for update',tab) into current_revision using t,rid;
 if current_revision is null then raise exception 'Record unavailable' using errcode='42501'; end if;
 if current_revision<>expected then raise exception 'Record changed; refresh and review before saving' using errcode='40001'; end if;
 execute format('update public.%I set status=case when $3 ? ''status'' then $3->>''status'' else status end,
  owner=case when $3 ? ''owner'' then nullif(btrim($3->>''owner''),'''') else owner end
  where tenant_id=$1 and id=$2 returning to_jsonb(%I.*)',tab,tab) into result using t,rid,input;
 return result;
end $$;

create or replace function sms_private.mcp_lead_handoff_read(u text,t text,tool text,p jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare is_lead boolean:=tool in ('crm_list_leads','crm_get_lead'); is_list boolean:=tool in ('crm_list_leads','crm_list_handoffs');
 tab text; id_key text; result_key text; content_key text; cap integer; allowed text[]; k text; pg integer:=1; size integer:=25;
 rid uuid; cid uuid; total integer; result jsonb; link jsonb; tz text; context jsonb;
begin
 perform sms_private.require_sms_reader(u,t);
 if tool not in ('crm_list_leads','crm_get_lead','crm_list_handoffs','crm_get_handoff') then raise exception 'Unknown management read'; end if;
 if jsonb_typeof(p) is distinct from 'object' then raise exception 'Invalid management read'; end if;
 if jsonb_typeof(p->'businessId') is distinct from 'string' or length(btrim(p->>'businessId')) not between 1 and 255 or p->>'businessId' is distinct from t then raise exception 'Explicit business ID required'; end if;
 id_key:=case when is_lead then 'leadId' else 'handoffId' end;
 allowed:=case when is_list then array['businessId','page','pageSize','status','contactId','q'] else array['businessId',id_key] end;
 if exists(select from jsonb_object_keys(p) keys(key) where not keys.key=any(allowed)) then raise exception 'Unexpected input field'; end if;
 if not is_list or p ? 'contactId' then
  k:=case when is_list then 'contactId' else id_key end;
  if jsonb_typeof(p->k) is distinct from 'string' or p->>k !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then raise exception 'Valid reference required'; end if;
  if is_list then cid:=(p->>k)::uuid; else rid:=(p->>k)::uuid; end if;
 end if;
 if is_list then
  foreach k in array array['page','pageSize'] loop
   if p ? k and (jsonb_typeof(p->k) is distinct from 'number' or p->>k !~ '^[0-9]+$' or (p->>k)::numeric<1 or (p->>k)::numeric>case when k='page' then 100000 else 100 end) then raise exception 'Invalid pagination'; end if;
  end loop;
  pg:=coalesce((p->>'page')::integer,1);size:=coalesce((p->>'pageSize')::integer,25);
  if p ? 'status' and (jsonb_typeof(p->'status') is distinct from 'string' or p->>'status' not in ('open','assigned','resolved','closed')) then raise exception 'Invalid status'; end if;
  if p ? 'q' and (jsonb_typeof(p->'q') is distinct from 'string' or length(p->>'q')>100) then raise exception 'Invalid search'; end if;
 end if;
 tab:=case when is_lead then 'sms_leads' else 'sms_handoffs' end;
 content_key:=case when is_lead then 'summary' else 'reason' end;cap:=case when is_lead then 4000 else 1000 end;
 result_key:=case when is_lead then case when is_list then 'leads' else 'lead' end else case when is_list then 'handoffs' else 'handoff' end end;
 -- Fixed relation/column allowlist; values remain bound. Filter before counts/pages.
 execute format($q$
 with eligible as materialized (
 select r.id,r.status,r.owner,r.priority,r.created_at,r.updated_at,r.revision,r.%I as content,c.id contact_id,c.name,c.phone
 from public.%I r join public.sms_contacts c on c.tenant_id=r.tenant_id and c.id=r.contact_id
 where r.tenant_id=$1 and ($2::uuid is null or r.id=$2) and ($3::uuid is null or c.id=$3)
 and ($4::text is null or r.status=$4)
 and ($5='' or position(lower($5) in lower(concat_ws(' ',c.name,c.phone,r.owner,r.%I)))>0)
 ), paged as (select * from eligible order by created_at desc,id limit $6 offset $7)
 select (select count(*) from eligible),coalesce(jsonb_agg(jsonb_build_object(
 'id',id,'status',status,'owner',left(owner,200),'priority',priority,'createdAt',created_at,'updatedAt',updated_at,'revision',revision,
 'contact',jsonb_build_object('id',contact_id,'name',left(name,200),'phone',left(phone,32)),%L,left(content,%s),
 'textTruncated',coalesce(length(owner)>200,false) or coalesce(length(name)>200,false) or length(phone)>32 or length(content)>%s
 ) order by created_at desc,id),'[]') from paged
 $q$,content_key,tab,content_key,content_key,cap,cap) into total,result using t,rid,cid,p->>'status',coalesce(p->>'q',''),size,(pg-1)*size;
 select time_zone into tz from public.sms_businesses where tenant_id=t;
 context:=jsonb_build_object('businessId',t,'timeZone',tz,'reportingAt',statement_timestamp());
 if is_list then return context||jsonb_build_object(result_key,result,'total',total,'page',pg,'pageSize',size); end if;
 if total=0 then raise exception 'Record unavailable' using errcode='42501'; end if;
 result:=result->0;
 -- Only explicit links, checked at both ends. Phone equality validates a link; it never creates one.
 select jsonb_build_object('runId',r.id,'origin',r.origin,'formId',r.form_id,'submissionId',r.submission_id) into link
 from sms_private.form_runs r
 where r.tenant_id=t and r.phone=result->'contact'->>'phone' and r.test_sequence is null and r.appointment_at is null
 and ((is_lead and exists(select from public.sms_leads l join public.sms_messages m on m.tenant_id=l.tenant_id and m.id=l.source_message_id
  join sms_private.activity_responses a on a.tenant_id=m.tenant_id and a.message_id=m.id
  where l.tenant_id=t and l.id=rid and m.direction='inbound' and m.contact_phone=r.phone and a.run_id=r.id))
 or (not is_lead and exists(select from sms_private.activity_handoffs a where a.tenant_id=t and a.handoff_id=rid and a.run_id=r.id)))
 and ((r.origin='direct' and r.form_id is null and r.submission_id is null and exists(select from sms_private.direct_templates d where d.tenant_id=t and d.id=r.direct_template_id))
 or (r.origin='form' and exists(select from public.sms_web_form_definitions f where f.tenant_id=t and f.public_id=r.form_id and
  ((f.preset='contacts' and exists(select from public.sms_web_form_contact_submissions s where s.tenant_id=t and s.form_public_id=f.public_id and s.id=r.submission_id))
   or (f.preset='quote_requests' and exists(select from public.sms_web_form_quote_request_submissions s where s.tenant_id=t and s.form_public_id=f.public_id and s.id=r.submission_id))
   or (f.preset='bookings' and exists(select from public.sms_web_form_booking_submissions s where s.tenant_id=t and s.form_public_id=f.public_id and s.id=r.submission_id))))))
 order by r.id limit 1;
 return context||jsonb_build_object(result_key,result||jsonb_build_object('enquiry',link));
end $$;
revoke all on function sms_private.mcp_lead_handoff_read(text,text,text,jsonb) from public,anon,authenticated,service_role,sms_api,crm_mcp;


create or replace function sms_private.mcp_invoke(u text,client text,tool text,p jsonb,request_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare aid uuid; c sms_private.mcp_connections; result jsonb; data jsonb; required_permission text; action text;
 t text:=p->>'businessId'; target text:=coalesce(p->>'leadId',p->>'handoffId',p->>'submissionId',p->>'runId',p->>'automationId',p->>'formId',p->>'businessId',p->>'accountId');
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
   required_permission:=case tool when 'crm_list_leads' then 'lead_read' when 'crm_get_lead' then 'lead_read' when 'crm_list_handoffs' then 'handoff_read' when 'crm_get_handoff' then 'handoff_read' when 'crm_get_enquiry_status' then 'enquiry_status_read' when 'crm_list_enquiries' then 'enquiry_read' when 'crm_get_enquiry' then 'enquiry_read' when 'crm_set_form_collection_enabled' then 'form_activate' when 'crm_apply_form_draft' then 'form_publish' when 'crm_preview_form' then 'form_preview' when 'crm_create_form' then 'form_create' when 'crm_save_form_draft' then 'form_edit' when 'crm_list_forms' then 'form_read' when 'crm_get_form' then 'form_read' when 'crm_search_customers' then 'read' when 'crm_get_customer' then 'read'
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
   if tool in ('crm_list_leads','crm_get_lead','crm_list_handoffs','crm_get_handoff','crm_get_enquiry_status','crm_list_enquiries','crm_get_enquiry','crm_set_form_collection_enabled','crm_apply_form_draft','crm_preview_form','crm_create_form','crm_save_form_draft','crm_list_forms','crm_get_form','crm_list_sms_runs','crm_get_sms_run','crm_get_sms_run_activity','crm_resume_sms_run','crm_pause_sms_run','crm_stop_sms_run','crm_get_sms_run_start_context','crm_start_sms_automation_run','crm_publish_sms_automation','crm_set_form_followups_enabled','crm_create_sms_automation','crm_save_sms_automation_draft','crm_preview_sms_automation','crm_list_sms_automations','crm_get_sms_automation','crm_search_sms_contacts','crm_list_form_submissions','crm_get_business','crm_save_business_profile_draft','crm_review_business_profile','crm_add_business_service','crm_set_service_visibility')
    and (t is null or (not c.all_businesses and not t=any(c.business_ids)) or not exists(select from public.sms_businesses where tenant_id=t)) then raise exception 'Business access denied' using errcode='42501'; end if;
   if tool='crm_start_sms_automation_run' and p->>'overlapChoice'='stop_selected' and not 'automation_run_pause_stop'=any(c.permissions) then raise exception 'Stopping overlapping runs is not granted' using errcode='42501'; end if;
   if tool in ('crm_list_leads','crm_get_lead','crm_list_handoffs','crm_get_handoff') then
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
     if tool='crm_set_form_collection_enabled' then
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
  error_code:=case when state='42501' then 'PERMISSION_DENIED' when state in ('23505','40001') then 'CONFLICT' when state in ('P0001','22P02','22023','23514','23502','P0002') then 'VALIDATION_ERROR' else 'TEMPORARY_FAILURE' end;
  if error_code='TEMPORARY_FAILURE' then error_message:='Service temporarily unavailable. Retry with the same idempotency key.'; end if;
  result:=jsonb_build_object('ok',false,'error',jsonb_build_object('code',error_code,'message',error_message,'retryable',error_code='TEMPORARY_FAILURE'));
 end;
 insert into sms_private.mcp_activity(connection_id,actor_id,tool,target,request_id,outcome,code,revision,draft_revision)
  values(c.id,aid,left(tool,100),left(coalesce(data->'lead'->>'id',data->'handoff'->>'id',data->'enquiry'->>'id',data->'form'->>'id',data->'run'->>'id',data->'automation'->>'id',target),255),request_id,case when error_code is not null then 'denied' when replay then 'replayed' else 'success' end,error_code,
   case when error_code is null then coalesce((data->'lead'->>'revision')::bigint,(data->'handoff'->>'revision')::bigint,(data->'enquiryStatus'->'sms'->>'generation')::bigint,(data->'enquiryStatus'->>'submittedFormVersion')::bigint,(data->'enquiry'->>'submittedFormVersion')::bigint,(data->'form'->>'revision')::bigint,(data->'run'->>'generation')::bigint,(data->'source'->>'revision')::bigint,(data->'automation'->>'revision')::bigint,(data->'record'->>'revision')::bigint,(data->'business'->'setup'->>'revision')::bigint) end,
   case when error_code is null then (data->'form'->>'draftRevision')::bigint end);
 if error_code is null and tool='crm_start_sms_automation_run' then
  insert into sms_private.mcp_activity(connection_id,actor_id,tool,target,request_id,outcome,revision)
   select c.id,aid,'crm_start_sms_automation_run:replace',v->>'id',request_id,case when replay then 'replayed' else 'success' end,(v->>'generation')::bigint from jsonb_array_elements(data->'stoppedRuns') v;
 end if;
 return result;
end $$;
