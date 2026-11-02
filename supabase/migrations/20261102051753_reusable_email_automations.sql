-- CRM-owned forward migration. Requires the existing paired CRM/E2 access baseline.
-- Apply before E2 20261102051756_customer_email_service; never replay either history.
create table sms_private.email_templates (
 id uuid primary key default gen_random_uuid(), tenant_id text not null references public.sms_businesses(tenant_id),
 name text not null check(length(btrim(name)) between 1 and 120), draft jsonb not null,
 revision integer not null default 1, published_version integer, archived boolean not null default false,
 created_at timestamptz not null default now(), unique(tenant_id,id)
);
create table sms_private.email_template_versions (
 tenant_id text not null, template_id uuid not null, version integer not null, definition jsonb not null,
 created_at timestamptz not null default now(), primary key(tenant_id,template_id,version),
 foreign key(tenant_id,template_id) references sms_private.email_templates(tenant_id,id)
);
create table sms_private.email_sender_domains (
 id uuid primary key default gen_random_uuid(), tenant_id text references public.sms_businesses(tenant_id),
 domain text not null unique check(domain='e2local.com' or domain ~ '^[a-z0-9][a-z0-9-]{0,61}[a-z0-9][.]e2local[.]com$'),
 provider_id text, status text not null default 'pending' check(status in ('pending','verified','failed')),
 records jsonb not null default '[]', error_code text, revision integer not null default 1,
 operation_token uuid, operation_until timestamptz, checked_at timestamptz,
 check((domain='e2local.com')=(tenant_id is null))
);
create index email_sender_tenant on sms_private.email_sender_domains(tenant_id);
insert into sms_private.email_sender_domains(domain) values('e2local.com');
create table sms_private.email_business_settings (
 tenant_id text primary key references public.sms_businesses(tenant_id), enabled boolean not null default false,
 domain_id uuid references sms_private.email_sender_domains(id), reply_to text not null default 'hello@e2local.com',
 mailing_address text not null default '', revision integer not null default 1
);
create index email_settings_domain on sms_private.email_business_settings(domain_id);
create table sms_private.email_connections (
 id uuid primary key default gen_random_uuid(), tenant_id text not null, template_id uuid not null,
 event text not null check(event in ('form.submitted','contact.opted_in','booking.confirmed','booking.changed','booking.cancelled')),
 form_id uuid, enabled boolean not null default false, replace_legacy boolean not null default false,
 revision integer not null default 1,
 foreign key(tenant_id,template_id) references sms_private.email_templates(tenant_id,id),
 foreign key(tenant_id,form_id) references public.sms_web_form_definitions(tenant_id,public_id),
 check((event='form.submitted')=(form_id is not null)), unique(tenant_id,id)
);
create index email_connections_template on sms_private.email_connections(tenant_id,template_id);
create index email_connections_event on sms_private.email_connections(tenant_id,event,form_id) where enabled;
create unique index email_connection_source on sms_private.email_connections(tenant_id,template_id,event,coalesce(form_id::text,''));
create table sms_private.email_permissions (
 tenant_id text not null references public.sms_businesses(tenant_id), email text not null,
 consent boolean not null, evidence text not null, updated_at timestamptz not null default now(), primary key(tenant_id,email)
);
create table sms_private.email_permission_events (
 id uuid primary key default gen_random_uuid(), tenant_id text not null references public.sms_businesses(tenant_id),
 email text not null, consent boolean not null, evidence text not null, actor text not null, created_at timestamptz not null default now()
);
create index email_permission_history on sms_private.email_permission_events(tenant_id,email,created_at desc);
create table sms_private.email_global_suppressions (email text primary key, reason text not null, created_at timestamptz not null default now());
insert into sms_private.email_global_suppressions(email,reason) select email,min(reason) from sms_private.email_suppressions
 where reason in ('email.bounced','email.complained','email.suppressed') group by email on conflict do nothing;
create table sms_private.email_automation_operations (
 tenant_id text not null, actor text not null, retry_key uuid not null, action text not null,
 payload jsonb not null, result jsonb not null, created_at timestamptz not null default now(), primary key(tenant_id,actor,retry_key)
);
alter table sms_private.email_enrollments alter column group_id drop not null;
alter table sms_private.email_enrollments add column template_id uuid, add column template_version integer,
 add column connection_id uuid, add column contact_id uuid, add column definition jsonb, add column context jsonb,
 add column origin_type text, add column origin_id text, add column event_key text, add column purpose text,
 add column trigger_at timestamptz,
 add foreign key(tenant_id,template_id,template_version) references sms_private.email_template_versions(tenant_id,template_id,version),
 add foreign key(tenant_id,connection_id) references sms_private.email_connections(tenant_id,id),
 add foreign key(tenant_id,contact_id) references public.sms_contacts(tenant_id,id),
 add check((template_id is null and group_id is not null) or (template_id is not null and group_id is null and definition is not null and purpose in ('marketing','service')));
create index email_run_template on sms_private.email_enrollments(tenant_id,template_id,template_version);
create index email_run_contact on sms_private.email_enrollments(tenant_id,contact_id);
create index email_run_connection on sms_private.email_enrollments(tenant_id,connection_id);
create index email_run_origin on sms_private.email_enrollments(tenant_id,origin_type,origin_id) where template_id is not null;
create unique index email_run_event on sms_private.email_enrollments(tenant_id,connection_id,event_key) where connection_id is not null;

create function sms_private.email_validate_definition(d jsonb) returns void language plpgsql set search_path='' as $$
declare s jsonb; b jsonb; x jsonb; token text; begin
 if jsonb_typeof(d) is distinct from 'object' or d->>'purpose' not in ('marketing','service') or d->>'purpose' is null
 or jsonb_typeof(d->'steps') is distinct from 'array' then raise exception 'Invalid email definition'; end if;
 if jsonb_array_length(d->'steps') not between 1 and 30 or length(d::text)>300000
 or coalesce((d->>'startHour')::integer,-1) not between 0 and 23 or coalesce((d->>'endHour')::integer,0) not between 1 and 24
 or (d->>'startHour')::integer >= (d->>'endHour')::integer then raise exception 'Invalid email steps or sending hours'; end if;
 for s in select value from jsonb_array_elements(d->'steps') loop
  if jsonb_typeof(s->'subject') is distinct from 'string' or coalesce(length(btrim(s->>'subject')),0) not between 1 and 200 or s->>'subject' ~ '[\r\n]'
   or coalesce(s->>'anchor','') not in ('event','appointment') or jsonb_typeof(s->'offsetMinutes') is distinct from 'number'
   or (s->>'offsetMinutes')::numeric <> trunc((s->>'offsetMinutes')::numeric) or abs((s->>'offsetMinutes')::numeric)>525600
   or s->>'anchor'='event' and (s->>'offsetMinutes')::integer<0
   or jsonb_typeof(s->'document') is distinct from 'array' then raise exception 'Invalid email step'; end if;
  if length((s->'document')::text)>10000 or jsonb_array_length(s->'document') not between 1 and 100 then raise exception 'Invalid email content'; end if;
  if not exists(select from jsonb_array_elements(s->'document') blocks cross join lateral jsonb_array_elements(blocks->'content') spans where length(btrim(spans->>'text'))>0) then raise exception 'Add email body text'; end if;
  for b in select value from jsonb_array_elements(s->'document') loop
   if coalesce(b->>'type','') not in ('paragraph','heading','bullet') or jsonb_typeof(b->'content') is distinct from 'array' then raise exception 'Invalid email block'; end if;
   for x in select value from jsonb_array_elements(b->'content') loop
    if jsonb_typeof(x->'text') is distinct from 'string' or exists(select from jsonb_object_keys(x) k where k not in ('text','bold','italic','href'))
     or x ? 'href' and (x->>'href' !~ '^(https?://|mailto:)' or x->>'href' ~ '[\r\n]') then raise exception 'Invalid email text or link'; end if;
   end loop;
  end loop;
  for token in select btrim(m[1]) from regexp_matches(s::text,'\{\{([^{}]+)\}\}','g') m loop
   if token not in ('name','firstName','email','businessName','appointment','request','service') then raise exception 'Unknown email field: %',token; end if;
  end loop;
 end loop;
end $$;

create function sms_private.email_template_due(d jsonb,idx integer,started timestamptz,appointment timestamptz,tz text) returns timestamptz
language plpgsql stable set search_path='' as $$ declare s jsonb; base timestamptz; begin
 s:=d->'steps'->idx; if s is null then return null; end if;
 base:=case when s->>'anchor'='appointment' then appointment else started end;
 if base is null then return null; end if;
 base:=base+make_interval(mins=>(s->>'offsetMinutes')::integer);
 -- Never send a stale pre-appointment reminder immediately after a late enrollment.
 if s->>'anchor'='appointment' and (s->>'offsetMinutes')::integer<0 and base<now() then return null; end if;
 return sms_private.form_due(greatest(base,now()),0,'minute',tz,(d->>'startHour')::integer,(d->>'endHour')::integer);
