create function sms_private.email_record_provider_event(event_key text,provider text,
  kind text,address text) returns void
language plpgsql security definer set search_path='' as $$
begin
  if not pg_has_role(session_user,'sms_automation','member') then raise exception 'Worker role denied' using errcode='42501'; end if;
  if length(event_key) not between 1 and 200 or kind not in
    ('email.sent','email.delivered','email.delivery_delayed','email.bounced','email.complained','email.failed','email.suppressed')
    then raise exception 'Invalid email provider event'; end if;
  insert into sms_private.email_webhook_events(event_id,provider_id,event_type)
    values(event_key,provider,kind) on conflict do nothing;
  update sms_private.email_jobs set provider_status=kind,updated_at=now()
    where provider_id=provider;
  if kind in ('email.bounced','email.complained','email.suppressed') and address is not null then
    insert into sms_private.email_suppressions(tenant_id,email,reason)
      values('e2-local',lower(address),kind) on conflict do nothing;
    update sms_private.email_enrollments set status='cancelled',next_run_at=null,
      generation=generation+1,updated_at=now()
      where tenant_id='e2-local' and email=lower(address) and status='active';
  end if;
end $$;
