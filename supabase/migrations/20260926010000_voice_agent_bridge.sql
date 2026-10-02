-- Soni's database role has no table privileges. All voice operations use these
-- tenant-scoped, deliberately narrow security-definer functions.
do $$ begin
  if not exists (select 1 from pg_roles where rolname='sms_voice') then
    create role sms_voice nologin;
  end if;
end $$;
grant usage on schema sms_private to sms_voice;

create table sms_private.voice_otps (
  tenant_id text not null references public.sms_businesses(tenant_id),
  call_id text not null,
  phone text not null,
  code_hash text not null,
  expires_at timestamptz not null,
  attempts integer not null default 0,
  sent_count integer not null default 1,
  last_sent_at timestamptz not null default now(),
  verified_at timestamptz,
  primary key (tenant_id,call_id,phone),
  check (length(call_id) between 8 and 160),
  check (phone ~ '^[+][1-9][0-9]{7,14}$'),
  check (attempts between 0 and 3)
);
create index voice_otps_phone_recent on sms_private.voice_otps(tenant_id,phone,last_sent_at desc);

create table public.sms_voice_service_rules (
  tenant_id text not null references public.sms_businesses(tenant_id),
  id uuid not null default gen_random_uuid(),
  service text not null check (service in ('junk_removal','dumpster_rental','property_cleanout','local_moving')),
  variant text not null default '',
  market text not null,
  zip_codes text[] not null default '{}',
  time_zone text not null,
  resource_pool text not null,
  enabled boolean not null default false,
  duration_minutes integer not null check (duration_minutes between 15 and 43200),
  capacity integer not null check (capacity between 1 and 100),
  minimum_notice_minutes integer not null default 120 check (minimum_notice_minutes between 0 and 43200),
  maximum_advance_days integer not null default 90 check (maximum_advance_days between 1 and 730),
  weekly_availability jsonb not null default '{"0":[],"1":[],"2":[],"3":[],"4":[],"5":[],"6":[]}',
  date_exceptions jsonb not null default '[]',
  version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id,id),
  unique (tenant_id,service,variant,market),
  check (length(market) between 1 and 100 and length(resource_pool) between 1 and 100 and length(variant)<=80),
  check (jsonb_typeof(weekly_availability)='object' and jsonb_typeof(date_exceptions)='array')
);
create index sms_voice_rules_zip on public.sms_voice_service_rules using gin(zip_codes);
alter table public.sms_voice_service_rules enable row level security;
revoke all on public.sms_voice_service_rules from public,anon,authenticated;

alter table public.sms_bookings
  add column if not exists voice_service text,
  add column if not exists voice_end_at timestamptz,
  add column if not exists voice_resource_pool text,
  add column if not exists voice_market text,
  add column if not exists voice_intake_id uuid;
create index sms_bookings_voice_pool_time on public.sms_bookings
  (tenant_id,voice_resource_pool,appointment_at,voice_end_at)
  where status='confirmed' and voice_resource_pool is not null;

create table sms_private.voice_booking_holds (
  tenant_id text not null references public.sms_businesses(tenant_id),
  id uuid not null default gen_random_uuid(),
  call_id text not null,
  phone text not null,
  customer_name text not null,
  service text not null,
  variant text not null default '',
  service_zip text not null,
  service_address text not null,
  local_date date not null,
  local_time time without time zone not null,
  time_zone text not null,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  rule_id uuid not null,
  rule_version integer not null,
  details jsonb not null default '{}',
  existing_booking_id text,
  expires_at timestamptz not null default now()+interval '5 minutes',
  confirmed_booking_id text,
  primary key (tenant_id,id),
  check (jsonb_typeof(details)='object' and pg_column_size(details)<=16384)
);
create index voice_holds_call on sms_private.voice_booking_holds(tenant_id,call_id,expires_at desc);

create or replace function sms_private.voice_valid_phone(ph text) returns boolean
language sql immutable set search_path='' as $$
  select coalesce(ph ~ '^[+][1-9][0-9]{7,14}$',false)
$$;

create or replace function sms_private.voice_verified(t text,cid text,ph text) returns boolean
language sql stable security definer set search_path='' as $$
  select exists(select 1 from sms_private.voice_otps o
    where o.tenant_id=t and o.call_id=cid and o.phone=ph
      and o.verified_at>now()-interval '30 minutes')
$$;

