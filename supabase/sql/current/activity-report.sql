-- Maintained current activity view and reporting API. Requires queue-reporting.sql.
create or replace view sms_private.activity_enquiries as
 select r.id,r.tenant_id,r.form_id,r.version,r.submission_id,r.intake_id,r.phone,r.context,r.appointment_at,r.status,r.reason,r.message_index,r.repeat_index,r.send_index,r.generation,r.next_run_at,r.last_sent_at,r.created_at,r.test_sequence,r.test_actor,r.test_request,coalesce(f.title,d.name) as form_title,coalesce(nullif(r.context->>'name',''),c.name,'Unknown') as customer,
 c.opted_out,cv.id as conversation_id,coalesce(cv.ai_paused,false) as ai_paused,
 case when r.test_sequence is not null then 'test' when r.appointment_at is not null or sms_private.form_run_sequence(r)->>'trigger'='appointment' then 'appointment' when r.origin='direct' then 'direct' else 'enquiry' end as scope,
 case when r.appointment_at is null and sms_private.form_run_sequence(r)->>'replyPolicy'='continue' then sms_private.run_quiet_until(r) end as quiet_until,
 (select a.accepted_at from sms_private.activity_first_contacts a where a.tenant_id=r.tenant_id and a.run_id=r.id) as first_contact_at,
 (select count(*) from sms_private.activity_responses a where a.tenant_id=r.tenant_id and a.run_id=r.id) as response_count,
 (select left(m.body,200) from sms_private.activity_responses a join public.sms_messages m on m.tenant_id=a.tenant_id and m.id=a.message_id where a.tenant_id=r.tenant_id and a.run_id=r.id order by m.created_at desc limit 1) as latest_response,
 (select count(*) from sms_private.activity_bookings a where a.tenant_id=r.tenant_id and a.run_id=r.id) as linked_bookings,
 (select count(*) from sms_private.activity_bookings a join public.sms_bookings b on b.tenant_id=a.tenant_id and b.id=a.booking_id where a.tenant_id=r.tenant_id and a.run_id=r.id and b.status='confirmed') as confirmed_bookings,
 (select count(*) from sms_private.activity_bookings a join public.sms_bookings b on b.tenant_id=a.tenant_id and b.id=a.booking_id where a.tenant_id=r.tenant_id and a.run_id=r.id and b.status='cancelled') as cancelled_bookings,
 (select count(*) from sms_private.activity_handoffs a join public.sms_handoffs h on h.tenant_id=a.tenant_id and h.id=a.handoff_id where a.tenant_id=r.tenant_id and a.run_id=r.id) as handoffs,
 (select count(*) from sms_private.activity_handoffs a join public.sms_handoffs h on h.tenant_id=a.tenant_id and h.id=a.handoff_id where a.tenant_id=r.tenant_id and a.run_id=r.id and h.status in ('open','assigned')) as unresolved_handoffs,
 coalesce((select jsonb_agg(jsonb_build_object('id',t.id,'name',t.name) order by t.name) from sms_private.activity_run_tags a join sms_private.activity_tags t on t.tenant_id=a.tenant_id and t.id=a.tag_id where a.tenant_id=r.tenant_id and a.run_id=r.id and not t.archived),'[]') as tags,r.origin,r.direct_template_id,r.direct_sequence,r.actor,r.enrollment_key
 from sms_private.form_runs r left join public.sms_web_form_definitions f on f.tenant_id=r.tenant_id and f.public_id=r.form_id left join sms_private.direct_templates d on d.tenant_id=r.tenant_id and d.id=r.direct_template_id
 left join public.sms_contacts c on c.tenant_id=r.tenant_id and c.phone=r.phone
 left join public.sms_conversations cv on cv.tenant_id=r.tenant_id and cv.phone=r.phone and cv.group_id is null;

