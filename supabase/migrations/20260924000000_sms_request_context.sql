-- Keep a newly submitted quote separate from older phone-based booking state.
create function sms_private.clear_conflicting_booking_draft() returns trigger
language plpgsql security definer set search_path='' as $$
declare draft public.sms_booking_sessions;
begin
  select s.* into draft from public.sms_booking_sessions s
    join public.sms_contacts c on c.tenant_id=s.tenant_id and c.id=s.contact_id
    where s.tenant_id=new.tenant_id and c.phone=new.phone and s.expires_at>now();
  if found and (
    (nullif(lower(btrim(new.name)),'') is not null and nullif(lower(btrim(draft.customer_name)),'') is not null
      and lower(btrim(new.name))<>lower(btrim(draft.customer_name)))
    or (nullif(lower(btrim(new.details->>'service_address')),'') is not null
      and nullif(lower(btrim(draft.service_address)),'') is not null
      and lower(btrim(new.details->>'service_address'))<>lower(btrim(draft.service_address)))
  ) then
    delete from public.sms_booking_sessions where tenant_id=draft.tenant_id and contact_id=draft.contact_id;
  end if;
  return new;
end $$;
create trigger sms_quote_clear_conflicting_draft after insert on public.sms_automation_quote_requests
  for each row execute function sms_private.clear_conflicting_booking_draft();
revoke all on function sms_private.clear_conflicting_booking_draft()
  from public,anon,authenticated,sms_api,sms_webhook,sms_sender,sms_automation,sms_ai;

alter function sms_private.job_context(uuid,uuid) rename to job_context_before_request_context;
revoke all on function sms_private.job_context_before_request_context(uuid,uuid)
  from public,anon,authenticated,sms_api,sms_webhook,sms_sender,sms_automation,sms_ai;
create function sms_private.job_context(jid uuid,token uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare base jsonb; j sms_private.jobs; active_request jsonb; recent_booking jsonb;
begin
  base:=sms_private.job_context_before_request_context(jid,token);
  select * into j from sms_private.jobs where id=jid;
  if j.queue<>'ai_reply_jobs' then return base; end if;
  select to_jsonb(i) into active_request
    from public.sms_automation_enrollments e
    join public.sms_automation_quote_requests i on i.tenant_id=e.tenant_id and i.id=e.source_id
    join public.sms_contacts c on c.tenant_id=e.tenant_id and c.id=e.contact_id
    where e.tenant_id=j.tenant_id and c.phone=j.payload->>'phone'
      and e.source_type='quote_requests' and e.status='active'
    order by i.created_at desc,i.id desc limit 1;
  select jsonb_build_object('id',b.id,'customer_name',b.customer_name,
      'service_address',b.service_address,'appointment_at',b.appointment_at,'status',b.status)
    into recent_booking from public.sms_bookings b
    join public.sms_contacts c on c.tenant_id=b.tenant_id and c.id=b.contact_id
    where b.tenant_id=j.tenant_id and c.phone=j.payload->>'phone'
      and b.status='confirmed'
    order by b.updated_at desc,b.id desc limit 1;
  return base||jsonb_build_object('active_request',active_request,'recent_booking',recent_booking);
end $$;
revoke all on function sms_private.job_context(uuid,uuid)
  from public,anon,authenticated,sms_api,sms_webhook,sms_sender,sms_automation,sms_ai;
grant execute on function sms_private.job_context_before_request_context(uuid,uuid),
  sms_private.job_context(uuid,uuid) to sms_automation,sms_ai;

