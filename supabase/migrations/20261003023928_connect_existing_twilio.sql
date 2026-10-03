-- CRM-owned forward migration. Requires E2's business_registration_services
-- and canonical_crm_access_profiles already applied. No E2 migration replay.
alter table sms_private.providers
  add column connection_revision bigint not null default 0,
  add column connection_details jsonb not null default '{}' check(jsonb_typeof(connection_details)='object');

create table sms_private.twilio_connection_requests (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null references public.sms_businesses(tenant_id),
  account_sid text not null check(account_sid ~ '^AC[0-9a-fA-F]{32}$'),
  actor text not null,
  selection jsonb not null check(jsonb_typeof(selection)='object'),
  state text not null default 'connecting' check(state in ('connecting','needs_review','connected')),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique(tenant_id),unique(account_sid)
);
alter table sms_private.twilio_connection_requests enable row level security;
revoke all on sms_private.twilio_connection_requests from public,anon,authenticated,service_role,sms_api,sms_automation,sms_sender,sms_ai,sms_webhook;

-- A verified existing sender must never queue account creation. The original
-- Add SMS path continues to bootstrap an isolated child account.
create or replace function sms_private.queue_twilio_bootstrap() returns trigger
language plpgsql security definer set search_path='' as $$
declare business_name text;
begin
 if new.provisioning_state<>'pending' then return new; end if;
 select name into strict business_name from public.sms_businesses where tenant_id=new.tenant_id;
 perform sms_private.enqueue(new.tenant_id,'provisioning_jobs','twilio-bootstrap:v1',jsonb_build_object('name',business_name,'operation','bootstrap'));
 return new;
end $$;

create function sms_private.twilio_connection_access(u text,t text default null) returns jsonb
language plpgsql security definer set search_path='' as $$
begin
 perform sms_private.require_admin(u);
 if t is not null and not exists(select from public.sms_businesses where tenant_id=t) then raise exception 'Unknown business'; end if;
 return jsonb_build_object('bindings',coalesce((select jsonb_agg(jsonb_build_object('accountSid',p.account_sid,'tenantId',p.tenant_id,'businessName',b.name))
   from sms_private.providers p join public.sms_businesses b using(tenant_id) where p.account_sid is not null),'[]'::jsonb),
  'business',(select jsonb_build_object('id',b.tenant_id,'name',b.name,'reviewed',s.reviewed_profile_id is not null) from public.sms_businesses b left join public.platform_business_setup s using(tenant_id) where b.tenant_id=t),
  'connection',(select jsonb_build_object('revision',p.connection_revision,'state',p.provisioning_state,'accountSid',p.account_sid,'phoneNumber',p.from_number,'details',p.connection_details) from sms_private.providers p where p.tenant_id=t));
end $$;

