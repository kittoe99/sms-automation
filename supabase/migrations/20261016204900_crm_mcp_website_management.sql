-- CRM-owned integration state. E2 hosting adapter contract 20261016204903 must
-- follow this migration before granting website writes or releasing either app.
create table sms_private.mcp_hosting_operations(
 id uuid primary key default gen_random_uuid(),connection_id uuid not null references sms_private.mcp_connections(id),
 tenant_id text not null,site_id uuid not null,kind text not null check(kind in ('publish','unpublish')),
 site_revision bigint not null,deployment_id uuid,deployment_revision bigint,
 state text not null default 'pending' check(state in ('pending','executing','completed','failed','attention')),
 lease_token uuid,lease_generation bigint,request_id uuid not null,
 created_at timestamptz not null default now(),finished_at timestamptz,resulting_revision bigint
);
create index mcp_hosting_operation_scope on sms_private.mcp_hosting_operations(connection_id,tenant_id,site_id,created_at desc,id);
create table sms_private.mcp_hosting_tickets(
 token_hash text primary key,connection_id uuid not null references sms_private.mcp_connections(id),tenant_id text not null,site_id uuid not null,
 operation_id uuid references sms_private.mcp_hosting_operations(id),expires_at timestamptz not null default now()+interval '60 seconds'
);
create index mcp_hosting_ticket_expiry on sms_private.mcp_hosting_tickets(expires_at);
alter table sms_private.mcp_hosting_operations enable row level security;
alter table sms_private.mcp_hosting_tickets enable row level security;
revoke all on sms_private.mcp_hosting_operations,sms_private.mcp_hosting_tickets from public,anon,authenticated,service_role,sms_api,crm_mcp;
create function sms_private.mcp_hosting_access(cid uuid,t text,permission text) returns sms_private.mcp_connections
language plpgsql security definer set search_path='' as $$
declare c sms_private.mcp_connections;
begin
 perform pg_advisory_xact_lock_shared(hashtextextended('platform:privileges',0));
 select * into c from sms_private.mcp_connections where id=cid for share;
 if c.id is null or c.status<>'active' or not permission=any(c.permissions) or not(c.all_businesses or t=any(c.business_ids))
  or not sms_private.platform_staff(c.account_id) or not exists(select from public.platform_account_identities i cross join public.platform_runtime r where i.issuer=c.issuer and i.issuer=r.crm_issuer and i.subject=c.subject and i.account_id=c.account_id and i.deleted_at is null) then raise exception 'Website access denied' using errcode='42501';end if;
 return c;
end $$;
create function crm_mcp.hosting_ticket(u text,client text,t text,site_id uuid,operation_id uuid default null) returns text
language plpgsql security definer set search_path='' as $$
#variable_conflict use_column
declare c sms_private.mcp_connections;o sms_private.mcp_hosting_operations;token text;
begin
 select * into c from sms_private.mcp_connections where issuer=current_setting('platform.actor_issuer',true) and subject=u and client_id=client;
 if operation_id is not null then
  select * into o from sms_private.mcp_hosting_operations x where x.id=operation_id and x.connection_id=c.id and x.tenant_id=t and x.site_id=hosting_ticket.site_id;
  if o.id is null then raise exception 'Operation access denied' using errcode='42501';end if;
 end if;
 c:=sms_private.mcp_hosting_access(c.id,t,case when o.id is null then 'website_read' when o.kind='publish' then 'website_publish' else 'website_unpublish' end);
 if not exists(select from public.hosting_sites x where x.id=hosting_ticket.site_id and x.sms_tenant_id=t) then raise exception 'Website access denied' using errcode='42501';end if;
 token:=gen_random_uuid()::text||gen_random_uuid()::text;
 delete from sms_private.mcp_hosting_tickets where expires_at<=now();
 insert into sms_private.mcp_hosting_tickets(token_hash,connection_id,tenant_id,site_id,operation_id) values(encode(sha256(convert_to(token,'UTF8')),'hex'),c.id,t,hosting_ticket.site_id,o.id);
 return token;
end $$;
revoke all on function crm_mcp.hosting_ticket(text,text,text,uuid,uuid) from public,anon,authenticated,service_role,sms_api;
grant execute on function crm_mcp.hosting_ticket(text,text,text,uuid,uuid) to crm_mcp;
create function sms_private.mcp_website_operation(o sms_private.mcp_hosting_operations) returns jsonb
language plpgsql stable set search_path='' as $$ begin return jsonb_build_object('id',o.id,'state',case when o.state='executing' and exists(select from sms_private.hosting_site_operations h where h.site_id=o.site_id and h.token=o.lease_token and h.generation=o.lease_generation and (h.state='attention' or h.expires_at<=now())) then 'attention' else o.state end,'kind',o.kind,'siteRevision',o.site_revision,'resultingRevision',o.resulting_revision,'deploymentId',o.deployment_id,'createdAt',o.created_at,'finishedAt',o.finished_at);end $$;
create function sms_private.mcp_website_projection(kind text,v jsonb) returns jsonb
language plpgsql stable set search_path='' as $$ begin return case kind
 when 'site' then jsonb_build_object('id',v->'id','revision',v->'revision','name',v->'name','slug',v->'slug','details',public.mcp_hosting_details(v->'details'),'createdAt',v->'created_at','detailsUpdatedAt',v->'details_updated_at')
 when 'deployment' then jsonb_build_object('id',v->'id','revision',v->'revision','mode',v->'mode','status',v->'status','sourceBytes',v->'source_bytes','createdAt',v->'created_at','builtAt',v->'built_at')
 when 'request' then jsonb_build_object('id',v->'id','revision',v->'revision','title',v->'title','category',v->'category','page',v->'page','description',v->'description','status',v->'status','response',v->'response','createdAt',v->'created_at','updatedAt',v->'updated_at') end;end $$;
