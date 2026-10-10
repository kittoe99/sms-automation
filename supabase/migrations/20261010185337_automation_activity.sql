-- CRM-owned. Requires inbound_automation_coordination (remote 20261010184313)
-- and the paired E2 service/access/cache baseline. No historical migration replay.
create table sms_private.activity_events (
 id bigint generated always as identity primary key, tenant_id text not null references public.sms_businesses(tenant_id),
 run_id uuid references sms_private.form_runs(id), event_key text not null, kind text not null,
 occurred_at timestamptz, recorded_at timestamptz not null default clock_timestamp(),
 historical boolean not null default false, simulated boolean not null default false,
 details jsonb not null default '{}', revision integer not null default 1, unique(tenant_id,event_key)
);
create index activity_events_run on sms_private.activity_events(tenant_id,run_id,recorded_at,id);
create index activity_events_unlinked on sms_private.activity_events(tenant_id,recorded_at desc) where run_id is null;
create table sms_private.activity_responses (
 tenant_id text not null, message_id uuid not null, run_id uuid not null references sms_private.form_runs(id),
 basis text not null, actor text, revision integer not null default 1,
 primary key(tenant_id,message_id), foreign key(tenant_id,message_id) references public.sms_messages(tenant_id,id)
);
create index activity_responses_run on sms_private.activity_responses(tenant_id,run_id);
create table sms_private.activity_bookings (
 tenant_id text not null, booking_id text not null, run_id uuid not null references sms_private.form_runs(id),
 basis text not null, actor text, revision integer not null default 1, linked_at timestamptz not null default clock_timestamp(),
 primary key(tenant_id,booking_id), foreign key(tenant_id,booking_id) references public.sms_bookings(tenant_id,id)
);
create index activity_bookings_run on sms_private.activity_bookings(tenant_id,run_id);
create table sms_private.activity_tags (
 tenant_id text not null references public.sms_businesses(tenant_id), id uuid not null default gen_random_uuid(),
 name text not null check(length(trim(name)) between 1 and 40), archived boolean not null default false,
 revision integer not null default 1, primary key(tenant_id,id)
);
create unique index activity_tag_names on sms_private.activity_tags(tenant_id,lower(name)) where not archived;
create table sms_private.activity_run_tags (
 tenant_id text not null, run_id uuid not null references sms_private.form_runs(id), tag_id uuid not null,
 primary key(tenant_id,run_id,tag_id), foreign key(tenant_id,tag_id) references sms_private.activity_tags(tenant_id,id)
);
create table sms_private.activity_handoffs (
 tenant_id text not null, handoff_id uuid not null, run_id uuid not null references sms_private.form_runs(id),
 primary key(tenant_id,handoff_id), foreign key(tenant_id,handoff_id) references public.sms_handoffs(tenant_id,id)
);
create index activity_handoffs_run on sms_private.activity_handoffs(tenant_id,run_id);
create index activity_message_run_accepted on public.sms_messages(tenant_id,(meta->>'form_run_id'),provider_accepted_at) where provider_accepted_at is not null;

create function sms_private.activity_event(t text,r uuid,k text,typ text,at_time timestamptz,d jsonb default '{}',hist boolean default false,sim boolean default false) returns void
language sql security definer set search_path='' as $$
 insert into sms_private.activity_events(tenant_id,run_id,event_key,kind,occurred_at,details,historical,simulated)
 select t,r,k,typ,at_time,d,hist,sim where r is null or exists(select from sms_private.form_runs where tenant_id=t and id=r)
 on conflict(tenant_id,event_key) do nothing;
$$;

