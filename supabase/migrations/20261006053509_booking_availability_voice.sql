-- CRM-owned forward migration. Requires existing booking, voice bridge and
-- 20261005200000 / 20261005203000 lookup scope and privilege boundary.
-- No schedules or enabled flags are seeded.
-- Helpers below are revoked explicitly at the end of this migration.
create function sms_private.validate_schedule(weekly jsonb,exceptions jsonb) returns void
language plpgsql immutable set search_path='' as $$
declare k text; windows jsonb; w jsonb; e jsonb; last_end text; dates text[]:='{}';
begin
 if jsonb_typeof(weekly) is distinct from 'object' or jsonb_typeof(exceptions) is distinct from 'array'
   or pg_column_size(weekly)>16384 or pg_column_size(exceptions)>32768 or jsonb_array_length(exceptions)>366 then
   raise exception 'Availability: invalid or oversized schedule'; end if;
 for k,windows in select key,value from jsonb_each(weekly) loop
  if k not in ('0','1','2','3','4','5','6') then raise exception 'Weekly hours: invalid day'; end if;
 end loop;
 for e in select value from jsonb_array_elements(exceptions) loop
  if jsonb_typeof(e) is distinct from 'object' or coalesce(e->>'date','') !~ '^\d{4}-\d{2}-\d{2}$'
    or jsonb_typeof(e->'closed') is distinct from 'boolean' then raise exception 'Date exceptions: invalid date or closed flag'; end if;
  begin perform (e->>'date')::date; exception when others then raise exception 'Date exceptions: invalid calendar date'; end;
  if e->>'date'=any(dates) then raise exception 'Date exceptions: duplicate date'; end if;
  dates:=array_append(dates,e->>'date');
 end loop;
 for windows in select value from jsonb_each(weekly) union all select coalesce(value->'windows','[]') from jsonb_array_elements(exceptions) loop
  if jsonb_typeof(windows) is distinct from 'array' or jsonb_array_length(windows)>8 then raise exception 'Hours: at most eight windows per day'; end if;
  last_end:=null;
  for w in select value from jsonb_array_elements(windows) order by value->>'start' loop
   if jsonb_typeof(w) is distinct from 'object' or coalesce(w->>'start','') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
    or coalesce(w->>'end','') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' or w->>'start'>=w->>'end' then
    raise exception 'Hours: start must precede end on the same day'; end if;
   if last_end is not null and w->>'start'<last_end then raise exception 'Hours: windows overlap'; end if;
   last_end:=w->>'end';
  end loop;
 end loop;
end $$;
create function sms_private.booking_integer(p jsonb,k text,lo integer,hi integer,fallback integer) returns integer
language plpgsql immutable set search_path='' as $$
declare v integer;
begin
 if not p ? k then return fallback; end if;
 if jsonb_typeof(p->k) is distinct from 'number' or (p->>k)!~'^[0-9]+$' then raise exception '%: enter a whole number',k; end if;
 begin v:=(p->>k)::integer; exception when others then raise exception '%: value is out of range',k; end;
 if v<lo or v>hi then raise exception '%: must be between % and %',k,lo,hi; end if;
 return v;
end $$;

