-- CRM-owned; after released conversation reads 20261016174527.
-- No automatic grants and no new executable mutation tools. Apply before matching MCP release.
alter table sms_private.mcp_connections drop constraint mcp_connections_permissions_check;
alter table sms_private.mcp_connections add constraint mcp_connections_permissions_check check
 (permissions <@ array['read','draft','review','service_add','visibility','global_customer_lookup',
 'automation_read','automation_draft','automation_preview','automation_publish','automation_enable',
 'automation_run_start','automation_run_resume','automation_run_pause_stop','automation_activity',
 'form_read','form_create','form_edit','form_preview','form_publish','form_activate','enquiry_read','enquiry_status_read','lead_read','lead_status_update','lead_assign','handoff_read','handoff_status_update','handoff_assign','conversation_read','conversation_messages_read','conversation_reply','conversation_mark_read']::text[]);



-- Shared database-managed revision; generation retains its existing workflow meaning.
alter table public.sms_conversations add column revision bigint not null default 1
 check(revision between 1 and 9007199254740991);

create function sms_private.conversation_revision() returns trigger
language plpgsql set search_path='' as $$
begin
 if tg_op='INSERT' then new.revision:=1;return new;end if;
 if new.revision is distinct from old.revision then
  -- Only a nested, private relationship trigger may bump an otherwise identical row.
  if pg_trigger_depth()>1 and new.revision=old.revision+1
   and (to_jsonb(new)-'revision') is not distinct from (to_jsonb(old)-'revision') then return new;end if;
  raise exception 'Revision is database managed' using errcode='23514';
 end if;
 if (to_jsonb(new)-'revision') is distinct from (to_jsonb(old)-'revision') then new.revision:=old.revision+1;end if;
 return new;
end $$;
create trigger conversation_revision before insert or update on public.sms_conversations
 for each row execute function sms_private.conversation_revision();

-- Includes CRM read-state changes, worker status/acceptance, new inbound/outbound
-- messages, deletes and both ends of a reassignment. Never touches generation.
create function sms_private.conversation_message_revision() returns trigger
language plpgsql security definer set search_path='' as $$
declare old_t text;new_t text;old_id uuid;new_id uuid;r record;
begin
 if tg_op='UPDATE' and (to_jsonb(new)-'updated_at') is not distinct from (to_jsonb(old)-'updated_at') then return new;end if;
 if tg_op<>'INSERT' then old_t:=old.tenant_id;old_id:=old.conversation_id;end if;
 if tg_op<>'DELETE' then new_t:=new.tenant_id;new_id:=new.conversation_id;end if;
 for r in select tenant_id,id from public.sms_conversations
  where (tenant_id=old_t and id=old_id) or (tenant_id=new_t and id=new_id)
  order by tenant_id,id for update loop
  update public.sms_conversations set revision=revision+1 where tenant_id=r.tenant_id and id=r.id;
 end loop;
 return null;
end $$;
create trigger conversation_message_revision after insert or update or delete on public.sms_messages
 for each row execute function sms_private.conversation_message_revision();

-- Contact changes invalidate reviewed context across only that contact's threads.
create function sms_private.conversation_contact_revision() returns trigger
language plpgsql security definer set search_path='' as $$
declare r record;
begin
 if (to_jsonb(new)-'updated_at') is not distinct from (to_jsonb(old)-'updated_at') then return new;end if;
 for r in select tenant_id,id from public.sms_conversations
  where (tenant_id=old.tenant_id and phone=old.phone) or (tenant_id=new.tenant_id and phone=new.phone)
  order by tenant_id,id for update loop
  update public.sms_conversations set revision=revision+1 where tenant_id=r.tenant_id and id=r.id;
 end loop;
 return null;
end $$;
create trigger conversation_contact_revision after update on public.sms_contacts
 for each row execute function sms_private.conversation_contact_revision();

-- Group context also participates in conversation reads. No changes to other groups.
create function sms_private.conversation_group_revision() returns trigger
language plpgsql security definer set search_path='' as $$
declare r record;
begin
 if (to_jsonb(new)-'updated_at') is not distinct from (to_jsonb(old)-'updated_at') then return new;end if;
 for r in select tenant_id,id from public.sms_conversations
  where (tenant_id=old.tenant_id and group_id=old.id) or (tenant_id=new.tenant_id and group_id=new.id)
  order by tenant_id,id for update loop
  update public.sms_conversations set revision=revision+1 where tenant_id=r.tenant_id and id=r.id;
 end loop;
 return null;