create function sms_private.reserve_twilio_connection(u text,t text,p jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
#variable_conflict use_column
declare provider sms_private.providers; request sms_private.twilio_connection_requests; selection jsonb; owner uuid;
begin
 perform sms_private.require_admin(u);
 perform 1 from public.sms_businesses where tenant_id=t for update;
 if not found then raise exception 'Unknown business'; end if;
 owner:=sms_private.platform_owner(t);
 if not sms_private.login_account(owner,'customer') then raise exception 'Assign an active customer owner first'; end if;
 if not exists(select from public.platform_business_setup where tenant_id=t and reviewed_profile_id is not null) then raise exception 'Save a reviewed business profile first'; end if;
 if coalesce(p->>'accountSid','') !~ '^AC[0-9a-fA-F]{32}$' or coalesce(p->>'messagingServiceSid','') !~ '^MG[0-9a-fA-F]{32}$'
  or coalesce(p->>'phoneNumberSid','') !~ '^PN[0-9a-fA-F]{32}$' or coalesce(p->>'phoneNumber','') !~ '^\+[1-9][0-9]{7,14}$'
  or coalesce(p->>'senderType','') not in ('toll_free','local_a2p')
  or (p->>'senderType'='toll_free' and coalesce(p->>'registrationSid','') !~ '^HH[0-9a-fA-F]{32}$')
  or (p->>'senderType'='local_a2p' and (coalesce(p->>'registrationSid','') !~ '^QE[0-9a-fA-F]{32}$' or coalesce(p->>'brandSid','') !~ '^BN[0-9a-fA-F]{32}$'))
 then raise exception 'Invalid verified Twilio sender'; end if;
 perform pg_advisory_xact_lock(hashtextextended('twilio-account:'||(p->>'accountSid'),0));
 if exists(select from sms_private.providers where account_sid=p->>'accountSid' and tenant_id<>t)
  or exists(select from sms_private.twilio_connection_requests where account_sid=p->>'accountSid' and tenant_id<>t)
 then raise exception 'This Twilio account is already assigned to another CRM business' using errcode='23505'; end if;
 select * into provider from sms_private.providers where tenant_id=t for update;
 if coalesce(provider.connection_revision,0) is distinct from (p->>'revision')::bigint then raise exception 'Twilio connection changed; refresh and retry' using errcode='23505'; end if;
 if provider.account_sid is not null then
  if provider.account_sid=p->>'accountSid' and provider.messaging_service_sid=p->>'messagingServiceSid' and provider.phone_number_sid=p->>'phoneNumberSid' and provider.connection_details->>'registrationSid'=p->>'registrationSid' then
   return jsonb_build_object('alreadyConnected',true,'phoneNumber',provider.from_number,'revision',provider.connection_revision);
  end if;
  raise exception 'This business already has a Twilio account. Reassignment requires a separate reviewed transfer';
 end if;
 if exists(select from sms_private.jobs where tenant_id=t and queue in ('provisioning_jobs','compliance_jobs') and leased_until>now()) then
  raise exception 'Twilio setup is running. Wait for it to finish, then refresh and retry' using errcode='23505';
 end if;
 selection:=jsonb_build_object('accountSid',p->>'accountSid','accountName',p->>'accountName','profileSid',p->>'profileSid','profileName',p->>'profileName',
  'legalBusinessName',p->>'legalBusinessName','messagingServiceSid',p->>'messagingServiceSid','serviceName',p->>'serviceName',
  'phoneNumberSid',p->>'phoneNumberSid','phoneNumber',p->>'phoneNumber','senderType',p->>'senderType','registrationSid',p->>'registrationSid','brandSid',p->>'brandSid');
 select * into request from sms_private.twilio_connection_requests where tenant_id=t for update;
 if request.id is not null then
  if request.selection is distinct from selection then raise exception 'An existing connection requires review before choosing a different sender'; end if;
  if request.state='connecting' and request.updated_at>now()-interval '2 minutes' then raise exception 'A connection is already being verified. Refresh shortly' using errcode='23505'; end if;
  update sms_private.twilio_connection_requests set state='connecting',actor=u,updated_at=now() where id=request.id returning * into request;
 else
  insert into sms_private.twilio_connection_requests(tenant_id,account_sid,actor,selection) values(t,p->>'accountSid',u,selection) returning * into request;
 end if;
 update sms_private.jobs set status='cancelled',error_code='EXISTING_TWILIO_CONNECTION',leased_until=null,lease_token=null,updated_at=now()
  where tenant_id=t and queue in ('provisioning_jobs','compliance_jobs') and status in ('queued','retry','submission_unknown');
 insert into sms_private.providers(tenant_id,provisioning_state) values(t,'connecting_existing')
  on conflict(tenant_id) do update set provisioning_state='connecting_existing',updated_at=now();
 perform sms_private.platform_action(u,'service_add',jsonb_build_object('tenantId',t,'kind','sms'));
 update public.sms_businesses set sending_enabled=false where tenant_id=t;
 insert into sms_private.audit(tenant_id,actor,action,detail) values(t,u,'twilio_connection_reserved',selection||jsonb_build_object('requestId',request.id));
 return jsonb_build_object('id',request.id);
end $$;

create function sms_private.complete_twilio_connection(u text,t text,rid uuid,p jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
#variable_conflict use_column
declare request sms_private.twilio_connection_requests; secret_id uuid; s jsonb;
begin
 perform sms_private.require_admin(u);
 perform 1 from public.sms_businesses where tenant_id=t for update;
 select * into strict request from sms_private.twilio_connection_requests where id=rid and tenant_id=t for update;
 if request.actor<>u or request.state<>'connecting' then raise exception 'Connection verification is no longer current' using errcode='23505'; end if;
 s:=request.selection;
 if p->>'accountSid' is distinct from s->>'accountSid' or p->>'phoneNumberSid' is distinct from s->>'phoneNumberSid'
  or p->>'messagingServiceSid' is distinct from s->>'messagingServiceSid' or p->>'registrationSid' is distinct from s->>'registrationSid'
  or length(coalesce(p->>'authToken',''))<16 then raise exception 'Invalid verified connection'; end if;
 select vault.create_secret(p->>'authToken') into secret_id;
 update sms_private.providers set account_sid=s->>'accountSid',parent_account_sid=p->>'parentAccountSid',account_friendly_name=s->>'accountName',
  auth_secret_id=secret_id,messaging_service_sid=s->>'messagingServiceSid',phone_number_sid=s->>'phoneNumberSid',from_number=s->>'phoneNumber',
  provisioning_state='configured',registration_status='approved',connection_details=s,connection_revision=connection_revision+1,updated_at=now()
  where tenant_id=t and account_sid is null;
 if not found then raise exception 'The provider changed during verification' using errcode='23505'; end if;
 insert into public.sms_twilio_registrations(tenant_id,sender_type,state,customer_profile_sid,brand_registration_sid,campaign_sid,verification_sid,phone_number_sid,messaging_service_sid,last_checked_at)
 values(t,s->>'senderType','webhook_verified',s->>'profileSid',s->>'brandSid',case when s->>'senderType'='local_a2p' then s->>'registrationSid' end,
  case when s->>'senderType'='toll_free' then s->>'registrationSid' end,s->>'phoneNumberSid',s->>'messagingServiceSid',now())
 on conflict(tenant_id) do update set sender_type=excluded.sender_type,state=excluded.state,customer_profile_sid=excluded.customer_profile_sid,
  brand_registration_sid=excluded.brand_registration_sid,campaign_sid=excluded.campaign_sid,verification_sid=excluded.verification_sid,
  phone_number_sid=excluded.phone_number_sid,messaging_service_sid=excluded.messaging_service_sid,last_checked_at=now(),updated_at=now(),
  canary_phone=null,canary_message_id=null,canary_message_sid=null,rejection_code=null,rejection_reason=null;
 update sms_private.twilio_connection_requests set state='connected',updated_at=now() where id=rid;
 insert into sms_private.audit(tenant_id,actor,action,detail) values(t,u,'twilio_existing_connected',s||jsonb_build_object('requestId',rid));
 return jsonb_build_object('connected',true,'phoneNumber',s->>'phoneNumber','sendingEnabled',false,'registrationState','webhook_verified');
end $$;

create function sms_private.fail_twilio_connection(u text,t text,rid uuid) returns void
language plpgsql security definer set search_path='' as $$
begin
 perform sms_private.require_admin(u);
 update sms_private.twilio_connection_requests set state='needs_review',updated_at=now() where id=rid and tenant_id=t and actor=u and state='connecting';
 if found then update sms_private.providers set provisioning_state='connection_needs_review',updated_at=now() where tenant_id=t and account_sid is null; end if;
end $$;

revoke all on function sms_private.twilio_connection_access(text,text),sms_private.reserve_twilio_connection(text,text,jsonb),
 sms_private.complete_twilio_connection(text,text,uuid,jsonb),sms_private.fail_twilio_connection(text,text,uuid) from public,anon,authenticated,service_role;
grant execute on function sms_private.twilio_connection_access(text,text),sms_private.reserve_twilio_connection(text,text,jsonb),
 sms_private.complete_twilio_connection(text,text,uuid,jsonb),sms_private.fail_twilio_connection(text,text,uuid) to sms_api;
