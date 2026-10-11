-- CRM-owned forward migration after shared_twilio_accounts; no E2 migration.
-- Toll-free SMS verification never gates voice. Keep claims, admin/identity
-- review, revision checks and SMS activation requirements intact.
-- Compatible with the prior approved-only API; deploy this before the new API.
create or replace function sms_private.reserve_twilio_connection(u text,t text,p jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
#variable_conflict use_column
declare provider sms_private.providers; request sms_private.twilio_connection_requests; chosen jsonb; owner uuid;
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
  or (p->>'senderType'='toll_free' and (
   (p->>'registrationSid' is not null and p->>'registrationSid' !~ '^HH[0-9a-fA-F]{32}$')
   or (coalesce((p->>'smsApproved')::boolean,true) and p->>'registrationSid' is null)
   or (not coalesce((p->>'smsApproved')::boolean,true) and not coalesce((p->>'voiceCapable')::boolean,false))))
  or (p->>'senderType'='local_a2p' and not coalesce((p->>'smsApproved')::boolean,true))
  or (p->>'senderType'='local_a2p' and (coalesce(p->>'registrationSid','') !~ '^QE[0-9a-fA-F]{32}$' or coalesce(p->>'brandSid','') !~ '^BN[0-9a-fA-F]{32}$'))
 then raise exception 'Invalid Twilio sender'; end if;
 select * into provider from sms_private.providers where tenant_id=t for update;
 if coalesce(provider.connection_revision,0) is distinct from (p->>'revision')::bigint then raise exception 'Twilio connection changed; refresh and retry' using errcode='23505'; end if;
 if provider.account_sid is not null then
  if provider.account_sid=p->>'accountSid' and provider.messaging_service_sid=p->>'messagingServiceSid' and provider.phone_number_sid=p->>'phoneNumberSid' and provider.from_number=p->>'phoneNumber' then
   return jsonb_build_object('alreadyConnected',true,'phoneNumber',provider.from_number,'revision',provider.connection_revision);
  end if;
  raise exception 'This business already has a Twilio account. Reassignment requires a separate reviewed transfer';
 end if;
 if exists(select from sms_private.jobs where tenant_id=t and queue in ('provisioning_jobs','compliance_jobs') and leased_until>now()) then
  raise exception 'Twilio setup is running. Wait for it to finish, then refresh and retry' using errcode='23505';
 end if;
 chosen:=jsonb_build_object('accountSid',p->>'accountSid','accountName',p->>'accountName','profileSid',p->>'profileSid','profileName',p->>'profileName',
  'legalBusinessName',p->>'legalBusinessName','messagingServiceSid',p->>'messagingServiceSid','serviceName',p->>'serviceName',
  'phoneNumberSid',p->>'phoneNumberSid','phoneNumber',p->>'phoneNumber','senderType',p->>'senderType','registrationSid',p->>'registrationSid','brandSid',p->>'brandSid',
  'smsApproved',coalesce((p->>'smsApproved')::boolean,true),'voiceCapable',coalesce((p->>'voiceCapable')::boolean,false),
  'smsVerificationStatus',p->>'smsVerificationStatus');
 select * into request from sms_private.twilio_connection_requests where tenant_id=t for update;
 if request.id is not null then
  -- Registration may progress during a failed attempt; revalidated metadata
  -- can refresh, but the reserved business/number/service cannot change.
  if request.selection->>'accountSid' is distinct from chosen->>'accountSid'
   or request.selection->>'phoneNumberSid' is distinct from chosen->>'phoneNumberSid'
   or request.selection->>'phoneNumber' is distinct from chosen->>'phoneNumber'
   or request.selection->>'messagingServiceSid' is distinct from chosen->>'messagingServiceSid'
   or request.selection->>'senderType' is distinct from chosen->>'senderType' then raise exception 'An existing connection requires review before choosing a different sender'; end if;
  if request.state='connecting' and request.updated_at>now()-interval '2 minutes' then raise exception 'A connection is already being verified. Refresh shortly' using errcode='23505'; end if;
  update sms_private.twilio_connection_requests set state='connecting',actor=u,selection=chosen,updated_at=now() where id=request.id returning * into request;
 else
  insert into sms_private.twilio_connection_requests(tenant_id,account_sid,actor,selection) values(t,p->>'accountSid',u,chosen) returning * into request;
 end if;
 update sms_private.jobs set status='cancelled',error_code='EXISTING_TWILIO_CONNECTION',leased_until=null,lease_token=null,updated_at=now()
  where tenant_id=t and queue in ('provisioning_jobs','compliance_jobs') and status in ('queued','retry','submission_unknown');
 insert into sms_private.providers(tenant_id,provisioning_state) values(t,'connecting_existing')
  on conflict(tenant_id) do update set provisioning_state='connecting_existing',updated_at=now();
 perform sms_private.platform_action(u,'service_add',jsonb_build_object('tenantId',t,'kind','sms'));
 update public.sms_businesses set sending_enabled=false where tenant_id=t;
 insert into sms_private.audit(tenant_id,actor,action,detail) values(t,u,'twilio_connection_reserved',chosen||jsonb_build_object('requestId',request.id));
 return jsonb_build_object('id',request.id);
end $$;


create or replace function sms_private.complete_twilio_connection(u text,t text,rid uuid,p jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
#variable_conflict use_column
declare request sms_private.twilio_connection_requests; secret_id uuid; s jsonb; registration_state text;
begin
 perform sms_private.require_admin(u);
 perform 1 from public.sms_businesses where tenant_id=t for update;
 select * into strict request from sms_private.twilio_connection_requests where id=rid and tenant_id=t for update;
 if request.actor<>u or request.state<>'connecting' then raise exception 'Connection verification is no longer current' using errcode='23505'; end if;
 s:=request.selection;
 if p->>'accountSid' is distinct from s->>'accountSid' or p->>'phoneNumberSid' is distinct from s->>'phoneNumberSid'
  or p->>'messagingServiceSid' is distinct from s->>'messagingServiceSid' or p->>'registrationSid' is distinct from s->>'registrationSid'
  or length(coalesce(p->>'authToken',''))<16 then raise exception 'Invalid verified connection'; end if;
 -- Old API callers only admitted approved senders. Missing smsApproved stays
 -- compatible with that contract; new callers always provide the verified flag.
 registration_state:=case when coalesce((s->>'smsApproved')::boolean,true) then 'webhook_verified'
  when s->>'smsVerificationStatus'='TWILIO_REJECTED' then 'rejected'
  when s->>'registrationSid' is null then 'verification_pending' else 'in_review' end;
 select vault.create_secret(p->>'authToken') into secret_id;
 update sms_private.providers set account_sid=s->>'accountSid',parent_account_sid=p->>'parentAccountSid',account_friendly_name=s->>'accountName',
  auth_secret_id=secret_id,messaging_service_sid=s->>'messagingServiceSid',phone_number_sid=s->>'phoneNumberSid',from_number=s->>'phoneNumber',
  provisioning_state='configured',registration_status=case registration_state when 'webhook_verified' then 'approved' when 'rejected' then 'rejected' when 'verification_pending' then 'not_started' else 'submitted' end,connection_details=s,connection_revision=connection_revision+1,updated_at=now()
  where tenant_id=t and account_sid is null;
 if not found then raise exception 'The provider changed during verification' using errcode='23505'; end if;
 insert into public.sms_twilio_registrations(tenant_id,sender_type,state,customer_profile_sid,brand_registration_sid,campaign_sid,verification_sid,phone_number_sid,messaging_service_sid,last_checked_at)
 values(t,s->>'senderType',registration_state,s->>'profileSid',s->>'brandSid',case when s->>'senderType'='local_a2p' then s->>'registrationSid' end,
  case when s->>'senderType'='toll_free' then s->>'registrationSid' end,s->>'phoneNumberSid',s->>'messagingServiceSid',now())
 on conflict(tenant_id) do update set sender_type=excluded.sender_type,state=excluded.state,customer_profile_sid=excluded.customer_profile_sid,
  brand_registration_sid=excluded.brand_registration_sid,campaign_sid=excluded.campaign_sid,verification_sid=excluded.verification_sid,
  phone_number_sid=excluded.phone_number_sid,messaging_service_sid=excluded.messaging_service_sid,last_checked_at=now(),updated_at=now(),
  canary_phone=null,canary_message_id=null,canary_message_sid=null,rejection_code=null,rejection_reason=null;
 update sms_private.twilio_connection_requests set state='connected',updated_at=now() where id=rid;
 insert into sms_private.audit(tenant_id,actor,action,detail) values(t,u,'twilio_existing_connected',s||jsonb_build_object('requestId',rid));
 return jsonb_build_object('connected',true,'phoneNumber',s->>'phoneNumber','sendingEnabled',false,'registrationState',registration_state);
end $$;

revoke all on function sms_private.reserve_twilio_connection(text,text,jsonb),
 sms_private.complete_twilio_connection(text,text,uuid,jsonb) from public,anon,authenticated,service_role;
grant execute on function sms_private.reserve_twilio_connection(text,text,jsonb),
 sms_private.complete_twilio_connection(text,text,uuid,jsonb) to sms_api;