end $$;
create function sms_private.email_sender_settings(t text) returns jsonb language sql stable set search_path='' as $$
 select jsonb_build_object('sender',regexp_replace(b.name,'[<>,;"\r\n]','','g')||' <hello@'||coalesce(d.domain,'e2local.com')||'>',
 'reply_to',s.reply_to,'mailing_address',s.mailing_address,'ready',coalesce(d.status='verified',false),'enabled',s.enabled,'providerId',d.provider_id,'checkedAt',d.checked_at)
 from sms_private.email_business_settings s join public.sms_businesses b on b.tenant_id=s.tenant_id
 left join sms_private.email_sender_domains d on d.id=coalesce(s.domain_id,(select id from sms_private.email_sender_domains where domain='e2local.com')) where s.tenant_id=t
$$;
create function sms_private.email_set_permission(t text,address text,choice boolean,evidence text,actor text) returns void
language plpgsql set search_path='' as $$ begin
 address:=lower(btrim(address)); if address !~ '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$' or length(address)>320 or coalesce(length(btrim(evidence)),0) not between 1 and 1500 then raise exception 'Email and consent evidence required'; end if;
 perform pg_advisory_xact_lock(hashtextextended('email:'||t||':'||address,0));
 insert into sms_private.email_permissions values(t,address,choice,evidence,now()) on conflict(tenant_id,email) do update set consent=excluded.consent,evidence=excluded.evidence,updated_at=now();
 insert into sms_private.email_permission_events(tenant_id,email,consent,evidence,actor) values(t,address,choice,evidence,actor);
 if not choice then
  insert into sms_private.email_suppressions(tenant_id,email,reason) values(t,address,'unsubscribe') on conflict(tenant_id,email) do nothing;
  update sms_private.email_enrollments set status='unsubscribed',pause_reason=null,generation=generation+1,next_run_at=null where tenant_id=t and email=address and status in ('active','paused') and (purpose='marketing' or template_id is null);
 end if;
end $$;
-- Existing recorded consent remains usable without enrolling historical records.
-- A new explicit choice is authoritative; a legacy historical event alone is insufficient.
create function sms_private.email_has_permission(t text,address text) returns boolean language sql stable set search_path='' as $$
 select case when exists(select from sms_private.email_permissions where tenant_id=t and email=address)
 then coalesce((select consent from sms_private.email_permissions where tenant_id=t and email=address),false)
 else exists(select from sms_private.email_consent_events e join (
  select tenant_id,id,'contacts' kind,email,email_opt_in from public.sms_automation_contacts union all
  select tenant_id,id,'quote_requests',email,email_opt_in from public.sms_automation_quote_requests union all
  select tenant_id,id,'bookings',email,email_opt_in from public.sms_automation_bookings union all
  select tenant_id,id,'reviews',email,email_opt_in from public.sms_automation_reviews
 ) s on s.tenant_id=e.tenant_id and s.id=e.source_id and s.kind=e.source_type
 where e.tenant_id=t and lower(btrim(e.email))=address and lower(btrim(s.email))=address and s.email_opt_in and length(btrim(e.evidence))>0) end
$$;
create function sms_private.email_start_template(t text,tid uuid,cid uuid,origin text,oid text,ek text,address text,customer text,ph text,contact uuid,ctx jsonb,appt timestamptz,fid uuid default null) returns uuid
language plpgsql set search_path='' as $$
declare a sms_private.email_templates; d jsonb; rid uuid; idx integer:=0; due timestamptz; tz text; begin
 address:=lower(btrim(address));
 perform pg_advisory_xact_lock(hashtextextended('email:'||t||':'||address,0));
 select * into a from sms_private.email_templates where tenant_id=t and id=tid and not archived;
 if a.published_version is null then return null; end if;
 select definition into d from sms_private.email_template_versions where tenant_id=t and template_id=tid and version=a.published_version;
 if not coalesce((sms_private.email_sender_settings(t)->>'enabled')::boolean,false) or not coalesce((sms_private.email_sender_settings(t)->>'ready')::boolean,false)
 or not exists(select from public.sms_businesses where tenant_id=t and status='active') or address is null or address !~ '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$'
 or exists(select from sms_private.email_global_suppressions where email=address) then return null; end if;
 if d->>'purpose'='service' and origin<>'booking' then raise exception 'Service templates require a booking event'; end if;
 if d->>'purpose'='marketing' and (not sms_private.email_has_permission(t,address)
 or exists(select from sms_private.email_suppressions where tenant_id=t and email=address)) then return null; end if;
 select time_zone into tz from public.sms_businesses where tenant_id=t;
 while idx<jsonb_array_length(d->'steps') loop
  due:=sms_private.email_template_due(d,idx,now(),appt,tz); exit when due is not null; idx:=idx+1;
 end loop;
 if due is null then return null; end if;
 insert into sms_private.email_enrollments(tenant_id,group_id,source_type,source_id,email,name,phone,rule_snapshot,appointment_at,next_run_at,template_id,template_version,connection_id,contact_id,definition,context,origin_type,origin_id,event_key,purpose,trigger_at,form_public_id,step_index)
 values(t,null,'email_template',gen_random_uuid(),address,coalesce(customer,''),ph,jsonb_build_object('startHour',d->'startHour','endHour',d->'endHour'),appt,due,tid,a.published_version,cid,contact,d,ctx,origin,oid,ek,d->>'purpose',now(),fid,idx)
 on conflict do nothing returning id into rid;
 if rid is null then select id into rid from sms_private.email_enrollments where tenant_id=t and connection_id=cid and event_key=ek; end if;
 return rid;
end $$;
create function sms_private.email_emit(t text,event_name text,oid text,ek text,address text,customer text,ph text,contact uuid,ctx jsonb,appt timestamptz,fid uuid default null) returns void
language plpgsql set search_path='' as $$ declare c sms_private.email_connections; begin
 for c in select * from sms_private.email_connections where tenant_id=t and event=event_name and enabled and form_id is not distinct from fid order by id loop
  perform sms_private.email_start_template(t,c.template_id,c.id,case when event_name like 'booking.%' then 'booking' when event_name='contact.opted_in' then 'contact' else 'form' end,oid,ek,address,customer,ph,contact,ctx,appt,fid);
 end loop;
end $$;

create function sms_private.email_automation_read(t text,p jsonb default '{}') returns jsonb language plpgsql set search_path='' as $$
declare rows jsonb; page integer:=greatest(1,least(10000,coalesce((p->>'page')::integer,1))); begin
 return jsonb_build_object('settings',coalesce((select to_jsonb(s) from sms_private.email_business_settings s where tenant_id=t),jsonb_build_object('enabled',false,'revision',0,'reply_to','hello@e2local.com','mailing_address','')),
 'sender',sms_private.email_sender_settings(t),
 'domains',coalesce((select jsonb_agg(jsonb_build_object('id',id,'domain',domain,'status',status,'error',error_code,'checkedAt',checked_at,'revision',revision) order by domain) from sms_private.email_sender_domains where tenant_id=t or tenant_id is null),'[]'),
 'templates',coalesce((select jsonb_agg(to_jsonb(x) order by x.created_at desc) from(select * from sms_private.email_templates where tenant_id=t order by created_at desc limit 100)x),'[]'),
 'connections',coalesce((select jsonb_agg(to_jsonb(x)) from(select * from sms_private.email_connections where tenant_id=t order by id limit 100)x),'[]'),
 'forms',coalesce((select jsonb_agg(jsonb_build_object('id',public_id,'name',title,'emailEnabled',email_enabled,'revision',version)) from(select * from public.sms_web_form_definitions where tenant_id=t and not archived order by title limit 100)x),'[]'),
 'contacts',coalesce((select jsonb_agg(jsonb_build_object('id',id,'name',name,'email',email,'revision',revision,'consent',sms_private.email_has_permission(t,lower(c.email)))) from(select * from public.sms_contacts where tenant_id=t and email is not null order by name,id limit 100)c),'[]'),
 'runs',coalesce((select jsonb_agg(to_jsonb(x)) from(select id,template_id,template_version,email,name,status,pause_reason,step_index,next_run_at,origin_type,origin_id,purpose,revision,generation from sms_private.email_enrollments where tenant_id=t and template_id is not null order by enrolled_at desc,id limit 25 offset (page-1)*25)x),'[]'),
 'jobs',coalesce((select jsonb_agg(to_jsonb(x)) from(select j.id,j.enrollment_id,j.subject,j.status,j.provider_status,j.error_code,j.created_at,e.email from sms_private.email_jobs j join sms_private.email_enrollments e on e.id=j.enrollment_id where e.tenant_id=t and e.template_id is not null order by j.created_at desc,j.id limit 25 offset (page-1)*25)x),'[]'),
 'page',page);
end $$;