-- Reports do not invoke the model. Accepted context is usable only when it is
-- unambiguous; unrelated or competing requests remain in Unlinked activity.
create function sms_private.activity_record_message(m public.sms_messages,hist boolean default false) returns void
language plpgsql security definer set search_path='' as $$
declare rid uuid; last_ref text; previous uuid; n integer; begin
 select id into rid from sms_private.form_runs where tenant_id=m.tenant_id and phone=m.contact_phone
  and id::text=coalesce(m.meta->>'form_run_id',m.meta->>'enquiry_run_id');
 if m.direction='inbound' then
  if rid is null then
   select coalesce(meta->>'form_run_id',meta->>'enquiry_run_id') into last_ref from public.sms_messages
    where tenant_id=m.tenant_id and contact_phone=m.contact_phone and direction='outbound'
     and provider_accepted_at<=m.created_at order by provider_accepted_at desc,created_at desc,id desc limit 1;
   select a.run_id into previous from sms_private.activity_responses a join public.sms_messages x
    on x.tenant_id=a.tenant_id and x.id=a.message_id where x.tenant_id=m.tenant_id and x.conversation_id=m.conversation_id
    and x.created_at<m.created_at order by x.created_at desc limit 1;
   select count(*) into n from sms_private.form_runs r where r.tenant_id=m.tenant_id and r.phone=m.contact_phone
    and r.created_at<=m.created_at and r.status in ('active','paused') and r.appointment_at is null
    and exists(select from public.sms_messages x where x.tenant_id=r.tenant_id and x.meta->>'form_run_id'=r.id::text and x.provider_accepted_at<=m.created_at);
   if (n=1 or previous::text=last_ref) and (previous is null or previous::text=last_ref) then
    select id into rid from sms_private.form_runs where tenant_id=m.tenant_id and phone=m.contact_phone and id::text=last_ref;
   end if;
  end if;
  -- Historical current status cannot prove which competing enquiry was active.
  if hist and m.meta->>'form_run_id' is null and m.meta->>'enquiry_run_id' is null then rid:=null; end if;
  if rid is not null then
   insert into sms_private.activity_responses(tenant_id,message_id,run_id,basis) values(m.tenant_id,m.id,rid,'accepted_context') on conflict do nothing;
  end if;
  perform sms_private.activity_event(m.tenant_id,rid,'reply:'||m.id,'customer_response',m.created_at,
   jsonb_build_object('messageId',m.id,'conversationId',m.conversation_id,'body',left(m.body,600),'phone',m.contact_phone),hist);
 elsif m.provider_accepted_at is not null then
  if rid is not null or m.meta->>'agent_version'='sms-agent-v1' then
   perform sms_private.activity_event(m.tenant_id,rid,'accepted:'||m.id,
    case when m.meta ? 'form_run_id' then 'automation_accepted' else 'ai_sent' end,m.provider_accepted_at,
    jsonb_build_object('messageId',m.id,'conversationId',m.conversation_id,'body',left(m.body,600),'phone',m.contact_phone),hist);
   if m.status='delivered' then
    perform sms_private.activity_event(m.tenant_id,rid,'delivered:'||m.id,'message_delivered',case when hist then null else clock_timestamp() end,
     jsonb_build_object('messageId',m.id,'automation',m.meta ? 'form_run_id','status','delivered'),hist);
   end if;
  end if;
 end if;
end $$;

create view sms_private.activity_enquiries as
 select r.*,f.title as form_title,coalesce(nullif(r.context->>'name',''),c.name,'Unknown') as customer,
 c.opted_out,cv.id as conversation_id,coalesce(cv.ai_paused,false) as ai_paused,
 case when r.test_sequence is not null then 'test' when r.appointment_at is not null or sms_private.form_run_sequence(r)->>'trigger'='appointment' then 'appointment' else 'enquiry' end as scope,
 case when r.appointment_at is null and sms_private.form_run_sequence(r)->>'replyPolicy'='continue' then sms_private.enquiry_quiet_until(r.tenant_id,r.phone) end as quiet_until,
 (select min(m.provider_accepted_at) from public.sms_messages m where m.tenant_id=r.tenant_id and m.meta->>'form_run_id'=r.id::text and m.provider_accepted_at is not null) as first_contact_at,
 (select count(*) from sms_private.activity_responses a where a.tenant_id=r.tenant_id and a.run_id=r.id) as response_count,
 (select left(m.body,200) from sms_private.activity_responses a join public.sms_messages m on m.tenant_id=a.tenant_id and m.id=a.message_id where a.tenant_id=r.tenant_id and a.run_id=r.id order by m.created_at desc limit 1) as latest_response,
 (select count(*) from sms_private.activity_bookings a where a.tenant_id=r.tenant_id and a.run_id=r.id) as linked_bookings,
 (select count(*) from sms_private.activity_bookings a join public.sms_bookings b on b.tenant_id=a.tenant_id and b.id=a.booking_id where a.tenant_id=r.tenant_id and a.run_id=r.id and b.status='confirmed') as confirmed_bookings,
 (select count(*) from sms_private.activity_bookings a join public.sms_bookings b on b.tenant_id=a.tenant_id and b.id=a.booking_id where a.tenant_id=r.tenant_id and a.run_id=r.id and b.status='cancelled') as cancelled_bookings,
 (select count(*) from sms_private.activity_handoffs a join public.sms_handoffs h on h.tenant_id=a.tenant_id and h.id=a.handoff_id where a.tenant_id=r.tenant_id and a.run_id=r.id) as handoffs,
 (select count(*) from sms_private.activity_handoffs a join public.sms_handoffs h on h.tenant_id=a.tenant_id and h.id=a.handoff_id where a.tenant_id=r.tenant_id and a.run_id=r.id and h.status in ('open','assigned')) as unresolved_handoffs,
 coalesce((select jsonb_agg(jsonb_build_object('id',t.id,'name',t.name) order by t.name) from sms_private.activity_run_tags a join sms_private.activity_tags t on t.tenant_id=a.tenant_id and t.id=a.tag_id where a.tenant_id=r.tenant_id and a.run_id=r.id and not t.archived),'[]') as tags
 from sms_private.form_runs r join public.sms_web_form_definitions f on f.tenant_id=r.tenant_id and f.public_id=r.form_id
 left join public.sms_contacts c on c.tenant_id=r.tenant_id and c.phone=r.phone
 left join public.sms_conversations cv on cv.tenant_id=r.tenant_id and cv.phone=r.phone and cv.group_id is null;

