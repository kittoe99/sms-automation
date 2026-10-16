-- CRM-owned forward integration of the unshipped 20261016035447 AI defaults change.
-- Apply after crm_mcp_ai_reply_diagnostics; no E2 dashboard migration is needed.
-- Preserves unified Business Info, instant acknowledgments, readiness and audit checks.
alter table sms_private.inbound_ai_settings alter column mode set default 'live';
alter table sms_private.inbound_ai_settings alter column coordination_enabled set default true;
alter table sms_private.inbound_ai_settings alter column system_prompt
 set default 'Help customers using approved business information. Ask for clarification when information is missing.';

-- Only untouched defaults are upgraded. Explicit Off/Review choices survive.
update sms_private.inbound_ai_settings set mode='live',coordination_enabled=true,
 system_prompt='Help customers using approved business information. Ask for clarification when information is missing.',
 revision=revision+1,updated_at=now()
 where mode='off' and revision=0 and system_prompt='' and live_validated_at is null;

-- JSON sequence snapshots already persist through drafts, presets, publication
-- and enrollment. Missing means on; false must remain a boolean, never a string.
alter function sms_private.validate_form_sequence(jsonb,jsonb,boolean) rename to validate_form_sequence_before_ai_defaults;
create function sms_private.validate_form_sequence(s jsonb,fields jsonb,booking boolean) returns void
language plpgsql set search_path='' as $$ begin
 if s ? 'aiRepliesEnabled' and jsonb_typeof(s->'aiRepliesEnabled') is distinct from 'boolean' then
  raise exception 'AI replies must be on or off' using errcode='22023';
 end if;
 perform sms_private.validate_form_sequence_before_ai_defaults(s,fields,booking);
end $$;

-- SMS has no reply-to identifier. Honor any current overlapping opt-out rather
-- than guessing which automation the customer means. The last accepted outbound
-- also protects replies to completed/Stop-on-reply runs; queued sends don't count.
create function sms_private.automation_ai_replies_allowed(t text,ph text) returns boolean
language plpgsql stable security definer set search_path='' as $$
declare last_meta jsonb; begin
 if exists(select from sms_private.form_runs r where r.tenant_id=t and r.phone=ph
  and r.status in ('active','paused') and r.test_sequence is null
  and sms_private.form_run_sequence(r)->'aiRepliesEnabled'='false'::jsonb) then return false; end if;
 select m.meta into last_meta from public.sms_messages m
 where m.tenant_id=t and m.contact_phone=ph and m.direction='outbound' and m.provider_accepted_at is not null
 order by m.provider_accepted_at desc,m.id desc limit 1;
 return not exists(select from sms_private.form_runs r where r.tenant_id=t and r.phone=ph
  and r.id::text=last_meta->>'form_run_id' and sms_private.form_run_sequence(r)->'aiRepliesEnabled'='false'::jsonb);
end $$;

-- Keep all existing revision, STOP, takeover, generation and sending fences.
-- The same eligibility function is used by tools, completion and provider send.
alter function sms_private.inbound_ai_eligible(sms_private.jobs,boolean) rename to inbound_ai_eligible_before_ai_defaults;
create function sms_private.inbound_ai_eligible(j sms_private.jobs,allow_paused boolean default false) returns boolean
language plpgsql security definer set search_path='' as $$ begin
 return sms_private.inbound_ai_eligible_before_ai_defaults(j,allow_paused)
  and sms_private.automation_ai_replies_allowed(j.tenant_id,j.payload->>'phone');
end $$;

