-- CRM-owned. Requires CRM connect_existing_twilio and E2 canonical_crm_access_profiles.
-- Internal projection shared by the guarded CRM and customer readers; never
-- grant callers a generic tenant lookup or expose provider/registration rows.
create function sms_private.sms_connection_summary(t text) returns jsonb
language sql stable security definer set search_path='' as $$
 select jsonb_build_object(
  'businessName',b.name,
  'profileName',coalesce(nullif(p.connection_details->>'profileName',''),nullif(p.connection_details->>'legalBusinessName','')),
  'phoneNumber',p.from_number,
  'senderType',case when r.sender_type in ('toll_free','local_a2p') then r.sender_type end,
  'connectionStatus',case when p.provisioning_state='configured' and p.from_number is not null then 'connected'
    when p.provisioning_state in ('connection_needs_review','submission_unknown') then 'needs_attention'
    when p.tenant_id is not null then 'in_progress' else 'not_available' end,
  'approvalStatus',case when r.state in ('rejected','submission_unknown','paused') then 'needs_attention'
    when r.state in ('approved','sender_attached','webhook_verified','canary_pending','ready') then 'approved'
    when r.state in ('profile_pending','brand_pending','campaign_pending','number_pending','verification_pending','in_review') then 'in_progress'
    else 'not_available' end,
  'messagingStatus',case when b.status='paused' or r.state='paused' then 'paused'
    when b.sending_enabled and b.status='active' then 'active' else 'disabled' end)
 from public.sms_businesses b left join sms_private.providers p using(tenant_id)
 left join public.sms_twilio_registrations r using(tenant_id) where b.tenant_id=t
$$;
revoke all on function sms_private.sms_connection_summary(text) from public,anon,authenticated,service_role,sms_api;

create function sms_private.read_sms_connection(u text,t text) returns jsonb
language plpgsql stable security definer set search_path='' as $$
begin
 perform sms_private.require_sms_reader(u,t);
 return sms_private.sms_connection_summary(t);
end $$;

-- Close the direct Data API path too; masking only an HTTP response would still
-- let SMS readers select the complete registration row through authenticated.
-- Late-bind paired canonical functions so the historical CRM-first test harness
-- can assemble both histories; production requires the E2 prerequisites above.
create function sms_private.registration_staff_read(t text) returns boolean
language plpgsql stable security definer set search_path='' as $$
begin
 return sms_private.can_access(t)
  and sms_private.platform_staff(sms_private.platform_actor(auth.jwt()->>'sub'));
end $$;
revoke all on function sms_private.registration_staff_read(text) from public,anon,service_role,sms_api;
grant execute on function sms_private.registration_staff_read(text) to authenticated;
alter policy tenant_read on public.sms_twilio_registrations using (
 sms_private.registration_staff_read(tenant_id)
);
revoke all on function sms_private.read_sms_connection(text,text) from public,anon,authenticated,service_role;
grant execute on function sms_private.read_sms_connection(text,text) to sms_api;

-- Detailed registration contains provider references, canary data and internal
-- errors. Readers use read_sms_connection instead; staff behavior is unchanged.
create or replace function sms_private.twilio_registration(u text,t text) returns jsonb
language plpgsql security definer set search_path='' as $$
begin
 perform sms_private.require_admin(u);
 if not sms_private.can_access(t,u) then raise exception 'Tenant access denied' using errcode='42501'; end if;
 return coalesce((select to_jsonb(r)-'paid_action_confirmed_by' from public.sms_twilio_registrations r where tenant_id=t),jsonb_build_object('state','draft'));
end $$;
