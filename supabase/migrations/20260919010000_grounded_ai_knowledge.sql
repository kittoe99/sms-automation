-- Tenant-owned, approved business knowledge and grounded SMS AI.
-- New behavior is feature gated; applying this migration does not enable AI or sending.

create extension if not exists vector with schema extensions;

alter table public.sms_ai_settings
  add column grounded_enabled boolean not null default false,
  add column shadow_mode boolean not null default true,
  add column alert_phone text,
  add constraint sms_ai_alert_phone_e164 check(alert_phone is null or alert_phone ~ '^\+[1-9][0-9]{7,14}$');

create table public.sms_business_profile_versions (
  tenant_id text not null references public.sms_businesses on delete cascade,
  id uuid not null default gen_random_uuid(),
  version integer not null,
  facts jsonb not null,
  status text not null default 'draft' check(status in ('draft','approved','superseded','archived')),
  content_hash text not null,
  created_by text not null,
  approved_by text,
  approved_at timestamptz,
  created_at timestamptz not null default now(),
  primary key(tenant_id,id),
  unique(tenant_id,version),
  unique(tenant_id,content_hash),
  check(jsonb_typeof(facts)='object'),
  check((status in ('approved','superseded') and approved_at is not null)
    or (status not in ('approved','superseded') and approved_at is null))
);

alter table public.sms_businesses add column active_profile_version_id uuid;
alter table public.sms_businesses add constraint sms_businesses_active_profile_fk
  foreign key(tenant_id,active_profile_version_id)
  references public.sms_business_profile_versions(tenant_id,id);

create table public.sms_knowledge_sources (
  tenant_id text not null references public.sms_businesses on delete cascade,
  id uuid not null default gen_random_uuid(),
  type text not null check(type in ('structured','website','file','manual')),
  title text not null check(length(title) between 1 and 200),
  origin text,
  storage_path text,
  status text not null default 'draft' check(status in ('draft','indexing','ready','failed','archived')),
  refresh_interval interval,
  next_refresh_at timestamptz,
  active_version_id uuid,
  created_by text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key(tenant_id,id),
  unique(tenant_id,origin),
  check(type<>'website' or origin ~ '^https://'),
  check(type<>'file' or storage_path like tenant_id||'/%')
);

create table public.sms_knowledge_source_versions (
  tenant_id text not null,
  id uuid not null default gen_random_uuid(),
  source_id uuid not null,
  version integer not null,
  status text not null default 'draft' check(status in ('draft','processing','ready','approved','failed','superseded','archived')),
  extracted_text text not null default '',
  content_hash text,
  extraction_meta jsonb not null default '{}',
  failure_code text,
  created_by text not null,
  approved_by text,
  approved_at timestamptz,
  created_at timestamptz not null default now(),
  primary key(tenant_id,id),
  unique(tenant_id,source_id,version),
  foreign key(tenant_id,source_id) references public.sms_knowledge_sources(tenant_id,id) on delete cascade,
  check(jsonb_typeof(extraction_meta)='object')
);

alter table public.sms_knowledge_sources add constraint sms_knowledge_source_active_version_fk
  foreign key(tenant_id,active_version_id)
  references public.sms_knowledge_source_versions(tenant_id,id);

create table public.sms_knowledge_chunks (
  tenant_id text not null,
  id uuid not null default gen_random_uuid(),
  source_id uuid not null,
  source_version_id uuid not null,
  chunk_index integer not null check(chunk_index>=0),
  precedence smallint not null default 30 check(precedence between 1 and 100),
  content text not null check(length(content) between 1 and 8000),
  content_hash text not null,
  metadata jsonb not null default '{}',
  embedding_model text,
  embedded_at timestamptz,
  fts tsvector generated always as (to_tsvector('english',content)) stored,
  created_at timestamptz not null default now(),
  primary key(tenant_id,id),
  unique(tenant_id,source_version_id,chunk_index),
  foreign key(tenant_id,source_id) references public.sms_knowledge_sources(tenant_id,id) on delete cascade,
  foreign key(tenant_id,source_version_id) references public.sms_knowledge_source_versions(tenant_id,id) on delete cascade,
  check(jsonb_typeof(metadata)='object')
);

-- PGLITE_VECTOR_BEGIN (the SQL test harness replaces this block with a real[] column)
alter table public.sms_knowledge_chunks add column embedding extensions.vector(1536);
create index sms_knowledge_chunks_embedding_hnsw on public.sms_knowledge_chunks
  using hnsw (embedding vector_cosine_ops) where embedding is not null;
-- PGLITE_VECTOR_END
create index sms_knowledge_chunks_fts on public.sms_knowledge_chunks using gin(fts);
create index sms_knowledge_chunks_active_lookup on public.sms_knowledge_chunks(tenant_id,source_id,source_version_id,precedence);

create table public.sms_leads (
  tenant_id text not null,
  id uuid not null default gen_random_uuid(),
  contact_id uuid not null,
  status text not null default 'open' check(status in ('open','assigned','resolved','closed')),
  owner text,
  fields jsonb not null default '{}',
  summary text not null default '',
  priority text not null default 'normal' check(priority in ('low','normal','high','urgent')),
  source_message_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key(tenant_id,id),
  foreign key(tenant_id,contact_id) references public.sms_contacts(tenant_id,id),
  foreign key(tenant_id,source_message_id) references public.sms_messages(tenant_id,id),
  check(jsonb_typeof(fields)='object')
);
create unique index sms_one_open_lead_per_contact on public.sms_leads(tenant_id,contact_id)
  where status in ('open','assigned');

create table public.sms_handoffs (
  tenant_id text not null,
  id uuid not null default gen_random_uuid(),
  lead_id uuid,
  contact_id uuid not null,
  ai_job_id uuid not null,
  reason text not null check(length(reason) between 1 and 1000),
  status text not null default 'open' check(status in ('open','assigned','resolved','closed')),
  owner text,
  priority text not null default 'normal' check(priority in ('low','normal','high','urgent')),
  alert_status text not null default 'not_configured' check(alert_status in ('not_configured','queued','sent','failed')),
  alert_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key(tenant_id,id),
  unique(tenant_id,ai_job_id),
  foreign key(tenant_id,lead_id) references public.sms_leads(tenant_id,id),
  foreign key(tenant_id,contact_id) references public.sms_contacts(tenant_id,id),
  foreign key(ai_job_id) references sms_private.jobs(id)
);

create table public.sms_ai_runs (
  tenant_id text not null references public.sms_businesses on delete cascade,
  id uuid not null default gen_random_uuid(),
  job_id uuid not null references sms_private.jobs(id),
  contact_phone text not null,
  mode text not null check(mode in ('shadow','live')),
  disposition text not null check(disposition in ('answered','collect_lead','handoff')),
  grounded boolean not null,
  citation_ids uuid[] not null default '{}',
  profile_version_id uuid,
  model text not null,
  prompt_version text not null,
  input_tokens integer,
  output_tokens integer,
  estimated_cost_micros bigint check(estimated_cost_micros is null or estimated_cost_micros>=0),
  latency_ms integer,
  validation_error text,
  result jsonb not null default '{}',
  created_at timestamptz not null default now(),
  primary key(tenant_id,id),
  unique(tenant_id,job_id),
  foreign key(tenant_id,profile_version_id) references public.sms_business_profile_versions(tenant_id,id),
  check(jsonb_typeof(result)='object')
);
create unique index sms_one_open_handoff_per_contact on public.sms_handoffs(tenant_id,contact_id) where status in ('open','assigned');

create table public.sms_twilio_registrations (
  tenant_id text primary key references public.sms_businesses on delete cascade,
  sender_type text not null check(sender_type in ('local_a2p','toll_free')),
  country text not null default 'US' check(country in ('US','CA')),
  state text not null default 'draft' check(state in (
    'draft','profile_pending','brand_pending','campaign_pending','number_pending','verification_pending',
    'in_review','approved','sender_attached','webhook_verified','canary_pending','ready','rejected','submission_unknown','paused'
  )),
  customer_profile_sid text,
  brand_registration_sid text,
  campaign_sid text,
  verification_sid text,
  bundle_sid text,
  brand_inquiry_id text,
  campaign_inquiry_id text,
  phone_number_sid text,
  messaging_service_sid text,
  canary_phone text,
  canary_message_id uuid,
  canary_message_sid text,
  rejection_code text,
  rejection_reason text,
  paid_action_confirmed_at timestamptz,
  paid_action_confirmed_by text,
  last_checked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check(customer_profile_sid is null or customer_profile_sid ~ '^BU[0-9A-Fa-f]{32}$'),
  check(brand_registration_sid is null or brand_registration_sid ~ '^BN[0-9A-Fa-f]{32}$'),
  check(phone_number_sid is null or phone_number_sid ~ '^PN[0-9A-Fa-f]{32}$'),
  check(messaging_service_sid is null or messaging_service_sid ~ '^MG[0-9A-Fa-f]{32}$'),
  check(canary_phone is null or canary_phone ~ '^\+[1-9][0-9]{7,14}$'),
  check(canary_message_sid is null or canary_message_sid ~ '^SM[0-9A-Fa-f]{32}$')
);
alter table public.sms_twilio_registrations add constraint sms_twilio_canary_message_fk foreign key(tenant_id,canary_message_id) references public.sms_messages(tenant_id,id);

create table sms_private.remote_operations (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null references public.sms_businesses on delete cascade,
  provider text not null check(provider='twilio'),
  operation text not null,
  idempotency_key text not null,
  state text not null default 'pending' check(state in ('pending','submitting','completed','failed','submission_unknown','reconciled')),
  request jsonb not null default '{}',
  provider_resource_sid text,
  error_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(tenant_id,provider,idempotency_key),
  check(jsonb_typeof(request)='object')
);