end $$;
create trigger conversation_group_revision after update on public.sms_automation_groups
 for each row execute function sms_private.conversation_group_revision();

-- Internal primitive for the next mutation wrappers. It does not grant MCP access
-- or perform a write; the caller must check current connection/action grants first
-- and perform the protected operation in this same transaction.
create function sms_private.lock_conversation_revision(u text,t text,cid uuid,expected jsonb) returns bigint
language plpgsql security definer set search_path='' as $$
declare current_revision bigint;
begin
 perform sms_private.require_admin(u);
 perform sms_private.require_sms_reader(u,t);
 if jsonb_typeof(expected) is distinct from 'number' or expected::text !~ '^[0-9]+$'
  or expected::text::numeric not between 1 and 9007199254740991 then raise exception 'Current revision required' using errcode='22023';end if;
 select c.revision into current_revision from public.sms_conversations c
 join public.sms_contacts contact on contact.tenant_id=c.tenant_id and contact.phone=c.phone
 where c.tenant_id=t and c.id=cid and (c.group_id is null or exists(select from public.sms_automation_groups g where g.tenant_id=t and g.id=c.group_id))
 for update of c;
 if current_revision is null then raise exception 'Conversation unavailable' using errcode='42501';end if;
 if current_revision<>expected::text::bigint then raise exception 'Conversation changed; reread and review before updating' using errcode='40001';end if;
 return current_revision;
end $$;
revoke all on function sms_private.conversation_revision(),sms_private.conversation_message_revision(),
 sms_private.conversation_contact_revision(),sms_private.conversation_group_revision(),
 sms_private.lock_conversation_revision(text,text,uuid,jsonb)
 from public,anon,authenticated,service_role,sms_api,crm_mcp,sms_sender,sms_webhook,sms_ai,sms_automation;

