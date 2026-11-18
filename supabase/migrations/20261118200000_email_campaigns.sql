-- CRM-owned forward migration: email marketing campaigns, saved segments, batched
-- Resend delivery and open/click engagement. Requires CRM
-- 20261102051753_reusable_email_automations (and its MCP follow-ups). No E2 change.
-- Apply once after reconciling live history; never replay either paired history.
-- Nothing here enables sending: campaigns start only by explicit staff action and
-- still require business email activation, a verified sender and recorded consent.
do $$ begin
 if to_regprocedure('sms_private.email_automation_apply(text,text,text,jsonb)') is null then raise exception 'Apply CRM reusable_email_automations first'; end if;
end $$;

create table sms_private.email_segments (
 id uuid primary key default gen_random_uuid(), tenant_id text not null references public.sms_businesses(tenant_id),
 name text not null check(length(btrim(name)) between 1 and 120), definition jsonb not null,
 revision integer not null default 1, archived boolean not null default false,
 created_by text not null, created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
 unique(tenant_id,id)
);
create table sms_private.email_campaigns (
 id uuid primary key default gen_random_uuid(), tenant_id text not null references public.sms_businesses(tenant_id),
 name text not null check(length(btrim(name)) between 1 and 120),
 status text not null default 'draft' check(status in ('draft','scheduled','sending','paused','completed','cancelled')),
 template_id uuid, template_version integer, segment_id uuid, scheduled_at timestamptz,
 started_at timestamptz, completed_at timestamptz, revision integer not null default 1,
 created_by text not null, created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
 foreign key(tenant_id,template_id) references sms_private.email_templates(tenant_id,id),
 foreign key(tenant_id,segment_id) references sms_private.email_segments(tenant_id,id),
 check(status in ('draft','cancelled') or (template_version is not null and segment_id is not null and started_at is not null)),
 unique(tenant_id,id)
);
create index email_campaign_tenant on sms_private.email_campaigns(tenant_id,created_at desc);
create index email_campaign_live on sms_private.email_campaigns(status) where status in ('scheduled','sending');
-- Recipient snapshot taken at start. Skipped rows record why an address was excluded.
create table sms_private.email_campaign_recipients (
 tenant_id text not null, campaign_id uuid not null, email text not null, contact_id uuid,
 status text not null check(status in ('queued','skipped')), skip_reason text, enrollment_id uuid,
 created_at timestamptz not null default now(), primary key(campaign_id,email),
 foreign key(tenant_id,campaign_id) references sms_private.email_campaigns(tenant_id,id),
 check((status='skipped')=(skip_reason is not null))
);
create index email_campaign_recipient_status on sms_private.email_campaign_recipients(campaign_id,status,skip_reason);
alter table sms_private.email_enrollments add column campaign_id uuid,
 add foreign key(tenant_id,campaign_id) references sms_private.email_campaigns(tenant_id,id),
 add check(campaign_id is null or (template_id is not null and purpose='marketing' and origin_type='campaign'));
create unique index email_run_campaign on sms_private.email_enrollments(campaign_id,email) where campaign_id is not null;
create index email_run_campaign_live on sms_private.email_enrollments(campaign_id,status) where campaign_id is not null;

-- A batch is one Resend /emails/batch request. Once submitted, its member list and
-- frozen payloads never change, so a retry replays the identical request under the
-- same idempotency key (the batch id) within the provider's 24-hour horizon.
create table sms_private.email_send_batches (
 id uuid primary key default gen_random_uuid(), tenant_id text not null, campaign_id uuid not null,
 status text not null default 'open' check(status in ('open','submitted','sent','failed')),
 job_ids uuid[] not null default '{}', lease_token uuid, attempts integer not null default 0,
 submitted_at timestamptz, created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
 foreign key(tenant_id,campaign_id) references sms_private.email_campaigns(tenant_id,id),
 check(cardinality(job_ids)<=100), check((status='open')=(submitted_at is null))
);
create index email_batch_replay on sms_private.email_send_batches(submitted_at) where status='submitted';
alter table sms_private.email_jobs add column batch_id uuid references sms_private.email_send_batches(id),
 add column opened_at timestamptz, add column clicked_at timestamptz;
create index email_job_batch on sms_private.email_jobs(batch_id) where batch_id is not null;
create table sms_private.email_engagement_events (
 event_key text primary key, provider_id text not null, kind text not null check(kind in ('email.opened','email.clicked')),
 url text check(url is null or length(url)<=2000), occurred_at timestamptz not null default now()
);
create index email_engagement_provider on sms_private.email_engagement_events(provider_id,kind);
alter table sms_private.email_segments enable row level security;
alter table sms_private.email_campaigns enable row level security;
alter table sms_private.email_campaign_recipients enable row level security;
alter table sms_private.email_send_batches enable row level security;
alter table sms_private.email_engagement_events enable row level security;
revoke all on sms_private.email_segments,sms_private.email_campaigns,sms_private.email_campaign_recipients,
 sms_private.email_send_batches,sms_private.email_engagement_events from public,anon,authenticated,service_role,sms_api,sms_sender,sms_ai,sms_automation;

