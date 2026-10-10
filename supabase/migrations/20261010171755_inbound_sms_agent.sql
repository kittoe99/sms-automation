-- CRM-owned forward migration. Requires the paired form-first baseline and CRM 20261006065213.
-- Apply once after reconciling both project histories. All new modes default off.
alter table sms_private.voice_booking_holds add column booking_channel text not null default 'voice' check(booking_channel in ('voice','sms'));
create or replace function sms_private.booking_prepare_shared(t text,cid text,p jsonb,channel text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare r public.sms_voice_service_rules; h sms_private.voice_booking_holds;
  day date; clock time without time zone; starts timestamptz; old public.sms_bookings;
begin
  if channel not in ('voice','sms') then raise exception 'Invalid channel'; end if;
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
  if not sms_private.voice_slot_open(r,day,clock,old.id) then
    return jsonb_build_object('available',false,'reason','That time is not available'); end if;
  starts:=make_timestamptz(extract(year from day)::integer,extract(month from day)::integer,
    extract(day from day)::integer,extract(hour from clock)::integer,
    extract(minute from clock)::integer,0,r.time_zone);
  insert into sms_private.voice_booking_holds
    (tenant_id,call_id,phone,customer_name,service,variant,service_zip,service_address,
     local_date,local_time,time_zone,starts_at,ends_at,rule_id,rule_version,details,existing_booking_id,booking_channel)
  values(t,cid,p->>'phone',btrim(p->>'name'),r.service,r.variant,'',btrim(p->>'address'),
    day,clock,r.time_zone,starts,starts+make_interval(mins=>r.duration_minutes),r.id,r.version,
    coalesce(p->'details','{}'::jsonb),nullif(p->>'existingBookingId',''),channel) returning * into h;
  return jsonb_build_object('available',true,'holdId',h.id,'service',h.service,'variant',h.variant,'localDate',h.local_date,
    'localTime',to_char(h.local_time,'HH24:MI'),'timeZone',h.time_zone,
    'address',h.service_address,'phone',h.phone,'expiresAt',h.expires_at);
end $$;
create or replace function sms_private.booking_confirm_shared(t text,cid text,hid uuid,channel text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare h sms_private.voice_booking_holds; r public.sms_voice_service_rules;
  b public.sms_bookings; contact_id uuid; intake_id uuid; bid text;
begin
  if channel not in ('voice','sms') then raise exception 'Invalid channel'; end if;
  select * into strict h from sms_private.voice_booking_holds where tenant_id=t and id=hid
    and call_id=cid and booking_channel=channel for update;
  if h.existing_booking_id is not null then raise exception 'Only new bookings are supported'; end if;
  if h.confirmed_booking_id is not null then
    select * into strict b from public.sms_bookings where tenant_id=t and id=h.confirmed_booking_id;
    return jsonb_build_object('status','confirmed','bookingId',b.id,'appointmentAt',b.appointment_at,
      'timeZone',b.time_zone,'service',b.voice_service,'address',b.service_address,'duplicate',true); end if;
  if h.expires_at<=now() then raise exception 'Booking check expired'; end if;
  select * into strict r from public.sms_voice_service_rules where tenant_id=t and id=h.rule_id for share;
  perform pg_advisory_xact_lock(hashtextextended(t||':voice-pool:'||r.resource_pool,992));
  if r.version<>h.rule_version or r.service<>h.service or r.variant<>h.variant
    or not sms_private.voice_slot_open(r,h.local_date,h.local_time,h.existing_booking_id)
    then raise exception 'Time no longer available'; end if;

    insert into public.sms_contacts(tenant_id,phone,name,source)
      values(t,h.phone,h.customer_name,channel)
      on conflict(tenant_id,phone) do update set name=excluded.name,updated_at=now();
    select id into strict contact_id from public.sms_contacts where tenant_id=t and phone=h.phone;
    bid:=channel||':'||h.id::text;
    insert into public.sms_bookings
      (tenant_id,id,contact_id,appointment_at,status,customer_name,customer_phone,
       service_address,time_zone,extra_answers,source,confirmed_at,voice_service,
       voice_end_at,voice_resource_pool,voice_market)
      values(t,bid,contact_id,h.starts_at,'confirmed',h.customer_name,h.phone,
        h.service_address,h.time_zone,h.details||jsonb_build_object('variant',h.variant),channel,now(),h.service,
        h.ends_at,r.resource_pool,r.market) returning * into b;
    select id into strict intake_id from public.sms_automation_bookings
      where tenant_id=t and source='sms_bookings' and source_record_id=bid;
    update public.sms_bookings set voice_intake_id=intake_id where tenant_id=t and id=bid;

  update sms_private.voice_booking_holds set confirmed_booking_id=b.id where tenant_id=t and id=hid;
  return jsonb_build_object('status','confirmed','bookingId',b.id,'appointmentAt',b.appointment_at,
    'timeZone',b.time_zone,'service',b.voice_service,'address',b.service_address,'duplicate',false);
end $$;
create or replace function sms_private.booking_prepare_new(t text,cid text,p jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$ begin
 perform sms_private.voice_read_scope(t);
 if not sms_private.voice_verified(t,cid,p->>'phone') then raise exception 'Phone verification required' using errcode='42501'; end if;
 return sms_private.booking_prepare_shared(t,cid,p,'voice');
end $$;
create or replace function sms_private.booking_confirm_new(t text,cid text,hid uuid) returns jsonb
language plpgsql security definer set search_path='' as $$ declare ph text; begin
 perform sms_private.voice_read_scope(t);
 select phone into strict ph from sms_private.voice_booking_holds where tenant_id=t and id=hid and call_id=cid and booking_channel='voice';
 if not sms_private.voice_verified(t,cid,ph) then raise exception 'Phone verification required' using errcode='42501'; end if;
 return sms_private.booking_confirm_shared(t,cid,hid,'voice');
end $$;
revoke all on function sms_private.booking_prepare_shared(text,text,jsonb,text),sms_private.booking_confirm_shared(text,text,uuid,text) from public,anon,authenticated,sms_api,sms_ai,sms_webhook,sms_sender,sms_automation;

create table sms_private.inbound_ai_settings (
 tenant_id text primary key references public.sms_businesses(tenant_id),
 mode text not null default 'off' check(mode in ('off','shadow','live')),
 system_prompt text not null default '', booking_enabled boolean not null default false,
 revision integer not null default 0, live_validated_at timestamptz,
 updated_at timestamptz not null default now()
);
create table sms_private.inbound_ai_sessions (
 tenant_id text not null, conversation_id uuid not null, draft jsonb not null default '{}',
 hold_id uuid, summary text,
 summary_message_id uuid, updated_at timestamptz not null default now(),
 primary key(tenant_id,conversation_id),
 foreign key(tenant_id,conversation_id) references public.sms_conversations(tenant_id,id),
 foreign key(tenant_id,hold_id) references sms_private.voice_booking_holds(tenant_id,id)
);
create table sms_private.inbound_ai_actions (
 job_id uuid not null references sms_private.jobs(id), action_key text not null,
 name text not null, arguments jsonb not null, result jsonb not null,
 created_at timestamptz not null default now(), primary key(job_id,action_key)
);
create table sms_private.inbound_ai_runs (
 job_id uuid primary key references sms_private.jobs(id), tenant_id text not null,
 mode text not null, result jsonb not null, created_at timestamptz not null default now()
);
create index inbound_ai_runs_tenant on sms_private.inbound_ai_runs(tenant_id,created_at desc);
do $$ declare tab text; begin
 foreach tab in array array['inbound_ai_settings','inbound_ai_sessions','inbound_ai_actions','inbound_ai_runs'] loop
  execute format('alter table sms_private.%I enable row level security',tab);
  execute format('revoke all on sms_private.%I from public,anon,authenticated,sms_api,sms_ai,sms_webhook,sms_sender,sms_automation',tab);
 end loop;
end $$;

create function sms_private.inbound_ai_settings_api(u text,t text,p jsonb default null) returns jsonb
language plpgsql security definer set search_path='' as $$
declare s sms_private.inbound_ai_settings; begin
 perform sms_private.require_admin(u);
 if not sms_private.can_access(t,u) then raise exception 'Business access denied' using errcode='42501'; end if;
 insert into sms_private.inbound_ai_settings(tenant_id) values(t) on conflict do nothing;
 select * into strict s from sms_private.inbound_ai_settings where tenant_id=t for update;
 if p is not null then
  if p->>'mode' not in ('off','shadow','live') or p->>'mode' is null
   or jsonb_typeof(p->'bookingEnabled') is distinct from 'boolean'
   or jsonb_typeof(p->'systemPrompt') is distinct from 'string' or length(p->>'systemPrompt')>6000
   or coalesce((p->>'revision')::integer,-1)<>s.revision then raise exception 'Invalid settings or stale revision' using errcode='23505'; end if;
  if p->>'mode'<>'off' then
   if t<>'biz-1c0c09ce-819e-4795-86b9-0e457ab92f58' then raise exception 'Only the Opek pilot is enabled'; end if;
   if length(btrim(p->>'systemPrompt'))=0 or not exists(select from public.sms_businesses b
    join public.sms_business_profile_versions v on v.tenant_id=b.tenant_id and v.id=b.active_profile_version_id
    where b.tenant_id=t and v.status='approved') then raise exception 'Instructions and approved business knowledge required'; end if;
   if p->>'mode'='live' and s.live_validated_at is null then raise exception 'Pilot validation must pass before live activation'; end if;
  end if;
  update sms_private.inbound_ai_settings set mode=p->>'mode',system_prompt=btrim(p->>'systemPrompt'),
   booking_enabled=(p->>'bookingEnabled')::boolean,revision=revision+1,updated_at=now() where tenant_id=t returning * into s;
 end if;
 return jsonb_build_object('mode',s.mode,'systemPrompt',s.system_prompt,'bookingEnabled',s.booking_enabled,
  'revision',s.revision,'model','gpt-6.1-sol','liveValidated',s.live_validated_at is not null,
  'pilot',t='biz-1c0c09ce-819e-4795-86b9-0e457ab92f58',
  'runs',coalesce((select jsonb_agg(x) from (select job_id,mode,created_at,result from sms_private.inbound_ai_runs where tenant_id=t order by created_at desc limit 20)x),'[]'));
end $$;

-- The fence is reused at every tool and again at provider submission. Locks last only
-- for the database transaction, never across an LLM or provider network request.
create function sms_private.inbound_ai_eligible(j sms_private.jobs,allow_paused boolean default false) returns boolean
language plpgsql security definer set search_path='' as $$
declare c public.sms_contacts; th public.sms_thread_contacts; conv public.sms_conversations; s sms_private.inbound_ai_settings; begin
 if j.queue<>'ai_reply_jobs' or j.payload->>'agent_version' is distinct from 'sms-agent-v1' then return false; end if;
 select * into c from public.sms_contacts where tenant_id=j.tenant_id and phone=j.payload->>'phone' for update;
 select * into th from public.sms_thread_contacts where tenant_id=j.tenant_id and phone=j.payload->>'phone' for update;
 select * into conv from public.sms_conversations where tenant_id=j.tenant_id and id=(j.payload->>'conversation_id')::uuid and phone=c.phone for update;
 select * into s from sms_private.inbound_ai_settings where tenant_id=j.tenant_id for share;
 return coalesce(c.id is not null and not c.opted_out and not th.ai_paused and (not conv.ai_paused or allow_paused)
  and th.generation=(j.payload->>'generation')::bigint and conv.generation=(j.payload->>'conversation_generation')::bigint
  and s.mode in ('shadow','live') and s.revision=(j.payload->>'settings_revision')::integer
  and exists(select from public.sms_businesses where tenant_id=j.tenant_id and status='active' and (s.mode='shadow' or sending_enabled))
  and exists(select from public.sms_messages where tenant_id=j.tenant_id and id=(j.payload->>'message_id')::uuid
   and direction='inbound' and contact_phone=c.phone and conversation_id=conv.id),false);
end $$;

-- Legacy callers cannot enqueue the new version. The webhook wrapper below is its producer.
create or replace function sms_private.enqueue(t text,q text,k text,p jsonb,due timestamptz default now()) returns uuid
language plpgsql security definer set search_path='' as $$ begin
 if q='ai_reply_jobs' then return null; end if;
 if q='automation_jobs' and not p ? 'form_run_id' then return null; end if;
 return sms_private.enqueue_before_form_sequences(t,q,k,p,due);
end $$;

alter function sms_private.record_webhook(text,text,jsonb) rename to record_webhook_before_inbound_agent;
create function sms_private.record_webhook(t text,event text,p jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare result jsonb; m public.sms_messages; c public.sms_conversations; th public.sms_thread_contacts; s sms_private.inbound_ai_settings; begin
 result:=sms_private.record_webhook_before_inbound_agent(t,event,p);
 if event<>'inbound' or coalesce((result->>'duplicate')::boolean,false) or coalesce((result->>'consent_event')::boolean,false) then return result; end if;
 select * into s from sms_private.inbound_ai_settings where tenant_id=t;
 if s.mode is null or s.mode='off' then return result; end if;
 select * into strict m from public.sms_messages where tenant_id=t and sid=p->>'MessageSid';
 select * into strict c from public.sms_conversations where tenant_id=t and id=m.conversation_id for update;
 update public.sms_thread_contacts set generation=generation+1 where tenant_id=t and phone=m.contact_phone returning * into th;
 -- Any new message invalidates a stale proposal except an unambiguous confirmation.
 if lower(btrim(m.body)) !~ '^(yes|y|confirm|book it|yes please|looks good)[.!]?$' and s.mode='live' then
  update sms_private.inbound_ai_sessions set hold_id=null,summary_message_id=null where tenant_id=t and conversation_id=c.id;
 end if;
 update sms_private.jobs set status='cancelled',error_code='SUPERSEDED_INBOUND',leased_until=null
  where tenant_id=t and queue='ai_reply_jobs' and payload->>'phone'=m.contact_phone and status in ('queued','retry');
 if not c.ai_paused and not th.ai_paused and not exists(select from public.sms_contacts where tenant_id=t and phone=m.contact_phone and opted_out) then
  perform sms_private.enqueue_before_form_sequences(t,'ai_reply_jobs','sms-agent-v1:'||m.sid,jsonb_build_object(
   'agent_version','sms-agent-v1','phone',m.contact_phone,'message_id',m.id,'conversation_id',c.id,
   'generation',th.generation,'conversation_generation',c.generation,'settings_revision',s.revision),now()+interval '2 seconds');
 end if;
 return result;
end $$;

create function sms_private.inbound_ai_context(jid uuid,token uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare j sms_private.jobs; result jsonb; begin
 j:=sms_private.lease(jid,token);
 if not sms_private.inbound_ai_eligible(j,exists(select from public.sms_handoffs where tenant_id=j.tenant_id and ai_job_id=jid)) then return null; end if;
 select jsonb_build_object('settings',to_jsonb(s),'business',jsonb_build_object('name',b.name,'timeZone',b.time_zone),
  'profile',(select v.facts from public.sms_business_profile_versions v where v.tenant_id=b.tenant_id and v.id=b.active_profile_version_id and v.status='approved'),
  'latestMessage',(select body from public.sms_messages where tenant_id=j.tenant_id and id=(j.payload->>'message_id')::uuid),
  'history',coalesce((select jsonb_agg(x order by x.created_at) from (select direction,body,created_at from public.sms_messages
   where tenant_id=j.tenant_id and conversation_id=(j.payload->>'conversation_id')::uuid
    and (direction='inbound' or provider_accepted_at is not null) order by created_at desc limit 20)x),'[]'),
  'session',(select jsonb_build_object('draft',draft,'summary',summary,'awaitingConfirmation',hold_id is not null and summary_message_id is not null)
   from sms_private.inbound_ai_sessions where tenant_id=j.tenant_id and conversation_id=(j.payload->>'conversation_id')::uuid),
  'requests',coalesce((select jsonb_agg(x) from (select form_public_id,name,details,submitted_at from (
    select tenant_id,phone,form_public_id,name,details,submitted_at from public.sms_web_form_contact_submissions
    union all select tenant_id,phone,form_public_id,name,details,submitted_at from public.sms_web_form_quote_request_submissions
    union all select tenant_id,phone,form_public_id,name,details,submitted_at from public.sms_web_form_booking_submissions
   ) submissions where tenant_id=j.tenant_id and phone=j.payload->>'phone' order by submitted_at desc limit 3)x),'[]'),
  'services',coalesce((select jsonb_agg(jsonb_build_object('service',service,'timeZone',time_zone)) from public.sms_voice_service_rules where tenant_id=j.tenant_id and enabled),'[]'),
  'recoveredReply',(select a.result->>'customerReply' from sms_private.inbound_ai_actions a where a.job_id=jid and a.name in ('confirm_booking','request_staff_help') order by a.created_at desc limit 1)) into result
 from public.sms_businesses b join sms_private.inbound_ai_settings s using(tenant_id) where b.tenant_id=j.tenant_id;
 return result;
end $$;

create function sms_private.inbound_ai_tool(jid uuid,token uuid,name text,args jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
#variable_conflict use_variable
declare j sms_private.jobs; s sms_private.inbound_ai_settings; sess sms_private.inbound_ai_sessions;
 r public.sms_voice_service_rules; settings public.sms_booking_settings; result jsonb; key text; draft jsonb;
 conv uuid; cid uuid; hid uuid; ph text; body text; missing text; summary text; held sms_private.voice_booking_holds;
begin
 j:=sms_private.lease(jid,token);
 if not sms_private.inbound_ai_eligible(j) then return jsonb_build_object('stale',true); end if;
 if name not in ('lookup_bookings','check_availability','prepare_booking','confirm_booking','request_staff_help')
  or jsonb_typeof(args) is distinct from 'object' or pg_column_size(args)>16000 then raise exception 'Invalid tool'; end if;
 if args ?| array['tenant','tenant_id','phone','customerId','conversation_id'] then raise exception 'Identity is server-owned' using errcode='42501'; end if;
 conv:=(j.payload->>'conversation_id')::uuid;ph:=j.payload->>'phone';
 select * into strict s from sms_private.inbound_ai_settings where tenant_id=j.tenant_id;
 select id into strict cid from public.sms_contacts where tenant_id=j.tenant_id and phone=ph;
 key:=name||':'||md5(args::text);
 select a.result into result from sms_private.inbound_ai_actions a where a.job_id=jid and a.action_key=key;
 if found then return result; end if;
 if (select count(*) from sms_private.inbound_ai_actions where job_id=jid)>=3 then raise exception 'Tool budget exhausted'; end if;
 if name='lookup_bookings' then
  if args<>'{}' then raise exception 'Lookup takes no identifiers'; end if;
  select jsonb_build_object('bookings',coalesce(jsonb_agg(x),'[]')) into result from (select id,voice_service as service,appointment_at,time_zone,status
   from public.sms_bookings where tenant_id=j.tenant_id and (contact_id=cid or customer_phone=ph) order by appointment_at desc limit 10)x;
  result:=result||jsonb_build_object('customerReply',coalesce((select 'Appointments for this number: '||string_agg(
   coalesce(replace(x->>'service','_',' '),'Appointment')||' — '||to_char((x->>'appointment_at')::timestamptz at time zone coalesce(x->>'time_zone','UTC'),'Mon DD YYYY HH12:MI AM')||' ('||coalesce(x->>'time_zone','UTC')||'), '||(x->>'status')||'.',' ')
   from (select value x from jsonb_array_elements(result->'bookings') limit 3) recent),'I do not see an appointment for this number. Would you like help booking?'));
 elsif name='check_availability' then
  select * into r from public.sms_voice_service_rules where tenant_id=j.tenant_id and service=args->>'service' and enabled;
  if r.id is null then result:=jsonb_build_object('configured',false,'slots','[]'::jsonb);
  else result:=jsonb_build_object('configured',true,'timeZone',r.time_zone,'slots',sms_private.availability_slots(j.tenant_id,(args->>'localDate')::date,settings,r,r.time_zone)); end if;
 elsif name='prepare_booking' then
  if not s.booking_enabled then return jsonb_build_object('error','Booking is disabled'); end if;
  if exists(select from jsonb_object_keys(args) k where k not in ('service','name','address','localDate','localTime','details')) then raise exception 'Invalid booking field'; end if;
  select * into sess from sms_private.inbound_ai_sessions where tenant_id=j.tenant_id and conversation_id=conv for update;
  draft:=coalesce(sess.draft,'{}')||jsonb_strip_nulls(args);
  draft:=draft||jsonb_build_object('details',coalesce(sess.draft->'details','{}')||coalesce(jsonb_strip_nulls(args->'details'),'{}'));
  missing:=case when nullif(draft->>'service','') is null then 'Which service do you need?' when nullif(draft->>'name','') is null then 'What name should I put on the booking?'
   when nullif(draft->>'address','') is null then 'What is the full service address?' when nullif(draft->>'localDate','') is null then 'Which date would you prefer?'
   when nullif(draft->>'localTime','') is null then 'What time would you prefer?' end;
  if missing is not null then result:=jsonb_build_object('customerReply',missing,'draft',draft);
  elsif s.mode='shadow' then
   select * into r from public.sms_voice_service_rules where tenant_id=j.tenant_id and service=draft->>'service' and enabled;
   result:=jsonb_build_object('simulated',true,'available',r.id is not null and sms_private.voice_slot_open(r,(draft->>'localDate')::date,(draft->>'localTime')::time,null),'customerReply','Shadow: would prepare booking details for confirmation.');
  else
   result:=sms_private.booking_prepare_shared(j.tenant_id,'sms:'||conv,draft||jsonb_build_object('phone',ph),'sms');
   if coalesce((result->>'available')::boolean,false) then
    hid:=(result->>'holdId')::uuid;
    summary:=format('Please confirm: %s on %s at %s (%s), at %s. Reply YES to book. Availability is checked again when you confirm.',replace(result->>'service','_',' '),result->>'localDate',result->>'localTime',result->>'timeZone',draft->>'address');
    if length(summary)>600 then raise exception 'Booking address is too long for confirmation'; end if;
    result:=result||jsonb_build_object('customerReply',summary);
   else result:=result||jsonb_build_object('customerReply','That time is not available. Would you like to try another time?'); end if;
  end if;
  if s.mode='live' then
   insert into sms_private.inbound_ai_sessions(tenant_id,conversation_id,draft,hold_id,summary) values(j.tenant_id,conv,draft,hid,summary)
   on conflict(tenant_id,conversation_id) do update set draft=excluded.draft,hold_id=excluded.hold_id,summary=excluded.summary,summary_message_id=null,updated_at=now();
  end if;
 elsif name='confirm_booking' then
  if args<>'{}' or not s.booking_enabled then raise exception 'Booking confirmation unavailable'; end if;
  select * into sess from sms_private.inbound_ai_sessions where tenant_id=j.tenant_id and conversation_id=conv for update;
  select m.body into body from public.sms_messages m where tenant_id=j.tenant_id and id=(j.payload->>'message_id')::uuid;
  if sess.hold_id is null or lower(btrim(body)) !~ '^(yes|y|confirm|book it|yes please|looks good)[.!]?$'
   or not exists(select from public.sms_messages m join public.sms_messages inbound on inbound.tenant_id=m.tenant_id and inbound.id=(j.payload->>'message_id')::uuid
    where m.tenant_id=j.tenant_id and m.id=sess.summary_message_id and m.provider_accepted_at is not null
     and m.provider_accepted_at<=inbound.created_at and m.body=sess.summary) then
   return jsonb_build_object('customerReply','Please review the booking details before confirming.','needsPreparation',true);
  end if;
  if s.mode='shadow' then result:=jsonb_build_object('simulated',true,'customerReply','Shadow: would confirm the prepared booking.');
  else
   begin
    result:=sms_private.booking_confirm_shared(j.tenant_id,'sms:'||conv,sess.hold_id,'sms');
    result:=result||jsonb_build_object('customerReply',format('Your %s booking is confirmed for %s. Reference: %s.',replace(result->>'service','_',' '),to_char((result->>'appointmentAt')::timestamptz at time zone (result->>'timeZone'),'Dy Mon DD at HH12:MI AM')||' ('||(result->>'timeZone')||')',result->>'bookingId'));
   exception when raise_exception then
    if sqlerrm not in ('Booking check expired','Time no longer available') then raise; end if;
    update sms_private.inbound_ai_sessions set hold_id=null,summary_message_id=null where tenant_id=j.tenant_id and conversation_id=conv;
    result:=jsonb_build_object('needsPreparation',true,'customerReply','That proposal has expired or availability has changed. What date and time would you like me to check again?');
   end;
  end if;
 elsif name='request_staff_help' then
  if length(btrim(coalesce(args->>'reason',''))) not between 1 and 1000 then raise exception 'Reason required'; end if;
  if s.mode='shadow' then result:=jsonb_build_object('simulated',true,'customerReply','Shadow: would request staff assistance.');
  else
   insert into public.sms_handoffs(tenant_id,contact_id,ai_job_id,reason) values(j.tenant_id,cid,jid,args->>'reason') on conflict(tenant_id,ai_job_id) do nothing;
   update public.sms_conversations set ai_paused=true where tenant_id=j.tenant_id and id=conv;
   result:=jsonb_build_object('handoff',true,'customerReply','I have passed your request to the team. They can help you from here.');
  end if;
 end if;
 insert into sms_private.inbound_ai_actions(job_id,action_key,name,arguments,result) values(jid,key,name,args,result);
 return result;
end $$;

create function sms_private.complete_inbound_ai(jid uuid,token uuid,p jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare j sms_private.jobs; s sms_private.inbound_ai_settings; result jsonb; reply text; action jsonb; conv uuid; begin
 j:=sms_private.lease(jid,token);
 if not sms_private.inbound_ai_eligible(j,exists(select from public.sms_handoffs where tenant_id=j.tenant_id and ai_job_id=jid)) then perform sms_private.finish(jid,token,'cancelled','STALE_INBOUND'); return null; end if;
 select * into strict s from sms_private.inbound_ai_settings where tenant_id=j.tenant_id;
 conv:=(j.payload->>'conversation_id')::uuid;
 select a.result into action from sms_private.inbound_ai_actions a where job_id=jid and a.result ? 'customerReply' order by created_at desc limit 1;
 reply:=coalesce(action->>'customerReply',p->>'reply');
 if length(btrim(coalesce(reply,''))) not between 1 and 600 then raise exception 'Invalid reply'; end if;
 -- Statements about completed actions are only rendered from transactional tool results.
 if action is null and reply ~* '\m(booked|confirmed|reserved|cancelled|rescheduled|paid|guaranteed)\M' then
  reply:='I can check your appointment or help you book. What would you like to do?';
 end if;
 insert into sms_private.inbound_ai_runs(job_id,tenant_id,mode,result) values(jid,j.tenant_id,s.mode,p||jsonb_build_object('reply',reply)) on conflict(job_id) do nothing;
 if s.mode='live' then
  result:=sms_private.outbox(j.tenant_id,'sms-agent-v1:'||jid,jsonb_build_object('phone',j.payload->>'phone','body',reply,'purpose','transactional',
   'category_id',(select group_id from public.sms_conversations where tenant_id=j.tenant_id and id=conv),'conversation_id',conv,
   'agent_version','sms-agent-v1','agent_job_id',jid));
  update sms_private.inbound_ai_sessions set summary_message_id=(result->>'messageId')::uuid where tenant_id=j.tenant_id and conversation_id=conv and summary=reply;
  update public.sms_messages set meta=meta||jsonb_build_object('agent_version','sms-agent-v1','agent_job_id',jid) where tenant_id=j.tenant_id and id=(result->>'messageId')::uuid;
  if action->>'handoff'='true' then update public.sms_conversations set ai_paused=true where tenant_id=j.tenant_id and id=conv; end if;
 end if;
 perform sms_private.finish(jid,token,'completed'); return result;
end $$;

create function sms_private.fail_inbound_ai(jid uuid,token uuid,p jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare j sms_private.jobs; result jsonb; begin
 j:=sms_private.lease(jid,token);
 if not sms_private.inbound_ai_eligible(j) then perform sms_private.finish(jid,token,'cancelled','STALE_INBOUND'); return null; end if;
 select a.result into result from sms_private.inbound_ai_actions a where job_id=jid and name='confirm_booking' and a.result->>'status'='confirmed' limit 1;
 if result is not null then return sms_private.complete_inbound_ai(jid,token,p||jsonb_build_object('reply',result->>'customerReply')); end if;
 if j.attempts<3 and coalesce((p->>'transient')::boolean,false) then perform sms_private.finish(jid,token,'retry',p->>'code',30*j.attempts); return null; end if;
 -- A failure may occur after consuming the tool budget; terminal handoff is deterministic.
 if exists(select from sms_private.inbound_ai_settings where tenant_id=j.tenant_id and mode='live') then
  insert into public.sms_handoffs(tenant_id,contact_id,ai_job_id,reason)
   select j.tenant_id,id,jid,'Inbound AI could not complete: '||left(coalesce(p->>'code','AI_ERROR'),100) from public.sms_contacts where tenant_id=j.tenant_id and phone=j.payload->>'phone'
   on conflict(tenant_id,ai_job_id) do nothing;
 end if;
 result:=sms_private.complete_inbound_ai(jid,token,p||jsonb_build_object('reply','I could not complete that just now. Your message is saved for the team.'));
 if exists(select from sms_private.inbound_ai_settings where tenant_id=j.tenant_id and mode='live') then
  update public.sms_conversations set ai_paused=true where tenant_id=j.tenant_id and id=(j.payload->>'conversation_id')::uuid;
 end if;
 return result;
end $$;

alter function sms_private.begin_submission(uuid,uuid) rename to begin_submission_before_inbound_agent;
create function sms_private.begin_submission(jid uuid,token uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare j sms_private.jobs; origin sms_private.jobs; allowed_pause boolean; begin
 j:=sms_private.lease(jid,token);
 if j.payload->'request'->>'agent_version'='sms-agent-v1' then
  select * into origin from sms_private.jobs where id=(j.payload->'request'->>'agent_job_id')::uuid and tenant_id=j.tenant_id;
  allowed_pause:=exists(select from public.sms_handoffs where tenant_id=j.tenant_id and ai_job_id=origin.id);
  if origin.id is null or not exists(select from sms_private.inbound_ai_settings where tenant_id=j.tenant_id and mode='live')
   or not sms_private.inbound_ai_eligible(origin,allowed_pause) then
   perform sms_private.finish(jid,token,'cancelled','STALE_INBOUND');return null;
  end if;
  return sms_private.begin_submission_before_form_sequences(jid,token);
 end if;
 return sms_private.begin_submission_before_inbound_agent(jid,token);
end $$;

-- Every staff send path shares api_action; pause the actual outbound conversation.
alter function sms_private.api_action(text,text,text,jsonb) rename to api_action_before_inbound_agent;
create function sms_private.api_action(u text,t text,action text,p jsonb default '{}') returns jsonb
language plpgsql security definer set search_path='' as $$ declare result jsonb; begin
 result:=sms_private.api_action_before_inbound_agent(u,t,action,p);
 if action='send' then
  update public.sms_conversations set ai_paused=true,generation=generation+1 where tenant_id=t and id=(select conversation_id from public.sms_messages where tenant_id=t and id=(result->>'messageId')::uuid);
 end if;
 return result;
end $$;
revoke all on function sms_private.api_action_before_inbound_agent(text,text,text,jsonb),sms_private.api_action(text,text,text,jsonb) from public,anon,authenticated,sms_api,sms_ai,sms_webhook,sms_sender,sms_automation;
grant execute on function sms_private.api_action(text,text,text,jsonb) to sms_api;

-- Private cores are callable only through authorized wrappers.
do $$ declare f record; begin
 for f in select p.oid::regprocedure signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='sms_private'
  and p.proname in ('inbound_ai_settings_api','inbound_ai_eligible','inbound_ai_context','inbound_ai_tool','complete_inbound_ai','fail_inbound_ai','inbound_ai_staff_takeover','record_webhook_before_inbound_agent','record_webhook','begin_submission_before_inbound_agent','begin_submission') loop
  execute format('revoke all on function %s from public,anon,authenticated,sms_api,sms_ai,sms_webhook,sms_sender,sms_automation',f.signature);
 end loop;
end $$;
grant execute on function sms_private.inbound_ai_settings_api(text,text,jsonb) to sms_api;
grant execute on function sms_private.inbound_ai_context(uuid,uuid),sms_private.inbound_ai_tool(uuid,uuid,text,jsonb),sms_private.complete_inbound_ai(uuid,uuid,jsonb),sms_private.fail_inbound_ai(uuid,uuid,jsonb) to sms_ai;
grant execute on function sms_private.record_webhook(text,text,jsonb) to sms_webhook;
grant execute on function sms_private.begin_submission(uuid,uuid) to sms_sender;