create function sms_private.automation_activity(u text,t text,action text,p jsonb default '{}') returns jsonb
language plpgsql security definer set search_path='' as $$
declare report_at timestamptz:=statement_timestamp(); tz text; from_at timestamptz; until_at timestamptz; result jsonb;
 r sms_private.form_runs; v_booking public.sms_bookings; v_message public.sms_messages; tag sms_private.activity_tags;
 rid uuid; old_rid uuid; rev integer; manage boolean:=false; pg integer:=greatest(1,coalesce((p->>'page')::integer,1));
 page_size integer:=least(100,greatest(1,coalesce((p->>'pageSize')::integer,25))); from_day date; end_day date;
begin
 perform sms_private.require_sms_reader(u,t);
 begin perform sms_private.require_admin(u); manage:=true; exception when insufficient_privilege then manage:=false; end;
 select time_zone into tz from public.sms_businesses where tenant_id=t; tz:=coalesce(tz,'UTC');
 from_day:=coalesce(nullif(p->>'from','')::date,(report_at at time zone tz)::date-29);
 end_day:=coalesce(nullif(p->>'to','')::date,(report_at at time zone tz)::date);
 if end_day<from_day or end_day-from_day>366 then raise exception 'Choose a date range of up to 367 days'; end if;
 from_at:=from_day::timestamp at time zone tz; until_at:=(end_day+1)::timestamp at time zone tz;
 if action in ('tag','tag_assignment','booking_link','response_link','activity_link','sequence') then
  if not manage then raise exception 'Staff management access required' using errcode='42501'; end if;
  if action='tag' then
   if nullif(p->>'id','') is null then
    insert into sms_private.activity_tags(tenant_id,name) values(t,trim(p->>'name')) returning * into tag;
   else
    select * into tag from sms_private.activity_tags where tenant_id=t and id=(p->>'id')::uuid for update;
    if tag.id is null then raise exception 'Tag not found' using errcode='42501'; end if;
    if tag.revision is distinct from (p->>'revision')::integer then raise exception 'Tag changed; refresh before editing' using errcode='40001'; end if;
    update sms_private.activity_tags set name=coalesce(trim(p->>'name'),name),archived=coalesce((p->>'archived')::boolean,archived),revision=revision+1 where tenant_id=t and id=tag.id returning * into tag;
   end if;
   perform sms_private.activity_event(t,null,'tag:'||tag.id||':'||tag.revision,'staff_tag',clock_timestamp(),jsonb_build_object('actor',u,'tagId',tag.id,'name',tag.name,'archived',tag.archived));
   return jsonb_build_object('tag',to_jsonb(tag),'reportingAt',report_at);
  end if;
  select * into r from sms_private.form_runs where tenant_id=t and id=(p->>'runId')::uuid;
  if r.id is null then raise exception 'Enquiry not found' using errcode='42501'; end if;
  perform sms_private.coordination_lock(t,r.phone);
  select * into r from sms_private.form_runs where tenant_id=t and id=r.id for update;
  if action='sequence' then
   if p->>'operation' not in ('pause','resume') then raise exception 'Choose pause or resume'; end if;
   if r.generation is distinct from (p->>'generation')::bigint then raise exception 'Sequence changed; refresh before editing' using errcode='40001'; end if;
   if p->>'operation'='resume' and exists(select from public.sms_contacts where tenant_id=t and phone=r.phone and opted_out) then raise exception 'STOP suppression prevents resuming'; end if;
   perform sms_private.form_workspace(u,t,p->>'operation',r.form_id,jsonb_build_object('runId',r.id));
  elsif action='tag_assignment' then
   select * into tag from sms_private.activity_tags where tenant_id=t and id=(p->>'tagId')::uuid for share;
   if tag.id is null or tag.archived then raise exception 'Active business tag required' using errcode='42501'; end if;
   if (p->>'present')::boolean then insert into sms_private.activity_run_tags values(t,r.id,tag.id) on conflict do nothing;
   else delete from sms_private.activity_run_tags where tenant_id=t and run_id=r.id and tag_id=tag.id; end if;
  elsif action='booking_link' then
   if r.test_sequence is not null or r.appointment_at is not null then raise exception 'Choose a real enquiry'; end if;
   select * into v_booking from public.sms_bookings where tenant_id=t and id=p->>'bookingId' for update;
   if v_booking.id is null or coalesce(v_booking.customer_phone,(select phone from public.sms_contacts where tenant_id=t and id=v_booking.contact_id)) is distinct from r.phone then raise exception 'Same-business, same-customer booking required' using errcode='42501'; end if;
   select run_id,revision into old_rid,rev from sms_private.activity_bookings where tenant_id=t and booking_id=v_booking.id;
   if coalesce(rev,0) is distinct from (p->>'revision')::integer then raise exception 'Booking attribution changed; refresh before editing' using errcode='40001'; end if;
   insert into sms_private.activity_bookings(tenant_id,booking_id,run_id,basis,actor) values(t,v_booking.id,r.id,'staff_explicit',u)
    on conflict(tenant_id,booking_id) do update set run_id=excluded.run_id,basis=excluded.basis,actor=u,revision=activity_bookings.revision+1,linked_at=clock_timestamp();
   if old_rid is not null and old_rid<>r.id then perform sms_private.activity_event(t,old_rid,'booking-unlink:'||v_booking.id||':'||rev,'booking_attribution_removed',clock_timestamp(),jsonb_build_object('actor',u,'bookingId',v_booking.id,'newRunId',r.id)); end if;
  elsif action='activity_link' then
   if not exists(select from sms_private.activity_events e left join public.sms_conversations cv on cv.tenant_id=e.tenant_id and cv.id::text=e.details->>'conversationId'
    where e.tenant_id=t and e.id=(p->>'eventId')::bigint and e.kind in ('ai_action','ai_run','ai_sent') and coalesce(e.details->>'phone',cv.phone)=r.phone) then raise exception 'Same-customer AI activity required' using errcode='42501'; end if;
   update sms_private.activity_events set run_id=r.id,revision=revision+1 where tenant_id=t and id=(p->>'eventId')::bigint and revision=(p->>'revision')::integer;
   if not found then raise exception 'Activity attribution changed; refresh before editing' using errcode='40001'; end if;
  elsif action='response_link' then
   select * into v_message from public.sms_messages where tenant_id=t and id=(p->>'messageId')::uuid and direction='inbound' for update;
   if v_message.id is null or v_message.contact_phone<>r.phone then raise exception 'Same-customer response required' using errcode='42501'; end if;
   select run_id,revision into old_rid,rev from sms_private.activity_responses where tenant_id=t and message_id=v_message.id;
   if coalesce(rev,0) is distinct from (p->>'revision')::integer then raise exception 'Response attribution changed; refresh before editing' using errcode='40001'; end if;
   insert into sms_private.activity_responses(tenant_id,message_id,run_id,basis,actor) values(t,v_message.id,r.id,'staff_explicit',u)
    on conflict(tenant_id,message_id) do update set run_id=excluded.run_id,basis=excluded.basis,actor=u,revision=activity_responses.revision+1;
   update sms_private.activity_events set run_id=r.id where tenant_id=t and event_key='reply:'||v_message.id;
   if old_rid is not null and old_rid<>r.id then perform sms_private.activity_event(t,old_rid,'response-unlink:'||v_message.id||':'||rev,'response_attribution_removed',clock_timestamp(),jsonb_build_object('actor',u,'messageId',v_message.id,'newRunId',r.id)); end if;
  end if;
  perform sms_private.activity_event(t,r.id,'staff:'||gen_random_uuid(),'staff_'||action,clock_timestamp(),p||jsonb_build_object('actor',u));
  return jsonb_build_object('ok',true,'reportingAt',report_at);
 end if;
 if action='timeline' then
  select * into r from sms_private.form_runs where tenant_id=t and id=(p->>'runId')::uuid;
  if r.id is null then raise exception 'Enquiry not found' using errcode='42501'; end if;
  return jsonb_build_object('reportingAt',report_at,'timeZone',tz,'canManage',manage,
   'enquiry',(select to_jsonb(x) from sms_private.activity_enquiries x where tenant_id=t and id=r.id),
   'events',coalesce((select jsonb_agg(to_jsonb(e) order by e.recorded_at,e.id) from sms_private.activity_events e where tenant_id=t and run_id=r.id),'[]'),
   'bookings',coalesce((select jsonb_agg(jsonb_build_object('id',b.id,'status',b.status,'appointmentAt',b.appointment_at,'channel',coalesce(b.source,'Unknown'),'creator',coalesce(b.metadata->>'actor','Unknown'),'linkedRunId',a.run_id,'revision',coalesce(a.revision,0))) from public.sms_bookings b left join sms_private.activity_bookings a on a.tenant_id=b.tenant_id and a.booking_id=b.id left join public.sms_contacts c on c.tenant_id=b.tenant_id and c.id=b.contact_id where b.tenant_id=t and coalesce(b.customer_phone,c.phone)=r.phone),'[]'),
   'handoffs',coalesce((select jsonb_agg(jsonb_build_object('id',h.id,'status',h.status,'reason',h.reason)) from sms_private.activity_handoffs a join public.sms_handoffs h on h.tenant_id=a.tenant_id and h.id=a.handoff_id where a.tenant_id=t and a.run_id=r.id),'[]'));
 end if;
 if action='unlinked' then
  with items as (
   select e.*,coalesce((select jsonb_agg(jsonb_build_object('id',fr.id,'title',f.title)) from sms_private.form_runs fr join public.sms_web_form_definitions f on f.tenant_id=fr.tenant_id and f.public_id=fr.form_id where fr.tenant_id=t and fr.phone=e.details->>'phone' and fr.test_sequence is null and fr.appointment_at is null),'[]') as candidates from sms_private.activity_events e where tenant_id=t and (case when p->>'shadow'='true' then simulated else run_id is null and not simulated end) and kind in ('customer_response','ai_action','ai_sent','ai_run')
    and coalesce(occurred_at,recorded_at)>=from_at and coalesce(occurred_at,recorded_at)<until_at
    and (coalesce(p->>'search','')='' or details::text ilike '%'||(p->>'search')||'%')
  ) select jsonb_build_object('reportingAt',report_at,'timeZone',tz,'total',(select count(*) from items),'page',pg,
   'rows',coalesce((select jsonb_agg(to_jsonb(x)) from (select * from items order by recorded_at desc,id desc limit page_size offset (pg-1)*page_size)x),'[]')) into result;
  return result;
 end if;
 if action not in ('report','summary','enquiries') then raise exception 'Unknown activity operation'; end if;
 with base as materialized (
  select * from sms_private.activity_enquiries x where tenant_id=t
   and scope=coalesce(nullif(p->>'scope',''),'enquiry')
   and (coalesce(p->>'form','')='' or form_id::text=p->>'form')
   and (coalesce(p->>'status','')='' or status=p->>'status')
   and (coalesce(p->>'response','')='' or (response_count>0)=(p->>'response'='responded'))
   and (coalesce(p->>'booking','')='' or case p->>'booking' when 'booked' then confirmed_bookings>0 when 'cancelled' then cancelled_bookings>0 else confirmed_bookings=0 end)
   and (coalesce(p->>'handoff','')='' or case p->>'handoff' when 'unresolved' then unresolved_handoffs>0 when 'any' then handoffs>0 else handoffs=0 end)
   and (coalesce(p->>'search','')='' or customer ilike '%'||(p->>'search')||'%' or phone ilike '%'||(p->>'search')||'%')
   and (coalesce(p->>'tags','')='' or exists(select from jsonb_array_elements(tags) selected_tag where selected_tag->>'id'=any(string_to_array(p->>'tags',','))))
   and (coalesce(p->>'quick','')='' or case p->>'quick' when 'attention' then status='paused' or ai_paused or unresolved_handoffs>0 when 'paused' then status='paused' or ai_paused when 'responded' then response_count>0 when 'booked' then confirmed_bookings>0 else true end)
 ), cohort as materialized (select * from base where first_contact_at>=from_at and first_contact_at<until_at and first_contact_at<=report_at),
 listed as materialized (select * from base where coalesce(first_contact_at,created_at)>=from_at and coalesce(first_contact_at,created_at)<until_at),
 totals as (select count(*) as contacted,count(*) filter(where response_count>0) as responded,count(*) filter(where confirmed_bookings>0) as booked,count(*) filter(where cancelled_bookings>0) as cancelled from cohort where scope='enquiry'),
 activity as (select e.* from sms_private.activity_events e join base b on b.id=e.run_id where e.tenant_id=t and not e.simulated and e.occurred_at>=from_at and e.occurred_at<until_at and e.occurred_at<=report_at)
 select jsonb_build_object('reportingAt',report_at,'timeZone',tz,'from',from_day,'to',end_day,'canManage',manage,'page',pg,'pageSize',page_size,
  'definitions',jsonb_build_object('cohort','First provider-accepted automation message in the selected business-local dates. Subsequent attributed outcomes through reporting time.','conversion','Distinct contacted enquiries with a currently confirmed primary-linked booking. Cancelled, shadow, test and appointment runs excluded.','activity','Actual events in the selected dates; accepted is not delivered. Historical delivery snapshots without a known time are excluded.','workload','Current workload across all dates, using the other selected filters.'),
  'funnel',(select to_jsonb(totals)||jsonb_build_object('responseRate',round(100.0*responded/nullif(contacted,0),1),'conversionRate',round(100.0*booked/nullif(contacted,0),1)) from totals),
  'activity',(select jsonb_build_object('accepted',count(*) filter(where kind='automation_accepted'),'delivered',count(*) filter(where kind='message_delivered' and details->>'automation'='true'),'responses',count(*) filter(where kind='customer_response'),'aiSent',count(*) filter(where kind='ai_sent')) from activity),
  'outcomes',jsonb_build_object('linkedBookings',(select coalesce(sum(linked_bookings),0) from cohort),'handoffs',(select coalesce(sum(handoffs),0) from cohort)),
  'workload',(select jsonb_build_object('active',count(*) filter(where status='active'),'quiet',count(*) filter(where status='active' and quiet_until>report_at),'paused',count(*) filter(where status='paused'),'aiPaused',(select count(*) from public.sms_conversations cv where cv.tenant_id=t and cv.ai_paused and (exists(select from base bx where bx.conversation_id=cv.id) or (not exists(select from sms_private.form_runs fr where fr.tenant_id=t and fr.phone=cv.phone) and coalesce(p->>'form','')='' and coalesce(p->>'tags','')='' and coalesce(p->>'status','')='' and coalesce(p->>'search','')=''))),'unresolvedHandoffs',coalesce(sum(unresolved_handoffs),0)+(select count(*) from public.sms_handoffs h where h.tenant_id=t and h.status in ('open','assigned') and not exists(select from sms_private.activity_handoffs ah where ah.tenant_id=t and ah.handoff_id=h.id) and coalesce(p->>'form','')='' and coalesce(p->>'tags','')='' and coalesce(p->>'status','')='' and coalesce(p->>'search','')='')) from base),
  'total',(select count(*) from listed),'rows',coalesce((select jsonb_agg(to_jsonb(x)) from (select * from listed order by coalesce(first_contact_at,created_at) desc,id limit page_size offset (pg-1)*page_size)x),'[]'),
  'forms',coalesce((select jsonb_agg(jsonb_build_object('id',public_id,'title',title) order by title) from public.sms_web_form_definitions where tenant_id=t),'[]'),
  'tags',coalesce((select jsonb_agg(to_jsonb(tag_row) order by name) from sms_private.activity_tags tag_row where tenant_id=t),'[]')) into result;
 return result;