-- Segment definitions are data, never SQL: {"match":"all"|"any","rules":[{"field","value"}]}.
create function sms_private.email_segment_validate(d jsonb) returns void language plpgsql immutable set search_path='' as $$
declare r jsonb; begin
 if jsonb_typeof(d) is distinct from 'object' or coalesce(d->>'match','') not in ('all','any') or jsonb_typeof(d->'rules') is distinct from 'array'
  or jsonb_array_length(d->'rules')>20 or exists(select from jsonb_object_keys(d) k where k not in ('match','rules')) then raise exception 'Invalid segment'; end if;
 for r in select value from jsonb_array_elements(d->'rules') loop
  if jsonb_typeof(r) is distinct from 'object' or exists(select from jsonb_object_keys(r) k where k not in ('field','value')) then raise exception 'Invalid segment rule'; end if;
  if r->>'field' in ('createdWithinDays','createdOlderThanDays') then
   if jsonb_typeof(r->'value') is distinct from 'number' or (r->>'value')::numeric<>trunc((r->>'value')::numeric) or (r->>'value')::numeric not between 1 and 3650 then raise exception 'Days must be a whole number from 1 to 3650'; end if;
  elsif r->>'field'='source' then
   if jsonb_typeof(r->'value') is distinct from 'string' or length(btrim(r->>'value')) not between 1 and 60 then raise exception 'Choose a contact source'; end if;
  elsif r->>'field'='emailDomain' then
   if jsonb_typeof(r->'value') is distinct from 'string' or r->>'value' !~ '^[A-Za-z0-9.-]{1,253}$' then raise exception 'Enter an email domain such as example.com'; end if;
  else raise exception 'Unknown segment field'; end if;
 end loop;
end $$;
create function sms_private.email_segment_rule(c public.sms_contacts,r jsonb) returns boolean language sql stable set search_path='' as $$
 select case r->>'field'
  when 'source' then c.source=r->>'value'
  when 'createdWithinDays' then c.created_at>=now()-make_interval(days=>(r->>'value')::integer)
  when 'createdOlderThanDays' then c.created_at<now()-make_interval(days=>(r->>'value')::integer)
  when 'emailDomain' then lower(split_part(c.email,'@',2))=lower(r->>'value')
  else false end
$$;
-- One row per normalized address; the earliest contact wins for personalization.
create function sms_private.email_segment_contacts(t text,d jsonb) returns table(contact_id uuid,email text,name text,phone text)
language sql stable set search_path='' as $$
 select distinct on (lower(c.email)) c.id,lower(c.email),c.name,c.phone from public.sms_contacts c
 -- Must equal the send guard's contact check (lower(email)); padded addresses are invalid.
 where c.tenant_id=t and c.email is not null and length(c.email)<=320
  and lower(c.email) ~ '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$'
  and case when jsonb_array_length(d->'rules')=0 then true
   when d->>'match'='any' then exists(select from jsonb_array_elements(d->'rules') r where sms_private.email_segment_rule(c,r.value))
   else not exists(select from jsonb_array_elements(d->'rules') r where not sms_private.email_segment_rule(c,r.value)) end
 order by lower(c.email),c.created_at,c.id
$$;
-- Marketing eligibility at snapshot time; the send guard re-checks every address.
create function sms_private.email_campaign_skip_reason(t text,address text) returns text language sql stable set search_path='' as $$
 select case when exists(select from sms_private.email_global_suppressions where email=address) then 'PROVIDER_SUPPRESSED'
  when exists(select from sms_private.email_suppressions where tenant_id=t and email=address) then 'UNSUBSCRIBED'
  when not sms_private.email_has_permission(t,address) then 'NO_CONSENT' end
$$;
create function sms_private.email_segment_preview(t text,d jsonb) returns jsonb language sql stable set search_path='' as $$
 with s as (select x.*,sms_private.email_campaign_skip_reason(t,x.email) reason from sms_private.email_segment_contacts(t,d) x)
 select jsonb_build_object('total',(select count(*) from s),'eligible',(select count(*) from s where reason is null),
  'skipped',coalesce((select jsonb_object_agg(reason,n) from (select reason,count(*) n from s where reason is not null group by reason) g),'{}'),
  'sample',coalesce((select jsonb_agg(jsonb_build_object('name',name,'email',email)) from (select name,email from s where reason is null order by email limit 10) q),'[]'))
$$;
create function sms_private.email_campaign_template_ok(t text,tid uuid) returns jsonb language plpgsql stable set search_path='' as $$
declare a sms_private.email_templates; d jsonb; begin
 select * into a from sms_private.email_templates where tenant_id=t and id=tid;
 if a.id is null or a.archived or a.published_version is null then raise exception 'Choose a published, unarchived template'; end if;
 select definition into d from sms_private.email_template_versions where tenant_id=t and template_id=tid and version=a.published_version;
 if d->>'purpose'<>'marketing' then raise exception 'Campaigns require a marketing template'; end if;
 if exists(select from jsonb_array_elements(d->'steps') s where s->>'anchor'<>'event') then raise exception 'Campaign templates cannot use appointment timing'; end if;
 return jsonb_build_object('version',a.published_version,'definition',d);
