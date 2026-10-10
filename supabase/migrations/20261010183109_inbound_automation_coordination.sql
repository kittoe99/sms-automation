-- CRM-owned forward migration; requires inbound_sms_agent (remote 20261010175821)
-- and the paired E2 form/cache baseline. Never replay either historical migration.
alter table sms_private.inbound_ai_settings add column coordination_enabled boolean not null default false;
alter table sms_private.inbound_ai_sessions add column enquiry_run_id uuid references sms_private.form_runs(id);
create index inbound_sessions_enquiry on sms_private.inbound_ai_sessions(enquiry_run_id) where enquiry_run_id is not null;
create index inbound_coordination_messages on public.sms_messages(tenant_id,contact_phone,provider_accepted_at desc) where direction='outbound' and provider_accepted_at is not null;

-- Take the same phone lock BEFORE job/contact/run locks in every participating
-- entrypoint. It is never held over an OpenAI or Twilio network request.
create function sms_private.coordination_lock(t text,ph text) returns void
language plpgsql security definer set search_path='' as $$ begin
 if ph is not null then perform pg_advisory_xact_lock(hashtextextended(t||':'||ph,419)); end if;
end $$;
create function sms_private.coordination_job_lock(jid uuid) returns void
language plpgsql security definer set search_path='' as $$ declare j sms_private.jobs; ph text; begin
 select * into strict j from sms_private.jobs where id=jid;
 ph:=coalesce(j.payload->>'phone',j.payload->'request'->>'phone',
  (select phone from sms_private.form_runs where tenant_id=j.tenant_id and id=(j.payload->>'form_run_id')::uuid));
 perform sms_private.coordination_lock(j.tenant_id,ph);
end $$;

-- A derived deadline avoids a second mutable clock and includes real provider
-- acceptance, not just creation of an outbound row. Shadow reads can simulate it.
create function sms_private.enquiry_quiet_until(t text,ph text,simulate boolean default false) returns timestamptz
language plpgsql security definer set search_path='' as $$ declare until_at timestamptz; s sms_private.inbound_ai_settings; begin
 select * into s from sms_private.inbound_ai_settings where tenant_id=t;
 if not coalesce(s.coordination_enabled,false) or (s.mode<>'live' and not(simulate and s.mode='shadow')) then return null; end if;
 select max(case when direction='inbound' then created_at else provider_accepted_at end)+interval '30 minutes' into until_at
 from public.sms_messages where tenant_id=t and contact_phone=ph
  and (direction='inbound' or direction='outbound' and provider_accepted_at is not null and meta->>'agent_version'='sms-agent-v1');
 if exists(select from sms_private.jobs where tenant_id=t and queue='ai_reply_jobs' and payload->>'phone'=ph
    and payload->>'agent_version'='sms-agent-v1' and (payload->>'settings_revision')::integer=s.revision
    and status in ('queued','retry','processing'))
  or exists(select from sms_private.jobs j join public.sms_messages m on m.tenant_id=j.tenant_id and m.id=(j.payload->>'message_id')::uuid
    where j.tenant_id=t and j.queue='sms_send_jobs' and j.payload->'request'->>'phone'=ph
      and j.payload->'request'->>'agent_version'='sms-agent-v1' and m.provider_accepted_at is null
      and j.status in ('queued','retry','processing','submitting','submission_unknown')) then
  until_at:=greatest(until_at,now()+interval '1 minute');
 end if;
 return until_at;
end $$;