create or replace function sms_private.voice_start_otp(t text,cid text,ph text,hashed text,body text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare o sms_private.voice_otps; queued jsonb;
begin
  if t<>'opek' or length(cid) not between 8 and 160 or not sms_private.voice_valid_phone(ph)
    or hashed !~ '^[0-9a-f]{64}$' or length(body) not between 20 and 160
    then raise exception 'Invalid verification request'; end if;
  perform pg_advisory_xact_lock(hashtextextended(t||':voice-otp:'||ph,991));
  delete from sms_private.voice_otps where expires_at<now()-interval '1 day';
  if (select coalesce(sum(sent_count),0) from sms_private.voice_otps where tenant_id=t and phone=ph
      and last_sent_at>now()-interval '1 hour')>=5 then raise exception 'Verification limit reached'; end if;
  select * into o from sms_private.voice_otps where tenant_id=t and call_id=cid and phone=ph for update;
  if found and o.last_sent_at>now()-interval '60 seconds' then raise exception 'Wait before requesting another code'; end if;
  insert into public.sms_contacts(tenant_id,phone,source) values(t,ph,'voice_verification')
    on conflict(tenant_id,phone) do nothing;
  insert into sms_private.voice_otps(tenant_id,call_id,phone,code_hash,expires_at)
    values(t,cid,ph,hashed,now()+interval '5 minutes')
    on conflict(tenant_id,call_id,phone) do update set
      code_hash=excluded.code_hash,expires_at=excluded.expires_at,
      attempts=0,sent_count=voice_otps.sent_count+1,last_sent_at=now(),verified_at=null;
  queued:=sms_private.outbox(t,'voice-otp:'||md5(cid||':'||ph||':'||now()::text),
    jsonb_build_object('phone',ph,'body',body,'purpose','transactional'));
  return jsonb_build_object('status',queued->>'status','phone',right(ph,4));
end $$;

create or replace function sms_private.voice_verify_otp(t text,cid text,ph text,hashed text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare o sms_private.voice_otps;
begin
  if t<>'opek' or not sms_private.voice_valid_phone(ph) or hashed !~ '^[0-9a-f]{64}$'
    then raise exception 'Invalid verification request'; end if;
  select * into o from sms_private.voice_otps where tenant_id=t and call_id=cid and phone=ph for update;
  if not found or o.expires_at<=now() or o.attempts>=3 then return jsonb_build_object('verified',false); end if;
  update sms_private.voice_otps set attempts=attempts+1,
    verified_at=case when code_hash=hashed then now() else null end
    where tenant_id=t and call_id=cid and phone=ph;
  return jsonb_build_object('verified',o.code_hash=hashed);
end $$;

create or replace function sms_private.voice_create_intake(t text,cid text,typ text,p jsonb,k text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare tab text; result jsonb; ph text:=p->>'phone';
begin
  if t<>'opek' or typ not in ('contacts','quote_requests') or not sms_private.voice_valid_phone(ph)
    or length(cid) not between 8 and 160 or length(k) not between 8 and 160
    or length(btrim(coalesce(p->>'name',''))) not between 1 and 200
    or jsonb_typeof(coalesce(p->'details','{}'))<>'object'
    or pg_column_size(coalesce(p->'details','{}'))>16384
    then raise exception 'Invalid intake request'; end if;
  tab:=sms_private.intake_table(typ);
  execute format('select to_jsonb(x) from public.%I x where tenant_id=$1 and source=$2 and source_record_id=$3',tab)
    into result using t,'voice',k;
  if result is not null then return jsonb_build_object('id',result->>'id','duplicate',true); end if;
  begin
    execute format('insert into public.%I(tenant_id,name,phone,email,details,source,source_record_id)
      values($1,$2,$3,$4,$5,$6,$7) returning to_jsonb(%I)',tab,tab)
      into result using t,btrim(p->>'name'),ph,nullif(lower(btrim(p->>'email')),''),
        coalesce(p->'details','{}'::jsonb),'voice',k;
  exception when unique_violation then
    execute format('select to_jsonb(x) from public.%I x where tenant_id=$1 and source=$2 and source_record_id=$3',tab)
      into result using t,'voice',k;
    if result is null then raise; end if;
    return jsonb_build_object('id',result->>'id','duplicate',true);
  end;
  return jsonb_build_object('id',result->>'id','duplicate',false,'intakeState',result->>'intake_state');
end $$;

create or replace function sms_private.voice_lookup(t text,cid text,ph text) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare result jsonb;
begin
  if t<>'opek' or not sms_private.voice_verified(t,cid,ph) then raise exception 'Verification required' using errcode='42501'; end if;
  select jsonb_build_object(
    'contact',jsonb_build_object('name',c.name,'phone',c.phone,'email',c.email,'optedOut',c.opted_out),
    'quotes',coalesce((select jsonb_agg(q) from (select id,details,created_at from public.sms_automation_quote_requests
      where tenant_id=t and phone=ph order by created_at desc limit 5) q),'[]'::jsonb),
    'bookings',coalesce((select jsonb_agg(b) from (select id,status,appointment_at,service_address,time_zone,voice_service
      from public.sms_bookings where tenant_id=t and (customer_phone=ph or contact_id=c.id)
      order by appointment_at desc limit 5) b),'[]'::jsonb)
  ) into result from public.sms_contacts c where c.tenant_id=t and c.phone=ph;
  return coalesce(result,'{}'::jsonb);
end $$;

create or replace function sms_private.voice_update_record(t text,cid text,ph text,typ text,rid text,p jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare changed jsonb;
begin
  if t<>'opek' or not sms_private.voice_verified(t,cid,ph) then raise exception 'Verification required' using errcode='42501'; end if;
  if typ='contact' then
    if p ? 'name' and length(btrim(p->>'name')) not between 1 and 200 then raise exception 'Invalid name'; end if;
    if p ? 'email' and (length(p->>'email')>320 or
      (btrim(p->>'email')<>'' and lower(btrim(p->>'email')) !~ '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$'))
      then raise exception 'Invalid email'; end if;
    update public.sms_contacts set name=coalesce(nullif(btrim(p->>'name'),''),name),
      email=case when p ? 'email' then nullif(lower(btrim(p->>'email')),'') else email end,
      updated_at=now() where tenant_id=t and phone=ph
      returning jsonb_build_object('phone',phone,'name',name,'email',email) into changed;
  elsif typ='quote' then
    if jsonb_typeof(p->'details')<>'object' or pg_column_size(p->'details')>16384 then raise exception 'Invalid quote details'; end if;
    update public.sms_automation_quote_requests set details=details||(p->'details'),updated_at=now()
      where tenant_id=t and phone=ph and id=rid::uuid
      returning jsonb_build_object('id',id,'details',details) into changed;
  else raise exception 'Unsupported record type'; end if;
  if changed is null then raise exception 'Record not found'; end if;
  return changed;
end $$;

revoke all on sms_private.voice_otps,sms_private.voice_booking_holds from public,anon,authenticated;
revoke all on function sms_private.voice_valid_phone(text),sms_private.voice_verified(text,text,text),
  sms_private.voice_start_otp(text,text,text,text,text),sms_private.voice_verify_otp(text,text,text,text),
  sms_private.voice_create_intake(text,text,text,jsonb,text),sms_private.voice_lookup(text,text,text),
  sms_private.voice_update_record(text,text,text,text,text,jsonb)
  from public,anon,authenticated,sms_api,sms_webhook,sms_sender,sms_automation,sms_ai;
grant execute on function sms_private.voice_start_otp(text,text,text,text,text),
  sms_private.voice_verify_otp(text,text,text,text),sms_private.voice_create_intake(text,text,text,jsonb,text),
  sms_private.voice_lookup(text,text,text),sms_private.voice_update_record(text,text,text,text,text,jsonb)
  to sms_voice;

create or replace function sms_private.voice_save_rule(u text,t text,p jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare result public.sms_voice_service_rules; z text; w jsonb; win jsonb; entry jsonb;
begin
  perform sms_private.require_admin(u);
  if t<>'opek' or p->>'service' not in ('junk_removal','dumpster_rental','property_cleanout','local_moving')
    or length(coalesce(p->>'variant',''))>80
    or (p->>'service'='dumpster_rental' and length(btrim(coalesce(p->>'variant','')))=0)
    or (p->>'service'<>'dumpster_rental' and length(btrim(coalesce(p->>'variant','')))>0)
    or length(btrim(coalesce(p->>'market',''))) not between 1 and 100
    or length(btrim(coalesce(p->>'resourcePool',''))) not between 1 and 100
    or not exists(select 1 from pg_timezone_names where name=p->>'timeZone')
    or jsonb_typeof(p->'zipCodes')<>'array' or jsonb_array_length(p->'zipCodes') not between 1 and 1000
    or jsonb_typeof(p->'weeklyAvailability')<>'object'
    or jsonb_typeof(coalesce(p->'dateExceptions','[]'::jsonb))<>'array'
    or (p->>'durationMinutes')::integer not between 15 and 43200
    or (p->>'capacity')::integer not between 1 and 100
    or coalesce((p->>'minimumNoticeMinutes')::integer,120) not between 0 and 43200
    or coalesce((p->>'maximumAdvanceDays')::integer,90) not between 1 and 730
    then raise exception 'Invalid voice booking rule'; end if;
  for z in select jsonb_array_elements_text(p->'zipCodes') loop
    if z !~ '^[0-9]{5}$' then raise exception 'Invalid ZIP'; end if;
  end loop;
  for z,w in select key,value from jsonb_each(p->'weeklyAvailability') loop
    if z not in ('0','1','2','3','4','5','6') or jsonb_typeof(w)<>'array' then raise exception 'Invalid hours'; end if;
    for win in select value from jsonb_array_elements(w) loop
      if (win->>'start') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
        or (win->>'end') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
        or (win->>'start')::time >= (win->>'end')::time then raise exception 'Invalid hours'; end if;
    end loop;
  end loop;
  for entry in select value from jsonb_array_elements(coalesce(p->'dateExceptions','[]'::jsonb)) loop
    if (entry->>'date') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
      or jsonb_typeof(coalesce(entry->'windows','[]'::jsonb))<>'array'
      or (entry ? 'closed' and jsonb_typeof(entry->'closed')<>'boolean')
      then raise exception 'Invalid date exception'; end if;
    perform (entry->>'date')::date;
    for win in select value from jsonb_array_elements(coalesce(entry->'windows','[]'::jsonb)) loop
      if (win->>'start') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
        or (win->>'end') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
        or (win->>'start')::time >= (win->>'end')::time then raise exception 'Invalid date exception hours'; end if;
    end loop;
  end loop;
  if coalesce((p->>'enabled')::boolean,false) and exists(select 1 from public.sms_bookings
    where tenant_id=t and status='confirmed' and appointment_at>now() and voice_resource_pool is null)
    then raise exception 'Reconcile existing confirmed bookings before enabling voice reservations'; end if;
  if coalesce((p->>'enabled')::boolean,false) and exists(select 1 from public.sms_voice_service_rules
    where tenant_id=t and resource_pool=p->>'resourcePool' and enabled
      and capacity<>(p->>'capacity')::integer
      and (p->>'id' is null or id<>(p->>'id')::uuid))
    then raise exception 'Shared resource pool must use one capacity'; end if;
  if exists(select 1 from public.sms_voice_service_rules r
    where r.tenant_id=t and r.service=p->>'service' and r.variant=coalesce(p->>'variant','')
      and r.zip_codes && array(select jsonb_array_elements_text(p->'zipCodes'))
      and (p->>'id' is null or r.id<>(p->>'id')::uuid))
    then raise exception 'ZIP overlaps another rule for this service'; end if;
  insert into public.sms_voice_service_rules
    (tenant_id,id,service,variant,market,zip_codes,time_zone,resource_pool,enabled,duration_minutes,capacity,
     minimum_notice_minutes,maximum_advance_days,weekly_availability,date_exceptions)
  values(t,coalesce(nullif(p->>'id','')::uuid,gen_random_uuid()),p->>'service',coalesce(p->>'variant',''),btrim(p->>'market'),
    array(select jsonb_array_elements_text(p->'zipCodes')),p->>'timeZone',btrim(p->>'resourcePool'),
    coalesce((p->>'enabled')::boolean,false),(p->>'durationMinutes')::integer,(p->>'capacity')::integer,
    coalesce((p->>'minimumNoticeMinutes')::integer,120),coalesce((p->>'maximumAdvanceDays')::integer,90),
    p->'weeklyAvailability',coalesce(p->'dateExceptions','[]'::jsonb))
  on conflict(tenant_id,id) do update set service=excluded.service,variant=excluded.variant,market=excluded.market,
    zip_codes=excluded.zip_codes,time_zone=excluded.time_zone,resource_pool=excluded.resource_pool,
    enabled=excluded.enabled,duration_minutes=excluded.duration_minutes,capacity=excluded.capacity,
    minimum_notice_minutes=excluded.minimum_notice_minutes,maximum_advance_days=excluded.maximum_advance_days,
    weekly_availability=excluded.weekly_availability,date_exceptions=excluded.date_exceptions,
    version=sms_voice_service_rules.version+1,updated_at=now()
  returning * into result;
  return to_jsonb(result);
end $$;

create or replace function sms_private.voice_rules(u text,t text) returns jsonb
language plpgsql stable security definer set search_path='' as $$
begin
  perform sms_private.require_admin(u);
  return coalesce((select jsonb_agg(r order by r.service,r.variant,r.market) from public.sms_voice_service_rules r
    where tenant_id=t),'[]'::jsonb);
end $$;

create or replace function sms_private.voice_slot_open(r public.sms_voice_service_rules,
  local_day date,local_clock time without time zone,exclude_booking text default null) returns boolean
language plpgsql stable security definer set search_path='' as $$
declare starts timestamptz; ends timestamptz; windows jsonb; exception jsonb;
begin
  if r.id is null or not r.enabled then return false; end if;
  starts:=make_timestamptz(extract(year from local_day)::integer,extract(month from local_day)::integer,
    extract(day from local_day)::integer,extract(hour from local_clock)::integer,
    extract(minute from local_clock)::integer,0,r.time_zone);
  ends:=starts+make_interval(mins=>r.duration_minutes);
  if (starts at time zone r.time_zone)::date<>local_day
    or (starts at time zone r.time_zone)::time<>local_clock
    or starts<now()+make_interval(mins=>r.minimum_notice_minutes)
    or starts>now()+make_interval(days=>r.maximum_advance_days) then return false; end if;
  select value into exception from jsonb_array_elements(r.date_exceptions)
    where value->>'date'=local_day::text limit 1;
  if exception is not null and coalesce((exception->>'closed')::boolean,false) then return false; end if;
  windows:=case when exception is not null then coalesce(exception->'windows','[]'::jsonb)
    else coalesce(r.weekly_availability->(extract(dow from local_day)::integer)::text,'[]'::jsonb) end;
  if not exists(select 1 from jsonb_array_elements(windows) w
      where local_clock>=(w->>'start')::time and local_clock<(w->>'end')::time
        and (r.service='dumpster_rental' or
          ((ends at time zone r.time_zone)::date=local_day
            and (ends at time zone r.time_zone)::time<=(w->>'end')::time))) then return false; end if;
  -- Count all overlapping reservations in the shared pool. This conservative
  -- limit never overbooks even when overlaps do not all occur simultaneously.
  if exists(select 1 from public.sms_bookings b where b.tenant_id=r.tenant_id
      and b.status='confirmed' and b.voice_resource_pool is null
      and (b.appointment_at at time zone r.time_zone)::date=local_day) then return false; end if;
  return (select count(*) from public.sms_bookings b where b.tenant_id=r.tenant_id
    and b.status='confirmed' and b.voice_resource_pool=r.resource_pool
    and b.id is distinct from exclude_booking
    and b.appointment_at<ends and b.voice_end_at>starts)<r.capacity;
end $$;

create or replace function sms_private.voice_prepare_booking(t text,cid text,p jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare r public.sms_voice_service_rules; h sms_private.voice_booking_holds;
  day date; clock time without time zone; starts timestamptz; old public.sms_bookings;
begin
  if t<>'opek' or length(cid) not between 8 and 160
    or p->>'service' not in ('junk_removal','dumpster_rental','property_cleanout','local_moving')
    or p->>'zip' !~ '^[0-9]{5}$' or not sms_private.voice_valid_phone(p->>'phone')
    or (p->>'service'='dumpster_rental' and length(btrim(coalesce(p->>'variant','')))=0)
    or (p->>'service'<>'dumpster_rental' and length(btrim(coalesce(p->>'variant','')))>0)
    or length(btrim(coalesce(p->>'name',''))) not between 1 and 200
    or length(btrim(coalesce(p->>'address',''))) not between 5 and 500
    or p->>'localDate' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
    or p->>'localTime' !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
    or jsonb_typeof(coalesce(p->'details','{}'::jsonb))<>'object'
    or pg_column_size(coalesce(p->'details','{}'::jsonb))>16384
    then raise exception 'Incomplete booking details'; end if;
  day:=(p->>'localDate')::date;clock:=(p->>'localTime')::time;
  select * into r from public.sms_voice_service_rules
    where tenant_id=t and service=p->>'service' and variant=coalesce(p->>'variant','')
      and p->>'zip'=any(zip_codes) and enabled limit 1;
  if not found then return jsonb_build_object('available',false,'reason','No configured live booking for this service and ZIP'); end if;
  if nullif(p->>'existingBookingId','') is not null then
    if not sms_private.voice_verified(t,cid,p->>'phone') then raise exception 'Verification required' using errcode='42501'; end if;
    select * into old from public.sms_bookings b where b.tenant_id=t and b.id=p->>'existingBookingId'
      and (b.customer_phone=p->>'phone' or exists(select 1 from public.sms_contacts c
        where c.tenant_id=t and c.id=b.contact_id and c.phone=p->>'phone'))
      and b.status='confirmed' for update;
    if not found then raise exception 'Booking not found'; end if;
  end if;
  if not sms_private.voice_slot_open(r,day,clock,old.id) then
    return jsonb_build_object('available',false,'reason','That time is not available'); end if;
  starts:=make_timestamptz(extract(year from day)::integer,extract(month from day)::integer,
    extract(day from day)::integer,extract(hour from clock)::integer,
    extract(minute from clock)::integer,0,r.time_zone);
  insert into sms_private.voice_booking_holds
    (tenant_id,call_id,phone,customer_name,service,variant,service_zip,service_address,
     local_date,local_time,time_zone,starts_at,ends_at,rule_id,rule_version,details,existing_booking_id)
  values(t,cid,p->>'phone',btrim(p->>'name'),r.service,r.variant,p->>'zip',btrim(p->>'address'),
    day,clock,r.time_zone,starts,starts+make_interval(mins=>r.duration_minutes),r.id,r.version,
    coalesce(p->'details','{}'::jsonb),nullif(p->>'existingBookingId','')) returning * into h;
  return jsonb_build_object('available',true,'holdId',h.id,'service',h.service,'variant',h.variant,'localDate',h.local_date,
    'localTime',to_char(h.local_time,'HH24:MI'),'timeZone',h.time_zone,
    'address',h.service_address,'phone',h.phone,'expiresAt',h.expires_at);
end $$;

create or replace function sms_private.voice_confirm_booking(t text,cid text,hid uuid,caller_number text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare h sms_private.voice_booking_holds; r public.sms_voice_service_rules;
  b public.sms_bookings; contact_id uuid; intake_id uuid; bid text;
begin
  if t<>'opek' then raise exception 'Business unavailable'; end if;
  select * into strict h from sms_private.voice_booking_holds where tenant_id=t and id=hid
    and call_id=cid for update;
  if h.confirmed_booking_id is not null then
    return jsonb_build_object('status','confirmed','bookingId',h.confirmed_booking_id,'duplicate',true); end if;
  if h.expires_at<=now() then raise exception 'Booking check expired'; end if;
  if caller_number is distinct from h.phone and not sms_private.voice_verified(t,cid,h.phone)
    then raise exception 'Phone verification required' using errcode='42501'; end if;
  select * into strict r from public.sms_voice_service_rules where tenant_id=t and id=h.rule_id;
  perform pg_advisory_xact_lock(hashtextextended(t||':voice-pool:'||r.resource_pool,992));
  if r.version<>h.rule_version or r.service<>h.service or r.variant<>h.variant or not h.service_zip=any(r.zip_codes)
    or not sms_private.voice_slot_open(r,h.local_date,h.local_time,h.existing_booking_id)
    then raise exception 'Time no longer available'; end if;
  if h.existing_booking_id is not null then
    if not sms_private.voice_verified(t,cid,h.phone) then raise exception 'Verification required' using errcode='42501'; end if;
    update public.sms_bookings target set appointment_at=h.starts_at,voice_end_at=h.ends_at,
      voice_resource_pool=r.resource_pool,voice_service=h.service,voice_market=r.market,
      service_address=h.service_address,time_zone=h.time_zone,
      extra_answers=h.details||jsonb_build_object('variant',h.variant),updated_at=now()
      where target.tenant_id=t and target.id=h.existing_booking_id and
        (target.customer_phone=h.phone or exists(select 1 from public.sms_contacts c
          where c.tenant_id=t and c.id=target.contact_id and c.phone=h.phone))
        and target.status='confirmed' returning * into b;
    if b.id is null then raise exception 'Booking no longer exists'; end if;
  else
    insert into public.sms_contacts(tenant_id,phone,name,source)
      values(t,h.phone,h.customer_name,'voice')
      on conflict(tenant_id,phone) do update set name=excluded.name,updated_at=now();
    select id into strict contact_id from public.sms_contacts where tenant_id=t and phone=h.phone;
    bid:='voice:'||h.id::text;
    insert into public.sms_bookings
      (tenant_id,id,contact_id,appointment_at,status,customer_name,customer_phone,
       service_address,time_zone,extra_answers,source,confirmed_at,voice_service,
       voice_end_at,voice_resource_pool,voice_market)
      values(t,bid,contact_id,h.starts_at,'confirmed',h.customer_name,h.phone,
        h.service_address,h.time_zone,h.details||jsonb_build_object('variant',h.variant),'voice',now(),h.service,
        h.ends_at,r.resource_pool,r.market) returning * into b;
    select id into strict intake_id from public.sms_automation_bookings
      where tenant_id=t and source='sms_bookings' and source_record_id=bid;
    update public.sms_bookings set voice_intake_id=intake_id where tenant_id=t and id=bid;
  end if;
  update sms_private.voice_booking_holds set confirmed_booking_id=b.id where tenant_id=t and id=hid;
  return jsonb_build_object('status','confirmed','bookingId',b.id,'appointmentAt',b.appointment_at,
    'timeZone',b.time_zone,'service',b.voice_service,'address',b.service_address,'duplicate',false);
end $$;

create or replace function sms_private.voice_cancel_booking(t text,cid text,ph text,bid text,k text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare b public.sms_bookings;
begin
  if t<>'opek' or not sms_private.voice_verified(t,cid,ph) then raise exception 'Verification required' using errcode='42501'; end if;
  if length(k) not between 8 and 160 then raise exception 'Idempotency key required'; end if;
  select * into strict b from public.sms_bookings x where x.tenant_id=t and x.id=bid
    and (x.customer_phone=ph or exists(select 1 from public.sms_contacts c
      where c.tenant_id=t and c.id=x.contact_id and c.phone=ph)) for update;
  if b.status='cancelled' then return jsonb_build_object('status','cancelled','bookingId',bid,'duplicate',true); end if;
  if b.status<>'confirmed' then raise exception 'Only confirmed bookings may be cancelled'; end if;
  update public.sms_bookings set status='cancelled',cancelled_at=now(),updated_at=now(),
    metadata=metadata||jsonb_build_object('cancel_idempotency_key',k,'cancelled_by','voice')
    where tenant_id=t and id=bid;
  update public.sms_automation_enrollments set status='cancelled',generation=generation+1
    where tenant_id=t and status in ('active','paused') and metadata->>'booking_id'=bid;
  insert into sms_private.audit(tenant_id,actor,action,detail)
    values(t,'voice:'||cid,'booking_cancelled',jsonb_build_object('bookingId',bid));
  return jsonb_build_object('status','cancelled','bookingId',bid,'duplicate',false);
end $$;

create or replace function sms_private.voice_send_sms(t text,cid text,ph text,caller_number text,body text,k text) returns jsonb
language plpgsql security definer set search_path='' as $$
begin
  if t<>'opek' or not sms_private.voice_valid_phone(ph) or length(btrim(body)) not between 1 and 600
    or length(k) not between 8 and 160 then raise exception 'Invalid message'; end if;
  if caller_number is distinct from ph and not sms_private.voice_verified(t,cid,ph)
    then raise exception 'Phone verification required' using errcode='42501'; end if;
  insert into public.sms_contacts(tenant_id,phone,source) values(t,ph,'voice') on conflict do nothing;
  return sms_private.outbox(t,'voice-sms:'||k,
    jsonb_build_object('phone',ph,'body',btrim(body),'purpose','transactional'));
end $$;

revoke all on function sms_private.voice_save_rule(text,text,jsonb),sms_private.voice_rules(text,text),
  sms_private.voice_slot_open(public.sms_voice_service_rules,date,time without time zone,text),
  sms_private.voice_prepare_booking(text,text,jsonb),sms_private.voice_confirm_booking(text,text,uuid,text),
  sms_private.voice_cancel_booking(text,text,text,text,text),
  sms_private.voice_send_sms(text,text,text,text,text,text)
  from public,anon,authenticated,sms_api,sms_webhook,sms_sender,sms_automation,sms_ai;
grant execute on function sms_private.voice_save_rule(text,text,jsonb),sms_private.voice_rules(text,text) to sms_api;
grant execute on function sms_private.voice_prepare_booking(text,text,jsonb),
  sms_private.voice_confirm_booking(text,text,uuid,text),sms_private.voice_cancel_booking(text,text,text,text,text),
  sms_private.voice_send_sms(text,text,text,text,text,text) to sms_voice;

-- Voice intake stays visible in the automation forms without enrolling a caller in texts.
-- Keep form consent and email routing after the E.164 validation correction.
create or replace function sms_private.route_automation_intake() returns trigger
language plpgsql security definer set search_path='' as $$
#variable_conflict use_column
declare typ text; c public.sms_contacts; g public.sms_automation_groups;
  tz text; due_at timestamptz; appointment timestamptz; new_enrollment uuid;
begin
  typ:=case tg_table_name
    when 'sms_automation_contacts' then 'contacts'
    when 'sms_automation_quote_requests' then 'quote_requests'
    when 'sms_automation_bookings' then 'bookings'
    when 'sms_automation_reviews' then 'reviews' end;
  if typ is null then raise exception 'Unknown SMS intake table'; end if;
  if tg_op='UPDATE' and (new.tenant_id<>old.tenant_id or new.id<>old.id) then
    raise exception 'Intake identity cannot change';
  end if;
  if tg_op='UPDATE' and typ='bookings' then
    if new.name is not distinct from old.name and new.phone is not distinct from old.phone
       and new.details is not distinct from old.details and new.status is not distinct from old.status
       and new.appointment_at is not distinct from old.appointment_at then return new; end if;
  end if;
  if tg_op='UPDATE' and old.enrollment_id is not null then
    update public.sms_automation_enrollments set status='cancelled',generation=generation+1,next_run_at=null
      where tenant_id=old.tenant_id and id=old.enrollment_id and status in ('active','paused');
  end if;
  new.enrollment_id:=null; new.skip_reason:=null; new.updated_at:=now();
  if new.phone is null or new.phone !~ '^[+][1-9][0-9]{7,14}$' then
    new.intake_state:='skipped'; new.skip_reason:='INVALID_PHONE'; return new;
  end if;
  insert into public.sms_contacts(tenant_id,phone,name,email,source)
    values(new.tenant_id,new.phone,coalesce(new.name,''),new.email,'automation_intake')
    on conflict(tenant_id,phone) do update set
      name=case when excluded.name<>'' then excluded.name else sms_contacts.name end,
      email=coalesce(excluded.email,sms_contacts.email),updated_at=now();
  select * into strict c from public.sms_contacts where tenant_id=new.tenant_id and phone=new.phone for update;
  if new.source='web_form' and typ in ('contacts','quote_requests') and new.sms_opt_in is not true then
    new.intake_state:='skipped'; new.skip_reason:='CONSENT_REQUIRED'; return new;
  end if;
  select * into g from public.sms_automation_groups
    where tenant_id=new.tenant_id and fixed_type=typ for update;
  if g.id is not null then
    update public.sms_automation_enrollments set status='cancelled',generation=generation+1,next_run_at=null
      where tenant_id=new.tenant_id and contact_id=c.id and category_id=g.id and status in ('active','paused');
  end if;
  if typ='quote_requests' then
    update public.sms_automation_enrollments e set status='cancelled',generation=generation+1,next_run_at=null
      where e.tenant_id=new.tenant_id and e.contact_id=c.id and e.status in ('active','paused')
        and exists(select 1 from public.sms_automation_groups x where x.tenant_id=e.tenant_id and x.id=e.category_id and x.fixed_type='contacts');
  elsif typ='bookings' then
    if new.status='confirmed' then
      update public.sms_automation_enrollments e set status='cancelled',generation=generation+1,next_run_at=null
        where e.tenant_id=new.tenant_id and e.contact_id=c.id and e.status in ('active','paused')
          and exists(select 1 from public.sms_automation_groups x where x.tenant_id=e.tenant_id and x.id=e.category_id and x.fixed_type in ('contacts','quote_requests'));
    end if;
  elsif typ='reviews' then
    update public.sms_automation_enrollments e set status='cancelled',generation=generation+1,next_run_at=null
      where e.tenant_id=new.tenant_id and e.contact_id=c.id and e.status in ('active','paused')
        and exists(select 1 from public.sms_automation_groups x where x.tenant_id=e.tenant_id and x.id=e.category_id and x.fixed_type='bookings');
  end if;
  if typ='bookings' then
    if new.status='cancelled' then new.intake_state:='cancelled'; return new; end if;
    if new.status='requested' then new.intake_state:='waiting_confirmation'; return new; end if;
    appointment:=new.appointment_at;
    if appointment is null or appointment<=now() then
      new.intake_state:='skipped'; new.skip_reason:='FUTURE_APPOINTMENT_REQUIRED'; return new;
    end if;
  end if;
  if new.source='voice' or (typ='bookings' and new.source='sms_bookings' and exists(select 1 from public.sms_bookings vb where vb.tenant_id=new.tenant_id and vb.id=new.source_record_id and vb.source='voice')) then
    new.intake_state:='skipped'; new.skip_reason:='VOICE_EXPLICIT_SMS_ONLY'; return new;
  end if;
  if c.opted_out then new.intake_state:='skipped'; new.skip_reason:='OPTED_OUT'; return new; end if;
  if typ<>'bookings' and not c.marketing_consent then
    new.intake_state:='skipped'; new.skip_reason:='CONSENT_REQUIRED'; return new;
  end if;
  if g.id is null or not g.active or not exists(select 1 from public.sms_automation_intents i
    where i.tenant_id=new.tenant_id and i.group_id=g.id and btrim(i.intent)<>'') then
    new.intake_state:='skipped'; new.skip_reason:='RULE_UNAVAILABLE'; return new;
  end if;
  select time_zone into tz from public.sms_businesses where tenant_id=new.tenant_id;
  due_at:=sms_private.automation_due(case when typ='bookings' then appointment else now() end,g.rule,tz,true);
  insert into public.sms_automation_enrollments
    (tenant_id,contact_id,category_id,appointment_at,next_run_at,metadata,source_type,source_id)
    values(new.tenant_id,c.id,g.id,appointment,due_at,
      jsonb_build_object('intake_type',typ,'intake_id',new.id,'source',new.source)
      || case when typ='bookings' and new.source_record_id is not null
        then jsonb_build_object('booking_id',new.source_record_id) else '{}'::jsonb end,
      typ,new.id) returning id into new_enrollment;
  new.enrollment_id:=new_enrollment; new.intake_state:='enrolled';
  return new;
end $$;