end $$;

create function sms_private.activity_message_trigger() returns trigger language plpgsql security definer set search_path='' as $$ begin
 perform sms_private.activity_record_message(new); return new; end $$;
create trigger activity_message after insert or update of provider_accepted_at,status on public.sms_messages
 for each row execute function sms_private.activity_message_trigger();

create function sms_private.activity_submission_time(r sms_private.form_runs) returns timestamptz
language sql stable security definer set search_path='' as $$
 select min(submitted_at) from (
 select submitted_at from public.sms_web_form_contact_submissions where tenant_id=r.tenant_id and id=r.submission_id and form_public_id=r.form_id
 union all select submitted_at from public.sms_web_form_quote_request_submissions where tenant_id=r.tenant_id and id=r.submission_id and form_public_id=r.form_id
 union all select submitted_at from public.sms_web_form_booking_submissions where tenant_id=r.tenant_id and id=r.submission_id and form_public_id=r.form_id
 ) x;
$$;
create function sms_private.activity_run_trigger() returns trigger language plpgsql security definer set search_path='' as $$ begin
 if tg_op='INSERT' then
  perform sms_private.activity_event(new.tenant_id,new.id,'run-start:'||new.id,'sequence_started',new.created_at,jsonb_build_object('submissionId',new.submission_id));
  if sms_private.activity_submission_time(new) is not null then perform sms_private.activity_event(new.tenant_id,new.id,'submission:'||new.id,'submission',sms_private.activity_submission_time(new),jsonb_build_object('submissionId',new.submission_id)); end if;
 elsif new.status is distinct from old.status or new.reason is distinct from old.reason then
  perform sms_private.activity_event(new.tenant_id,new.id,'state:'||new.id||':'||new.generation,'sequence_state',clock_timestamp(),
   jsonb_build_object('from',old.status,'status',new.status,'reason',new.reason));
 end if; return new; end $$;