create function sms_private.inbound_automation_context(j sms_private.jobs) returns jsonb
language plpgsql security definer set search_path='' as $$
declare candidates jsonb; last_out jsonb; associated uuid; previous uuid; n integer; begin
 if not exists(select from sms_private.inbound_ai_settings where tenant_id=j.tenant_id and coordination_enabled and mode in ('live','shadow')) then return '{}'; end if;
 select jsonb_build_object('id',id,'body',left(body,1600),'acceptedAt',provider_accepted_at,'requestRef',coalesce(meta->>'form_run_id',meta->>'enquiry_run_id')) into last_out
 from public.sms_messages where tenant_id=j.tenant_id and contact_phone=j.payload->>'phone' and direction='outbound'
  and provider_accepted_at is not null and provider_accepted_at<=(select created_at from public.sms_messages where tenant_id=j.tenant_id and id=(j.payload->>'message_id')::uuid)
 order by provider_accepted_at desc,created_at desc,id desc limit 1;
 select coalesce(jsonb_agg(x order by x."requestRef"),'[]'),count(*) into candidates,n from (
  select r.id as "requestRef",r.form_id as "formId",f.title,r.submission_id as "submissionId",r.version,
   r.status,r.reason,r.message_index+1 as "messageNumber",r.next_run_at as "nextRunAt",
   sms_private.form_run_sequence(r)->>'replyPolicy' as "replyPolicy",left(r.context::text,2500) as "customerContext",
   (select jsonb_build_object('body',left(m.body,1600),'acceptedAt',m.provider_accepted_at) from public.sms_messages m
     where m.tenant_id=r.tenant_id and m.contact_phone=r.phone and m.meta->>'form_run_id'=r.id::text and m.provider_accepted_at is not null
     order by m.provider_accepted_at desc limit 1) as "lastAutomationMessage"
  from sms_private.form_runs r join public.sms_web_form_definitions f on f.tenant_id=r.tenant_id and f.public_id=r.form_id
  where r.tenant_id=j.tenant_id and r.phone=j.payload->>'phone' and r.appointment_at is null
   and sms_private.form_run_sequence(r)->>'trigger'='submission' and r.status in ('active','paused')
  order by r.id limit 11
 )x;
 select enquiry_run_id into previous from sms_private.inbound_ai_sessions where tenant_id=j.tenant_id and conversation_id=(j.payload->>'conversation_id')::uuid;
 if exists(select from jsonb_array_elements(candidates) x where x->>'requestRef'=previous::text) then associated:=previous; end if;
 if last_out->>'requestRef' is not null and exists(select from jsonb_array_elements(candidates) x where x->>'requestRef'=last_out->>'requestRef') then
  if associated is null or associated::text=last_out->>'requestRef' then associated:=(last_out->>'requestRef')::uuid; else associated:=null; end if;
 elsif associated is null and n=1 then associated:=(candidates->0->>'requestRef')::uuid; end if;
 if n>10 then associated:=null; end if;
 return jsonb_build_object('candidates',candidates,'associatedRequestRef',associated,'needsClarification',associated is null and n>1,
  'lastAcceptedOutbound',last_out,'quietUntil',sms_private.enquiry_quiet_until(j.tenant_id,j.payload->>'phone',true),'shadow',
  exists(select from sms_private.inbound_ai_settings where tenant_id=j.tenant_id and mode='shadow'));
end $$;

-- Validate references against the job's context, never accept arbitrary run IDs.
-- With competing enquiries an explicit form title in the latest text can resolve
-- the choice. Otherwise return clarification instead of guessing.
create function sms_private.inbound_enquiry_ref(j sms_private.jobs,ref text) returns uuid
language plpgsql security definer set search_path='' as $$ declare ctx jsonb; candidate jsonb; body text; begin
 ctx:=sms_private.inbound_automation_context(j);
 ref:=coalesce(nullif(ref,''),ctx->>'associatedRequestRef');
 if ref is null then return null; end if;
 select x into candidate from jsonb_array_elements(coalesce(ctx->'candidates','[]')) x where x->>'requestRef'=ref;
 if candidate is null then raise exception 'Enquiry reference outside job scope' using errcode='42501'; end if;
 if ref is distinct from ctx->>'associatedRequestRef' then
  select m.body into body from public.sms_messages m where tenant_id=j.tenant_id and id=(j.payload->>'message_id')::uuid;
  if length(candidate->>'title')<3 or position(lower(candidate->>'title') in lower(body))=0 or (select count(*) from jsonb_array_elements(ctx->'candidates') x where lower(x->>'title')=lower(candidate->>'title'))<>1 then return null; end if;
 end if;
 return ref::uuid;
end $$;