create or replace function sms_private.validate_booking_settings_base(input jsonb) returns jsonb
language plpgsql immutable set search_path='' as $$
#variable_conflict use_column
declare weekly jsonb:=coalesce(input->'weeklyAvailability','{}'); exceptions jsonb:=coalesce(input->'dateExceptions','[]'); fields jsonb:=coalesce(input->'extraFields','[]'); item jsonb; win jsonb; keys text[]:='{}'; dates text[]:='{}'; options text[]; k text; typ text;
begin
 if jsonb_typeof(weekly)<>'object' or jsonb_typeof(exceptions)<>'array' or jsonb_typeof(fields)<>'array' then raise exception 'Invalid booking configuration'; end if;
 if jsonb_array_length(exceptions)>366 or jsonb_array_length(fields)>30 or pg_column_size(weekly)>16384 or pg_column_size(exceptions)>32768 or pg_column_size(fields)>32768 then raise exception 'Booking configuration is too large'; end if;
 for k in select jsonb_object_keys(weekly) loop
   if k not in ('0','1','2','3','4','5','6') or jsonb_typeof(weekly->k)<>'array' or jsonb_array_length(weekly->k)>8 then raise exception 'Invalid weekly availability'; end if;
   for win in select value from jsonb_array_elements(weekly->k) loop
     if jsonb_typeof(win)<>'object' or coalesce(win->>'start','')!~'^([01][0-9]|2[0-3]):[0-5][0-9]$' or coalesce(win->>'end','')!~'^([01][0-9]|2[0-3]):[0-5][0-9]$' or (win->>'start')::time >= (win->>'end')::time then raise exception 'Invalid availability window'; end if;
   end loop;
 end loop;
 for item in select value from jsonb_array_elements(exceptions) loop
   if coalesce(item->>'date','')!~'^\d{4}-\d{2}-\d{2}$' then raise exception 'Invalid exception date'; end if;
   perform (item->>'date')::date;
   if (item->>'date')=any(dates) then raise exception 'Duplicate exception date'; end if; dates:=array_append(dates,item->>'date');
   if coalesce((item->>'closed')::boolean,false)=false then
     if jsonb_typeof(coalesce(item->'windows','[]'))<>'array' or jsonb_array_length(coalesce(item->'windows','[]'))>8 then raise exception 'Invalid exception windows'; end if;
     for win in select value from jsonb_array_elements(coalesce(item->'windows','[]')) loop
       if coalesce(win->>'start','')!~'^([01][0-9]|2[0-3]):[0-5][0-9]$' or coalesce(win->>'end','')!~'^([01][0-9]|2[0-3]):[0-5][0-9]$' or (win->>'start')::time >= (win->>'end')::time then raise exception 'Invalid exception window'; end if;
     end loop;
   end if;
 end loop;
 for item in select value from jsonb_array_elements(fields) loop
   k:=coalesce(item->>'key',''); typ:=coalesce(item->>'type','');
   if k!~'^[a-z][a-z0-9_]{0,39}$' or k=any(keys) or length(trim(coalesce(item->>'question',''))) not between 1 and 240 or typ not in ('short_text','long_text','number','boolean','single_select') then raise exception 'Invalid extra booking field'; end if;
   keys:=array_append(keys,k);
   if typ='single_select' and (jsonb_typeof(coalesce(item->'options','[]'))<>'array' or jsonb_array_length(coalesce(item->'options','[]')) not between 1 and 30) then raise exception 'Select fields require options'; end if;
   if typ='single_select' then
     select array_agg(lower(trim(value))) into options from jsonb_array_elements_text(item->'options');
     if exists(select from unnest(options) option where length(option) not between 1 and 100) or (select count(*) from unnest(options))<>(select count(distinct option) from unnest(options) option) then raise exception 'Select options must be unique and 1-100 characters'; end if;
   end if;
 end loop;
 return jsonb_build_object(
   'enabled',coalesce((input->>'enabled')::boolean,false),
   'slotDurationMinutes',greatest(15,least(480,coalesce((input->>'slotDurationMinutes')::integer,60))),
   'capacityPerSlot',greatest(1,least(100,coalesce((input->>'capacityPerSlot')::integer,1))),
   'minimumNoticeMinutes',greatest(0,least(43200,coalesce((input->>'minimumNoticeMinutes')::integer,120))),
   'maximumAdvanceDays',greatest(1,least(730,coalesce((input->>'maximumAdvanceDays')::integer,90))),
   'weeklyAvailability',weekly,'dateExceptions',exceptions,'extraFields',fields);
end $$;
create or replace function sms_private.validate_booking_settings(input jsonb) returns jsonb
language plpgsql immutable set search_path='' as $$
begin
 if jsonb_typeof(input) is distinct from 'object' then raise exception 'SMS settings: expected settings'; end if;
 perform sms_private.validate_schedule(coalesce(input->'weeklyAvailability','{}'),coalesce(input->'dateExceptions','[]'));
 perform sms_private.booking_integer(input,'slotDurationMinutes',15,480,60);
 perform sms_private.booking_integer(input,'capacityPerSlot',1,100,1);
 perform sms_private.booking_integer(input,'minimumNoticeMinutes',0,43200,120);
 perform sms_private.booking_integer(input,'maximumAdvanceDays',1,730,90);
 perform sms_private.booking_integer(input,'followUpDelayHours',1,720,24);
 perform sms_private.booking_integer(input,'followUpIntervalHours',1,720,48);
 perform sms_private.booking_integer(input,'followUpMaxAttempts',1,5,2);
 return sms_private.validate_booking_settings_base(input);
