-- Automatically prepare an isolated Twilio child account for every new CRM business.
-- Phone purchases and paid compliance submissions remain explicit later stages.

alter table sms_private.providers
  add column parent_account_sid text,
  add column account_friendly_name text,
  add column phone_number_sid text,
  add column registration_status text not null default 'not_started'
    check (registration_status in ('not_started','collecting_details','submitted','approved','rejected','needs_review')),
  add column updated_at timestamptz not null default now();

create function sms_private.queue_twilio_bootstrap() returns trigger
language plpgsql security definer set search_path='' as $$
declare business_name text;
begin
  select name into strict business_name from public.sms_businesses where tenant_id=new.tenant_id;
  perform sms_private.enqueue(new.tenant_id,'provisioning_jobs','twilio-bootstrap:v1',
    jsonb_build_object('name',business_name,'operation','bootstrap'));
  return new;
end $$;

create trigger sms_provider_bootstrap_after_insert
after insert on sms_private.providers
for each row execute function sms_private.queue_twilio_bootstrap();

create function sms_private.provider_setup(u text,t text) returns jsonb
language plpgsql security definer set search_path='' as $$
#variable_conflict use_column
begin
  perform sms_private.require_admin(u);
  if not exists(select from public.sms_businesses where tenant_id=t) then raise exception 'Unknown business'; end if;
  return coalesce((select jsonb_build_object(
    'state',p.provisioning_state,
    'accountSid',p.account_sid,
    'accountFriendlyName',p.account_friendly_name,
    'messagingServiceSid',p.messaging_service_sid,
    'phoneNumber',p.from_number,
    'phoneNumberSid',p.phone_number_sid,
    'registrationStatus',p.registration_status,
    'readyForNumber',p.account_sid is not null and p.messaging_service_sid is not null,
    'sendingEnabled',b.sending_enabled,
    'businessStatus',b.status,
    'updatedAt',p.updated_at)
    from sms_private.providers p join public.sms_businesses b using(tenant_id) where p.tenant_id=t),
    jsonb_build_object('state','pending','sendingEnabled',false,'businessStatus','pending'));
end $$;

create or replace function sms_private.job_context(jid uuid,token uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
#variable_conflict use_column
declare j sms_private.jobs; e public.sms_automation_enrollments; c public.sms_contacts; ph text;
begin
  j:=sms_private.lease(jid,token);
  if j.queue='automation_jobs' then
    select * into e from public.sms_automation_enrollments where tenant_id=j.tenant_id and id=(j.payload->>'enrollment_id')::uuid;
    select * into c from public.sms_contacts where tenant_id=j.tenant_id and id=e.contact_id;
    return jsonb_build_object('enrollment',to_jsonb(e),'contact',to_jsonb(c),
      'business',(select to_jsonb(b) from public.sms_businesses b where tenant_id=j.tenant_id),
      'group',(select to_jsonb(g) from public.sms_automation_groups g where tenant_id=j.tenant_id and id=e.category_id),
      'steps',(select jsonb_agg(s order by step_index) from public.sms_automation_steps s where tenant_id=j.tenant_id and group_id=e.category_id));
  elsif j.queue='ai_reply_jobs' then
    ph:=j.payload->>'phone';
    return jsonb_build_object('business',(select to_jsonb(b) from public.sms_businesses b where tenant_id=j.tenant_id),
      'contact',(select to_jsonb(c) from public.sms_contacts c where tenant_id=j.tenant_id and phone=ph),
      'thread',(select to_jsonb(th) from public.sms_thread_contacts th where tenant_id=j.tenant_id and phone=ph),
      'settings',(select to_jsonb(a) from public.sms_ai_settings a where tenant_id=j.tenant_id and group_id=j.payload->>'group_id'),
      'history',(select coalesce(jsonb_agg(m order by created_at),'[]') from
        (select direction,body,created_at from public.sms_messages where tenant_id=j.tenant_id and contact_phone=ph order by created_at desc limit 20)m));
  elsif j.queue='provisioning_jobs' then
    return (select jsonb_build_object('account_sid',p.account_sid,'messaging_service_sid',p.messaging_service_sid,
      'phone_number_sid',p.phone_number_sid,'state',p.provisioning_state,'business_name',b.name)
      from sms_private.providers p join public.sms_businesses b using(tenant_id) where p.tenant_id=j.tenant_id);
  end if;
  raise exception 'Unsupported context';
end $$;

create or replace function sms_private.provision_checkpoint(jid uuid,token uuid,p jsonb) returns void
language plpgsql security definer set search_path='' as $$
#variable_conflict use_column
declare j sms_private.jobs; sec uuid;
begin
  j:=sms_private.lease(jid,token);
  if j.queue<>'provisioning_jobs' then raise exception 'Wrong queue'; end if;
  if p ? 'auth_token' then select vault.create_secret(p->>'auth_token') into sec; end if;
  update sms_private.providers set
    account_sid=coalesce(p->>'account_sid',account_sid),
    auth_secret_id=coalesce(sec,auth_secret_id),
    parent_account_sid=coalesce(p->>'parent_account_sid',parent_account_sid),
    account_friendly_name=coalesce(p->>'account_friendly_name',account_friendly_name),
    messaging_service_sid=coalesce(p->>'messaging_service_sid',messaging_service_sid),
    phone_number_sid=coalesce(p->>'phone_number_sid',phone_number_sid),
    from_number=coalesce(p->>'from_number',from_number),
    provisioning_state=p->>'state',updated_at=now()
  where tenant_id=j.tenant_id;
end $$;

revoke all on function sms_private.provider_setup(text,text) from public,anon,authenticated;
grant execute on function sms_private.provider_setup(text,text) to sms_api;

comment on trigger sms_provider_bootstrap_after_insert on sms_private.providers is
  'Queues idempotent Twilio child-account setup whenever a CRM provider record is first created.';
