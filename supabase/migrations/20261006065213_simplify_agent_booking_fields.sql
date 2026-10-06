-- CRM forward-only migration; requires 20261006060755 and its booking prerequisites.
-- Agent booking selects a schedule by service, without ZIP or dumpster-size filters.
-- Keep legacy columns and payload compatibility; do not alter existing history.
-- Fail on pre-existing ambiguity instead of choosing an arbitrary enabled schedule.
create unique index sms_voice_one_enabled_service on public.sms_voice_service_rules(tenant_id,service) where enabled;
create or replace function sms_private.voice_save_rule(u text,t text,p jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare result public.sms_voice_service_rules; z text; w jsonb; win jsonb; entry jsonb;
begin
  perform sms_private.require_admin(u);
  if not sms_private.can_access(t,u) then raise exception 'Business access denied' using errcode='42501'; end if;
  p:=p||jsonb_build_object('zipCodes',coalesce(p->'zipCodes','[]'::jsonb));
  perform sms_private.validate_voice_schedule(p);
  if not exists(select from public.sms_businesses where tenant_id=t) or p->>'service' not in ('junk_removal','dumpster_rental','property_cleanout','local_moving')
    or length(coalesce(p->>'variant',''))>80
    or (p->>'service'<>'dumpster_rental' and length(btrim(coalesce(p->>'variant','')))>0)
    or length(btrim(coalesce(p->>'market',''))) not between 1 and 100
    or length(btrim(coalesce(p->>'resourcePool',''))) not between 1 and 100
    or not exists(select 1 from pg_timezone_names where name=p->>'timeZone')
    or jsonb_typeof(p->'zipCodes') is distinct from 'array' or jsonb_array_length(p->'zipCodes')>1000
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
  if coalesce((p->>'enabled')::boolean,false) and exists(select 1 from public.sms_voice_service_rules r
    where r.tenant_id=t and r.service=p->>'service' and r.enabled
      and (p->>'id' is null or r.id<>(p->>'id')::uuid))
    then raise exception 'Service: only one schedule can be enabled per service'; end if;
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
    or not sms_private.voice_valid_phone(p->>'phone')
    or length(btrim(coalesce(p->>'name',''))) not between 1 and 200
    or length(btrim(coalesce(p->>'address',''))) not between 5 and 500
    or p->>'localDate' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
    or p->>'localTime' !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
    or jsonb_typeof(coalesce(p->'details','{}'::jsonb))<>'object'
    or pg_column_size(coalesce(p->'details','{}'::jsonb))>16384
    then raise exception 'Incomplete booking details'; end if;
  day:=(p->>'localDate')::date;clock:=(p->>'localTime')::time;
  select * into r from public.sms_voice_service_rules
    where tenant_id=t and service=p->>'service' and enabled;
  if not found then return jsonb_build_object('available',false,'reason','No configured live booking for this service'); end if;
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
  values(t,cid,p->>'phone',btrim(p->>'name'),r.service,r.variant,'',btrim(p->>'address'),
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
  if r.version<>h.rule_version or r.service<>h.service or r.variant<>h.variant
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
create or replace function voice_booking_api.availability(t text,cid text,p jsonb) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare r public.sms_voice_service_rules; s public.sms_booking_settings; slots jsonb; day date;
begin
 perform sms_private.voice_read_scope(t);
 if cid is null or length(cid) not between 8 and 160 or coalesce(p->>'service','') not in ('junk_removal','dumpster_rental','property_cleanout','local_moving')
  or coalesce(p->>'localDate','')!~'^\d{4}-\d{2}-\d{2}$' then raise exception 'Service and calendar date required'; end if;
 begin day:=(p->>'localDate')::date; exception when others then raise exception 'Invalid calendar date'; end;
 select * into r from public.sms_voice_service_rules where tenant_id=t and enabled and service=p->>'service';
 if r.id is null then return jsonb_build_object('configured',false,'slots','[]'::jsonb); end if;
 slots:=sms_private.availability_slots(t,day,s,r,r.time_zone);
 return jsonb_build_object('configured',true,'service',r.service,'variant',r.variant,'timeZone',r.time_zone,'localDate',day,
  'slots',(select coalesce(jsonb_agg(value),'[]') from jsonb_array_elements(slots) where (value->>'available')::boolean));
end $$;
-- CREATE OR REPLACE retains the existing narrow grants and CRM attribution wrapper.
