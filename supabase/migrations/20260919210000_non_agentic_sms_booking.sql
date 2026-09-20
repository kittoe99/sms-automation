-- Deterministic, tenant-isolated SMS booking. The model extracts values only;
-- all validation and mutations happen in these database functions.

alter table public.sms_bookings
  add column if not exists customer_name text,
  add column if not exists customer_phone text,
  add column if not exists service_address text,
  add column if not exists time_zone text,
  add column if not exists extra_answers jsonb not null default '{}',
  add column if not exists booking_settings_version bigint,
  add column if not exists source text not null default 'integration',
  add column if not exists confirmed_at timestamptz,
  add column if not exists cancelled_at timestamptz,
  add column if not exists created_at timestamptz not null default now();

alter table public.sms_bookings drop constraint if exists sms_bookings_status_check;
alter table public.sms_bookings add constraint sms_bookings_status_check
  check(status in ('confirmed','cancelled','requested'));
alter table public.sms_bookings add constraint sms_bookings_extra_answers_object
  check(jsonb_typeof(extra_answers)='object' and pg_column_size(extra_answers)<=32768);
create index if not exists sms_bookings_tenant_time on public.sms_bookings(tenant_id,appointment_at) where status='confirmed';

create table public.sms_booking_settings (
  tenant_id text primary key references public.sms_businesses(tenant_id) on delete cascade,
  enabled boolean not null default false,
  version bigint not null default 1,
  slot_duration_minutes integer not null default 60 check(slot_duration_minutes between 15 and 480),
  capacity_per_slot integer not null default 1 check(capacity_per_slot between 1 and 100),
  minimum_notice_minutes integer not null default 120 check(minimum_notice_minutes between 0 and 43200),
  maximum_advance_days integer not null default 90 check(maximum_advance_days between 1 and 730),
  weekly_availability jsonb not null default '{"0":[],"1":[],"2":[],"3":[],"4":[],"5":[],"6":[]}',
  date_exceptions jsonb not null default '[]',
  extra_fields jsonb not null default '[]',
  updated_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check(jsonb_typeof(weekly_availability)='object' and pg_column_size(weekly_availability)<=16384),
  check(jsonb_typeof(date_exceptions)='array' and jsonb_array_length(date_exceptions)<=366 and pg_column_size(date_exceptions)<=32768),
  check(jsonb_typeof(extra_fields)='array' and jsonb_array_length(extra_fields)<=30 and pg_column_size(extra_fields)<=32768)
);

create table public.sms_booking_sessions (
  tenant_id text not null references public.sms_businesses(tenant_id) on delete cascade,
  contact_id uuid not null,
  state text not null default 'collecting' check(state in ('collecting','awaiting_confirmation')),
  customer_name text,
  customer_phone text not null,
  service_address text,
  local_date date,
  local_time time without time zone,
  extra_answers jsonb not null default '{}',
  settings_version bigint not null,
  conversation_generation bigint not null,
  expires_at timestamptz not null default now()+interval '7 days',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key(tenant_id,contact_id),
  foreign key(tenant_id,contact_id) references public.sms_contacts(tenant_id,id) on delete cascade,
  check(jsonb_typeof(extra_answers)='object' and pg_column_size(extra_answers)<=32768),
  check(length(coalesce(customer_name,''))<=200 and length(customer_phone)<=32 and length(coalesce(service_address,''))<=500)
);

alter table public.sms_booking_settings enable row level security;
alter table public.sms_booking_sessions enable row level security;
revoke all on public.sms_booking_settings,public.sms_booking_sessions from public,anon,authenticated;

create or replace function sms_private.validate_booking_settings(input jsonb) returns jsonb
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

create or replace function sms_private.booking_alternatives(t text,settings public.sms_booking_settings,tz text) returns text
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
     while candidate+make_interval(mins=>settings.slot_duration_minutes)<=(win->>'end')::time loop
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

