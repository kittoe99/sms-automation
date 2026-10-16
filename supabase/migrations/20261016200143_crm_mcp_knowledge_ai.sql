-- CRM-owned knowledge/active SMS AI contracts. No E2 schema changes.
alter table public.sms_knowledge_sources add column revision bigint not null default 1 check(revision between 1 and 9007199254740991);
alter table public.sms_knowledge_source_versions add column revision bigint not null default 1 check(revision between 1 and 9007199254740991);
create function sms_private.knowledge_shared_revision() returns trigger language plpgsql set search_path='' as $$
begin
 if new.tenant_id<>old.tenant_id then raise exception 'Immutable business identity';end if;
 if tg_table_name<>'inbound_ai_settings' then
  if new.id<>old.id then raise exception 'Immutable knowledge identity';end if;
  if tg_table_name='sms_knowledge_source_versions' then if new.source_id<>old.source_id then raise exception 'Immutable source identity';end if;end if;
  if old.status='archived' and new.status<>'archived' then raise exception 'Archived knowledge cannot be reactivated' using errcode='23505';end if;
 end if;
 new.revision:=old.revision+1;return new;
end $$;
create trigger knowledge_shared_revision before update on public.sms_knowledge_sources for each row execute function sms_private.knowledge_shared_revision();
create trigger knowledge_version_shared_revision before update on public.sms_knowledge_source_versions for each row execute function sms_private.knowledge_shared_revision();
create trigger inbound_settings_shared_revision before update on sms_private.inbound_ai_settings for each row execute function sms_private.knowledge_shared_revision();
revoke all on function sms_private.knowledge_shared_revision() from public,anon,authenticated,service_role,sms_api,crm_mcp;

