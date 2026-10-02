-- Brand and service-ground every AI-enabled automation fallback. Appointment
-- reminders remain deterministic and never call the AI drafter.
update public.sms_automation_groups
set rule = rule || jsonb_build_object('aiDraft', false),
    version = version + 1,
    updated_at = now()
where kind = 'reminder' or id = 'appointment-reminders';

update public.sms_automation_groups
set rule = rule || jsonb_build_object(
      'trigger', 'quote.created',
      'aiDraft', true,
      'steps', jsonb_build_array(
        jsonb_build_object('id','send-1','delayCount',1,'delayUnit','day','template','Hi {{first_name}}, thanks for requesting a {{service_name}} quote from {{business_name}}. Do you have questions about the estimate or what is included? Reply STOP to opt out.'),
        jsonb_build_object('id','send-2','delayCount',1,'delayUnit','day','template','Hi {{first_name}}, {{business_name}} checking in on your {{service_name}} quote. Has anything changed with the scope, timing, or details? Reply STOP to opt out.'),
        jsonb_build_object('id','send-3','delayCount',1,'delayUnit','day','template','Hi {{first_name}}, if you are ready to move forward with your {{service_name}} quote from {{business_name}}, reply with the day or time that works best. Reply STOP to opt out.'),
        jsonb_build_object('id','send-4','delayCount',2,'delayUnit','day','template','Hi {{first_name}}, are you still considering the {{service_name}} quote from {{business_name}}? Reply with any question or concern holding things up. Reply STOP to opt out.'),
        jsonb_build_object('id','send-5','delayCount',2,'delayUnit','day','template','Hi {{first_name}}, {{business_name}} here about your {{service_name}} quote. If your plans or project details changed, reply and we can review it with you. Reply STOP to opt out.'),
        jsonb_build_object('id','send-6','delayCount',7,'delayUnit','day','template','Hi {{first_name}}, final follow-up from {{business_name}} about your {{service_name}} quote. We will close this sequence, but you can reply anytime to revisit it. Reply STOP to opt out.')
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
  (0, 'Hi {{first_name}}, thanks for requesting a {{service_name}} quote from {{business_name}}. Do you have questions about the estimate or what is included? Reply STOP to opt out.', 1),
  (1, 'Hi {{first_name}}, {{business_name}} checking in on your {{service_name}} quote. Has anything changed with the scope, timing, or details? Reply STOP to opt out.', 1),
  (2, 'Hi {{first_name}}, if you are ready to move forward with your {{service_name}} quote from {{business_name}}, reply with the day or time that works best. Reply STOP to opt out.', 1),
  (3, 'Hi {{first_name}}, are you still considering the {{service_name}} quote from {{business_name}}? Reply with any question or concern holding things up. Reply STOP to opt out.', 2),
  (4, 'Hi {{first_name}}, {{business_name}} here about your {{service_name}} quote. If your plans or project details changed, reply and we can review it with you. Reply STOP to opt out.', 2),
  (5, 'Hi {{first_name}}, final follow-up from {{business_name}} about your {{service_name}} quote. We will close this sequence, but you can reply anytime to revisit it. Reply STOP to opt out.', 7)
) as s(step_index, template, delay_count)
where g.kind = 'quote' or g.id = 'quote-requests';

-- Upgrade existing AI-enabled custom messages that were saved before the
-- contextual presets. User timing and message intent are preserved.
update public.sms_automation_steps s
set template = case
  when s.template ~* '^Hi\s+\{\{first_name\}\},?\s*'
    then regexp_replace(s.template, '^Hi\s+\{\{first_name\}\},?\s*', 'Hi {{first_name}}, {{business_name}} here about your {{service_name}}. ', 'i')
  else '{{business_name}} follow-up about your {{service_name}}: ' || s.template
end
from public.sms_automation_groups g
where g.tenant_id = s.tenant_id
  and g.id = s.group_id
  and g.kind = 'custom'
  and coalesce((g.rule->>'aiDraft')::boolean, true)
  and s.template not like '%{{business_name}}%'
  and s.template not like '%{{service_name}}%';

update public.sms_automation_groups g
set rule = jsonb_set(
      jsonb_set(g.rule, '{steps}', coalesce((
        select jsonb_agg(jsonb_build_object(
          'id', 'send-' || (s.step_index + 1),
          'template', s.template,
          'delayCount', s.delay_count,
          'delayUnit', s.delay_unit
        ) order by s.step_index)
        from public.sms_automation_steps s
        where s.tenant_id = g.tenant_id and s.group_id = g.id
      ), '[]'::jsonb)),
      '{template}',
      to_jsonb(coalesce((
        select s.template from public.sms_automation_steps s
        where s.tenant_id = g.tenant_id and s.group_id = g.id
        order by s.step_index limit 1
      ), ''))
    ),
    version = version + 1,
    updated_at = now()
where g.kind = 'custom'
  and coalesce((g.rule->>'aiDraft')::boolean, true);
