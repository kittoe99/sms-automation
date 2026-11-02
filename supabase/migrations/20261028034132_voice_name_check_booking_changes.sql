-- CRM-owned forward migration. Requires CRM 20261022175711 (voice in-call SMS).
-- Phone calls confirm a caller with the booking's phone number plus the full name on it
-- instead of a texted code, book new appointments without a code, and can reschedule,
-- cancel or update a confirmed booking for that confirmed phone.

create table sms_private.voice_identity_checks (
  tenant_id text not null references public.sms_businesses(tenant_id),
  call_id text not null,
  phone text not null,
  attempts integer not null default 0,
  verified_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (tenant_id,call_id,phone),
  check (length(call_id) between 8 and 160),
  check (phone ~ '^[+][1-9][0-9]{7,14}$')
);
alter table sms_private.voice_identity_checks enable row level security;
revoke all on sms_private.voice_identity_checks from public,anon,authenticated,sms_api,sms_ai,sms_webhook,sms_sender,sms_automation;

-- Case, punctuation, spacing and word order do not matter; every word must match.
create function sms_private.voice_name_key(n text) returns text
language sql immutable set search_path='' as $$
  select coalesce(string_agg(w,' ' order by w),'')
  from regexp_split_to_table(lower(regexp_replace(regexp_replace(coalesce(n,''),'[-_.]',' ','g'),'[^[:alpha:][:space:]]','','g')),'\s+') w
  where w<>''
$$;

create function sms_private.voice_phone_bookings(t text,ph text) returns setof public.sms_bookings
language sql stable security definer set search_path='' as $$
  select b.* from public.sms_bookings b where b.tenant_id=t and (b.customer_phone=ph or b.contact_id in (
    select id from public.sms_contacts where tenant_id=t and phone=ph))
$$;

-- A phone match only says whether a booking exists; details need the name as well.
create function sms_private.voice_find_bookings(t text,cid text,ph text) returns jsonb
language plpgsql stable security definer set search_path='' as $$
begin
  perform sms_private.voice_read_scope(t);
  if length(coalesce(cid,'')) not between 8 and 160 or not sms_private.voice_valid_phone(ph)
    then raise exception 'Valid phone required'; end if;
  return jsonb_build_object('found',exists(select 1 from sms_private.voice_phone_bookings(t,ph) b
    where b.status in ('confirmed','requested')));
end $$;