end $$;

create function sms_private.email_campaign_counts(cid uuid) returns jsonb language sql stable set search_path='' as $$
 select jsonb_build_object(
  'recipients',(select count(*) from sms_private.email_campaign_recipients where campaign_id=cid),
  'queued',(select count(*) from sms_private.email_campaign_recipients where campaign_id=cid and status='queued'),
  'skipped',coalesce((select jsonb_object_agg(skip_reason,n) from (select skip_reason,count(*) n from sms_private.email_campaign_recipients where campaign_id=cid and status='skipped' group by skip_reason) g),'{}'),
  'unsubscribed',(select count(*) from sms_private.email_enrollments where campaign_id=cid and status='unsubscribed'),
  'messages',(select jsonb_build_object('sent',count(*) filter(where j.status='sent'),'pending',count(*) filter(where j.status in ('pending','processing')),
    'cancelled',count(*) filter(where j.status='cancelled'),'failed',count(*) filter(where j.status in ('failed','uncertain')),
    'delivered',count(*) filter(where j.provider_status='email.delivered'),'bounced',count(*) filter(where j.provider_status='email.bounced'),
    'complained',count(*) filter(where j.provider_status='email.complained'),'opened',count(*) filter(where j.opened_at is not null),
    'clicked',count(*) filter(where j.clicked_at is not null))
   from sms_private.email_jobs j join sms_private.email_enrollments e on e.id=j.enrollment_id where e.campaign_id=cid))
$$;

create function sms_private.email_campaign_read(t text,p jsonb default '{}') returns jsonb language plpgsql stable set search_path='' as $$
declare c sms_private.email_campaigns; begin
 if nullif(p->>'campaignId','') is not null then
  select * into strict c from sms_private.email_campaigns where tenant_id=t and id=(p->>'campaignId')::uuid;
  return jsonb_build_object('campaign',to_jsonb(c)||jsonb_build_object('counts',sms_private.email_campaign_counts(c.id)),
   'links',coalesce((select jsonb_agg(jsonb_build_object('url',url,'clicks',n) order by n desc,url) from (
     select g.url,count(*) n from sms_private.email_engagement_events g join sms_private.email_jobs j on j.provider_id=g.provider_id
     join sms_private.email_enrollments e on e.id=j.enrollment_id where e.campaign_id=c.id and g.kind='email.clicked' and g.url is not null
     group by g.url order by count(*) desc,g.url limit 10) l),'[]'),
   'recipients',coalesce((select jsonb_agg(to_jsonb(x)) from (select r.email,r.status,r.skip_reason,e.status run_status,
     (select j.status||coalesce(':'||j.provider_status,'') from sms_private.email_jobs j where j.enrollment_id=e.id order by j.created_at desc limit 1) delivery
     from sms_private.email_campaign_recipients r left join sms_private.email_enrollments e on e.id=r.enrollment_id
     where r.campaign_id=c.id order by r.status,r.email limit 100 offset greatest(0,coalesce((p->>'page')::integer,1)-1)*100) x),'[]'));
 end if;
 return jsonb_build_object(
  'segments',coalesce((select jsonb_agg(to_jsonb(s) order by s.name) from (select * from sms_private.email_segments where tenant_id=t and not archived order by name limit 100) s),'[]'),
  'campaigns',coalesce((select jsonb_agg(to_jsonb(x)||jsonb_build_object('counts',sms_private.email_campaign_counts(x.id)) order by x.created_at desc) from (select * from sms_private.email_campaigns where tenant_id=t order by created_at desc limit 50) x),'[]'),
  'templates',coalesce((select jsonb_agg(jsonb_build_object('id',a.id,'name',a.name,'version',a.published_version,'steps',jsonb_array_length(v.definition->'steps')) order by a.name)
    from sms_private.email_templates a join sms_private.email_template_versions v on v.tenant_id=a.tenant_id and v.template_id=a.id and v.version=a.published_version
    where a.tenant_id=t and not a.archived and v.definition->>'purpose'='marketing' and not exists(select from jsonb_array_elements(v.definition->'steps') st where st->>'anchor'<>'event')),'[]'),
  'sources',coalesce((select jsonb_agg(source order by source) from (select distinct source from public.sms_contacts where tenant_id=t and email is not null limit 50) s),'[]'),
  'sender',sms_private.email_sender_settings(t));
end $$;

