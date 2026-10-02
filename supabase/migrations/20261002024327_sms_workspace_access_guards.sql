-- Apply before E2 20261002024330_canonical_crm_access_profiles.
-- Reader authorization uses can_access, including its paired canonical override.
create function sms_private.require_sms_reader(u text,t text) returns void
language plpgsql security definer set search_path='' as $$
begin
  if not sms_private.can_access(t,u) then raise exception 'Business access required' using errcode='42501'; end if;
  if not exists(select from public.sms_businesses where tenant_id=t) then raise exception 'Unknown business'; end if;
end $$;
revoke all on function sms_private.require_sms_reader(text,text) from public,anon,authenticated,sms_api,service_role;

-- Change only read entry points. Operational mutations keep require_admin.
do $$ declare n text; d text; begin
  foreach n in array array['api_read_legacy','api_read_before_group_ai','list_intake','list_bookings','booking_detail'] loop
    select pg_get_functiondef(p.oid) into strict d from pg_proc p join pg_namespace s on s.oid=p.pronamespace
      where s.nspname='sms_private' and p.proname=n;
    if position('perform sms_private.require_admin(u);' in d)=0 then raise exception 'Review read guard for %',n; end if;
    if n='api_read_legacy' then
      d:=replace(d,'perform sms_private.require_admin(u);',
        'if resource=''operations'' then perform sms_private.require_admin(u); elsif resource<>''businesses'' then perform sms_private.require_sms_reader(u,t); end if;');
      d:=replace(d,'from public.sms_businesses b),','from public.sms_businesses b where sms_private.can_access(b.tenant_id,u)),');
    else d:=replace(d,'perform sms_private.require_admin(u);','perform sms_private.require_sms_reader(u,t);'); end if;
    execute d;
  end loop;
end $$;

-- Registration intentionally has no provider. Do not queue doomed jobs or report
-- a successful setup-detail save until explicit service addition creates one.
create function sms_private.require_sms_provider(t text) returns void
language plpgsql security definer set search_path='' as $$
begin
  perform 1 from public.sms_businesses where tenant_id=t for update;
  if not found then raise exception 'Unknown business'; end if;
  if not exists(select from sms_private.providers where tenant_id=t) then
    raise exception 'Add the SMS service from Businesses before configuring or retrying it';
  end if;
end $$;
revoke all on function sms_private.require_sms_provider(text) from public,anon,authenticated,sms_api,service_role;
do $$ declare n text; d text; begin
  foreach n in array array['queue_provision','save_provider_setup'] loop
    select pg_get_functiondef(p.oid) into strict d from pg_proc p join pg_namespace s on s.oid=p.pronamespace
      where s.nspname='sms_private' and p.proname=n;
    if position('perform sms_private.require_admin(u);' in d)=0 then raise exception 'Review provider guard for %',n; end if;
    execute replace(d,'perform sms_private.require_admin(u);',
      'perform sms_private.require_admin(u); perform sms_private.require_sms_provider(t);');
  end loop;
end $$;
alter function sms_private.provider_setup(text,text) rename to provider_setup_before_service_guard;
revoke all on function sms_private.provider_setup_before_service_guard(text,text) from public,anon,authenticated,sms_api,service_role;
create function sms_private.provider_setup(u text,t text) returns jsonb
language plpgsql security definer set search_path='' as $$
begin
  return sms_private.provider_setup_before_service_guard(u,t)||jsonb_build_object(
    'serviceAdded',exists(select from sms_private.providers where tenant_id=t));
end $$;
revoke all on function sms_private.provider_setup(text,text) from public,anon,authenticated,service_role;
grant execute on function sms_private.provider_setup(text,text) to sms_api;
