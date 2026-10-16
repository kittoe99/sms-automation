-- CRM owned. Forward only after 20261016183855. No contact backfill or grants.
create function sms_private.mcp_contact_record(c public.sms_contacts) returns jsonb
language sql immutable set search_path='' as $$
 select jsonb_build_object('id',c.id,'name',left(c.name,200),'phone',c.phone,'email',c.email,'revision',c.revision)
$$;

create function sms_private.mcp_contact_action(u text,t text,tool text,p jsonb,connection_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare c public.sms_contacts; rev bigint; keys text[]; mutation boolean; pg integer:=1; size integer:=25;
 total bigint; rows jsonb; result jsonb; preview jsonb; blockers text[]:='{}'; sender_ready boolean;
 context record; secret_id uuid; body text; segments integer; key text; evidence text;
begin
 mutation:=tool in ('crm_create_contact','crm_update_contact','crm_record_contact_sms_opt_in','crm_suppress_contact_sms','crm_set_contact_automation_blocked','crm_send_contact_sms');
 keys:=case tool
 when 'crm_list_contacts' then array['businessId','page','pageSize','q']
 when 'crm_get_contact' then array['businessId','contactId']
 when 'crm_get_contact_consent' then array['businessId','contactId','page','pageSize']
 when 'crm_create_contact' then array['businessId','phone','name','email','idempotencyKey']
 when 'crm_update_contact' then array['businessId','contactId','revision','name','email','idempotencyKey']
 when 'crm_record_contact_sms_opt_in' then array['businessId','contactId','revision','channel','purpose','evidence','source','observedAt','idempotencyKey']
 when 'crm_suppress_contact_sms' then array['businessId','contactId','revision','reason','idempotencyKey']
 when 'crm_set_contact_automation_blocked' then array['businessId','contactId','revision','blocked','idempotencyKey']
 when 'crm_preview_contact_sms' then array['businessId','contactId','revision','body']
 when 'crm_send_contact_sms' then array['businessId','contactId','revision','body','idempotencyKey'] end;
 if keys is null or jsonb_typeof(p) is distinct from 'object'
 or jsonb_typeof(p->'businessId') is distinct from 'string' or p->>'businessId' is distinct from t
 or length(t) not between 1 and 255 or exists(select from jsonb_object_keys(p) k where not k=any(keys))
 then raise exception 'Invalid contact input' using errcode='22023';end if;
 if p ? 'page' then
  if jsonb_typeof(p->'page') is distinct from 'number' or (p->>'page') !~ '^[0-9]+$' or (p->>'page')::numeric not between 1 and 100000 then raise exception 'Invalid page' using errcode='22023';end if;pg:=(p->>'page')::integer;
 end if;
 if p ? 'pageSize' then
  if jsonb_typeof(p->'pageSize') is distinct from 'number' or (p->>'pageSize') !~ '^[0-9]+$' or (p->>'pageSize')::numeric not between 1 and 100 then raise exception 'Invalid page size' using errcode='22023';end if;size:=(p->>'pageSize')::integer;
 end if;
 if p ? 'q' and (jsonb_typeof(p->'q') is distinct from 'string' or length(p->>'q')>100) then raise exception 'Invalid search' using errcode='22023';end if;
 if p ? 'name' and (jsonb_typeof(p->'name') is distinct from 'string' or length(p->>'name')>200) then raise exception 'Invalid name' using errcode='22023';end if;
 if p ? 'email' and p->'email'<>'null'::jsonb and (jsonb_typeof(p->'email') is distinct from 'string' or length(p->>'email')>254 or p->>'email' !~ '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$') then raise exception 'Invalid email' using errcode='22023';end if;
 if tool='crm_list_contacts' then
  with eligible as materialized(select * from public.sms_contacts where tenant_id=t and concat_ws(' ',name,phone,email) ilike '%'||coalesce(p->>'q','')||'%'),
  selected as(select * from eligible order by id limit size offset (pg-1)*size)
  select (select count(*) from eligible),coalesce(jsonb_agg(sms_private.mcp_contact_record(x) order by x.id),'[]') into total,rows from selected x;
  return jsonb_build_object('businessId',t,'contacts',rows,'total',total,'page',pg,'pageSize',size);
 end if;
 if tool='crm_create_contact' then
  if jsonb_typeof(p->'phone') is distinct from 'string' or p->>'phone' !~ '^[+][1-9][0-9]{7,14}$' then raise exception 'E.164 phone required' using errcode='22023';end if;
  perform sms_private.coordination_lock(t,p->>'phone');
  if exists(select from public.sms_contacts where tenant_id=t and phone=p->>'phone') then raise exception 'Contact already exists; reread before editing' using errcode='40001';end if;
  -- The browser's legacy contact upsert is deliberately not used: another
  -- writer may create this phone after our lookup without taking this lock.
  -- INSERT plus the canonical unique constraint/triggers preserves that row.
  insert into public.sms_contacts(tenant_id,phone,name,email,source)
   values(t,p->>'phone',coalesce(p->>'name',''),p->>'email','mcp') returning * into c;
 else
  if jsonb_typeof(p->'contactId') is distinct from 'string' or coalesce(p->>'contactId','') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then raise exception 'Contact ID required' using errcode='22023';end if;
  select * into c from public.sms_contacts where tenant_id=t and id=(p->>'contactId')::uuid;
  if not found then raise exception 'Contact unavailable' using errcode='42501';end if;
  if tool='crm_get_contact' then return jsonb_build_object('businessId',t,'contact',sms_private.mcp_contact_record(c));end if;
  if tool='crm_get_contact_consent' then
   select count(*) into total from public.sms_consent_events where tenant_id=t and contact_id=c.id;
   select coalesce(jsonb_agg(jsonb_build_object('id',x.id,'consent',x.consent,'source',x.source,'evidence',x.evidence,'createdAt',x.created_at) order by x.created_at desc,x.id),'[]') into rows
    from(select * from public.sms_consent_events where tenant_id=t and contact_id=c.id order by created_at desc,id limit size offset (pg-1)*size)x;
   return jsonb_build_object('businessId',t,'contactId',c.id,'revision',c.revision,'channel','sms','purpose','marketing','optedOut',c.opted_out,'marketingConsent',c.marketing_consent,'enquiryBlocked',c.enquiry_blocked,'events',rows,'total',total,'page',pg,'pageSize',size);
  end if;
  if jsonb_typeof(p->'revision') is distinct from 'number' or coalesce(p->>'revision','') !~ '^[0-9]+$' or (p->>'revision')::numeric not between 1 and 9007199254740991 then raise exception 'Current revision required' using errcode='22023';end if;
  perform sms_private.coordination_lock(t,c.phone);
  select * into strict c from public.sms_contacts where tenant_id=t and id=c.id for update;
  rev:=c.revision;
  if c.revision<>(p->>'revision')::bigint then raise exception 'Contact changed; reread' using errcode='40001';end if;
  key:='mcp-contact:'||connection_id::text||':'||encode(sha256(convert_to(coalesce(p->>'idempotencyKey',''),'UTF8')),'hex');
  if tool in ('crm_preview_contact_sms','crm_send_contact_sms') then
   if jsonb_typeof(p->'body') is distinct from 'string' then raise exception 'Message body required' using errcode='22023';end if;
   body:=btrim(p->>'body',U&'\0009\000a\000b\000c\000d\0020\00a0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200a\2028\2029\202f\205f\3000\feff');segments:=sms_private.conversation_reply_segments(body);
   -- Hold readiness metadata only for sends; previews never reserve work.
   if tool='crm_send_contact_sms' then
    perform 1 from public.sms_businesses where tenant_id=t for share nowait;
    select auth_secret_id into secret_id from sms_private.providers where tenant_id=t for share nowait;
    perform 1 from vault.secrets where id=secret_id for key share nowait;
   end if;
   select status,sending_enabled into context from public.sms_businesses where tenant_id=t;
   select provisioning_state='configured' and nullif(account_sid,'') is not null
    and (nullif(messaging_service_sid,'') is not null or nullif(from_number,'') is not null)
    and exists(select from vault.secrets where id=auth_secret_id) into sender_ready from sms_private.providers where tenant_id=t;
   if c.opted_out then blockers:=array_append(blockers,'CONTACT_OPTED_OUT');end if;
   if not c.marketing_consent then blockers:=array_append(blockers,'MARKETING_CONSENT_REQUIRED');end if;
   if context.status<>'active' or not context.sending_enabled then blockers:=array_append(blockers,'BUSINESS_SENDING_DISABLED');end if;
   if sender_ready is not true then blockers:=array_append(blockers,'SENDER_NOT_READY');end if;
   if tool='crm_preview_contact_sms' then return jsonb_build_object('businessId',t,'contactId',c.id,'revision',c.revision,'recipientPhone',c.phone,'body',body,'estimatedSegments',segments,'eligible',cardinality(blockers)=0,'blockers',to_jsonb(blockers),'queued',false);end if;
   if cardinality(blockers)>0 then raise exception 'SMS not eligible: %',blockers using errcode='42501';end if;
   result:=sms_private.api_action(u,t,'send',jsonb_build_object('phone',c.phone,'body',body,'purpose','marketing','idempotencyKey',key));
  elsif tool in ('crm_update_contact','crm_set_contact_automation_blocked') then
   if tool='crm_update_contact' and not (p ? 'name' or p ? 'email') then raise exception 'Specify name or email' using errcode='22023';end if;
   if tool='crm_set_contact_automation_blocked' and jsonb_typeof(p->'blocked') is distinct from 'boolean' then raise exception 'Blocked state required' using errcode='22023';end if;
   perform sms_private.contact_automations(u,t,case when tool='crm_update_contact' then 'edit' else 'block' end,(p-'businessId')||jsonb_build_object('idempotencyKey',key));
  elsif tool in ('crm_record_contact_sms_opt_in','crm_suppress_contact_sms') then
   if tool='crm_record_contact_sms_opt_in' then
    if p->>'channel' is distinct from 'sms' or p->>'purpose' is distinct from 'marketing'
     or jsonb_typeof(p->'evidence') is distinct from 'string' or length(btrim(p->>'evidence')) not between 1 and 2000
     or jsonb_typeof(p->'source') is distinct from 'string' or length(btrim(p->>'source')) not between 1 and 100
     or jsonb_typeof(p->'observedAt') is distinct from 'string' or (p->>'observedAt') !~ '(Z|[+-][0-9]{2}:[0-9]{2})$'
     then raise exception 'Consent evidence and provenance required' using errcode='22023';end if;
    if (p->>'observedAt')::timestamptz>clock_timestamp() then raise exception 'Consent evidence cannot be in the future' using errcode='22023';end if;
    evidence:=jsonb_build_object('evidence',p->>'evidence','source',p->>'source','observedAt',p->>'observedAt','channel','sms','purpose','marketing')::text;
   else
    if jsonb_typeof(p->'reason') is distinct from 'string' or length(btrim(p->>'reason')) not between 1 and 1000 then raise exception 'Suppression reason required' using errcode='22023';end if;evidence:=p->>'reason';
   end if;
   perform sms_private.api_action(u,t,'consent',jsonb_build_object('phone',c.phone,'consent',tool='crm_record_contact_sms_opt_in','evidence',evidence));
  else raise exception 'Unknown contact tool' using errcode='22023';end if;
  select * into strict c from public.sms_contacts where tenant_id=t and id=c.id;
 end if;
 return jsonb_build_object('businessId',t,'contactId',c.id,'previousRevision',rev,'revision',c.revision,'databaseStatus','committed')||
  case when tool='crm_send_contact_sms' then jsonb_build_object('messageId',result->>'messageId','jobId',result->>'jobId','deliveryStatus','queued') else '{}'::jsonb end;
end $$;
revoke all on function sms_private.mcp_contact_record(public.sms_contacts),sms_private.mcp_contact_action(text,text,text,jsonb,uuid)
 from public,anon,authenticated,service_role,sms_api,crm_mcp,sms_sender,sms_webhook,sms_ai,sms_automation;

alter table sms_private.mcp_connections drop constraint mcp_connections_permissions_check;
alter table sms_private.mcp_connections add constraint mcp_connections_permissions_check check
 (permissions <@ array['read','draft','review','service_add','visibility','global_customer_lookup',
 'automation_read','automation_draft','automation_preview','automation_publish','automation_enable',
 'automation_run_start','automation_run_resume','automation_run_pause_stop','automation_activity',
 'form_read','form_create','form_edit','form_preview','form_publish','form_activate','enquiry_read','enquiry_status_read','lead_read','lead_status_update','lead_assign','handoff_read','handoff_status_update','handoff_assign','conversation_read','conversation_messages_read','conversation_reply','conversation_mark_read','contact_read','contact_create','contact_edit','consent_read','consent_opt_in','contact_suppress','contact_automation_block','sms_message_preview','sms_message_send']::text[]);

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
  if not perms <@ array['read','draft','review','service_add','visibility','global_customer_lookup','automation_read','automation_draft','automation_preview','automation_publish','automation_enable','automation_run_start','automation_run_resume','automation_run_pause_stop','automation_activity','form_read','form_create','form_edit','form_preview','form_publish','form_activate','enquiry_read','enquiry_status_read','lead_read','lead_status_update','lead_assign','handoff_read','handoff_status_update','handoff_assign','conversation_read','conversation_messages_read','conversation_reply','conversation_mark_read','contact_read','contact_create','contact_edit','consent_read','consent_opt_in','contact_suppress','contact_automation_block','sms_message_preview','sms_message_send']::text[] or cardinality(businesses)>500
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
 t text:=p->>'businessId'; target text:=coalesce(p->>'contactId',p->>'conversationId',p->>'leadId',p->>'handoffId',p->>'submissionId',p->>'runId',p->>'automationId',p->>'formId',p->>'businessId',p->>'accountId');
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
   required_permission:=case tool when 'crm_list_contacts' then 'contact_read' when 'crm_get_contact' then 'contact_read' when 'crm_get_contact_consent' then 'consent_read' when 'crm_create_contact' then 'contact_create' when 'crm_update_contact' then 'contact_edit' when 'crm_record_contact_sms_opt_in' then 'consent_opt_in' when 'crm_suppress_contact_sms' then 'contact_suppress' when 'crm_set_contact_automation_blocked' then 'contact_automation_block' when 'crm_preview_contact_sms' then 'sms_message_preview' when 'crm_send_contact_sms' then 'sms_message_send' when 'crm_reply_to_conversation' then 'conversation_reply' when 'crm_preview_conversation_reply' then 'conversation_reply' when 'crm_mark_conversation_messages_read' then 'conversation_mark_read' when 'crm_list_conversations' then 'conversation_read' when 'crm_get_conversation' then 'conversation_read' when 'crm_assign_lead' then 'lead_assign' when 'crm_set_lead_status' then 'lead_status_update' when 'crm_assign_handoff' then 'handoff_assign' when 'crm_set_handoff_status' then 'handoff_status_update' when 'crm_list_leads' then 'lead_read' when 'crm_get_lead' then 'lead_read' when 'crm_list_handoffs' then 'handoff_read' when 'crm_get_handoff' then 'handoff_read' when 'crm_get_enquiry_status' then 'enquiry_status_read' when 'crm_list_enquiries' then 'enquiry_read' when 'crm_get_enquiry' then 'enquiry_read' when 'crm_set_form_collection_enabled' then 'form_activate' when 'crm_apply_form_draft' then 'form_publish' when 'crm_preview_form' then 'form_preview' when 'crm_create_form' then 'form_create' when 'crm_save_form_draft' then 'form_edit' when 'crm_list_forms' then 'form_read' when 'crm_get_form' then 'form_read' when 'crm_search_customers' then 'read' when 'crm_get_customer' then 'read'
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
   if tool in ('crm_list_contacts','crm_get_contact','crm_get_contact_consent','crm_create_contact','crm_update_contact','crm_record_contact_sms_opt_in','crm_suppress_contact_sms','crm_set_contact_automation_blocked','crm_preview_contact_sms','crm_send_contact_sms','crm_reply_to_conversation','crm_preview_conversation_reply','crm_mark_conversation_messages_read','crm_list_conversations','crm_get_conversation','crm_assign_lead','crm_set_lead_status','crm_assign_handoff','crm_set_handoff_status','crm_list_leads','crm_get_lead','crm_list_handoffs','crm_get_handoff','crm_get_enquiry_status','crm_list_enquiries','crm_get_enquiry','crm_set_form_collection_enabled','crm_apply_form_draft','crm_preview_form','crm_create_form','crm_save_form_draft','crm_list_forms','crm_get_form','crm_list_sms_runs','crm_get_sms_run','crm_get_sms_run_activity','crm_resume_sms_run','crm_pause_sms_run','crm_stop_sms_run','crm_get_sms_run_start_context','crm_start_sms_automation_run','crm_publish_sms_automation','crm_set_form_followups_enabled','crm_create_sms_automation','crm_save_sms_automation_draft','crm_preview_sms_automation','crm_list_sms_automations','crm_get_sms_automation','crm_search_sms_contacts','crm_list_form_submissions','crm_get_business','crm_save_business_profile_draft','crm_review_business_profile','crm_add_business_service','crm_set_service_visibility')
    and (t is null or (not c.all_businesses and not t=any(c.business_ids)) or not exists(select from public.sms_businesses where tenant_id=t)) then raise exception 'Business access denied' using errcode='42501'; end if;
   if tool='crm_start_sms_automation_run' and p->>'overlapChoice'='stop_selected' and not 'automation_run_pause_stop'=any(c.permissions) then raise exception 'Stopping overlapping runs is not granted' using errcode='42501'; end if;
   if tool='crm_get_conversation' and p->'includeMessages'='true'::jsonb and not 'conversation_messages_read'=any(c.permissions) then raise exception 'Message content is not granted' using errcode='42501'; end if;
   if tool in ('crm_list_contacts','crm_get_contact','crm_get_contact_consent','crm_preview_contact_sms') then
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
     if tool in ('crm_create_contact','crm_update_contact','crm_record_contact_sms_opt_in','crm_suppress_contact_sms','crm_set_contact_automation_blocked','crm_send_contact_sms') then
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
  values(c.id,aid,left(tool,100),left(coalesce(data->>'contactId',data->'contact'->>'id',data->'conversation'->>'id',data->'lead'->>'id',data->'handoff'->>'id',data->'enquiry'->>'id',data->'form'->>'id',data->'run'->>'id',data->'automation'->>'id',target),255),request_id,case when error_code is not null then 'denied' when replay then 'replayed' else 'success' end,error_code,
   case when error_code is null then coalesce((data->>'revision')::bigint,(data->'contact'->>'revision')::bigint,(data->'conversation'->>'revision')::bigint,(data->'lead'->>'revision')::bigint,(data->'handoff'->>'revision')::bigint,(data->'enquiryStatus'->'sms'->>'generation')::bigint,(data->'enquiryStatus'->>'submittedFormVersion')::bigint,(data->'enquiry'->>'submittedFormVersion')::bigint,(data->'form'->>'revision')::bigint,(data->'run'->>'generation')::bigint,(data->'source'->>'revision')::bigint,(data->'automation'->>'revision')::bigint,(data->'record'->>'revision')::bigint,(data->'business'->'setup'->>'revision')::bigint) end,
   case when error_code is null then (data->'form'->>'draftRevision')::bigint end,
   case when error_code is null and tool in ('crm_create_contact','crm_update_contact','crm_record_contact_sms_opt_in','crm_suppress_contact_sms','crm_set_contact_automation_blocked','crm_send_contact_sms','crm_reply_to_conversation','crm_mark_conversation_messages_read','crm_assign_lead','crm_set_lead_status','crm_assign_handoff','crm_set_handoff_status') then (data->>'previousRevision')::bigint end,
   case when error_code is null and tool in ('crm_assign_lead','crm_set_lead_status','crm_assign_handoff','crm_set_handoff_status') then array(select jsonb_array_elements_text(data->'changedFields')) end,
   case when error_code is null and tool in ('crm_reply_to_conversation','crm_send_contact_sms') then array[(data->>'messageId')::uuid] when error_code is null and tool='crm_mark_conversation_messages_read' then array(select x::uuid from jsonb_array_elements_text(data->'changedMessageIds') x) end,
   case when error_code is null and tool in ('crm_reply_to_conversation','crm_send_contact_sms') then 1 when error_code is null and tool='crm_mark_conversation_messages_read' then (data->>'changedCount')::integer end);
 if error_code is null and tool='crm_start_sms_automation_run' then
  insert into sms_private.mcp_activity(connection_id,actor_id,tool,target,request_id,outcome,revision)
   select c.id,aid,'crm_start_sms_automation_run:replace',v->>'id',request_id,case when replay then 'replayed' else 'success' end,(v->>'generation')::bigint from jsonb_array_elements(data->'stoppedRuns') v;
 end if;
 return result;
end $$;
