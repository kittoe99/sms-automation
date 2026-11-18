-- CRM-owned: MCP tools for email campaigns and saved segments. Requires CRM
-- 20261118200000_email_campaigns and the MCP gateway from 20261102181913. New
-- grants are opt-in; existing connections gain nothing. The existing gateway and
-- grant editor are wrapped (renamed), not rewritten, so later changes to them are kept.
do $$ begin
 if to_regprocedure('sms_private.email_campaign_apply(text,text,text,jsonb)') is null then raise exception 'Apply CRM email_campaigns first'; end if;
end $$;

-- Extend the permission constraint from its current definition.
do $$ declare def text; begin
 select pg_get_constraintdef(oid) into def from pg_constraint where conname='mcp_connections_permissions_check' and conrelid='sms_private.mcp_connections'::regclass;
 if def is null or position('ARRAY[' in def)=0 then raise exception 'Unexpected MCP permission constraint'; end if;
 if position('email_campaign_read' in def)>0 then return; end if;
 execute 'alter table sms_private.mcp_connections drop constraint mcp_connections_permissions_check';
 execute 'alter table sms_private.mcp_connections add constraint mcp_connections_permissions_check '
  ||replace(def,'ARRAY[','ARRAY[''email_campaign_read''::text, ''email_campaign_edit''::text, ''email_campaign_send''::text, ''email_campaign_control''::text, ');
end $$;