-- Browser source creation takes the same business lock as MCP, preventing a
-- concurrent upsert from bypassing the MCP duplicate-origin check.
alter function sms_private.create_knowledge_source(text,text,jsonb) rename to create_knowledge_source_before_mcp;
create function sms_private.create_knowledge_source(u text,t text,p jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$ begin
 perform sms_private.require_admin(u);
 if not sms_private.can_access(t,u) then raise exception 'Business access denied' using errcode='42501';end if;
 perform 1 from public.sms_businesses where tenant_id=t for update;
 return sms_private.create_knowledge_source_before_mcp(u,t,p);
end $$;
revoke all on function sms_private.create_knowledge_source_before_mcp(text,text,jsonb),sms_private.create_knowledge_source(text,text,jsonb) from public,anon,authenticated,service_role,sms_api,crm_mcp;
grant execute on function sms_private.create_knowledge_source(text,text,jsonb) to sms_api;

create table sms_private.mcp_knowledge_uploads(
 id uuid primary key default gen_random_uuid(),connection_id uuid not null references sms_private.mcp_connections(id),
 tenant_id text not null references public.sms_businesses(tenant_id),file_name text not null,content_type text not null,
 byte_size integer not null check(byte_size between 1 and 10485760),storage_path text not null unique,
 source_id uuid,expires_at timestamptz not null default now()+interval '24 hours',
 foreign key(tenant_id,source_id) references public.sms_knowledge_sources(tenant_id,id)
);
create table sms_private.mcp_upload_tickets(
 token_hash text primary key,upload_id uuid not null references sms_private.mcp_knowledge_uploads(id),
 expires_at timestamptz not null default now()+interval '60 seconds'
);
alter table sms_private.mcp_knowledge_uploads enable row level security;
alter table sms_private.mcp_upload_tickets enable row level security;
revoke all on sms_private.mcp_knowledge_uploads,sms_private.mcp_upload_tickets from public,anon,authenticated,service_role,sms_api,crm_mcp;
create index mcp_upload_connection on sms_private.mcp_knowledge_uploads(connection_id,tenant_id);
create index mcp_upload_ticket_upload on sms_private.mcp_upload_tickets(upload_id);

-- Restricted login mints a one-use adapter credential only for its own intent.
-- It is never stored in mutation receipts or activity logs.
create function crm_mcp.knowledge_upload_ticket(u text,client text,upload uuid) returns text
language plpgsql security definer set search_path='' as $$
declare c sms_private.mcp_connections; x sms_private.mcp_knowledge_uploads; token text; actor uuid;
begin
 perform pg_advisory_xact_lock_shared(hashtextextended('platform:privileges',0));
 actor:=sms_private.platform_actor(u);
 select * into c from sms_private.mcp_connections where issuer=current_setting('platform.actor_issuer',true) and subject=u and client_id=client for share;
 select * into x from sms_private.mcp_knowledge_uploads where id=upload and connection_id=c.id;
 if not sms_private.platform_staff(actor) or actor is distinct from c.account_id or c.status is distinct from 'active'
  or not 'knowledge_upload'=any(c.permissions) or x.id is null or x.expires_at<=now() or x.source_id is not null
  or not (c.all_businesses or x.tenant_id=any(c.business_ids)) then raise exception 'Upload access denied' using errcode='42501';end if;
 token:=gen_random_uuid()::text||gen_random_uuid()::text;
 delete from sms_private.mcp_upload_tickets where expires_at<=now() or upload_id=x.id;
 insert into sms_private.mcp_upload_tickets(token_hash,upload_id) values(encode(sha256(convert_to(token,'UTF8')),'hex'),x.id);
 return token;
end $$;
revoke all on function crm_mcp.knowledge_upload_ticket(text,text,uuid) from public,anon,authenticated,service_role,sms_api;
grant execute on function crm_mcp.knowledge_upload_ticket(text,text,uuid) to crm_mcp;
create function sms_private.mcp_consume_upload_ticket(token text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare ticket sms_private.mcp_upload_tickets; x sms_private.mcp_knowledge_uploads;c sms_private.mcp_connections;
begin
 perform pg_advisory_xact_lock_shared(hashtextextended('platform:privileges',0));
 if length(token)<>72 then raise exception 'Upload access denied' using errcode='42501';end if;
 delete from sms_private.mcp_upload_tickets where token_hash=encode(sha256(convert_to(token,'UTF8')),'hex') and expires_at>now() returning * into ticket;
 select * into x from sms_private.mcp_knowledge_uploads where id=ticket.upload_id;
 select * into c from sms_private.mcp_connections where id=x.connection_id for share;
 if ticket.upload_id is null or x.expires_at<=now() or x.source_id is not null or c.status is distinct from 'active'
  or not 'knowledge_upload'=any(c.permissions) or not(c.all_businesses or x.tenant_id=any(c.business_ids))
  or not sms_private.platform_staff(c.account_id) or sms_private.login_issuer() is distinct from c.issuer or sms_private.platform_actor(c.subject) is distinct from c.account_id then raise exception 'Upload access denied' using errcode='42501';end if;
 return jsonb_build_object('path',x.storage_path,'contentType',x.content_type,'maxBytes',x.byte_size);
end $$;
revoke all on function sms_private.mcp_consume_upload_ticket(text) from public,anon,authenticated,service_role,crm_mcp;
grant execute on function sms_private.mcp_consume_upload_ticket(text) to sms_api;

create function sms_private.mcp_knowledge_source(s public.sms_knowledge_sources) returns jsonb
language sql immutable set search_path='' as $$ select jsonb_build_object('id',s.id,'revision',s.revision,'type',s.type,'title',s.title,'status',s.status,'activeVersionId',s.active_version_id,'updatedAt',s.updated_at) $$;
create function sms_private.mcp_knowledge_version(v public.sms_knowledge_source_versions) returns jsonb
language sql immutable set search_path='' as $$ select jsonb_build_object('id',v.id,'sourceId',v.source_id,'revision',v.revision,'version',v.version,'status',v.status,'createdAt',v.created_at,'approvedAt',v.approved_at) $$;
create function sms_private.mcp_ai_configuration(t text) returns jsonb
language sql stable set search_path='' as $$ select jsonb_build_object('revision',coalesce(s.revision,0),'mode',coalesce(s.mode,'off'),'systemPrompt',coalesce(s.system_prompt,''),'bookingEnabled',coalesce(s.booking_enabled,false),'liveValidated',s.live_validated_at is not null,'coordinationEnabled',coalesce(s.coordination_enabled,false),'pilot',t='biz-1c0c09ce-819e-4795-86b9-0e457ab92f58') from (select 1) dummy left join sms_private.inbound_ai_settings s on s.tenant_id=t $$;

create function sms_private.mcp_knowledge_action(u text,t text,tool text,p jsonb,cid uuid,rid uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
#variable_conflict use_column
declare s public.sms_knowledge_sources;v public.sms_knowledge_source_versions;x sms_private.mcp_knowledge_uploads;
 a sms_private.inbound_ai_settings;file_meta jsonb;result jsonb;items jsonb;total bigint;pg integer:=coalesce((p->>'page')::integer,1);sz integer:=coalesce((p->>'pageSize')::integer,25);
 prior_versions jsonb;previous bigint;vid uuid;vrev bigint;work text:='none';origin text;ids uuid[];start_at integer:=coalesce((p->>'textOffset')::integer,0);text_limit integer:=coalesce((p->>'textLimit')::integer,4000);
begin
 perform sms_private.mcp_validate_input(tool,p);
 if tool='crm_list_knowledge_sources' then
  select count(*) into total from public.sms_knowledge_sources where tenant_id=t;
  select coalesce(jsonb_agg(sms_private.mcp_knowledge_source(q) order by q.updated_at desc,q.id),'[]') into items from (select * from public.sms_knowledge_sources where tenant_id=t order by updated_at desc,id limit sz offset (pg-1)*sz) q;
  return jsonb_build_object('businessId',t,'sources',items,'total',total,'page',pg,'pageSize',sz);
 elsif tool='crm_prepare_knowledge_upload' then
  insert into sms_private.mcp_knowledge_uploads(connection_id,tenant_id,file_name,content_type,byte_size,storage_path)
  values(cid,t,p->>'fileName',p->>'contentType',(p->>'size')::integer,t||'/'||gen_random_uuid()||'-'||(p->>'fileName')) returning * into x;
  return jsonb_build_object('businessId',t,'uploadId',x.id,'contentType',x.content_type,'maxBytes',x.byte_size,'expiresAt',x.expires_at,'uploadStatus','prepared','databaseStatus','committed','previousRevision',null,'revision',1);
 elsif tool in ('crm_get_ai_configuration','crm_save_ai_configuration','crm_set_ai_mode') then
  if tool='crm_get_ai_configuration' then return jsonb_build_object('businessId',t,'configuration',sms_private.mcp_ai_configuration(t));end if;
  perform 1 from public.sms_businesses where tenant_id=t for update;
  select * into a from sms_private.inbound_ai_settings where tenant_id=t for update;
  previous:=coalesce(a.revision,0);
  if previous<>(p->>'revision')::bigint then raise exception 'AI settings changed; reread' using errcode='23505';end if;
  result:=sms_private.inbound_ai_settings_api(u,t,jsonb_build_object('revision',previous,
   'systemPrompt',case when tool='crm_save_ai_configuration' then p->>'systemPrompt' else coalesce(a.system_prompt,'') end,
   'mode',case when tool='crm_set_ai_mode' then p->>'mode' else coalesce(a.mode,'off') end,
   'bookingEnabled',case when tool='crm_set_ai_mode' then (p->>'bookingEnabled')::boolean else coalesce(a.booking_enabled,false) end));
  result:=sms_private.mcp_ai_configuration(t);
  return jsonb_build_object('businessId',t,'configuration',result-'systemPrompt','previousRevision',previous,'revision',result->'revision','databaseStatus','committed','messageQueued',false);
 elsif tool='crm_create_knowledge_source' then
  perform 1 from public.sms_businesses where tenant_id=t for update;
  if p->>'type'='website' then
   if not p ? 'websiteUrl' or p ?| array['text','uploadId'] then raise exception 'Website URL required exclusively' using errcode='22023';end if;
   origin:=p->>'websiteUrl';
   if origin !~ '^https://[^/@#[:space:]]+(/[^#[:space:]]*)?$' then raise exception 'Public HTTPS URL without credentials or fragment required' using errcode='22023';end if;
  elsif p->>'type'='manual' then
   if not p ? 'text' or p ?| array['websiteUrl','uploadId'] then raise exception 'Manual text required exclusively' using errcode='22023';end if;origin:=p->>'text';
  else
   if not p ? 'uploadId' or p ?| array['text','websiteUrl'] then raise exception 'Prepared upload required exclusively' using errcode='22023';end if;
   select * into x from sms_private.mcp_knowledge_uploads where tenant_id=t and id=(p->>'uploadId')::uuid and connection_id=cid for update;
   if x.id is null then raise exception 'Upload access denied' using errcode='42501';end if;
   if x.expires_at<=now() or x.source_id is not null then raise exception 'Upload expired or already consumed' using errcode='23505';end if;
   if to_regclass('storage.objects') is null then raise exception 'Private storage is unavailable' using errcode='55P03';end if;
   execute 'select metadata from storage.objects where bucket_id=$1 and name=$2' into file_meta using 'business-knowledge',x.storage_path;
   if file_meta is null or file_meta->>'mimetype' is distinct from x.content_type or (file_meta->>'size')::bigint is distinct from x.byte_size::bigint then raise exception 'Upload the complete matching file before indexing' using errcode='22023';end if;
  end if;
  if origin is not null and exists(select from public.sms_knowledge_sources q where q.tenant_id=t and q.origin=btrim(case when p->>'type'='website' then p->>'websiteUrl' else p->>'text' end)) then raise exception 'Source already exists; reread and refresh it' using errcode='23505';end if;
  result:=sms_private.create_knowledge_source(u,t,jsonb_build_object('type',p->>'type','title',p->>'title','origin',origin,'storagePath',x.storage_path));
  select * into s from public.sms_knowledge_sources where tenant_id=t and id=(result->>'id')::uuid;
  if x.id is not null then update sms_private.mcp_knowledge_uploads set source_id=s.id where id=x.id;end if;
  work:='queued';
 else
  select * into s from public.sms_knowledge_sources where tenant_id=t and id=(p->>'sourceId')::uuid;
  if s.id is null then raise exception 'Source access denied' using errcode='42501';end if;
  if tool='crm_get_knowledge_source' then return jsonb_build_object('businessId',t,'source',sms_private.mcp_knowledge_source(s));end if;
  if tool='crm_list_knowledge_versions' then
   select count(*) into total from public.sms_knowledge_source_versions where tenant_id=t and source_id=s.id;
   select coalesce(jsonb_agg(sms_private.mcp_knowledge_version(q) order by q.version desc,q.id),'[]') into items from (select * from public.sms_knowledge_source_versions where tenant_id=t and source_id=s.id order by version desc,id limit sz offset (pg-1)*sz) q;
   return jsonb_build_object('businessId',t,'sourceId',s.id,'versions',items,'total',total,'page',pg,'pageSize',sz);
  end if;
  if tool='crm_get_knowledge_version' then
   select * into v from public.sms_knowledge_source_versions where tenant_id=t and source_id=s.id and id=(p->>'versionId')::uuid;
   if v.id is null then raise exception 'Version access denied' using errcode='42501';end if;
   return jsonb_build_object('businessId',t,'version',sms_private.mcp_knowledge_version(v),'text',substr(v.extracted_text,start_at+1,text_limit),'textOffset',start_at,'totalCharacters',length(v.extracted_text),'nextTextOffset',case when length(v.extracted_text)>start_at+text_limit then start_at+text_limit end);
  end if;
  select * into s from public.sms_knowledge_sources where tenant_id=t and id=s.id for update nowait;
  previous:=s.revision;
  if previous<>(p->>'revision')::bigint or s.status='archived' then raise exception 'Source changed or archived; reread' using errcode='23505';end if;
  perform 1 from public.sms_knowledge_source_versions where tenant_id=t and source_id=s.id for update nowait;
  select coalesce(jsonb_object_agg(id::text,revision),'{}') into prior_versions from public.sms_knowledge_source_versions where tenant_id=t and source_id=s.id;
  if tool='crm_refresh_knowledge_source' then
   if s.type='structured' then raise exception 'Use the reviewed business profile workflow' using errcode='22023';end if;
   perform sms_private.queue_knowledge_refresh(u,t,s.id);work:='queued';
  elsif tool='crm_archive_knowledge_source' then
   if s.type='structured' then raise exception 'Use the reviewed business profile workflow' using errcode='22023';end if;
   perform 1 from sms_private.jobs where tenant_id=t and queue in ('knowledge_ingest_jobs','embedding_jobs') and payload->>'source_id'=s.id::text for update nowait;
   if exists(select from sms_private.jobs where tenant_id=t and queue in ('knowledge_ingest_jobs','embedding_jobs') and payload->>'source_id'=s.id::text and status in ('processing','leased','submitting','unknown')) then raise exception 'Indexing is in flight; retry later' using errcode='55P03';end if;
   select array_agg(id) into ids from sms_private.jobs where tenant_id=t and queue in ('knowledge_ingest_jobs','embedding_jobs') and payload->>'source_id'=s.id::text and status in ('queued','retry');
   update sms_private.jobs set status='cancelled' where tenant_id=t and queue in ('knowledge_ingest_jobs','embedding_jobs') and payload->>'source_id'=s.id::text and status in ('queued','retry');
   perform sms_private.archive_knowledge_source(u,t,s.id);
   insert into sms_private.mcp_activity(connection_id,actor_id,tool,target,request_id,outcome) select cid,sms_private.platform_actor(u),tool||':job',j.id::text,rid,'success' from sms_private.jobs j where j.tenant_id=t and j.id=any(ids);
  elsif tool='crm_approve_knowledge_version' then
   select * into v from public.sms_knowledge_source_versions where tenant_id=t and source_id=s.id and id=(p->>'versionId')::uuid for update nowait;
   if v.id is null then raise exception 'Version access denied' using errcode='42501';end if;
   if v.revision<>(p->>'versionRevision')::bigint then raise exception 'Version changed; reread' using errcode='23505';end if;
   if v.status<>'ready' then raise exception 'Indexed ready version required' using errcode='22023';end if;
   perform sms_private.approve_knowledge_version(u,t,v.id);vid:=v.id;
   select revision into vrev from public.sms_knowledge_source_versions where tenant_id=t and id=v.id;
  else raise exception 'Unsupported knowledge tool' using errcode='22023';end if;
  if tool in ('crm_archive_knowledge_source','crm_approve_knowledge_version') then
   insert into sms_private.mcp_activity(connection_id,actor_id,tool,target,request_id,outcome,previous_revision,revision)
   select cid,sms_private.platform_actor(u),tool||':version',q.id::text,rid,'success',(prior_versions->>q.id::text)::bigint,q.revision from public.sms_knowledge_source_versions q where q.tenant_id=t and q.source_id=s.id and q.revision is distinct from (prior_versions->>q.id::text)::bigint;
  end if;
  select * into s from public.sms_knowledge_sources where tenant_id=t and id=s.id;
 end if;
 return jsonb_build_object('businessId',t,'sourceId',s.id,'previousRevision',previous,'revision',s.revision,'status',s.status,'providerWork',work,'versionId',vid,'versionRevision',vrev,'databaseStatus','committed');
end $$;
revoke all on function sms_private.mcp_knowledge_source(public.sms_knowledge_sources),sms_private.mcp_knowledge_version(public.sms_knowledge_source_versions),sms_private.mcp_ai_configuration(text),sms_private.mcp_knowledge_action(text,text,text,jsonb,uuid,uuid) from public,anon,authenticated,service_role,sms_api,crm_mcp;

-- GENERATED MCP CONTRACTS
insert into sms_private.mcp_input_schemas values('crm_list_knowledge_sources','{"type":"object","properties":{"businessId":{"type":"string","minLength":1,"maxLength":255},"page":{"type":"integer","minimum":1,"maximum":100000,"default":1},"pageSize":{"type":"integer","minimum":1,"maximum":100,"default":25}},"required":["businessId"],"additionalProperties":false,"$schema":"http://json-schema.org/draft-07/schema#"}'::jsonb);
insert into sms_private.mcp_input_schemas values('crm_get_knowledge_source','{"type":"object","properties":{"businessId":{"type":"string","minLength":1,"maxLength":255},"sourceId":{"type":"string","format":"uuid"}},"required":["businessId","sourceId"],"additionalProperties":false,"$schema":"http://json-schema.org/draft-07/schema#"}'::jsonb);
insert into sms_private.mcp_input_schemas values('crm_list_knowledge_versions','{"type":"object","properties":{"businessId":{"type":"string","minLength":1,"maxLength":255},"sourceId":{"type":"string","format":"uuid"},"page":{"type":"integer","minimum":1,"maximum":100000,"default":1},"pageSize":{"type":"integer","minimum":1,"maximum":100,"default":25}},"required":["businessId","sourceId"],"additionalProperties":false,"$schema":"http://json-schema.org/draft-07/schema#"}'::jsonb);
insert into sms_private.mcp_input_schemas values('crm_get_knowledge_version','{"type":"object","properties":{"businessId":{"type":"string","minLength":1,"maxLength":255},"sourceId":{"type":"string","format":"uuid"},"versionId":{"type":"string","format":"uuid"},"textOffset":{"type":"integer","minimum":0,"maximum":5242880,"default":0},"textLimit":{"type":"integer","minimum":1,"maximum":20000,"default":4000}},"required":["businessId","sourceId","versionId"],"additionalProperties":false,"$schema":"http://json-schema.org/draft-07/schema#"}'::jsonb);
insert into sms_private.mcp_input_schemas values('crm_prepare_knowledge_upload','{"type":"object","properties":{"businessId":{"type":"string","minLength":1,"maxLength":255},"fileName":{"type":"string","minLength":1,"maxLength":120,"pattern":"^[a-zA-Z0-9][a-zA-Z0-9._-]*$"},"contentType":{"type":"string","enum":["application/pdf","application/vnd.openxmlformats-officedocument.wordprocessingml.document","text/plain","text/markdown"]},"size":{"type":"integer","minimum":1,"maximum":10485760},"idempotencyKey":{"type":"string","minLength":8,"maxLength":128}},"required":["businessId","fileName","contentType","size","idempotencyKey"],"additionalProperties":false,"$schema":"http://json-schema.org/draft-07/schema#"}'::jsonb);
insert into sms_private.mcp_input_schemas values('crm_create_knowledge_source','{"type":"object","properties":{"businessId":{"type":"string","minLength":1,"maxLength":255},"type":{"type":"string","enum":["website","manual","file"]},"title":{"type":"string","minLength":1,"maxLength":200},"websiteUrl":{"type":"string","minLength":10,"maxLength":2048},"text":{"type":"string","minLength":20,"maxLength":20000},"uploadId":{"type":"string","format":"uuid"},"idempotencyKey":{"type":"string","minLength":8,"maxLength":128}},"required":["businessId","type","title","idempotencyKey"],"additionalProperties":false,"$schema":"http://json-schema.org/draft-07/schema#"}'::jsonb);
insert into sms_private.mcp_input_schemas values('crm_refresh_knowledge_source','{"type":"object","properties":{"businessId":{"type":"string","minLength":1,"maxLength":255},"sourceId":{"type":"string","format":"uuid"},"revision":{"type":"integer","minimum":0,"maximum":9007199254740991},"idempotencyKey":{"type":"string","minLength":8,"maxLength":128}},"required":["businessId","sourceId","revision","idempotencyKey"],"additionalProperties":false,"$schema":"http://json-schema.org/draft-07/schema#"}'::jsonb);
insert into sms_private.mcp_input_schemas values('crm_archive_knowledge_source','{"type":"object","properties":{"businessId":{"type":"string","minLength":1,"maxLength":255},"sourceId":{"type":"string","format":"uuid"},"revision":{"type":"integer","minimum":0,"maximum":9007199254740991},"idempotencyKey":{"type":"string","minLength":8,"maxLength":128}},"required":["businessId","sourceId","revision","idempotencyKey"],"additionalProperties":false,"$schema":"http://json-schema.org/draft-07/schema#"}'::jsonb);
insert into sms_private.mcp_input_schemas values('crm_approve_knowledge_version','{"type":"object","properties":{"businessId":{"type":"string","minLength":1,"maxLength":255},"sourceId":{"type":"string","format":"uuid"},"revision":{"type":"integer","minimum":0,"maximum":9007199254740991},"versionId":{"type":"string","format":"uuid"},"versionRevision":{"type":"integer","minimum":0,"maximum":9007199254740991},"idempotencyKey":{"type":"string","minLength":8,"maxLength":128}},"required":["businessId","sourceId","revision","versionId","versionRevision","idempotencyKey"],"additionalProperties":false,"$schema":"http://json-schema.org/draft-07/schema#"}'::jsonb);
insert into sms_private.mcp_input_schemas values('crm_get_ai_configuration','{"type":"object","properties":{"businessId":{"type":"string","minLength":1,"maxLength":255}},"required":["businessId"],"additionalProperties":false,"$schema":"http://json-schema.org/draft-07/schema#"}'::jsonb);
insert into sms_private.mcp_input_schemas values('crm_save_ai_configuration','{"type":"object","properties":{"businessId":{"type":"string","minLength":1,"maxLength":255},"revision":{"type":"integer","minimum":0,"maximum":9007199254740991},"systemPrompt":{"type":"string","maxLength":6000},"idempotencyKey":{"type":"string","minLength":8,"maxLength":128}},"required":["businessId","revision","systemPrompt","idempotencyKey"],"additionalProperties":false,"$schema":"http://json-schema.org/draft-07/schema#"}'::jsonb);
insert into sms_private.mcp_input_schemas values('crm_set_ai_mode','{"type":"object","properties":{"businessId":{"type":"string","minLength":1,"maxLength":255},"revision":{"type":"integer","minimum":0,"maximum":9007199254740991},"mode":{"type":"string","enum":["off","shadow","live"]},"bookingEnabled":{"type":"boolean"},"idempotencyKey":{"type":"string","minLength":8,"maxLength":128}},"required":["businessId","revision","mode","bookingEnabled","idempotencyKey"],"additionalProperties":false,"$schema":"http://json-schema.org/draft-07/schema#"}'::jsonb);
alter table sms_private.mcp_connections drop constraint mcp_connections_permissions_check;
alter table sms_private.mcp_connections add constraint mcp_connections_permissions_check check(permissions <@ array['knowledge_read','knowledge_upload','knowledge_create','knowledge_refresh','knowledge_archive','knowledge_approve','ai_config_read','ai_config_edit','ai_activate','booking_read','booking_intake_read','booking_schedule_read','booking_schedule_edit','booking_schedule_enable','booking_preview','booking_intake_edit','booking_cancel','form_duplicate','form_archive','form_restore','automation_archive','automation_preset_read','automation_preset_save','conversation_ai_pause','conversation_ai_resume','conversation_message_reassign','handoff_alert_retry','activity_report_read','activity_tag_manage','activity_attribution_update','read','draft','review','service_add','visibility','global_customer_lookup','automation_read','automation_draft','automation_preview','automation_publish','automation_enable','automation_run_start','automation_run_resume','automation_run_pause_stop','automation_activity','form_read','form_create','form_edit','form_preview','form_publish','form_activate','enquiry_read','enquiry_status_read','lead_read','lead_status_update','lead_assign','handoff_read','handoff_status_update','handoff_assign','conversation_read','conversation_messages_read','conversation_reply','conversation_mark_read','contact_read','contact_create','contact_edit','consent_read','consent_opt_in','contact_suppress','contact_automation_block','sms_message_preview','sms_message_send']::text[]);
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
  if not perms <@ array['knowledge_read','knowledge_upload','knowledge_create','knowledge_refresh','knowledge_archive','knowledge_approve','ai_config_read','ai_config_edit','ai_activate','booking_read','booking_intake_read','booking_schedule_read','booking_schedule_edit','booking_schedule_enable','booking_preview','booking_intake_edit','booking_cancel','form_duplicate','form_archive','form_restore','automation_archive','automation_preset_read','automation_preset_save','conversation_ai_pause','conversation_ai_resume','conversation_message_reassign','handoff_alert_retry','activity_report_read','activity_tag_manage','activity_attribution_update','read','draft','review','service_add','visibility','global_customer_lookup','automation_read','automation_draft','automation_preview','automation_publish','automation_enable','automation_run_start','automation_run_resume','automation_run_pause_stop','automation_activity','form_read','form_create','form_edit','form_preview','form_publish','form_activate','enquiry_read','enquiry_status_read','lead_read','lead_status_update','lead_assign','handoff_read','handoff_status_update','handoff_assign','conversation_read','conversation_messages_read','conversation_reply','conversation_mark_read','contact_read','contact_create','contact_edit','consent_read','consent_opt_in','contact_suppress','contact_automation_block','sms_message_preview','sms_message_send']::text[] or cardinality(businesses)>500
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
 t text:=p->>'businessId'; target text:=coalesce(p->>'sourceId',p->>'uploadId',p->>'tagId',p->>'eventId',p->>'contactId',p->>'conversationId',p->>'leadId',p->>'handoffId',p->>'submissionId',p->>'runId',p->>'automationId',p->>'formId',p->>'businessId',p->>'accountId');
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
   required_permission:=case tool when 'crm_list_knowledge_sources' then 'knowledge_read' when 'crm_get_knowledge_source' then 'knowledge_read' when 'crm_list_knowledge_versions' then 'knowledge_read' when 'crm_get_knowledge_version' then 'knowledge_read' when 'crm_prepare_knowledge_upload' then 'knowledge_upload' when 'crm_create_knowledge_source' then 'knowledge_create' when 'crm_refresh_knowledge_source' then 'knowledge_refresh' when 'crm_archive_knowledge_source' then 'knowledge_archive' when 'crm_approve_knowledge_version' then 'knowledge_approve' when 'crm_get_ai_configuration' then 'ai_config_read' when 'crm_save_ai_configuration' then 'ai_config_edit' when 'crm_set_ai_mode' then 'ai_activate' when 'crm_list_bookings' then 'booking_read' when 'crm_get_booking' then 'booking_read' when 'crm_list_booking_intakes' then 'booking_intake_read' when 'crm_get_booking_intake' then 'booking_intake_read' when 'crm_list_booking_schedules' then 'booking_schedule_read' when 'crm_get_booking_schedule' then 'booking_schedule_read' when 'crm_create_booking_schedule' then 'booking_schedule_edit' when 'crm_update_booking_schedule' then 'booking_schedule_edit' when 'crm_set_booking_schedule_enabled' then 'booking_schedule_enable' when 'crm_preview_booking_availability' then 'booking_preview' when 'crm_update_booking_intake' then 'booking_intake_edit' when 'crm_cancel_booking' then 'booking_cancel' when 'crm_duplicate_form' then 'form_duplicate' when 'crm_archive_form' then 'form_archive' when 'crm_restore_form' then 'form_restore' when 'crm_archive_sms_template' then 'automation_archive' when 'crm_list_sms_presets' then 'automation_preset_read' when 'crm_get_sms_preset' then 'automation_preset_read' when 'crm_save_sms_preset' then 'automation_preset_save' when 'crm_pause_conversation_ai' then 'conversation_ai_pause' when 'crm_resume_conversation_ai' then 'conversation_ai_resume' when 'crm_reassign_conversation_message' then 'conversation_message_reassign' when 'crm_retry_handoff_alert' then 'handoff_alert_retry' when 'crm_get_activity_report' then 'activity_report_read' when 'crm_list_activity_tags' then 'activity_report_read' when 'crm_get_enquiry_attribution_context' then 'activity_report_read' when 'crm_create_activity_tag' then 'activity_tag_manage' when 'crm_update_activity_tag' then 'activity_tag_manage' when 'crm_set_enquiry_tag' then 'activity_tag_manage' when 'crm_link_enquiry_booking' then 'activity_attribution_update' when 'crm_link_enquiry_response' then 'activity_attribution_update' when 'crm_link_enquiry_activity' then 'activity_attribution_update' when 'crm_list_contacts' then 'contact_read' when 'crm_get_contact' then 'contact_read' when 'crm_get_contact_consent' then 'consent_read' when 'crm_create_contact' then 'contact_create' when 'crm_update_contact' then 'contact_edit' when 'crm_record_contact_sms_opt_in' then 'consent_opt_in' when 'crm_suppress_contact_sms' then 'contact_suppress' when 'crm_set_contact_automation_blocked' then 'contact_automation_block' when 'crm_preview_contact_sms' then 'sms_message_preview' when 'crm_send_contact_sms' then 'sms_message_send' when 'crm_reply_to_conversation' then 'conversation_reply' when 'crm_preview_conversation_reply' then 'conversation_reply' when 'crm_mark_conversation_messages_read' then 'conversation_mark_read' when 'crm_list_conversations' then 'conversation_read' when 'crm_get_conversation' then 'conversation_read' when 'crm_assign_lead' then 'lead_assign' when 'crm_set_lead_status' then 'lead_status_update' when 'crm_assign_handoff' then 'handoff_assign' when 'crm_set_handoff_status' then 'handoff_status_update' when 'crm_list_leads' then 'lead_read' when 'crm_get_lead' then 'lead_read' when 'crm_list_handoffs' then 'handoff_read' when 'crm_get_handoff' then 'handoff_read' when 'crm_get_enquiry_status' then 'enquiry_status_read' when 'crm_list_enquiries' then 'enquiry_read' when 'crm_get_enquiry' then 'enquiry_read' when 'crm_set_form_collection_enabled' then 'form_activate' when 'crm_apply_form_draft' then 'form_publish' when 'crm_preview_form' then 'form_preview' when 'crm_create_form' then 'form_create' when 'crm_save_form_draft' then 'form_edit' when 'crm_list_forms' then 'form_read' when 'crm_get_form' then 'form_read' when 'crm_search_customers' then 'read' when 'crm_get_customer' then 'read'
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
   if tool in ('crm_list_knowledge_sources','crm_get_knowledge_source','crm_list_knowledge_versions','crm_get_knowledge_version','crm_prepare_knowledge_upload','crm_create_knowledge_source','crm_refresh_knowledge_source','crm_archive_knowledge_source','crm_approve_knowledge_version','crm_get_ai_configuration','crm_save_ai_configuration','crm_set_ai_mode','crm_list_bookings','crm_get_booking','crm_list_booking_intakes','crm_get_booking_intake','crm_list_booking_schedules','crm_get_booking_schedule','crm_create_booking_schedule','crm_update_booking_schedule','crm_set_booking_schedule_enabled','crm_preview_booking_availability','crm_update_booking_intake','crm_cancel_booking','crm_duplicate_form','crm_archive_form','crm_restore_form','crm_archive_sms_template','crm_list_sms_presets','crm_get_sms_preset','crm_save_sms_preset','crm_pause_conversation_ai','crm_resume_conversation_ai','crm_reassign_conversation_message','crm_retry_handoff_alert','crm_get_activity_report','crm_list_activity_tags','crm_get_enquiry_attribution_context','crm_create_activity_tag','crm_update_activity_tag','crm_set_enquiry_tag','crm_link_enquiry_booking','crm_link_enquiry_response','crm_link_enquiry_activity','crm_list_contacts','crm_get_contact','crm_get_contact_consent','crm_create_contact','crm_update_contact','crm_record_contact_sms_opt_in','crm_suppress_contact_sms','crm_set_contact_automation_blocked','crm_preview_contact_sms','crm_send_contact_sms','crm_reply_to_conversation','crm_preview_conversation_reply','crm_mark_conversation_messages_read','crm_list_conversations','crm_get_conversation','crm_assign_lead','crm_set_lead_status','crm_assign_handoff','crm_set_handoff_status','crm_list_leads','crm_get_lead','crm_list_handoffs','crm_get_handoff','crm_get_enquiry_status','crm_list_enquiries','crm_get_enquiry','crm_set_form_collection_enabled','crm_apply_form_draft','crm_preview_form','crm_create_form','crm_save_form_draft','crm_list_forms','crm_get_form','crm_list_sms_runs','crm_get_sms_run','crm_get_sms_run_activity','crm_resume_sms_run','crm_pause_sms_run','crm_stop_sms_run','crm_get_sms_run_start_context','crm_start_sms_automation_run','crm_publish_sms_automation','crm_set_form_followups_enabled','crm_create_sms_automation','crm_save_sms_automation_draft','crm_preview_sms_automation','crm_list_sms_automations','crm_get_sms_automation','crm_search_sms_contacts','crm_list_form_submissions','crm_get_business','crm_save_business_profile_draft','crm_review_business_profile','crm_add_business_service','crm_set_service_visibility')
    and (t is null or (not c.all_businesses and not t=any(c.business_ids)) or not exists(select from public.sms_businesses where tenant_id=t)) then raise exception 'Business access denied' using errcode='42501'; end if;
   if tool='crm_start_sms_automation_run' and p->>'overlapChoice'='stop_selected' and not 'automation_run_pause_stop'=any(c.permissions) then raise exception 'Stopping overlapping runs is not granted' using errcode='42501'; end if;
   if tool='crm_get_conversation' and p->'includeMessages'='true'::jsonb and not 'conversation_messages_read'=any(c.permissions) then raise exception 'Message content is not granted' using errcode='42501'; end if;
   if tool in ('crm_list_knowledge_sources','crm_get_knowledge_source','crm_list_knowledge_versions','crm_get_knowledge_version','crm_get_ai_configuration') then
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
     if tool in ('crm_prepare_knowledge_upload','crm_create_knowledge_source','crm_refresh_knowledge_source','crm_archive_knowledge_source','crm_approve_knowledge_version','crm_save_ai_configuration','crm_set_ai_mode') then
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
  values(c.id,aid,left(tool,100),left(coalesce(data->>'bookingId',data->>'intakeId',data->>'scheduleId',data->>'formId',data->>'presetId',data->>'automationId',data->>'tagId',data->>'runId',data->>'handoffId',data->>'conversationId',data->>'contactId',data->'contact'->>'id',data->'conversation'->>'id',data->'lead'->>'id',data->'handoff'->>'id',data->'enquiry'->>'id',data->'form'->>'id',data->'run'->>'id',data->'automation'->>'id',target),255),request_id,case when error_code is not null then 'denied' when replay then 'replayed' else 'success' end,error_code,
   case when error_code is null then coalesce((data->>'revision')::bigint,(data->'contact'->>'revision')::bigint,(data->'conversation'->>'revision')::bigint,(data->'lead'->>'revision')::bigint,(data->'handoff'->>'revision')::bigint,(data->'enquiryStatus'->'sms'->>'generation')::bigint,(data->'enquiryStatus'->>'submittedFormVersion')::bigint,(data->'enquiry'->>'submittedFormVersion')::bigint,(data->'form'->>'revision')::bigint,(data->'run'->>'generation')::bigint,(data->'source'->>'revision')::bigint,(data->'automation'->>'revision')::bigint,(data->'record'->>'revision')::bigint,(data->'business'->'setup'->>'revision')::bigint) end,
   case when error_code is null then (data->'form'->>'draftRevision')::bigint end,
   case when error_code is null and tool in ('crm_prepare_knowledge_upload','crm_create_knowledge_source','crm_refresh_knowledge_source','crm_archive_knowledge_source','crm_approve_knowledge_version','crm_save_ai_configuration','crm_set_ai_mode','crm_create_booking_schedule','crm_update_booking_schedule','crm_set_booking_schedule_enabled','crm_update_booking_intake','crm_cancel_booking','crm_duplicate_form','crm_archive_form','crm_restore_form','crm_archive_sms_template','crm_save_sms_preset','crm_pause_conversation_ai','crm_resume_conversation_ai','crm_reassign_conversation_message','crm_retry_handoff_alert','crm_create_activity_tag','crm_update_activity_tag','crm_set_enquiry_tag','crm_link_enquiry_booking','crm_link_enquiry_response','crm_link_enquiry_activity','crm_create_contact','crm_update_contact','crm_record_contact_sms_opt_in','crm_suppress_contact_sms','crm_set_contact_automation_blocked','crm_send_contact_sms','crm_reply_to_conversation','crm_mark_conversation_messages_read','crm_assign_lead','crm_set_lead_status','crm_assign_handoff','crm_set_handoff_status') then (data->>'previousRevision')::bigint end,
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
