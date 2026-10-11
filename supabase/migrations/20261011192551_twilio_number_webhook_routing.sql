-- Stage 1: apply before deploying both twilio-webhook and soni-voice-inbound.
-- Account sharing is enabled only by the separate stage 2 migration.
create or replace function sms_private.webhook_credentials(account text) returns jsonb
language sql security definer set search_path='' as $$
 select jsonb_build_object('tenant_id',p.tenant_id,'auth_token',s.decrypted_secret,'from_number',p.from_number)
 from sms_private.providers p join vault.decrypted_secrets s on s.id=p.auth_secret_id
 where p.account_sid=account and (select count(*) from sms_private.providers where account_sid=account)=1
$$;

create function sms_private.resolve_twilio_webhook(account text,event text,p jsonb,attempt text default null) returns jsonb
language plpgsql security definer set search_path='' as $$
declare t text; mid uuid; a sms_private.attempts; m public.sms_messages; provider sms_private.providers;
begin
 if coalesce(account,'') !~ '^AC[0-9a-fA-F]{32}$' then return null; end if;
 if event in ('inbound','call') then
  if event='call' and coalesce(p->>'Direction','inbound')<>'inbound' then return null; end if;
  -- INTO STRICT rejects missing and ambiguous destinations; never pick a first row.
  select * into strict provider from sms_private.providers where account_sid=account and from_number=p->>'To';
 elsif event='status' then
  if nullif(p->>'MessageSid','') is null then return null; end if;
  if attempt is not null then
   select * into strict a from sms_private.attempts where id=attempt::uuid;
   if a.sid is not null and a.sid is distinct from p->>'MessageSid' then return null; end if;
   select tenant_id,(payload->>'message_id')::uuid into strict t,mid from sms_private.jobs where id=a.job_id and queue='sms_send_jobs';
   select * into strict m from public.sms_messages where tenant_id=t and id=mid and direction='outbound';
   if m.sid is not null and m.sid is distinct from p->>'MessageSid' then return null; end if;
   if exists(select from public.sms_messages where sid=p->>'MessageSid' and id<>mid)
    or exists(select from sms_private.attempts where sid=p->>'MessageSid' and job_id<>a.job_id) then return null; end if;
  else
   select * into strict m from public.sms_messages where sid=p->>'MessageSid' and direction='outbound';
  end if;
  select * into strict provider from sms_private.providers where tenant_id=m.tenant_id and account_sid=account;
  if nullif(p->>'From','') is not null and p->>'From' is distinct from provider.from_number then return null; end if;
  if nullif(p->>'To','') is not null and p->>'To' is distinct from m.contact_phone then return null; end if;
 else return null;
 end if;
 if nullif(p->>'MessagingServiceSid','') is not null and p->>'MessagingServiceSid' is distinct from provider.messaging_service_sid then return null; end if;
 return (select jsonb_build_object('tenant_id',provider.tenant_id,'auth_token',s.decrypted_secret,'from_number',provider.from_number)
  from vault.decrypted_secrets s where s.id=provider.auth_secret_id);
 exception when no_data_found or too_many_rows or invalid_text_representation then return null;
end $$;
revoke all on function sms_private.resolve_twilio_webhook(text,text,jsonb,text) from public,anon,authenticated,service_role;
grant execute on function sms_private.resolve_twilio_webhook(text,text,jsonb,text) to sms_webhook;
