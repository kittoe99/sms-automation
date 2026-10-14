-- CRM-only forward migration. Requires direct_contact_automations and the paired
-- October 14 queue/reporting baseline. No E2 schema change; do not replay history.
-- SMS history is shared only within the verified business and phone identity.
create or replace function sms_private.inbound_ai_context(jid uuid,token uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare j sms_private.jobs; result jsonb; begin
 perform sms_private.coordination_job_lock(jid);
 j:=sms_private.lease(jid,token);
 if not sms_private.inbound_ai_eligible(j,exists(select from public.sms_handoffs where tenant_id=j.tenant_id and ai_job_id=jid)) then return null; end if;
 select jsonb_build_object('settings',to_jsonb(s),'business',jsonb_build_object('name',b.name,'timeZone',b.time_zone),
  'profile',(select v.facts from public.sms_business_profile_versions v where v.tenant_id=b.tenant_id and v.id=b.active_profile_version_id and v.status='approved'),
  'latestMessage',(select body from public.sms_messages where tenant_id=j.tenant_id and id=(j.payload->>'message_id')::uuid),
  'history',coalesce((select jsonb_agg(x order by x.occurred_at,x.id) from (
   select * from (
    (select m.id,m.direction,m.body,m.created_at,m.created_at as occurred_at
     from public.sms_messages m
     where m.tenant_id=j.tenant_id and m.contact_phone=j.payload->>'phone' and m.direction='inbound'
      and m.created_at <= (select created_at from public.sms_messages where tenant_id=j.tenant_id and id=(j.payload->>'message_id')::uuid)
     order by m.created_at desc,m.id desc limit 30)
    union all
    (select m.id,m.direction,m.body,m.created_at,m.provider_accepted_at as occurred_at
     from public.sms_messages m
     where m.tenant_id=j.tenant_id and m.contact_phone=j.payload->>'phone' and m.direction='outbound'
      and m.provider_accepted_at is not null
      and m.provider_accepted_at <= (select created_at from public.sms_messages where tenant_id=j.tenant_id and id=(j.payload->>'message_id')::uuid)
     order by m.provider_accepted_at desc,m.id desc limit 30)
   ) recent order by occurred_at desc,id desc limit 30)x),'[]'),
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

-- Both form and direct enquiry follow-ups respect the customer's latest reply,
-- including when AI is off or in review mode. Appointment policies are unchanged.
create or replace function sms_private.run_quiet_until(r sms_private.form_runs) returns timestamptz
language plpgsql security definer set search_path='' as $$
declare due timestamptz; begin
 if r.appointment_at is not null or sms_private.form_run_sequence(r)->>'trigger'<>'submission' then return null; end if;
 select max(case when direction='inbound' then created_at else provider_accepted_at end)+interval '30 minutes' into due
 from public.sms_messages where tenant_id=r.tenant_id and contact_phone=r.phone
  and (direction='inbound' or provider_accepted_at is not null and meta->>'agent_version'='sms-agent-v1');
 return greatest(due,sms_private.enquiry_quiet_until(r.tenant_id,r.phone));
end $$;

-- The existing business reply mode also enables automation context/coordination.
-- Preserve approval, authorization, revision checks, and every current mode.
alter function sms_private.inbound_ai_settings_api(text,text,jsonb) rename to inbound_ai_settings_api_before_unified_sms;
create function sms_private.inbound_ai_settings_api(u text,t text,p jsonb default null) returns jsonb
language plpgsql security definer set search_path='' as $$
declare result jsonb; begin
 result:=sms_private.inbound_ai_settings_api_before_unified_sms(u,t,p);
 if p is not null and p->>'mode' in ('shadow','live') then
  update sms_private.inbound_ai_settings set coordination_enabled=true where tenant_id=t and not coordination_enabled;
  result:=sms_private.inbound_ai_settings_api_before_unified_sms(u,t,null);
 end if;
 return result||jsonb_build_object('replyScope','all_sms','followupWaitMinutes',30);
end $$;
update sms_private.inbound_ai_settings set coordination_enabled=true,revision=revision+1,updated_at=now()
 where mode in ('shadow','live') and not coordination_enabled;
revoke all on function sms_private.inbound_ai_settings_api_before_unified_sms(text,text,jsonb),
 sms_private.inbound_ai_settings_api(text,text,jsonb) from public,anon,authenticated,sms_api,sms_ai,sms_webhook,sms_sender,sms_automation;
grant execute on function sms_private.inbound_ai_settings_api(text,text,jsonb) to sms_api;
-- Replaced context and quiet-time helpers retain their existing scoped grants.