create function sms_private.email_automation_apply(t text,actor text,action text,p jsonb) returns jsonb language plpgsql set search_path='' as $$
declare a sms_private.email_templates; c sms_private.email_connections; s sms_private.email_business_settings; r sms_private.email_enrollments; ct public.sms_contacts;
 result jsonb; saved sms_private.email_automation_operations; key uuid; d jsonb; j sms_private.email_jobs; was_consented boolean; begin
 if jsonb_typeof(p) is distinct from 'object' or length(p::text)>350000 then raise exception 'Invalid email request'; end if;
 if action='read' then return sms_private.email_automation_read(t,p); end if;
 if action='preview' then
  select * into strict a from sms_private.email_templates where tenant_id=t and id=(p->>'id')::uuid;
  if a.revision is distinct from (p->>'revision')::integer then raise exception 'Email template changed; reload' using errcode='40001'; end if;
  d:=coalesce(p->'definition',a.draft); perform sms_private.email_validate_definition(d);
  return jsonb_build_object('definition',d,'schedule',(select jsonb_agg(jsonb_build_object('step',n+1,'dueAt',sms_private.email_template_due(d,n,coalesce(nullif(p->>'startAt','')::timestamptz,now()),nullif(p->>'appointmentAt','')::timestamptz,(select time_zone from public.sms_businesses where tenant_id=t)))) from generate_series(0,jsonb_array_length(d->'steps')-1)n),'queued',false);
 end if;
 key:=(p->>'idempotencyKey')::uuid; if key is null then raise exception 'Retry identity required'; end if;
 perform pg_advisory_xact_lock(hashtextextended('email-operation:'||t||':'||actor||':'||key,0));
 select * into saved from sms_private.email_automation_operations where tenant_id=t and email_automation_operations.actor=email_automation_apply.actor and retry_key=key;
 if found then if saved.action<>action or saved.payload<>p then raise exception 'Retry identity already used'; end if; return saved.result; end if;
 if action in ('create','save','publish','archive','duplicate') then
  if action<>'create' then
   select * into strict a from sms_private.email_templates where tenant_id=t and id=(p->>'id')::uuid for update;
   if a.revision is distinct from (p->>'revision')::integer then raise exception 'Email template changed; reload' using errcode='40001'; end if;
  end if;
  if action in ('create','save') then
   perform sms_private.email_validate_definition(p->'definition');
   if action='create' then insert into sms_private.email_templates(tenant_id,name,draft) values(t,btrim(p->>'name'),p->'definition') returning * into a;
   else update sms_private.email_templates set name=btrim(p->>'name'),draft=p->'definition',revision=revision+1 where id=a.id returning * into a; end if;
  elsif action='publish' then
   if a.archived then raise exception 'Archived template'; end if;
   perform sms_private.email_validate_definition(a.draft);
   if a.draft->>'purpose'='service' and exists(select from sms_private.email_connections where template_id=a.id and enabled and event not like 'booking.%') then raise exception 'Disconnect non-booking connections before publishing a service template'; end if;
   insert into sms_private.email_template_versions values(t,a.id,coalesce(a.published_version,0)+1,a.draft,now());
   update sms_private.email_templates set published_version=coalesce(published_version,0)+1,revision=revision+1 where id=a.id returning * into a;
  elsif action='archive' then
   update sms_private.email_templates set archived=true,revision=revision+1 where id=a.id returning * into a;
  else insert into sms_private.email_templates(tenant_id,name,draft) values(t,left(a.name||' copy',120),a.draft) returning * into a;
  end if; result:=to_jsonb(a);
 elsif action='settings' then
  insert into sms_private.email_business_settings(tenant_id) values(t) on conflict do nothing;
  select * into strict s from sms_private.email_business_settings where tenant_id=t for update;
  if not p ? 'revision' or s.revision is distinct from greatest(1,(p->>'revision')::integer) then raise exception 'Email settings changed; reload' using errcode='40001'; end if;
  if jsonb_typeof(p->'enabled') is distinct from 'boolean' or coalesce(p->>'replyTo','') !~ '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$' or length(p->>'replyTo')>320 or coalesce(length(btrim(p->>'mailingAddress')),0)>300 then raise exception 'Invalid email settings'; end if;
  if nullif(p->>'domainId','') is not null and not exists(select from sms_private.email_sender_domains where id=(p->>'domainId')::uuid and (tenant_id=t or tenant_id is null) and status='verified') then raise exception 'Choose a verified business sender'; end if;
  if (p->>'enabled')::boolean and (coalesce(length(btrim(p->>'mailingAddress')),0)=0 or not exists(select from sms_private.email_sender_domains where id=coalesce(nullif(p->>'domainId','')::uuid,(select id from sms_private.email_sender_domains where domain='e2local.com')) and status='verified')
   or not exists(select from sms_private.edge_config where queue='automation_jobs' and enabled and secret_id is not null)) then raise exception 'Verify sender, worker and mailing address before activation'; end if;
  update sms_private.email_business_settings set enabled=(p->>'enabled')::boolean,domain_id=nullif(p->>'domainId','')::uuid,reply_to=lower(btrim(p->>'replyTo')),mailing_address=btrim(p->>'mailingAddress'),revision=revision+1 where tenant_id=t returning * into s;
  result:=to_jsonb(s);
 elsif action='form_consent' then
  perform 1 from public.sms_web_form_definitions where tenant_id=t and public_id=(p->>'formId')::uuid and version=(p->>'revision')::integer and not archived for update;
  if not found then raise exception 'Form changed; reload' using errcode='40001'; end if;
  if jsonb_typeof(p->'enabled') is distinct from 'boolean' then raise exception 'Choose email consent'; end if;
  update public.sms_web_form_definitions set email_enabled=(p->>'enabled')::boolean where tenant_id=t and public_id=(p->>'formId')::uuid and email_enabled is distinct from (p->>'enabled')::boolean;
  if found then update sms_private.mcp_form_drafts set base_revision=(p->>'revision')::integer+1,revision=revision+1,updated_at=now() where tenant_id=t and form_id=(p->>'formId')::uuid and base_revision=(p->>'revision')::integer; end if;
  result:=jsonb_build_object('ok',true);
 elsif action='connection' then
  select * into strict a from sms_private.email_templates where tenant_id=t and id=(p->>'templateId')::uuid for share;
  if a.archived or a.published_version is null then raise exception 'Publish the template first'; end if;
  select definition into d from sms_private.email_template_versions where tenant_id=t and template_id=a.id and version=a.published_version;
  if d->>'purpose'='service' and coalesce(p->>'event','') not like 'booking.%' then raise exception 'Service templates require booking events'; end if;
  if nullif(p->>'formId','') is not null and not exists(select from public.sms_web_form_definitions where tenant_id=t and public_id=(p->>'formId')::uuid and not archived) then raise exception 'Unknown business form'; end if;
  if p ? 'id' and nullif(p->>'id','') is not null then
   select * into strict c from sms_private.email_connections where tenant_id=t and id=(p->>'id')::uuid for update;
   if c.revision is distinct from (p->>'revision')::integer then raise exception 'Email connection changed; reload' using errcode='40001'; end if;
  end if;
  if coalesce((p->>'enabled')::boolean,false) and not coalesce((p->>'replaceLegacy')::boolean,false) and exists(select from sms_private.email_group_settings where tenant_id=t and enabled) then raise exception 'Confirm replacement of overlapping legacy email routing'; end if;
  if c.id is null then insert into sms_private.email_connections(tenant_id,template_id,event,form_id,enabled,replace_legacy) values(t,a.id,p->>'event',nullif(p->>'formId','')::uuid,coalesce((p->>'enabled')::boolean,false),coalesce((p->>'replaceLegacy')::boolean,false)) returning * into c;
  else update sms_private.email_connections set template_id=a.id,event=p->>'event',form_id=nullif(p->>'formId','')::uuid,enabled=coalesce((p->>'enabled')::boolean,false),replace_legacy=coalesce((p->>'replaceLegacy')::boolean,false),revision=revision+1 where id=c.id returning * into c; end if;
  if not c.enabled then update sms_private.email_enrollments set status='cancelled',generation=generation+1,next_run_at=null where tenant_id=t and connection_id=c.id and status in ('active','paused'); end if;
  result:=to_jsonb(c);
 elsif action='consent' then
  select * into strict ct from public.sms_contacts where tenant_id=t and id=(p->>'contactId')::uuid for share;
  if ct.revision is distinct from (p->>'contactRevision')::integer then raise exception 'Contact changed; reload' using errcode='40001'; end if;
  if jsonb_typeof(p->'consent') is distinct from 'boolean' then raise exception 'Choose email consent'; end if;
  perform pg_advisory_xact_lock(hashtextextended('email:'||t||':'||lower(btrim(ct.email)),0));
  was_consented:=exists(select from sms_private.email_permissions where tenant_id=t and email=lower(btrim(ct.email)) and consent);
  perform sms_private.email_set_permission(t,ct.email,(p->>'consent')::boolean,p->>'evidence',actor);
  if (p->>'consent')::boolean and not was_consented then perform sms_private.email_emit(t,'contact.opted_in',ct.id::text,key::text,ct.email,ct.name,ct.phone,ct.id,jsonb_build_object('name',ct.name),null); end if;
  result:=jsonb_build_object('ok',true);
 elsif action='start' then
  select * into strict ct from public.sms_contacts where tenant_id=t and id=(p->>'contactId')::uuid for share;
  if ct.revision is distinct from (p->>'contactRevision')::integer then raise exception 'Contact changed; reload' using errcode='40001'; end if;
  if exists(select from sms_private.email_template_versions v join sms_private.email_templates et on et.id=v.template_id and et.published_version=v.version where et.tenant_id=t and et.id=(p->>'templateId')::uuid and (v.definition->>'purpose'='service' or exists(select from jsonb_array_elements(v.definition->'steps') st where st->>'anchor'='appointment'))) then raise exception 'This template requires a booking event'; end if;
  result:=jsonb_build_object('runId',sms_private.email_start_template(t,(p->>'templateId')::uuid,null,'contact',ct.id::text,key::text,ct.email,ct.name,ct.phone,ct.id,jsonb_build_object('name',ct.name,'request',left(coalesce(p->>'request',''),1600)),null));
  if result->>'runId' is null then raise exception 'Email cannot start: check activation, sender, consent and suppression'; end if;
 elsif action in ('pause','resume','stop','retry') then
  select * into strict r from sms_private.email_enrollments where tenant_id=t and id=(p->>'runId')::uuid and template_id is not null for update;
  if r.revision is distinct from (p->>'revision')::integer or r.generation is distinct from (p->>'generation')::integer then raise exception 'Email run changed; reload' using errcode='40001'; end if;
  if action='stop' then update sms_private.email_enrollments set status='cancelled',generation=generation+1,next_run_at=null where id=r.id returning * into r;
  elsif action='pause' and r.status='active' then update sms_private.email_enrollments set status='paused',pause_reason='STAFF_PAUSED' where id=r.id returning * into r;
  elsif action in ('resume','retry') and r.status='paused' then
   if not coalesce((sms_private.email_sender_settings(t)->>'enabled')::boolean,false) or not coalesce((sms_private.email_sender_settings(t)->>'ready')::boolean,false)
    or exists(select from sms_private.email_global_suppressions where email=r.email)
    or r.purpose='marketing' and (not sms_private.email_has_permission(t,r.email) or exists(select from sms_private.email_suppressions where tenant_id=t and email=r.email))
    or r.contact_id is not null and not exists(select from public.sms_contacts where tenant_id=t and id=r.contact_id and lower(email)=r.email)
    or r.connection_id is not null and not exists(select from sms_private.email_connections where id=r.connection_id and enabled)
    or r.form_public_id is not null and not exists(select from public.sms_web_form_definitions where public_id=r.form_public_id and enabled and not archived and email_enabled)
   then raise exception 'Email cannot resume: check activation, recipient, consent and suppression'; end if;
   if exists(select from sms_private.email_jobs where enrollment_id=r.id and generation=r.generation and (status='uncertain' or send_started_at<=now()-interval '23 hours')) then raise exception 'Reconcile provider outcome before resuming'; end if;
   update sms_private.email_jobs set status='pending',attempts=0,error_code=null,due_at=now() where enrollment_id=r.id and generation=r.generation and step_index=r.step_index and status='failed';
   update sms_private.email_enrollments set status='active',pause_reason=null where id=r.id returning * into r;
  else raise exception 'Email run cannot perform this action'; end if;
  result:=jsonb_build_object('id',r.id,'status',r.status,'revision',r.revision,'generation',r.generation);
 else raise exception 'Unknown email action'; end if;
 insert into sms_private.email_automation_operations values(t,actor,key,action,p,result,now());
 return result;