create function sms_private.email_campaign_apply(t text,actor text,action text,p jsonb) returns jsonb language plpgsql set search_path='' as $$
declare s sms_private.email_segments; c sms_private.email_campaigns; result jsonb; saved sms_private.email_automation_operations; key uuid;
 tpl jsonb; d jsonb; base timestamptz; due timestamptz; tz text; n integer; snd jsonb; begin
 if jsonb_typeof(p) is distinct from 'object' or length(p::text)>50000 then raise exception 'Invalid campaign request'; end if;
 if action='read' then return sms_private.email_campaign_read(t,p); end if;
 if action='segment_preview' then
  if nullif(p->>'segmentId','') is not null then select definition into strict d from sms_private.email_segments where tenant_id=t and id=(p->>'segmentId')::uuid;
  else d:=p->'definition'; end if;
  perform sms_private.email_segment_validate(d); return sms_private.email_segment_preview(t,d);
 end if;
 if action='campaign_preview' then
  select * into strict c from sms_private.email_campaigns where tenant_id=t and id=(p->>'id')::uuid;
  if c.segment_id is null then raise exception 'Choose a segment'; end if;
  select definition into strict d from sms_private.email_segments where tenant_id=t and id=c.segment_id;
  return sms_private.email_segment_preview(t,d)||jsonb_build_object('sender',sms_private.email_sender_settings(t),'queued',false);
 end if;
 key:=(p->>'idempotencyKey')::uuid; if key is null then raise exception 'Retry identity required'; end if;
 perform pg_advisory_xact_lock(hashtextextended('email-operation:'||t||':'||actor||':'||key,0));
 select * into saved from sms_private.email_automation_operations o where o.tenant_id=t and o.actor=email_campaign_apply.actor and o.retry_key=key;
 if found then if saved.action<>'campaign:'||action or saved.payload<>p then raise exception 'Retry identity already used'; end if; return saved.result; end if;
 if action in ('segment_save','segment_archive') then
  if nullif(p->>'id','') is not null then
   select * into strict s from sms_private.email_segments where tenant_id=t and id=(p->>'id')::uuid for update;
   if s.revision is distinct from (p->>'revision')::integer or s.archived then raise exception 'Segment changed; reload' using errcode='40001'; end if;
  elsif action='segment_archive' then raise exception 'Choose a segment';
  end if;
  if action='segment_archive' then
   if exists(select from sms_private.email_campaigns where segment_id=s.id and status in ('draft','scheduled','paused')) then raise exception 'Remove this segment from draft, scheduled or paused campaigns first'; end if;
   update sms_private.email_segments set archived=true,revision=revision+1,updated_at=now() where id=s.id returning * into s;
  else
   perform sms_private.email_segment_validate(p->'definition');
   if coalesce(length(btrim(p->>'name')),0) not between 1 and 120 then raise exception 'Name the segment'; end if;
   if s.id is null then insert into sms_private.email_segments(tenant_id,name,definition,created_by) values(t,btrim(p->>'name'),p->'definition',actor) returning * into s;
   else update sms_private.email_segments set name=btrim(p->>'name'),definition=p->'definition',revision=revision+1,updated_at=now() where id=s.id returning * into s; end if;
  end if;
  result:=to_jsonb(s);
 elsif action='campaign_save' then
  if nullif(p->>'id','') is not null then
   select * into strict c from sms_private.email_campaigns where tenant_id=t and id=(p->>'id')::uuid for update;
   if c.revision is distinct from (p->>'revision')::integer then raise exception 'Campaign changed; reload' using errcode='40001'; end if;
   if c.status<>'draft' then raise exception 'Only draft campaigns can be edited'; end if;
  end if;
  if coalesce(length(btrim(p->>'name')),0) not between 1 and 120 then raise exception 'Name the campaign'; end if;
  if nullif(p->>'templateId','') is not null then perform sms_private.email_campaign_template_ok(t,(p->>'templateId')::uuid); end if;
  if nullif(p->>'segmentId','') is not null and not exists(select from sms_private.email_segments where tenant_id=t and id=(p->>'segmentId')::uuid and not archived) then raise exception 'Choose an active segment'; end if;
  if nullif(p->>'scheduledAt','') is not null and ((p->>'scheduledAt')::timestamptz<now()-interval '5 minutes' or (p->>'scheduledAt')::timestamptz>now()+interval '365 days') then raise exception 'Schedule a time within the next year'; end if;
  if c.id is null then insert into sms_private.email_campaigns(tenant_id,name,template_id,segment_id,scheduled_at,created_by)
   values(t,btrim(p->>'name'),nullif(p->>'templateId','')::uuid,nullif(p->>'segmentId','')::uuid,nullif(p->>'scheduledAt','')::timestamptz,actor) returning * into c;
  else update sms_private.email_campaigns set name=btrim(p->>'name'),template_id=nullif(p->>'templateId','')::uuid,segment_id=nullif(p->>'segmentId','')::uuid,
   scheduled_at=nullif(p->>'scheduledAt','')::timestamptz,revision=revision+1,updated_at=now() where id=c.id returning * into c; end if;
  result:=to_jsonb(c);
 elsif action in ('campaign_start','campaign_pause','campaign_resume','campaign_cancel') then
  select * into strict c from sms_private.email_campaigns where tenant_id=t and id=(p->>'id')::uuid for update;
  if c.revision is distinct from (p->>'revision')::integer then raise exception 'Campaign changed; reload' using errcode='40001'; end if;
  snd:=sms_private.email_sender_settings(t);
  if action in ('campaign_start','campaign_resume') and (not coalesce((snd->>'enabled')::boolean,false) or not coalesce((snd->>'ready')::boolean,false)
   or coalesce(length(btrim(snd->>'mailing_address')),0)=0 or not exists(select from public.sms_businesses where tenant_id=t and status='active')) then
   raise exception 'Enable email sending with a verified sender and mailing address first';
  end if;
  if action='campaign_start' then
   if c.status<>'draft' then raise exception 'This campaign has already started'; end if;
   if c.template_id is null or c.segment_id is null then raise exception 'Choose a template and segment'; end if;
   tpl:=sms_private.email_campaign_template_ok(t,c.template_id);
   select definition into strict d from sms_private.email_segments where tenant_id=t and id=c.segment_id and not archived;
   base:=greatest(coalesce(c.scheduled_at,now()),now());
   select time_zone into tz from public.sms_businesses where tenant_id=t;
   due:=sms_private.email_template_due(tpl->'definition',0,base,null,tz);
   if due is null then raise exception 'Template has no sendable first email'; end if;
   select count(*) into n from sms_private.email_segment_contacts(t,d);
   if n=0 then raise exception 'This segment has no contacts with an email address'; end if;
   if n>50000 then raise exception 'Segments are limited to 50,000 recipients per campaign'; end if;
   insert into sms_private.email_campaign_recipients(tenant_id,campaign_id,email,contact_id,status,skip_reason)
    select t,c.id,x.email,x.contact_id,case when r is null then 'queued' else 'skipped' end,r
    from sms_private.email_segment_contacts(t,d) x cross join lateral sms_private.email_campaign_skip_reason(t,x.email) r;
   if not exists(select from sms_private.email_campaign_recipients where campaign_id=c.id and status='queued') then raise exception 'No segment contact has recorded email consent'; end if;
   with runs as (
    insert into sms_private.email_enrollments(tenant_id,group_id,source_type,source_id,email,name,phone,rule_snapshot,next_run_at,template_id,template_version,
     contact_id,definition,context,origin_type,origin_id,event_key,purpose,trigger_at,step_index,campaign_id)
    select t,null,'email_template',gen_random_uuid(),r.email,coalesce(x.name,''),x.phone,
     jsonb_build_object('startHour',tpl->'definition'->'startHour','endHour',tpl->'definition'->'endHour'),due,c.template_id,(tpl->>'version')::integer,
     r.contact_id,tpl->'definition',jsonb_build_object('name',coalesce(x.name,''),'campaign',c.name),'campaign',c.id::text,c.id::text||':'||r.email,'marketing',base,0,c.id
    from sms_private.email_campaign_recipients r join public.sms_contacts x on x.tenant_id=t and x.id=r.contact_id
    where r.campaign_id=c.id and r.status='queued' returning id,email)
   update sms_private.email_campaign_recipients r set enrollment_id=runs.id from runs where r.campaign_id=c.id and r.email=runs.email;
   update sms_private.email_campaigns set status=case when base>now()+interval '1 minute' then 'scheduled' else 'sending' end,template_version=(tpl->>'version')::integer,
    started_at=now(),scheduled_at=base,revision=revision+1,updated_at=now() where id=c.id returning * into c;
  elsif action='campaign_pause' then
   if c.status not in ('scheduled','sending') then raise exception 'Only scheduled or sending campaigns can pause'; end if;
   update sms_private.email_enrollments set status='paused',pause_reason='CAMPAIGN_PAUSED',updated_at=now() where campaign_id=c.id and status='active';
   update sms_private.email_campaigns set status='paused',revision=revision+1,updated_at=now() where id=c.id returning * into c;
  elsif action='campaign_resume' then
   if c.status<>'paused' then raise exception 'Only paused campaigns can resume'; end if;
   -- The send guard re-checks consent, suppression and contact address for every message.
   update sms_private.email_enrollments set status='active',pause_reason=null,updated_at=now() where campaign_id=c.id and status='paused' and pause_reason='CAMPAIGN_PAUSED';
   update sms_private.email_campaigns set status=case when scheduled_at>now() then 'scheduled' else 'sending' end,revision=revision+1,updated_at=now() where id=c.id returning * into c;
  else
   if c.status in ('completed','cancelled') then raise exception 'This campaign has already finished'; end if;
   update sms_private.email_enrollments set status='cancelled',pause_reason=null,generation=generation+1,next_run_at=null,updated_at=now() where campaign_id=c.id and status in ('active','paused');
   update sms_private.email_campaigns set status='cancelled',completed_at=now(),revision=revision+1,updated_at=now() where id=c.id returning * into c;
  end if;
  result:=to_jsonb(c)||jsonb_build_object('counts',sms_private.email_campaign_counts(c.id));
 else raise exception 'Unknown campaign action'; end if;
 insert into sms_private.email_automation_operations values(t,actor,key,'campaign:'||action,p,result,now());
 return result;