create or replace function sms_private.booking_settings(u text,t text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare s public.sms_booking_settings; begin
 perform sms_private.require_admin(u);
 if not exists(select from public.sms_businesses where tenant_id=t) then raise exception 'Unknown business'; end if;
 select * into s from public.sms_booking_settings where tenant_id=t;
 return jsonb_build_object('enabled',coalesce(s.enabled,false),'version',coalesce(s.version,0),'slotDurationMinutes',coalesce(s.slot_duration_minutes,60),'capacityPerSlot',coalesce(s.capacity_per_slot,1),'minimumNoticeMinutes',coalesce(s.minimum_notice_minutes,120),'maximumAdvanceDays',coalesce(s.maximum_advance_days,90),'weeklyAvailability',coalesce(s.weekly_availability,'{"0":[],"1":[],"2":[],"3":[],"4":[],"5":[],"6":[]}'::jsonb),'dateExceptions',coalesce(s.date_exceptions,'[]'::jsonb),'extraFields',coalesce(s.extra_fields,'[]'::jsonb));
end $$;

create or replace function sms_private.save_booking_settings(u text,t text,input jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
#variable_conflict use_column
declare v jsonb; s public.sms_booking_settings; begin
 perform sms_private.require_admin(u); if not exists(select from public.sms_businesses where tenant_id=t) then raise exception 'Unknown business'; end if;
 v:=sms_private.validate_booking_settings(input);
 insert into public.sms_booking_settings(tenant_id,enabled,slot_duration_minutes,capacity_per_slot,minimum_notice_minutes,maximum_advance_days,weekly_availability,date_exceptions,extra_fields,updated_by)
 values(t,(v->>'enabled')::boolean,(v->>'slotDurationMinutes')::integer,(v->>'capacityPerSlot')::integer,(v->>'minimumNoticeMinutes')::integer,(v->>'maximumAdvanceDays')::integer,v->'weeklyAvailability',v->'dateExceptions',v->'extraFields',u)
 on conflict(tenant_id) do update set enabled=excluded.enabled,version=sms_booking_settings.version+1,slot_duration_minutes=excluded.slot_duration_minutes,capacity_per_slot=excluded.capacity_per_slot,minimum_notice_minutes=excluded.minimum_notice_minutes,maximum_advance_days=excluded.maximum_advance_days,weekly_availability=excluded.weekly_availability,date_exceptions=excluded.date_exceptions,extra_fields=excluded.extra_fields,updated_by=u,updated_at=now() returning * into s;
 insert into sms_private.audit(tenant_id,actor,action,detail) values(t,u,'booking_settings_saved',jsonb_build_object('version',s.version,'enabled',s.enabled));
 return sms_private.booking_settings(u,t);
end $$;

create or replace function sms_private.booking_slot_open(t text,local_day date,local_clock time without time zone,settings public.sms_booking_settings,tz text,exclude_booking text default null) returns boolean
language plpgsql stable set search_path='' as $$
#variable_conflict use_column
declare windows jsonb; exception jsonb; finish time; slot_at timestamptz; begin
 if local_day is null or local_clock is null then return false; end if;
 slot_at:=make_timestamptz(extract(year from local_day)::int,extract(month from local_day)::int,extract(day from local_day)::int,extract(hour from local_clock)::int,extract(minute from local_clock)::int,0,tz);
 if slot_at<now()+make_interval(mins=>settings.minimum_notice_minutes) or slot_at>now()+make_interval(days=>settings.maximum_advance_days) then return false; end if;
 select value into exception from jsonb_array_elements(settings.date_exceptions) where value->>'date'=local_day::text limit 1;
 if exception is not null and coalesce((exception->>'closed')::boolean,false) then return false; end if;
 windows:=case when exception is not null then coalesce(exception->'windows','[]') else coalesce(settings.weekly_availability->(extract(dow from local_day)::int)::text,'[]') end;
 finish:=local_clock+make_interval(mins=>settings.slot_duration_minutes);
 if not exists(select from jsonb_array_elements(windows) w where local_clock>=(w->>'start')::time and finish<=(w->>'end')::time) then return false; end if;
 return (select count(*) from public.sms_bookings b where b.tenant_id=t and b.status='confirmed' and b.appointment_at=slot_at and (exclude_booking is null or b.id<>exclude_booking))<settings.capacity_per_slot;
end $$;

create or replace function sms_private.validate_booking_answers(settings public.sms_booking_settings,answers jsonb) returns jsonb
language plpgsql immutable set search_path='' as $$
#variable_conflict use_column
declare k text; val text; field jsonb; typ text; result jsonb:='{}'; begin
 if jsonb_typeof(coalesce(answers,'{}'))<>'object' or pg_column_size(coalesce(answers,'{}'))>32768 then raise exception 'Invalid booking answers'; end if;
 for k,val in select key,value #>> '{}' from jsonb_each(coalesce(answers,'{}')) loop
   select value into field from jsonb_array_elements(settings.extra_fields) where value->>'key'=k;
   if field is null then raise exception 'Unknown booking field'; end if;
   typ:=field->>'type'; val:=trim(coalesce(val,''));
   if length(val)>(case when typ='long_text' then 2000 else 500 end) then raise exception 'Booking answer is too long'; end if;
   if typ='number' and val!~'^-?[0-9]+([.][0-9]+)?$' then raise exception 'Invalid number answer'; end if;
   if typ='boolean' and lower(val) not in ('yes','no','true','false') then raise exception 'Invalid yes/no answer'; end if;
   if typ='single_select' and not exists(select from jsonb_array_elements_text(field->'options') x where lower(x)=lower(val)) then raise exception 'Invalid selection'; end if;
   result:=result||jsonb_build_object(k,val);
 end loop;
 return result;
end $$;

create or replace function sms_private.booking_missing_question(settings public.sms_booking_settings,s public.sms_booking_sessions) returns text
language plpgsql immutable set search_path='' as $$
declare f jsonb; begin
 if nullif(trim(coalesce(s.customer_name,'')),'') is null then return 'What name should I put on the booking?'; end if;
 if nullif(trim(coalesce(s.service_address,'')),'') is null then return 'What is the service address?'; end if;
 if s.local_date is null then return 'What date would you like?'; end if;
 if s.local_time is null then return 'What time would you like?'; end if;
 select value into f from jsonb_array_elements(settings.extra_fields) with ordinality x(value,position) where coalesce((value->>'required')::boolean,false) and nullif(trim(coalesce(s.extra_answers->>(value->>'key'),'')),'') is null order by position limit 1;
 if f is not null then return f->>'question'; end if;
 return null;
end $$;

create or replace function sms_private.apply_booking_ai(j sms_private.jobs,p jsonb,cid uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
#variable_conflict use_column
declare settings public.sms_booking_settings; session public.sms_booking_sessions; business public.sms_businesses; intent text:=coalesce(p->>'bookingIntent','none'); patch jsonb:=coalesce(p->'bookingPatch','{}'); answer_patch jsonb:='{}'; pair jsonb; question text; slot_at timestamptz; booking_id text; gid text; reply text; alternatives text; begin
 if intent='none' then return jsonb_build_object('handled',false); end if;
 select * into settings from public.sms_booking_settings where tenant_id=j.tenant_id;
 if not found or not settings.enabled then return jsonb_build_object('handled',false); end if;
 select * into business from public.sms_businesses where tenant_id=j.tenant_id;
 perform pg_advisory_xact_lock(hashtextextended(j.tenant_id||':booking:'||cid::text,991));
 delete from public.sms_booking_sessions where tenant_id=j.tenant_id and contact_id=cid and expires_at<=now();
 select * into session from public.sms_booking_sessions where tenant_id=j.tenant_id and contact_id=cid for update;
 if intent='decline' then
   delete from public.sms_booking_sessions where tenant_id=j.tenant_id and contact_id=cid;
   return jsonb_build_object('handled',true,'state','declined','reply','No problem — I did not create the booking.');
 end if;
 if not found then
   insert into public.sms_booking_sessions(tenant_id,contact_id,customer_phone,settings_version,conversation_generation)
   values(j.tenant_id,cid,j.payload->>'phone',settings.version,(j.payload->>'generation')::bigint) returning * into session;
 end if;
 for pair in select value from jsonb_array_elements(coalesce(patch->'extraAnswers','[]')) loop
   if nullif(pair->>'fieldKey','') is not null and pair ? 'value' then answer_patch:=answer_patch||jsonb_build_object(pair->>'fieldKey',pair->>'value'); end if;
 end loop;
 answer_patch:=sms_private.validate_booking_answers(settings,answer_patch);
 update public.sms_booking_sessions set
   customer_name=coalesce(nullif(trim(patch->>'name'),''),customer_name),
   service_address=coalesce(nullif(trim(patch->>'address'),''),service_address),
   local_date=case when coalesce((patch->>'dateTimeAmbiguous')::boolean,false) then local_date when coalesce(patch->>'localDate','')~'^\d{4}-\d{2}-\d{2}$' then (patch->>'localDate')::date else local_date end,
   local_time=case when coalesce((patch->>'dateTimeAmbiguous')::boolean,false) then local_time when coalesce(patch->>'localTime','')~'^([01][0-9]|2[0-3]):[0-5][0-9]$' then (patch->>'localTime')::time else local_time end,
   extra_answers=extra_answers||answer_patch,settings_version=settings.version,conversation_generation=(j.payload->>'generation')::bigint,expires_at=now()+interval '7 days',updated_at=now()
 where tenant_id=j.tenant_id and contact_id=cid returning * into session;
 if intent='confirm' then
   if session.state<>'awaiting_confirmation' then return jsonb_build_object('handled',true,'state','collecting','reply','I still need a few booking details before I can confirm it.'); end if;
   perform pg_advisory_xact_lock(hashtextextended(j.tenant_id||':slot:'||session.local_date::text||':'||session.local_time::text,992));
   if not sms_private.booking_slot_open(j.tenant_id,session.local_date,session.local_time,settings,business.time_zone) then
     update public.sms_booking_sessions set state='collecting',updated_at=now() where tenant_id=j.tenant_id and contact_id=cid;
     alternatives:=sms_private.booking_alternatives(j.tenant_id,settings,business.time_zone);
     return jsonb_build_object('handled',true,'state','unavailable','reply',left('That time is no longer available.'||case when alternatives<>'' then ' The next openings are '||alternatives||'. Which works best?' else ' What other date or time works for you?' end,600));
   end if;
   slot_at:=make_timestamptz(extract(year from session.local_date)::int,extract(month from session.local_date)::int,extract(day from session.local_date)::int,extract(hour from session.local_time)::int,extract(minute from session.local_time)::int,0,business.time_zone);
   booking_id:='sms:'||j.id::text;
   insert into public.sms_bookings(tenant_id,id,contact_id,appointment_at,status,metadata,customer_name,customer_phone,service_address,time_zone,extra_answers,booking_settings_version,source,confirmed_at)
   values(j.tenant_id,booking_id,cid,slot_at,'confirmed',jsonb_build_object('ai_job_id',j.id),session.customer_name,session.customer_phone,session.service_address,business.time_zone,session.extra_answers,settings.version,'sms_ai',now()) on conflict(tenant_id,id) do nothing;
   delete from public.sms_booking_sessions where tenant_id=j.tenant_id and contact_id=cid;
   select id into gid from public.sms_automation_groups where tenant_id=j.tenant_id and kind='reminder' and active order by created_at limit 1;
   if gid is not null and not exists(select from public.sms_contacts where tenant_id=j.tenant_id and id=cid and opted_out) then
     insert into public.sms_automation_enrollments(tenant_id,contact_id,category_id,appointment_at,next_run_at,metadata)
     values(j.tenant_id,cid,gid,slot_at,now(),jsonb_build_object('booking_id',booking_id,'source','sms_ai')) on conflict do nothing;
   end if;
   reply:=left('Booked! Reference '||booking_id||' for '||session.customer_name||' on '||to_char(session.local_date,'Mon FMDD, YYYY')||' at '||to_char(session.local_time,'FMHH12:MI AM')||' at '||session.service_address||'. Contact us if you need to cancel.',600);
   return jsonb_build_object('handled',true,'state','confirmed','bookingId',booking_id,'reply',reply);
 end if;
 question:=sms_private.booking_missing_question(settings,session);
 if coalesce((patch->>'dateTimeAmbiguous')::boolean,false) then question:='Please send the exact date and time you want, including AM or PM.'; end if;
 if question is not null then return jsonb_build_object('handled',true,'state','collecting','reply',question); end if;
 if not sms_private.booking_slot_open(j.tenant_id,session.local_date,session.local_time,settings,business.time_zone) then
   alternatives:=sms_private.booking_alternatives(j.tenant_id,settings,business.time_zone);
   return jsonb_build_object('handled',true,'state','unavailable','reply',left('That time is outside the available booking hours or already full.'||case when alternatives<>'' then ' The next openings are '||alternatives||'. Which works best?' else ' What other date or time works for you?' end,600));
 end if;
 update public.sms_booking_sessions set state='awaiting_confirmation',updated_at=now() where tenant_id=j.tenant_id and contact_id=cid;
 reply:=left('Please confirm: '||session.customer_name||', '||to_char(session.local_date,'Mon FMDD, YYYY')||' at '||to_char(session.local_time,'FMHH12:MI AM')||', at '||session.service_address||'. Reply YES to book or NO to cancel.',600);
 return jsonb_build_object('handled',true,'state','awaiting_confirmation','reply',reply);
end $$;

create or replace function sms_private.list_bookings(u text,t text,p jsonb default '{}') returns jsonb
language plpgsql security definer set search_path='' as $$
#variable_conflict use_column
declare rows jsonb; total bigint; page integer:=greatest(1,coalesce((p->>'page')::integer,1)); size integer:=greatest(1,least(250,coalesce((p->>'pageSize')::integer,50))); begin
 perform sms_private.require_admin(u);
 select count(*) into total from public.sms_bookings b where b.tenant_id=t and (nullif(p->>'status','') is null or b.status=p->>'status') and (nullif(p->>'q','') is null or b.customer_name ilike '%'||(p->>'q')||'%' or b.customer_phone ilike '%'||(p->>'q')||'%' or b.service_address ilike '%'||(p->>'q')||'%');
 select coalesce(jsonb_agg(x),'[]') into rows from (select b.*,c.phone contact_phone from public.sms_bookings b join public.sms_contacts c on c.tenant_id=b.tenant_id and c.id=b.contact_id where b.tenant_id=t and (nullif(p->>'status','') is null or b.status=p->>'status') and (nullif(p->>'q','') is null or b.customer_name ilike '%'||(p->>'q')||'%' or b.customer_phone ilike '%'||(p->>'q')||'%' or b.service_address ilike '%'||(p->>'q')||'%') order by b.appointment_at desc limit size offset (page-1)*size)x;
 return jsonb_build_object('bookings',rows,'rows',rows,'total',total,'page',page,'pageSize',size,'totalPages',greatest(1,ceil(total::numeric/size)));
end $$;

create or replace function sms_private.booking_detail(u text,t text,bid text) returns jsonb
language plpgsql security definer set search_path='' as $$
begin perform sms_private.require_admin(u); return (select to_jsonb(b)||jsonb_build_object('contact_phone',c.phone) from public.sms_bookings b join public.sms_contacts c on c.tenant_id=b.tenant_id and c.id=b.contact_id where b.tenant_id=t and b.id=bid); end $$;

create or replace function sms_private.cancel_booking(u text,t text,bid text,key text) returns jsonb
language plpgsql security definer set search_path='' as $$
#variable_conflict use_column
declare b public.sms_bookings; begin
 perform sms_private.require_admin(u); if length(trim(coalesce(key,''))) not between 8 and 200 then raise exception 'Idempotency-Key required'; end if;
 perform pg_advisory_xact_lock(hashtextextended(t||':cancel:'||bid,993));
 select * into strict b from public.sms_bookings where tenant_id=t and id=bid for update;
 if b.status='cancelled' then return to_jsonb(b); end if;
 if b.status<>'confirmed' then raise exception 'Only confirmed bookings can be cancelled'; end if;
 update public.sms_bookings set status='cancelled',cancelled_at=now(),updated_at=now(),metadata=metadata||jsonb_build_object('cancel_idempotency_key',key,'cancelled_by',u) where tenant_id=t and id=bid returning * into b;
 update public.sms_automation_enrollments set status='cancelled',generation=generation+1 where tenant_id=t and status in ('active','paused') and metadata->>'booking_id'=bid;
 insert into sms_private.audit(tenant_id,actor,action,detail) values(t,u,'booking_cancelled',jsonb_build_object('bookingId',bid,'idempotencyKey',key));
 return to_jsonb(b);
end $$;

-- Include operational booking state in the existing bounded AI context.
create or replace function sms_private.job_context(jid uuid,token uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
#variable_conflict use_column
declare j sms_private.jobs; e public.sms_automation_enrollments; c public.sms_contacts; ph text;
begin
 j:=sms_private.lease(jid,token);
 if j.queue='automation_jobs' then
   select * into e from public.sms_automation_enrollments where tenant_id=j.tenant_id and id=(j.payload->>'enrollment_id')::uuid;
   select * into c from public.sms_contacts where tenant_id=j.tenant_id and id=e.contact_id;
   return jsonb_build_object('enrollment',to_jsonb(e),'contact',to_jsonb(c),'business',(select to_jsonb(b) from public.sms_businesses b where tenant_id=j.tenant_id),'group',(select to_jsonb(g) from public.sms_automation_groups g where tenant_id=j.tenant_id and id=e.category_id),'steps',(select jsonb_agg(s order by step_index) from public.sms_automation_steps s where tenant_id=j.tenant_id and group_id=e.category_id));
 elsif j.queue='ai_reply_jobs' then
   ph:=j.payload->>'phone'; select * into c from public.sms_contacts where tenant_id=j.tenant_id and phone=ph;
   return jsonb_build_object('business',(select to_jsonb(b) from public.sms_businesses b where tenant_id=j.tenant_id),'profile',(select to_jsonb(v) from public.sms_business_profile_versions v join public.sms_businesses b on b.tenant_id=v.tenant_id and b.active_profile_version_id=v.id where v.tenant_id=j.tenant_id and v.status='approved'),'contact',to_jsonb(c),'thread',(select to_jsonb(th) from public.sms_thread_contacts th where tenant_id=j.tenant_id and phone=ph),'settings',(select to_jsonb(a) from public.sms_ai_settings a where tenant_id=j.tenant_id and group_id=j.payload->>'group_id'),'open_lead',(select to_jsonb(l) from public.sms_leads l where l.tenant_id=j.tenant_id and l.contact_id=c.id and l.status in ('open','assigned') order by l.updated_at desc limit 1),'booking_settings',(select to_jsonb(s) from public.sms_booking_settings s where s.tenant_id=j.tenant_id and s.enabled),'booking_session',(select to_jsonb(s) from public.sms_booking_sessions s where s.tenant_id=j.tenant_id and s.contact_id=c.id and s.expires_at>now()),'history',(select coalesce(jsonb_agg(m order by created_at),'[]') from (select id,direction,body,created_at from public.sms_messages where tenant_id=j.tenant_id and contact_phone=ph order by created_at desc limit 20)m));
 elsif j.queue='provisioning_jobs' then
   return (select jsonb_build_object('account_sid',p.account_sid,'messaging_service_sid',p.messaging_service_sid,'phone_number_sid',p.phone_number_sid,'state',p.provisioning_state,'business_name',b.name) from sms_private.providers p join public.sms_businesses b using(tenant_id) where p.tenant_id=j.tenant_id);
 end if;
 raise exception 'Unsupported context';
end $$;

-- Wrap the existing completion behavior, adding only deterministic booking handling.
create or replace function sms_private.complete_grounded_ai(jid uuid,token uuid,p jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
#variable_conflict use_column
declare j sms_private.jobs; cid uuid; mid uuid; lead public.sms_leads; handoff_id uuid; result jsonb; alert text; disposition text; booking jsonb; effective_reply text;
begin
 j:=sms_private.lease(jid,token); if j.queue<>'ai_reply_jobs' then raise exception 'Wrong queue'; end if;
 if not exists(select from public.sms_thread_contacts th join public.sms_contacts c using(tenant_id,phone) where th.tenant_id=j.tenant_id and th.phone=j.payload->>'phone' and th.generation=(j.payload->>'generation')::bigint and not th.ai_paused and not c.opted_out) or not exists(select from public.sms_ai_settings where tenant_id=j.tenant_id and group_id=j.payload->>'group_id' and enabled) then perform sms_private.finish(jid,token,'cancelled','STALE_REPLY'); return null; end if;
 select id into strict cid from public.sms_contacts where tenant_id=j.tenant_id and phone=j.payload->>'phone' for update;
 disposition:=p->>'disposition'; if disposition not in ('answered','collect_lead','handoff') then raise exception 'Invalid AI disposition'; end if;
 if length(trim(coalesce(p->>'reply',''))) not between 1 and 600 then raise exception 'AI reply must be between 1 and 600 characters'; end if;
 if disposition='answered' and coalesce((p->>'grounded')::boolean,false) is not true then raise exception 'Direct answers must be grounded'; end if;
 if disposition='answered' and nullif(p->>'profileVersionId','') is null and jsonb_array_length(coalesce(p->'citationIds','[]'))=0 then raise exception 'Direct answers require approved evidence'; end if;
 if exists(select from jsonb_array_elements_text(coalesce(p->'citationIds','[]')) x where not exists(select from public.sms_knowledge_chunks c join public.sms_knowledge_sources s on s.tenant_id=c.tenant_id and s.id=c.source_id and s.active_version_id=c.source_version_id join public.sms_knowledge_source_versions v on v.tenant_id=c.tenant_id and v.id=c.source_version_id and v.status='approved' where c.tenant_id=j.tenant_id and c.id=x::uuid)) then raise exception 'AI cited unapproved evidence'; end if;
 if nullif(p->>'profileVersionId','') is not null and not exists(select from public.sms_businesses where tenant_id=j.tenant_id and active_profile_version_id=(p->>'profileVersionId')::uuid) then raise exception 'AI used an inactive profile'; end if;
 booking:=case when coalesce(p->>'mode','live')='shadow' then jsonb_build_object('handled',false,'state','shadow') else sms_private.apply_booking_ai(j,p,cid) end; effective_reply:=case when coalesce((booking->>'handled')::boolean,false) then booking->>'reply' else p->>'reply' end;
 insert into public.sms_ai_runs(tenant_id,job_id,contact_phone,mode,disposition,grounded,citation_ids,profile_version_id,model,prompt_version,input_tokens,output_tokens,estimated_cost_micros,latency_ms,validation_error,result)
 values(j.tenant_id,j.id,j.payload->>'phone',coalesce(p->>'mode','live'),disposition,coalesce((p->>'grounded')::boolean,false),coalesce((select array_agg(x::uuid) from jsonb_array_elements_text(coalesce(p->'citationIds','[]')) x),'{}'),nullif(p->>'profileVersionId','')::uuid,p->>'model',coalesce(p->>'promptVersion','grounded-v1'),(p->>'inputTokens')::integer,(p->>'outputTokens')::integer,(p->>'estimatedCostMicros')::bigint,(p->>'latencyMs')::integer,p->>'validationError',p||jsonb_build_object('bookingOutcome',booking));
 if coalesce(p->>'mode','live')='shadow' then perform sms_private.finish(jid,token,'completed');return jsonb_build_object('shadow',true);end if;
 if disposition in ('collect_lead','handoff') then
   perform pg_advisory_xact_lock(hashtextextended(j.tenant_id||':'||cid::text,713)); select * into lead from public.sms_leads where tenant_id=j.tenant_id and contact_id=cid and status in ('open','assigned') for update;
   if found then update public.sms_leads set fields=fields||coalesce(p->'lead','{}'),summary=coalesce(nullif(p->>'leadSummary',''),summary),updated_at=now() where tenant_id=j.tenant_id and id=lead.id returning * into lead;
   else insert into public.sms_leads(tenant_id,contact_id,fields,summary,priority,source_message_id) values(j.tenant_id,cid,coalesce(p->'lead','{}'),coalesce(p->>'leadSummary',''),coalesce(p->>'priority','normal'),nullif(j.payload->>'message_id','')::uuid) returning * into lead; end if;
 end if;
 if disposition='handoff' then
   insert into public.sms_handoffs(tenant_id,lead_id,contact_id,ai_job_id,reason,priority) values(j.tenant_id,lead.id,cid,j.id,coalesce(nullif(p->>'handoffReason',''),'Approved business knowledge did not support an answer.'),coalesce(p->>'priority','normal')) on conflict(tenant_id,contact_id) where status in ('open','assigned') do update set reason=excluded.reason,priority=excluded.priority,updated_at=now() returning id into handoff_id;
   select alert_phone into alert from public.sms_ai_settings where tenant_id=j.tenant_id and group_id=j.payload->>'group_id';
   if alert is not null and alert<>j.payload->>'phone' then begin perform sms_private.enqueue(j.tenant_id,'handoff_alert_jobs','handoff-alert:'||handoff_id,jsonb_build_object('handoff_id',handoff_id,'alert_phone',alert)); update public.sms_handoffs set alert_status='queued' where tenant_id=j.tenant_id and id=handoff_id; exception when others then update public.sms_handoffs set alert_status='failed',alert_error=left(sqlstate||':'||sqlerrm,500) where tenant_id=j.tenant_id and id=handoff_id; end; end if;
 end if;
 result:=sms_private.outbox(j.tenant_id,'ai:'||j.id,jsonb_build_object('phone',j.payload->>'phone','body',effective_reply,'purpose','transactional','category_id',j.payload->>'group_id','conversation_generation',j.payload->'generation','ai_run_id',j.id));
 perform sms_private.finish(jid,token,'completed'); return result||jsonb_build_object('leadId',lead.id,'handoffId',handoff_id,'booking',booking);
end $$;

revoke all on function sms_private.validate_booking_settings(jsonb),sms_private.booking_slot_open(text,date,time without time zone,public.sms_booking_settings,text,text),sms_private.booking_alternatives(text,public.sms_booking_settings,text),sms_private.validate_booking_answers(public.sms_booking_settings,jsonb),sms_private.booking_missing_question(public.sms_booking_settings,public.sms_booking_sessions),sms_private.booking_settings(text,text),sms_private.save_booking_settings(text,text,jsonb),sms_private.list_bookings(text,text,jsonb),sms_private.booking_detail(text,text,text),sms_private.cancel_booking(text,text,text,text),sms_private.apply_booking_ai(sms_private.jobs,jsonb,uuid) from public,anon,authenticated,sms_api,sms_webhook,sms_sender,sms_automation,sms_ai;
grant execute on function sms_private.booking_settings(text,text),sms_private.save_booking_settings(text,text,jsonb),sms_private.list_bookings(text,text,jsonb),sms_private.booking_detail(text,text,text),sms_private.cancel_booking(text,text,text,text) to sms_api;
grant execute on function sms_private.job_context(uuid,uuid),sms_private.complete_grounded_ai(uuid,uuid,jsonb) to sms_ai;

do $$ begin
 if exists(select from pg_publication where pubname='supabase_realtime') then
   begin alter publication supabase_realtime add table public.sms_bookings; exception when duplicate_object then null; end;
 end if;
end $$;