create function sms_private.mcp_email_campaign_action(u text,t text,tool text,p jsonb,cid uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare action text; allowed text[]; required text[]; k text; input jsonb; result jsonb; begin
 action:=case tool
  when 'crm_get_email_campaign_workspace' then 'read' when 'crm_get_email_campaign' then 'read'
  when 'crm_preview_email_segment' then 'segment_preview' when 'crm_preview_email_campaign' then 'campaign_preview'
  when 'crm_save_email_segment' then 'segment_save' when 'crm_archive_email_segment' then 'segment_archive'
  when 'crm_save_email_campaign' then 'campaign_save' when 'crm_start_email_campaign' then 'campaign_start'
  when 'crm_pause_email_campaign' then 'campaign_pause' when 'crm_resume_email_campaign' then 'campaign_resume'
  when 'crm_cancel_email_campaign' then 'campaign_cancel' end;
 allowed:=case tool
  when 'crm_get_email_campaign_workspace' then array['businessId']
  when 'crm_get_email_campaign' then array['businessId','campaignId','page']
  when 'crm_preview_email_segment' then array['businessId','segmentId','definition']
  when 'crm_preview_email_campaign' then array['businessId','id']
  when 'crm_save_email_segment' then array['businessId','idempotencyKey','id','revision','name','definition']
  when 'crm_save_email_campaign' then array['businessId','idempotencyKey','id','revision','name','templateId','segmentId','scheduledAt']
  else array['businessId','idempotencyKey','id','revision'] end;
 required:=case tool
  when 'crm_get_email_campaign_workspace' then array['businessId']
  when 'crm_get_email_campaign' then array['businessId','campaignId']
  when 'crm_preview_email_segment' then array['businessId']
  when 'crm_preview_email_campaign' then array['businessId','id']
  when 'crm_save_email_segment' then array['businessId','idempotencyKey','name','definition']
  when 'crm_save_email_campaign' then array['businessId','idempotencyKey','name']
  else array['businessId','idempotencyKey','id','revision'] end;
 if action is null or jsonb_typeof(p) is distinct from 'object' or length(p::text)>50000 or exists(select from jsonb_object_keys(p) x where not x=any(allowed)) then raise exception 'Invalid email campaign input' using errcode='22023'; end if;
 foreach k in array required loop
  if not p ? k then raise exception 'Missing email campaign field: %',k using errcode='22023'; end if;
 end loop;
 if tool='crm_preview_email_segment' and (p ? 'segmentId')=(p ? 'definition') then raise exception 'Provide either segmentId or definition' using errcode='22023'; end if;
 if tool in ('crm_save_email_segment','crm_save_email_campaign') and (p ? 'id')<>(p ? 'revision') then raise exception 'id and revision must be provided together' using errcode='22023'; end if;
 foreach k in array allowed loop
  if not p ? k then continue; end if;
  if k in ('revision','page') then
   if jsonb_typeof(p->k)<>'number' or (p->>k)::numeric<>trunc((p->>k)::numeric) or (p->>k)::numeric<1 or (p->>k)::numeric>(case when k='page' then 10000 else 2147483647 end) then raise exception 'Invalid revision or page' using errcode='22023'; end if;
  elsif k='definition' then perform sms_private.email_segment_validate(p->k);
  elsif k in ('id','campaignId','segmentId','templateId','idempotencyKey') then
   if p->k='null'::jsonb and k in ('templateId','segmentId') then continue; end if;
   if jsonb_typeof(p->k)<>'string' then raise exception 'Invalid identifier' using errcode='22023'; end if;
   perform (p->>k)::uuid;
  elsif k='scheduledAt' then
   if p->k='null'::jsonb then continue; end if;
   if jsonb_typeof(p->k)<>'string' then raise exception 'Invalid schedule time' using errcode='22023'; end if;
   perform (p->>k)::timestamptz;
  elsif jsonb_typeof(p->k)<>'string' then raise exception 'Invalid text' using errcode='22023';
  end if;
 end loop;
 input:=p-'businessId';
 result:=sms_private.email_campaign_apply(t,'mcp:'||cid::text,action,input);
 if tool='crm_get_email_campaign_workspace' then
  if jsonb_typeof(result->'sender')='object' then result:=jsonb_set(result,'{sender}',(result->'sender')-'providerId'); end if;
  return result;
 elsif action in ('read','segment_preview') then return result;
 elsif action='campaign_preview' then return result-'sender';
 end if;
 -- Receipts carry identifiers, revisions and aggregate counts only: never recipient
 -- addresses, names or segment content.
 return jsonb_build_object('businessId',t,'databaseStatus','committed','id',result->'id','revision',result->'revision',
  'status',case when action like 'segment%' then case when (result->>'archived')::boolean then 'archived' else 'active' end else result->>'status' end,
  'counts',case when result ? 'counts' then result->'counts' end);
end $$;
revoke all on function sms_private.mcp_email_campaign_action(text,text,text,jsonb,uuid) from public,anon,authenticated,service_role,sms_api,crm_mcp;

-- Gateway: campaign tools are authorized, scoped, replayed and audited here; every
-- other tool is delegated unchanged to the existing gateway.
alter function sms_private.mcp_invoke(text,text,text,jsonb,uuid) rename to mcp_invoke_before_campaigns;
revoke all on function sms_private.mcp_invoke_before_campaigns(text,text,text,jsonb,uuid) from public,anon,authenticated,service_role,sms_api,crm_mcp;
create or replace function sms_private.mcp_invoke(u text,client text,tool text,p jsonb,request_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare aid uuid; c sms_private.mcp_connections; required_permission text; t text:=p->>'businessId'; data jsonb; result jsonb;
 key text:=p->>'idempotencyKey'; fingerprint text; prior sms_private.mcp_requests; replay boolean:=false;
 state text; error_code text; error_message text;
begin
 required_permission:=case tool
  when 'crm_get_email_campaign_workspace' then 'email_campaign_read'
  when 'crm_get_email_campaign' then 'email_campaign_read'
  when 'crm_preview_email_segment' then 'email_campaign_read'
  when 'crm_preview_email_campaign' then 'email_campaign_read'
  when 'crm_save_email_segment' then 'email_campaign_edit'
  when 'crm_archive_email_segment' then 'email_campaign_edit'
  when 'crm_save_email_campaign' then 'email_campaign_edit'
  when 'crm_start_email_campaign' then 'email_campaign_send'
  when 'crm_resume_email_campaign' then 'email_campaign_send'
  when 'crm_pause_email_campaign' then 'email_campaign_control'
  when 'crm_cancel_email_campaign' then 'email_campaign_control' end;
 if required_permission is null then return sms_private.mcp_invoke_before_campaigns(u,client,tool,p,request_id); end if;
 perform pg_advisory_xact_lock(hashtextextended('platform:privileges',0));
 begin
  aid:=sms_private.platform_actor(u);
  if aid is null or not sms_private.platform_staff(aid) then raise exception 'Active CRM staff required' using errcode='42501'; end if;
  select * into c from sms_private.mcp_connections where issuer=sms_private.login_issuer() and subject=u and client_id=client for update;
  if c.id is null or c.account_id is distinct from aid or c.status<>'active' then raise exception 'Connection is not active' using errcode='42501'; end if;
  update sms_private.mcp_connections set last_used_at=now() where id=c.id;
  if not required_permission=any(c.permissions) then raise exception 'Action is not granted' using errcode='42501'; end if;
  if t is null or (not c.all_businesses and not t=any(c.business_ids)) or not exists(select from public.sms_businesses where tenant_id=t) then raise exception 'Business access denied' using errcode='42501'; end if;
  if tool in ('crm_get_email_campaign_workspace','crm_get_email_campaign','crm_preview_email_segment','crm_preview_email_campaign') then
   data:=sms_private.mcp_email_campaign_action(u,t,tool,p,c.id);
  else
   if jsonb_typeof(p->'idempotencyKey') is distinct from 'string' or key is null or length(key) not between 8 and 128 then raise exception 'An idempotency key of 8 to 128 characters is required' using errcode='22023'; end if;
   fingerprint:=encode(sha256(convert_to((p-'idempotencyKey')::text,'UTF8')),'hex');
   select * into prior from sms_private.mcp_requests where connection_id=c.id and idempotency_key=key;
   if found then
    if prior.tool<>tool or prior.fingerprint<>fingerprint then raise exception 'Idempotency key was used for a different request' using errcode='40001'; end if;
    data:=prior.result;replay:=true;
   else
    data:=sms_private.mcp_email_campaign_action(u,t,tool,p,c.id);
    insert into sms_private.mcp_requests(connection_id,idempotency_key,tool,fingerprint,result) values(c.id,key,tool,fingerprint,data);
   end if;
  end if;
  result:=jsonb_build_object('ok',true,'data',data);
 exception when others then
  get stacked diagnostics state=returned_sqlstate,error_message=message_text;
  error_code:=case when state='42501' then 'PERMISSION_DENIED' when state in ('23505','40001') then 'CONFLICT' when left(state,2)='22' or state in ('P0001','23514','23502','P0002') then 'VALIDATION_ERROR' else 'TEMPORARY_FAILURE' end;
  if error_code='TEMPORARY_FAILURE' then error_message:='Service temporarily unavailable. Retry with the same idempotency key.'; end if;
  result:=jsonb_build_object('ok',false,'error',jsonb_build_object('code',error_code,'message',error_message,'retryable',error_code='TEMPORARY_FAILURE'));
 end;
 insert into sms_private.mcp_activity(connection_id,actor_id,tool,target,request_id,outcome,code,revision)
  values(c.id,aid,left(tool,100),left(coalesce(data->>'id',p->>'id',p->>'campaignId',p->>'segmentId',t),255),request_id,
   case when error_code is not null then 'denied' when replay then 'replayed' else 'success' end,error_code,
   case when error_code is null then (data->>'revision')::bigint end);
 return result;
end $$;
revoke all on function sms_private.mcp_invoke(text,text,text,jsonb,uuid) from public,anon,authenticated,service_role,sms_api,crm_mcp;

-- Grant editor: campaign grants are validated here, the rest by the existing editor.
alter function sms_private.mcp_admin(text,text,jsonb) rename to mcp_admin_before_campaigns;
revoke all on function sms_private.mcp_admin_before_campaigns(text,text,jsonb) from public,anon,authenticated,service_role,sms_api,crm_mcp;
create function sms_private.mcp_admin(u text,action text,p jsonb default '{}') returns jsonb
language plpgsql security definer set search_path='' as $$
declare campaign text[]:=array['email_campaign_read','email_campaign_edit','email_campaign_send','email_campaign_control'];
 extra text[]; base jsonb; result jsonb; begin
 if action<>'save' or jsonb_typeof(p->'permissions') is distinct from 'array' then return sms_private.mcp_admin_before_campaigns(u,action,p); end if;
 select coalesce(array_agg(distinct x),'{}') into extra from jsonb_array_elements_text(p->'permissions') x where x=any(campaign);
 base:=sms_private.mcp_admin_before_campaigns(u,action,jsonb_set(p,'{permissions}',
  coalesce((select jsonb_agg(x) from jsonb_array_elements_text(p->'permissions') x where not x=any(campaign)),'[]'::jsonb)));
 if cardinality(extra)=0 then return base; end if;
 update sms_private.mcp_connections set permissions=(select coalesce(array_agg(distinct x),'{}') from unnest(permissions||extra) x)
  where id=(base->'connection'->>'id')::uuid returning to_jsonb(mcp_connections.*) into result;
 return jsonb_build_object('connection',result);
end $$;
revoke all on function sms_private.mcp_admin(text,text,jsonb) from public,anon,authenticated,service_role,crm_mcp;
grant execute on function sms_private.mcp_admin(text,text,jsonb) to sms_api;
