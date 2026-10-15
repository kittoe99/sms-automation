-- CRM-owned forward migration after 20261015035649 and the paired E2 baseline.
-- No existing connection receives new permissions. No messaging settings change.
-- Private helpers are reachable only through the existing guarded MCP gateway.
alter table sms_private.mcp_connections drop constraint mcp_connections_permissions_check;
alter table sms_private.mcp_connections add constraint mcp_connections_permissions_check check
 (permissions <@ array['read','draft','review','service_add','visibility','global_customer_lookup',
 'automation_read','automation_draft','automation_preview','automation_publish','automation_enable',
 'automation_run_start','automation_run_resume','automation_run_pause_stop','automation_activity']::text[]);

-- Bound form history scans to the requested business/form before sorting/paging.
create index mcp_contact_submissions_form on public.sms_web_form_contact_submissions(tenant_id,form_public_id,submitted_at desc,id);
create index mcp_quote_submissions_form on public.sms_web_form_quote_request_submissions(tenant_id,form_public_id,submitted_at desc,id);
create index mcp_booking_submissions_form on public.sms_web_form_booking_submissions(tenant_id,form_public_id,submitted_at desc,id);

create function sms_private.mcp_sms_catalog(t text)
returns table(id uuid,kind text,name text,archived boolean,revision integer,published_version integer,
 enabled boolean,form_enabled boolean,form_revision integer,preset text)
language sql stable set search_path='' as $$
 select f.public_id,'form'::text,f.title,f.archived,
  case when s.revision=1 and s.draft='{}' then 0 else coalesce(s.revision,0) end,
  s.published_version,coalesce(s.enabled,false),f.enabled,f.version,f.preset
 from public.sms_web_form_definitions f left join sms_private.form_sequences s
  on s.tenant_id=f.tenant_id and s.form_id=f.public_id where f.tenant_id=t
 union all
 select d.id,'contact'::text,d.name,d.archived,d.revision,d.published_version,null::boolean,null::boolean,null::integer,null::text
 from sms_private.direct_templates d where d.tenant_id=t
$$;

create function sms_private.mcp_sms_summary(x jsonb) returns jsonb
language sql stable set search_path='' as $$
 select jsonb_build_object('id',x->'id','kind',x->'kind','name',x->'name','archived',x->'archived','revision',x->'revision',
 'publishedVersion',x->'published_version','enabled',x->'enabled','formEnabled',x->'form_enabled','formRevision',x->'form_revision','preset',x->'preset')
$$;

-- Project stored rules explicitly; future private fields must not enter the MCP contract.
create function sms_private.mcp_sms_sequence(s jsonb) returns jsonb
language sql immutable set search_path='' as $$
 select case when s is null or s='{}' then null else jsonb_build_object(
  'trigger',s->'trigger','leadHours',coalesce(s->'leadHours','24'::jsonb),'replyPolicy',s->'replyPolicy',
  'startHour',s->'startHour','endHour',s->'endHour','steps',coalesce((select jsonb_agg(jsonb_build_object(
  'body',v->'body','delayCount',v->'delayCount','delayUnit',v->'delayUnit','sendCount',v->'sendCount',
  'intervalCount',v->'intervalCount','intervalUnit',v->'intervalUnit') order by n)
  from jsonb_array_elements(s->'steps') with ordinality a(v,n)),'[]')) end
$$;