create trigger activity_run after insert or update on sms_private.form_runs for each row execute function sms_private.activity_run_trigger();

create function sms_private.activity_action_trigger() returns trigger language plpgsql security definer set search_path='' as $$
declare j sms_private.jobs; rid uuid; sim boolean; bid text; h uuid; begin
 select * into j from sms_private.jobs where id=new.job_id;
 select id into rid from sms_private.form_runs where tenant_id=j.tenant_id and phone=j.payload->>'phone'
  and id::text=coalesce(new.result->'coordination'->>'requestRef',new.arguments->>'requestRef');
 sim:=coalesce((new.result->>'simulated')::boolean,false) or coalesce((new.result->'coordination'->>'simulated')::boolean,false)
  or exists(select from sms_private.inbound_ai_settings where tenant_id=j.tenant_id and mode='shadow');
 perform sms_private.activity_event(j.tenant_id,rid,'action:'||new.job_id||':'||new.action_key,'ai_action',new.created_at,
  jsonb_build_object('name',new.name,'result',new.result,'conversationId',j.payload->>'conversation_id','phone',j.payload->>'phone'),false,sim);
 if rid is not null and not sim then
  if new.result->'coordination'->>'requestRef'=rid::text then
   insert into sms_private.activity_responses(tenant_id,message_id,run_id,basis)
    select j.tenant_id,m.id,rid,'validated_action_reference' from public.sms_messages m
    where m.tenant_id=j.tenant_id and m.id::text=j.payload->>'message_id' and m.direction='inbound' on conflict do nothing;
   update sms_private.activity_events set run_id=rid where tenant_id=j.tenant_id and event_key='reply:'||(j.payload->>'message_id') and run_id is null;
  end if;
  bid:=new.result->>'bookingId';
  if new.name='confirm_booking' and new.result->>'status'='confirmed' then
   insert into sms_private.activity_bookings(tenant_id,booking_id,run_id,basis)
    select j.tenant_id,b.id,rid,'confirmed_agent_action' from public.sms_bookings b
    left join public.sms_contacts c on c.tenant_id=b.tenant_id and c.id=b.contact_id
    where b.tenant_id=j.tenant_id and b.id=bid and coalesce(b.customer_phone,c.phone)=j.payload->>'phone' on conflict do nothing;
  end if;
  if new.name='request_staff_help' then
   select id into h from public.sms_handoffs where tenant_id=j.tenant_id and ai_job_id=j.id;
   if h is not null then insert into sms_private.activity_handoffs values(j.tenant_id,h,rid) on conflict do nothing; end if;
  end if;
 end if; return new;
