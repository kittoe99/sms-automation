create function sms_private.provision_credentials(jid uuid,token uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
#variable_conflict use_column
declare j sms_private.jobs;
begin
  j:=sms_private.lease(jid,token);
  if j.queue<>'provisioning_jobs' then raise exception 'Wrong queue'; end if;
  return (select jsonb_build_object('account_sid',p.account_sid,'auth_token',s.decrypted_secret,
    'messaging_service_sid',p.messaging_service_sid,'phone_number_sid',p.phone_number_sid,
    'state',p.provisioning_state,'business_name',b.name)
    from sms_private.providers p join public.sms_businesses b using(tenant_id)
    left join vault.decrypted_secrets s on s.id=p.auth_secret_id where p.tenant_id=j.tenant_id);
end $$;

revoke all on function sms_private.provision_credentials(uuid,uuid) from public,anon,authenticated,sms_sender,sms_ai,sms_webhook,sms_api;
grant execute on function sms_private.provision_credentials(uuid,uuid) to sms_automation;
