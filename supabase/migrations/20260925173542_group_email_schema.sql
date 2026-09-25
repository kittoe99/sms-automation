-- Email marketing follows the four fixed intake groups. All switches start off.
alter table public.sms_web_form_definitions add column email_enabled boolean not null default false;
do $$ declare tab text; begin
  foreach tab in array array['sms_automation_contacts','sms_automation_quote_requests',
    'sms_automation_bookings','sms_automation_reviews'] loop
    execute format('alter table public.%I add column email_opt_in boolean not null default false',tab);
    execute format('alter table public.%I add column email_consent_evidence text',tab);
  end loop;
end $$;

create table sms_private.email_group_settings (
  tenant_id text not null,
  group_id text not null,
  enabled boolean not null default false,
  rule jsonb not null,
  intent text not null default '',
  system_prompt text not null default '',
  business_context text not null default '',
  mailing_address text not null default '',
  sender text not null default 'E2 Local <hello@e2local.com>',
  reply_to text not null default 'hello@e2local.com',
  updated_at timestamptz not null default now(),
  primary key(tenant_id,group_id),
  foreign key(tenant_id,group_id) references public.sms_automation_groups(tenant_id,id),
  check(tenant_id='e2-local'),
  check(length(intent)<=1600 and length(system_prompt)<=6000 and length(business_context)<=10000
    and length(mailing_address)<=300)
);
create function sms_private.seed_email_group() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  if new.tenant_id='e2-local' and new.fixed_type in ('contacts','quote_requests','bookings','reviews') then
    insert into sms_private.email_group_settings(tenant_id,group_id,rule)
      values(new.tenant_id,new.id,new.rule) on conflict do nothing;
  end if;
  return new;
end $$;
create trigger seed_email_group after insert on public.sms_automation_groups
  for each row execute function sms_private.seed_email_group();
insert into sms_private.email_group_settings(tenant_id,group_id,rule)
  select tenant_id,id,rule from public.sms_automation_groups
  where tenant_id='e2-local' and fixed_type in ('contacts','quote_requests','bookings','reviews')
  on conflict do nothing;

create table sms_private.email_suppressions (
  tenant_id text not null,
  email text not null,
  reason text not null,
  created_at timestamptz not null default now(),
  primary key(tenant_id,email)
);
create table sms_private.email_consent_events (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null,
  group_id text not null,
  source_type text not null,
  source_id uuid not null,
  email text not null,
  evidence text not null,
  form_public_id uuid,
  form_version integer,
  created_at timestamptz not null default now(),
  unique(tenant_id,source_type,source_id)
);
create table sms_private.email_enrollments (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null,
  group_id text not null,
  source_type text not null,
  source_id uuid not null,
  form_public_id uuid,
  email text not null,
  name text not null,
  phone text,
  status text not null default 'active' check(status in ('active','resolved','cancelled','unsubscribed','completed')),
  step_index integer not null default 0,
  generation integer not null default 1,
  rule_snapshot jsonb not null,
  appointment_at timestamptz,
  next_run_at timestamptz,
  unsubscribe_token uuid not null default gen_random_uuid() unique,
  enrolled_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(tenant_id,source_type,source_id),
  foreign key(tenant_id,group_id) references sms_private.email_group_settings(tenant_id,group_id)
);
create index email_enrollment_due on sms_private.email_enrollments(next_run_at) where status='active';
create index email_enrollment_address on sms_private.email_enrollments(tenant_id,email) where status='active';
create table sms_private.email_jobs (
  id uuid primary key default gen_random_uuid(),
  enrollment_id uuid not null references sms_private.email_enrollments(id),
  step_index integer not null,
  generation integer not null,
  status text not null default 'pending' check(status in ('pending','processing','sent','cancelled','failed','uncertain')),
  attempts integer not null default 0,
  due_at timestamptz not null default now(),
  lease_token uuid,
  lease_until timestamptz,
  subject text,
  body text,
  provider_payload jsonb,
  send_started_at timestamptz,
  provider_id text unique,
  provider_status text,
  error_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(enrollment_id,generation,step_index)
);
create index email_job_due on sms_private.email_jobs(due_at) where status='pending';
create table sms_private.email_webhook_events (
  event_id text primary key,
  provider_id text,
  event_type text not null,
  received_at timestamptz not null default now()
);

create function sms_private.email_consent_text(business_name text) returns text
language sql immutable set search_path='' as $$
  select 'I agree to receive marketing and follow-up emails from '||business_name||
    ' about my request. Email frequency varies. I can unsubscribe at any time.'
$$;

create function sms_private.email_enroll(t text,gid text,typ text,rid uuid,
  address text,customer_name text,customer_phone text,consent_text text,fid uuid default null,
  appointment timestamptz default null) returns uuid