end $$;
create trigger activity_action after insert on sms_private.inbound_ai_actions for each row execute function sms_private.activity_action_trigger();

create function sms_private.activity_booking_trigger() returns trigger language plpgsql security definer set search_path='' as $$ declare rid uuid; begin
 if new.status is distinct from old.status then
 select run_id into rid from sms_private.activity_bookings where tenant_id=new.tenant_id and booking_id=new.id;
 if rid is not null then perform sms_private.activity_event(new.tenant_id,rid,'booking-state:'||new.id||':'||gen_random_uuid(),'booking_state',clock_timestamp(),jsonb_build_object('bookingId',new.id,'from',old.status,'status',new.status)); end if;
 end if; return new; end $$;
create trigger activity_booking after update of status on public.sms_bookings for each row execute function sms_private.activity_booking_trigger();

-- Backfill explicit facts only. A current run state is not a historical transition.
insert into sms_private.activity_events(tenant_id,run_id,event_key,kind,occurred_at,historical,details)
 select tenant_id,id,'run-start:'||id,'sequence_started',created_at,true,jsonb_build_object('submissionId',submission_id) from sms_private.form_runs;
insert into sms_private.activity_events(tenant_id,run_id,event_key,kind,occurred_at,historical,details)
 select tenant_id,id,'submission:'||id,'submission',sms_private.activity_submission_time(r),true,jsonb_build_object('submissionId',submission_id) from sms_private.form_runs r where sms_private.activity_submission_time(r) is not null;