create function sms_private.mcp_sms_read(u text,t text,tool text,p jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare pg integer; size integer; total bigint; result jsonb; tz text; x record; f public.sms_web_form_definitions;
 draft jsonb; published jsonb; fields jsonb; blockers text[]:='{}'; allowed text[]; b public.sms_businesses;
begin
 perform sms_private.require_sms_reader(u,t);
 allowed:=case tool
  when 'crm_list_sms_automations' then array['businessId','page','pageSize','q','kind','includeArchived']
  when 'crm_get_sms_automation' then array['businessId','kind','automationId']
  when 'crm_search_sms_contacts' then array['businessId','page','pageSize','q']
  when 'crm_list_form_submissions' then array['businessId','page','pageSize','formId'] end;
 if allowed is null or jsonb_typeof(p) is distinct from 'object' then raise exception 'Invalid SMS read'; end if;
 if exists(select from jsonb_object_keys(p) k where not k=any(allowed)) then raise exception 'Unexpected input field'; end if;
 -- Validate at the database boundary too: the restricted login can call the gateway directly.
 if (p ? 'page' and (jsonb_typeof(p->'page')<>'number' or (p->>'page')::numeric<>trunc((p->>'page')::numeric)))
  or (p ? 'pageSize' and (jsonb_typeof(p->'pageSize')<>'number' or (p->>'pageSize')::numeric<>trunc((p->>'pageSize')::numeric)))
  or (p ? 'q' and (jsonb_typeof(p->'q')<>'string' or length(p->>'q')>100))
  or (p ? 'includeArchived' and jsonb_typeof(p->'includeArchived')<>'boolean')
  or (p ? 'kind' and coalesce(p->>'kind','') not in ('form','contact')) then raise exception 'Invalid SMS read input'; end if;
 if (p ? 'page' and (p->>'page')::numeric not between 1 and 100000)
  or (p ? 'pageSize' and (p->>'pageSize')::numeric not between 1 and 100) then raise exception 'Invalid pagination'; end if;
 pg:=coalesce((p->>'page')::integer,1);size:=coalesce((p->>'pageSize')::integer,25);
 if pg not between 1 and 100000 or size not between 1 and 100 then raise exception 'Invalid pagination'; end if;
 select * into b from public.sms_businesses where tenant_id=t;tz:=b.time_zone;
 if tool='crm_list_sms_automations' then
  with eligible as materialized(select * from sms_private.mcp_sms_catalog(t) c
   where (coalesce((p->>'includeArchived')::boolean,false) or not c.archived)
   and (not p ? 'kind' or c.kind=p->>'kind') and c.name ilike '%'||coalesce(p->>'q','')||'%'),
  paged as(select * from eligible order by kind,id limit size offset (pg-1)*size)
  select (select count(*) from eligible),coalesce(jsonb_agg(sms_private.mcp_sms_summary(to_jsonb(c)) order by c.kind,c.id),'[]')
   into total,result from paged c;
  return jsonb_build_object('businessId',t,'timeZone',tz,'automations',result,'total',total,'page',pg,'pageSize',size);
 elsif tool='crm_get_sms_automation' then
  if coalesce(p->>'kind','') not in ('form','contact') or not p ? 'automationId' then raise exception 'Automation kind and ID required'; end if;
  select * into x from sms_private.mcp_sms_catalog(t) c where c.kind=p->>'kind' and c.id=(p->>'automationId')::uuid;
  if not found then raise exception 'Automation unavailable' using errcode='42501'; end if;
  fields:='["first_name","name","phone","email","business_name"]'::jsonb;
  if x.kind='form' then
   select s.draft,v.sequence into draft,published from sms_private.form_sequences s
    left join sms_private.form_sequence_versions v on v.tenant_id=s.tenant_id and v.form_id=s.form_id and v.version=s.published_version
    where s.tenant_id=t and s.form_id=x.id;
   select * into f from public.sms_web_form_definitions where tenant_id=t and public_id=x.id;
   fields:=fields||coalesce((select jsonb_agg('field.'||(v->>'key') order by n) from jsonb_array_elements(f.fields) with ordinality a(v,n)),'[]');
   if f.preset='bookings' then fields:=fields||'["appointment_at"]'::jsonb; end if;
   if not x.form_enabled then blockers:=array_append(blockers,'FORM_DISABLED'); end if;
   if not x.enabled then blockers:=array_append(blockers,'AUTOMATION_DISABLED'); end if;
  else
   select d.draft,v.sequence into draft,published from sms_private.direct_templates d
    left join sms_private.direct_versions v on v.tenant_id=d.tenant_id and v.template_id=d.id and v.version=d.published_version where d.tenant_id=t and d.id=x.id;
   fields:=fields||'["request"]'::jsonb;
   if not coalesce((select direct_automations_enabled from sms_private.runtime),false) then blockers:=array_append(blockers,'DIRECT_RUNTIME_DISABLED'); end if;
  end if;
  if x.archived then blockers:=array_append(blockers,'ARCHIVED'); end if;
  if x.published_version is null then blockers:=array_append(blockers,'UNPUBLISHED'); end if;
  if b.status<>'active' then blockers:=array_append(blockers,'BUSINESS_INACTIVE'); end if;
  if not b.sending_enabled then blockers:=array_append(blockers,'SENDING_DISABLED'); end if;
  if not exists(select from sms_private.providers where tenant_id=t and provisioning_state='configured' and from_number is not null)
   then blockers:=array_append(blockers,'SENDER_NOT_CONNECTED'); end if;
  return jsonb_build_object('businessId',t,'timeZone',tz,'automation',sms_private.mcp_sms_summary(to_jsonb(x))||jsonb_build_object(
   'draft',sms_private.mcp_sms_sequence(draft),'published',sms_private.mcp_sms_sequence(published),'supportedFields',fields),
   'readiness',jsonb_build_object('blockers',to_jsonb(blockers),'recipientChecksRequired',true));
 elsif tool='crm_search_sms_contacts' then
  with eligible as materialized(select c.id,c.name,c.phone,c.email,c.revision,c.marketing_consent,c.opted_out,c.enquiry_blocked
   from public.sms_contacts c where c.tenant_id=t and concat_ws(' ',c.name,c.phone,c.email) ilike '%'||coalesce(p->>'q','')||'%'),
  paged as(select * from eligible order by id limit size offset (pg-1)*size)
  select (select count(*) from eligible),coalesce(jsonb_agg(jsonb_build_object('id',c.id,'name',c.name,'phone',c.phone,'email',c.email,
   'revision',c.revision,'marketingConsent',c.marketing_consent,'optedOut',c.opted_out,'enquiryBlocked',c.enquiry_blocked) order by c.id),'[]') into total,result from paged c;
  return jsonb_build_object('businessId',t,'timeZone',tz,'contacts',result,'total',total,'page',pg,'pageSize',size);
 elsif tool='crm_list_form_submissions' then
  if not p ? 'formId' then raise exception 'Form ID required'; end if;
  select * into f from public.sms_web_form_definitions where tenant_id=t and public_id=(p->>'formId')::uuid;
  if not found then raise exception 'Form unavailable' using errcode='42501'; end if;
  -- Identifier comes from the canonical preset allowlist; all user values are bound.
  execute format($query$
   with eligible as materialized(select id,name,phone,email,submitted_at,sms_opt_in,%s as appointment_at
    from public.%I where tenant_id=$1 and form_public_id=$2),
   paged as(select * from eligible order by submitted_at desc,id limit $3 offset $4)
   select (select count(*) from eligible),coalesce(jsonb_agg(jsonb_build_object(
    'id',s.id,'name',s.name,'phone',s.phone,'email',s.email,'submittedAt',s.submitted_at,'smsConsent',s.sms_opt_in,
    'appointmentAt',s.appointment_at,'contactId',c.id,'contactRevision',c.revision,
    'run',case when r.id is null then null else jsonb_build_object('id',r.id,'status',r.status,'generation',r.generation) end)
    order by s.submitted_at desc,s.id),'[]')
   from paged s left join public.sms_contacts c on c.tenant_id=$1 and c.phone=s.phone
   left join sms_private.form_runs r on r.tenant_id=$1 and r.form_id=$2 and r.submission_id=s.id and r.origin='form'
  $query$,case when f.preset='bookings' then 'appointment_at' else 'null::timestamptz' end,sms_private.web_form_table(f.preset))
  into total,result using t,f.public_id,size,(pg-1)*size;
  return jsonb_build_object('businessId',t,'timeZone',tz,'formId',f.public_id,'submissions',result,'total',total,'page',pg,'pageSize',size);
 end if;
 raise exception 'Unknown SMS read';
end $$;
revoke all on function sms_private.mcp_sms_catalog(text),sms_private.mcp_sms_summary(jsonb),sms_private.mcp_sms_sequence(jsonb),sms_private.mcp_sms_read(text,text,text,jsonb) from public,anon,authenticated,crm_mcp,sms_api;

-- CRM-owned forward fix: distinguish the list alias from the mutable connection row.
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
  if not perms <@ array['read','draft','review','service_add','visibility','global_customer_lookup','automation_read','automation_draft','automation_preview','automation_publish','automation_enable','automation_run_start','automation_run_resume','automation_run_pause_stop','automation_activity']::text[] or cardinality(businesses)>500
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
    when 'crm_list_sms_automations' then 'automation_read' when 'crm_get_sms_automation' then 'automation_read'
    when 'crm_search_sms_contacts' then 'automation_read' when 'crm_list_form_submissions' then 'automation_read'
    when 'crm_list_businesses' then 'read' when 'crm_get_business' then 'read'
    when 'crm_save_business_profile_draft' then 'draft' when 'crm_review_business_profile' then 'review'
    when 'crm_add_business_service' then 'service_add' when 'crm_set_service_visibility' then 'visibility' end;
   if required_permission is null or not required_permission=any(c.permissions) then raise exception 'Action is not granted' using errcode='42501'; end if;
   if tool in ('crm_list_sms_automations','crm_get_sms_automation','crm_search_sms_contacts','crm_list_form_submissions','crm_get_business','crm_save_business_profile_draft','crm_review_business_profile','crm_add_business_service','crm_set_service_visibility')
    and (t is null or (not c.all_businesses and not t=any(c.business_ids)) or not exists(select from public.sms_businesses where tenant_id=t)) then raise exception 'Business access denied' using errcode='42501'; end if;
   if tool in ('crm_list_sms_automations','crm_get_sms_automation','crm_search_sms_contacts','crm_list_form_submissions') then
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
    if key is null or length(key) not between 8 and 128 then raise exception 'An idempotency key of 8 to 128 characters is required'; end if;
    fingerprint:=encode(sha256(convert_to((p-'idempotencyKey')::text,'UTF8')),'hex');
    select * into prior from sms_private.mcp_requests where connection_id=c.id and idempotency_key=key;
    if found then
     if prior.tool<>tool or prior.fingerprint<>fingerprint then raise exception 'Idempotency key was used for a different request' using errcode='40001'; end if;
     data:=prior.result;replay:=true;
    else
     action:=case tool when 'crm_save_business_profile_draft' then 'business_profile_draft' when 'crm_review_business_profile' then 'business_profile_review'
      when 'crm_add_business_service' then 'service_add' when 'crm_set_service_visibility' then 'service_visibility' end;
     allowed_keys:=case when action in ('business_profile_draft','business_profile_review') then array['businessId','idempotencyKey','revision','profile']
      when action='service_add' then array['businessId','idempotencyKey','kind','siteId','siteRevision'] else array['businessId','idempotencyKey','serviceId','revision','visibility'] end;
     if exists(select from jsonb_object_keys(p) x where not x=any(allowed_keys)) then raise exception 'Unexpected input field'; end if;
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
  values(c.id,aid,left(tool,100),left(target,255),request_id,case when error_code is not null then 'denied' when replay then 'replayed' else 'success' end,error_code,
   case when error_code is null then coalesce((data->'automation'->>'revision')::bigint,(data->'record'->>'revision')::bigint,(data->'business'->'setup'->>'revision')::bigint) end);
 return result;
end $$;