language plpgsql security definer set search_path='' as $$
#variable_conflict use_column
declare s sms_private.email_group_settings; b public.sms_businesses; due timestamptz; eid uuid;
begin
  if t<>'e2-local' or coalesce(length(btrim(consent_text)),0)=0 then return null; end if;
  address:=lower(btrim(address));
  if length(address) not between 3 and 320 or address !~ '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$' then return null; end if;
  perform pg_advisory_xact_lock(hashtext(t||':'||address));
  select * into s from sms_private.email_group_settings where tenant_id=t and group_id=gid;
  if not found or not s.enabled then return null; end if;
  if fid is not null and not exists(select from public.sms_web_form_definitions
    where tenant_id=t and public_id=fid and email_enabled and enabled) then return null; end if;
  if exists(select from sms_private.email_suppressions where tenant_id=t and email=address) then return null; end if;
  if exists(select from sms_private.email_enrollments x where x.tenant_id=t and x.email=address
    and x.status='active' and (x.source_type,x.source_id)<>(typ,rid)) then return null; end if;
  select * into b from public.sms_businesses where tenant_id=t;
  if typ='bookings' and (appointment is null or appointment<=now()) then return null; end if;
  due:=sms_private.automation_due(case when typ='bookings' then appointment else now() end,s.rule,b.time_zone,true);
  if due is null or (typ='bookings' and due>=appointment) then return null; end if;
  insert into sms_private.email_enrollments(tenant_id,group_id,source_type,source_id,form_public_id,
    email,name,phone,rule_snapshot,appointment_at,next_run_at)
    values(t,gid,typ,rid,fid,address,customer_name,customer_phone,s.rule,appointment,due)
    on conflict(tenant_id,source_type,source_id) do update set
      group_id=excluded.group_id,email=excluded.email,name=excluded.name,phone=excluded.phone,
      form_public_id=coalesce(excluded.form_public_id,email_enrollments.form_public_id),rule_snapshot=excluded.rule_snapshot,
      appointment_at=excluded.appointment_at,next_run_at=excluded.next_run_at,
      status='active',step_index=0,generation=email_enrollments.generation+1,updated_at=now()
    returning id into eid;
  return eid;
end $$;

create or replace function sms_private.create_intake(u text,t text,typ text,p jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
#variable_conflict use_column
declare tab text; result jsonb; source_name text; source_id text; address text;
  opted boolean; evidence text; gid text;
begin
  perform sms_private.require_admin(u);
  tab:=sms_private.intake_table(typ);
  if tab is null then raise exception 'Unknown SMS automation type'; end if;
  if jsonb_typeof(coalesce(p->'details','{}'::jsonb))<>'object' then raise exception 'Details must be an object'; end if;
  if p ? 'emailOptIn' and jsonb_typeof(p->'emailOptIn')<>'boolean' then raise exception 'Email consent choice must be true or false'; end if;
  opted:=coalesce((p->>'emailOptIn')::boolean,false);
  if opted and t<>'e2-local' then raise exception 'Email sender is not configured for this business'; end if;
  address:=nullif(lower(btrim(coalesce(p->>'email',''))),'');
  evidence:=nullif(btrim(coalesce(p->>'emailConsentEvidence','')),'');
  if address is not null and (length(address)>320 or address !~ '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$')
    then raise exception 'Valid email address required'; end if;
  if opted and (address is null or evidence is null or length(evidence)>1500)
    then raise exception 'Record email address and consent evidence before enrolling'; end if;
  source_name:=left(coalesce(nullif(btrim(p->>'source'),''),'staff'),100);
  source_id:=left(coalesce(nullif(btrim(p->>'sourceRecordId'),''),gen_random_uuid()::text),256);
  execute format('select to_jsonb(x) from public.%I x where tenant_id=$1 and source=$2 and source_record_id=$3',tab)
    into result using t,source_name,source_id;
  if result is not null then return result; end if;
  begin
    if typ='bookings' then
      execute format('insert into public.%I(tenant_id,name,phone,email,email_opt_in,email_consent_evidence,
        details,source,source_record_id,status,appointment_at)
        values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) returning to_jsonb(%I)',tab,tab)
        into result using t,left(coalesce(p->>'name',''),200),p->>'phone',address,opted,evidence,
          coalesce(p->'details','{}'::jsonb),source_name,source_id,
          coalesce(p->>'status','requested'),nullif(p->>'appointmentAt','')::timestamptz;
    else
      execute format('insert into public.%I(tenant_id,name,phone,email,email_opt_in,email_consent_evidence,
        details,source,source_record_id)
        values($1,$2,$3,$4,$5,$6,$7,$8,$9) returning to_jsonb(%I)',tab,tab)
        into result using t,left(coalesce(p->>'name',''),200),p->>'phone',address,opted,evidence,
          coalesce(p->'details','{}'::jsonb),source_name,source_id;
    end if;
  exception when unique_violation then
    execute format('select to_jsonb(x) from public.%I x where tenant_id=$1 and source=$2 and source_record_id=$3',tab)
      into result using t,source_name,source_id;
    if result is null then raise; end if;
  end;
  if opted then
    select id into gid from public.sms_automation_groups where tenant_id=t and fixed_type=typ;
    if gid is not null then
      insert into sms_private.email_consent_events(tenant_id,group_id,source_type,source_id,email,evidence)
        values(t,gid,typ,(result->>'id')::uuid,address,evidence) on conflict do nothing;
    end if;
  end if;
  return result;
end $$;

create or replace function sms_private.update_intake_booking(u text,t text,rid uuid,p jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
#variable_conflict use_column
declare result public.sms_automation_bookings;
begin
  perform sms_private.require_admin(u);
  update public.sms_automation_bookings set
    name=coalesce(p->>'name',name),phone=coalesce(p->>'phone',phone),
    details=coalesce(p->'details',details),status=coalesce(p->>'status',status),
    appointment_at=case when p ? 'appointmentAt' then nullif(p->>'appointmentAt','')::timestamptz else appointment_at end
    where tenant_id=t and id=rid returning * into result;
  if result.id is null then raise exception 'SMS booking intake record not found'; end if;
  return to_jsonb(result);
end $$;