-- The original producer is called inside the phone-locking/normalizing wrappers.
-- Lazily initialize missing settings on a real inbound text, not business creation.
create or replace function sms_private.record_webhook_before_coordination(t text,event text,p jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare result jsonb; m public.sms_messages; c public.sms_conversations; th public.sms_thread_contacts; s sms_private.inbound_ai_settings; begin
 result:=sms_private.record_webhook_before_inbound_agent(t,event,p);
 if event<>'inbound' or coalesce((result->>'duplicate')::boolean,false) or coalesce((result->>'consent_event')::boolean,false) then return result; end if;
 insert into sms_private.inbound_ai_settings(tenant_id) values(t) on conflict do nothing;
 select * into s from sms_private.inbound_ai_settings where tenant_id=t;
 if s.mode='off' then return result; end if;
 select * into strict m from public.sms_messages where tenant_id=t and sid=p->>'MessageSid';
 select * into strict c from public.sms_conversations where tenant_id=t and id=m.conversation_id for update;
 update public.sms_thread_contacts set generation=generation+1 where tenant_id=t and phone=m.contact_phone returning * into th;
 if lower(btrim(m.body)) !~ '^(yes|y|confirm|book it|yes please|looks good)[.!]?$' and s.mode='live' then
  update sms_private.inbound_ai_sessions set hold_id=null,summary_message_id=null where tenant_id=t and conversation_id=c.id;
 end if;
 update sms_private.jobs set status='cancelled',error_code='SUPERSEDED_INBOUND',leased_until=null
  where tenant_id=t and queue='ai_reply_jobs' and payload->>'phone'=m.contact_phone and status in ('queued','retry');
 if not c.ai_paused and not th.ai_paused and not exists(select from public.sms_contacts where tenant_id=t and phone=m.contact_phone and opted_out)
  and sms_private.automation_ai_replies_allowed(t,m.contact_phone) then
  perform sms_private.enqueue_before_form_sequences(t,'ai_reply_jobs','sms-agent-v1:'||m.sid,jsonb_build_object(
   'agent_version','sms-agent-v1','phone',m.contact_phone,'message_id',m.id,'conversation_id',c.id,
   'generation',th.generation,'conversation_generation',c.generation,'settings_revision',s.revision),now()+interval '2 seconds');
 end if;
 return result;
end $$;

revoke all on function sms_private.validate_form_sequence(jsonb,jsonb,boolean),
 sms_private.validate_form_sequence_before_ai_defaults(jsonb,jsonb,boolean),
 sms_private.automation_ai_replies_allowed(text,text),
 sms_private.inbound_ai_eligible(sms_private.jobs,boolean),
 sms_private.inbound_ai_eligible_before_ai_defaults(sms_private.jobs,boolean),
 sms_private.record_webhook_before_coordination(text,text,jsonb)
 from public,anon,authenticated,sms_api,sms_ai,sms_webhook,sms_sender,sms_automation;

-- Strict MCP validation and projection retain both optional automation controls.
create or replace function sms_private.mcp_sms_validate_sequence(s jsonb,k text,fields jsonb,preset text) returns void
language plpgsql immutable set search_path='' as $$
declare step jsonb; n text; begin
 if jsonb_typeof(s) is distinct from 'object' then raise exception 'Sequence must be an object'; end if;
 if exists(select from jsonb_object_keys(s) x where not x=any(array['trigger','leadHours','replyPolicy','startHour','endHour','steps','instantAcknowledgment','aiRepliesEnabled']))
  or not s ?& array['trigger','leadHours','replyPolicy','startHour','endHour','steps'] then raise exception 'Invalid sequence fields'; end if;
 foreach n in array array['leadHours','startHour','endHour'] loop
  if jsonb_typeof(s->n) is distinct from 'number' then raise exception 'Sequence timing must use whole numbers'; end if;
  if (s->>n)::numeric<>trunc((s->>n)::numeric) or (s->>n)::numeric not between 0 and 8760 then raise exception 'Invalid sequence timing'; end if;
 end loop;
 if jsonb_typeof(s->'steps') is distinct from 'array' then raise exception 'Messages must be an array'; end if;
 if jsonb_array_length(s->'steps') not between 1 and 50 then raise exception 'Use 1 to 50 messages'; end if;
 for step in select value from jsonb_array_elements(s->'steps') loop
  if jsonb_typeof(step) is distinct from 'object' then raise exception 'Invalid message'; end if;
  if exists(select from jsonb_object_keys(step) x where not x=any(array['body','delayCount','delayUnit','sendCount','intervalCount','intervalUnit'])) then raise exception 'Invalid message fields'; end if;
  foreach n in array array['delayCount','sendCount','intervalCount'] loop
   if jsonb_typeof(step->n) is distinct from 'number' then raise exception 'Message timing must use whole numbers'; end if;
   if (step->>n)::numeric<>trunc((step->>n)::numeric) or (step->>n)::numeric not between 0 and 1000 then raise exception 'Invalid message timing'; end if;
  end loop;
 end loop;
 if k='form' then perform sms_private.validate_form_sequence(s,fields,preset='bookings');
 elsif k='contact' then perform sms_private.direct_validate(s);
 else raise exception 'Invalid automation kind'; end if;
end $$;

create or replace function sms_private.mcp_sms_sequence(s jsonb) returns jsonb
language sql immutable set search_path='' as $$
 select case when s is null or s='{}' then null else jsonb_build_object(
  'aiRepliesEnabled',coalesce(s->'aiRepliesEnabled','true'::jsonb),'trigger',s->'trigger','leadHours',coalesce(s->'leadHours','24'::jsonb),'replyPolicy',s->'replyPolicy',
  'startHour',s->'startHour','endHour',s->'endHour','steps',coalesce((select jsonb_agg(jsonb_build_object(
  'body',v->'body','delayCount',v->'delayCount','delayUnit',v->'delayUnit','sendCount',v->'sendCount',
  'intervalCount',v->'intervalCount','intervalUnit',v->'intervalUnit') order by n)
  from jsonb_array_elements(s->'steps') with ordinality a(v,n)),'[]')) || case when s ? 'instantAcknowledgment' then jsonb_build_object('instantAcknowledgment',s->'instantAcknowledgment') else '{}'::jsonb end end
$$;