create function sms_private.apply_enquiry_outcome(j sms_private.jobs,rid uuid,outcome text) returns jsonb
language plpgsql security definer set search_path='' as $$ declare r sms_private.form_runs; simulated boolean; begin
 if rid is null then return '{}'::jsonb; end if;
 if outcome not in ('BOOKED','DECLINED','STAFF_HANDOFF') then raise exception 'Invalid enquiry outcome'; end if;
 select * into r from sms_private.form_runs where tenant_id=j.tenant_id and id=rid and phone=j.payload->>'phone' for update;
 if r.id is null or r.appointment_at is not null or sms_private.form_run_sequence(r)->>'trigger'<>'submission' then raise exception 'Enquiry scope denied' using errcode='42501'; end if;
 select mode='shadow' into simulated from sms_private.inbound_ai_settings where tenant_id=j.tenant_id and coordination_enabled and mode in ('live','shadow');
 if simulated is null then return '{}'; end if;
 if not simulated and r.status in ('active','paused') then
  update sms_private.form_runs set status=case when outcome='STAFF_HANDOFF' then 'paused' else 'stopped' end,
   reason='AI_'||outcome,generation=generation+1,next_run_at=case when outcome='STAFF_HANDOFF' then next_run_at else null end where id=rid;
 end if;
 return jsonb_build_object('requestRef',rid,'reason','AI_'||outcome,'simulated',simulated);
end $$;

-- Retry the SAME queue item without treating a quiet window as a send failure.
create function sms_private.defer_enquiry_job(j sms_private.jobs,token uuid,rid uuid) returns boolean
language plpgsql security definer set search_path='' as $$ declare r sms_private.form_runs; due timestamptz; begin
 select * into r from sms_private.form_runs where tenant_id=j.tenant_id and id=rid for update;
 if r.id is null or r.status<>'active' or r.appointment_at is not null
  or sms_private.form_run_sequence(r)->>'trigger'<>'submission' or sms_private.form_run_sequence(r)->>'replyPolicy'<>'continue' then return false; end if;
 if r.generation<>coalesce((j.payload->>'generation')::bigint,(j.payload->'request'->>'run_generation')::bigint)
  or r.send_index<>coalesce((j.payload->>'send_index')::integer,(j.payload->'request'->>'send_index')::integer) then return false; end if;
 due:=sms_private.enquiry_quiet_until(r.tenant_id,r.phone);
 if due is null or due<=now() then return false; end if;
 update sms_private.jobs set attempts=greatest(0,attempts-1) where id=j.id;
 perform sms_private.finish(j.id,token,'retry','AI_QUIET_WINDOW',greatest(1,ceil(extract(epoch from due-now()))::integer));
 return true;
end $$;


create or replace function sms_private.inbound_ai_context(jid uuid,token uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare j sms_private.jobs; result jsonb; begin
 perform sms_private.coordination_job_lock(jid);
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
  'automation',sms_private.inbound_automation_context(j),
  'requests',coalesce((select jsonb_agg(x) from (select form_public_id,name,details,submitted_at from (
    select tenant_id,phone,form_public_id,name,details,submitted_at from public.sms_web_form_contact_submissions
    union all select tenant_id,phone,form_public_id,name,details,submitted_at from public.sms_web_form_quote_request_submissions
    union all select tenant_id,phone,form_public_id,name,details,submitted_at from public.sms_web_form_booking_submissions
   ) submissions where tenant_id=j.tenant_id and phone=j.payload->>'phone' order by submitted_at desc limit 3)x),'[]'),
  'services',coalesce((select jsonb_agg(jsonb_build_object('service',service,'timeZone',time_zone)) from public.sms_voice_service_rules where tenant_id=j.tenant_id and enabled),'[]'),
  'recoveredReply',(select a.result->>'customerReply' from sms_private.inbound_ai_actions a where a.job_id=jid and a.name in ('confirm_booking','request_staff_help','close_enquiry') order by a.created_at desc limit 1)) into result
 from public.sms_businesses b join sms_private.inbound_ai_settings s using(tenant_id) where b.tenant_id=j.tenant_id;
 return result;
end $$;