end $$;
create function sms_private.email_campaigns(u text,t text,action text,p jsonb default '{}') returns jsonb
language plpgsql security definer set search_path='' as $$ begin
 perform sms_private.require_admin(u);
 if not exists(select from public.sms_businesses where tenant_id=t) then raise exception 'Unknown business'; end if;
 return sms_private.email_campaign_apply(t,u,action,p);
end $$;

-- Single-message claims leave campaign jobs to the batch path.
create or replace function sms_private.email_claim() returns jsonb
language plpgsql security definer set search_path='' as $$
declare j sms_private.email_jobs; selected_tenant text; begin
 if not pg_has_role(session_user,'sms_automation','member') then raise exception 'Worker role denied' using errcode='42501'; end if;
 perform sms_private.recover_email_jobs();
 select s.tenant_id into selected_tenant from sms_private.email_scheduler_state s
  where exists(select from sms_private.email_jobs x join sms_private.email_enrollments e on e.id=x.enrollment_id
   where e.tenant_id=s.tenant_id and e.campaign_id is null and x.status='pending' and x.due_at<=now())
  order by s.claimed_at,s.tenant_id limit 1 for update of s skip locked;
 if selected_tenant is null then return null; end if;
 select x.* into j from sms_private.email_jobs x join sms_private.email_enrollments e on e.id=x.enrollment_id
  where e.tenant_id=selected_tenant and e.campaign_id is null and x.status='pending' and x.due_at<=now()
  order by x.due_at,x.id limit 1 for update of x skip locked;
 if not found then return null; end if;
 update sms_private.email_scheduler_state set claimed_at=clock_timestamp() where tenant_id=selected_tenant;
 update sms_private.email_jobs set status='processing',attempts=attempts+1,
  lease_token=gen_random_uuid(),lease_until=now()+interval '90 seconds',updated_at=now()
  where id=j.id returning * into j;
 return to_jsonb(j);
