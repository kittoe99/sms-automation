-- The connected management integration does not expose Edge secrets. Keep
-- provider credentials in Supabase Vault and return them only to the worker.
create table sms_private.email_provider_secrets (
  kind text primary key check(kind in ('resend_api','resend_webhook')),
  secret_id uuid not null references vault.secrets(id),
  updated_at timestamptz not null default now()
);
revoke all on sms_private.email_provider_secrets from public,anon,authenticated,
  sms_api,sms_webhook,sms_sender,sms_automation,sms_ai,sms_form_public;

create function sms_private.email_secret_value(secret_kind text) returns text
language plpgsql security definer set search_path='' as $$
declare result text;
begin
  if not pg_has_role(session_user,'sms_automation','member') then
    raise exception 'Worker role denied' using errcode='42501';
  end if;
  if secret_kind not in ('resend_api','resend_webhook') then
    raise exception 'Unknown email secret';
  end if;
  select v.decrypted_secret into result
    from sms_private.email_provider_secrets s
    join vault.decrypted_secrets v on v.id=s.secret_id
    where s.kind=secret_kind;
  return result;
end $$;

create function sms_private.email_provider_ready(u text,t text) returns boolean
language plpgsql security definer set search_path='' as $$
begin
  perform sms_private.require_web_form_editor(u,t);
  return t='e2-local' and
    exists(select from sms_private.email_provider_secrets s
      join vault.decrypted_secrets v on v.id=s.secret_id
      where s.kind='resend_api' and length(v.decrypted_secret)>0) and
    exists(select from sms_private.email_provider_secrets s
      join vault.decrypted_secrets v on v.id=s.secret_id
      where s.kind='resend_webhook' and length(v.decrypted_secret)>0);
end $$;

revoke all on function sms_private.email_secret_value(text),
  sms_private.email_provider_ready(text,text)
  from public,anon,authenticated,sms_api,sms_webhook,sms_sender,
    sms_automation,sms_ai,sms_form_public;
grant execute on function sms_private.email_secret_value(text) to sms_automation;
grant execute on function sms_private.email_provider_ready(text,text) to sms_api;
