-- Stage 2: deploy/verify number-aware messaging AND voice handlers first.
-- Requires the existing paired E2 registration/access migrations; no E2 replay.
lock table sms_private.providers, sms_private.twilio_connection_requests in share row exclusive mode;

-- One atomic ownership registry covers BOTH providers and in-flight reservations.
-- Unique indexes on the two source tables alone cannot prevent cross-table races.
create table sms_private.twilio_sender_claims (
 resource_kind text not null check(resource_kind in ('phone_sid','phone_number','service_sid')),
 resource_key text not null,
 tenant_id text not null references public.sms_businesses(tenant_id),
 primary key(resource_kind,resource_key)
);
create index twilio_sender_claims_tenant on sms_private.twilio_sender_claims(tenant_id);
alter table sms_private.twilio_sender_claims enable row level security;
revoke all on sms_private.twilio_sender_claims from public,anon,authenticated,service_role,sms_api,sms_webhook,sms_sender,sms_automation,sms_ai;

create function sms_private.twilio_sender_resources(t text default null)
returns table(resource_kind text,resource_key text,tenant_id text)
language sql set search_path='' as $$
 select distinct v.kind,v.key,s.tenant_id from (
  select tenant_id,phone_number_sid,from_number,messaging_service_sid from sms_private.providers where t is null or tenant_id=t
  union all
  select tenant_id,selection->>'phoneNumberSid',selection->>'phoneNumber',selection->>'messagingServiceSid'
   from sms_private.twilio_connection_requests where t is null or tenant_id=t
 ) s cross join lateral (values ('phone_sid',s.phone_number_sid),('phone_number',s.from_number),('service_sid',s.messaging_service_sid)) v(kind,key)
 where nullif(v.key,'') is not null
$$;
revoke all on function sms_private.twilio_sender_resources(text) from public,anon,authenticated,service_role;

do $$ begin
 if exists(select from sms_private.twilio_sender_resources() group by resource_kind,resource_key having count(distinct tenant_id)>1) then
  raise exception 'Twilio sender ownership conflicts exist. Review providers and connection requests before applying shared accounts.';
 end if;
end $$;
insert into sms_private.twilio_sender_claims select * from sms_private.twilio_sender_resources();

create function sms_private.sync_twilio_sender_claims() returns trigger
language plpgsql security definer set search_path='' as $$
declare t text; resource record;
begin
 if tg_op='UPDATE' and new.tenant_id is distinct from old.tenant_id then
  raise exception 'Twilio sender reassignment requires a separate reviewed transfer';
 end if;
 t:=case when tg_op='DELETE' then old.tenant_id else new.tenant_id end;
 perform pg_advisory_xact_lock(hashtextextended('twilio-sender-tenant:'||t,0));
 -- Deterministic order, with uniqueness arbitrated by PostgreSQL even when a
 -- competing transaction is invisible to the current statement snapshot.
 for resource in select * from sms_private.twilio_sender_resources(t) order by resource_kind,resource_key loop
  insert into sms_private.twilio_sender_claims as claim(resource_kind,resource_key,tenant_id)
   values(resource.resource_kind,resource.resource_key,t)
   on conflict(resource_kind,resource_key) do update set tenant_id=excluded.tenant_id where claim.tenant_id=excluded.tenant_id;
  if not found then raise exception 'This Twilio number or Messaging Service is already assigned or reserved for another CRM business' using errcode='23505'; end if;
 end loop;
 delete from sms_private.twilio_sender_claims c where c.tenant_id=t and not exists(
  select from sms_private.twilio_sender_resources(t) r where r.resource_kind=c.resource_kind and r.resource_key=c.resource_key);
 return null;
end $$;
revoke all on function sms_private.sync_twilio_sender_claims() from public,anon,authenticated,service_role;
create trigger twilio_sender_claims after insert or update of tenant_id,phone_number_sid,from_number,messaging_service_sid or delete
 on sms_private.providers for each row execute function sms_private.sync_twilio_sender_claims();
create trigger twilio_sender_claims after insert or update of tenant_id,selection or delete
 on sms_private.twilio_connection_requests for each row execute function sms_private.sync_twilio_sender_claims();

alter table sms_private.providers drop constraint providers_account_sid_key;
alter table sms_private.twilio_connection_requests drop constraint twilio_connection_requests_account_sid_key;
create index providers_twilio_account_number on sms_private.providers(account_sid,from_number) where account_sid is not null;
create index twilio_requests_account on sms_private.twilio_connection_requests(account_sid);
create index sms_messages_webhook_sid on public.sms_messages(sid) where sid is not null;

create or replace function sms_private.twilio_connection_access(u text,t text default null) returns jsonb
language plpgsql security definer set search_path='' as $$
begin
 perform sms_private.require_admin(u);
 if t is not null and not exists(select from public.sms_businesses where tenant_id=t) then raise exception 'Unknown business'; end if;
 return jsonb_build_object('bindings',coalesce((select jsonb_agg(jsonb_build_object('accountSid',p.account_sid,'tenantId',p.tenant_id,'businessName',b.name,
   'phoneNumber',p.from_number,'phoneNumberSid',p.phone_number_sid,'messagingServiceSid',p.messaging_service_sid) order by b.name,p.tenant_id)
   from sms_private.providers p join public.sms_businesses b using(tenant_id) where p.account_sid is not null),'[]'::jsonb),
  'reservations',coalesce((select jsonb_agg(jsonb_build_object('accountSid',r.account_sid,'tenantId',r.tenant_id,'businessName',b.name,
   'phoneNumber',r.selection->>'phoneNumber','phoneNumberSid',r.selection->>'phoneNumberSid','messagingServiceSid',r.selection->>'messagingServiceSid','state',r.state) order by b.name,r.tenant_id)
   from sms_private.twilio_connection_requests r join public.sms_businesses b using(tenant_id) where r.state<>'connected'),'[]'::jsonb),
  'business',(select jsonb_build_object('id',b.tenant_id,'name',b.name,'reviewed',s.reviewed_profile_id is not null) from public.sms_businesses b left join public.platform_business_setup s using(tenant_id) where b.tenant_id=t),
  'connection',(select jsonb_build_object('revision',p.connection_revision,'state',p.provisioning_state,'accountSid',p.account_sid,'phoneNumber',p.from_number,'details',p.connection_details) from sms_private.providers p where p.tenant_id=t));
end $$;

create or replace function sms_private.reserve_twilio_connection(u text,t text,p jsonb) returns jsonb
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