create function sms_private.voice_identify(t text,cid text,ph text,n text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare c sms_private.voice_identity_checks; matched boolean;
begin
  perform sms_private.voice_read_scope(t);
  if length(coalesce(cid,'')) not between 8 and 160 or not sms_private.voice_valid_phone(ph)
    or length(btrim(coalesce(n,''))) not between 1 and 200 then raise exception 'Phone and name required'; end if;
  delete from sms_private.voice_identity_checks where tenant_id=t and updated_at<now()-interval '2 days';
  insert into sms_private.voice_identity_checks(tenant_id,call_id,phone) values(t,cid,ph) on conflict do nothing;
  select * into strict c from sms_private.voice_identity_checks where tenant_id=t and call_id=cid and phone=ph for update;
  if c.verified_at is null and c.attempts>=3 then return jsonb_build_object('verified',false,'attemptsLeft',0); end if;
  matched:=sms_private.voice_name_key(n)<>'' and exists(select 1 from sms_private.voice_phone_bookings(t,ph) b
    left join public.sms_contacts k on k.tenant_id=b.tenant_id and k.id=b.contact_id
    where b.status in ('confirmed','requested') and sms_private.voice_name_key(n) in
      (sms_private.voice_name_key(b.customer_name),sms_private.voice_name_key(k.name)));
  update sms_private.voice_identity_checks set attempts=attempts+case when matched then 0 else 1 end,
    verified_at=case when matched then now() else verified_at end,updated_at=now()
    where tenant_id=t and call_id=cid and phone=ph;
  return jsonb_build_object('verified',matched,'attemptsLeft',greatest(0,3-c.attempts-case when matched then 0 else 1 end));
end $$;

-- A matched name now counts the same as a verified code for this call and phone.
create or replace function sms_private.voice_verified(t text,cid text,ph text) returns boolean
language sql stable security definer set search_path='' as $$
  select exists(select 1 from sms_private.voice_otps o
      where o.tenant_id=t and o.call_id=cid and o.phone=ph and o.verified_at>now()-interval '30 minutes')
    or exists(select 1 from sms_private.voice_identity_checks i
      where i.tenant_id=t and i.call_id=cid and i.phone=ph and i.verified_at>now()-interval '30 minutes')
$$;

-- New phone bookings no longer need a texted code. SMS-channel booking is unchanged.
create or replace function sms_private.booking_prepare_new(t text,cid text,p jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$ begin
 perform sms_private.voice_read_scope(t);
 return sms_private.booking_prepare_shared(t,cid,p,'voice');
end $$;
create or replace function sms_private.booking_confirm_new(t text,cid text,hid uuid) returns jsonb
language plpgsql security definer set search_path='' as $$ begin
 perform sms_private.voice_read_scope(t);
 return sms_private.booking_confirm_shared(t,cid,hid,'voice');
end $$;

-- Check (apply=false) or make (apply=true) one change to a confirmed booking owned by a
-- name-confirmed phone. Moves recheck the shared capacity under the same pool lock as
-- new bookings. Changes inside 72 hours need the caller's agreement to the $69 fee.
create function sms_private.voice_change_booking(t text,cid text,p jsonb,apply boolean) returns jsonb
language plpgsql security definer set search_path='' as $$
declare b public.sms_bookings; r public.sms_voice_service_rules; kind text; ph text;
  day date; clock time without time zone; starts timestamptz; late boolean; entry jsonb;
  address text; notes text;
begin
  perform sms_private.voice_read_scope(t);
  kind:=p->>'kind'; ph:=p->>'phone';
  address:=nullif(btrim(coalesce(p->>'address','')),''); notes:=nullif(btrim(coalesce(p->>'notes','')),'');
  if length(coalesce(cid,'')) not between 8 and 160 or coalesce(kind,'') not in ('reschedule','cancel','update')
    or not sms_private.voice_valid_phone(ph) or length(coalesce(p->>'bookingId','')) not between 1 and 255
    then raise exception 'Invalid booking change'; end if;
  if not sms_private.voice_verified(t,cid,ph)
    then raise exception 'Confirm the name on the booking first' using errcode='42501'; end if;
  select * into b from public.sms_bookings x where x.tenant_id=t and x.id=p->>'bookingId'
    and (x.customer_phone=ph or x.contact_id in (select id from public.sms_contacts where tenant_id=t and phone=ph))
    for update;
  if b.id is null then raise exception 'Booking not found'; end if;
  if b.status='cancelled' and kind='cancel' then
    return jsonb_build_object('status','cancelled','bookingId',b.id,'duplicate',true); end if;
  if b.status<>'confirmed' then raise exception 'Only confirmed bookings can be changed by phone'; end if;
  late:=kind in ('reschedule','cancel') and b.appointment_at<now()+interval '72 hours';
  if kind='reschedule' then
    if coalesce(p->>'localDate','') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
      or coalesce(p->>'localTime','') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' then raise exception 'Choose a new date and time'; end if;
    day:=(p->>'localDate')::date; clock:=(p->>'localTime')::time;
    select * into r from public.sms_voice_service_rules where tenant_id=t and service=b.voice_service and enabled limit 1;
    if r.id is null then return jsonb_build_object('available',false,'reason','No live schedule for this booking''s service'); end if;
    starts:=make_timestamptz(extract(year from day)::integer,extract(month from day)::integer,
      extract(day from day)::integer,extract(hour from clock)::integer,extract(minute from clock)::integer,0,r.time_zone);
    if starts=b.appointment_at then
      return jsonb_build_object('status','confirmed','bookingId',b.id,'appointmentAt',b.appointment_at,
        'timeZone',b.time_zone,'duplicate',true); end if;
    if apply then perform pg_advisory_xact_lock(hashtextextended(t||':voice-pool:'||r.resource_pool,992)); end if;
    if not sms_private.voice_slot_open(r,day,clock,b.id) then
      return jsonb_build_object('available',false,'reason','That time is not available'); end if;
  elsif kind='update' then
    if address is null and notes is null then raise exception 'Say what to change on the booking'; end if;
    if length(coalesce(address,'xxxxx'))<5 or length(coalesce(address,''))>500 or length(coalesce(notes,''))>2000
      then raise exception 'Invalid address or notes'; end if;
  end if;
  if not apply then
    return jsonb_build_object('available',true,'kind',kind,'bookingId',b.id,'service',b.voice_service,
      'currentAppointmentAt',b.appointment_at,'newAppointmentAt',starts,'timeZone',coalesce(r.time_zone,b.time_zone),
      'address',coalesce(address,b.service_address),'notes',notes,'lateFee',case when late then 69 else 0 end);
  end if;
  if late and coalesce(p->>'lateFeeAccepted','')<>'true'
    then raise exception 'The caller must agree to the $69 late change fee first'; end if;
  entry:=jsonb_strip_nulls(jsonb_build_object('kind',kind,'at',now(),'callId',cid,
    'previousAppointmentAt',case when kind='reschedule' then b.appointment_at end,
    'address',address,'notes',notes,'lateFee',case when late then 69 end));
  if kind='reschedule' then
    update public.sms_bookings set appointment_at=starts,voice_end_at=starts+make_interval(mins=>r.duration_minutes),
      voice_resource_pool=r.resource_pool,voice_market=r.market,time_zone=r.time_zone,updated_at=now(),
      metadata=metadata||jsonb_build_object('voice_changes',coalesce(metadata->'voice_changes','[]'::jsonb)||jsonb_build_array(entry))
        ||case when late then jsonb_build_object('late_change_fee',69) else '{}'::jsonb end
      where tenant_id=t and id=b.id returning * into b;
  elsif kind='cancel' then
    update public.sms_bookings set status='cancelled',cancelled_at=now(),updated_at=now(),
      metadata=metadata||jsonb_build_object('cancelled_by','voice:'||cid,
        'voice_changes',coalesce(metadata->'voice_changes','[]'::jsonb)||jsonb_build_array(entry))
        ||case when late then jsonb_build_object('late_change_fee',69) else '{}'::jsonb end
      where tenant_id=t and id=b.id returning * into b;
    update public.sms_automation_enrollments set status='cancelled',generation=generation+1
      where tenant_id=t and status in ('active','paused') and metadata->>'booking_id'=b.id;
  else
    update public.sms_bookings set service_address=coalesce(address,service_address),updated_at=now(),
      extra_answers=extra_answers||case when notes is null then '{}'::jsonb else jsonb_build_object('voice_notes',notes) end,
      metadata=metadata||jsonb_build_object('voice_changes',coalesce(metadata->'voice_changes','[]'::jsonb)||jsonb_build_array(entry))
      where tenant_id=t and id=b.id returning * into b;
  end if;
  insert into sms_private.audit(tenant_id,actor,action,detail)
    values(t,'voice:'||cid,'booking_voice_'||kind,jsonb_build_object('bookingId',b.id)||entry);
  return jsonb_build_object('status',b.status,'bookingId',b.id,'appointmentAt',b.appointment_at,'timeZone',b.time_zone,
    'address',b.service_address,'lateFee',case when late then 69 else 0 end,'duplicate',false);
end $$;

revoke all on function sms_private.voice_name_key(text),sms_private.voice_phone_bookings(text,text),
  sms_private.voice_find_bookings(text,text,text),sms_private.voice_identify(text,text,text,text),
  sms_private.voice_change_booking(text,text,jsonb,boolean)
  from public,anon,authenticated,service_role,sms_api,sms_ai,sms_webhook,sms_sender,sms_automation;

create function voice_lookup_api.voice_find_bookings(t text,cid text,ph text) returns jsonb
language sql stable security definer set search_path='' as $$ select sms_private.voice_find_bookings(t,cid,ph); $$;
create function voice_lookup_api.voice_identify(t text,cid text,ph text,n text) returns jsonb
language sql security definer set search_path='' as $$ select sms_private.voice_identify(t,cid,ph,n); $$;
revoke all on function voice_lookup_api.voice_find_bookings(text,text,text),voice_lookup_api.voice_identify(text,text,text,text)
  from public,anon,authenticated,service_role;
grant execute on function voice_lookup_api.voice_find_bookings(text,text,text),voice_lookup_api.voice_identify(text,text,text,text)
  to sms_voice_lookup;

create function voice_booking_api.check_change(t text,cid text,p jsonb) returns jsonb
language sql security definer set search_path='' as $$ select sms_private.voice_change_booking(t,cid,p,false); $$;
create function voice_booking_api.apply_change(t text,cid text,p jsonb) returns jsonb
language sql security definer set search_path='' as $$ select sms_private.voice_change_booking(t,cid,p,true); $$;
revoke all on function voice_booking_api.check_change(text,text,jsonb),voice_booking_api.apply_change(text,text,jsonb)
  from public,anon,authenticated,service_role;
grant execute on function voice_booking_api.check_change(text,text,jsonb),voice_booking_api.apply_change(text,text,jsonb)
  to sms_voice_booking;