insert into sms_private.activity_events(tenant_id,run_id,event_key,kind,historical,details)
 select tenant_id,id,'snapshot:'||id,'historical_status_snapshot',true,jsonb_build_object('status',status,'reason',reason) from sms_private.form_runs;
do $$ declare m public.sms_messages; begin
 for m in select * from public.sms_messages where direction='inbound' or meta ? 'form_run_id' or meta->>'agent_version'='sms-agent-v1' order by created_at,id loop
  perform sms_private.activity_record_message(m,true);
 end loop;
end $$;

create function sms_private.activity_handoff_trigger() returns trigger language plpgsql security definer set search_path='' as $$ declare rid uuid; begin
 select run_id into rid from sms_private.activity_handoffs where tenant_id=new.tenant_id and handoff_id=new.id;
 if tg_op='INSERT' or new.status is distinct from old.status then
 perform sms_private.activity_event(new.tenant_id,rid,'handoff:'||new.id||':'||new.status,'handoff_state',clock_timestamp(),jsonb_build_object('handoffId',new.id,'status',new.status));
 end if; return new; end $$;
create trigger activity_handoff after insert or update of status on public.sms_handoffs for each row execute function sms_private.activity_handoff_trigger();

create function sms_private.activity_ai_run_trigger() returns trigger language plpgsql security definer set search_path='' as $$ declare rid uuid; j sms_private.jobs; begin
 select * into j from sms_private.jobs where id=new.job_id;
 select id into rid from sms_private.form_runs where tenant_id=new.tenant_id and id::text=new.result->'coordination'->>'requestRef';
 perform sms_private.activity_event(new.tenant_id,rid,'ai-run:'||new.job_id,'ai_run',new.created_at,
 jsonb_build_object('conversationId',j.payload->>'conversation_id','phone',j.payload->>'phone','result',new.result),false,new.mode='shadow');
 return new; end $$;
create trigger activity_ai_run after insert on sms_private.inbound_ai_runs for each row execute function sms_private.activity_ai_run_trigger();

-- Handoffs from exhausted provider retries also use this outcome function.
alter function sms_private.apply_enquiry_outcome(sms_private.jobs,uuid,text) rename to apply_enquiry_outcome_before_activity;
create function sms_private.apply_enquiry_outcome(j sms_private.jobs,rid uuid,outcome text) returns jsonb
language plpgsql security definer set search_path='' as $$ declare result jsonb; begin
 result:=sms_private.apply_enquiry_outcome_before_activity(j,rid,outcome);
 if rid is not null and outcome='STAFF_HANDOFF' and result->>'simulated'='false' then
  insert into sms_private.activity_handoffs(tenant_id,handoff_id,run_id)
   select j.tenant_id,id,rid from public.sms_handoffs where tenant_id=j.tenant_id and ai_job_id=j.id on conflict do nothing;
  update sms_private.activity_events set run_id=rid where tenant_id=j.tenant_id and kind='handoff_state'
   and details->>'handoffId' in (select id::text from public.sms_handoffs where tenant_id=j.tenant_id and ai_job_id=j.id);
 end if; return result;
end $$;

create function sms_private.activity_link_trigger() returns trigger language plpgsql security definer set search_path='' as $$ begin
 perform sms_private.activity_event(new.tenant_id,new.run_id,'booking-link:'||new.booking_id||':'||new.revision,'booking_link',new.linked_at,
  jsonb_build_object('bookingId',new.booking_id,'basis',new.basis,'actor',new.actor));return new;
end $$;
create trigger activity_booking_link after insert or update on sms_private.activity_bookings for each row execute function sms_private.activity_link_trigger();

