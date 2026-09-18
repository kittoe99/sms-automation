alter table sms_private.providers
  add column setup_details jsonb not null default '{}',
  add column setup_completed_at timestamptz,
  add constraint sms_provider_setup_details_object check (jsonb_typeof(setup_details)='object');

create or replace function sms_private.provider_setup(u text,t text) returns jsonb
language plpgsql security definer set search_path='' as $$
#variable_conflict use_column
begin
  perform sms_private.require_admin(u);
  if not exists(select from public.sms_businesses where tenant_id=t) then raise exception 'Unknown business'; end if;
  return coalesce((select jsonb_build_object(
    'state',p.provisioning_state,'accountSid',p.account_sid,'accountFriendlyName',p.account_friendly_name,
    'messagingServiceSid',p.messaging_service_sid,'phoneNumber',p.from_number,'phoneNumberSid',p.phone_number_sid,
    'registrationStatus',p.registration_status,'details',p.setup_details,'detailsComplete',p.setup_completed_at is not null,
    'readyForNumber',p.account_sid is not null and p.messaging_service_sid is not null,
    'sendingEnabled',b.sending_enabled,'businessStatus',b.status,'updatedAt',p.updated_at)
    from sms_private.providers p join public.sms_businesses b using(tenant_id) where p.tenant_id=t),
    jsonb_build_object('state','pending','details','{}'::jsonb,'detailsComplete',false,'sendingEnabled',false,'businessStatus','pending'));
end $$;

create function sms_private.save_provider_setup(u text,t text,input jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
#variable_conflict use_column
declare details jsonb; samples jsonb; sender text; brand text;
begin
  perform sms_private.require_admin(u);
  if not exists(select from public.sms_businesses where tenant_id=t) then raise exception 'Unknown business'; end if;
  sender:=input->>'senderType'; brand:=input->>'brandType'; samples:=input->'sampleMessages';
  if sender not in ('local_a2p','toll_free') then raise exception 'Choose a sender type'; end if;
  if sender='local_a2p' and brand not in ('standard','sole_proprietor') then raise exception 'Choose a brand type'; end if;
  if length(trim(coalesce(input->>'legalBusinessName',''))) not between 1 and 160 then raise exception 'Legal business name is required'; end if;
  if coalesce(input->>'notificationEmail','') !~* '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then raise exception 'Valid notification email is required'; end if;
  if coalesce(input->>'websiteUrl','') !~* '^https://[^[:space:]]+$' then raise exception 'A public HTTPS website is required'; end if;
  if sender='local_a2p' and coalesce(input->>'areaCode','') !~ '^[0-9]{3}$' then raise exception 'A three-digit area code is required'; end if;
  if length(trim(coalesce(input->>'campaignDescription',''))) not between 40 and 1500 then raise exception 'Campaign description must be 40-1500 characters'; end if;
  if length(trim(coalesce(input->>'optInDescription',''))) not between 40 and 1500 then raise exception 'Opt-in description must be 40-1500 characters'; end if;
  if coalesce(jsonb_typeof(samples),'null')<>'array' then raise exception 'Provide 2-5 sample messages of 20-320 characters'; end if;
  if jsonb_array_length(samples) not between 2 and 5
    or exists(select from jsonb_array_elements_text(samples) s where length(trim(s)) not between 20 and 320)
  then raise exception 'Provide 2-5 sample messages of 20-320 characters'; end if;
  details:=jsonb_build_object(
    'senderType',sender,'brandType',case when sender='local_a2p' then brand else null end,
    'legalBusinessName',trim(input->>'legalBusinessName'),'notificationEmail',lower(trim(input->>'notificationEmail')),
    'websiteUrl',trim(input->>'websiteUrl'),'areaCode',case when sender='local_a2p' then input->>'areaCode' else null end,
    'campaignDescription',trim(input->>'campaignDescription'),'optInDescription',trim(input->>'optInDescription'),
    'sampleMessages',samples);
  update sms_private.providers set setup_details=details,setup_completed_at=now(),registration_status='collecting_details',updated_at=now()
  where tenant_id=t;
  insert into sms_private.audit(tenant_id,actor,action,detail) values(t,u,'provider_setup_saved',jsonb_build_object('senderType',sender));
  return sms_private.provider_setup(u,t);
end $$;

revoke all on function sms_private.save_provider_setup(text,text,jsonb) from public,anon,authenticated;
grant execute on function sms_private.save_provider_setup(text,text,jsonb) to sms_api;
