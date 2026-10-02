-- Bounded AI follow-ups for abandoned SMS booking drafts.
alter table public.sms_booking_settings
  add column follow_up_enabled boolean not null default false,
  add column follow_up_delay_hours integer not null default 24 check(follow_up_delay_hours between 1 and 720),
  add column follow_up_interval_hours integer not null default 48 check(follow_up_interval_hours between 1 and 720),
  add column follow_up_max_attempts integer not null default 2 check(follow_up_max_attempts between 1 and 5);

alter table public.sms_booking_sessions
  add column follow_up_count integer not null default 0 check(follow_up_count between 0 and 5),
  add column next_follow_up_at timestamptz,
  add column last_follow_up_at timestamptz;

create index sms_booking_sessions_follow_up_due
on public.sms_booking_sessions(next_follow_up_at)
where next_follow_up_at is not null;

create or replace function sms_private.booking_settings(u text,t text) returns jsonb
language plpgsql security definer set search_path='' as $$
#variable_conflict use_column
declare s public.sms_booking_settings; begin
 perform sms_private.require_admin(u); select * into s from public.sms_booking_settings where tenant_id=t;
 return jsonb_build_object('enabled',coalesce(s.enabled,false),'version',coalesce(s.version,0),'slotDurationMinutes',coalesce(s.slot_duration_minutes,60),'capacityPerSlot',coalesce(s.capacity_per_slot,1),'minimumNoticeMinutes',coalesce(s.minimum_notice_minutes,120),'maximumAdvanceDays',coalesce(s.maximum_advance_days,90),'weeklyAvailability',coalesce(s.weekly_availability,'{"0":[],"1":[],"2":[],"3":[],"4":[],"5":[],"6":[]}'::jsonb),'dateExceptions',coalesce(s.date_exceptions,'[]'::jsonb),'extraFields',coalesce(s.extra_fields,'[]'::jsonb),'followUpEnabled',coalesce(s.follow_up_enabled,false),'followUpDelayHours',coalesce(s.follow_up_delay_hours,24),'followUpIntervalHours',coalesce(s.follow_up_interval_hours,48),'followUpMaxAttempts',coalesce(s.follow_up_max_attempts,2));
end $$;

