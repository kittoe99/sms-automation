-- CRM-owned document content; existing E2-owned setup revisions, identity,
-- owner/review workflow and customer invalidation remain authoritative.
-- No existing profile, AI mode or messaging configuration is changed here.
create or replace function sms_private.validate_business_facts(input jsonb) returns jsonb
language plpgsql stable set search_path='' as $$
declare services jsonb; locations jsonb; faqs jsonb; pricing jsonb; policies jsonb; result jsonb;
begin
 if coalesce(jsonb_typeof(input),'null')<>'object' then raise exception 'Business facts must be an object'; end if;
 if input ? 'businessInfo' and (jsonb_typeof(input->'businessInfo') is distinct from 'string' or length(btrim(input->>'businessInfo')) not between 1 and 20000) then raise exception 'Business Info must contain 1-20000 characters';end if;
 if length(trim(coalesce(input->>'businessName',''))) not between 1 and 160 then raise exception 'Business name is required'; end if;
 if coalesce(input->>'websiteUrl','')<>'' and coalesce(input->>'websiteUrl','') !~* '^https://[^[:space:]]+$' then raise exception 'Website must start with https://'; end if;
 if coalesce(input->>'contactEmail','')<>'' and input->>'contactEmail' !~* '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then raise exception 'Enter a valid contact email'; end if;
 if trim(coalesce(input->>'summary',''))<>'' and length(trim(input->>'summary')) not between 20 and 2000 then raise exception 'Summary must be 20-2000 characters'; end if;
 if length(trim(coalesce(input->>'hours','')))>200 or length(trim(coalesce(input->>'contactPhone','')))>32 or length(trim(coalesce(input->>'handoff','')))>1000 or length(trim(coalesce(input->>'bookingRules','')))>2000 then raise exception 'A business fact exceeds its allowed length'; end if;
 if coalesce(input->>'tone','')<>'' and input->>'tone' not in ('friendly','professional','casual') then raise exception 'Choose a brand voice'; end if;
 services:=coalesce(input->'services','[]'); locations:=coalesce(input->'locations','[]'); faqs:=coalesce(input->'faqs','[]');
 pricing:=coalesce(input->'pricing','[]'); policies:=coalesce(input->'policies','[]');
 if jsonb_typeof(services)<>'array' or jsonb_array_length(services) not between (case when input ? 'businessInfo' then 0 else 1 end) and 30
   or exists(select from jsonb_array_elements_text(services) s where length(trim(s)) not between 1 and 160) then raise exception 'Add 1-30 services, with no more than 160 characters per service'; end if;
 if jsonb_typeof(locations)<>'array' or jsonb_array_length(locations) not between (case when input ? 'businessInfo' then 0 else 1 end) and 20
   or exists(select from jsonb_array_elements_text(locations) s where length(trim(s)) not between 1 and 160) then raise exception 'Add 1-20 service areas, with no more than 160 characters per area'; end if;
 if jsonb_typeof(faqs)<>'array' or jsonb_array_length(faqs)>20
   or exists(select from jsonb_array_elements_text(faqs) s where length(trim(s)) not between 1 and 300) then raise exception 'Add up to 20 FAQs, with no more than 300 characters each'; end if;
 if jsonb_typeof(pricing)<>'array' or jsonb_array_length(pricing)>200 then raise exception 'Pricing must be a list of at most 200 items'; end if;
 if jsonb_typeof(policies)<>'array' or jsonb_array_length(policies)>100 then raise exception 'Policies must be a list of at most 100 items'; end if;
 result:=input || jsonb_build_object(
   'businessName',trim(input->>'businessName'),'summary',trim(input->>'summary'),'websiteUrl',trim(input->>'websiteUrl'),'hours',trim(input->>'hours'),'contactPhone',trim(input->>'contactPhone'),'contactEmail',lower(trim(input->>'contactEmail')),'bookingRules',trim(input->>'bookingRules'),'handoff',trim(input->>'handoff'),
   'services',(select coalesce(jsonb_agg(trim(s)),'[]') from jsonb_array_elements_text(services) s),
   'locations',(select coalesce(jsonb_agg(trim(s)),'[]') from jsonb_array_elements_text(locations) s),
   'faqs',(select coalesce(jsonb_agg(trim(s)),'[]') from jsonb_array_elements_text(faqs) s where trim(s)<>''),
   'pricing',pricing,'policies',policies,'updatedAt',now());
 return result;
end $$;

-- Replace only the canonical settings implementation; coordination wrappers stay intact.
-- Legacy shadow values remain readable for compatibility; the UI offers on/off.
-- live_validated_at is historical evidence, never fabricated or a pilot-only gate.
create or replace function sms_private.inbound_ai_settings_api_before_coordination(u text,t text,p jsonb default null) returns jsonb
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
   if not exists(select from public.sms_businesses b
    join public.sms_business_profile_versions v on v.tenant_id=b.tenant_id and v.id=b.active_profile_version_id
    where b.tenant_id=t and v.status='approved') then raise exception 'Approved business information required'; end if;
   if p->>'mode'='live' and (
    not exists(select from public.sms_businesses where tenant_id=t and status='active' and sending_enabled)
    or not exists(select from public.sms_twilio_registrations where tenant_id=t and state='ready')
    or not coalesce((sms_private.activation_readiness(u,t)->>'ready')::boolean,false)
   ) then raise exception 'A ready SMS connection with sending enabled is required' using errcode='22023';end if;
  end if;
  update sms_private.inbound_ai_settings set mode=p->>'mode',system_prompt=btrim(p->>'systemPrompt'),
   booking_enabled=(p->>'bookingEnabled')::boolean,revision=revision+1,updated_at=now() where tenant_id=t returning * into s;
  insert into sms_private.audit(tenant_id,actor,action,detail) values(t,u,'inbound_ai_settings_saved',jsonb_build_object('previousRevision',(p->>'revision')::integer,'revision',s.revision,'mode',s.mode,'bookingEnabled',s.booking_enabled));
 end if;
 return jsonb_build_object('mode',s.mode,'systemPrompt',s.system_prompt,'bookingEnabled',s.booking_enabled,
  'revision',s.revision,'model','gpt-6.1-sol','liveValidated',s.live_validated_at is not null,
  'pilot',t='biz-1c0c09ce-819e-4795-86b9-0e457ab92f58',
  'runs',coalesce((select jsonb_agg(x) from (select job_id,mode,created_at,result from sms_private.inbound_ai_runs where tenant_id=t order by created_at desc limit 20)x),'[]'));
end $$;
