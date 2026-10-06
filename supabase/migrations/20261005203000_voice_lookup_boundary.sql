-- Older sms_private routines can inherit PUBLIC execution. Keep the new lookup
-- login outside that schema rather than changing privileges of existing clients.
create schema voice_lookup_api;
revoke all on schema voice_lookup_api from public;
grant usage on schema voice_lookup_api to sms_voice_lookup;
revoke usage on schema sms_private from sms_voice_lookup;
revoke execute on function sms_private.voice_read_business(text,text),
  sms_private.voice_read_start_otp(text,text,text,text,text),
  sms_private.voice_read_verify_otp(text,text,text,text),
  sms_private.voice_read_customer(text,text,text) from sms_voice_lookup;

create function voice_lookup_api.voice_read_business(t text,q text) returns jsonb
language sql stable security definer set search_path='' as $$
  select sms_private.voice_read_business(t,q);
$$;
create function voice_lookup_api.voice_read_start_otp(t text,cid text,ph text,hashed text,body text) returns jsonb
language sql security definer set search_path='' as $$
  select sms_private.voice_read_start_otp(t,cid,ph,hashed,body);
$$;
create function voice_lookup_api.voice_read_verify_otp(t text,cid text,ph text,hashed text) returns jsonb
language sql security definer set search_path='' as $$
  select sms_private.voice_read_verify_otp(t,cid,ph,hashed);
$$;
create function voice_lookup_api.voice_read_customer(t text,cid text,ph text) returns jsonb
language sql stable security definer set search_path='' as $$
  select sms_private.voice_read_customer(t,cid,ph);
$$;
revoke all on all functions in schema voice_lookup_api from public,anon,authenticated,service_role;
grant execute on all functions in schema voice_lookup_api to sms_voice_lookup;