end $$;

-- Claims up to 100 campaign jobs sharing one lease. A submitted batch whose members
-- returned to pending is replayed as-is before any new batch is formed.
create function sms_private.email_claim_batch() returns jsonb language plpgsql security definer set search_path='' as $$
declare b sms_private.email_send_batches; token uuid:=gen_random_uuid(); selected_tenant text; cid uuid; ids uuid[]; begin
 if not pg_has_role(session_user,'sms_automation','member') then raise exception 'Worker role denied' using errcode='42501'; end if;
 perform sms_private.recover_email_jobs();
 select sb.* into b from sms_private.email_send_batches sb where sb.status='submitted'
  and exists(select from sms_private.email_jobs j where j.batch_id=sb.id and j.status='pending' and j.due_at<=now())
  and not exists(select from sms_private.email_jobs j where j.batch_id=sb.id and j.status='processing')
  order by sb.submitted_at,sb.id limit 1 for update of sb skip locked;
 if b.id is not null then
  update sms_private.email_jobs set status='processing',attempts=attempts+1,lease_token=token,lease_until=now()+interval '120 seconds',updated_at=now()
   where batch_id=b.id and status='pending';
  update sms_private.email_send_batches set lease_token=token,attempts=attempts+1,updated_at=now() where id=b.id returning * into b;
  return jsonb_build_object('batch',to_jsonb(b),'resume',true,'jobs',(select jsonb_agg(to_jsonb(j) order by j.id) from sms_private.email_jobs j where j.batch_id=b.id and j.lease_token=token and j.status='processing'));
 end if;
 select s.tenant_id into selected_tenant from sms_private.email_scheduler_state s
  where exists(select from sms_private.email_jobs x join sms_private.email_enrollments e on e.id=x.enrollment_id
   where e.tenant_id=s.tenant_id and e.campaign_id is not null and x.status='pending' and x.due_at<=now()
    and (x.batch_id is null or exists(select from sms_private.email_send_batches ob where ob.id=x.batch_id and ob.status='open')))
  order by s.claimed_at,s.tenant_id limit 1 for update of s skip locked;
 if selected_tenant is null then return null; end if;
 select e.campaign_id into cid from sms_private.email_jobs x join sms_private.email_enrollments e on e.id=x.enrollment_id
  where e.tenant_id=selected_tenant and e.campaign_id is not null and x.status='pending' and x.due_at<=now()
   and (x.batch_id is null or exists(select from sms_private.email_send_batches ob where ob.id=x.batch_id and ob.status='open'))
  order by x.due_at,x.id limit 1;
 select array_agg(id) into ids from (select x.id from sms_private.email_jobs x join sms_private.email_enrollments e on e.id=x.enrollment_id
  where e.campaign_id=cid and x.status='pending' and x.due_at<=now()
   and (x.batch_id is null or exists(select from sms_private.email_send_batches ob where ob.id=x.batch_id and ob.status='open'))
  order by x.due_at,x.id limit 100 for update of x skip locked) q;
 update sms_private.email_scheduler_state set claimed_at=clock_timestamp() where tenant_id=selected_tenant;
 if ids is null then return null; end if;
 insert into sms_private.email_send_batches(tenant_id,campaign_id,lease_token,attempts) values(selected_tenant,cid,token,1) returning * into b;
 update sms_private.email_jobs set batch_id=b.id,status='processing',attempts=attempts+1,lease_token=token,lease_until=now()+interval '120 seconds',updated_at=now() where id=any(ids);
 return jsonb_build_object('batch',to_jsonb(b),'resume',false,'jobs',(select jsonb_agg(to_jsonb(j) order by j.due_at,j.id) from sms_private.email_jobs j where j.id=any(ids)));