create function sms_private.mcp_website_action(u text,t text,tool text,p jsonb,cid uuid,rid uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
#variable_conflict use_column
declare s record;d record;f record;r record;con record;o sms_private.mcp_hosting_operations;result jsonb;items jsonb;total bigint;oldrev bigint;site uuid:=(p->>'siteId')::uuid;pg integer:=coalesce((p->>'page')::integer,1);sz integer:=coalesce((p->>'pageSize')::integer,25);
begin
 perform sms_private.mcp_validate_input(tool,p);
 if tool='crm_list_websites' then
  select count(*) into total from public.hosting_sites where sms_tenant_id=t;
  select coalesce(jsonb_agg(sms_private.mcp_website_projection('site',to_jsonb(q)) order by q.created_at desc,q.id),'[]') into items from (select * from public.hosting_sites where sms_tenant_id=t order by created_at desc,id limit sz offset (pg-1)*sz) q;
  return jsonb_build_object('businessId',t,'page',pg,'pageSize',sz,'total',total,'sites',items);
 end if;
 select * into s from public.hosting_sites where sms_tenant_id=t and id=site;
 if not found then raise exception 'Website access denied' using errcode='42501';end if;
 if tool='crm_get_website' then return jsonb_build_object('businessId',t,'siteId',site,'site',sms_private.mcp_website_projection('site',to_jsonb(s)));
 elsif tool='crm_get_website_publication' then return jsonb_build_object('businessId',t,'siteId',site,'status','unavailable','deploymentId',null,'checkedAt',null);
 elsif tool='crm_get_website_operation' then
  select * into o from sms_private.mcp_hosting_operations where connection_id=cid and tenant_id=t and site_id=site and id=(p->>'operationId')::uuid;
  if o.id is null then raise exception 'Operation access denied' using errcode='42501';end if;
  return jsonb_build_object('businessId',t,'siteId',site,'operation',sms_private.mcp_website_operation(o));
 elsif tool='crm_list_website_deployments' then
  select count(*) into total from public.hosting_deployments where site_id=site;
  select coalesce(jsonb_agg(sms_private.mcp_website_projection('deployment',to_jsonb(q)) order by q.created_at desc,q.id),'[]') into items from (select * from public.hosting_deployments where site_id=site order by created_at desc,id limit sz offset (pg-1)*sz) q;
  return jsonb_build_object('businessId',t,'siteId',site,'page',pg,'pageSize',sz,'total',total,'deployments',items);
 elsif tool='crm_get_website_deployment' then
  select * into d from public.hosting_deployments where site_id=site and id=(p->>'deploymentId')::uuid;
  if not found then raise exception 'Deployment access denied' using errcode='42501';end if;
  return jsonb_build_object('businessId',t,'siteId',site,'deployment',sms_private.mcp_website_projection('deployment',to_jsonb(d)));
 elsif tool='crm_list_website_form_connections' then
  select count(*) into total from public.hosting_site_forms x join public.sms_web_form_definitions y on y.tenant_id=x.tenant_id and y.public_id=x.form_public_id where x.site_id=site and x.tenant_id=t;
  select coalesce(jsonb_agg(to_jsonb(q) order by q.id),'[]') into items from (select x.id,x.revision,x.form_public_id "formId",y.version "formRevision",y.title,x.enabled,y.enabled "collectionEnabled" from public.hosting_site_forms x join public.sms_web_form_definitions y on y.tenant_id=x.tenant_id and y.public_id=x.form_public_id where x.site_id=site and x.tenant_id=t order by x.id limit sz offset (pg-1)*sz) q;
  return jsonb_build_object('businessId',t,'siteId',site,'page',pg,'pageSize',sz,'total',total,'connections',items);
 elsif tool='crm_list_website_requests' then
  select count(*) into total from public.hosting_update_requests where site_id=site and tenant_id=t;
  select coalesce(jsonb_agg(sms_private.mcp_website_projection('request',to_jsonb(q)) order by q.created_at desc,q.id),'[]') into items from (select * from public.hosting_update_requests where site_id=site and tenant_id=t order by created_at desc,id limit sz offset (pg-1)*sz) q;
  return jsonb_build_object('businessId',t,'siteId',site,'page',pg,'pageSize',sz,'total',total,'requests',items);
 elsif tool in ('crm_get_website_request','crm_update_website_request') then
  select * into r from public.hosting_update_requests where site_id=site and tenant_id=t and id=(p->>'websiteRequestId')::uuid;
  if not found then raise exception 'Request access denied' using errcode='42501';end if;
  if tool='crm_get_website_request' then return jsonb_build_object('businessId',t,'siteId',site,'request',sms_private.mcp_website_projection('request',to_jsonb(r)));end if;
  perform public.staff_website_requests(current_setting('platform.actor_issuer',true),u,site,jsonb_build_object('id',r.id,'revision',p->'revision','status',p->'status','response',p->'response'));
  select * into r from public.hosting_update_requests where id=r.id and site_id=site and tenant_id=t;
  return jsonb_build_object('businessId',t,'siteId',site,'websiteRequestId',r.id,'previousRevision',p->'revision','revision',r.revision,'status',r.status,'databaseStatus','committed');
 end if;
 -- Consistent lock order with the E2 hosting executor. Never wait behind unknown R2 work.
 if not pg_try_advisory_xact_lock(hashtextextended('hosting-operation:'||site,0)) then raise exception 'Website busy' using errcode='55P03';end if;
 select * into s from public.hosting_sites where id=site and sms_tenant_id=t for update nowait;
 if not found then raise exception 'Website access denied' using errcode='42501';end if;
 oldrev:=s.revision;
 if oldrev<>(p->>'revision')::bigint then raise exception 'Website changed; reread' using errcode='23505';end if;
 if exists(select from sms_private.hosting_site_operations where site_id=site and state<>'idle') then raise exception 'Hosting operation running or requires reconciliation' using errcode='23505';end if;
 if tool='crm_update_website_details' then
  perform public.mcp_save_hosting_details(current_setting('platform.actor_issuer',true),u,site,oldrev,p->>'name',p->'details');
 elsif tool='crm_connect_website_form' then
  select * into f from public.sms_web_form_definitions where tenant_id=t and public_id=(p->>'formId')::uuid for share nowait;
  if not found then raise exception 'Form access denied' using errcode='42501';end if;
  if f.version<>(p->>'formRevision')::bigint then raise exception 'Form changed; reread' using errcode='23505';end if;
  if not f.enabled or f.archived then raise exception 'Choose an enabled, unarchived form';end if;
  result:=sms_private.platform_action(u,'connection_create',jsonb_build_object('siteId',site,'formId',f.public_id));
  select * into con from public.hosting_site_forms where id=(result->>'id')::uuid and site_id=site and tenant_id=t;
 elsif tool='crm_disable_website_form_connection' then
  select * into con from public.hosting_site_forms where site_id=site and tenant_id=t and id=(p->>'connectionId')::uuid for update nowait;
  if not found then raise exception 'Connection access denied' using errcode='42501';end if;
  if con.revision<>(p->>'connectionRevision')::bigint then raise exception 'Connection changed; reread' using errcode='23505';end if;
  result:=sms_private.platform_action(u,'connection_disable',jsonb_build_object('siteId',site,'connectionId',con.id));
  select * into con from public.hosting_site_forms where id=con.id and site_id=site and tenant_id=t;
 elsif tool in ('crm_publish_website','crm_unpublish_website') then
  if tool='crm_publish_website' then
   select * into d from public.hosting_deployments where site_id=site and id=(p->>'deploymentId')::uuid for share nowait;
   if not found then raise exception 'Deployment access denied' using errcode='42501';end if;
   if d.revision<>(p->>'deploymentRevision')::bigint then raise exception 'Deployment changed; reread' using errcode='23505';end if;
   if d.status<>'ready' or d.manifest is null then raise exception 'Ready built deployment required';end if;
  end if;
  insert into sms_private.mcp_hosting_operations(connection_id,tenant_id,site_id,kind,site_revision,deployment_id,deployment_revision,request_id)
   values(cid,t,site,case when tool='crm_publish_website' then 'publish' else 'unpublish' end,oldrev,(p->>'deploymentId')::uuid,(p->>'deploymentRevision')::bigint,rid) returning * into o;
  return jsonb_build_object('businessId',t,'siteId',site,'previousRevision',oldrev,'revision',oldrev,'databaseStatus','committed','operation',sms_private.mcp_website_operation(o),'providerWork','queued');
 else raise exception 'Unsupported website action';end if;
 select * into s from public.hosting_sites where id=site and sms_tenant_id=t;
 result:=jsonb_build_object('businessId',t,'siteId',site,'previousRevision',oldrev,'revision',s.revision,'databaseStatus','committed');
 if tool='crm_connect_website_form' then result:=result||jsonb_build_object('connectionId',con.id,'connectionRevision',con.revision,'formId',con.form_public_id);
 elsif tool='crm_disable_website_form_connection' then result:=result||jsonb_build_object('connectionId',con.id,'connectionRevision',con.revision,'enabled',false);end if;
 return result;
end $$;
revoke all on function sms_private.mcp_hosting_access(uuid,text,text),sms_private.mcp_website_operation(sms_private.mcp_hosting_operations),sms_private.mcp_website_projection(text,jsonb),sms_private.mcp_website_action(text,text,text,jsonb,uuid,uuid) from public,anon,authenticated,service_role,sms_api,crm_mcp;

-- GENERATED MCP CONTRACTS
insert into sms_private.mcp_input_schemas values('crm_list_websites','{"type":"object","properties":{"businessId":{"type":"string","minLength":1,"maxLength":255},"page":{"type":"integer","minimum":1,"maximum":100000,"default":1},"pageSize":{"type":"integer","minimum":1,"maximum":100,"default":25}},"required":["businessId"],"additionalProperties":false,"$schema":"http://json-schema.org/draft-07/schema#"}'::jsonb);
insert into sms_private.mcp_input_schemas values('crm_get_website','{"type":"object","properties":{"businessId":{"type":"string","minLength":1,"maxLength":255},"siteId":{"type":"string","format":"uuid"}},"required":["businessId","siteId"],"additionalProperties":false,"$schema":"http://json-schema.org/draft-07/schema#"}'::jsonb);
insert into sms_private.mcp_input_schemas values('crm_get_website_publication','{"type":"object","properties":{"businessId":{"type":"string","minLength":1,"maxLength":255},"siteId":{"type":"string","format":"uuid"}},"required":["businessId","siteId"],"additionalProperties":false,"$schema":"http://json-schema.org/draft-07/schema#"}'::jsonb);
insert into sms_private.mcp_input_schemas values('crm_list_website_deployments','{"type":"object","properties":{"businessId":{"type":"string","minLength":1,"maxLength":255},"siteId":{"type":"string","format":"uuid"},"page":{"type":"integer","minimum":1,"maximum":100000,"default":1},"pageSize":{"type":"integer","minimum":1,"maximum":100,"default":25}},"required":["businessId","siteId"],"additionalProperties":false,"$schema":"http://json-schema.org/draft-07/schema#"}'::jsonb);
insert into sms_private.mcp_input_schemas values('crm_get_website_deployment','{"type":"object","properties":{"businessId":{"type":"string","minLength":1,"maxLength":255},"siteId":{"type":"string","format":"uuid"},"deploymentId":{"type":"string","format":"uuid"}},"required":["businessId","siteId","deploymentId"],"additionalProperties":false,"$schema":"http://json-schema.org/draft-07/schema#"}'::jsonb);
insert into sms_private.mcp_input_schemas values('crm_update_website_details','{"type":"object","properties":{"businessId":{"type":"string","minLength":1,"maxLength":255},"siteId":{"type":"string","format":"uuid"},"revision":{"type":"integer","minimum":0,"maximum":9007199254740991},"name":{"type":"string","minLength":1,"maxLength":100},"details":{"type":"object","properties":{"businessName":{"type":"string","maxLength":160},"description":{"type":"string","maxLength":1500},"contactEmail":{"type":"string","maxLength":254},"contactPhone":{"type":"string","maxLength":40},"services":{"type":"array","items":{"type":"string","minLength":1,"maxLength":1500},"maxItems":100},"serviceAreas":{"type":"array","items":{"type":"string","minLength":1,"maxLength":1000},"maxItems":100}},"additionalProperties":false},"idempotencyKey":{"type":"string","minLength":8,"maxLength":128}},"required":["businessId","siteId","revision","name","details","idempotencyKey"],"additionalProperties":false,"$schema":"http://json-schema.org/draft-07/schema#"}'::jsonb);
insert into sms_private.mcp_input_schemas values('crm_list_website_form_connections','{"type":"object","properties":{"businessId":{"type":"string","minLength":1,"maxLength":255},"siteId":{"type":"string","format":"uuid"},"page":{"type":"integer","minimum":1,"maximum":100000,"default":1},"pageSize":{"type":"integer","minimum":1,"maximum":100,"default":25}},"required":["businessId","siteId"],"additionalProperties":false,"$schema":"http://json-schema.org/draft-07/schema#"}'::jsonb);
insert into sms_private.mcp_input_schemas values('crm_connect_website_form','{"type":"object","properties":{"businessId":{"type":"string","minLength":1,"maxLength":255},"siteId":{"type":"string","format":"uuid"},"revision":{"type":"integer","minimum":0,"maximum":9007199254740991},"formId":{"type":"string","format":"uuid"},"formRevision":{"type":"integer","minimum":0,"maximum":9007199254740991},"idempotencyKey":{"type":"string","minLength":8,"maxLength":128}},"required":["businessId","siteId","revision","formId","formRevision","idempotencyKey"],"additionalProperties":false,"$schema":"http://json-schema.org/draft-07/schema#"}'::jsonb);
insert into sms_private.mcp_input_schemas values('crm_disable_website_form_connection','{"type":"object","properties":{"businessId":{"type":"string","minLength":1,"maxLength":255},"siteId":{"type":"string","format":"uuid"},"revision":{"type":"integer","minimum":0,"maximum":9007199254740991},"connectionId":{"type":"string","format":"uuid"},"connectionRevision":{"type":"integer","minimum":0,"maximum":9007199254740991},"idempotencyKey":{"type":"string","minLength":8,"maxLength":128}},"required":["businessId","siteId","revision","connectionId","connectionRevision","idempotencyKey"],"additionalProperties":false,"$schema":"http://json-schema.org/draft-07/schema#"}'::jsonb);
insert into sms_private.mcp_input_schemas values('crm_list_website_requests','{"type":"object","properties":{"businessId":{"type":"string","minLength":1,"maxLength":255},"siteId":{"type":"string","format":"uuid"},"page":{"type":"integer","minimum":1,"maximum":100000,"default":1},"pageSize":{"type":"integer","minimum":1,"maximum":100,"default":25}},"required":["businessId","siteId"],"additionalProperties":false,"$schema":"http://json-schema.org/draft-07/schema#"}'::jsonb);
insert into sms_private.mcp_input_schemas values('crm_get_website_request','{"type":"object","properties":{"businessId":{"type":"string","minLength":1,"maxLength":255},"siteId":{"type":"string","format":"uuid"},"websiteRequestId":{"type":"string","format":"uuid"}},"required":["businessId","siteId","websiteRequestId"],"additionalProperties":false,"$schema":"http://json-schema.org/draft-07/schema#"}'::jsonb);
insert into sms_private.mcp_input_schemas values('crm_update_website_request','{"type":"object","properties":{"businessId":{"type":"string","minLength":1,"maxLength":255},"siteId":{"type":"string","format":"uuid"},"websiteRequestId":{"type":"string","format":"uuid"},"revision":{"type":"integer","minimum":0,"maximum":9007199254740991},"status":{"type":"string","enum":["received","in_progress","needs_info","completed"]},"response":{"type":"string","maxLength":2000},"idempotencyKey":{"type":"string","minLength":8,"maxLength":128}},"required":["businessId","siteId","websiteRequestId","revision","status","response","idempotencyKey"],"additionalProperties":false,"$schema":"http://json-schema.org/draft-07/schema#"}'::jsonb);
insert into sms_private.mcp_input_schemas values('crm_publish_website','{"type":"object","properties":{"businessId":{"type":"string","minLength":1,"maxLength":255},"siteId":{"type":"string","format":"uuid"},"revision":{"type":"integer","minimum":0,"maximum":9007199254740991},"deploymentId":{"type":"string","format":"uuid"},"deploymentRevision":{"type":"integer","minimum":0,"maximum":9007199254740991},"idempotencyKey":{"type":"string","minLength":8,"maxLength":128}},"required":["businessId","siteId","revision","deploymentId","deploymentRevision","idempotencyKey"],"additionalProperties":false,"$schema":"http://json-schema.org/draft-07/schema#"}'::jsonb);
insert into sms_private.mcp_input_schemas values('crm_unpublish_website','{"type":"object","properties":{"businessId":{"type":"string","minLength":1,"maxLength":255},"siteId":{"type":"string","format":"uuid"},"revision":{"type":"integer","minimum":0,"maximum":9007199254740991},"idempotencyKey":{"type":"string","minLength":8,"maxLength":128}},"required":["businessId","siteId","revision","idempotencyKey"],"additionalProperties":false,"$schema":"http://json-schema.org/draft-07/schema#"}'::jsonb);
insert into sms_private.mcp_input_schemas values('crm_get_website_operation','{"type":"object","properties":{"businessId":{"type":"string","minLength":1,"maxLength":255},"siteId":{"type":"string","format":"uuid"},"operationId":{"type":"string","format":"uuid"}},"required":["businessId","siteId","operationId"],"additionalProperties":false,"$schema":"http://json-schema.org/draft-07/schema#"}'::jsonb);
alter table sms_private.mcp_connections drop constraint mcp_connections_permissions_check;
alter table sms_private.mcp_connections add constraint mcp_connections_permissions_check check(permissions <@ array['website_read','website_deployment_read','website_details_edit','website_form_read','website_form_connect','website_form_disable','website_request_read','website_request_edit','website_publish','website_unpublish','voice_config_read','voice_create','voice_edit','voice_publish','voice_rollback','voice_call_read','voice_transcript_read','voice_media_read','email_form_enable','email_read','email_preview','email_config_edit','email_enable','email_resolve','email_retry','email_content_read','knowledge_read','knowledge_upload','knowledge_create','knowledge_refresh','knowledge_archive','knowledge_approve','ai_config_read','ai_config_edit','ai_activate','booking_read','booking_intake_read','booking_schedule_read','booking_schedule_edit','booking_schedule_enable','booking_preview','booking_intake_edit','booking_cancel','form_duplicate','form_archive','form_restore','automation_archive','automation_preset_read','automation_preset_save','conversation_ai_pause','conversation_ai_resume','conversation_message_reassign','handoff_alert_retry','activity_report_read','activity_tag_manage','activity_attribution_update','read','draft','review','service_add','visibility','global_customer_lookup','automation_read','automation_draft','automation_preview','automation_publish','automation_enable','automation_run_start','automation_run_resume','automation_run_pause_stop','automation_activity','form_read','form_create','form_edit','form_preview','form_publish','form_activate','enquiry_read','enquiry_status_read','lead_read','lead_status_update','lead_assign','handoff_read','handoff_status_update','handoff_assign','conversation_read','conversation_messages_read','conversation_reply','conversation_mark_read','contact_read','contact_create','contact_edit','consent_read','consent_opt_in','contact_suppress','contact_automation_block','sms_message_preview','sms_message_send']::text[]);
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
  if not perms <@ array['website_read','website_deployment_read','website_details_edit','website_form_read','website_form_connect','website_form_disable','website_request_read','website_request_edit','website_publish','website_unpublish','voice_config_read','voice_create','voice_edit','voice_publish','voice_rollback','voice_call_read','voice_transcript_read','voice_media_read','email_form_enable','email_read','email_preview','email_config_edit','email_enable','email_resolve','email_retry','email_content_read','knowledge_read','knowledge_upload','knowledge_create','knowledge_refresh','knowledge_archive','knowledge_approve','ai_config_read','ai_config_edit','ai_activate','booking_read','booking_intake_read','booking_schedule_read','booking_schedule_edit','booking_schedule_enable','booking_preview','booking_intake_edit','booking_cancel','form_duplicate','form_archive','form_restore','automation_archive','automation_preset_read','automation_preset_save','conversation_ai_pause','conversation_ai_resume','conversation_message_reassign','handoff_alert_retry','activity_report_read','activity_tag_manage','activity_attribution_update','read','draft','review','service_add','visibility','global_customer_lookup','automation_read','automation_draft','automation_preview','automation_publish','automation_enable','automation_run_start','automation_run_resume','automation_run_pause_stop','automation_activity','form_read','form_create','form_edit','form_preview','form_publish','form_activate','enquiry_read','enquiry_status_read','lead_read','lead_status_update','lead_assign','handoff_read','handoff_status_update','handoff_assign','conversation_read','conversation_messages_read','conversation_reply','conversation_mark_read','contact_read','contact_create','contact_edit','consent_read','consent_opt_in','contact_suppress','contact_automation_block','sms_message_preview','sms_message_send']::text[] or cardinality(businesses)>500
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
   required_permission:=case tool when 'crm_list_websites' then 'website_read' when 'crm_get_website' then 'website_read' when 'crm_get_website_publication' then 'website_read' when 'crm_list_website_deployments' then 'website_deployment_read' when 'crm_get_website_deployment' then 'website_deployment_read' when 'crm_update_website_details' then 'website_details_edit' when 'crm_list_website_form_connections' then 'website_form_read' when 'crm_connect_website_form' then 'website_form_connect' when 'crm_disable_website_form_connection' then 'website_form_disable' when 'crm_list_website_requests' then 'website_request_read' when 'crm_get_website_request' then 'website_request_read' when 'crm_update_website_request' then 'website_request_edit' when 'crm_publish_website' then 'website_publish' when 'crm_unpublish_website' then 'website_unpublish' when 'crm_get_website_operation' then 'website_read' when 'crm_list_voice_agents' then 'voice_config_read' when 'crm_get_voice_agent' then 'voice_config_read' when 'crm_list_voice_versions' then 'voice_config_read' when 'crm_get_voice_version' then 'voice_config_read' when 'crm_create_voice_agent' then 'voice_create' when 'crm_save_voice_draft' then 'voice_edit' when 'crm_publish_voice_draft' then 'voice_publish' when 'crm_rollback_voice_configuration' then 'voice_rollback' when 'crm_list_voice_calls' then 'voice_call_read' when 'crm_get_voice_call' then 'voice_call_read' when 'crm_get_voice_transcript' then 'voice_transcript_read' when 'crm_get_voice_recording' then 'voice_media_read' when 'crm_set_form_email_enabled' then 'email_form_enable' when 'crm_list_email_groups' then 'email_read' when 'crm_get_email_group' then 'email_read' when 'crm_list_email_enrollments' then 'email_read' when 'crm_get_email_enrollment' then 'email_read' when 'crm_list_email_jobs' then 'email_read' when 'crm_get_email_job' then 'email_read' when 'crm_preview_email_schedule' then 'email_preview' when 'crm_save_email_group' then 'email_config_edit' when 'crm_set_email_group_enabled' then 'email_enable' when 'crm_resolve_email_enrollment' then 'email_resolve' when 'crm_retry_email_job' then 'email_retry' when 'crm_list_knowledge_sources' then 'knowledge_read' when 'crm_get_knowledge_source' then 'knowledge_read' when 'crm_list_knowledge_versions' then 'knowledge_read' when 'crm_get_knowledge_version' then 'knowledge_read' when 'crm_prepare_knowledge_upload' then 'knowledge_upload' when 'crm_create_knowledge_source' then 'knowledge_create' when 'crm_refresh_knowledge_source' then 'knowledge_refresh' when 'crm_archive_knowledge_source' then 'knowledge_archive' when 'crm_approve_knowledge_version' then 'knowledge_approve' when 'crm_get_ai_configuration' then 'ai_config_read' when 'crm_save_ai_configuration' then 'ai_config_edit' when 'crm_set_ai_mode' then 'ai_activate' when 'crm_list_bookings' then 'booking_read' when 'crm_get_booking' then 'booking_read' when 'crm_list_booking_intakes' then 'booking_intake_read' when 'crm_get_booking_intake' then 'booking_intake_read' when 'crm_list_booking_schedules' then 'booking_schedule_read' when 'crm_get_booking_schedule' then 'booking_schedule_read' when 'crm_create_booking_schedule' then 'booking_schedule_edit' when 'crm_update_booking_schedule' then 'booking_schedule_edit' when 'crm_set_booking_schedule_enabled' then 'booking_schedule_enable' when 'crm_preview_booking_availability' then 'booking_preview' when 'crm_update_booking_intake' then 'booking_intake_edit' when 'crm_cancel_booking' then 'booking_cancel' when 'crm_duplicate_form' then 'form_duplicate' when 'crm_archive_form' then 'form_archive' when 'crm_restore_form' then 'form_restore' when 'crm_archive_sms_template' then 'automation_archive' when 'crm_list_sms_presets' then 'automation_preset_read' when 'crm_get_sms_preset' then 'automation_preset_read' when 'crm_save_sms_preset' then 'automation_preset_save' when 'crm_pause_conversation_ai' then 'conversation_ai_pause' when 'crm_resume_conversation_ai' then 'conversation_ai_resume' when 'crm_reassign_conversation_message' then 'conversation_message_reassign' when 'crm_retry_handoff_alert' then 'handoff_alert_retry' when 'crm_get_activity_report' then 'activity_report_read' when 'crm_list_activity_tags' then 'activity_report_read' when 'crm_get_enquiry_attribution_context' then 'activity_report_read' when 'crm_create_activity_tag' then 'activity_tag_manage' when 'crm_update_activity_tag' then 'activity_tag_manage' when 'crm_set_enquiry_tag' then 'activity_tag_manage' when 'crm_link_enquiry_booking' then 'activity_attribution_update' when 'crm_link_enquiry_response' then 'activity_attribution_update' when 'crm_link_enquiry_activity' then 'activity_attribution_update' when 'crm_list_contacts' then 'contact_read' when 'crm_get_contact' then 'contact_read' when 'crm_get_contact_consent' then 'consent_read' when 'crm_create_contact' then 'contact_create' when 'crm_update_contact' then 'contact_edit' when 'crm_record_contact_sms_opt_in' then 'consent_opt_in' when 'crm_suppress_contact_sms' then 'contact_suppress' when 'crm_set_contact_automation_blocked' then 'contact_automation_block' when 'crm_preview_contact_sms' then 'sms_message_preview' when 'crm_send_contact_sms' then 'sms_message_send' when 'crm_reply_to_conversation' then 'conversation_reply' when 'crm_preview_conversation_reply' then 'conversation_reply' when 'crm_mark_conversation_messages_read' then 'conversation_mark_read' when 'crm_list_conversations' then 'conversation_read' when 'crm_get_conversation' then 'conversation_read' when 'crm_assign_lead' then 'lead_assign' when 'crm_set_lead_status' then 'lead_status_update' when 'crm_assign_handoff' then 'handoff_assign' when 'crm_set_handoff_status' then 'handoff_status_update' when 'crm_list_leads' then 'lead_read' when 'crm_get_lead' then 'lead_read' when 'crm_list_handoffs' then 'handoff_read' when 'crm_get_handoff' then 'handoff_read' when 'crm_get_enquiry_status' then 'enquiry_status_read' when 'crm_list_enquiries' then 'enquiry_read' when 'crm_get_enquiry' then 'enquiry_read' when 'crm_set_form_collection_enabled' then 'form_activate' when 'crm_apply_form_draft' then 'form_publish' when 'crm_preview_form' then 'form_preview' when 'crm_create_form' then 'form_create' when 'crm_save_form_draft' then 'form_edit' when 'crm_list_forms' then 'form_read' when 'crm_get_form' then 'form_read' when 'crm_search_customers' then 'read' when 'crm_get_customer' then 'read'
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
   if tool in ('crm_list_websites','crm_get_website','crm_get_website_publication','crm_list_website_deployments','crm_get_website_deployment','crm_update_website_details','crm_list_website_form_connections','crm_connect_website_form','crm_disable_website_form_connection','crm_list_website_requests','crm_get_website_request','crm_update_website_request','crm_publish_website','crm_unpublish_website','crm_get_website_operation','crm_list_voice_agents','crm_get_voice_agent','crm_list_voice_versions','crm_get_voice_version','crm_create_voice_agent','crm_save_voice_draft','crm_publish_voice_draft','crm_rollback_voice_configuration','crm_list_voice_calls','crm_get_voice_call','crm_get_voice_transcript','crm_get_voice_recording','crm_set_form_email_enabled','crm_list_email_groups','crm_get_email_group','crm_list_email_enrollments','crm_get_email_enrollment','crm_list_email_jobs','crm_get_email_job','crm_preview_email_schedule','crm_save_email_group','crm_set_email_group_enabled','crm_resolve_email_enrollment','crm_retry_email_job','crm_list_knowledge_sources','crm_get_knowledge_source','crm_list_knowledge_versions','crm_get_knowledge_version','crm_prepare_knowledge_upload','crm_create_knowledge_source','crm_refresh_knowledge_source','crm_archive_knowledge_source','crm_approve_knowledge_version','crm_get_ai_configuration','crm_save_ai_configuration','crm_set_ai_mode','crm_list_bookings','crm_get_booking','crm_list_booking_intakes','crm_get_booking_intake','crm_list_booking_schedules','crm_get_booking_schedule','crm_create_booking_schedule','crm_update_booking_schedule','crm_set_booking_schedule_enabled','crm_preview_booking_availability','crm_update_booking_intake','crm_cancel_booking','crm_duplicate_form','crm_archive_form','crm_restore_form','crm_archive_sms_template','crm_list_sms_presets','crm_get_sms_preset','crm_save_sms_preset','crm_pause_conversation_ai','crm_resume_conversation_ai','crm_reassign_conversation_message','crm_retry_handoff_alert','crm_get_activity_report','crm_list_activity_tags','crm_get_enquiry_attribution_context','crm_create_activity_tag','crm_update_activity_tag','crm_set_enquiry_tag','crm_link_enquiry_booking','crm_link_enquiry_response','crm_link_enquiry_activity','crm_list_contacts','crm_get_contact','crm_get_contact_consent','crm_create_contact','crm_update_contact','crm_record_contact_sms_opt_in','crm_suppress_contact_sms','crm_set_contact_automation_blocked','crm_preview_contact_sms','crm_send_contact_sms','crm_reply_to_conversation','crm_preview_conversation_reply','crm_mark_conversation_messages_read','crm_list_conversations','crm_get_conversation','crm_assign_lead','crm_set_lead_status','crm_assign_handoff','crm_set_handoff_status','crm_list_leads','crm_get_lead','crm_list_handoffs','crm_get_handoff','crm_get_enquiry_status','crm_list_enquiries','crm_get_enquiry','crm_set_form_collection_enabled','crm_apply_form_draft','crm_preview_form','crm_create_form','crm_save_form_draft','crm_list_forms','crm_get_form','crm_list_sms_runs','crm_get_sms_run','crm_get_sms_run_activity','crm_resume_sms_run','crm_pause_sms_run','crm_stop_sms_run','crm_get_sms_run_start_context','crm_start_sms_automation_run','crm_publish_sms_automation','crm_set_form_followups_enabled','crm_create_sms_automation','crm_save_sms_automation_draft','crm_preview_sms_automation','crm_list_sms_automations','crm_get_sms_automation','crm_search_sms_contacts','crm_list_form_submissions','crm_get_business','crm_save_business_profile_draft','crm_review_business_profile','crm_add_business_service','crm_set_service_visibility')
    and (t is null or (not c.all_businesses and not t=any(c.business_ids)) or not exists(select from public.sms_businesses where tenant_id=t)) then raise exception 'Business access denied' using errcode='42501'; end if;
   if tool='crm_start_sms_automation_run' and p->>'overlapChoice'='stop_selected' and not 'automation_run_pause_stop'=any(c.permissions) then raise exception 'Stopping overlapping runs is not granted' using errcode='42501'; end if;
   if tool='crm_get_conversation' and p->'includeMessages'='true'::jsonb and not 'conversation_messages_read'=any(c.permissions) then raise exception 'Message content is not granted' using errcode='42501'; end if;
   if tool in ('crm_list_websites','crm_get_website','crm_get_website_publication','crm_list_website_deployments','crm_get_website_deployment','crm_list_website_form_connections','crm_list_website_requests','crm_get_website_request','crm_get_website_operation') then
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
     if tool in ('crm_update_website_details','crm_connect_website_form','crm_disable_website_form_connection','crm_update_website_request','crm_publish_website','crm_unpublish_website') then
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
  values(c.id,aid,left(tool,100),left(coalesce(data->>'websiteRequestId',data->>'siteId',data->>'agentId',data->>'callId',data->'agent'->>'id',data->'call'->>'id',data->>'bookingId',data->>'intakeId',data->>'scheduleId',data->>'formId',data->>'presetId',data->>'automationId',data->>'tagId',data->>'runId',data->>'handoffId',data->>'conversationId',data->>'contactId',data->'contact'->>'id',data->'conversation'->>'id',data->'lead'->>'id',data->'handoff'->>'id',data->'enquiry'->>'id',data->'form'->>'id',data->'run'->>'id',data->'automation'->>'id',target),255),request_id,case when error_code is not null then 'denied' when replay then 'replayed' else 'success' end,error_code,
   case when error_code is null then coalesce((data->>'revision')::bigint,(data->'contact'->>'revision')::bigint,(data->'conversation'->>'revision')::bigint,(data->'lead'->>'revision')::bigint,(data->'handoff'->>'revision')::bigint,(data->'enquiryStatus'->'sms'->>'generation')::bigint,(data->'enquiryStatus'->>'submittedFormVersion')::bigint,(data->'enquiry'->>'submittedFormVersion')::bigint,(data->'form'->>'revision')::bigint,(data->'run'->>'generation')::bigint,(data->'source'->>'revision')::bigint,(data->'automation'->>'revision')::bigint,(data->'record'->>'revision')::bigint,(data->'business'->'setup'->>'revision')::bigint) end,
   case when error_code is null then coalesce(nullif(data->>'draftRevision','0'),data->'form'->>'draftRevision')::bigint end,
   case when error_code is null and tool in ('crm_update_website_details','crm_connect_website_form','crm_disable_website_form_connection','crm_update_website_request','crm_publish_website','crm_unpublish_website','crm_create_voice_agent','crm_save_voice_draft','crm_publish_voice_draft','crm_rollback_voice_configuration','crm_set_form_email_enabled','crm_save_email_group','crm_set_email_group_enabled','crm_resolve_email_enrollment','crm_retry_email_job','crm_prepare_knowledge_upload','crm_create_knowledge_source','crm_refresh_knowledge_source','crm_archive_knowledge_source','crm_approve_knowledge_version','crm_save_ai_configuration','crm_set_ai_mode','crm_create_booking_schedule','crm_update_booking_schedule','crm_set_booking_schedule_enabled','crm_update_booking_intake','crm_cancel_booking','crm_duplicate_form','crm_archive_form','crm_restore_form','crm_archive_sms_template','crm_save_sms_preset','crm_pause_conversation_ai','crm_resume_conversation_ai','crm_reassign_conversation_message','crm_retry_handoff_alert','crm_create_activity_tag','crm_update_activity_tag','crm_set_enquiry_tag','crm_link_enquiry_booking','crm_link_enquiry_response','crm_link_enquiry_activity','crm_create_contact','crm_update_contact','crm_record_contact_sms_opt_in','crm_suppress_contact_sms','crm_set_contact_automation_blocked','crm_send_contact_sms','crm_reply_to_conversation','crm_mark_conversation_messages_read','crm_assign_lead','crm_set_lead_status','crm_assign_handoff','crm_set_handoff_status') then (data->>'previousRevision')::bigint end,
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