create function sms_private.activity_conversation_trigger() returns trigger language plpgsql security definer set search_path='' as $$ declare rid uuid; begin
 if new.ai_paused is distinct from old.ai_paused then
  select enquiry_run_id into rid from sms_private.inbound_ai_sessions where tenant_id=new.tenant_id and conversation_id=new.id;
  perform sms_private.activity_event(new.tenant_id,rid,'ai-state:'||new.id||':'||gen_random_uuid(),'ai_state',clock_timestamp(),
   jsonb_build_object('conversationId',new.id,'paused',new.ai_paused));
 end if; return new;
end $$;
create trigger activity_conversation after update of ai_paused on public.sms_conversations for each row execute function sms_private.activity_conversation_trigger();

-- Explicit action results support historical attribution; matching phone alone
-- is never enough. Unknown historical states remain snapshots.
insert into sms_private.activity_bookings(tenant_id,booking_id,run_id,basis,linked_at)
 select j.tenant_id,b.id,r.id,'historical_confirmed_action',a.created_at
 from sms_private.inbound_ai_actions a join sms_private.jobs j on j.id=a.job_id
 join sms_private.form_runs r on r.tenant_id=j.tenant_id and r.id::text=a.result->'coordination'->>'requestRef' and r.phone=j.payload->>'phone'
 join public.sms_bookings b on b.tenant_id=j.tenant_id and b.id=a.result->>'bookingId'
 where a.name='confirm_booking' and a.result->>'status'='confirmed' and coalesce(a.result->>'simulated','false')<>'true'
 order by a.created_at on conflict do nothing;
insert into sms_private.activity_handoffs(tenant_id,handoff_id,run_id)
 select j.tenant_id,h.id,r.id from sms_private.inbound_ai_actions a join sms_private.jobs j on j.id=a.job_id
 join sms_private.form_runs r on r.tenant_id=j.tenant_id and r.id::text=a.result->'coordination'->>'requestRef' and r.phone=j.payload->>'phone'
 join public.sms_handoffs h on h.tenant_id=j.tenant_id and h.ai_job_id=j.id
 where a.name='request_staff_help' and a.result->>'handoff'='true' on conflict do nothing;
insert into sms_private.activity_events(tenant_id,run_id,event_key,kind,occurred_at,historical,simulated,details)
 select j.tenant_id,r.id,'action:'||a.job_id||':'||a.action_key,'ai_action',a.created_at,true,
 coalesce(a.result->>'simulated','false')='true' or coalesce(a.result->'coordination'->>'simulated','false')='true' or coalesce(ai.mode='shadow',false),
 jsonb_build_object('name',a.name,'result',a.result,'conversationId',j.payload->>'conversation_id','phone',j.payload->>'phone')
 from sms_private.inbound_ai_actions a join sms_private.jobs j on j.id=a.job_id
 left join sms_private.inbound_ai_runs ai on ai.job_id=j.id
 left join sms_private.form_runs r on r.tenant_id=j.tenant_id and r.id::text=coalesce(a.result->'coordination'->>'requestRef',a.arguments->>'requestRef')
 on conflict do nothing;
update sms_private.activity_events set historical=true where kind='booking_link' and details->>'basis'='historical_confirmed_action';
insert into sms_private.activity_events(tenant_id,run_id,event_key,kind,occurred_at,historical,simulated,details)
 select ai.tenant_id,r.id,'ai-run:'||ai.job_id,'ai_run',ai.created_at,true,ai.mode='shadow',
 jsonb_build_object('conversationId',j.payload->>'conversation_id','phone',j.payload->>'phone','result',ai.result)
 from sms_private.inbound_ai_runs ai join sms_private.jobs j on j.id=ai.job_id
 left join sms_private.form_runs r on r.tenant_id=ai.tenant_id and r.id::text=ai.result->'coordination'->>'requestRef' on conflict do nothing;

do $$ declare tab text; f record; begin
 foreach tab in array array['activity_events','activity_responses','activity_bookings','activity_tags','activity_run_tags','activity_handoffs'] loop
 execute format('alter table sms_private.%I enable row level security',tab);
 execute format('revoke all on sms_private.%I from public,anon,authenticated,sms_api,sms_ai,sms_sender,sms_webhook,sms_automation',tab);
 end loop;
 revoke all on sms_private.activity_enquiries from public,anon,authenticated,sms_api;
 for f in select p.oid::regprocedure as signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='sms_private' and (p.proname like 'activity_%' or p.proname='automation_activity') loop
 execute format('revoke all on function %s from public,anon,authenticated,sms_api,sms_ai,sms_sender,sms_webhook,sms_automation',f.signature);
 end loop;
end $$;
grant execute on function sms_private.automation_activity(text,text,text,jsonb) to sms_api;
revoke all on function sms_private.apply_enquiry_outcome(sms_private.jobs,uuid,text),sms_private.apply_enquiry_outcome_before_activity(sms_private.jobs,uuid,text) from public,anon,authenticated,sms_api,sms_ai,sms_sender,sms_webhook,sms_automation;