end $$;

-- Freezes batch membership on first submission (only jobs that passed the send
-- guard) and returns the exact request to send. Later calls return the same request.
-- Job ids arrive as a JSON array so every database driver passes them unambiguously.
create function sms_private.email_batch_submit(bid uuid,token uuid,members jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare b sms_private.email_send_batches; ids uuid[]; begin
 if not pg_has_role(session_user,'sms_automation','member') then raise exception 'Worker role denied' using errcode='42501'; end if;
 select * into strict b from sms_private.email_send_batches where id=bid and lease_token=token for update;
 if b.status='open' then
  if jsonb_typeof(members) is distinct from 'array' then raise exception 'Invalid email batch'; end if;
  select array_agg(value::uuid) into ids from jsonb_array_elements_text(members);
  if ids is null or cardinality(ids) not between 1 and 100 or cardinality(ids)<>(select count(distinct x) from unnest(ids) x)
   or exists(select from unnest(ids) i where not exists(select from sms_private.email_jobs j where j.id=i and j.batch_id=bid and j.lease_token=token
    and j.status='processing' and j.lease_until>now() and j.send_started_at is not null and j.provider_payload is not null)) then raise exception 'Invalid email batch'; end if;
  update sms_private.email_send_batches set job_ids=ids,status='submitted',submitted_at=now(),updated_at=now() where id=bid returning * into b;
  update sms_private.email_jobs set batch_id=null where batch_id=bid and not (id=any(ids));
 elsif b.status<>'submitted' then raise exception 'Email batch already finished';
 elsif b.submitted_at<=now()-interval '23 hours' then raise exception 'Email batch is outside the provider retry horizon';
 end if;
 return jsonb_build_object('idempotencyKey','campaign-batch-'||b.id,'jobs',(select jsonb_agg(jsonb_build_object('id',j.id,'payload',j.provider_payload) order by array_position(b.job_ids,j.id)) from sms_private.email_jobs j where j.id=any(b.job_ids)));
end $$;
create function sms_private.email_batch_finish(bid uuid,token uuid,outcome text) returns void language plpgsql security definer set search_path='' as $$ begin
 if not pg_has_role(session_user,'sms_automation','member') then raise exception 'Worker role denied' using errcode='42501'; end if;
 if outcome not in ('sent','failed','retry') then raise exception 'Invalid batch outcome'; end if;
 update sms_private.email_send_batches set status=case when outcome='retry' then status else outcome end,updated_at=now() where id=bid and lease_token=token and status='submitted';
end $$;

create function sms_private.email_record_engagement(event_key text,provider text,kind text,link text default null) returns void
language plpgsql security definer set search_path='' as $$ begin
 if not pg_has_role(session_user,'sms_automation','member') then raise exception 'Worker role denied' using errcode='42501'; end if;
 if length(event_key) not between 1 and 200 or kind not in ('email.opened','email.clicked') or coalesce(length(provider),0) not between 1 and 200 then raise exception 'Invalid email engagement event'; end if;
 insert into sms_private.email_webhook_events(event_id,provider_id,event_type) values(event_key,provider,kind) on conflict do nothing;
 if not found then return; end if;
 insert into sms_private.email_engagement_events(event_key,provider_id,kind,url) values(event_key,provider,kind,case when link ~ '^https?://' then left(link,2000) end) on conflict do nothing;
 update sms_private.email_jobs set opened_at=coalesce(opened_at,now()),clicked_at=case when kind='email.clicked' then coalesce(clicked_at,now()) else clicked_at end,updated_at=now() where provider_id=provider;
end $$;

-- Campaign jobs get their own larger per-tick allowance so a big send cannot consume
-- the drip/booking allowance, and drips cannot starve a campaign.
create or replace function sms_private.dispatch_email_edge() returns integer
language plpgsql security definer set search_path='' as $$
declare bearer text; request_id bigint; capacity integer; tenant record; queued integer:=0; added integer; begin
 if not pg_try_advisory_xact_lock(720491323) then return 0; end if;
 -- Recovery must run even when no pending job can wake a worker.
 perform sms_private.recover_email_jobs();
 insert into sms_private.email_scheduler_state(tenant_id) select distinct tenant_id from sms_private.email_group_settings where enabled on conflict do nothing;
 for tenant in select st.tenant_id from sms_private.email_scheduler_state st
  where exists(select from sms_private.email_enrollments e left join sms_private.email_group_settings s on s.tenant_id=e.tenant_id and s.group_id=e.group_id
   where e.tenant_id=st.tenant_id and e.campaign_id is null and e.status='active' and e.next_run_at<=now() and (s.enabled or e.template_id is not null and exists(select from sms_private.email_business_settings bs where bs.tenant_id=e.tenant_id and bs.enabled))
    and not exists(select from sms_private.email_jobs j where j.enrollment_id=e.id and j.step_index=e.step_index and j.generation=e.generation))
  order by st.dispatched_at,st.tenant_id limit 32
 loop
  insert into sms_private.email_jobs(enrollment_id,step_index,generation,due_at)
   select e.id,e.step_index,e.generation,e.next_run_at from sms_private.email_enrollments e
   left join sms_private.email_group_settings s on s.tenant_id=e.tenant_id and s.group_id=e.group_id
   where e.tenant_id=tenant.tenant_id and e.campaign_id is null and e.status='active' and e.next_run_at<=now() and (s.enabled or e.template_id is not null and exists(select from sms_private.email_business_settings bs where bs.tenant_id=e.tenant_id and bs.enabled))
    and not exists(select from sms_private.email_jobs j where j.enrollment_id=e.id and j.step_index=e.step_index and j.generation=e.generation)
   order by e.next_run_at,e.id limit least(10,100-queued) on conflict do nothing;
  get diagnostics added=row_count; queued:=queued+added;
  update sms_private.email_scheduler_state set dispatched_at=clock_timestamp() where tenant_id=tenant.tenant_id;
  exit when queued>=100;
 end loop;
 update sms_private.email_campaigns set status='sending',updated_at=now() where status='scheduled' and scheduled_at<=now();
 update sms_private.email_campaigns c set status='completed',completed_at=now(),updated_at=now() where c.status='sending'
  and not exists(select from sms_private.email_enrollments e where e.campaign_id=c.id and e.status in ('active','paused'));
 queued:=0;
 -- Tenants whose oldest due campaign message has waited longest go first.
 for tenant in select e.tenant_id from sms_private.email_enrollments e join sms_private.email_campaigns c on c.id=e.campaign_id
  where c.status='sending' and e.status='active' and e.next_run_at<=now()
   and exists(select from sms_private.email_business_settings bs where bs.tenant_id=e.tenant_id and bs.enabled)
   and not exists(select from sms_private.email_jobs j where j.enrollment_id=e.id and j.step_index=e.step_index and j.generation=e.generation)
  group by e.tenant_id order by min(e.next_run_at),e.tenant_id limit 32
 loop
  insert into sms_private.email_jobs(enrollment_id,step_index,generation,due_at)
   select e.id,e.step_index,e.generation,e.next_run_at from sms_private.email_enrollments e join sms_private.email_campaigns c on c.id=e.campaign_id
   where e.tenant_id=tenant.tenant_id and c.status='sending' and e.status='active' and e.next_run_at<=now()
    and not exists(select from sms_private.email_jobs j where j.enrollment_id=e.id and j.step_index=e.step_index and j.generation=e.generation)
   order by e.next_run_at,e.id limit least(500,2000-queued) on conflict do nothing;
  get diagnostics added=row_count; queued:=queued+added;
  exit when queued>=2000;
 end loop;
 if not (select edge_enabled from sms_private.runtime) then return 0; end if;
 if not exists(select from sms_private.email_jobs where status='pending' and due_at<=now()) then return 0; end if;
 select v.decrypted_secret,c.max_concurrency into bearer,capacity from sms_private.edge_config c
  join vault.decrypted_secrets v on v.id=c.secret_id where c.queue='automation_jobs' and c.enabled;
 if bearer is null or (select count(*) from sms_private.edge_runs where queue='automation_jobs' and expires_at>now())>=capacity then return 0; end if;
 select net.http_post(url:='https://wxamwhfmelxqahkdtcci.supabase.co/functions/v1/email-worker',
  headers:=jsonb_build_object('Authorization','Bearer '||bearer,'Content-Type','application/json'),
  body:='{}'::jsonb,timeout_milliseconds:=60000) into request_id;
 return 1;
end $$;

revoke all on function sms_private.email_segment_validate(jsonb),sms_private.email_segment_rule(public.sms_contacts,jsonb),
 sms_private.email_segment_contacts(text,jsonb),sms_private.email_campaign_skip_reason(text,text),sms_private.email_segment_preview(text,jsonb),
 sms_private.email_campaign_template_ok(text,uuid),sms_private.email_campaign_counts(uuid),sms_private.email_campaign_read(text,jsonb),
 sms_private.email_campaign_apply(text,text,text,jsonb),sms_private.email_campaigns(text,text,text,jsonb),
 sms_private.email_claim_batch(),sms_private.email_batch_submit(uuid,uuid,jsonb),sms_private.email_batch_finish(uuid,uuid,text),
 sms_private.email_record_engagement(text,text,text,text) from public,anon,authenticated,service_role,sms_api,sms_sender,sms_ai,sms_automation;
grant execute on function sms_private.email_campaigns(text,text,text,jsonb) to sms_api;
grant execute on function sms_private.email_claim_batch(),sms_private.email_batch_submit(uuid,uuid,jsonb),sms_private.email_batch_finish(uuid,uuid,text),
 sms_private.email_record_engagement(text,text,text,text) to sms_automation;
