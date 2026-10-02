-- A new Quote Request starts today within the business send window. Keep
-- customized groups and the due times already saved on enrollments intact.
update public.sms_automation_groups
set rule=jsonb_set(rule,'{firstDelayCount}','0'::jsonb),
    version=version+1,updated_at=now()
where fixed_type='quote_requests'
  and rule='{"anchor":"enrollment","firstDelayCount":1,"firstDelayUnit":"day","intervalCount":2,"intervalUnit":"day","repeatCount":6,"leadHours":null,"startHour":9,"endHour":19}'::jsonb;

create or replace function sms_private.seed_fixed_automation_groups(t text) returns void
language plpgsql security definer set search_path='' as $$
begin
  insert into public.sms_automation_groups(tenant_id,id,name,description,kind,fixed_type,rule)
  values
    (t,'sms-contact','Contact','New SMS lead follow-up','contact','contacts',
      '{"anchor":"enrollment","firstDelayCount":1,"firstDelayUnit":"day","intervalCount":1,"intervalUnit":"day","repeatCount":1,"leadHours":null,"startHour":9,"endHour":19}'::jsonb),
    (t,'quote-requests','Quote Request','Follow up on a quote inquiry','quote','quote_requests',
      '{"anchor":"enrollment","firstDelayCount":0,"firstDelayUnit":"day","intervalCount":2,"intervalUnit":"day","repeatCount":6,"leadHours":null,"startHour":9,"endHour":19}'::jsonb),
    (t,'appointment-reminders','Bookings','Confirmed appointment reminder','reminder','bookings',
      '{"anchor":"appointment","firstDelayCount":0,"firstDelayUnit":"day","intervalCount":6,"intervalUnit":"hour","repeatCount":1,"leadHours":24,"startHour":0,"endHour":24}'::jsonb),
    (t,'sms-review','Reviews','Post-service feedback request','review','reviews',
      '{"anchor":"enrollment","firstDelayCount":1,"firstDelayUnit":"day","intervalCount":1,"intervalUnit":"day","repeatCount":1,"leadHours":null,"startHour":9,"endHour":19}'::jsonb)
  on conflict(tenant_id,id) do nothing;
  insert into public.sms_automation_intents(tenant_id,group_id,intent)
  select t,g.id,case g.fixed_type
    when 'contacts' then 'Help the customer take the next useful step with their new inquiry. Acknowledge what they asked for without assuming a quote or booking exists.'
    when 'quote_requests' then 'Acknowledge the quote request, clarify any missing details, and help the customer toward an estimate or decision. Never claim a quote was issued unless the record or conversation confirms it.'
    when 'bookings' then 'Remind the customer of their confirmed appointment using its actual local date and time, and invite a reply if rescheduling is needed.'
    when 'reviews' then 'Ask about the completed service and invite honest feedback. Use an approved review URL if supplied; otherwise invite a reply. Do not assume satisfaction.' end
  from public.sms_automation_groups g where g.tenant_id=t and g.fixed_type is not null
  on conflict(tenant_id,group_id) do nothing;
end $$;