end $$;
create function sms_private.email_automations(u text,t text,action text,p jsonb default '{}') returns jsonb
language plpgsql security definer set search_path='' as $$ begin
 perform sms_private.require_admin(u);
 if not exists(select from public.sms_businesses where tenant_id=t) then raise exception 'Unknown business'; end if;
 return sms_private.email_automation_apply(t,u,action,p);
end $$;

-- Reuse existing enrollment/job infrastructure, with explicit branches for immutable templates.
alter function sms_private.email_job_context(uuid,uuid) rename to email_job_context_before_templates;
create function sms_private.email_job_context(jid uuid,token uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare j sms_private.email_jobs; e sms_private.email_enrollments; begin
 if not pg_has_role(session_user,'sms_automation','member') then raise exception 'Worker role denied' using errcode='42501'; end if;
 select * into strict j from sms_private.email_jobs where id=jid and lease_token=token and status='processing' and lease_until>now();
 select * into strict e from sms_private.email_enrollments where id=j.enrollment_id;
 if e.template_id is null then return sms_private.email_job_context_before_templates(jid,token); end if;
 return jsonb_build_object('job',to_jsonb(j),'enrollment',to_jsonb(e),'settings',sms_private.email_sender_settings(e.tenant_id),'source',e.context,
 'business',(select jsonb_build_object('name',name,'timeZone',time_zone) from public.sms_businesses where tenant_id=e.tenant_id),
 'step',e.definition->'steps'->e.step_index,'template',true);
end $$;
alter function sms_private.email_save_payload(uuid,uuid,jsonb) rename to email_save_payload_before_templates;
create function sms_private.email_save_payload(jid uuid,token uuid,p jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare j sms_private.email_jobs; e sms_private.email_enrollments; s jsonb; begin
 if not pg_has_role(session_user,'sms_automation','member') then raise exception 'Worker role denied' using errcode='42501'; end if;
 select * into strict j from sms_private.email_jobs where id=jid and lease_token=token and status='processing' and lease_until>now() for update;
 select * into strict e from sms_private.email_enrollments where id=j.enrollment_id;
 if e.template_id is null then return sms_private.email_save_payload_before_templates(jid,token,p); end if;
 s:=sms_private.email_sender_settings(e.tenant_id);
 if jsonb_typeof(p) is distinct from 'object' or length(p::text)>100000 or p->>'to' is distinct from e.email or p->>'from' is distinct from s->>'sender'
 or p->>'reply_to' is distinct from s->>'reply_to' or p->>'subject' is distinct from j.subject or coalesce(length(p->>'html'),0)<100 or coalesce(length(p->>'text'),0)<10 then raise exception 'Invalid email payload'; end if;
 update sms_private.email_jobs set provider_payload=coalesce(provider_payload,p),updated_at=now() where id=jid returning * into j; return to_jsonb(j);
end $$;
alter function sms_private.email_before_send(uuid,uuid) rename to email_before_send_before_templates;
create function sms_private.email_before_send(jid uuid,token uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare j sms_private.email_jobs; e sms_private.email_enrollments; s jsonb; due timestamptz; tz text; reason text; lock_key text; begin
 if not pg_has_role(session_user,'sms_automation','member') then raise exception 'Worker role denied' using errcode='42501'; end if;
 select 'email:'||ee.tenant_id||':'||ee.email into lock_key from sms_private.email_enrollments ee join sms_private.email_jobs jj on jj.enrollment_id=ee.id where jj.id=jid;
 perform pg_advisory_xact_lock(hashtextextended(lock_key,0));
 select * into strict j from sms_private.email_jobs where id=jid and lease_token=token and status='processing' and lease_until>now() for update;
 select * into strict e from sms_private.email_enrollments where id=j.enrollment_id for update;
 if e.template_id is null then return sms_private.email_before_send_before_templates(jid,token); end if;
 if e.status='paused' and e.generation=j.generation and e.step_index=j.step_index then
  update sms_private.email_jobs set status='pending',error_code='RUN_PAUSED',due_at=now()+interval '5 minutes',attempts=greatest(0,attempts-1),lease_token=null,lease_until=null where id=jid; return null;
 end if;
 s:=sms_private.email_sender_settings(e.tenant_id);
 if e.status<>'active' or e.generation<>j.generation or e.step_index<>j.step_index
 or not exists(select from public.sms_businesses where tenant_id=e.tenant_id and status='active')
 or e.connection_id is not null and not exists(select from sms_private.email_connections where id=e.connection_id and enabled)
 or e.form_public_id is not null and not exists(select from public.sms_web_form_definitions where public_id=e.form_public_id and enabled and not archived and email_enabled)
 or e.contact_id is not null and not exists(select from public.sms_contacts where tenant_id=e.tenant_id and id=e.contact_id and lower(email)=e.email)
 or exists(select from sms_private.email_global_suppressions where email=e.email)
 or e.purpose='marketing' and (not sms_private.email_has_permission(e.tenant_id,e.email) or exists(select from sms_private.email_suppressions where tenant_id=e.tenant_id and email=e.email))
 then reason:='INELIGIBLE'; end if;
 if reason is not null then
  update sms_private.email_jobs set status='cancelled',error_code=reason,lease_token=null,lease_until=null where id=jid;
  update sms_private.email_enrollments set status='cancelled',pause_reason=null,generation=generation+1,next_run_at=null where id=e.id and generation=j.generation and step_index=j.step_index and status='active';
  return null;
 end if;
 if not coalesce((s->>'enabled')::boolean,false) then reason:='EMAIL_DISABLED';
 elsif not coalesce((s->>'ready')::boolean,false) then reason:='SENDER_NOT_VERIFIED';
 elsif j.provider_payload->>'from' is distinct from s->>'sender' or j.provider_payload->>'reply_to' is distinct from s->>'reply_to' then reason:='SENDER_CHANGED'; end if;
 if reason is not null then
  if reason='SENDER_CHANGED' and j.send_started_at is null then update sms_private.email_jobs set provider_payload=null where id=jid; end if;
  update sms_private.email_jobs set status='pending',error_code=reason,due_at=now()+interval '5 minutes',attempts=greatest(0,attempts-1),lease_token=null,lease_until=null where id=jid; return null;
 end if;
 if j.send_started_at<=now()-interval '23 hours' then
  update sms_private.email_jobs set status='uncertain',error_code='PROVIDER_OUTCOME_UNKNOWN',lease_token=null,lease_until=null where id=jid;
  update sms_private.email_enrollments set status='paused',pause_reason='PROVIDER_OUTCOME_UNKNOWN' where id=e.id; return null;
 end if;
 select time_zone into tz from public.sms_businesses where tenant_id=e.tenant_id;
 due:=sms_private.form_due(now(),0,'minute',tz,(e.definition->>'startHour')::integer,(e.definition->>'endHour')::integer);
 if e.origin_type='booking' and e.definition->'steps'->e.step_index->>'anchor'='appointment' and (e.definition->'steps'->e.step_index->>'offsetMinutes')::integer<0 and now()>=e.appointment_at then
  update sms_private.email_jobs set status='cancelled',error_code='APPOINTMENT_PASSED',lease_token=null,lease_until=null where id=jid;
  update sms_private.email_enrollments set status='cancelled',next_run_at=null,generation=generation+1 where id=e.id; return null;
 end if;
 if due>now() then update sms_private.email_jobs set status='pending',due_at=due,error_code='OUTSIDE_WINDOW',attempts=greatest(0,attempts-1),lease_token=null,lease_until=null where id=jid; return null; end if;
 if j.subject is null or j.body is null or j.provider_payload is null then raise exception 'Email payload missing'; end if;
 update sms_private.email_jobs set send_started_at=coalesce(send_started_at,now()) where id=jid returning * into j;
 return jsonb_build_object('job',to_jsonb(j));
end $$;
alter function sms_private.email_finish(uuid,uuid,text,text,text) rename to email_finish_before_templates;
create function sms_private.email_finish(jid uuid,token uuid,outcome text,provider text default null,code text default null) returns void language plpgsql security definer set search_path='' as $$
declare j sms_private.email_jobs; e sms_private.email_enrollments; idx integer; due timestamptz; tz text; begin
 if not pg_has_role(session_user,'sms_automation','member') then raise exception 'Worker role denied' using errcode='42501'; end if;
 select * into strict j from sms_private.email_jobs where id=jid and lease_token=token and status='processing' and lease_until>now() for update;
 select * into strict e from sms_private.email_enrollments where id=j.enrollment_id for update;
 if e.template_id is null then perform sms_private.email_finish_before_templates(jid,token,outcome,provider,code); return; end if;
 if outcome not in ('sent','retry','failed','uncertain') then raise exception 'Invalid email outcome'; end if;
 select time_zone into tz from public.sms_businesses where tenant_id=e.tenant_id;
 update sms_private.email_jobs set status=case when outcome='retry' and attempts<5 then 'pending' when outcome='retry' then 'failed' else outcome end,
 due_at=case when outcome='retry' then sms_private.form_due(now()+make_interval(secs=>least(3600,30*(2^least(j.attempts,10))::integer)),0,'minute',tz,(e.definition->>'startHour')::integer,(e.definition->>'endHour')::integer) else due_at end,
 provider_id=coalesce(provider_id,provider),error_code=code,lease_token=null,lease_until=null where id=jid;
 if e.generation<>j.generation or e.status not in ('active','paused') then return; end if;
 if outcome<>'sent' then
  if outcome in ('failed','uncertain') or j.attempts>=5 then update sms_private.email_enrollments set status='paused',pause_reason=coalesce(code,'EMAIL_FAILED') where id=e.id; end if; return;
 end if;
 idx:=e.step_index+1;
 while idx<jsonb_array_length(e.definition->'steps') loop due:=sms_private.email_template_due(e.definition,idx,e.trigger_at,e.appointment_at,tz); exit when due is not null; idx:=idx+1; end loop;
 update sms_private.email_enrollments set step_index=idx,status=case when due is null then 'completed' else e.status end,next_run_at=due where id=e.id;
end $$;
create or replace function sms_private.dispatch_email_edge() returns integer
language plpgsql security definer set search_path='' as $$
declare bearer text; request_id bigint; capacity integer; tenant record; queued integer:=0; added integer; begin
 if not pg_try_advisory_xact_lock(720491323) then return 0; end if;
 -- Recovery must run even when no pending job can wake a worker.
 perform sms_private.recover_email_jobs();
 insert into sms_private.email_scheduler_state(tenant_id) select distinct tenant_id from sms_private.email_group_settings where enabled on conflict do nothing;
 for tenant in select st.tenant_id from sms_private.email_scheduler_state st
  where exists(select from sms_private.email_enrollments e left join sms_private.email_group_settings s on s.tenant_id=e.tenant_id and s.group_id=e.group_id
   where e.tenant_id=st.tenant_id and e.status='active' and e.next_run_at<=now() and (s.enabled or e.template_id is not null and exists(select from sms_private.email_business_settings bs where bs.tenant_id=e.tenant_id and bs.enabled))
    and not exists(select from sms_private.email_jobs j where j.enrollment_id=e.id and j.step_index=e.step_index and j.generation=e.generation))
  order by st.dispatched_at,st.tenant_id limit 32
 loop
  insert into sms_private.email_jobs(enrollment_id,step_index,generation,due_at)
   select e.id,e.step_index,e.generation,e.next_run_at from sms_private.email_enrollments e
   left join sms_private.email_group_settings s on s.tenant_id=e.tenant_id and s.group_id=e.group_id
   where e.tenant_id=tenant.tenant_id and e.status='active' and e.next_run_at<=now() and (s.enabled or e.template_id is not null and exists(select from sms_private.email_business_settings bs where bs.tenant_id=e.tenant_id and bs.enabled))
    and not exists(select from sms_private.email_jobs j where j.enrollment_id=e.id and j.step_index=e.step_index and j.generation=e.generation)
   order by e.next_run_at,e.id limit least(10,100-queued) on conflict do nothing;
  get diagnostics added=row_count; queued:=queued+added;
  update sms_private.email_scheduler_state set dispatched_at=clock_timestamp() where tenant_id=tenant.tenant_id;
  exit when queued>=100;
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

alter function sms_private.email_unsubscribe(uuid) rename to email_unsubscribe_before_templates;
create function sms_private.email_unsubscribe(token uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare e sms_private.email_enrollments; begin
 select * into e from sms_private.email_enrollments where unsubscribe_token=token;
 if e.id is not null and (e.template_id is null or e.purpose='marketing') then perform sms_private.email_set_permission(e.tenant_id,e.email,false,'One-click unsubscribe','public'); end if;
 return jsonb_build_object('ok',true);
end $$;
alter function sms_private.email_record_provider_event(text,text,text,text) rename to email_record_provider_event_before_templates;
create function sms_private.email_record_provider_event(event_key text,provider text,kind text,address text) returns void language plpgsql security definer set search_path='' as $$ begin
 perform sms_private.email_record_provider_event_before_templates(event_key,provider,kind,address);
 if kind in ('email.bounced','email.complained','email.suppressed') then
  insert into sms_private.email_global_suppressions values(lower(btrim(address)),kind,now()) on conflict do nothing;
  update sms_private.email_enrollments set status='cancelled',generation=generation+1,next_run_at=null where email=lower(btrim(address)) and template_id is not null and status in ('active','paused');
 end if;
end $$;

-- Public form wrapper retains the existing submission/SMS pipeline and fingerprints the full consent choice.
create table sms_private.email_form_receipts(form_id uuid not null,submission_id uuid not null,fingerprint text not null,primary key(form_id,submission_id));
alter function sms_private.submit_web_form(uuid,jsonb) rename to submit_web_form_before_email_templates;
create function sms_private.submit_web_form(fid uuid,p jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare f public.sms_web_form_definitions; result jsonb; fp text; prior text; opted boolean; ct uuid; ctx jsonb; begin
 select * into f from public.sms_web_form_definitions where public_id=fid and enabled and not archived for share;
 if f.public_id is null then raise exception 'Form unavailable'; end if;
 if p ? 'emailOptIn' and jsonb_typeof(p->'emailOptIn') is distinct from 'boolean' then raise exception 'Choose email consent'; end if;
 opted:=coalesce((p->>'emailOptIn')::boolean,false);
 if opted and not f.email_enabled then raise exception 'Email consent is not enabled'; end if;
 perform pg_advisory_xact_lock(hashtextextended('email-form:'||fid||':'||(p->>'submissionId'),0));
 fp:=md5((p-'honeypot')::text);
 select fingerprint into prior from sms_private.email_form_receipts where form_id=fid and submission_id=(p->>'submissionId')::uuid;
 if prior is not null and prior<>fp then raise exception 'Submission ID already used'; end if;
 result:=sms_private.submit_web_form_before_email_templates(fid,case when f.legacy_form then p else jsonb_set(p,'{emailOptIn}','false') end);
 if coalesce((result->>'duplicate')::boolean,false) then return result; end if;
 insert into sms_private.email_form_receipts values(fid,(p->>'submissionId')::uuid,fp);
 select id into ct from public.sms_contacts where tenant_id=f.tenant_id and phone=p->>'phone';
 ctx:=jsonb_build_object('name',p->>'name','request',coalesce(p->'details'->>'request',f.title),'service',coalesce(p->'details'->>'service',''),'fields',p->'details');
 if opted then
  perform sms_private.email_set_permission(f.tenant_id,p->>'email',true,sms_private.email_consent_text((select name from public.sms_businesses where tenant_id=f.tenant_id))||' | form='||fid||' version='||f.version,'form');
  perform sms_private.email_emit(f.tenant_id,'form.submitted',p->>'submissionId',p->>'submissionId',p->>'email',p->>'name',p->>'phone',ct,ctx,nullif(p->>'appointmentAt','')::timestamptz,fid);
 end if;
 return result;
end $$;
alter function sms_private.public_web_form(uuid) rename to public_web_form_before_email_templates;
create function sms_private.public_web_form(fid uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare result jsonb; begin
 result:=sms_private.public_web_form_before_email_templates(fid);
 return result||jsonb_build_object('emailEnabled',(select email_enabled from public.sms_web_form_definitions where public_id=fid),
 'emailConsentText',sms_private.email_consent_text(result->>'businessName'));
end $$;
-- Prevent duplicate legacy enrollment only for explicitly replaced sources.
alter function sms_private.email_enroll(text,text,text,uuid,text,text,text,text,uuid,timestamptz) rename to email_enroll_before_templates;
create function sms_private.email_enroll(t text,gid text,typ text,rid uuid,address text,customer_name text,customer_phone text,consent_text text,fid uuid default null,appointment timestamptz default null) returns uuid
language plpgsql security definer set search_path='' as $$ begin
 if exists(select from sms_private.email_connections where tenant_id=t and enabled and replace_legacy and
  (event='form.submitted' and (form_id=fid or exists(select from sms_private.email_consent_events e where e.tenant_id=t and e.source_id=rid and e.form_public_id=email_connections.form_id))
   or event like 'booking.%' and typ='bookings' or event='contact.opted_in' and typ='contacts')) then return null; end if;
 return sms_private.email_enroll_before_templates(t,gid,typ,rid,address,customer_name,customer_phone,consent_text,fid,appointment);
end $$;
create function sms_private.email_booking_changed() returns trigger language plpgsql security definer set search_path='' as $$
declare c public.sms_contacts; e sms_private.email_enrollments; event_name text; appt timestamptz; idx integer; due timestamptz; tz text; event_revision bigint; begin
 if tg_op='UPDATE' and new.status is not distinct from old.status and new.appointment_at is not distinct from old.appointment_at and new.contact_id is not distinct from old.contact_id then return new; end if;
 select * into strict c from public.sms_contacts where tenant_id=new.tenant_id and id=new.contact_id;
 if tg_op='UPDATE' then
  for e in select * from sms_private.email_enrollments where tenant_id=new.tenant_id and origin_type='booking' and origin_id=new.id and status in ('active','paused') order by id for update loop
   if new.status<>'confirmed' or new.contact_id<>old.contact_id then update sms_private.email_enrollments set status='cancelled',generation=generation+1,next_run_at=null where id=e.id;
   else
    select time_zone into tz from public.sms_businesses where tenant_id=new.tenant_id;
    idx:=e.step_index;
    while idx<jsonb_array_length(e.definition->'steps') loop
     due:=sms_private.email_template_due(e.definition,idx,e.trigger_at,new.appointment_at,tz); exit when due is not null; idx:=idx+1;
    end loop;
    update sms_private.email_enrollments set appointment_at=new.appointment_at,context=context||jsonb_build_object('appointmentAt',new.appointment_at),generation=generation+1,step_index=idx,next_run_at=due,status=case when due is null then 'completed' else status end where id=e.id;
   end if;
  end loop;
 end if;
 event_name:=case when new.status='cancelled' then 'booking.cancelled' when new.status='confirmed' and (tg_op='INSERT' or old.status<>'confirmed') then 'booking.confirmed' when new.status='confirmed' then 'booking.changed' end;
 if event_name is null then return new; end if;
 insert into sms_private.email_booking_revisions values(new.tenant_id,new.id,1) on conflict(tenant_id,booking_id) do update set revision=email_booking_revisions.revision+1 returning revision into event_revision;
 if new.status='confirmed' then update sms_private.email_enrollments set status='cancelled',generation=generation+1,next_run_at=null where tenant_id=new.tenant_id and template_id is not null and purpose='marketing' and origin_type in ('contact','form') and email=lower(c.email) and status in ('active','paused'); end if;
 perform sms_private.email_emit(new.tenant_id,event_name,new.id,event_name||':'||new.id||':'||event_revision,c.email,c.name,c.phone,c.id,
  jsonb_build_object('name',c.name,'appointmentAt',new.appointment_at,'service',coalesce(new.metadata->>'service',''),'request',coalesce(new.metadata->>'notes','')),new.appointment_at);
 return new;
end $$;
create table sms_private.email_booking_revisions(tenant_id text not null,booking_id text not null,revision bigint not null,primary key(tenant_id,booking_id));
create trigger email_booking_events after insert or update on public.sms_bookings for each row execute function sms_private.email_booking_changed();

do $$ declare tab text; f record; begin
 foreach tab in array array['email_templates','email_template_versions','email_sender_domains','email_business_settings','email_connections','email_permissions','email_permission_events','email_global_suppressions','email_automation_operations','email_form_receipts','email_booking_revisions'] loop
  execute format('alter table sms_private.%I enable row level security',tab);
  execute format('revoke all on sms_private.%I from public,anon,authenticated,service_role,sms_api,sms_automation,sms_form_public',tab);
 end loop;
 for f in select oid::regprocedure as name from pg_proc where pronamespace='sms_private'::regnamespace and (proname like 'email_%' or proname in ('dispatch_email_edge','dispatch_email_edge_before_templates','submit_web_form_before_email_templates','public_web_form_before_email_templates')) loop
  if f.name::text like '%before_templates%' or f.name::text like '%before_email_templates%' or f.name::text ~ 'email_(validate_definition|template_due|sender_settings|set_permission|has_permission|start_template|emit|automation_read|automation_apply|booking_changed)\(' then
   execute format('revoke all on function %s from public,anon,authenticated,service_role,sms_api,sms_automation,sms_form_public',f.name);
  end if;
 end loop;
end $$;
revoke all on function sms_private.email_automations(text,text,text,jsonb) from public,anon,authenticated,service_role;
grant execute on function sms_private.email_automations(text,text,text,jsonb) to sms_api;
revoke all on function sms_private.email_job_context(uuid,uuid),sms_private.email_save_payload(uuid,uuid,jsonb),sms_private.email_before_send(uuid,uuid),sms_private.email_finish(uuid,uuid,text,text,text),sms_private.dispatch_email_edge(),sms_private.email_record_provider_event(text,text,text,text) from public,anon,authenticated,sms_api,service_role;
grant execute on function sms_private.email_job_context(uuid,uuid),sms_private.email_save_payload(uuid,uuid,jsonb),sms_private.email_before_send(uuid,uuid),sms_private.email_finish(uuid,uuid,text,text,text),sms_private.email_record_provider_event(text,text,text,text) to sms_automation;
revoke all on function sms_private.submit_web_form(uuid,jsonb),sms_private.public_web_form(uuid),sms_private.email_unsubscribe(uuid),sms_private.email_enroll(text,text,text,uuid,text,text,text,text,uuid,timestamptz) from public,anon,authenticated,service_role,sms_api,sms_automation;
grant execute on function sms_private.submit_web_form(uuid,jsonb),sms_private.public_web_form(uuid),sms_private.email_unsubscribe(uuid) to sms_form_public;

-- Staff-only provider management; no HTTP route ever serializes the provider key.
create function sms_private.email_domain_control(u text,t text,action text,p jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$ declare d sms_private.email_sender_domains; slug text; begin
 perform sms_private.require_admin(u);
 if not exists(select from public.sms_businesses where tenant_id=t) then raise exception 'Unknown business'; end if;
 if action='key' then return to_jsonb((select v.decrypted_secret from sms_private.email_provider_secrets s join vault.decrypted_secrets v on v.id=s.secret_id where s.kind='resend_api')); end if;
 if action='begin' then
  if p->>'id' is not null then select * into strict d from sms_private.email_sender_domains where id=(p->>'id')::uuid and (tenant_id=t or tenant_id is null) for update;
  else
   slug:=lower(btrim(p->>'slug'));
   if slug is null or slug !~ '^[a-z0-9][a-z0-9-]{0,61}[a-z0-9]$' or slug in ('www','crm','api','mail','smtp','imap','pop','send','clerk','accounts','auth','admin','support','status','cdn','assets','hosting','links','notify','email','e2local') then raise exception 'Choose an available business subdomain (2–63 characters)'; end if;
   insert into sms_private.email_sender_domains(tenant_id,domain) values(t,slug||'.e2local.com') on conflict(domain) do nothing;
   select * into strict d from sms_private.email_sender_domains where domain=slug||'.e2local.com' and tenant_id=t for update;
  end if;
  if d.operation_until>now() then raise exception 'Sender setup is running; refresh shortly' using errcode='40001'; end if;
  update sms_private.email_sender_domains set operation_token=gen_random_uuid(),operation_until=now()+interval '2 minutes',revision=revision+1 where id=d.id returning * into d;
  return to_jsonb(d);
 elsif action='complete' then
  update sms_private.email_sender_domains set provider_id=coalesce(p->>'providerId',provider_id),status=p->>'status',records=coalesce(p->'records',records),error_code=p->>'error',checked_at=now(),operation_token=null,operation_until=null,revision=revision+1
   where id=(p->>'id')::uuid and (tenant_id=t or tenant_id is null) and operation_token=(p->>'token')::uuid returning * into d;
  if d.id is null then raise exception 'Sender operation changed; refresh' using errcode='40001'; end if;
  return jsonb_build_object('id',d.id,'domain',d.domain,'status',d.status,'error',d.error_code,'revision',d.revision);
 end if;
 raise exception 'Unknown sender operation';
end $$;
revoke all on function sms_private.email_domain_control(text,text,text,jsonb) from public,anon,authenticated,service_role,sms_automation;
grant execute on function sms_private.email_domain_control(text,text,text,jsonb) to sms_api;

create function sms_private.email_sender_verified(jid uuid,token uuid,verified boolean) returns void language plpgsql security definer set search_path='' as $$
declare t text; begin
 if not pg_has_role(session_user,'sms_automation','member') then raise exception 'Worker role denied' using errcode='42501'; end if;
 select e.tenant_id into strict t from sms_private.email_jobs j join sms_private.email_enrollments e on e.id=j.enrollment_id where j.id=jid and j.lease_token=token and j.status='processing' and j.lease_until>now() and e.template_id is not null;
 update sms_private.email_sender_domains set status=case when verified then 'verified' else 'pending' end,checked_at=now(),revision=revision+1 where id=(select coalesce(domain_id,(select id from sms_private.email_sender_domains where domain='e2local.com')) from sms_private.email_business_settings where tenant_id=t);
end $$;
revoke all on function sms_private.email_sender_verified(uuid,uuid,boolean) from public,anon,authenticated,sms_api,service_role;
grant execute on function sms_private.email_sender_verified(uuid,uuid,boolean) to sms_automation;

-- The existing MCP email catalog continues to describe legacy groups only.
create or replace function sms_private.mcp_email_action(u text,t text,tool text,p jsonb,cid uuid,rid uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
#variable_conflict use_column
declare f public.sms_web_form_definitions;d sms_private.mcp_form_drafts;cancelled integer:=0;s sms_private.email_group_settings;g public.sms_automation_groups;e sms_private.email_enrollments;j sms_private.email_jobs;
 pg integer:=coalesce((p->>'page')::integer,1);sz integer:=coalesce((p->>'pageSize')::integer,25);rows jsonb;total bigint;tz text;prev bigint;eprev bigint;desired boolean;source_opted boolean;source_table text;args jsonb;affected jsonb;due timestamptz;appt timestamptz;times jsonb:='[]';i integer;
begin
 perform sms_private.mcp_validate_input(tool,p);
 if p ? 'enrollmentId' and exists(select from sms_private.email_enrollments where tenant_id=t and id=(p->>'enrollmentId')::uuid and template_id is not null)
 or p ? 'jobId' and exists(select from sms_private.email_jobs j0 join sms_private.email_enrollments e0 on e0.id=j0.enrollment_id where e0.tenant_id=t and j0.id=(p->>'jobId')::uuid and e0.template_id is not null) then raise exception 'Legacy email access denied' using errcode='42501'; end if;

 select time_zone into tz from public.sms_businesses where tenant_id=t;
 if tool='crm_set_form_email_enabled' then
  select * into f from public.sms_web_form_definitions where tenant_id=t and public_id=(p->>'formId')::uuid for update nowait;
  if f.public_id is null then raise exception 'Form access denied' using errcode='42501';end if;
  select * into d from sms_private.mcp_form_drafts where tenant_id=t and form_id=f.public_id for update nowait;
  if f.version<>(p->>'revision')::bigint or coalesce(d.revision,0)<>(p->>'draftRevision')::bigint then raise exception 'Form or draft changed; reread' using errcode='23505';end if;
  if f.archived or not f.legacy_form then raise exception 'An unarchived legacy email-connected form is required' using errcode='22023';end if;
  desired:=(p->>'enabled')::boolean;
  if desired and exists(select from jsonb_array_elements(f.fields||coalesce(d.definition->'fields','[]')) field where field->>'key'='email_opt_in') then raise exception 'Remove the conflicting custom email consent field first' using errcode='22023';end if;
  perform 1 from sms_private.email_enrollments where tenant_id=t and form_public_id=f.public_id and status in ('active','paused') for update nowait;
  select coalesce(jsonb_object_agg(id::text,revision),'{}') into affected from sms_private.email_enrollments where tenant_id=t and form_public_id=f.public_id and status in ('active','paused');
  prev:=f.version;
  if f.email_enabled<>desired then
   update public.sms_web_form_definitions set email_enabled=desired,updated_at=now() where tenant_id=t and public_id=f.public_id;
   update sms_private.mcp_form_drafts set base_revision=prev+1,revision=revision+1,updated_by=sms_private.platform_actor(u),connection_id=cid,updated_at=now() where tenant_id=t and form_id=f.public_id and base_revision=prev;
  end if;
  if not desired then update sms_private.email_enrollments set status='cancelled',pause_reason=null,next_run_at=null,generation=generation+1,updated_at=now() where tenant_id=t and form_public_id=f.public_id and status in ('active','paused');end if;
  insert into sms_private.mcp_activity(connection_id,actor_id,tool,target,request_id,outcome,previous_revision,revision)
  select cid,sms_private.platform_actor(u),tool||':enrollment',q.id::text,rid,'success',(affected->>q.id::text)::bigint,q.revision from sms_private.email_enrollments q where q.tenant_id=t and affected ? q.id::text and q.revision<>(affected->>q.id::text)::bigint;
  get diagnostics cancelled=row_count;
  select * into f from public.sms_web_form_definitions where tenant_id=t and public_id=f.public_id;
  select * into d from sms_private.mcp_form_drafts where tenant_id=t and form_id=f.public_id;
  return jsonb_build_object('businessId',t,'formId',f.public_id,'previousRevision',prev,'revision',f.version,'draftRevision',coalesce(d.revision,0),'emailConsentEnabled',f.email_enabled,'collectionEnabled',f.enabled,'cancelledEnrollments',cancelled,'databaseStatus','committed');
 elsif tool='crm_list_email_groups' then
  select count(*) into total from sms_private.email_group_settings s0 join public.sms_automation_groups g0 on g0.tenant_id=s0.tenant_id and g0.id=s0.group_id where s0.tenant_id=t;
  select coalesce(jsonb_agg(q.value order by q.id),'[]') into rows from (select s0.group_id id,sms_private.mcp_email_group(s0,g0,tz) value from sms_private.email_group_settings s0 join public.sms_automation_groups g0 on g0.tenant_id=s0.tenant_id and g0.id=s0.group_id where s0.tenant_id=t order by s0.group_id limit sz offset(pg-1)*sz) q;
  return jsonb_build_object('businessId',t,'groups',rows,'total',total,'page',pg,'pageSize',sz);
 elsif tool='crm_list_email_enrollments' then
  if p ? 'groupId' and not exists(select from sms_private.email_group_settings where tenant_id=t and group_id=p->>'groupId') then raise exception 'Group access denied' using errcode='42501';end if;
  select count(*) into total from sms_private.email_enrollments where tenant_id=t and template_id is null and(not p ? 'groupId' or group_id=p->>'groupId');
  select coalesce(jsonb_agg(sms_private.mcp_email_enrollment(q) order by q.enrolled_at desc,q.id),'[]') into rows from (select * from sms_private.email_enrollments where tenant_id=t and template_id is null and(not p ? 'groupId' or group_id=p->>'groupId') order by enrolled_at desc,id limit sz offset(pg-1)*sz) q;
  return jsonb_build_object('businessId',t,'enrollments',rows,'total',total,'page',pg,'pageSize',sz);
 elsif tool='crm_list_email_jobs' then
  if p ? 'enrollmentId' and not exists(select from sms_private.email_enrollments where tenant_id=t and id=(p->>'enrollmentId')::uuid) then raise exception 'Enrollment access denied' using errcode='42501';end if;
  select count(*) into total from sms_private.email_jobs j0 join sms_private.email_enrollments e0 on e0.id=j0.enrollment_id where e0.tenant_id=t and e0.template_id is null and(not p ? 'enrollmentId' or e0.id=(p->>'enrollmentId')::uuid);
  select coalesce(jsonb_agg(sms_private.mcp_email_job(q) order by q.created_at desc,q.id),'[]') into rows from (select j0.* from sms_private.email_jobs j0 join sms_private.email_enrollments e0 on e0.id=j0.enrollment_id where e0.tenant_id=t and e0.template_id is null and(not p ? 'enrollmentId' or e0.id=(p->>'enrollmentId')::uuid) order by j0.created_at desc,j0.id limit sz offset(pg-1)*sz) q;
  return jsonb_build_object('businessId',t,'jobs',rows,'total',total,'page',pg,'pageSize',sz);
 elsif tool in ('crm_get_email_group','crm_save_email_group','crm_set_email_group_enabled','crm_preview_email_schedule') then
  select * into s from sms_private.email_group_settings where tenant_id=t and group_id=p->>'groupId';
  select * into g from public.sms_automation_groups where tenant_id=t and id=s.group_id;
  if s.group_id is null or g.id is null then raise exception 'Group access denied' using errcode='42501';end if;
  if tool='crm_get_email_group' then return jsonb_build_object('businessId',t,'group',sms_private.mcp_email_group(s,g,tz));end if;
  if tool<>'crm_preview_email_schedule' then select * into s from sms_private.email_group_settings where tenant_id=t and group_id=s.group_id for update nowait;end if;
  prev:=s.revision;if prev<>(p->>'revision')::bigint then raise exception 'Email settings changed; reread' using errcode='23505';end if;
  if tool='crm_preview_email_schedule' then
   appt:=(p->>'appointmentAt')::timestamptz;
   if g.fixed_type='bookings' and (appt is null or appt<=(p->>'startAt')::timestamptz) then raise exception 'Future appointment required for booking preview' using errcode='22023';end if;
   due:=sms_private.automation_due(case when g.fixed_type='bookings' then appt else (p->>'startAt')::timestamptz end,s.rule,tz,true);
   for i in 1..least(30,(s.rule->>'repeatCount')::integer) loop
    due:=sms_private.form_due(greatest(due,(p->>'startAt')::timestamptz),0,'minute',tz,(s.rule->>'startHour')::integer,(s.rule->>'endHour')::integer);
    exit when due is null or (g.fixed_type='bookings' and due>=appt);
    times:=times||to_jsonb(due);due:=sms_private.automation_due(due,s.rule,tz,false);
   end loop;
   return jsonb_build_object('businessId',t,'groupId',s.group_id,'revision',s.revision,'timeZone',tz,'enabled',s.enabled,'hypothetical',true,'messageTextAvailable',false,'requiresEmailConsent',true,'times',times);
  end if;
  desired:=case when tool='crm_set_email_group_enabled' then (p->>'enabled')::boolean else s.enabled end;
  if desired and (not exists(select from sms_private.mcp_email_tickets x where x.connection_id=cid and x.request_id=rid and x.tool=mcp_email_action.tool and x.input_hash=encode(sha256(convert_to(p::text,'UTF8')),'hex') and x.expires_at>now() and x.openai_ready) or not sms_private.email_provider_ready(u,t)) then raise exception 'Configure email provider and AI before activation; use the verified CRM adapter' using errcode='22023';end if;
  args:=case when tool='crm_save_email_group' then p->'configuration' else jsonb_build_object('rule',s.rule,'intent',s.intent,'systemPrompt',s.system_prompt,'businessContext',s.business_context,'mailingAddress',s.mailing_address) end;
  if not desired then
   perform 1 from sms_private.email_enrollments where tenant_id=t and group_id=s.group_id and status in ('active','paused') for update nowait;
   select coalesce(jsonb_object_agg(id::text,revision),'{}') into affected from sms_private.email_enrollments where tenant_id=t and group_id=s.group_id and status in ('active','paused');
  end if;
  perform sms_private.email_save_group(u,t,s.group_id,args||jsonb_build_object('enabled',desired,'revision',prev));
  select * into s from sms_private.email_group_settings where tenant_id=t and group_id=s.group_id;
  insert into sms_private.mcp_activity(connection_id,actor_id,tool,target,request_id,outcome,previous_revision,revision)
  select cid,sms_private.platform_actor(u),tool||':enrollment',q.id::text,rid,'success',(affected->>q.id::text)::bigint,q.revision from sms_private.email_enrollments q where q.tenant_id=t and affected ? q.id::text;
  return jsonb_build_object('businessId',t,'groupId',s.group_id,'previousRevision',prev,'revision',s.revision,'enabled',s.enabled,'databaseStatus','committed','enrolledPastSubmissions',false);
 else
  if tool in ('crm_get_email_job','crm_retry_email_job') then
   select j0.* into j from sms_private.email_jobs j0 join sms_private.email_enrollments e0 on e0.id=j0.enrollment_id where e0.tenant_id=t and j0.id=(p->>'jobId')::uuid;
   if j.id is null then raise exception 'Job access denied' using errcode='42501';end if;
   select * into e from sms_private.email_enrollments where tenant_id=t and id=j.enrollment_id;
  else select * into e from sms_private.email_enrollments where tenant_id=t and id=(p->>'enrollmentId')::uuid;end if;
  if e.id is null then raise exception 'Enrollment access denied' using errcode='42501';end if;
  if tool='crm_get_email_enrollment' then return jsonb_build_object('businessId',t,'enrollment',sms_private.mcp_email_enrollment(e));end if;
  if tool='crm_get_email_job' then
   if p->'includeContent'='true'::jsonb and not exists(select from sms_private.mcp_connections where id=cid and 'email_content_read'=any(permissions)) then raise exception 'Email content is not granted' using errcode='42501';end if;
   return jsonb_build_object('businessId',t,'job',sms_private.mcp_email_job(j),'content',case when p->'includeContent'='true'::jsonb then jsonb_build_object('subject',j.subject,'body',j.body) end);
  end if;
  perform pg_advisory_xact_lock(hashtext(t||':'||e.email));
  if tool='crm_retry_email_job' then select * into j from sms_private.email_jobs where id=j.id for update nowait;end if;
  select * into e from sms_private.email_enrollments where tenant_id=t and id=e.id for update nowait;
  if e.id<>(p->>'enrollmentId')::uuid then raise exception 'Enrollment access denied' using errcode='42501';end if;
  if e.generation<>(p->>'generation')::integer or e.revision<>coalesce((p->>'enrollmentRevision')::bigint,(p->>'revision')::bigint) then raise exception 'Enrollment changed; reread' using errcode='23505';end if;
  eprev:=e.revision;
  if tool='crm_resolve_email_enrollment' then
   perform sms_private.email_resolve(u,t,e.id);select * into e from sms_private.email_enrollments where tenant_id=t and id=e.id;
   return jsonb_build_object('businessId',t,'enrollmentId',e.id,'previousRevision',eprev,'revision',e.revision,'generation',e.generation,'status',e.status,'databaseStatus','committed');
  elsif tool='crm_retry_email_job' then
   prev:=j.revision;if prev<>(p->>'revision')::bigint then raise exception 'Email job changed; reread' using errcode='23505';end if;
   if not exists(select from sms_private.email_consent_events c where c.tenant_id=t and c.source_type=e.source_type and c.source_id=e.source_id and lower(btrim(c.email))=e.email and length(btrim(c.evidence))>0) then raise exception 'Recorded email consent is required' using errcode='22023';end if;
   source_table:=sms_private.intake_table(e.source_type);
   if source_table is null then raise exception 'Unsupported email source' using errcode='22023';end if;
   execute format('select email_opt_in and lower(btrim(email))=$3 from public.%I where tenant_id=$1 and id=$2 for share nowait',source_table) into source_opted using t,e.source_id,e.email;
   if source_opted is distinct from true then raise exception 'Current email consent and address must match the enrollment' using errcode='22023';end if;
   perform sms_private.email_retry(u,t,j.id);
   select * into j from sms_private.email_jobs where id=j.id;select * into e from sms_private.email_enrollments where tenant_id=t and id=e.id;
   insert into sms_private.mcp_activity(connection_id,actor_id,tool,target,request_id,outcome,previous_revision,revision) values(cid,sms_private.platform_actor(u),tool||':enrollment',e.id::text,rid,'success',eprev,e.revision);
   return jsonb_build_object('businessId',t,'jobId',j.id,'enrollmentId',e.id,'previousRevision',prev,'revision',j.revision,'enrollmentRevision',e.revision,'generation',e.generation,'status',j.status,'providerWork','queued','databaseStatus','committed');
  end if;
 end if;
 raise exception 'Unsupported email tool' using errcode='22023';
end $$;
revoke all on function sms_private.mcp_email_action(text,text,text,jsonb,uuid,uuid) from public,anon,authenticated,sms_api,service_role,crm_mcp;
alter function sms_private.email_overview(text,text) rename to email_overview_before_templates;
create function sms_private.email_overview(u text,t text) returns jsonb language plpgsql security definer set search_path='' as $$ declare result jsonb; begin
 result:=sms_private.email_overview_before_templates(u,t);
 result:=jsonb_set(result,'{enrollments}',coalesce((select jsonb_agg(x) from jsonb_array_elements(result->'enrollments') x where exists(select from sms_private.email_enrollments where id=(x->>'id')::uuid and template_id is null)),'[]'));
 return jsonb_set(result,'{jobs}',coalesce((select jsonb_agg(x) from jsonb_array_elements(result->'jobs') x where exists(select from sms_private.email_jobs j join sms_private.email_enrollments e on e.id=j.enrollment_id where j.id=(x->>'id')::uuid and e.template_id is null)),'[]'));
end $$;
revoke all on function sms_private.email_overview_before_templates(text,text),sms_private.email_overview(text,text) from public,anon,authenticated,sms_api,service_role;
grant execute on function sms_private.email_overview(text,text) to sms_api;