CREATE OR REPLACE FUNCTION sms_private.automation_activity(u text, t text, action text, p jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
   if p->>'operation' not in ('pause','resume','stop') then raise exception 'Choose pause, resume or stop'; end if;
   if r.generation is distinct from (p->>'generation')::bigint then raise exception 'Sequence changed; refresh before editing' using errcode='40001'; end if;
   if p->>'operation'='resume' and exists(select from public.sms_contacts where tenant_id=t and phone=r.phone and opted_out) then raise exception 'STOP suppression prevents resuming'; end if;
   perform sms_private.contact_automations(u,t,'run',p||jsonb_build_object('contactId',(select id from public.sms_contacts where tenant_id=t and phone=r.phone),'idempotencyKey',coalesce(p->>'idempotencyKey','activity:'||r.id||':'||r.generation||':'||(p->>'operation'))));
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
   if r.origin='direct' and v_booking.status='confirmed' and r.status in ('active','paused') then update sms_private.form_runs set status='stopped',reason='LINKED_BOOKING_CONFIRMED',next_run_at=null,generation=generation+1 where id=r.id;end if;
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
  with items as materialized (
   select e.* from sms_private.activity_events e where tenant_id=t
    and (case when p->>'shadow'='true' then simulated else run_id is null and not simulated end)
    and kind in ('customer_response','ai_action','ai_sent','ai_run')
    and coalesce(occurred_at,recorded_at)>=from_at and coalesce(occurred_at,recorded_at)<until_at
    and (coalesce(p->>'search','')='' or details::text ilike '%'||(p->>'search')||'%')
  ), paged as materialized (select * from items order by recorded_at desc,id desc limit page_size offset (pg-1)*page_size)
  select jsonb_build_object('reportingAt',report_at,'timeZone',tz,'total',(select count(*) from items),'page',pg,
   'rows',coalesce((select jsonb_agg(to_jsonb(e)||jsonb_build_object('candidates',coalesce((
    select jsonb_agg(jsonb_build_object('id',fr.id,'title',coalesce(f.title,d.name))) from sms_private.form_runs fr
    left join public.sms_web_form_definitions f on f.tenant_id=fr.tenant_id and f.public_id=fr.form_id
    left join sms_private.direct_templates d on d.tenant_id=fr.tenant_id and d.id=fr.direct_template_id
    where fr.tenant_id=t and fr.phone=e.details->>'phone' and fr.test_sequence is null and fr.appointment_at is null),'[]'))
    order by e.recorded_at desc,e.id desc) from paged e),'[]')) into result;
  return result;
 end if;
 if action not in ('report','summary','enquiries') then raise exception 'Unknown activity operation'; end if;
 -- Base carries only filtering keys. Never materialize the wide display view
 -- across history: date cohorts, the selected page, and live workload diverge.
 with base as materialized (
  select frun.id,frun.tenant_id,frun.phone,frun.status,frun.created_at,a.accepted_at as first_contact_at,
   cv.id as conversation_id,coalesce(cv.ai_paused,false) as ai_paused,sc.scope
  from sms_private.form_runs frun
  left join sms_private.activity_first_contacts a on a.run_id=frun.id and a.tenant_id=frun.tenant_id
  left join public.sms_contacts c on c.tenant_id=frun.tenant_id and c.phone=frun.phone
  left join public.sms_conversations cv on cv.tenant_id=frun.tenant_id and cv.phone=frun.phone and cv.group_id is null
  left join sms_private.form_sequence_versions v on v.tenant_id=frun.tenant_id and v.form_id=frun.form_id and v.version=frun.version
  cross join lateral (select case when frun.test_sequence is not null then 'test'
   when frun.appointment_at is not null or coalesce(frun.direct_sequence,frun.test_sequence,v.sequence)->>'trigger'='appointment' then 'appointment'
   when frun.origin='direct' then 'direct' else 'enquiry' end as scope)sc
  where frun.tenant_id=t
   and (sc.scope=coalesce(nullif(p->>'scope',''),'all') or coalesce(nullif(p->>'scope',''),'all')='all' and sc.scope in ('enquiry','direct'))
   and (coalesce(p->>'template','')='' or frun.direct_template_id::text=p->>'template')
   and (coalesce(p->>'form','')='' or frun.form_id::text=p->>'form')
   and (coalesce(p->>'status','')='' or frun.status=p->>'status')
   and (coalesce(p->>'search','')='' or coalesce(nullif(frun.context->>'name',''),c.name,'Unknown') ilike '%'||(p->>'search')||'%' or frun.phone ilike '%'||(p->>'search')||'%')
   and (coalesce(p->>'tags','')='' or exists(select from sms_private.activity_run_tags rt join sms_private.activity_tags tag_filter on tag_filter.tenant_id=rt.tenant_id and tag_filter.id=rt.tag_id
    where rt.tenant_id=t and rt.run_id=frun.id and not tag_filter.archived and tag_filter.id::text=any(string_to_array(p->>'tags',','))))
   and (coalesce(p->>'response','')='' or exists(select from sms_private.activity_responses x where x.tenant_id=t and x.run_id=frun.id)=(p->>'response'='responded'))
   and (coalesce(p->>'booking','')='' or case p->>'booking'
    when 'booked' then exists(select from sms_private.activity_bookings x join public.sms_bookings b on b.tenant_id=x.tenant_id and b.id=x.booking_id where x.tenant_id=t and x.run_id=frun.id and b.status='confirmed')
    when 'cancelled' then exists(select from sms_private.activity_bookings x join public.sms_bookings b on b.tenant_id=x.tenant_id and b.id=x.booking_id where x.tenant_id=t and x.run_id=frun.id and b.status='cancelled')
    else not exists(select from sms_private.activity_bookings x join public.sms_bookings b on b.tenant_id=x.tenant_id and b.id=x.booking_id where x.tenant_id=t and x.run_id=frun.id and b.status='confirmed') end)
   and (coalesce(p->>'handoff','')='' or case p->>'handoff'
    when 'unresolved' then exists(select from sms_private.activity_handoffs x join public.sms_handoffs h on h.tenant_id=x.tenant_id and h.id=x.handoff_id where x.tenant_id=t and x.run_id=frun.id and h.status in ('open','assigned'))
    when 'any' then exists(select from sms_private.activity_handoffs x where x.tenant_id=t and x.run_id=frun.id)
    else not exists(select from sms_private.activity_handoffs x where x.tenant_id=t and x.run_id=frun.id) end)
   and (coalesce(p->>'quick','')='' or case p->>'quick'
    when 'attention' then frun.status='paused' or cv.ai_paused or exists(select from sms_private.activity_handoffs x join public.sms_handoffs h on h.tenant_id=x.tenant_id and h.id=x.handoff_id where x.tenant_id=t and x.run_id=frun.id and h.status in ('open','assigned'))
    when 'paused' then frun.status='paused' or cv.ai_paused
    when 'responded' then exists(select from sms_private.activity_responses x where x.tenant_id=t and x.run_id=frun.id)
    when 'booked' then exists(select from sms_private.activity_bookings x join public.sms_bookings b on b.tenant_id=x.tenant_id and b.id=x.booking_id where x.tenant_id=t and x.run_id=frun.id and b.status='confirmed') else true end)
 ), cohort as materialized (
  select x.id,x.scope,x.response_count,x.confirmed_bookings,x.cancelled_bookings,x.linked_bookings,x.handoffs
  from (select id from base where first_contact_at>=from_at and first_contact_at<until_at and first_contact_at<=report_at)b
  cross join lateral (select x.id,x.scope,x.response_count,x.confirmed_bookings,x.cancelled_bookings,x.linked_bookings,x.handoffs
   from sms_private.activity_enquiries x where x.tenant_id=t and x.id=b.id offset 0)x
 ), listed as materialized (
  select * from base where coalesce(first_contact_at,created_at)>=from_at and coalesce(first_contact_at,created_at)<until_at
 ), paged as materialized (
  select * from listed order by coalesce(first_contact_at,created_at) desc,id limit page_size offset (pg-1)*page_size
 ), totals as (
  select count(*) as contacted,count(*) filter(where response_count>0) as responded,count(*) filter(where confirmed_bookings>0) as booked,count(*) filter(where cancelled_bookings>0) as cancelled from cohort where scope='enquiry'
 ), activity as (
  select e.* from sms_private.activity_events e join base b on b.id=e.run_id where e.tenant_id=t and not e.simulated and e.occurred_at>=from_at and e.occurred_at<until_at and e.occurred_at<=report_at
 ), live_candidates as materialized (
  select frun from base b join sms_private.form_runs frun on frun.id=b.id where b.status='active'
   and frun.appointment_at is null and sms_private.form_run_sequence(frun)->>'replyPolicy'='continue'
 ), live_quiet as materialized (
  select (frun).id from live_candidates where sms_private.run_quiet_until(frun)>report_at
 )
 select jsonb_build_object('reportingAt',report_at,'timeZone',tz,'from',from_day,'to',end_day,'canManage',manage,'page',pg,'pageSize',page_size,
  'definitions',jsonb_build_object('cohort','First provider-accepted automation message in the selected business-local dates. Subsequent attributed outcomes through reporting time.','conversion','Distinct contacted enquiries with a currently confirmed primary-linked booking. Cancelled, shadow, test and appointment runs excluded.','activity','Actual events in the selected dates; accepted is not delivered. Historical delivery snapshots without a known time are excluded.','workload','Current workload across all dates, using the other selected filters.'),
  'directFunnel',(select jsonb_build_object('contacted',count(*),'responded',count(*) filter(where response_count>0),'booked',count(*) filter(where confirmed_bookings>0),'cancelled',count(*) filter(where cancelled_bookings>0),'responseRate',round(100.0*count(*) filter(where response_count>0)/nullif(count(*),0),1),'conversionRate',round(100.0*count(*) filter(where confirmed_bookings>0)/nullif(count(*),0),1)) from cohort where scope='direct'),
  'templates',coalesce((select jsonb_agg(jsonb_build_object('id',id,'title',name) order by name) from sms_private.direct_templates where tenant_id=t),'[]'),
  'funnel',(select to_jsonb(totals)||jsonb_build_object('responseRate',round(100.0*responded/nullif(contacted,0),1),'conversionRate',round(100.0*booked/nullif(contacted,0),1)) from totals),
  'activity',(select jsonb_build_object('accepted',count(*) filter(where kind='automation_accepted'),'delivered',count(*) filter(where kind='message_delivered' and details->>'automation'='true'),'responses',count(*) filter(where kind='customer_response'),'aiSent',count(*) filter(where kind='ai_sent')) from activity),
  'outcomes',jsonb_build_object('linkedBookings',(select coalesce(sum(linked_bookings),0) from cohort),'handoffs',(select coalesce(sum(handoffs),0) from cohort)),
  'workload',jsonb_build_object('active',(select count(*) from base where status='active'),'quiet',(select count(*) from live_quiet),'paused',(select count(*) from base where status='paused'),
   'aiPaused',(select count(*) from public.sms_conversations cv where cv.tenant_id=t and cv.ai_paused and (exists(select from base bx where bx.conversation_id=cv.id) or (not exists(select from sms_private.form_runs fr where fr.tenant_id=t and fr.phone=cv.phone) and coalesce(p->>'form','')='' and coalesce(p->>'tags','')='' and coalesce(p->>'status','')='' and coalesce(p->>'search','')=''))),
   'unresolvedHandoffs',(select count(*) from sms_private.activity_handoffs ah join public.sms_handoffs h on h.tenant_id=ah.tenant_id and h.id=ah.handoff_id join base b on b.id=ah.run_id where ah.tenant_id=t and h.status in ('open','assigned'))
    +(select count(*) from public.sms_handoffs h where h.tenant_id=t and h.status in ('open','assigned') and not exists(select from sms_private.activity_handoffs ah where ah.tenant_id=t and ah.handoff_id=h.id) and coalesce(p->>'form','')='' and coalesce(p->>'tags','')='' and coalesce(p->>'status','')='' and coalesce(p->>'search','')='')),
  'total',(select count(*) from listed),
  'rows',coalesce((select jsonb_agg(to_jsonb(x) order by coalesce(b.first_contact_at,b.created_at) desc,b.id) from paged b
   cross join lateral (select * from sms_private.activity_enquiries x where x.tenant_id=t and x.id=b.id offset 0)x),'[]'),
  'forms',coalesce((select jsonb_agg(jsonb_build_object('id',public_id,'title',title) order by title) from public.sms_web_form_definitions where tenant_id=t),'[]'),
  'tags',coalesce((select jsonb_agg(to_jsonb(tag_row) order by name) from sms_private.activity_tags tag_row where tenant_id=t),'[]')) into result;
 return result;
end $function$;