-- Add bounded queues. Knowledge runs under sms_ai; compliance runs under sms_automation.
alter table sms_private.jobs drop constraint jobs_queue_check;
alter table sms_private.jobs add constraint jobs_queue_check check(queue in (
  'sms_send_jobs','automation_jobs','ai_reply_jobs','provisioning_jobs','knowledge_ingest_jobs','embedding_jobs','handoff_alert_jobs','compliance_jobs'
));
alter table sms_private.edge_config drop constraint edge_config_queue_check;
alter table sms_private.edge_config drop constraint edge_config_function_name_check;
alter table sms_private.edge_config add constraint edge_config_queue_check check(queue in (
  'sms_send_jobs','automation_jobs','ai_reply_jobs','provisioning_jobs','knowledge_ingest_jobs','embedding_jobs','handoff_alert_jobs','compliance_jobs'
));
alter table sms_private.edge_config add constraint edge_config_function_name_check check(function_name in (
  'sms-worker','automation-worker','ai-worker','provisioning-worker','knowledge-worker','embedding-worker','handoff-worker','compliance-worker'
));
select pgmq.create('knowledge_ingest_jobs');
select pgmq.create('embedding_jobs');
select pgmq.create('handoff_alert_jobs');
select pgmq.create('compliance_jobs');
insert into sms_private.edge_config(queue,function_name,max_concurrency) values
 ('knowledge_ingest_jobs','knowledge-worker',2),('embedding_jobs','embedding-worker',2),
 ('handoff_alert_jobs','handoff-worker',2),('compliance_jobs','compliance-worker',1);

create or replace function sms_private.worker_access(q text) returns void language plpgsql security definer set search_path='' as $$
#variable_conflict use_column
declare r text; begin
 r:=case
   when q in ('sms_send_jobs','handoff_alert_jobs') then 'sms_sender'
   when q in ('ai_reply_jobs','knowledge_ingest_jobs','embedding_jobs') then 'sms_ai'
   when q in ('automation_jobs','provisioning_jobs','compliance_jobs') then 'sms_automation'
 end;
 if r is null or not pg_has_role(session_user,r,'member') then raise exception 'Worker role denied' using errcode='42501'; end if;
end $$;

create function sms_private.validate_business_facts(input jsonb) returns jsonb
language plpgsql immutable set search_path='' as $$
declare services jsonb; locations jsonb; faqs jsonb; pricing jsonb; policies jsonb; result jsonb;
begin
 if coalesce(jsonb_typeof(input),'null')<>'object' then raise exception 'Business facts must be an object'; end if;
 if length(trim(coalesce(input->>'businessName',''))) not between 1 and 120 then raise exception 'Business name is required'; end if;
 if coalesce(input->>'websiteUrl','')<>'' and coalesce(input->>'websiteUrl','') !~* '^https://[^[:space:]]+$' then raise exception 'Website must start with https://'; end if;
 if coalesce(input->>'contactEmail','')<>'' and input->>'contactEmail' !~* '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then raise exception 'Enter a valid contact email'; end if;
 if trim(coalesce(input->>'summary',''))<>'' and length(trim(input->>'summary')) not between 20 and 2000 then raise exception 'Summary must be 20-2000 characters'; end if;
 if length(trim(coalesce(input->>'hours','')))>200 or length(trim(coalesce(input->>'contactPhone','')))>32 or length(trim(coalesce(input->>'handoff','')))>1000 or length(trim(coalesce(input->>'bookingRules','')))>2000 then raise exception 'A business fact exceeds its allowed length'; end if;
 if coalesce(input->>'tone','')<>'' and input->>'tone' not in ('friendly','professional','casual') then raise exception 'Choose a brand voice'; end if;
 services:=coalesce(input->'services','[]'); locations:=coalesce(input->'locations','[]'); faqs:=coalesce(input->'faqs','[]');
 pricing:=coalesce(input->'pricing','[]'); policies:=coalesce(input->'policies','[]');
 if jsonb_typeof(services)<>'array' or jsonb_array_length(services) not between 1 and 30
   or exists(select from jsonb_array_elements_text(services) s where length(trim(s)) not between 1 and 160) then raise exception 'Add 1-30 services, with no more than 160 characters per service'; end if;
 if jsonb_typeof(locations)<>'array' or jsonb_array_length(locations) not between 1 and 20
   or exists(select from jsonb_array_elements_text(locations) s where length(trim(s)) not between 1 and 160) then raise exception 'Add 1-20 service areas, with no more than 160 characters per area'; end if;
 if jsonb_typeof(faqs)<>'array' or jsonb_array_length(faqs)>20
   or exists(select from jsonb_array_elements_text(faqs) s where length(trim(s)) not between 1 and 300) then raise exception 'Add up to 20 FAQs, with no more than 300 characters each'; end if;
 if jsonb_typeof(pricing)<>'array' or jsonb_array_length(pricing)>200 then raise exception 'Pricing must be a list of at most 200 items'; end if;
 if jsonb_typeof(policies)<>'array' or jsonb_array_length(policies)>100 then raise exception 'Policies must be a list of at most 100 items'; end if;
 result:=input || jsonb_build_object(
   'businessName',trim(input->>'businessName'),'summary',trim(input->>'summary'),'websiteUrl',trim(input->>'websiteUrl'),'hours',trim(input->>'hours'),'contactPhone',trim(input->>'contactPhone'),'contactEmail',lower(trim(input->>'contactEmail')),'bookingRules',trim(input->>'bookingRules'),'handoff',trim(input->>'handoff'),
   'services',(select coalesce(jsonb_agg(trim(s)),'[]') from jsonb_array_elements_text(services) s),
   'locations',(select coalesce(jsonb_agg(trim(s)),'[]') from jsonb_array_elements_text(locations) s),
   'faqs',(select coalesce(jsonb_agg(trim(s)),'[]') from jsonb_array_elements_text(faqs) s where trim(s)<>''),
   'pricing',pricing,'policies',policies,'updatedAt',now());
 return result;
end $$;

create function sms_private.save_profile_version(u text,t text,input jsonb,approve boolean default false) returns jsonb
language plpgsql security definer set search_path='' as $$
#variable_conflict use_column
declare facts jsonb; v integer; row public.sms_business_profile_versions; hash text;
begin
 perform sms_private.require_admin(u);
 if not exists(select from public.sms_businesses where tenant_id=t) then raise exception 'Unknown business'; end if;
 facts:=sms_private.validate_business_facts(input); hash:=md5(facts::text);
 select * into row from public.sms_business_profile_versions where tenant_id=t and content_hash=hash;
 if found then return to_jsonb(row); end if;
 if approve then facts:=facts||jsonb_build_object('completedAt',now()); end if;
 select coalesce(max(version),0)+1 into v from public.sms_business_profile_versions where tenant_id=t;
 insert into public.sms_business_profile_versions(tenant_id,version,facts,status,content_hash,created_by,approved_by,approved_at)
 values(t,v,facts,case when approve then 'approved' else 'draft' end,hash,u,case when approve then u end,case when approve then now() end) returning * into row;
 if approve then
   update public.sms_business_profile_versions set status='superseded' where tenant_id=t and id<>row.id and status='approved';
   update public.sms_businesses set active_profile_version_id=row.id,profile=coalesce(profile,'{}')||jsonb_build_object('onboarding',facts) where tenant_id=t;
 end if;
 insert into sms_private.audit(tenant_id,actor,action,detail) values(t,u,case when approve then 'business_profile_approved' else 'business_profile_drafted' end,jsonb_build_object('versionId',row.id,'version',row.version));
 return to_jsonb(row);
end $$;