create or replace function sms_private.mcp_conversation_read(u text,t text,tool text,p jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare is_list boolean:=tool='crm_list_conversations'; allowed text[]; k text; pg integer:=1; size integer:=25;
 cid uuid; contact_filter uuid; include_messages boolean:=false; total bigint; unread_total bigint; result jsonb; msgs jsonb; tz text;
begin
 perform sms_private.require_sms_reader(u,t);
 if tool not in ('crm_list_conversations','crm_get_conversation') or tool is null then raise exception 'Unknown conversation read'; end if;
 if jsonb_typeof(p) is distinct from 'object' then raise exception 'Invalid conversation read'; end if;
 if jsonb_typeof(p->'businessId') is distinct from 'string' or length(btrim(p->>'businessId')) not between 1 and 255 or p->>'businessId' is distinct from t then raise exception 'Explicit business ID required'; end if;
 allowed:=case when is_list then array['businessId','page','pageSize','q','contactId','unreadOnly'] else array['businessId','conversationId','includeMessages','messagePage','messagePageSize'] end;
 if exists(select from jsonb_object_keys(p) keys(key) where not keys.key=any(allowed)) then raise exception 'Unexpected input field'; end if;
 if not is_list or p ? 'contactId' then
  k:=case when is_list then 'contactId' else 'conversationId' end;
  if jsonb_typeof(p->k) is distinct from 'string' or p->>k !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then raise exception 'Valid reference required'; end if;
  if is_list then contact_filter:=(p->>k)::uuid; else cid:=(p->>k)::uuid; end if;
 end if;
 foreach k in array case when is_list then array['page','pageSize'] else array['messagePage','messagePageSize'] end loop
  if p ? k and (jsonb_typeof(p->k) is distinct from 'number' or p->>k !~ '^[0-9]+$' or (p->>k)::numeric<1 or (p->>k)::numeric>case when k in ('page','messagePage') then 100000 else 100 end) then raise exception 'Invalid pagination'; end if;
 end loop;
 k:=case when is_list then 'unreadOnly' else 'includeMessages' end;
 if p ? k and jsonb_typeof(p->k) is distinct from 'boolean' then raise exception 'Invalid read option'; end if;
 if is_list then
  if p ? 'q' and (jsonb_typeof(p->'q') is distinct from 'string' or length(p->>'q')>100) then raise exception 'Invalid search'; end if;
  pg:=coalesce((p->>'page')::integer,1);size:=coalesce((p->>'pageSize')::integer,25);
 else
  include_messages:=coalesce((p->>'includeMessages')::boolean,false);
  pg:=coalesce((p->>'messagePage')::integer,1);size:=coalesce((p->>'messagePageSize')::integer,25);
 end if;
 -- Pin a detail revision across metadata and message-page statements. Related
 -- writers bump this row before committing, so the page cannot mix revisions.
 if not is_list then perform 1 from public.sms_conversations where tenant_id=t and id=cid for share;end if;
 -- Join all relationships through the selected business. Message summaries use
 -- only explicitly assigned conversation IDs and matching phone/group, not a
 -- phone-only fallback that might merge distinct threads. Never select a body
 -- in the metadata/search/count path.
 with scoped as materialized (
  select c.*,ct.id contact_id,ct.name contact_name,g.name group_name,
   stats.message_count,stats.unread_count,last_message.created_at last_message_at,last_message.direction last_direction
  from public.sms_conversations c
  join public.sms_contacts ct on ct.tenant_id=c.tenant_id and ct.phone=c.phone
  left join public.sms_automation_groups g on g.tenant_id=c.tenant_id and g.id=c.group_id
  cross join lateral (select count(*) message_count,count(*) filter(where m.direction='inbound' and m.read_at is null) unread_count
   from public.sms_messages m where m.tenant_id=c.tenant_id and m.conversation_id=c.id and m.contact_phone=c.phone
   and (m.direction='inbound' or m.category_id is not distinct from c.group_id)) stats
  left join lateral (select m.created_at,m.direction from public.sms_messages m
   where m.tenant_id=c.tenant_id and m.conversation_id=c.id and m.contact_phone=c.phone
   and (m.direction='inbound' or m.category_id is not distinct from c.group_id)
   order by m.created_at desc,m.id desc limit 1) last_message on true
  where c.tenant_id=t and (cid is null or c.id=cid) and (contact_filter is null or ct.id=contact_filter)
   and (c.group_id is null or g.id is not null)
   and (not is_list or (stats.message_count>0
    and (not coalesce((p->>'unreadOnly')::boolean,false) or stats.unread_count>0)
    and (coalesce(p->>'q','')='' or position(lower(p->>'q') in lower(concat_ws(' ',ct.name,c.phone)))>0)))
 ), paged as (select * from scoped order by last_message_at desc nulls last,id limit case when is_list then size else 1 end offset case when is_list then (pg-1)*size else 0 end)
 select (select count(*) from scoped),(select coalesce(sum(unread_count),0) from scoped),coalesce(jsonb_agg(jsonb_build_object(
  'id',id,'contact',jsonb_build_object('id',contact_id,'name',left(contact_name,200),'phone',left(phone,32)),
  'group',case when group_id is null then null else jsonb_build_object('id',group_id,'name',left(group_name,200)) end,
  'createdAt',created_at,'generation',generation,'revision',revision,'aiPaused',ai_paused,'messageCount',message_count,'unreadCount',unread_count,
  'lastMessageAt',last_message_at,'lastDirection',last_direction,
  'textTruncated',coalesce(length(contact_name)>200,false) or length(phone)>32 or coalesce(length(group_name)>200,false)
 ) order by last_message_at desc nulls last,id),'[]') into total,unread_total,result from paged;
 select time_zone into tz from public.sms_businesses where tenant_id=t;
 if is_list then return jsonb_build_object('businessId',t,'timeZone',tz,'reportingAt',statement_timestamp(),'conversations',result,'total',total,'unreadTotal',unread_total,'page',pg,'pageSize',size); end if;
 if total=0 then raise exception 'Conversation unavailable' using errcode='42501'; end if;
 if include_messages then
  select coalesce(jsonb_agg(jsonb_build_object('id',id,'direction',direction,'body',left(body,4000),'bodyTruncated',length(body)>4000,
   'status',left(status,64),'statusTruncated',length(status)>64,'createdAt',created_at,'updatedAt',updated_at,'providerAcceptedAt',provider_accepted_at,'readAt',read_at)
   order by created_at desc,id desc),'[]') into msgs from (
   select m.* from public.sms_messages m join public.sms_conversations c on c.tenant_id=m.tenant_id and c.id=m.conversation_id
   where c.tenant_id=t and c.id=cid and m.contact_phone=c.phone and (m.direction='inbound' or m.category_id is not distinct from c.group_id)
   order by m.created_at desc,m.id desc limit size offset (pg-1)*size
  ) message_page;
 end if;
 return jsonb_build_object('businessId',t,'timeZone',tz,'reportingAt',statement_timestamp(),'conversation',result->0,
  'messages',case when include_messages then jsonb_build_object('rows',msgs,'total',result->0->'messageCount','page',pg,'pageSize',size,'order','newest_first') else null end);
end $$;
revoke all on function sms_private.mcp_conversation_read(text,text,text,jsonb) from public,anon,authenticated,service_role,sms_api,crm_mcp;


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
  if not perms <@ array['read','draft','review','service_add','visibility','global_customer_lookup','automation_read','automation_draft','automation_preview','automation_publish','automation_enable','automation_run_start','automation_run_resume','automation_run_pause_stop','automation_activity','form_read','form_create','form_edit','form_preview','form_publish','form_activate','enquiry_read','enquiry_status_read','lead_read','lead_status_update','lead_assign','handoff_read','handoff_status_update','handoff_assign','conversation_read','conversation_messages_read','conversation_reply','conversation_mark_read']::text[] or cardinality(businesses)>500
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
 t text:=p->>'businessId'; target text:=coalesce(p->>'conversationId',p->>'leadId',p->>'handoffId',p->>'submissionId',p->>'runId',p->>'automationId',p->>'formId',p->>'businessId',p->>'accountId');
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
   required_permission:=case tool when 'crm_list_conversations' then 'conversation_read' when 'crm_get_conversation' then 'conversation_read' when 'crm_assign_lead' then 'lead_assign' when 'crm_set_lead_status' then 'lead_status_update' when 'crm_assign_handoff' then 'handoff_assign' when 'crm_set_handoff_status' then 'handoff_status_update' when 'crm_list_leads' then 'lead_read' when 'crm_get_lead' then 'lead_read' when 'crm_list_handoffs' then 'handoff_read' when 'crm_get_handoff' then 'handoff_read' when 'crm_get_enquiry_status' then 'enquiry_status_read' when 'crm_list_enquiries' then 'enquiry_read' when 'crm_get_enquiry' then 'enquiry_read' when 'crm_set_form_collection_enabled' then 'form_activate' when 'crm_apply_form_draft' then 'form_publish' when 'crm_preview_form' then 'form_preview' when 'crm_create_form' then 'form_create' when 'crm_save_form_draft' then 'form_edit' when 'crm_list_forms' then 'form_read' when 'crm_get_form' then 'form_read' when 'crm_search_customers' then 'read' when 'crm_get_customer' then 'read'
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
   if tool in ('crm_list_conversations','crm_get_conversation','crm_assign_lead','crm_set_lead_status','crm_assign_handoff','crm_set_handoff_status','crm_list_leads','crm_get_lead','crm_list_handoffs','crm_get_handoff','crm_get_enquiry_status','crm_list_enquiries','crm_get_enquiry','crm_set_form_collection_enabled','crm_apply_form_draft','crm_preview_form','crm_create_form','crm_save_form_draft','crm_list_forms','crm_get_form','crm_list_sms_runs','crm_get_sms_run','crm_get_sms_run_activity','crm_resume_sms_run','crm_pause_sms_run','crm_stop_sms_run','crm_get_sms_run_start_context','crm_start_sms_automation_run','crm_publish_sms_automation','crm_set_form_followups_enabled','crm_create_sms_automation','crm_save_sms_automation_draft','crm_preview_sms_automation','crm_list_sms_automations','crm_get_sms_automation','crm_search_sms_contacts','crm_list_form_submissions','crm_get_business','crm_save_business_profile_draft','crm_review_business_profile','crm_add_business_service','crm_set_service_visibility')
    and (t is null or (not c.all_businesses and not t=any(c.business_ids)) or not exists(select from public.sms_businesses where tenant_id=t)) then raise exception 'Business access denied' using errcode='42501'; end if;
   if tool='crm_start_sms_automation_run' and p->>'overlapChoice'='stop_selected' and not 'automation_run_pause_stop'=any(c.permissions) then raise exception 'Stopping overlapping runs is not granted' using errcode='42501'; end if;
   if tool='crm_get_conversation' and p->'includeMessages'='true'::jsonb and not 'conversation_messages_read'=any(c.permissions) then raise exception 'Message content is not granted' using errcode='42501'; end if;
   if tool in ('crm_list_conversations','crm_get_conversation') then
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
     if tool in ('crm_assign_lead','crm_set_lead_status','crm_assign_handoff','crm_set_handoff_status') then
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
  error_code:=case when state='42501' then 'PERMISSION_DENIED' when state in ('23505','40001') then 'CONFLICT' when state in ('P0001','22P02','22023','23514','23502','P0002') then 'VALIDATION_ERROR' else 'TEMPORARY_FAILURE' end;
  if error_code='TEMPORARY_FAILURE' then error_message:='Service temporarily unavailable. Retry with the same idempotency key.'; end if;
  result:=jsonb_build_object('ok',false,'error',jsonb_build_object('code',error_code,'message',error_message,'retryable',error_code='TEMPORARY_FAILURE'));
 end;
 insert into sms_private.mcp_activity(connection_id,actor_id,tool,target,request_id,outcome,code,revision,draft_revision,previous_revision,changed_fields)
  values(c.id,aid,left(tool,100),left(coalesce(data->'conversation'->>'id',data->'lead'->>'id',data->'handoff'->>'id',data->'enquiry'->>'id',data->'form'->>'id',data->'run'->>'id',data->'automation'->>'id',target),255),request_id,case when error_code is not null then 'denied' when replay then 'replayed' else 'success' end,error_code,
   case when error_code is null then coalesce((data->'conversation'->>'revision')::bigint,(data->'lead'->>'revision')::bigint,(data->'handoff'->>'revision')::bigint,(data->'enquiryStatus'->'sms'->>'generation')::bigint,(data->'enquiryStatus'->>'submittedFormVersion')::bigint,(data->'enquiry'->>'submittedFormVersion')::bigint,(data->'form'->>'revision')::bigint,(data->'run'->>'generation')::bigint,(data->'source'->>'revision')::bigint,(data->'automation'->>'revision')::bigint,(data->'record'->>'revision')::bigint,(data->'business'->'setup'->>'revision')::bigint) end,
   case when error_code is null then (data->'form'->>'draftRevision')::bigint end,
   case when error_code is null and tool in ('crm_assign_lead','crm_set_lead_status','crm_assign_handoff','crm_set_handoff_status') then (data->>'previousRevision')::bigint end,
   case when error_code is null and tool in ('crm_assign_lead','crm_set_lead_status','crm_assign_handoff','crm_set_handoff_status') then array(select jsonb_array_elements_text(data->'changedFields')) end);
 if error_code is null and tool='crm_start_sms_automation_run' then
  insert into sms_private.mcp_activity(connection_id,actor_id,tool,target,request_id,outcome,revision)
   select c.id,aid,'crm_start_sms_automation_run:replace',v->>'id',request_id,case when replay then 'replayed' else 'success' end,(v->>'generation')::bigint from jsonb_array_elements(data->'stoppedRuns') v;
 end if;
 return result;
end $$;

create or replace function sms_private.list_conversation_threads(u text,t text,p jsonb default '{}') returns jsonb
language plpgsql security definer set search_path='' as $$
declare page_number integer; page_size integer; total_count bigint; unread_total bigint; rows jsonb; search_text text;
begin
  if not sms_private.can_access(t,u) then raise exception 'Tenant access denied' using errcode='42501'; end if;
  page_number:=greatest(1,least(100000,coalesce((p->>'page')::integer,1)));
  page_size:=greatest(1,least(250,coalesce((p->>'pageSize')::integer,50)));
  search_text:=nullif(btrim(p->>'q'),'');
  with matches as (
    select c.id,c.phone,c.group_id,c.ai_paused,c.generation,c.revision,c.created_at,
      coalesce(nullif(contact.name,''),c.phone) as name,
      g.name as group_name,last_message.body as last_body,
      last_message.direction as last_direction,
      last_message.created_at as last_message_at,
      (select count(*) from public.sms_messages m where m.tenant_id=t
        and m.conversation_id=c.id and m.direction='inbound' and m.read_at is null)::integer as unread_count
    from public.sms_conversations c
    join public.sms_contacts contact on contact.tenant_id=c.tenant_id and contact.phone=c.phone
    left join public.sms_automation_groups g on g.tenant_id=c.tenant_id and g.id=c.group_id
    join lateral (select body,direction,created_at from public.sms_messages m
      where m.tenant_id=c.tenant_id and m.conversation_id=c.id
      order by created_at desc,id desc limit 1) last_message on true
    where c.tenant_id=t and (search_text is null or c.phone ilike '%'||search_text||'%'
      or contact.name ilike '%'||search_text||'%')
  ), filtered as (
    select * from matches where p->>'unread' is distinct from '1' or unread_count>0
  ), page_rows as (
    select * from filtered order by last_message_at desc,id
      limit page_size offset (page_number-1)*page_size
  )
  select (select count(*) from filtered),
    (select coalesce(sum(unread_count),0) from filtered),
    (select coalesce(jsonb_agg(to_jsonb(x) order by x.last_message_at desc,x.id),'[]'::jsonb)
      from page_rows x) into total_count,unread_total,rows;
  return jsonb_build_object('rows',rows,'total',total_count,'page',page_number,
    'pageSize',page_size,'unreadTotal',unread_total,
    'totalPages',greatest(1,ceil(total_count::numeric/page_size)));
end $$;

