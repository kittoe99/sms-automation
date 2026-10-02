-- Make quote follow-ups progressive, explicitly event-triggered, and AI-drafted.
-- Existing enrollments keep their schedule and pick up the new group version.
update public.sms_automation_groups
set rule = rule || jsonb_build_object(
      'trigger', 'quote.created',
      'aiDraft', true,
      'startHour', coalesce((rule->>'startHour')::integer, 9),
      'endHour', coalesce((rule->>'endHour')::integer, 19),
      'steps', jsonb_build_array(
        jsonb_build_object('id','send-1','delayCount',1,'delayUnit','day','template','Hi {{first_name}}, thanks for requesting a quote from {{business_name}}. Do you have any questions about the estimate or what is included? Reply STOP to opt out.'),
        jsonb_build_object('id','send-2','delayCount',1,'delayUnit','day','template','Hi {{first_name}}, checking in on your quote. Has anything changed with the scope, timing, or details we should know about? Reply STOP to opt out.'),
        jsonb_build_object('id','send-3','delayCount',1,'delayUnit','day','template','Hi {{first_name}}, if you are ready to move forward with your quote, reply with the day or time that works best and we can help with the next step. Reply STOP to opt out.'),
        jsonb_build_object('id','send-4','delayCount',2,'delayUnit','day','template','Hi {{first_name}}, are you still considering the quote from {{business_name}}? If a question or concern is holding things up, reply here and we will help. Reply STOP to opt out.'),
        jsonb_build_object('id','send-5','delayCount',2,'delayUnit','day','template','Hi {{first_name}}, if your plans or project details changed, reply and we can review the quote with you before you decide. Reply STOP to opt out.'),
        jsonb_build_object('id','send-6','delayCount',7,'delayUnit','day','template','Hi {{first_name}}, this is our final quote follow-up for now. We will close the reminder sequence, but you can reply anytime if you would like to revisit it. Reply STOP to opt out.')
      )
    ),
    version = version + 1,
    updated_at = now()
where kind = 'quote' or id = 'quote-requests';

delete from public.sms_automation_steps
where (tenant_id, group_id) in (
  select tenant_id, id from public.sms_automation_groups where kind = 'quote' or id = 'quote-requests'
);

insert into public.sms_automation_steps(tenant_id, group_id, step_index, template, delay_count, delay_unit)
select g.tenant_id, g.id, s.step_index, s.template, s.delay_count, 'day'
from public.sms_automation_groups g
cross join (values
  (0, 'Hi {{first_name}}, thanks for requesting a quote from {{business_name}}. Do you have any questions about the estimate or what is included? Reply STOP to opt out.', 1),
  (1, 'Hi {{first_name}}, checking in on your quote. Has anything changed with the scope, timing, or details we should know about? Reply STOP to opt out.', 1),
  (2, 'Hi {{first_name}}, if you are ready to move forward with your quote, reply with the day or time that works best and we can help with the next step. Reply STOP to opt out.', 1),
  (3, 'Hi {{first_name}}, are you still considering the quote from {{business_name}}? If a question or concern is holding things up, reply here and we will help. Reply STOP to opt out.', 2),
  (4, 'Hi {{first_name}}, if your plans or project details changed, reply and we can review the quote with you before you decide. Reply STOP to opt out.', 2),
  (5, 'Hi {{first_name}}, this is our final quote follow-up for now. We will close the reminder sequence, but you can reply anytime if you would like to revisit it. Reply STOP to opt out.', 7)
) as s(step_index, template, delay_count)
where g.kind = 'quote' or g.id = 'quote-requests';

create or replace function sms_private.job_context(jid uuid,token uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
#variable_conflict use_column
declare j sms_private.jobs; e public.sms_automation_enrollments; c public.sms_contacts; ph text;
begin
 j:=sms_private.lease(jid,token);
 if j.queue='automation_jobs' then
   select * into e from public.sms_automation_enrollments where tenant_id=j.tenant_id and id=(j.payload->>'enrollment_id')::uuid;
   select * into c from public.sms_contacts where tenant_id=j.tenant_id and id=e.contact_id;
   return jsonb_build_object(
     'enrollment',to_jsonb(e),
     'contact',to_jsonb(c),
     'business',(select to_jsonb(b) from public.sms_businesses b where tenant_id=j.tenant_id),
     'profile',(select to_jsonb(v) from public.sms_business_profile_versions v join public.sms_businesses b on b.tenant_id=v.tenant_id and b.active_profile_version_id=v.id where v.tenant_id=j.tenant_id and v.status='approved'),
     'group',(select to_jsonb(g) from public.sms_automation_groups g where tenant_id=j.tenant_id and id=e.category_id),
     'settings',(select to_jsonb(a) from public.sms_ai_settings a where tenant_id=j.tenant_id and group_id=e.category_id),
     'history',(select coalesce(jsonb_agg(m order by created_at),'[]'::jsonb) from (select direction,body,created_at from public.sms_messages where tenant_id=j.tenant_id and contact_phone=c.phone order by created_at)m),
     'steps',(select jsonb_agg(s order by step_index) from public.sms_automation_steps s where tenant_id=j.tenant_id and group_id=e.category_id));
 elsif j.queue='ai_reply_jobs' then
   ph:=j.payload->>'phone';
   select * into c from public.sms_contacts where tenant_id=j.tenant_id and phone=ph;
   return jsonb_build_object(
     'business',(select to_jsonb(b) from public.sms_businesses b where tenant_id=j.tenant_id),
     'profile',(select to_jsonb(v) from public.sms_business_profile_versions v join public.sms_businesses b on b.tenant_id=v.tenant_id and b.active_profile_version_id=v.id where v.tenant_id=j.tenant_id and v.status='approved'),
     'contact',to_jsonb(c),
     'thread',(select to_jsonb(th) from public.sms_thread_contacts th where tenant_id=j.tenant_id and phone=ph),
     'settings',(select to_jsonb(a) from public.sms_ai_settings a where tenant_id=j.tenant_id and group_id=j.payload->>'group_id'),
     'open_lead',(select to_jsonb(l) from public.sms_leads l where l.tenant_id=j.tenant_id and l.contact_id=c.id and l.status in ('open','assigned') order by l.updated_at desc limit 1),
     'booking_settings',(select to_jsonb(s) from public.sms_booking_settings s where s.tenant_id=j.tenant_id and s.enabled),
     'booking_session',(select to_jsonb(s) from public.sms_booking_sessions s where s.tenant_id=j.tenant_id and s.contact_id=c.id and s.expires_at>now()),
     'history',(select coalesce(jsonb_agg(m order by created_at),'[]') from (select id,direction,body,created_at from public.sms_messages where tenant_id=j.tenant_id and contact_phone=ph order by created_at desc limit 20)m));
 elsif j.queue='provisioning_jobs' then
   return (select jsonb_build_object('account_sid',p.account_sid,'messaging_service_sid',p.messaging_service_sid,'phone_number_sid',p.phone_number_sid,'state',p.provisioning_state,'business_name',b.name) from sms_private.providers p join public.sms_businesses b using(tenant_id) where p.tenant_id=j.tenant_id);
 end if;
 raise exception 'Unsupported context';
end $$;

revoke all on function sms_private.job_context(uuid,uuid) from public,anon,authenticated,sms_api,sms_webhook,sms_sender,sms_ai,sms_automation;
grant execute on function sms_private.job_context(uuid,uuid) to sms_automation,sms_ai;