create function sms_private.approve_profile_version(u text,t text,vid uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
#variable_conflict use_column
declare row public.sms_business_profile_versions;
begin
 perform sms_private.require_admin(u);
 select * into strict row from public.sms_business_profile_versions where tenant_id=t and id=vid and status='draft' for update;
 update public.sms_business_profile_versions set status='superseded' where tenant_id=t and status='approved';
 update public.sms_business_profile_versions set status='approved',approved_by=u,approved_at=now() where tenant_id=t and id=vid returning * into row;
 update public.sms_businesses set active_profile_version_id=vid,profile=coalesce(profile,'{}')||jsonb_build_object('onboarding',row.facts) where tenant_id=t;
 insert into sms_private.audit(tenant_id,actor,action,detail) values(t,u,'business_profile_approved',jsonb_build_object('versionId',vid));
 return to_jsonb(row);
end $$;

create function sms_private.knowledge_overview(u text,t text) returns jsonb
language plpgsql security definer set search_path='' as $$
begin
 if not sms_private.can_access(t,u) then raise exception 'Tenant access denied' using errcode='42501'; end if;
 return jsonb_build_object(
  'profile',(select to_jsonb(v) from public.sms_business_profile_versions v join public.sms_businesses b on b.tenant_id=v.tenant_id and b.active_profile_version_id=v.id where v.tenant_id=t),
  'profileVersions',(select coalesce(jsonb_agg(v order by v.version desc),'[]') from public.sms_business_profile_versions v where v.tenant_id=t),
  'sources',(select coalesce(jsonb_agg(s order by s.updated_at desc),'[]') from public.sms_knowledge_sources s where s.tenant_id=t),
  'sourceVersions',(select coalesce(jsonb_agg(v order by v.created_at desc),'[]') from public.sms_knowledge_source_versions v where v.tenant_id=t),
  'leads',(select coalesce(jsonb_agg(l order by l.updated_at desc),'[]') from (select * from public.sms_leads where tenant_id=t order by updated_at desc limit 100) l),
  'handoffs',(select coalesce(jsonb_agg(h order by h.created_at desc),'[]') from (select * from public.sms_handoffs where tenant_id=t order by created_at desc limit 100) h));
end $$;

create function sms_private.create_knowledge_source(u text,t text,input jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
#variable_conflict use_column
declare row public.sms_knowledge_sources; typ text; origin text; path text;
begin
 perform sms_private.require_admin(u); typ:=input->>'type'; origin:=nullif(trim(input->>'origin'),''); path:=nullif(trim(input->>'storagePath'),'');
 if typ not in ('website','file','manual') then raise exception 'Unsupported knowledge source type'; end if;
 if typ='website' and (origin is null or origin !~* '^https://[^[:space:]]+$') then raise exception 'A public HTTPS URL is required'; end if;
 if typ='file' and (path is null or path not like t||'/%') then raise exception 'Invalid tenant storage path'; end if;
 insert into public.sms_knowledge_sources(tenant_id,type,title,origin,storage_path,status,refresh_interval,next_refresh_at,created_by)
 values(t,typ,left(trim(input->>'title'),200),origin,path,'indexing',case when typ='website' then interval '7 days' end,case when typ='website' then now()+interval '7 days' end,u)
 on conflict(tenant_id,origin) do update set title=excluded.title,status='indexing',updated_at=now() returning * into row;
 perform sms_private.enqueue(t,'knowledge_ingest_jobs','source:'||row.id||':'||extract(epoch from row.updated_at)::bigint,
   jsonb_build_object('source_id',row.id,'actor',u));
 return to_jsonb(row);
end $$;

create function sms_private.queue_knowledge_refresh(u text,t text,sid uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
#variable_conflict use_column
declare row public.sms_knowledge_sources; jid uuid;
begin
 perform sms_private.require_admin(u);
 update public.sms_knowledge_sources set status='indexing',updated_at=now() where tenant_id=t and id=sid and status<>'archived' returning * into strict row;
 jid:=sms_private.enqueue(t,'knowledge_ingest_jobs','refresh:'||sid||':'||extract(epoch from row.updated_at)::bigint,jsonb_build_object('source_id',sid,'actor',u));
 return jsonb_build_object('source',to_jsonb(row),'jobId',jid);
end $$;

create function sms_private.archive_knowledge_source(u text,t text,sid uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
#variable_conflict use_column
declare row public.sms_knowledge_sources;
begin
 perform sms_private.require_admin(u);
 update public.sms_knowledge_sources
 set status='archived',active_version_id=null,next_refresh_at=null,updated_at=now()
 where tenant_id=t and id=sid and status<>'archived' returning * into strict row;
 update public.sms_knowledge_source_versions set status='archived'
 where tenant_id=t and source_id=sid and status in ('draft','processing','ready','approved','superseded');
 insert into sms_private.audit(tenant_id,actor,action,detail)
 values(t,u,'knowledge_source_archived',jsonb_build_object('sourceId',sid));
 return to_jsonb(row);
end $$;

create function sms_private.approve_knowledge_version(u text,t text,vid uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
#variable_conflict use_column
declare row public.sms_knowledge_source_versions;
begin
 perform sms_private.require_admin(u);
 select * into strict row from public.sms_knowledge_source_versions where tenant_id=t and id=vid and status='ready' for update;
 if exists(select from public.sms_knowledge_chunks where tenant_id=t and source_version_id=vid and embedding is null) then raise exception 'Knowledge is still indexing'; end if;
 update public.sms_knowledge_source_versions set status='superseded' where tenant_id=t and source_id=row.source_id and status='approved';
 update public.sms_knowledge_source_versions set status='approved',approved_by=u,approved_at=now() where tenant_id=t and id=vid returning * into row;
 update public.sms_knowledge_sources set active_version_id=vid,status='ready',updated_at=now() where tenant_id=t and id=row.source_id;
 insert into sms_private.audit(tenant_id,actor,action,detail) values(t,u,'knowledge_version_approved',jsonb_build_object('sourceId',row.source_id,'versionId',vid));
 return to_jsonb(row);
end $$;

create function sms_private.knowledge_job_context(jid uuid,token uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
#variable_conflict use_column
declare j sms_private.jobs; sid uuid;
begin
 j:=sms_private.lease(jid,token); if j.queue not in ('knowledge_ingest_jobs','embedding_jobs') then raise exception 'Wrong queue'; end if;
 sid:=(j.payload->>'source_id')::uuid;
 return jsonb_build_object('source',(select to_jsonb(s) from public.sms_knowledge_sources s where s.tenant_id=j.tenant_id and s.id=sid),
  'version',(select to_jsonb(v) from public.sms_knowledge_source_versions v where v.tenant_id=j.tenant_id and v.id=(j.payload->>'source_version_id')::uuid),
  'chunks',(select coalesce(jsonb_agg(c order by c.chunk_index),'[]') from public.sms_knowledge_chunks c where c.tenant_id=j.tenant_id and c.source_version_id=(j.payload->>'source_version_id')::uuid));
end $$;

create function sms_private.complete_knowledge_ingest(jid uuid,token uuid,p jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
#variable_conflict use_column
declare j sms_private.jobs; sid uuid; vid uuid; v integer; c jsonb; idx integer:=0; hash text;
begin
 j:=sms_private.lease(jid,token); if j.queue<>'knowledge_ingest_jobs' then raise exception 'Wrong queue'; end if; sid:=(j.payload->>'source_id')::uuid;
 hash:=p->>'content_hash';
 if exists(select from public.sms_knowledge_source_versions where tenant_id=j.tenant_id and source_id=sid and content_hash=hash) then
  update public.sms_knowledge_sources set status='ready',updated_at=now(),next_refresh_at=case when type='website' then now()+interval '7 days' end where tenant_id=j.tenant_id and id=sid;
  perform sms_private.finish(jid,token,'completed'); return jsonb_build_object('unchanged',true);
 end if;
 select coalesce(max(version),0)+1 into v from public.sms_knowledge_source_versions where tenant_id=j.tenant_id and source_id=sid;
 insert into public.sms_knowledge_source_versions(tenant_id,source_id,version,status,extracted_text,content_hash,extraction_meta,created_by)
 values(j.tenant_id,sid,v,'processing',p->>'text',hash,coalesce(p->'meta','{}'),coalesce(j.payload->>'actor','worker')) returning id into vid;
 for c in select * from jsonb_array_elements(p->'chunks') loop
  insert into public.sms_knowledge_chunks(tenant_id,source_id,source_version_id,chunk_index,precedence,content,content_hash,metadata)
  values(j.tenant_id,sid,vid,idx,coalesce((c->>'precedence')::smallint,30),c->>'content',md5(c->>'content'),coalesce(c->'metadata','{}'));
  idx:=idx+1;
 end loop;
 update public.sms_knowledge_sources set status='indexing',updated_at=now(),next_refresh_at=case when type='website' then now()+interval '7 days' end where tenant_id=j.tenant_id and id=sid;
 perform sms_private.enqueue(j.tenant_id,'embedding_jobs','version:'||vid,jsonb_build_object('source_id',sid,'source_version_id',vid));
 perform sms_private.finish(jid,token,'completed'); return jsonb_build_object('sourceVersionId',vid,'chunks',idx);
end $$;

create function sms_private.complete_embeddings(jid uuid,token uuid,p jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
#variable_conflict use_column
declare j sms_private.jobs; item jsonb; vid uuid; remaining integer; embedded integer;
begin
 j:=sms_private.lease(jid,token); if j.queue<>'embedding_jobs' then raise exception 'Wrong queue'; end if; vid:=(j.payload->>'source_version_id')::uuid;
 for item in select * from jsonb_array_elements(p->'items') loop
  execute 'update public.sms_knowledge_chunks set embedding=$1::extensions.vector,embedding_model=$2,embedded_at=now() where tenant_id=$3 and id=$4'
    using item->>'embedding',p->>'model',j.tenant_id,(item->>'id')::uuid;
 end loop;
 select count(*) filter(where embedding is null),count(*) filter(where embedding is not null) into remaining,embedded from public.sms_knowledge_chunks where tenant_id=j.tenant_id and source_version_id=vid;
 if remaining=0 then
  update public.sms_knowledge_source_versions set status='ready' where tenant_id=j.tenant_id and id=vid;
  update public.sms_knowledge_sources set status='ready',updated_at=now() where tenant_id=j.tenant_id and id=(j.payload->>'source_id')::uuid;
 else
  perform sms_private.enqueue(j.tenant_id,'embedding_jobs','version:'||vid||':'||embedded,jsonb_build_object('source_id',j.payload->>'source_id','source_version_id',vid));
 end if;
 perform sms_private.finish(jid,token,'completed'); return jsonb_build_object('sourceVersionId',vid,'embedded',jsonb_array_length(p->'items'));
end $$;

create function sms_private.fail_knowledge_job(jid uuid,token uuid,code text) returns void
language plpgsql security definer set search_path='' as $$
#variable_conflict use_column
declare j sms_private.jobs;begin
 j:=sms_private.lease(jid,token);if j.queue not in ('knowledge_ingest_jobs','embedding_jobs') then raise exception 'Wrong queue';end if;
 update public.sms_knowledge_sources set status='failed',updated_at=now() where tenant_id=j.tenant_id and id=(j.payload->>'source_id')::uuid;
 if j.payload ? 'source_version_id' then update public.sms_knowledge_source_versions set status='failed',failure_code=left(code,200) where tenant_id=j.tenant_id and id=(j.payload->>'source_version_id')::uuid;end if;
end $$;

create function sms_private.search_job_knowledge(jid uuid,token uuid,query text,query_embedding text,match_count integer default 8) returns jsonb
language plpgsql security definer set search_path='' as $$
#variable_conflict use_column
declare j sms_private.jobs; result jsonb;
begin
 j:=sms_private.lease(jid,token); if j.queue<>'ai_reply_jobs' then raise exception 'Wrong queue'; end if;
 match_count:=least(greatest(coalesce(match_count,8),1),20);
 if nullif(query_embedding,'') is null then
  select coalesce(jsonb_agg(x),'[]') into result from (
   select c.id,c.content,c.metadata,c.precedence,s.title,s.origin,ts_rank_cd(c.fts,websearch_to_tsquery('english',query)) score
   from public.sms_knowledge_chunks c join public.sms_knowledge_sources s on s.tenant_id=c.tenant_id and s.id=c.source_id and s.active_version_id=c.source_version_id
   join public.sms_knowledge_source_versions v on v.tenant_id=c.tenant_id and v.id=c.source_version_id and v.status='approved'
   where c.tenant_id=j.tenant_id and s.status='ready' and c.fts @@ websearch_to_tsquery('english',query)
   order by c.precedence,score desc limit match_count) x;
 else
  execute $q$with keyword as (
    select c.id,row_number() over(order by ts_rank_cd(c.fts,websearch_to_tsquery('english',$2)) desc) r
    from public.sms_knowledge_chunks c join public.sms_knowledge_sources s on s.tenant_id=c.tenant_id and s.id=c.source_id and s.active_version_id=c.source_version_id
    join public.sms_knowledge_source_versions v on v.tenant_id=c.tenant_id and v.id=c.source_version_id and v.status='approved'
    where c.tenant_id=$1 and s.status='ready' and c.fts @@ websearch_to_tsquery('english',$2) limit 30), semantic as (
    select c.id,row_number() over(order by c.embedding <=> $3::extensions.vector) r
    from public.sms_knowledge_chunks c join public.sms_knowledge_sources s on s.tenant_id=c.tenant_id and s.id=c.source_id and s.active_version_id=c.source_version_id
    join public.sms_knowledge_source_versions v on v.tenant_id=c.tenant_id and v.id=c.source_version_id and v.status='approved'
    where c.tenant_id=$1 and s.status='ready' and c.embedding is not null order by c.embedding <=> $3::extensions.vector limit 30), ranked as (
    select coalesce(k.id,s.id) id,coalesce(1.0/(50+k.r),0)+coalesce(1.0/(50+s.r),0) score from keyword k full join semantic s using(id))
    select coalesce(jsonb_agg(x),'[]') from (select c.id,c.content,c.metadata,c.precedence,src.title,src.origin,r.score
    from ranked r join public.sms_knowledge_chunks c on c.tenant_id=$1 and c.id=r.id join public.sms_knowledge_sources src on src.tenant_id=c.tenant_id and src.id=c.source_id
    order by c.precedence,r.score desc limit $4) x$q$ into result using j.tenant_id,query,query_embedding,match_count;
 end if;
 return result;
end $$;

create or replace function sms_private.job_context(jid uuid,token uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
#variable_conflict use_column
declare j sms_private.jobs; e public.sms_automation_enrollments; c public.sms_contacts; ph text;
begin
 j:=sms_private.lease(jid,token);
 if j.queue='automation_jobs' then
   select * into e from public.sms_automation_enrollments where tenant_id=j.tenant_id and id=(j.payload->>'enrollment_id')::uuid;
   select * into c from public.sms_contacts where tenant_id=j.tenant_id and id=e.contact_id;
   return jsonb_build_object('enrollment',to_jsonb(e),'contact',to_jsonb(c),'business',(select to_jsonb(b) from public.sms_businesses b where tenant_id=j.tenant_id),
     'group',(select to_jsonb(g) from public.sms_automation_groups g where tenant_id=j.tenant_id and id=e.category_id),
     'steps',(select jsonb_agg(s order by step_index) from public.sms_automation_steps s where tenant_id=j.tenant_id and group_id=e.category_id));
 elsif j.queue='ai_reply_jobs' then
   ph:=j.payload->>'phone';
   return jsonb_build_object('business',(select to_jsonb(b) from public.sms_businesses b where tenant_id=j.tenant_id),
     'profile',(select to_jsonb(v) from public.sms_business_profile_versions v join public.sms_businesses b on b.tenant_id=v.tenant_id and b.active_profile_version_id=v.id where v.tenant_id=j.tenant_id and v.status='approved'),
     'contact',(select to_jsonb(c) from public.sms_contacts c where tenant_id=j.tenant_id and phone=ph),
     'thread',(select to_jsonb(th) from public.sms_thread_contacts th where tenant_id=j.tenant_id and phone=ph),
     'settings',(select to_jsonb(a) from public.sms_ai_settings a where tenant_id=j.tenant_id and group_id=j.payload->>'group_id'),
     'open_lead',(select to_jsonb(l) from public.sms_leads l join public.sms_contacts c on c.tenant_id=l.tenant_id and c.id=l.contact_id where l.tenant_id=j.tenant_id and c.phone=ph and l.status in ('open','assigned') order by l.updated_at desc limit 1),
     'history',(select coalesce(jsonb_agg(m order by created_at),'[]') from (select id,direction,body,created_at from public.sms_messages where tenant_id=j.tenant_id and contact_phone=ph order by created_at desc limit 20)m));
 elsif j.queue='provisioning_jobs' then
   return (select jsonb_build_object('account_sid',p.account_sid,'messaging_service_sid',p.messaging_service_sid,'phone_number_sid',p.phone_number_sid,'state',p.provisioning_state,'business_name',b.name)
     from sms_private.providers p join public.sms_businesses b using(tenant_id) where p.tenant_id=j.tenant_id);
 end if;
 raise exception 'Unsupported context';
end $$;

create function sms_private.complete_grounded_ai(jid uuid,token uuid,p jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
#variable_conflict use_column
declare j sms_private.jobs; cid uuid; mid uuid; lead public.sms_leads; handoff_id uuid; result jsonb; alert text; disposition text;
begin
 j:=sms_private.lease(jid,token); if j.queue<>'ai_reply_jobs' then raise exception 'Wrong queue'; end if;
 if not exists(select from public.sms_thread_contacts th join public.sms_contacts c using(tenant_id,phone)
   where th.tenant_id=j.tenant_id and th.phone=j.payload->>'phone' and th.generation=(j.payload->>'generation')::bigint and not th.ai_paused and not c.opted_out)
   or not exists(select from public.sms_ai_settings where tenant_id=j.tenant_id and group_id=j.payload->>'group_id' and enabled) then
   perform sms_private.finish(jid,token,'cancelled','STALE_REPLY'); return null;
 end if;
 select id into strict cid from public.sms_contacts where tenant_id=j.tenant_id and phone=j.payload->>'phone' for update;
 disposition:=p->>'disposition';
 if disposition not in ('answered','collect_lead','handoff') then raise exception 'Invalid AI disposition'; end if;
 if length(trim(coalesce(p->>'reply',''))) not between 1 and 600 then raise exception 'AI reply must be between 1 and 600 characters'; end if;
 if disposition='answered' and coalesce((p->>'grounded')::boolean,false) is not true then raise exception 'Direct answers must be grounded'; end if;
 if disposition='answered' and nullif(p->>'profileVersionId','') is null and jsonb_array_length(coalesce(p->'citationIds','[]'))=0 then raise exception 'Direct answers require approved evidence'; end if;
 if exists(select from jsonb_array_elements_text(coalesce(p->'citationIds','[]')) x where not exists(
   select from public.sms_knowledge_chunks c join public.sms_knowledge_sources s on s.tenant_id=c.tenant_id and s.id=c.source_id and s.active_version_id=c.source_version_id
   join public.sms_knowledge_source_versions v on v.tenant_id=c.tenant_id and v.id=c.source_version_id and v.status='approved'
   where c.tenant_id=j.tenant_id and c.id=x::uuid)) then raise exception 'AI cited unapproved evidence'; end if;
 if nullif(p->>'profileVersionId','') is not null and not exists(select from public.sms_businesses where tenant_id=j.tenant_id and active_profile_version_id=(p->>'profileVersionId')::uuid) then raise exception 'AI used an inactive profile'; end if;
 insert into public.sms_ai_runs(tenant_id,job_id,contact_phone,mode,disposition,grounded,citation_ids,profile_version_id,model,prompt_version,input_tokens,output_tokens,estimated_cost_micros,latency_ms,validation_error,result)
 values(j.tenant_id,j.id,j.payload->>'phone',coalesce(p->>'mode','live'),disposition,coalesce((p->>'grounded')::boolean,false),
   coalesce((select array_agg(x::uuid) from jsonb_array_elements_text(coalesce(p->'citationIds','[]')) x),'{}'),nullif(p->>'profileVersionId','')::uuid,
   p->>'model',coalesce(p->>'promptVersion','grounded-v1'),(p->>'inputTokens')::integer,(p->>'outputTokens')::integer,(p->>'estimatedCostMicros')::bigint,(p->>'latencyMs')::integer,p->>'validationError',p);
 if coalesce((p->>'mode'),'live')='shadow' then perform sms_private.finish(jid,token,'completed');return jsonb_build_object('shadow',true);end if;
 if disposition in ('collect_lead','handoff') then
   perform pg_advisory_xact_lock(hashtextextended(j.tenant_id||':'||cid::text,713));
   select * into lead from public.sms_leads where tenant_id=j.tenant_id and contact_id=cid and status in ('open','assigned') for update;
   if found then
     update public.sms_leads set fields=fields||coalesce(p->'lead','{}'),summary=coalesce(nullif(p->>'leadSummary',''),summary),updated_at=now() where tenant_id=j.tenant_id and id=lead.id returning * into lead;
   else
     insert into public.sms_leads(tenant_id,contact_id,fields,summary,priority,source_message_id)
     values(j.tenant_id,cid,coalesce(p->'lead','{}'),coalesce(p->>'leadSummary',''),coalesce(p->>'priority','normal'),nullif(j.payload->>'message_id','')::uuid) returning * into lead;
   end if;
 end if;
 if disposition='handoff' then
   insert into public.sms_handoffs(tenant_id,lead_id,contact_id,ai_job_id,reason,priority)
   values(j.tenant_id,lead.id,cid,j.id,coalesce(nullif(p->>'handoffReason',''),'Approved business knowledge did not support an answer.'),coalesce(p->>'priority','normal'))
   on conflict(tenant_id,contact_id) where status in ('open','assigned') do update set reason=excluded.reason,priority=excluded.priority,updated_at=now() returning id into handoff_id;
   select alert_phone into alert from public.sms_ai_settings where tenant_id=j.tenant_id and group_id=j.payload->>'group_id';
   if alert is not null and alert<>j.payload->>'phone' then
    begin
     perform sms_private.enqueue(j.tenant_id,'handoff_alert_jobs','handoff-alert:'||handoff_id,jsonb_build_object('handoff_id',handoff_id,'alert_phone',alert));
     update public.sms_handoffs set alert_status='queued' where tenant_id=j.tenant_id and id=handoff_id;
    exception when others then
     update public.sms_handoffs set alert_status='failed',alert_error=left(sqlstate||':'||sqlerrm,500) where tenant_id=j.tenant_id and id=handoff_id;
    end;
   end if;
 end if;
 result:=sms_private.outbox(j.tenant_id,'ai:'||j.id,jsonb_build_object('phone',j.payload->>'phone','body',p->>'reply','purpose','transactional','category_id',j.payload->>'group_id','conversation_generation',j.payload->'generation','ai_run_id',j.id));
 perform sms_private.finish(jid,token,'completed'); return result||jsonb_build_object('leadId',lead.id,'handoffId',handoff_id);
end $$;

create function sms_private.handoff_job_context(jid uuid,token uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
#variable_conflict use_column
declare j sms_private.jobs; begin
 j:=sms_private.lease(jid,token); if j.queue<>'handoff_alert_jobs' then raise exception 'Wrong queue'; end if;
 return (select jsonb_build_object('handoff',to_jsonb(h),'lead',to_jsonb(l),'contact',to_jsonb(c),'alertPhone',j.payload->>'alert_phone')
   from public.sms_handoffs h left join public.sms_leads l on l.tenant_id=h.tenant_id and l.id=h.lead_id
   join public.sms_contacts c on c.tenant_id=h.tenant_id and c.id=h.contact_id
   where h.tenant_id=j.tenant_id and h.id=(j.payload->>'handoff_id')::uuid);
end $$;

create function sms_private.complete_handoff_alert(jid uuid,token uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
#variable_conflict use_column
declare j sms_private.jobs; hid uuid; result jsonb; begin
 j:=sms_private.lease(jid,token); if j.queue<>'handoff_alert_jobs' then raise exception 'Wrong queue'; end if; hid:=(j.payload->>'handoff_id')::uuid;
 insert into public.sms_contacts(tenant_id,phone,name,source,marketing_consent) values(j.tenant_id,j.payload->>'alert_phone','Team alerts','system',true) on conflict(tenant_id,phone) do nothing;
 result:=sms_private.outbox(j.tenant_id,'handoff-alert:'||hid,jsonb_build_object('phone',j.payload->>'alert_phone','body',left((select 'SMS handoff from '||c.phone||': '||coalesce(nullif(l.summary,''),h.reason) from public.sms_handoffs h join public.sms_contacts c on c.tenant_id=h.tenant_id and c.id=h.contact_id left join public.sms_leads l on l.tenant_id=h.tenant_id and l.id=h.lead_id where h.tenant_id=j.tenant_id and h.id=hid),600),'purpose','transactional','category_id',null,'handoff_id',hid));
 update public.sms_handoffs set alert_status='queued',alert_error=null,updated_at=now() where tenant_id=j.tenant_id and id=hid;
 perform sms_private.finish(jid,token,'completed'); return result;
end $$;

create function sms_private.record_sms_estimate(jid uuid,token uuid,segments integer,cost_micros bigint default null) returns void
language plpgsql security definer set search_path='' as $$
#variable_conflict use_column
declare j sms_private.jobs;begin
 select * into strict j from sms_private.jobs where id=jid and lease_token=token and queue='sms_send_jobs' and status='submitting' for update;
 if segments not between 1 and 100 or cost_micros is not null and cost_micros<0 then raise exception 'Invalid SMS usage estimate';end if;
 update public.sms_messages set meta=meta||jsonb_strip_nulls(jsonb_build_object('smsSegments',segments,'estimatedCostMicros',cost_micros)),updated_at=now()
 where tenant_id=j.tenant_id and id=(j.payload->>'message_id')::uuid;
end $$;

create function sms_private.retry_handoff_alert(u text,t text,hid uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
#variable_conflict use_column
declare h public.sms_handoffs; alert text; jid uuid; begin
 perform sms_private.require_admin(u); select * into strict h from public.sms_handoffs where tenant_id=t and id=hid for update;
 select alert_phone into alert from public.sms_ai_settings where tenant_id=t and alert_phone is not null order by updated_at desc limit 1;
 if alert is null then raise exception 'Configure a staff alert number first'; end if;
 update sms_private.jobs set status='queued',attempts=0,available_at=now(),error_code=null,updated_at=now() where tenant_id=t and queue='sms_send_jobs' and dedupe_key='handoff-alert:'||hid and status='failed' returning id into jid;
 if jid is null then update sms_private.jobs set status='queued',attempts=0,available_at=now(),error_code=null,updated_at=now() where tenant_id=t and queue='handoff_alert_jobs' and dedupe_key='handoff-alert:'||hid and status='failed' returning id into jid; end if;
 if jid is null then jid:=sms_private.enqueue(t,'handoff_alert_jobs','handoff-alert:'||hid,jsonb_build_object('handoff_id',hid,'alert_phone',alert)); end if;
 update public.sms_handoffs set alert_status='queued',alert_error=null,updated_at=now() where tenant_id=t and id=hid;
 return jsonb_build_object('handoffId',hid,'jobId',jid);
end $$;

create function sms_private.update_lead_handoff(u text,t text,resource text,rid uuid,input jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
#variable_conflict use_column
declare result jsonb; lead_row public.sms_leads; handoff_row public.sms_handoffs;
begin
 perform sms_private.require_admin(u);
 if input->>'status' not in ('open','assigned','resolved','closed') then raise exception 'Invalid status'; end if;
 if resource='lead' then
  update public.sms_leads set status=input->>'status',owner=nullif(input->>'owner',''),updated_at=now() where tenant_id=t and id=rid returning * into lead_row;
  if found then result:=to_jsonb(lead_row); end if;
 elsif resource='handoff' then
  update public.sms_handoffs set status=input->>'status',owner=nullif(input->>'owner',''),updated_at=now() where tenant_id=t and id=rid returning * into handoff_row;
  if found then result:=to_jsonb(handoff_row); end if;
 else raise exception 'Unknown resource'; end if;
 if result is null then raise exception 'Record not found'; end if;
 return result;
end $$;

create function sms_private.twilio_registration(u text,t text) returns jsonb
language plpgsql security definer set search_path='' as $$
begin
 if not sms_private.can_access(t,u) then raise exception 'Tenant access denied' using errcode='42501'; end if;
 return coalesce((select to_jsonb(r)-'paid_action_confirmed_by' from public.sms_twilio_registrations r where tenant_id=t),jsonb_build_object('state','draft'));
end $$;

create function sms_private.start_twilio_registration(u text,t text,input jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
#variable_conflict use_column
declare row public.sms_twilio_registrations;
begin
 perform sms_private.require_admin(u);
 if input->>'senderType' not in ('local_a2p','toll_free') then raise exception 'Choose a sender type'; end if;
 if coalesce(input->>'country','US') not in ('US','CA') then raise exception 'Only US and Canada are supported'; end if;
 if input->>'senderType'='local_a2p' and coalesce(input->>'country','US')<>'US' then raise exception 'A2P 10DLC local senders are US only'; end if;
 insert into public.sms_twilio_registrations(tenant_id,sender_type,country,state,messaging_service_sid)
 select t,input->>'senderType',coalesce(input->>'country','US'),case when input->>'senderType'='local_a2p' then 'profile_pending' else 'number_pending' end,p.messaging_service_sid from sms_private.providers p where p.tenant_id=t
 on conflict(tenant_id) do update set sender_type=excluded.sender_type,country=excluded.country,state=excluded.state,messaging_service_sid=excluded.messaging_service_sid,rejection_code=null,rejection_reason=null,updated_at=now()
 returning * into row;
 if row.tenant_id is null then raise exception 'Provision the Twilio child account first'; end if;
 insert into sms_private.audit(tenant_id,actor,action,detail) values(t,u,'twilio_registration_started',jsonb_build_object('senderType',row.sender_type,'country',row.country));
 return to_jsonb(row)-'paid_action_confirmed_by';
end $$;

create function sms_private.number_search_context(u text,t text,input jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare r public.sms_twilio_registrations;p sms_private.providers;sec text;begin
 perform sms_private.require_admin(u);select * into strict r from public.sms_twilio_registrations where tenant_id=t;select * into strict p from sms_private.providers where tenant_id=t;select decrypted_secret into strict sec from vault.decrypted_secrets where id=p.auth_secret_id;
 return jsonb_build_object('accountSid',p.account_sid,'authToken',sec,'senderType',r.sender_type,'country',r.country,'areaCode',case when coalesce(input->>'areaCode','')~'^[0-9]{3}$' then input->>'areaCode' else null end);
end $$;

create function sms_private.queue_registration_refresh(u text,t text,reconcile boolean default false) returns jsonb
language plpgsql security definer set search_path='' as $$
#variable_conflict use_column
declare remote sms_private.remote_operations;jid uuid;begin
 perform sms_private.require_admin(u);
 if reconcile and not exists(select from public.sms_twilio_registrations where tenant_id=t and state='submission_unknown') then raise exception 'Registration is not awaiting reconciliation';end if;
 insert into sms_private.remote_operations(tenant_id,provider,operation,idempotency_key,request) values(t,'twilio','refresh_status',(case when reconcile then 'reconcile:' else 'manual-refresh:' end)||extract(epoch from now())::bigint,jsonb_build_object('reconcile',reconcile)) returning * into remote;
 jid:=sms_private.enqueue(t,'compliance_jobs','operation:'||remote.id,jsonb_build_object('operation_id',remote.id,'actor',u));return jsonb_build_object('operationId',remote.id,'jobId',jid);
end $$;

create function sms_private.confirm_twilio_paid_action(u text,t text,input jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
#variable_conflict use_column
declare row public.sms_twilio_registrations; jid uuid; op text; remote sms_private.remote_operations; ikey text;
begin
 perform sms_private.require_admin(u); if coalesce((input->>'confirmed')::boolean,false) is not true then raise exception 'Explicit charge confirmation required'; end if;
 op:=input->>'operation'; if op not in ('purchase_number','submit_registration') then raise exception 'Unsupported paid operation'; end if;
 update public.sms_twilio_registrations set paid_action_confirmed_at=now(),paid_action_confirmed_by=u,updated_at=now() where tenant_id=t returning * into strict row;
 if op='purchase_number' and row.state<>'number_pending' then raise exception 'Registration is not ready for number purchase'; end if;
 ikey:=coalesce(nullif(input->>'idempotencyKey',''),md5(op||':'||coalesce((input->'selection')::text,'null')));
 insert into sms_private.remote_operations(tenant_id,provider,operation,idempotency_key,state,request)
 values(t,'twilio',op,ikey,case when op='submit_registration' then 'completed' else 'pending' end,input) on conflict(tenant_id,provider,idempotency_key) do update set updated_at=sms_private.remote_operations.updated_at returning * into remote;
 if op='purchase_number' then jid:=sms_private.enqueue(t,'compliance_jobs','operation:'||remote.id,jsonb_build_object('operation_id',remote.id,'actor',u)); end if;
 return jsonb_build_object('registration',to_jsonb(row)-'paid_action_confirmed_by','operation',to_jsonb(remote)-'request','jobId',jid);
end $$;

create function sms_private.compliance_job_context(jid uuid,token uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
#variable_conflict use_column
declare j sms_private.jobs; begin
 j:=sms_private.lease(jid,token); if j.queue<>'compliance_jobs' then raise exception 'Wrong queue'; end if;
 return (select jsonb_build_object('operation',to_jsonb(o),'registration',to_jsonb(r)-'paid_action_confirmed_by','provider',jsonb_build_object('account_sid',p.account_sid,'auth_token',s.decrypted_secret,'messaging_service_sid',p.messaging_service_sid,'phone_number_sid',p.phone_number_sid,'from_number',p.from_number),
   'uncertain_operation',case when coalesce((o.request->>'reconcile')::boolean,false) then (select to_jsonb(x) from sms_private.remote_operations x where x.tenant_id=o.tenant_id and x.id<>o.id and x.state='submission_unknown' order by x.updated_at desc limit 1) end)
   from sms_private.remote_operations o join public.sms_twilio_registrations r on r.tenant_id=o.tenant_id join sms_private.providers p on p.tenant_id=o.tenant_id join vault.decrypted_secrets s on s.id=p.auth_secret_id
   where o.tenant_id=j.tenant_id and o.id=(j.payload->>'operation_id')::uuid);
end $$;

create function sms_private.compliance_checkpoint(jid uuid,token uuid,next_state text,p jsonb default '{}') returns jsonb
language plpgsql security definer set search_path='' as $$
#variable_conflict use_column
declare j sms_private.jobs; oid uuid; op sms_private.remote_operations; begin
 j:=sms_private.lease(jid,token); if j.queue<>'compliance_jobs' then raise exception 'Wrong queue'; end if; oid:=(j.payload->>'operation_id')::uuid;
 select * into strict op from sms_private.remote_operations where tenant_id=j.tenant_id and id=oid for update;
 if next_state not in ('submitting','completed','failed','submission_unknown','reconciled') then raise exception 'Invalid remote operation state'; end if;
 if op.state in ('completed','reconciled') and next_state not in ('completed','reconciled') then raise exception 'Remote operation is final'; end if;
 update sms_private.remote_operations set state=next_state,provider_resource_sid=coalesce(p->>'providerResourceSid',provider_resource_sid),error_code=coalesce(p->>'errorCode',error_code),updated_at=now() where id=oid returning * into op;
 if op.operation='purchase_number' and next_state='completed' then
  update sms_private.providers set phone_number_sid=p->>'phoneNumberSid',from_number=p->>'phoneNumber',provisioning_state='configured' where tenant_id=j.tenant_id;
  update public.sms_twilio_registrations set phone_number_sid=p->>'phoneNumberSid',messaging_service_sid=p->>'messagingServiceSid',state=case when sender_type='toll_free' then 'verification_pending' else 'in_review' end,paid_action_confirmed_at=null,paid_action_confirmed_by=null,updated_at=now() where tenant_id=j.tenant_id;
 elsif op.operation='refresh_status' and next_state='completed' then
  if nullif(p->>'phoneNumberSid','') is not null then
   update sms_private.providers set phone_number_sid=p->>'phoneNumberSid',from_number=p->>'phoneNumber',provisioning_state='configured' where tenant_id=j.tenant_id;
  end if;
  update public.sms_twilio_registrations set state=coalesce(p->>'registrationState',state),brand_registration_sid=coalesce(p->>'brandRegistrationSid',brand_registration_sid),campaign_sid=coalesce(p->>'campaignSid',campaign_sid),verification_sid=coalesce(p->>'verificationSid',verification_sid),phone_number_sid=coalesce(p->>'phoneNumberSid',phone_number_sid),rejection_code=p->>'rejectionCode',rejection_reason=p->>'rejectionReason',canary_message_sid=coalesce(p->>'canaryMessageSid',canary_message_sid),last_checked_at=now(),updated_at=now() where tenant_id=j.tenant_id;
  if nullif(p->>'reconciledOperationId','') is not null and coalesce(p->>'registrationState','')<>'submission_unknown' then
   update sms_private.remote_operations set state='reconciled',provider_resource_sid=coalesce(p->>'phoneNumberSid',provider_resource_sid),error_code=null,updated_at=now()
   where tenant_id=j.tenant_id and id=(p->>'reconciledOperationId')::uuid and state='submission_unknown';
  end if;
 elsif op.operation='activation_canary' and next_state='completed' then
  update public.sms_twilio_registrations set state='canary_pending',canary_message_sid=p->>'canaryMessageSid',last_checked_at=now(),updated_at=now() where tenant_id=j.tenant_id;
 elsif next_state='submission_unknown' then update public.sms_twilio_registrations set state='submission_unknown',updated_at=now() where tenant_id=j.tenant_id;
 end if;
 return to_jsonb(op)-'request';
end $$;

create function sms_private.begin_embedded_session(u text,t text,input jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
#variable_conflict use_column
declare r public.sms_twilio_registrations; p sms_private.providers; sec text; stage text; action text; endpoint text; body jsonb; details jsonb; remote sms_private.remote_operations; inquiry text; begin
 perform sms_private.require_admin(u); stage:=input->>'stage';action:=coalesce(input->>'action','new');
 if stage not in ('brand','campaign','toll_free') or action not in ('new','resume','resubmit') then raise exception 'Invalid registration session request'; end if;
 select * into strict r from public.sms_twilio_registrations where tenant_id=t for update;select * into strict p from sms_private.providers where tenant_id=t;select decrypted_secret into strict sec from vault.decrypted_secrets where id=p.auth_secret_id;details:=p.setup_details;
 if details is null then raise exception 'Save registration details first'; end if;
 if action in ('new','resubmit') and (r.paid_action_confirmed_at is null or r.paid_action_confirmed_at<now()-interval '1 hour') then raise exception 'Confirm registration charges before opening a paid submission'; end if;
 if stage='brand' then
  if r.sender_type<>'local_a2p' then raise exception 'Brand registration applies to US local senders'; end if;
  if action='new' then endpoint:='https://trusthub.twilio.com/v1/A2PBrandRegistrations';body:=jsonb_build_object('brandType',case when details->>'brandType'='sole_proprietor' then 'SOLE_PROPRIETOR' else 'STANDARD' end,'friendlyName',details->>'legalBusinessName','notificationEmail',details->>'notificationEmail','businessName',details->>'legalBusinessName','businessWebsite',details->>'websiteUrl');
  else if r.bundle_sid is null then raise exception 'No brand draft is available to resume';end if;inquiry:=coalesce(r.brand_inquiry_id,'tri1.us1.account.'||p.account_sid||'.registration.'||r.bundle_sid);endpoint:='https://trusthub.twilio.com/v1/A2PBrandRegistrations/'||inquiry||'/EmbeddedSessions';body:='{}';end if;
 elsif stage='campaign' then
  if r.sender_type<>'local_a2p' or r.brand_registration_sid is null then raise exception 'An approved brand is required'; end if;
  if action='new' then endpoint:='https://trusthub.twilio.com/v1/A2PCampaignRegistrations';body:=jsonb_build_object('a2pBrandRegistrationSid',r.brand_registration_sid,'messagingServiceSid',p.messaging_service_sid);
  else inquiry:=case when action='resubmit' then p.messaging_service_sid else r.campaign_inquiry_id end;if inquiry is null then raise exception 'No campaign draft is available to resume';end if;endpoint:='https://trusthub.twilio.com/v1/A2PCampaignRegistrations/'||inquiry||'/EmbeddedSessions';body:='{}';end if;
 else
  if r.sender_type<>'toll_free' or p.phone_number_sid is null then raise exception 'Purchase a toll-free number first';end if;endpoint:='https://trusthub.twilio.com/v1/ComplianceInquiries/Tollfree/Initialize';body:='{}';
 end if;
 insert into sms_private.remote_operations(tenant_id,provider,operation,idempotency_key,state,request) values(t,'twilio','embedded_session',stage||':'||action||':'||extract(epoch from now())::bigint,'submitting',jsonb_build_object('stage',stage,'action',action)) returning * into remote;
 return jsonb_build_object('operationId',remote.id,'stage',stage,'endpoint',endpoint,'body',body,'accountSid',p.account_sid,'authToken',sec);
end $$;

create function sms_private.finish_embedded_session(oid uuid,next_state text,p jsonb default '{}') returns jsonb
language plpgsql security definer set search_path='' as $$
#variable_conflict use_column
declare op sms_private.remote_operations; stage text; resource text; bundle text; begin
 select * into strict op from sms_private.remote_operations where id=oid and operation='embedded_session' for update;stage:=op.request->>'stage';
 if next_state not in ('completed','failed','submission_unknown') then raise exception 'Invalid embedded session result';end if;
 resource:=p->>'id';bundle:=substring(resource from '(BU[0-9A-Fa-f]{32})$');
 update sms_private.remote_operations set state=next_state,provider_resource_sid=case when bundle is not null then bundle else provider_resource_sid end,error_code=p->>'errorCode',updated_at=now() where id=oid;
 if next_state='completed' then
  if stage='brand' then update public.sms_twilio_registrations set brand_inquiry_id=resource,bundle_sid=coalesce(bundle,bundle_sid),state='brand_pending',paid_action_confirmed_at=null,paid_action_confirmed_by=null,updated_at=now() where tenant_id=op.tenant_id;
  elsif stage='campaign' then update public.sms_twilio_registrations set campaign_inquiry_id=resource,bundle_sid=coalesce(bundle,bundle_sid),state='campaign_pending',paid_action_confirmed_at=null,paid_action_confirmed_by=null,updated_at=now() where tenant_id=op.tenant_id;
  else update public.sms_twilio_registrations set state='verification_pending',paid_action_confirmed_at=null,paid_action_confirmed_by=null,updated_at=now() where tenant_id=op.tenant_id;end if;
 elsif next_state='submission_unknown' then update public.sms_twilio_registrations set state='submission_unknown',updated_at=now() where tenant_id=op.tenant_id;end if;
 return jsonb_build_object('operationId',oid,'state',next_state,'registrationState',(select state from public.sms_twilio_registrations where tenant_id=op.tenant_id));
end $$;

create function sms_private.queue_grounded_maintenance() returns integer
language plpgsql security definer set search_path='' as $$
#variable_conflict use_column
declare source_row public.sms_knowledge_sources; registration_row public.sms_twilio_registrations; remote sms_private.remote_operations; bucket text; n integer:=0; begin
 for source_row in select * from public.sms_knowledge_sources where type='website' and status<>'archived' and next_refresh_at<=now() order by next_refresh_at limit 100 for update skip locked loop
  update public.sms_knowledge_sources set status='indexing',updated_at=now(),next_refresh_at=now()+interval '7 days' where tenant_id=source_row.tenant_id and id=source_row.id;
  perform sms_private.enqueue(source_row.tenant_id,'knowledge_ingest_jobs','scheduled:'||source_row.id||':'||to_char(now(),'IYYY-IW'),jsonb_build_object('source_id',source_row.id,'actor','scheduler')); n:=n+1;
 end loop;
 bucket:=to_char(now(),'YYYYMMDDHH24MI');
 for registration_row in select * from public.sms_twilio_registrations where state in ('brand_pending','campaign_pending','verification_pending','in_review','submission_unknown','canary_pending') and coalesce(last_checked_at,'epoch')<now()-interval '10 minutes' order by last_checked_at nulls first limit 100 for update skip locked loop
  insert into sms_private.remote_operations(tenant_id,provider,operation,idempotency_key,request) values(registration_row.tenant_id,'twilio','refresh_status','refresh:'||bucket,'{}') on conflict(tenant_id,provider,idempotency_key) do nothing returning * into remote;
  if remote.id is not null then perform sms_private.enqueue(registration_row.tenant_id,'compliance_jobs','operation:'||remote.id,jsonb_build_object('operation_id',remote.id,'actor','scheduler'));n:=n+1;end if;
  update public.sms_twilio_registrations set last_checked_at=now() where tenant_id=registration_row.tenant_id;
 end loop;
 return n;
end $$;
select cron.schedule('grounded-maintenance','*/10 * * * *','select sms_private.queue_grounded_maintenance()');

create function sms_private.request_activation_canary(u text,t text,input jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
#variable_conflict use_column
declare row public.sms_twilio_registrations; remote sms_private.remote_operations; jid uuid; target text; begin
 perform sms_private.require_admin(u); target:=trim(input->>'phone');
 if coalesce((input->>'confirmed')::boolean,false) is not true then raise exception 'Explicit SMS charge confirmation required'; end if;
 if target !~ '^\+[1-9][0-9]{7,14}$' then raise exception 'Canary phone must be E.164'; end if;
 update public.sms_twilio_registrations set canary_phone=target,updated_at=now() where tenant_id=t and state='webhook_verified' returning * into strict row;
 insert into sms_private.remote_operations(tenant_id,provider,operation,idempotency_key,request) values(t,'twilio','activation_canary','canary:'||target||':'||extract(epoch from now())::bigint,jsonb_build_object('phone',target)) returning * into remote;
 jid:=sms_private.enqueue(t,'compliance_jobs','operation:'||remote.id,jsonb_build_object('operation_id',remote.id,'actor',u));
 return jsonb_build_object('registration',to_jsonb(row)-'paid_action_confirmed_by','jobId',jid);
end $$;

create function sms_private.queue_activation_canary(jid uuid,token uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
#variable_conflict use_column
declare j sms_private.jobs;op sms_private.remote_operations;target text;cid uuid;mid uuid;send_job uuid;begin
 j:=sms_private.lease(jid,token);if j.queue<>'compliance_jobs' then raise exception 'Wrong queue';end if;select * into strict op from sms_private.remote_operations where tenant_id=j.tenant_id and id=(j.payload->>'operation_id')::uuid and operation='activation_canary' for update;target:=op.request->>'phone';
 insert into public.sms_contacts(tenant_id,phone,name,source,marketing_consent) values(j.tenant_id,target,'Activation canary','system',true) on conflict(tenant_id,phone) do update set marketing_consent=true returning id into cid;
 insert into public.sms_messages(tenant_id,contact_phone,direction,body,meta) values(j.tenant_id,target,'outbound','SMS activation check: reply YES to confirm this business line is ready.',jsonb_build_object('purpose','activation_canary','operationId',op.id)) returning id into mid;
 send_job:=sms_private.enqueue(j.tenant_id,'sms_send_jobs','activation-canary:'||op.id,jsonb_build_object('message_id',mid,'request',jsonb_build_object('phone',target,'body','SMS activation check: reply YES to confirm this business line is ready.','purpose','activation_canary'),'contact_generation',(select generation from public.sms_contacts where tenant_id=j.tenant_id and id=cid)));
 update sms_private.remote_operations set state='completed',updated_at=now() where id=op.id;update public.sms_twilio_registrations set state='canary_pending',canary_message_id=mid,last_checked_at=now(),updated_at=now() where tenant_id=j.tenant_id;
 return jsonb_build_object('messageId',mid,'jobId',send_job);
end $$;

create function sms_private.sync_activation_canary() returns trigger language plpgsql security definer set search_path='' as $$
begin
 update public.sms_twilio_registrations set canary_message_sid=coalesce(new.sid,canary_message_sid),state=case when new.status='delivered' then 'ready' when new.status in ('failed','undelivered') then 'webhook_verified' else state end,last_checked_at=now(),updated_at=now() where tenant_id=new.tenant_id and canary_message_id=new.id;
 return new;
end $$;
create trigger sms_activation_canary_status after update of status,sid on public.sms_messages for each row execute function sms_private.sync_activation_canary();

create or replace function sms_private.begin_submission(jid uuid,token uuid) returns jsonb language plpgsql security definer set search_path='' as $$
#variable_conflict use_column
declare j sms_private.jobs;c public.sms_contacts;b public.sms_businesses;p sms_private.providers;e public.sms_automation_enrollments;r jsonb;a uuid;sec text;local_hour integer;begin
 j:=sms_private.lease(jid,token);if j.queue<>'sms_send_jobs' or j.status<>'processing' then raise exception 'Not a send job';end if;r:=j.payload->'request';
 select * into strict c from public.sms_contacts where tenant_id=j.tenant_id and phone=r->>'phone' for update;select * into strict b from public.sms_businesses where tenant_id=j.tenant_id;
 if c.opted_out or c.generation<>(j.payload->>'contact_generation')::bigint or ((not b.sending_enabled or b.status<>'active') and not (r->>'purpose'='activation_canary' and exists(select from public.sms_twilio_registrations where tenant_id=j.tenant_id and state='canary_pending' and canary_message_id=(j.payload->>'message_id')::uuid))) or (coalesce(r->>'purpose','marketing')='marketing' and not c.marketing_consent) then perform sms_private.finish(jid,token,'cancelled','ELIGIBILITY_CHANGED');return null;end if;
 if r ? 'conversation_generation' and not exists(select from public.sms_thread_contacts where tenant_id=j.tenant_id and phone=c.phone and not ai_paused and generation=(r->>'conversation_generation')::bigint) then perform sms_private.finish(jid,token,'cancelled','STALE_REPLY');return null;end if;
 if r ? 'enrollment_id' then select * into e from public.sms_automation_enrollments where tenant_id=j.tenant_id and id=(r->>'enrollment_id')::uuid for update;if e.id is null or e.status<>'active' or e.generation<>(r->>'enrollment_generation')::bigint or e.step_index<>(r->>'step_index')::integer or not exists(select from public.sms_automation_groups where tenant_id=j.tenant_id and id=e.category_id and active and version=(r->>'group_version')::bigint) or e.appointment_at<=now() then perform sms_private.finish(jid,token,'cancelled','STALE_ENROLLMENT');return null;end if;if e.next_run_at>now() then update sms_private.jobs set attempts=attempts-1 where id=jid;perform sms_private.finish(jid,token,'retry','RESCHEDULED',ceil(extract(epoch from e.next_run_at-now()))::integer);return null;end if;end if;
 if coalesce(r->>'purpose','marketing')='marketing' then local_hour:=extract(hour from now() at time zone b.time_zone);if local_hour<coalesce((r->>'start_hour')::int,9) or local_hour>=coalesce((r->>'end_hour')::int,19) then update sms_private.jobs set attempts=attempts-1 where id=jid;perform sms_private.finish(jid,token,'retry','OUTSIDE_WINDOW',60);return null;end if;end if;
 select * into p from sms_private.providers where tenant_id=j.tenant_id for update;if p.auth_secret_id is null or p.account_sid is null or (p.messaging_service_sid is null and p.from_number is null) then perform sms_private.finish(jid,token,'failed','SENDER_NOT_CONFIGURED');return null;end if;if p.next_send_at>now() then update sms_private.jobs set attempts=attempts-1 where id=jid;perform sms_private.finish(jid,token,'retry','RATE_LIMIT',greatest(1,ceil(extract(epoch from p.next_send_at-now())))::int);return null;end if;
 select decrypted_secret into strict sec from vault.decrypted_secrets where id=p.auth_secret_id;insert into sms_private.attempts(job_id,lease_token) values(jid,token) returning id into a;update sms_private.providers set next_send_at=now()+make_interval(secs=>1/p.sends_per_second) where tenant_id=j.tenant_id;update sms_private.jobs set status='submitting' where id=jid;update public.sms_messages set status='submitting',updated_at=now() where tenant_id=j.tenant_id and id=(j.payload->>'message_id')::uuid;
 return jsonb_build_object('attempt_id',a,'account_sid',p.account_sid,'auth_token',sec,'messaging_service_sid',p.messaging_service_sid,'from_number',p.from_number,'phone',c.phone,'body',r->>'body');
end $$;

create function sms_private.activation_readiness(u text,t text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare reasons jsonb:='[]'; p sms_private.providers; r public.sms_twilio_registrations; b public.sms_businesses;
begin
 perform sms_private.require_admin(u); select * into strict b from public.sms_businesses where tenant_id=t; select * into p from sms_private.providers where tenant_id=t; select * into r from public.sms_twilio_registrations where tenant_id=t;
 if b.active_profile_version_id is null then reasons:=reasons||'"approved_business_profile_required"'; end if;
 if p.auth_secret_id is null or p.account_sid is null then reasons:=reasons||'"child_credentials_required"'; end if;
 if p.from_number is null or p.phone_number_sid is null then reasons:=reasons||'"owned_phone_number_required"'; end if;
 if p.messaging_service_sid is null or r.messaging_service_sid is distinct from p.messaging_service_sid then reasons:=reasons||'"messaging_service_attachment_required"'; end if;
 if r.state not in ('webhook_verified','canary_pending','ready') then reasons:=reasons||'"approved_registration_required"'; end if;
 return jsonb_build_object('ready',jsonb_array_length(reasons)=0,'reasons',reasons,'registrationState',r.state,'sendingEnabled',b.sending_enabled);
end $$;

create function sms_private.activate_twilio(u text,t text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare readiness jsonb; begin
 perform sms_private.require_admin(u); readiness:=sms_private.activation_readiness(u,t);
 if coalesce((readiness->>'ready')::boolean,false) is not true then raise exception 'Activation requirements are not satisfied'; end if;
 if not exists(select from public.sms_twilio_registrations where tenant_id=t and state='ready') then raise exception 'Activation canary has not passed'; end if;
 update public.sms_businesses set sending_enabled=true,status='active' where tenant_id=t;
 insert into sms_private.audit(tenant_id,actor,action,detail) values(t,u,'twilio_sending_activated',readiness);
 return readiness||jsonb_build_object('sendingEnabled',true);
end $$;

create function sms_private.configure_grounded_ai(u text,t text,g text,input jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
#variable_conflict use_column
declare row public.sms_ai_settings; begin
 perform sms_private.require_admin(u);
 update public.sms_ai_settings set grounded_enabled=coalesce((input->>'groundedEnabled')::boolean,grounded_enabled),shadow_mode=coalesce((input->>'shadowMode')::boolean,shadow_mode),alert_phone=case when input ? 'alertPhone' then nullif(trim(input->>'alertPhone'),'') else alert_phone end,updated_at=now()
 where tenant_id=t and group_id=g returning * into row;
 if row.tenant_id is null then raise exception 'Configure AI for this automation group first'; end if;
 if row.alert_phone is not null and row.alert_phone !~ '^\+[1-9][0-9]{7,14}$' then raise exception 'Staff alert phone must be E.164'; end if;
 return to_jsonb(row);
end $$;

create function sms_private.configure_ai_grounded(u text,t text,g text,input jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
begin
 perform sms_private.configure_ai(u,t,g,coalesce((input->>'enabled')::boolean,false),coalesce(input->>'instructions',''),coalesce((input->>'defaultForInbound')::boolean,false));
 return sms_private.configure_grounded_ai(u,t,g,input);
end $$;

create function sms_private.grounded_operations(u text,t text) returns jsonb
language plpgsql security definer set search_path='' as $$
begin
 if not sms_private.can_access(t,u) then raise exception 'Tenant access denied' using errcode='42501'; end if;
 return jsonb_build_object(
  'queues',(select coalesce(jsonb_agg(x),'[]') from (select queue,count(*) filter(where status in ('queued','retry')) backlog,extract(epoch from now()-min(created_at) filter(where status in ('queued','retry')))::integer oldest_age_seconds,count(*) filter(where status='failed') failed from sms_private.jobs where tenant_id=t and queue in ('knowledge_ingest_jobs','embedding_jobs','handoff_alert_jobs','compliance_jobs','ai_reply_jobs') group by queue order by queue)x),
  'ingestionFailures',(select count(*) from public.sms_knowledge_sources where tenant_id=t and status='failed'),
  'retrievalMisses',(select count(*) from public.sms_ai_runs where tenant_id=t and disposition='handoff' and cardinality(citation_ids)=0 and created_at>now()-interval '30 days'),
  'aiValidationFailures',(select count(*) from public.sms_ai_runs where tenant_id=t and validation_error is not null and created_at>now()-interval '30 days'),
  'handoffRate',(select case when count(*)=0 then 0 else round(count(*) filter(where disposition='handoff')::numeric/count(*),4) end from public.sms_ai_runs where tenant_id=t and created_at>now()-interval '30 days'),
  'responseLatencyP95Ms',(select coalesce(percentile_cont(0.95) within group(order by latency_ms),0)::integer from public.sms_ai_runs where tenant_id=t and latency_ms is not null and created_at>now()-interval '30 days'),
  'deliveryFailures',(select count(*) from public.sms_messages where tenant_id=t and status in ('failed','undelivered') and created_at>now()-interval '30 days'),
  'aiUsage',(select jsonb_build_object('inputTokens',coalesce(sum(input_tokens),0),'outputTokens',coalesce(sum(output_tokens),0),'runs',count(*),'estimatedCostMicros',sum(estimated_cost_micros)) from public.sms_ai_runs where tenant_id=t and created_at>date_trunc('month',now())),
  'smsUsage',(select jsonb_build_object('segments',coalesce(sum(case when meta->>'smsSegments'~'^[0-9]+$' then (meta->>'smsSegments')::integer else 0 end),0),'estimatedCostMicros',sum(case when meta->>'estimatedCostMicros'~'^[0-9]+$' then (meta->>'estimatedCostMicros')::bigint end)) from public.sms_messages where tenant_id=t and direction='outbound' and created_at>date_trunc('month',now())),
  'registration',(select jsonb_build_object('state',state,'ageSeconds',extract(epoch from now()-updated_at)::integer,'rejectionCode',rejection_code,'rejectionReason',rejection_reason) from public.sms_twilio_registrations where tenant_id=t));
end $$;

-- Backfill already-completed structured onboarding as the first approved version.
insert into public.sms_business_profile_versions(tenant_id,version,facts,status,content_hash,created_by,approved_by,approved_at)
select tenant_id,1,profile->'onboarding','approved',md5((profile->'onboarding')::text),'migration','migration',now()
from public.sms_businesses where profile ? 'onboarding' and profile->'onboarding'->>'completedAt' is not null
on conflict do nothing;
update public.sms_businesses b set active_profile_version_id=v.id from public.sms_business_profile_versions v
where v.tenant_id=b.tenant_id and v.status='approved' and b.active_profile_version_id is null;

-- Manual onboarding remains compatible and immediately approves admin-authored facts.
create or replace function sms_private.save_business_profile(u text,t text,input jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare row jsonb; normalized jsonb;
begin
 normalized:=input||jsonb_build_object('pricing',coalesce(input->'pricing','[]'),'policies',coalesce(input->'policies','[]'));
 row:=sms_private.save_profile_version(u,t,normalized,true);
 return sms_private.business_profile(u,t)||jsonb_build_object('profileVersionId',row->'id');
end $$;

-- Tenant-visible tables retain RLS; all writes go through audited definer functions.
do $$ declare tbl text; begin
 foreach tbl in array array['sms_business_profile_versions','sms_knowledge_sources','sms_knowledge_source_versions','sms_knowledge_chunks','sms_leads','sms_handoffs','sms_ai_runs','sms_twilio_registrations'] loop
  execute format('alter table public.%I enable row level security',tbl);
  execute format('create policy tenant_read on public.%I for select to authenticated using (sms_private.can_access(tenant_id))',tbl);
  execute format('grant select on public.%I to authenticated',tbl);
 end loop;
 alter table sms_private.remote_operations enable row level security;
end $$;

revoke all on function sms_private.validate_business_facts(jsonb),sms_private.save_profile_version(text,text,jsonb,boolean),sms_private.approve_profile_version(text,text,uuid),
 sms_private.knowledge_overview(text,text),sms_private.create_knowledge_source(text,text,jsonb),sms_private.queue_knowledge_refresh(text,text,uuid),sms_private.archive_knowledge_source(text,text,uuid),sms_private.approve_knowledge_version(text,text,uuid),
 sms_private.knowledge_job_context(uuid,uuid),sms_private.complete_knowledge_ingest(uuid,uuid,jsonb),sms_private.complete_embeddings(uuid,uuid,jsonb),sms_private.fail_knowledge_job(uuid,uuid,text),
 sms_private.search_job_knowledge(uuid,uuid,text,text,integer),sms_private.complete_grounded_ai(uuid,uuid,jsonb),sms_private.handoff_job_context(uuid,uuid),sms_private.complete_handoff_alert(uuid,uuid),sms_private.record_sms_estimate(uuid,uuid,integer,bigint),sms_private.retry_handoff_alert(text,text,uuid),sms_private.update_lead_handoff(text,text,text,uuid,jsonb),
 sms_private.twilio_registration(text,text),sms_private.start_twilio_registration(text,text,jsonb),sms_private.number_search_context(text,text,jsonb),sms_private.queue_registration_refresh(text,text,boolean),sms_private.confirm_twilio_paid_action(text,text,jsonb),sms_private.compliance_job_context(uuid,uuid),sms_private.compliance_checkpoint(uuid,uuid,text,jsonb),sms_private.begin_embedded_session(text,text,jsonb),sms_private.finish_embedded_session(uuid,text,jsonb),sms_private.request_activation_canary(text,text,jsonb),sms_private.queue_activation_canary(uuid,uuid),sms_private.activation_readiness(text,text),sms_private.activate_twilio(text,text),sms_private.configure_grounded_ai(text,text,text,jsonb),sms_private.configure_ai_grounded(text,text,text,jsonb),sms_private.grounded_operations(text,text),sms_private.queue_grounded_maintenance(),sms_private.sync_activation_canary()
 from public,anon,authenticated,sms_api,sms_webhook,sms_sender,sms_automation,sms_ai;

grant execute on function sms_private.save_profile_version(text,text,jsonb,boolean),sms_private.approve_profile_version(text,text,uuid),sms_private.knowledge_overview(text,text),
 sms_private.create_knowledge_source(text,text,jsonb),sms_private.queue_knowledge_refresh(text,text,uuid),sms_private.archive_knowledge_source(text,text,uuid),sms_private.approve_knowledge_version(text,text,uuid),
 sms_private.update_lead_handoff(text,text,text,uuid,jsonb),sms_private.twilio_registration(text,text),sms_private.start_twilio_registration(text,text,jsonb),
 sms_private.queue_registration_refresh(text,text,boolean),sms_private.confirm_twilio_paid_action(text,text,jsonb),sms_private.request_activation_canary(text,text,jsonb),sms_private.activation_readiness(text,text),sms_private.activate_twilio(text,text),sms_private.configure_grounded_ai(text,text,text,jsonb),sms_private.configure_ai_grounded(text,text,text,jsonb),sms_private.grounded_operations(text,text),sms_private.retry_handoff_alert(text,text,uuid) to sms_api;
grant execute on function sms_private.knowledge_job_context(uuid,uuid),sms_private.complete_knowledge_ingest(uuid,uuid,jsonb),sms_private.complete_embeddings(uuid,uuid,jsonb),sms_private.fail_knowledge_job(uuid,uuid,text),
 sms_private.search_job_knowledge(uuid,uuid,text,text,integer),sms_private.job_context(uuid,uuid),sms_private.complete_grounded_ai(uuid,uuid,jsonb) to sms_ai;
grant execute on function sms_private.handoff_job_context(uuid,uuid),sms_private.complete_handoff_alert(uuid,uuid) to sms_sender;
grant execute on function sms_private.record_sms_estimate(uuid,uuid,integer,bigint) to sms_sender;
grant execute on function sms_private.compliance_job_context(uuid,uuid),sms_private.compliance_checkpoint(uuid,uuid,text,jsonb),sms_private.queue_activation_canary(uuid,uuid) to sms_automation;
grant execute on function sms_private.begin_embedded_session(text,text,jsonb),sms_private.finish_embedded_session(uuid,text,jsonb),sms_private.number_search_context(text,text,jsonb) to sms_automation;
revoke execute on function sms_private.complete_ai(uuid,uuid,text) from sms_ai;

do $$ begin
 if to_regclass('storage.buckets') is not null then
  execute $q$insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types) values('business-knowledge','business-knowledge',false,10485760,array['application/pdf','application/vnd.openxmlformats-officedocument.wordprocessingml.document','text/plain','text/markdown']) on conflict(id) do update set public=false,file_size_limit=10485760,allowed_mime_types=excluded.allowed_mime_types$q$;
 end if;
end $$;