end $$;
create function sms_private.validate_voice_schedule(p jsonb) returns void
language plpgsql stable set search_path='' as $$
begin
 if jsonb_typeof(p) is distinct from 'object' then raise exception 'Voice rule: expected settings'; end if;
 perform sms_private.validate_schedule(p->'weeklyAvailability',coalesce(p->'dateExceptions','[]'));
 if coalesce(p->>'service','') not in ('junk_removal','dumpster_rental','property_cleanout','local_moving') then raise exception 'Service: choose a supported service'; end if;
 if not exists(select from pg_timezone_names where name=p->>'timeZone') then raise exception 'Time zone: choose a valid IANA time zone'; end if;
 perform sms_private.booking_integer(p,'durationMinutes',15,43200,120);
 perform sms_private.booking_integer(p,'capacity',1,100,1);
 perform sms_private.booking_integer(p,'minimumNoticeMinutes',0,43200,120);
 perform sms_private.booking_integer(p,'maximumAdvanceDays',1,730,90);
end $$;
create or replace function sms_private.voice_save_rule(u text,t text,p jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare result public.sms_voice_service_rules; z text; w jsonb; win jsonb; entry jsonb;
begin
  perform sms_private.require_admin(u);
  perform sms_private.validate_voice_schedule(p);
  if not exists(select from public.sms_businesses where tenant_id=t) or p->>'service' not in ('junk_removal','dumpster_rental','property_cleanout','local_moving')
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
create or replace function sms_private.booking_slot_open(
  t text, local_day date, local_clock time without time zone,
  settings public.sms_booking_settings, tz text, exclude_booking text default null
) returns boolean
language plpgsql stable set search_path='' as $$
#variable_conflict use_column
declare windows jsonb; exception jsonb; slot_at timestamptz; begin
 if local_day is null or local_clock is null then return false; end if;
 slot_at:=make_timestamptz(extract(year from local_day)::int,extract(month from local_day)::int,extract(day from local_day)::int,extract(hour from local_clock)::int,extract(minute from local_clock)::int,0,tz);
 if (slot_at at time zone tz)::date<>local_day or (slot_at at time zone tz)::time<>local_clock then return false; end if;
 if slot_at<now()+make_interval(mins=>settings.minimum_notice_minutes) or slot_at>now()+make_interval(days=>settings.maximum_advance_days) then return false; end if;
 select value into exception from jsonb_array_elements(settings.date_exceptions) where value->>'date'=local_day::text limit 1;
 if exception is not null and coalesce((exception->>'closed')::boolean,false) then return false; end if;
 windows:=case when exception is not null then coalesce(exception->'windows','[]') else coalesce(settings.weekly_availability->(extract(dow from local_day)::int)::text,'[]') end;
 if not exists(select from jsonb_array_elements(windows) w
   where local_clock>=(w->>'start')::time
     and extract(epoch from local_clock)+settings.slot_duration_minutes*60
       <=extract(epoch from (w->>'end')::time)) then return false; end if;
 return (select count(*) from public.sms_bookings b where b.tenant_id=t and b.status='confirmed' and b.appointment_at=slot_at and (exclude_booking is null or b.id<>exclude_booking))<settings.capacity_per_slot;
end $$;
create or replace function sms_private.booking_prepare_new(t text,cid text,p jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare r public.sms_voice_service_rules; h sms_private.voice_booking_holds;
  day date; clock time without time zone; starts timestamptz; old public.sms_bookings;
begin
  perform sms_private.voice_read_scope(t);
  if not sms_private.voice_verified(t,cid,p->>'phone') then raise exception 'Phone verification required' using errcode='42501'; end if;
  if p ? 'existingBookingId' then raise exception 'Only new bookings are supported'; end if;
  if length(cid) not between 8 and 160
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
create or replace function sms_private.booking_confirm_new(t text,cid text,hid uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare h sms_private.voice_booking_holds; r public.sms_voice_service_rules;
  b public.sms_bookings; contact_id uuid; intake_id uuid; bid text;
begin
  perform sms_private.voice_read_scope(t);
  select * into strict h from sms_private.voice_booking_holds where tenant_id=t and id=hid
    and call_id=cid for update;
  if h.existing_booking_id is not null then raise exception 'Only new bookings are supported'; end if;
  if not sms_private.voice_verified(t,cid,h.phone) then raise exception 'Phone verification required' using errcode='42501'; end if;
  if h.confirmed_booking_id is not null then
    return jsonb_build_object('status','confirmed','bookingId',h.confirmed_booking_id,'duplicate',true); end if;
  if h.expires_at<=now() then raise exception 'Booking check expired'; end if;
  if not sms_private.voice_verified(t,cid,h.phone)
    then raise exception 'Phone verification required' using errcode='42501'; end if;
  select * into strict r from public.sms_voice_service_rules where tenant_id=t and id=h.rule_id for share;
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

-- Shared enumeration delegates every decision to the existing slot checker.
create function sms_private.availability_slots(t text,day date,s public.sms_booking_settings,r public.sms_voice_service_rules,tz text) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare windows jsonb; exceptions jsonb; exception jsonb; w jsonb; minute integer; stop integer; step integer;
 clock time; starts timestamptz; ends timestamptz; available boolean; used integer; capacity integer; slots jsonb:='[]';
begin
 if r.id is null then
  exceptions:=s.date_exceptions; windows:=s.weekly_availability->(extract(dow from day)::integer)::text;
  step:=s.slot_duration_minutes; capacity:=s.capacity_per_slot;
 else
  exceptions:=r.date_exceptions; windows:=r.weekly_availability->(extract(dow from day)::integer)::text;
  step:=15; capacity:=r.capacity;
 end if;
 select value into exception from jsonb_array_elements(exceptions) where value->>'date'=day::text;
 if exception is not null then
  if (exception->>'closed')::boolean then return slots; end if;
  windows:=exception->'windows';
 end if;
 for w in select value from jsonb_array_elements(coalesce(windows,'[]')) order by value->>'start' loop
  minute:=extract(epoch from (w->>'start')::time)::integer/60;
  stop:=extract(epoch from (w->>'end')::time)::integer/60;
  while minute<stop loop
   clock:=(time '00:00'+make_interval(mins=>minute));
   starts:=(day+clock) at time zone tz;
   if r.id is null then
    available:=sms_private.booking_slot_open(t,day,clock,s,tz);
    ends:=starts+make_interval(mins=>s.slot_duration_minutes);
    select count(*) into used from public.sms_bookings where tenant_id=t and status='confirmed' and appointment_at=starts;
   else
    available:=sms_private.voice_slot_open(r,day,clock);
    ends:=starts+make_interval(mins=>r.duration_minutes);
    select count(*) into used from public.sms_bookings where tenant_id=t and status='confirmed'
      and voice_resource_pool=r.resource_pool and appointment_at<ends and voice_end_at>starts;
   end if;
   slots:=slots||jsonb_build_array(jsonb_build_object('localTime',to_char(clock,'HH24:MI'),'startsAt',starts,'endsAt',ends,
    'available',available,'remainingCapacity',case when available then greatest(0,capacity-used) else 0 end));
   minute:=minute+step;
  end loop;
 end loop;
 return slots;
end $$;
create function sms_private.preview_booking_availability(u text,t text,p jsonb) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare s public.sms_booking_settings; r public.sms_voice_service_rules; v jsonb; d date; tz text; enabled boolean;
begin
 perform sms_private.require_admin(u);
 select time_zone into strict tz from public.sms_businesses where tenant_id=t;
 if coalesce(p->>'localDate','')!~'^\d{4}-\d{2}-\d{2}$' then raise exception 'Date: choose a calendar date'; end if;
 begin d:=(p->>'localDate')::date; exception when others then raise exception 'Date: invalid calendar date'; end;
 if p->>'channel'='sms' then
  v:=sms_private.validate_booking_settings(p->'settings');
  s.tenant_id:=t;s.enabled:=coalesce((v->>'enabled')::boolean,false);
  s.slot_duration_minutes:=(v->>'slotDurationMinutes')::integer;s.capacity_per_slot:=(v->>'capacityPerSlot')::integer;
  s.minimum_notice_minutes:=(v->>'minimumNoticeMinutes')::integer;s.maximum_advance_days:=(v->>'maximumAdvanceDays')::integer;
  s.weekly_availability:=v->'weeklyAvailability';s.date_exceptions:=v->'dateExceptions';enabled:=s.enabled;
 elsif p->>'channel'='voice' then
  v:=p->'rule';perform sms_private.validate_voice_schedule(v);
  r.id:=coalesce(nullif(v->>'id','')::uuid,'00000000-0000-4000-8000-000000000000'::uuid);r.tenant_id:=t;
  r.service:=v->>'service';r.resource_pool:=v->>'resourcePool';r.time_zone:=v->>'timeZone';tz:=r.time_zone;
  r.duration_minutes:=sms_private.booking_integer(v,'durationMinutes',15,43200,120);r.capacity:=sms_private.booking_integer(v,'capacity',1,100,1);
  r.minimum_notice_minutes:=sms_private.booking_integer(v,'minimumNoticeMinutes',0,43200,120);
  r.maximum_advance_days:=sms_private.booking_integer(v,'maximumAdvanceDays',1,730,90);
  r.weekly_availability:=v->'weeklyAvailability';r.date_exceptions:=coalesce(v->'dateExceptions','[]');
  enabled:=coalesce((v->>'enabled')::boolean,false);r.enabled:=true;
 else raise exception 'Channel: choose SMS or voice'; end if;
 return jsonb_build_object('timeZone',tz,'localDate',d,'configuredEnabled',enabled,
  'hypothetical',not enabled or p->>'channel'='sms','smsActive',false,
  'slots',sms_private.availability_slots(t,d,s,r,tz));
end $$;

create schema voice_booking_api;
revoke all on schema voice_booking_api from public;
create role sms_voice_booking nologin nosuperuser nobypassrls;
grant usage on schema voice_booking_api to sms_voice_booking;
create function voice_booking_api.availability(t text,cid text,p jsonb) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare r public.sms_voice_service_rules; s public.sms_booking_settings; slots jsonb; day date;
begin
 perform sms_private.voice_read_scope(t);
 if cid is null or length(cid) not between 8 and 160 or coalesce(p->>'zip','')!~'^[0-9]{5}$'
  or coalesce(p->>'localDate','')!~'^\d{4}-\d{2}-\d{2}$' then raise exception 'Service, ZIP and calendar date required'; end if;
 begin day:=(p->>'localDate')::date; exception when others then raise exception 'Invalid calendar date'; end;
 select * into r from public.sms_voice_service_rules where tenant_id=t and enabled and service=p->>'service'
  and variant=coalesce(p->>'variant','') and p->>'zip'=any(zip_codes) limit 1;
 if r.id is null then return jsonb_build_object('configured',false,'slots','[]'::jsonb); end if;
 slots:=sms_private.availability_slots(t,day,s,r,r.time_zone);
 return jsonb_build_object('configured',true,'service',r.service,'variant',r.variant,'timeZone',r.time_zone,'localDate',day,
  'slots',(select coalesce(jsonb_agg(value),'[]') from jsonb_array_elements(slots) where (value->>'available')::boolean));
end $$;
create function voice_booking_api.prepare(t text,cid text,p jsonb) returns jsonb
language sql security definer set search_path='' as $$ select sms_private.booking_prepare_new(t,cid,p); $$;
create function voice_booking_api.confirm(t text,cid text,hid uuid) returns jsonb
language sql security definer set search_path='' as $$ select sms_private.booking_confirm_new(t,cid,hid); $$;
revoke all on all functions in schema voice_booking_api from public,anon,authenticated,service_role;
grant execute on all functions in schema voice_booking_api to sms_voice_booking;
revoke all on function sms_private.validate_schedule(jsonb,jsonb),sms_private.booking_integer(jsonb,text,integer,integer,integer),
 sms_private.validate_booking_settings_base(jsonb),sms_private.validate_voice_schedule(jsonb),
 sms_private.booking_prepare_new(text,text,jsonb),sms_private.booking_confirm_new(text,text,uuid),
 sms_private.availability_slots(text,date,public.sms_booking_settings,public.sms_voice_service_rules,text),
 sms_private.preview_booking_availability(text,text,jsonb) from public,anon,authenticated,service_role;
grant execute on function sms_private.preview_booking_availability(text,text,jsonb) to sms_api;
