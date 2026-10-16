-- CRM-owned forward migration after 20261015052336 and the paired E2 baseline.
-- Only form reads are exposed. Existing connection grants and form data stay intact.
alter table sms_private.mcp_connections drop constraint mcp_connections_permissions_check;
alter table sms_private.mcp_connections add constraint mcp_connections_permissions_check check
 (permissions <@ array['read','draft','review','service_add','visibility','global_customer_lookup',
 'automation_read','automation_draft','automation_preview','automation_publish','automation_enable',
 'automation_run_start','automation_run_resume','automation_run_pause_stop','automation_activity',
 'form_read','form_create','form_edit','form_preview','form_publish','form_activate']::text[]);

create index mcp_form_directory on public.sms_web_form_definitions(tenant_id,title,public_id);

-- Explicit projection: new/private columns and arbitrary JSON keys never leak.
create function sms_private.mcp_form_summary(f public.sms_web_form_definitions) returns jsonb
language sql stable set search_path='' as $$
 select jsonb_build_object('id',f.public_id,'preset',f.preset,'title',f.title,'revision',f.version,
  'collectionEnabled',f.enabled,'archived',f.archived,'legacyForm',f.legacy_form,'emailConsentEnabled',f.email_enabled)
$$;

create function sms_private.mcp_form_read(u text,t text,tool text,p jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare allowed text[]; pg integer; size integer; total bigint; result jsonb; tz text;
 f public.sms_web_form_definitions; fields jsonb; fixed_fields jsonb;
begin
 perform sms_private.require_web_form_editor(u,t);
 allowed:=case tool when 'crm_list_forms' then array['businessId','page','pageSize','q','preset','collectionEnabled','includeArchived']
  when 'crm_get_form' then array['businessId','formId'] end;
 if allowed is null or jsonb_typeof(p) is distinct from 'object' then raise exception 'Invalid form read'; end if;
 if exists(select from jsonb_object_keys(p) k where not k=any(allowed)) then raise exception 'Unexpected input field'; end if;
 if jsonb_typeof(p->'businessId') is distinct from 'string' or length(btrim(p->>'businessId')) not between 1 and 255
  or p->>'businessId' is distinct from t then raise exception 'Explicit business ID required'; end if;
 select time_zone into tz from public.sms_businesses where tenant_id=t;
 if tool='crm_list_forms' then
  if (p ? 'q' and (jsonb_typeof(p->'q') is distinct from 'string' or length(p->>'q')>100))
   or (p ? 'preset' and (jsonb_typeof(p->'preset') is distinct from 'string' or p->>'preset' not in ('contacts','quote_requests','bookings')))
   or (p ? 'includeArchived' and jsonb_typeof(p->'includeArchived') is distinct from 'boolean')
   or (p ? 'collectionEnabled' and jsonb_typeof(p->'collectionEnabled') is distinct from 'boolean') then raise exception 'Invalid form filter'; end if;
  if (p ? 'page' and jsonb_typeof(p->'page') is distinct from 'number')
   or (p ? 'pageSize' and jsonb_typeof(p->'pageSize') is distinct from 'number') then raise exception 'Invalid pagination'; end if;
  if (p ? 'page' and ((p->>'page')::numeric not between 1 and 100000 or (p->>'page')::numeric<>trunc((p->>'page')::numeric)))
   or (p ? 'pageSize' and ((p->>'pageSize')::numeric not between 1 and 100 or (p->>'pageSize')::numeric<>trunc((p->>'pageSize')::numeric))) then raise exception 'Invalid pagination'; end if;
  pg:=coalesce((p->>'page')::numeric,1)::integer;size:=coalesce((p->>'pageSize')::numeric,25)::integer;
  with eligible as materialized (
   select d.public_id,d.title from public.sms_web_form_definitions d where d.tenant_id=t
    and (coalesce((p->>'includeArchived')::boolean,false) or not d.archived)
    and (not p ? 'preset' or d.preset=p->>'preset')
    and (not p ? 'collectionEnabled' or d.enabled=(p->>'collectionEnabled')::boolean)
    and strpos(lower(d.title),lower(coalesce(p->>'q','')))>0
  ), paged as (select * from eligible order by title,public_id limit size offset (pg-1)*size)
  select (select count(*) from eligible),coalesce(jsonb_agg(sms_private.mcp_form_summary(d) order by d.title,d.public_id),'[]')
   into total,result from paged x join public.sms_web_form_definitions d on d.tenant_id=t and d.public_id=x.public_id;
  return jsonb_build_object('businessId',t,'timeZone',tz,'forms',result,'total',total,'page',pg,'pageSize',size);
 end if;
 if jsonb_typeof(p->'formId') is distinct from 'string' or p->>'formId' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  then raise exception 'Valid form ID required'; end if;
 select * into f from public.sms_web_form_definitions where tenant_id=t and public_id=(p->>'formId')::uuid;
 if not found then raise exception 'Form unavailable' using errcode='42501'; end if;
 select coalesce(jsonb_agg(jsonb_build_object('key',v->'key','type',v->'type','label',v->'label','required',coalesce(v->'required','false'::jsonb))
  ||case when v->>'type'='select' then jsonb_build_object('options',v->'options') else '{}'::jsonb end order by n),'[]')
  into fields from jsonb_array_elements(f.fields) with ordinality a(v,n);
 fixed_fields:='["name","phone","email","sms_opt_in"]'::jsonb;
 if f.preset='bookings' then fixed_fields:=fixed_fields||'["appointment_at"]'::jsonb; end if;
 if f.email_enabled then fixed_fields:=fixed_fields||'["email_opt_in"]'::jsonb; end if;
 return jsonb_build_object('businessId',t,'timeZone',tz,'form',sms_private.mcp_form_summary(f)||jsonb_build_object(
  'definition',jsonb_build_object('title',f.title,'description',f.description,'buttonLabel',f.button_label,'fields',fields),
  'draft',null,'draftRevision',null,'fixedFields',fixed_fields));
end $$;

revoke all on function sms_private.mcp_form_summary(public.sms_web_form_definitions),sms_private.mcp_form_read(text,text,text,jsonb)
 from public,anon,authenticated,service_role,crm_mcp;

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
  if not perms <@ array['read','draft','review','service_add','visibility','global_customer_lookup','automation_read','automation_draft','automation_preview','automation_publish','automation_enable','automation_run_start','automation_run_resume','automation_run_pause_stop','automation_activity','form_read','form_create','form_edit','form_preview','form_publish','form_activate']::text[] or cardinality(businesses)>500
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
   required_permission:=case tool when 'crm_list_forms' then 'form_read' when 'crm_get_form' then 'form_read' when 'crm_search_customers' then 'read' when 'crm_get_customer' then 'read'
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
   if tool in ('crm_list_forms','crm_get_form','crm_list_sms_runs','crm_get_sms_run','crm_get_sms_run_activity','crm_resume_sms_run','crm_pause_sms_run','crm_stop_sms_run','crm_get_sms_run_start_context','crm_start_sms_automation_run','crm_publish_sms_automation','crm_set_form_followups_enabled','crm_create_sms_automation','crm_save_sms_automation_draft','crm_preview_sms_automation','crm_list_sms_automations','crm_get_sms_automation','crm_search_sms_contacts','crm_list_form_submissions','crm_get_business','crm_save_business_profile_draft','crm_review_business_profile','crm_add_business_service','crm_set_service_visibility')
    and (t is null or (not c.all_businesses and not t=any(c.business_ids)) or not exists(select from public.sms_businesses where tenant_id=t)) then raise exception 'Business access denied' using errcode='42501'; end if;
   if tool='crm_start_sms_automation_run' and p->>'overlapChoice'='stop_selected' and not 'automation_run_pause_stop'=any(c.permissions) then raise exception 'Stopping overlapping runs is not granted' using errcode='42501'; end if;
   if tool in ('crm_list_forms','crm_get_form') then
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
  values(c.id,aid,left(tool,100),left(coalesce(data->'form'->>'id',data->'run'->>'id',data->'automation'->>'id',target),255),request_id,case when error_code is not null then 'denied' when replay then 'replayed' else 'success' end,error_code,
   case when error_code is null then coalesce((data->'form'->>'revision')::bigint,(data->'run'->>'generation')::bigint,(data->'source'->>'revision')::bigint,(data->'automation'->>'revision')::bigint,(data->'record'->>'revision')::bigint,(data->'business'->'setup'->>'revision')::bigint) end);
 if error_code is null and tool='crm_start_sms_automation_run' then
  insert into sms_private.mcp_activity(connection_id,actor_id,tool,target,request_id,outcome,revision)
   select c.id,aid,'crm_start_sms_automation_run:replace',v->>'id',request_id,case when replay then 'replayed' else 'success' end,(v->>'generation')::bigint from jsonb_array_elements(data->'stoppedRuns') v;
 end if;
 return result;
end $$;