create or replace function sms_private.save_booking_settings(u text,t text,input jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
#variable_conflict use_column
declare v jsonb; s public.sms_booking_settings; delay_hours integer; interval_hours integer; max_attempts integer; begin
 perform sms_private.require_admin(u); v:=sms_private.validate_booking_settings(input);
 delay_hours:=greatest(1,least(720,coalesce((input->>'followUpDelayHours')::integer,24)));
 interval_hours:=greatest(1,least(720,coalesce((input->>'followUpIntervalHours')::integer,48)));
 max_attempts:=greatest(1,least(5,coalesce((input->>'followUpMaxAttempts')::integer,2)));
 insert into public.sms_booking_settings(tenant_id,enabled,slot_duration_minutes,capacity_per_slot,minimum_notice_minutes,maximum_advance_days,weekly_availability,date_exceptions,extra_fields,follow_up_enabled,follow_up_delay_hours,follow_up_interval_hours,follow_up_max_attempts,updated_by)
 values(t,(v->>'enabled')::boolean,(v->>'slotDurationMinutes')::integer,(v->>'capacityPerSlot')::integer,(v->>'minimumNoticeMinutes')::integer,(v->>'maximumAdvanceDays')::integer,v->'weeklyAvailability',v->'dateExceptions',v->'extraFields',coalesce((input->>'followUpEnabled')::boolean,false),delay_hours,interval_hours,max_attempts,u)
 on conflict(tenant_id) do update set enabled=excluded.enabled,version=sms_booking_settings.version+1,slot_duration_minutes=excluded.slot_duration_minutes,capacity_per_slot=excluded.capacity_per_slot,minimum_notice_minutes=excluded.minimum_notice_minutes,maximum_advance_days=excluded.maximum_advance_days,weekly_availability=excluded.weekly_availability,date_exceptions=excluded.date_exceptions,extra_fields=excluded.extra_fields,follow_up_enabled=excluded.follow_up_enabled,follow_up_delay_hours=excluded.follow_up_delay_hours,follow_up_interval_hours=excluded.follow_up_interval_hours,follow_up_max_attempts=excluded.follow_up_max_attempts,updated_by=u,updated_at=now() returning * into s;
 return sms_private.booking_settings(u,t);
end $$;

-- Any new booking activity resets the bounded follow-up cadence. This trigger is
-- deliberately database-owned so API or worker callers cannot forget it.
create or replace function sms_private.schedule_booking_session_follow_up() returns trigger
language plpgsql security definer set search_path='' as $$
declare settings public.sms_booking_settings; begin
 select * into settings from public.sms_booking_settings where tenant_id=new.tenant_id;
 if settings.follow_up_enabled then
   if tg_op='INSERT' then new.follow_up_count:=0; end if;
   new.next_follow_up_at:=now()+make_interval(hours=>settings.follow_up_delay_hours);
 else new.next_follow_up_at:=null; end if;
 return new;
end $$;
create trigger sms_booking_session_follow_up_schedule before insert or update of customer_name,service_address,local_date,local_time,extra_answers on public.sms_booking_sessions for each row execute function sms_private.schedule_booking_session_follow_up();

create or replace function sms_private.queue_booking_followups() returns integer
language plpgsql security definer set search_path='' as $$
#variable_conflict use_column
declare row record; gid text; jid uuid; n integer:=0; begin
 if not (select scheduler_enabled from sms_private.runtime) then return 0; end if;
 for row in
   select s.*,c.phone,th.generation,settings.follow_up_interval_hours,settings.follow_up_max_attempts
   from public.sms_booking_sessions s
   join public.sms_booking_settings settings using(tenant_id)
   join public.sms_contacts c on c.tenant_id=s.tenant_id and c.id=s.contact_id
   join public.sms_thread_contacts th on th.tenant_id=s.tenant_id and th.phone=c.phone
   join public.sms_businesses b on b.tenant_id=s.tenant_id
   where settings.enabled and settings.follow_up_enabled and s.next_follow_up_at<=now()
     and s.expires_at>now() and s.follow_up_count<settings.follow_up_max_attempts
     and not c.opted_out and not th.ai_paused and b.status='active' and b.sending_enabled
   order by s.next_follow_up_at limit 100 for update of s skip locked
 loop
   select a.group_id into gid from public.sms_ai_settings a where a.tenant_id=row.tenant_id and a.enabled order by a.default_for_inbound desc,a.updated_at desc limit 1;
   if gid is null then continue; end if;
   jid:=sms_private.enqueue(row.tenant_id,'ai_reply_jobs','booking-followup:'||row.contact_id||':'||(row.follow_up_count+1),jsonb_build_object('phone',row.phone,'generation',row.generation,'group_id',gid,'booking_follow_up',true,'follow_up_number',row.follow_up_count+1));
   update public.sms_booking_sessions set follow_up_count=follow_up_count+1,last_follow_up_at=now(),next_follow_up_at=case when follow_up_count+1>=row.follow_up_max_attempts then null else now()+make_interval(hours=>row.follow_up_interval_hours) end,updated_at=updated_at where tenant_id=row.tenant_id and contact_id=row.contact_id;
   n:=n+1;
 end loop;
 return n;
end $$;
revoke all on function sms_private.schedule_booking_session_follow_up(),sms_private.queue_booking_followups() from public,anon,authenticated,sms_api,sms_webhook,sms_sender,sms_ai,sms_automation;

-- Supabase pg_cron provides the durable schedule; edge dispatch picks up the
-- resulting ai_reply_jobs on its existing five-second cycle.
select cron.schedule('booking-ai-followups','*/5 * * * *','select sms_private.queue_booking_followups()');