create or replace function sms_private.inbound_ai_tool(jid uuid,token uuid,name text,args jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
#variable_conflict use_variable
declare j sms_private.jobs; s sms_private.inbound_ai_settings; sess sms_private.inbound_ai_sessions;
 r public.sms_voice_service_rules; settings public.sms_booking_settings; result jsonb; key text; draft jsonb;
 rid uuid; coordination jsonb; quote text;
 conv uuid; cid uuid; hid uuid; ph text; body text; missing text; summary text; held sms_private.voice_booking_holds;
begin
 perform sms_private.coordination_job_lock(jid);
 j:=sms_private.lease(jid,token);
 if not sms_private.inbound_ai_eligible(j) then return jsonb_build_object('stale',true); end if;
 if name not in ('lookup_bookings','check_availability','prepare_booking','confirm_booking','request_staff_help','close_enquiry')
  or jsonb_typeof(args) is distinct from 'object' or pg_column_size(args)>16000 then raise exception 'Invalid tool'; end if;
 if args ?| array['tenant','tenant_id','phone','customerId','conversation_id'] then raise exception 'Identity is server-owned' using errcode='42501'; end if;
 conv:=(j.payload->>'conversation_id')::uuid;ph:=j.payload->>'phone';
 select * into strict s from sms_private.inbound_ai_settings where tenant_id=j.tenant_id;
 select id into strict cid from public.sms_contacts where tenant_id=j.tenant_id and phone=ph;
 key:=name||':'||md5(args::text);
 select a.result into result from sms_private.inbound_ai_actions a where a.job_id=jid and a.action_key=key;
 if found then return result; end if;
 if (select count(*) from sms_private.inbound_ai_actions where job_id=jid)>=3 then raise exception 'Tool budget exhausted'; end if;
 if s.coordination_enabled then
  coordination:=sms_private.inbound_automation_context(j);
  if name in ('prepare_booking','request_staff_help','close_enquiry') then
   if name in ('prepare_booking','request_staff_help') and args ? 'requestRef' and args->>'requestRef' is null then rid:=null;
   else rid:=sms_private.inbound_enquiry_ref(j,args->>'requestRef'); end if;
   if args->>'requestRef' is not null and rid is null then return jsonb_build_object('needsClarification',true,'customerReply','Which enquiry do you mean? Please tell me the form title.'); end if;
  end if;
 end if;
 if name='close_enquiry' then
  if not s.coordination_enabled then return jsonb_build_object('error','Enquiry coordination is disabled'); end if;
  if exists(select from jsonb_object_keys(args) k where k not in ('requestRef','declineQuote')) then raise exception 'Invalid enquiry field'; end if;
  quote:=btrim(coalesce(args->>'declineQuote',''));
  select m.body into body from public.sms_messages m where tenant_id=j.tenant_id and id=(j.payload->>'message_id')::uuid;
  -- Require evidence in the actual inbound text, not a model-supplied intention.
  -- Bare no/thanks and appointment cancellations must never close an enquiry.
  if rid is null or length(quote)<4 or position(lower(quote) in lower(body))=0
   or lower(quote) !~ '(not interested|no thank(s| you)|do(n''t| not) need|no longer need|stop (the |these )?follow.?ups|close (my |the |this )?enquiry)'
   or lower(body) ~ '(cancel|reschedul|another time|different time|but |instead|not yet|maybe|later|tomorrow|next week|[?])' then
   return jsonb_build_object('needsClarification',true,'customerReply','Would you like me to stop follow-ups for this enquiry? Please confirm which enquiry you no longer need.');
  end if;
  result:=jsonb_build_object('coordination',sms_private.apply_enquiry_outcome(j,rid,'DECLINED'),
   'customerReply',case when s.mode='shadow' then 'Shadow: would stop follow-ups for this enquiry.' else 'I have stopped follow-ups for this enquiry.' end);
 elsif name='lookup_bookings' then
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
  if exists(select from jsonb_object_keys(args) k where k not in ('service','name','address','localDate','localTime','details','requestRef')) then raise exception 'Invalid booking field'; end if;
  select * into sess from sms_private.inbound_ai_sessions where tenant_id=j.tenant_id and conversation_id=conv for update;
  draft:=coalesce(sess.draft,'{}')||jsonb_strip_nulls(args-'requestRef');
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
  if s.mode='live' and s.coordination_enabled then update sms_private.inbound_ai_sessions set enquiry_run_id=rid where tenant_id=j.tenant_id and conversation_id=conv; end if;
  result:=result||jsonb_build_object('coordination',jsonb_build_object('requestRef',rid,'reason','PREPARING_BOOKING','simulated',s.mode='shadow'));
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
  if not exists(select from sms_private.voice_booking_holds where tenant_id=j.tenant_id and id=sess.hold_id and confirmed_booking_id is not null)
   and sess.summary_message_id is distinct from (select m.id from public.sms_messages m
    where m.tenant_id=j.tenant_id and m.contact_phone=ph and m.direction='outbound' and m.provider_accepted_at is not null
      and m.provider_accepted_at<=(select created_at from public.sms_messages where tenant_id=j.tenant_id and id=(j.payload->>'message_id')::uuid)
    order by m.provider_accepted_at desc,m.created_at desc,m.id desc limit 1) then
   return jsonb_build_object('needsPreparation',true,'customerReply','Please review a fresh booking summary before confirming. What date and time should I check?');
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
  if result->>'status'='confirmed' then result:=result||jsonb_build_object('coordination',sms_private.apply_enquiry_outcome(j,sess.enquiry_run_id,'BOOKED')); end if;
 elsif name='request_staff_help' then
  if length(btrim(coalesce(args->>'reason',''))) not between 1 and 1000 then raise exception 'Reason required'; end if;
  if s.mode='shadow' then result:=jsonb_build_object('simulated',true,'customerReply','Shadow: would request staff assistance.');
  else
   insert into public.sms_handoffs(tenant_id,contact_id,ai_job_id,reason) values(j.tenant_id,cid,jid,args->>'reason') on conflict(tenant_id,ai_job_id) do nothing;
   update public.sms_conversations set ai_paused=true where tenant_id=j.tenant_id and id=conv;
   result:=jsonb_build_object('handoff',true,'customerReply','I have passed your request to the team. They can help you from here.');
  end if;
  result:=result||jsonb_build_object('coordination',sms_private.apply_enquiry_outcome(j,rid,'STAFF_HANDOFF'));
 end if;
 insert into sms_private.inbound_ai_actions(job_id,action_key,name,arguments,result) values(jid,key,name,args,result);
 return result;
end $$;

create or replace function sms_private.complete_inbound_ai(jid uuid,token uuid,p jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare j sms_private.jobs; s sms_private.inbound_ai_settings; result jsonb; reply text; action jsonb; conv uuid; coordination jsonb; rid uuid; begin
 perform sms_private.coordination_job_lock(jid);
 j:=sms_private.lease(jid,token);
 if not sms_private.inbound_ai_eligible(j,exists(select from public.sms_handoffs where tenant_id=j.tenant_id and ai_job_id=jid)) then perform sms_private.finish(jid,token,'cancelled','STALE_INBOUND'); return null; end if;
 select * into strict s from sms_private.inbound_ai_settings where tenant_id=j.tenant_id;
 conv:=(j.payload->>'conversation_id')::uuid;
 coordination:=sms_private.inbound_automation_context(j);
 rid:=(coordination->>'associatedRequestRef')::uuid;
 select a.result into action from sms_private.inbound_ai_actions a where job_id=jid and a.result ? 'customerReply' order by created_at desc limit 1;
 reply:=coalesce(action->>'customerReply',p->>'reply');
 if length(btrim(coalesce(reply,''))) not between 1 and 600 then raise exception 'Invalid reply'; end if;
 -- Statements about completed actions are only rendered from transactional tool results.
 if action is null and (reply ~* '\m(booked|confirmed|reserved|cancelled|rescheduled|paid|guaranteed)\M' or reply ~* '(I (have )?(stopped|closed|paused|resumed)|follow.?ups (have been|are) (stopped|closed|paused|resumed))') then
  reply:='I can check your appointment or help you book. What would you like to do?';
 end if;
 coordination:=jsonb_build_object('requestRef',case when action ? 'coordination' then action->'coordination'->>'requestRef' else rid::text end,
  'title',(select f.title from sms_private.form_runs r join public.sms_web_form_definitions f on f.tenant_id=r.tenant_id and f.public_id=r.form_id
   where r.tenant_id=j.tenant_id and r.id=case when action ? 'coordination' then (action->'coordination'->>'requestRef')::uuid else rid end),
  'quietUntil',coordination->'quietUntil','reason',coalesce(action->'coordination'->>'reason',case when coordination->>'needsClarification'='true' then 'NEEDS_CLARIFICATION' else 'CONVERSATION' end),'simulated',s.mode='shadow');
 insert into sms_private.inbound_ai_runs(job_id,tenant_id,mode,result) values(jid,j.tenant_id,s.mode,p||jsonb_build_object('reply',reply,'coordination',coordination)) on conflict(job_id) do nothing;
 if s.mode='live' then
  if s.coordination_enabled and rid is not null and action is null then
   insert into sms_private.inbound_ai_sessions(tenant_id,conversation_id,enquiry_run_id) values(j.tenant_id,conv,rid)
   on conflict(tenant_id,conversation_id) do update set enquiry_run_id=excluded.enquiry_run_id;
  end if;
  result:=sms_private.outbox(j.tenant_id,'sms-agent-v1:'||jid,jsonb_build_object('phone',j.payload->>'phone','body',reply,'purpose','transactional',
   'category_id',(select group_id from public.sms_conversations where tenant_id=j.tenant_id and id=conv),'conversation_id',conv,
   'agent_version','sms-agent-v1','agent_job_id',jid));
  update sms_private.inbound_ai_sessions set summary_message_id=(result->>'messageId')::uuid where tenant_id=j.tenant_id and conversation_id=conv and summary=reply;
  update public.sms_messages set meta=meta||jsonb_build_object('agent_version','sms-agent-v1','agent_job_id',jid,'enquiry_run_id',coordination->>'requestRef') where tenant_id=j.tenant_id and id=(result->>'messageId')::uuid;
  if action->>'handoff'='true' then update public.sms_conversations set ai_paused=true where tenant_id=j.tenant_id and id=conv; end if;
 end if;
 perform sms_private.finish(jid,token,'completed'); return result;
end $$;

create or replace function sms_private.fail_inbound_ai(jid uuid,token uuid,p jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare j sms_private.jobs; result jsonb; begin
 perform sms_private.coordination_job_lock(jid);
 j:=sms_private.lease(jid,token);
 if not sms_private.inbound_ai_eligible(j) then perform sms_private.finish(jid,token,'cancelled','STALE_INBOUND'); return null; end if;
 select a.result into result from sms_private.inbound_ai_actions a where job_id=jid and (name='confirm_booking' and a.result->>'status'='confirmed' or name='close_enquiry') limit 1;
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
  perform sms_private.apply_enquiry_outcome(j,sms_private.inbound_enquiry_ref(j,null),'STAFF_HANDOFF');
  update public.sms_conversations set ai_paused=true where tenant_id=j.tenant_id and id=(j.payload->>'conversation_id')::uuid;
 end if;
 return result;
end $$;

create or replace function sms_private.enqueue_due_automations() returns integer
language plpgsql security definer set search_path='' as $$
declare r record; n integer:=0; begin
  for r in select e.* from sms_private.form_runs e join public.sms_businesses b on b.tenant_id=e.tenant_id
    left join sms_private.form_sequences s on s.tenant_id=e.tenant_id and s.form_id=e.form_id
    join public.sms_web_form_definitions f on f.tenant_id=e.tenant_id and f.public_id=e.form_id
    where (e.appointment_at is not null or sms_private.form_run_sequence(e)->>'replyPolicy'<>'continue' or coalesce(sms_private.enquiry_quiet_until(e.tenant_id,e.phone),now())<=now()) and e.status='active' and e.next_run_at<=now() and b.sending_enabled and b.status='active'
      and (e.test_sequence is not null or s.enabled and f.enabled) and not f.archived
      and not exists(select from sms_private.jobs j where j.tenant_id=e.tenant_id and j.queue='automation_jobs'
        and j.dedupe_key='form:'||e.id||':'||e.generation||':'||e.send_index)
    order by e.next_run_at,e.id limit (select scheduler_batch_size from sms_private.runtime)
  loop
    perform sms_private.enqueue(r.tenant_id,'automation_jobs','form:'||r.id||':'||r.generation||':'||r.send_index,
      jsonb_build_object('form_run_id',r.id,'generation',r.generation,'send_index',r.send_index)); n:=n+1;
  end loop;
  return n;
end $$;


alter function sms_private.record_webhook(text,text,jsonb) rename to record_webhook_before_coordination;
create function sms_private.record_webhook(t text,event text,p jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$ declare ph text; begin
 ph:=case when event='inbound' then p->>'From' else (select contact_phone from public.sms_messages where tenant_id=t and sid=p->>'MessageSid' limit 1) end;
 perform sms_private.coordination_lock(t,ph);
 return sms_private.record_webhook_before_coordination(t,event,p);
end $$;

alter function sms_private.process_form_automation(uuid,uuid) rename to process_form_automation_before_coordination;
create function sms_private.process_form_automation(jid uuid,token uuid) returns jsonb
language plpgsql security definer set search_path='' as $$ declare j sms_private.jobs; begin
 perform sms_private.coordination_job_lock(jid);
 j:=sms_private.lease(jid,token);
 if j.queue<>'automation_jobs' then raise exception 'Wrong queue'; end if;
 if sms_private.defer_enquiry_job(j,token,(j.payload->>'form_run_id')::uuid) then return null; end if;
 return sms_private.process_form_automation_before_coordination(jid,token);
end $$;

alter function sms_private.begin_submission(uuid,uuid) rename to begin_submission_before_coordination;
create function sms_private.begin_submission(jid uuid,token uuid) returns jsonb
language plpgsql security definer set search_path='' as $$ declare j sms_private.jobs; begin
 perform sms_private.coordination_job_lock(jid);
 j:=sms_private.lease(jid,token);
 if j.queue<>'sms_send_jobs' then raise exception 'Wrong queue'; end if;
 if j.payload->'request' ? 'form_run_id' and sms_private.defer_enquiry_job(j,token,(j.payload->'request'->>'form_run_id')::uuid) then return null; end if;
 return sms_private.begin_submission_before_coordination(jid,token);
end $$;

alter function sms_private.accept_submission(uuid,uuid,uuid,text) rename to accept_submission_before_coordination;
create function sms_private.accept_submission(jid uuid,token uuid,aid uuid,s text) returns void
language plpgsql security definer set search_path='' as $$ begin
 perform sms_private.coordination_job_lock(jid);
 perform sms_private.accept_submission_before_coordination(jid,token,aid,s);
end $$;

-- Existing settings endpoint exposes coordination status; only an operator can
-- change the rollout switch. Mode=off also disables deferral/outcome writes.
alter function sms_private.inbound_ai_settings_api(text,text,jsonb) rename to inbound_ai_settings_api_before_coordination;
create function sms_private.inbound_ai_settings_api(u text,t text,p jsonb default null) returns jsonb
language plpgsql security definer set search_path='' as $$ declare result jsonb; begin
 result:=sms_private.inbound_ai_settings_api_before_coordination(u,t,p);
 return result||jsonb_build_object('coordinationEnabled',(select coordination_enabled from sms_private.inbound_ai_settings where tenant_id=t),
  'coordination',coalesce((select jsonb_agg(x) from (
   select r.id as "requestRef",f.title,r.status,r.reason,sms_private.enquiry_quiet_until(t,r.phone,true) as "quietUntil",
    exists(select from sms_private.inbound_ai_sessions s where s.tenant_id=t and s.enquiry_run_id=r.id) as associated
   from sms_private.form_runs r join public.sms_web_form_definitions f on f.tenant_id=r.tenant_id and f.public_id=r.form_id
   where r.tenant_id=t and r.appointment_at is null and r.status in ('active','paused')
    and sms_private.form_run_sequence(r)->>'trigger'='submission'
   order by r.created_at desc limit 30)x),'[]'));
end $$;

-- Replaced functions keep their earlier grants. Renamed wrappers and every new
-- helper are private; role access is restored only for the authorized entrypoints.
do $$ declare f record; begin
 for f in select p.oid::regprocedure signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='sms_private'
  and (p.proname in ('coordination_lock','coordination_job_lock','enquiry_quiet_until','inbound_automation_context','inbound_enquiry_ref','apply_enquiry_outcome','defer_enquiry_job',
    'record_webhook','process_form_automation','begin_submission','accept_submission','inbound_ai_settings_api') or p.proname like '%_before_coordination') loop
  execute format('revoke all on function %s from public,anon,authenticated,sms_api,sms_ai,sms_webhook,sms_sender,sms_automation',f.signature);
 end loop;
end $$;
grant execute on function sms_private.record_webhook(text,text,jsonb) to sms_webhook;
grant execute on function sms_private.process_form_automation(uuid,uuid) to sms_automation;
grant execute on function sms_private.begin_submission(uuid,uuid),sms_private.accept_submission(uuid,uuid,uuid,text) to sms_sender;
grant execute on function sms_private.inbound_ai_settings_api(text,text,jsonb) to sms_api;
