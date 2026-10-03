-- CRM-owned additive projection update. Requires CRM 20261003032940.
-- Apply before E2 20261003213905_sms_activation_summary_cache.
-- Existing guarded readers and privileges remain unchanged; no delivery data is exposed.
do $$ begin
 if to_regprocedure('sms_private.sms_connection_summary(text)') is null then
  raise exception 'CRM sms_connection_summary prerequisite missing';
 end if;
end $$;
-- CRM-owned. Requires CRM connect_existing_twilio and E2 canonical_crm_access_profiles.
-- Internal projection shared by the guarded CRM and customer readers; never
-- grant callers a generic tenant lookup or expose provider/registration rows.
create or replace function sms_private.sms_connection_summary(t text) returns jsonb
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
  'activationStatus',case
    when b.status='paused' or r.state='paused' then 'paused'
    when b.sending_enabled and b.status='active' then 'active'
    when p.provisioning_state='configured' and p.from_number is not null and r.state='ready' then 'ready'
    when r.state in ('rejected','submission_unknown') or p.provisioning_state in ('connection_needs_review','submission_unknown') then 'needs_attention'
    when r.tenant_id is not null and p.tenant_id is not null then 'in_progress' else 'not_available' end,
  'messagingStatus',case when b.status='paused' or r.state='paused' then 'paused'
    when b.sending_enabled and b.status='active' then 'active' else 'disabled' end)
 from public.sms_businesses b left join sms_private.providers p using(tenant_id)
 left join public.sms_twilio_registrations r using(tenant_id) where b.tenant_id=t
$$;
revoke all on function sms_private.sms_connection_summary(text) from public,anon,authenticated,service_role,sms_api;

