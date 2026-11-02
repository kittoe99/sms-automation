-- CRM-owned: requires reusable email automation migration; new grants are opt-in.
create function sms_private.mcp_email_template_action(u text,t text,tool text,p jsonb,cid uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare action text; allowed text[]; required text[]; k text; result jsonb;
begin
action:=case tool
 when 'crm_get_email_automation_workspace' then 'read'
 when 'crm_preview_email_template' then 'preview'
 when 'crm_create_email_template' then 'create'
 when 'crm_save_email_template' then 'save'
 when 'crm_publish_email_template' then 'publish'
 when 'crm_archive_email_template' then 'archive'
 when 'crm_duplicate_email_template' then 'duplicate'
 when 'crm_set_email_automation_settings' then 'settings'
 when 'crm_connect_email_template' then 'connection'
 when 'crm_set_email_template_form_consent' then 'form_consent'
 when 'crm_record_email_marketing_consent' then 'consent'
 when 'crm_start_email_template_run' then 'start'
 when 'crm_pause_email_template_run' then 'pause'
 when 'crm_resume_email_template_run' then 'resume'
 when 'crm_stop_email_template_run' then 'stop'
 when 'crm_retry_email_template_run' then 'retry'
 end;
allowed:=case tool
 when 'crm_get_email_automation_workspace' then array['businessId','page']
 when 'crm_preview_email_template' then array['businessId','id','revision','startAt','appointmentAt']
 when 'crm_create_email_template' then array['businessId','idempotencyKey','name','definition']
 when 'crm_save_email_template' then array['businessId','idempotencyKey','id','revision','name','definition']
 when 'crm_publish_email_template' then array['businessId','idempotencyKey','id','revision']
 when 'crm_archive_email_template' then array['businessId','idempotencyKey','id','revision']
 when 'crm_duplicate_email_template' then array['businessId','idempotencyKey','id','revision']
 when 'crm_set_email_automation_settings' then array['businessId','idempotencyKey','revision','enabled','replyTo','mailingAddress','domainId']
 when 'crm_connect_email_template' then array['businessId','idempotencyKey','id','revision','templateId','event','formId','enabled','replaceLegacy']
 when 'crm_set_email_template_form_consent' then array['businessId','idempotencyKey','formId','revision','enabled']
 when 'crm_record_email_marketing_consent' then array['businessId','idempotencyKey','contactId','contactRevision','consent','evidence']
 when 'crm_start_email_template_run' then array['businessId','idempotencyKey','templateId','contactId','contactRevision','request']
 when 'crm_pause_email_template_run' then array['businessId','idempotencyKey','runId','revision','generation']
 when 'crm_resume_email_template_run' then array['businessId','idempotencyKey','runId','revision','generation']
 when 'crm_stop_email_template_run' then array['businessId','idempotencyKey','runId','revision','generation']
 when 'crm_retry_email_template_run' then array['businessId','idempotencyKey','runId','revision','generation']
 end;
required:=case tool
 when 'crm_get_email_automation_workspace' then array['businessId']
 when 'crm_preview_email_template' then array['businessId','id','revision','startAt']
 when 'crm_create_email_template' then array['businessId','idempotencyKey','name','definition']
 when 'crm_save_email_template' then array['businessId','idempotencyKey','id','revision','name','definition']
 when 'crm_publish_email_template' then array['businessId','idempotencyKey','id','revision']
 when 'crm_archive_email_template' then array['businessId','idempotencyKey','id','revision']
 when 'crm_duplicate_email_template' then array['businessId','idempotencyKey','id','revision']
 when 'crm_set_email_automation_settings' then array['businessId','idempotencyKey','revision','enabled','replyTo','mailingAddress','domainId']
 when 'crm_connect_email_template' then array['businessId','idempotencyKey','templateId','event','formId','enabled','replaceLegacy']
 when 'crm_set_email_template_form_consent' then array['businessId','idempotencyKey','formId','revision','enabled']
 when 'crm_record_email_marketing_consent' then array['businessId','idempotencyKey','contactId','contactRevision','consent','evidence']
 when 'crm_start_email_template_run' then array['businessId','idempotencyKey','templateId','contactId','contactRevision']
 when 'crm_pause_email_template_run' then array['businessId','idempotencyKey','runId','revision','generation']
 when 'crm_resume_email_template_run' then array['businessId','idempotencyKey','runId','revision','generation']
 when 'crm_stop_email_template_run' then array['businessId','idempotencyKey','runId','revision','generation']
 when 'crm_retry_email_template_run' then array['businessId','idempotencyKey','runId','revision','generation']
 end;

 if action is null or jsonb_typeof(p) is distinct from 'object' or length(p::text)>350000 or exists(select from jsonb_object_keys(p) x where not x=any(allowed)) then raise exception 'Invalid email template input'; end if;
 foreach k in array required loop
  if not p ? k then raise exception 'Missing email field: %',k; end if;
 end loop;
 foreach k in array allowed loop
  if not p ? k then continue; end if;
  if k in ('enabled','consent','replaceLegacy') then
   if jsonb_typeof(p->k)<>'boolean' then raise exception 'Invalid boolean'; end if;
  elsif k in ('revision','contactRevision','generation','page') then
   if jsonb_typeof(p->k)<>'number' or (p->>k)::numeric<>trunc((p->>k)::numeric) or (p->>k)::numeric<(case when action='settings' and k='revision' then 0 else 1 end) or (p->>k)::numeric>(case when k='page' then 10000 else 2147483647 end) then raise exception 'Invalid revision or page'; end if;
  elsif k='definition' then perform sms_private.email_validate_definition(p->k);
  elsif k in ('id','templateId','contactId','formId','domainId','runId','idempotencyKey') then
   if p->k='null'::jsonb and k in ('formId','domainId') then continue; end if;
   if jsonb_typeof(p->k)<>'string' then raise exception 'Invalid identifier'; end if;
   perform (p->>k)::uuid;
  elsif k='appointmentAt' and p->k='null'::jsonb then continue;
  elsif jsonb_typeof(p->k)<>'string' then raise exception 'Invalid text';
  end if;
 end loop;
 if action='connection' and ((p ? 'id')<>(p ? 'revision') or ((p->>'event'='form.submitted')<>(p->>'formId' is not null))) then raise exception 'Connection revision and form source must match'; end if;
 if length(coalesce(p->>'request',''))>1600 or length(coalesce(p->>'evidence',''))>2000 then raise exception 'Email text too long'; end if;
 result:=sms_private.email_automation_apply(t,'mcp:'||cid::text,action,p-'businessId');
 if action='read' then
  if jsonb_typeof(result->'sender')='object' then result:=jsonb_set(result,'{sender}',(result->'sender')-'providerId'); end if;
  return result;
 elsif action='preview' then return result;
 end if;
 -- Never persist message content, recipient addresses or consent evidence in MCP receipts.
 return jsonb_build_object('businessId',t,'databaseStatus','committed','id',coalesce(result->'id',result->'runId'),'revision',result->'revision','generation',result->'generation','status',result->'status');
end $$;
revoke all on function sms_private.mcp_email_template_action(text,text,text,jsonb,uuid) from public,anon,authenticated,service_role,sms_api,crm_mcp;

alter table sms_private.mcp_connections drop constraint mcp_connections_permissions_check;
alter table sms_private.mcp_connections add constraint mcp_connections_permissions_check check(permissions <@ array['email_automation_read','email_automation_edit','email_automation_publish','email_automation_connect','email_automation_settings','email_automation_consent','email_automation_start','email_automation_control','ai_reply_preview','ai_reply_read','ai_reply_content_read','operations_read','provider_read','provider_refresh','provider_reconcile','operations_retry','sending_activate','website_read','website_deployment_read','website_details_edit','website_form_read','website_form_connect','website_form_disable','website_request_read','website_request_edit','website_publish','website_unpublish','voice_config_read','voice_create','voice_edit','voice_publish','voice_rollback','voice_call_read','voice_transcript_read','voice_media_read','email_form_enable','email_read','email_preview','email_config_edit','email_enable','email_resolve','email_retry','email_content_read','knowledge_read','knowledge_upload','knowledge_create','knowledge_refresh','knowledge_archive','knowledge_approve','ai_config_read','ai_config_edit','ai_activate','booking_read','booking_intake_read','booking_schedule_read','booking_schedule_edit','booking_schedule_enable','booking_preview','booking_intake_edit','booking_cancel','form_duplicate','form_archive','form_restore','automation_archive','automation_preset_read','automation_preset_save','conversation_ai_pause','conversation_ai_resume','conversation_message_reassign','handoff_alert_retry','activity_report_read','activity_tag_manage','activity_attribution_update','read','draft','review','service_add','visibility','global_customer_lookup','automation_read','automation_draft','automation_preview','automation_publish','automation_enable','automation_run_start','automation_run_resume','automation_run_pause_stop','automation_activity','form_read','form_create','form_edit','form_preview','form_publish','form_activate','enquiry_read','enquiry_status_read','lead_read','lead_status_update','lead_assign','handoff_read','handoff_status_update','handoff_assign','conversation_read','conversation_messages_read','conversation_reply','conversation_mark_read','contact_read','contact_create','contact_edit','consent_read','consent_opt_in','contact_suppress','contact_automation_block','sms_message_preview','sms_message_send']::text[]);
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
  if not perms <@ array['email_automation_read','email_automation_edit','email_automation_publish','email_automation_connect','email_automation_settings','email_automation_consent','email_automation_start','email_automation_control','ai_reply_preview','ai_reply_read','ai_reply_content_read','operations_read','provider_read','provider_refresh','provider_reconcile','operations_retry','sending_activate','website_read','website_deployment_read','website_details_edit','website_form_read','website_form_connect','website_form_disable','website_request_read','website_request_edit','website_publish','website_unpublish','voice_config_read','voice_create','voice_edit','voice_publish','voice_rollback','voice_call_read','voice_transcript_read','voice_media_read','email_form_enable','email_read','email_preview','email_config_edit','email_enable','email_resolve','email_retry','email_content_read','knowledge_read','knowledge_upload','knowledge_create','knowledge_refresh','knowledge_archive','knowledge_approve','ai_config_read','ai_config_edit','ai_activate','booking_read','booking_intake_read','booking_schedule_read','booking_schedule_edit','booking_schedule_enable','booking_preview','booking_intake_edit','booking_cancel','form_duplicate','form_archive','form_restore','automation_archive','automation_preset_read','automation_preset_save','conversation_ai_pause','conversation_ai_resume','conversation_message_reassign','handoff_alert_retry','activity_report_read','activity_tag_manage','activity_attribution_update','read','draft','review','service_add','visibility','global_customer_lookup','automation_read','automation_draft','automation_preview','automation_publish','automation_enable','automation_run_start','automation_run_resume','automation_run_pause_stop','automation_activity','form_read','form_create','form_edit','form_preview','form_publish','form_activate','enquiry_read','enquiry_status_read','lead_read','lead_status_update','lead_assign','handoff_read','handoff_status_update','handoff_assign','conversation_read','conversation_messages_read','conversation_reply','conversation_mark_read','contact_read','contact_create','contact_edit','consent_read','consent_opt_in','contact_suppress','contact_automation_block','sms_message_preview','sms_message_send']::text[] or cardinality(businesses)>500
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
 t text:=p->>'businessId'; target text:=coalesce(p->>'operationId',p->>'groupId',p->>'enrollmentId',p->>'jobId',p->>'sourceId',p->>'uploadId',p->>'tagId',p->>'eventId',p->>'contactId',p->>'conversationId',p->>'leadId',p->>'handoffId',p->>'submissionId',p->>'runId',p->>'automationId',p->>'formId',p->>'businessId',p->>'accountId');
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
   required_permission:=case tool when 'crm_get_email_automation_workspace' then 'email_automation_read' when 'crm_preview_email_template' then 'email_automation_read' when 'crm_create_email_template' then 'email_automation_edit' when 'crm_save_email_template' then 'email_automation_edit' when 'crm_publish_email_template' then 'email_automation_publish' when 'crm_archive_email_template' then 'email_automation_edit' when 'crm_duplicate_email_template' then 'email_automation_edit' when 'crm_set_email_automation_settings' then 'email_automation_settings' when 'crm_connect_email_template' then 'email_automation_connect' when 'crm_set_email_template_form_consent' then 'email_automation_connect' when 'crm_record_email_marketing_consent' then 'email_automation_consent' when 'crm_start_email_template_run' then 'email_automation_start' when 'crm_pause_email_template_run' then 'email_automation_control' when 'crm_resume_email_template_run' then 'email_automation_control' when 'crm_stop_email_template_run' then 'email_automation_control' when 'crm_retry_email_template_run' then 'email_automation_control'  when 'crm_preview_ai_reply' then 'ai_reply_preview' when 'crm_list_ai_reply_runs' then 'ai_reply_read' when 'crm_get_ai_reply_run' then 'ai_reply_read' when 'crm_get_operations_summary' then 'operations_read' when 'crm_list_operational_jobs' then 'operations_read' when 'crm_get_operational_job' then 'operations_read' when 'crm_list_provider_operations' then 'operations_read' when 'crm_get_provider_operation' then 'operations_read' when 'crm_get_provider_readiness' then 'provider_read' when 'crm_get_provider_inventory' then 'provider_read' when 'crm_refresh_provider_status' then 'provider_refresh' when 'crm_reconcile_provider_status' then 'provider_reconcile' when 'crm_retry_operational_job' then 'operations_retry' when 'crm_activate_sms_sending' then 'sending_activate' when 'crm_list_websites' then 'website_read' when 'crm_get_website' then 'website_read' when 'crm_get_website_publication' then 'website_read' when 'crm_list_website_deployments' then 'website_deployment_read' when 'crm_get_website_deployment' then 'website_deployment_read' when 'crm_update_website_details' then 'website_details_edit' when 'crm_list_website_form_connections' then 'website_form_read' when 'crm_connect_website_form' then 'website_form_connect' when 'crm_disable_website_form_connection' then 'website_form_disable' when 'crm_list_website_requests' then 'website_request_read' when 'crm_get_website_request' then 'website_request_read' when 'crm_update_website_request' then 'website_request_edit' when 'crm_publish_website' then 'website_publish' when 'crm_unpublish_website' then 'website_unpublish' when 'crm_get_website_operation' then 'website_read' when 'crm_list_voice_agents' then 'voice_config_read' when 'crm_get_voice_agent' then 'voice_config_read' when 'crm_list_voice_versions' then 'voice_config_read' when 'crm_get_voice_version' then 'voice_config_read' when 'crm_create_voice_agent' then 'voice_create' when 'crm_save_voice_draft' then 'voice_edit' when 'crm_publish_voice_draft' then 'voice_publish' when 'crm_rollback_voice_configuration' then 'voice_rollback' when 'crm_list_voice_calls' then 'voice_call_read' when 'crm_get_voice_call' then 'voice_call_read' when 'crm_get_voice_transcript' then 'voice_transcript_read' when 'crm_get_voice_recording' then 'voice_media_read' when 'crm_set_form_email_enabled' then 'email_form_enable' when 'crm_list_email_groups' then 'email_read' when 'crm_get_email_group' then 'email_read' when 'crm_list_email_enrollments' then 'email_read' when 'crm_get_email_enrollment' then 'email_read' when 'crm_list_email_jobs' then 'email_read' when 'crm_get_email_job' then 'email_read' when 'crm_preview_email_schedule' then 'email_preview' when 'crm_save_email_group' then 'email_config_edit' when 'crm_set_email_group_enabled' then 'email_enable' when 'crm_resolve_email_enrollment' then 'email_resolve' when 'crm_retry_email_job' then 'email_retry' when 'crm_list_knowledge_sources' then 'knowledge_read' when 'crm_get_knowledge_source' then 'knowledge_read' when 'crm_list_knowledge_versions' then 'knowledge_read' when 'crm_get_knowledge_version' then 'knowledge_read' when 'crm_prepare_knowledge_upload' then 'knowledge_upload' when 'crm_create_knowledge_source' then 'knowledge_create' when 'crm_refresh_knowledge_source' then 'knowledge_refresh' when 'crm_archive_knowledge_source' then 'knowledge_archive' when 'crm_approve_knowledge_version' then 'knowledge_approve' when 'crm_get_ai_configuration' then 'ai_config_read' when 'crm_save_ai_configuration' then 'ai_config_edit' when 'crm_set_ai_mode' then 'ai_activate' when 'crm_list_bookings' then 'booking_read' when 'crm_get_booking' then 'booking_read' when 'crm_list_booking_intakes' then 'booking_intake_read' when 'crm_get_booking_intake' then 'booking_intake_read' when 'crm_list_booking_schedules' then 'booking_schedule_read' when 'crm_get_booking_schedule' then 'booking_schedule_read' when 'crm_create_booking_schedule' then 'booking_schedule_edit' when 'crm_update_booking_schedule' then 'booking_schedule_edit' when 'crm_set_booking_schedule_enabled' then 'booking_schedule_enable' when 'crm_preview_booking_availability' then 'booking_preview' when 'crm_update_booking_intake' then 'booking_intake_edit' when 'crm_cancel_booking' then 'booking_cancel' when 'crm_duplicate_form' then 'form_duplicate' when 'crm_archive_form' then 'form_archive' when 'crm_restore_form' then 'form_restore' when 'crm_archive_sms_template' then 'automation_archive' when 'crm_list_sms_presets' then 'automation_preset_read' when 'crm_get_sms_preset' then 'automation_preset_read' when 'crm_save_sms_preset' then 'automation_preset_save' when 'crm_pause_conversation_ai' then 'conversation_ai_pause' when 'crm_resume_conversation_ai' then 'conversation_ai_resume' when 'crm_reassign_conversation_message' then 'conversation_message_reassign' when 'crm_retry_handoff_alert' then 'handoff_alert_retry' when 'crm_get_activity_report' then 'activity_report_read' when 'crm_list_activity_tags' then 'activity_report_read' when 'crm_get_enquiry_attribution_context' then 'activity_report_read' when 'crm_create_activity_tag' then 'activity_tag_manage' when 'crm_update_activity_tag' then 'activity_tag_manage' when 'crm_set_enquiry_tag' then 'activity_tag_manage' when 'crm_link_enquiry_booking' then 'activity_attribution_update' when 'crm_link_enquiry_response' then 'activity_attribution_update' when 'crm_link_enquiry_activity' then 'activity_attribution_update' when 'crm_list_contacts' then 'contact_read' when 'crm_get_contact' then 'contact_read' when 'crm_get_contact_consent' then 'consent_read' when 'crm_create_contact' then 'contact_create' when 'crm_update_contact' then 'contact_edit' when 'crm_record_contact_sms_opt_in' then 'consent_opt_in' when 'crm_suppress_contact_sms' then 'contact_suppress' when 'crm_set_contact_automation_blocked' then 'contact_automation_block' when 'crm_preview_contact_sms' then 'sms_message_preview' when 'crm_send_contact_sms' then 'sms_message_send' when 'crm_reply_to_conversation' then 'conversation_reply' when 'crm_preview_conversation_reply' then 'conversation_reply' when 'crm_mark_conversation_messages_read' then 'conversation_mark_read' when 'crm_list_conversations' then 'conversation_read' when 'crm_get_conversation' then 'conversation_read' when 'crm_assign_lead' then 'lead_assign' when 'crm_set_lead_status' then 'lead_status_update' when 'crm_assign_handoff' then 'handoff_assign' when 'crm_set_handoff_status' then 'handoff_status_update' when 'crm_list_leads' then 'lead_read' when 'crm_get_lead' then 'lead_read' when 'crm_list_handoffs' then 'handoff_read' when 'crm_get_handoff' then 'handoff_read' when 'crm_get_enquiry_status' then 'enquiry_status_read' when 'crm_list_enquiries' then 'enquiry_read' when 'crm_get_enquiry' then 'enquiry_read' when 'crm_set_form_collection_enabled' then 'form_activate' when 'crm_apply_form_draft' then 'form_publish' when 'crm_preview_form' then 'form_preview' when 'crm_create_form' then 'form_create' when 'crm_save_form_draft' then 'form_edit' when 'crm_list_forms' then 'form_read' when 'crm_get_form' then 'form_read' when 'crm_search_customers' then 'read' when 'crm_get_customer' then 'read'
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
   if tool in ('crm_get_email_automation_workspace','crm_preview_email_template','crm_create_email_template','crm_save_email_template','crm_publish_email_template','crm_archive_email_template','crm_duplicate_email_template','crm_set_email_automation_settings','crm_connect_email_template','crm_set_email_template_form_consent','crm_record_email_marketing_consent','crm_start_email_template_run','crm_pause_email_template_run','crm_resume_email_template_run','crm_stop_email_template_run','crm_retry_email_template_run','crm_preview_ai_reply','crm_list_ai_reply_runs','crm_get_ai_reply_run','crm_get_operations_summary','crm_list_operational_jobs','crm_get_operational_job','crm_list_provider_operations','crm_get_provider_operation','crm_get_provider_readiness','crm_get_provider_inventory','crm_refresh_provider_status','crm_reconcile_provider_status','crm_retry_operational_job','crm_activate_sms_sending','crm_list_websites','crm_get_website','crm_get_website_publication','crm_list_website_deployments','crm_get_website_deployment','crm_update_website_details','crm_list_website_form_connections','crm_connect_website_form','crm_disable_website_form_connection','crm_list_website_requests','crm_get_website_request','crm_update_website_request','crm_publish_website','crm_unpublish_website','crm_get_website_operation','crm_list_voice_agents','crm_get_voice_agent','crm_list_voice_versions','crm_get_voice_version','crm_create_voice_agent','crm_save_voice_draft','crm_publish_voice_draft','crm_rollback_voice_configuration','crm_list_voice_calls','crm_get_voice_call','crm_get_voice_transcript','crm_get_voice_recording','crm_set_form_email_enabled','crm_list_email_groups','crm_get_email_group','crm_list_email_enrollments','crm_get_email_enrollment','crm_list_email_jobs','crm_get_email_job','crm_preview_email_schedule','crm_save_email_group','crm_set_email_group_enabled','crm_resolve_email_enrollment','crm_retry_email_job','crm_list_knowledge_sources','crm_get_knowledge_source','crm_list_knowledge_versions','crm_get_knowledge_version','crm_prepare_knowledge_upload','crm_create_knowledge_source','crm_refresh_knowledge_source','crm_archive_knowledge_source','crm_approve_knowledge_version','crm_get_ai_configuration','crm_save_ai_configuration','crm_set_ai_mode','crm_list_bookings','crm_get_booking','crm_list_booking_intakes','crm_get_booking_intake','crm_list_booking_schedules','crm_get_booking_schedule','crm_create_booking_schedule','crm_update_booking_schedule','crm_set_booking_schedule_enabled','crm_preview_booking_availability','crm_update_booking_intake','crm_cancel_booking','crm_duplicate_form','crm_archive_form','crm_restore_form','crm_archive_sms_template','crm_list_sms_presets','crm_get_sms_preset','crm_save_sms_preset','crm_pause_conversation_ai','crm_resume_conversation_ai','crm_reassign_conversation_message','crm_retry_handoff_alert','crm_get_activity_report','crm_list_activity_tags','crm_get_enquiry_attribution_context','crm_create_activity_tag','crm_update_activity_tag','crm_set_enquiry_tag','crm_link_enquiry_booking','crm_link_enquiry_response','crm_link_enquiry_activity','crm_list_contacts','crm_get_contact','crm_get_contact_consent','crm_create_contact','crm_update_contact','crm_record_contact_sms_opt_in','crm_suppress_contact_sms','crm_set_contact_automation_blocked','crm_preview_contact_sms','crm_send_contact_sms','crm_reply_to_conversation','crm_preview_conversation_reply','crm_mark_conversation_messages_read','crm_list_conversations','crm_get_conversation','crm_assign_lead','crm_set_lead_status','crm_assign_handoff','crm_set_handoff_status','crm_list_leads','crm_get_lead','crm_list_handoffs','crm_get_handoff','crm_get_enquiry_status','crm_list_enquiries','crm_get_enquiry','crm_set_form_collection_enabled','crm_apply_form_draft','crm_preview_form','crm_create_form','crm_save_form_draft','crm_list_forms','crm_get_form','crm_list_sms_runs','crm_get_sms_run','crm_get_sms_run_activity','crm_resume_sms_run','crm_pause_sms_run','crm_stop_sms_run','crm_get_sms_run_start_context','crm_start_sms_automation_run','crm_publish_sms_automation','crm_set_form_followups_enabled','crm_create_sms_automation','crm_save_sms_automation_draft','crm_preview_sms_automation','crm_list_sms_automations','crm_get_sms_automation','crm_search_sms_contacts','crm_list_form_submissions','crm_get_business','crm_save_business_profile_draft','crm_review_business_profile','crm_add_business_service','crm_set_service_visibility')
    and (t is null or (not c.all_businesses and not t=any(c.business_ids)) or not exists(select from public.sms_businesses where tenant_id=t)) then raise exception 'Business access denied' using errcode='42501'; end if;
   if tool='crm_start_sms_automation_run' and p->>'overlapChoice'='stop_selected' and not 'automation_run_pause_stop'=any(c.permissions) then raise exception 'Stopping overlapping runs is not granted' using errcode='42501'; end if;
   if tool='crm_get_conversation' and p->'includeMessages'='true'::jsonb and not 'conversation_messages_read'=any(c.permissions) then raise exception 'Message content is not granted' using errcode='42501'; end if;
   if tool in ('crm_get_email_automation_workspace','crm_preview_email_template') then
    data:=sms_private.mcp_email_template_action(u,t,tool,p,c.id);
   elsif tool in ('crm_preview_ai_reply') then
    data:=sms_private.mcp_ai_preview_context(u,t,tool,p,c.id);
   elsif tool in ('crm_list_ai_reply_runs','crm_get_ai_reply_run') then
    data:=sms_private.mcp_ai_reply_read(u,t,tool,p,c.id);
   elsif tool in ('crm_get_operations_summary','crm_list_operational_jobs','crm_get_operational_job','crm_list_provider_operations','crm_get_provider_operation','crm_get_provider_readiness','crm_get_provider_inventory') then
    data:=sms_private.mcp_operations_action(u,t,tool,p,c.id,request_id);
   elsif tool in ('crm_list_websites','crm_get_website','crm_get_website_publication','crm_list_website_deployments','crm_get_website_deployment','crm_list_website_form_connections','crm_list_website_requests','crm_get_website_request','crm_get_website_operation') then
    data:=sms_private.mcp_website_action(u,t,tool,p,c.id,request_id);
   elsif tool in ('crm_list_voice_agents','crm_get_voice_agent','crm_list_voice_versions','crm_get_voice_version','crm_list_voice_calls','crm_get_voice_call','crm_get_voice_transcript','crm_get_voice_recording') then
    data:=sms_private.mcp_voice_action(u,t,tool,p,c.id);
   elsif tool in ('crm_list_email_groups','crm_get_email_group','crm_list_email_enrollments','crm_get_email_enrollment','crm_list_email_jobs','crm_get_email_job','crm_preview_email_schedule') then
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
     if tool in ('crm_create_email_template','crm_save_email_template','crm_publish_email_template','crm_archive_email_template','crm_duplicate_email_template','crm_set_email_automation_settings','crm_connect_email_template','crm_set_email_template_form_consent','crm_record_email_marketing_consent','crm_start_email_template_run','crm_pause_email_template_run','crm_resume_email_template_run','crm_stop_email_template_run','crm_retry_email_template_run') then
      data:=sms_private.mcp_email_template_action(u,t,tool,p,c.id);
     elsif tool in ('crm_refresh_provider_status','crm_reconcile_provider_status','crm_retry_operational_job','crm_activate_sms_sending') then
      data:=sms_private.mcp_operations_action(u,t,tool,p,c.id,request_id);
     elsif tool in ('crm_update_website_details','crm_connect_website_form','crm_disable_website_form_connection','crm_update_website_request','crm_publish_website','crm_unpublish_website') then
      data:=sms_private.mcp_website_action(u,t,tool,p,c.id,request_id);
     elsif tool in ('crm_create_voice_agent','crm_save_voice_draft','crm_publish_voice_draft','crm_rollback_voice_configuration') then
      data:=sms_private.mcp_voice_action(u,t,tool,p,c.id);
     elsif tool in ('crm_set_form_email_enabled','crm_save_email_group','crm_set_email_group_enabled','crm_resolve_email_enrollment','crm_retry_email_job') then
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
  values(c.id,aid,left(tool,100),left(case when tool in ('crm_refresh_provider_status','crm_reconcile_provider_status','crm_retry_operational_job','crm_activate_sms_sending') then t else coalesce(data->>'websiteRequestId',data->>'siteId',data->>'agentId',data->>'callId',data->'agent'->>'id',data->'call'->>'id',data->>'bookingId',data->>'intakeId',data->>'scheduleId',data->>'formId',data->>'presetId',data->>'automationId',data->>'tagId',data->>'runId',data->>'handoffId',data->>'conversationId',data->>'contactId',data->'contact'->>'id',data->'conversation'->>'id',data->'lead'->>'id',data->'handoff'->>'id',data->'enquiry'->>'id',data->'form'->>'id',data->'run'->>'id',data->'automation'->>'id',target) end,255),request_id,case when error_code is not null then 'denied' when replay then 'replayed' else 'success' end,error_code,
   case when error_code is null then coalesce((data->>'revision')::bigint,(data->'contact'->>'revision')::bigint,(data->'conversation'->>'revision')::bigint,(data->'lead'->>'revision')::bigint,(data->'handoff'->>'revision')::bigint,(data->'enquiryStatus'->'sms'->>'generation')::bigint,(data->'enquiryStatus'->>'submittedFormVersion')::bigint,(data->'enquiry'->>'submittedFormVersion')::bigint,(data->'form'->>'revision')::bigint,(data->'run'->>'generation')::bigint,(data->'source'->>'revision')::bigint,(data->'automation'->>'revision')::bigint,(data->'record'->>'revision')::bigint,(data->'business'->'setup'->>'revision')::bigint) end,
   case when error_code is null then coalesce(nullif(data->>'draftRevision','0'),data->'form'->>'draftRevision')::bigint end,
   case when error_code is null and tool in ('crm_refresh_provider_status','crm_reconcile_provider_status','crm_retry_operational_job','crm_activate_sms_sending','crm_update_website_details','crm_connect_website_form','crm_disable_website_form_connection','crm_update_website_request','crm_publish_website','crm_unpublish_website','crm_create_voice_agent','crm_save_voice_draft','crm_publish_voice_draft','crm_rollback_voice_configuration','crm_set_form_email_enabled','crm_save_email_group','crm_set_email_group_enabled','crm_resolve_email_enrollment','crm_retry_email_job','crm_prepare_knowledge_upload','crm_create_knowledge_source','crm_refresh_knowledge_source','crm_archive_knowledge_source','crm_approve_knowledge_version','crm_save_ai_configuration','crm_set_ai_mode','crm_create_booking_schedule','crm_update_booking_schedule','crm_set_booking_schedule_enabled','crm_update_booking_intake','crm_cancel_booking','crm_duplicate_form','crm_archive_form','crm_restore_form','crm_archive_sms_template','crm_save_sms_preset','crm_pause_conversation_ai','crm_resume_conversation_ai','crm_reassign_conversation_message','crm_retry_handoff_alert','crm_create_activity_tag','crm_update_activity_tag','crm_set_enquiry_tag','crm_link_enquiry_booking','crm_link_enquiry_response','crm_link_enquiry_activity','crm_create_contact','crm_update_contact','crm_record_contact_sms_opt_in','crm_suppress_contact_sms','crm_set_contact_automation_blocked','crm_send_contact_sms','crm_reply_to_conversation','crm_mark_conversation_messages_read','crm_assign_lead','crm_set_lead_status','crm_assign_handoff','crm_set_handoff_status') then (data->>'previousRevision')::bigint end,
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
