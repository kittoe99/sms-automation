-- Time arithmetic wraps at midnight. Compare seconds within the day so a slot
-- cannot spill into the next day and the alternatives scan always terminates.
create or replace function sms_private.booking_slot_open(
  t text, local_day date, local_clock time without time zone,
  settings public.sms_booking_settings, tz text, exclude_booking text default null
) returns boolean
language plpgsql stable set search_path='' as $$
#variable_conflict use_column
declare windows jsonb; exception jsonb; slot_at timestamptz; begin
 if local_day is null or local_clock is null then return false; end if;
 slot_at:=make_timestamptz(extract(year from local_day)::int,extract(month from local_day)::int,extract(day from local_day)::int,extract(hour from local_clock)::int,extract(minute from local_clock)::int,0,tz);
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

create or replace function sms_private.booking_alternatives(
  t text, settings public.sms_booking_settings, tz text
) returns text
language plpgsql stable set search_path='' as $$
#variable_conflict use_column
declare day_offset integer; local_day date; windows jsonb; exception jsonb; win jsonb; candidate time; labels text[]:='{}'; begin
 for day_offset in 0..least(settings.maximum_advance_days,30) loop
   local_day:=(now() at time zone tz)::date+day_offset;
   select value into exception from jsonb_array_elements(settings.date_exceptions) where value->>'date'=local_day::text limit 1;
   if exception is not null and coalesce((exception->>'closed')::boolean,false) then continue; end if;
   windows:=case when exception is not null then coalesce(exception->'windows','[]') else coalesce(settings.weekly_availability->(extract(dow from local_day)::int)::text,'[]') end;
   for win in select value from jsonb_array_elements(windows) loop
     candidate:=(win->>'start')::time;
     while extract(epoch from candidate)+settings.slot_duration_minutes*60
       <=extract(epoch from (win->>'end')::time) loop
       if sms_private.booking_slot_open(t,local_day,candidate,settings,tz) then
         labels:=array_append(labels,to_char(local_day,'Dy Mon FMDD')||' at '||to_char(candidate,'FMHH12:MI AM'));
         if cardinality(labels)=3 then return array_to_string(labels,', '); end if;
       end if;
       candidate:=candidate+make_interval(mins=>settings.slot_duration_minutes);
     end loop;
   end loop;
 end loop;
 return array_to_string(labels,', ');
end $$;
