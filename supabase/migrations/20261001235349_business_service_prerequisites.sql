-- Apply before E2 Local's business_registration_services migration.
-- Legacy tenants retain their templates; new registered businesses defer setup.
alter table public.sms_businesses add column managed_setup boolean not null default false;
alter table public.sms_businesses drop constraint sms_businesses_name_check;
alter table public.sms_businesses add constraint sms_businesses_name_check
  check(length(btrim(name)) between 1 and 160);

create or replace function sms_private.seed_fixed_automation_groups_on_business() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  if not new.managed_setup then perform sms_private.seed_fixed_automation_groups(new.tenant_id); end if;
  return new;
end $$;
create or replace function sms_private.seed_web_forms_on_business() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  if not new.managed_setup then perform sms_private.seed_web_forms(new.tenant_id); end if;
  return new;
end $$;

-- Internal primitive: only the authenticated E2 platform action calls this.
-- No customer role or API login can invoke it directly.
create function sms_private.initialize_business_service(t text,k text) returns void
language plpgsql security definer set search_path='' as $$
begin
  if k not in ('sms','enquiries','bookings') then raise exception 'Unknown service'; end if;
  perform 1 from public.sms_businesses where tenant_id=t for update;
  if not found then raise exception 'Business not found'; end if;
  perform sms_private.seed_fixed_automation_groups(t);
  if k in ('sms','enquiries') then perform sms_private.seed_web_forms(t); end if;
  if k='sms' then
    -- The existing insert trigger queues exactly one bootstrap job.
    insert into sms_private.providers(tenant_id) values(t) on conflict(tenant_id) do nothing;
  end if;
end $$;
revoke all on function sms_private.initialize_business_service(text,text) from public,anon,authenticated,sms_api,service_role;

-- Existing profile approval stays authoritative; retain its other validation.
do $$ declare d text; begin
  d:=pg_get_functiondef('sms_private.validate_business_facts(jsonb)'::regprocedure);
  if position('not between 1 and 120' in d)=0 then raise exception 'Review business-name validator before migration'; end if;
  execute replace(d,'not between 1 and 120','not between 1 and 160');
end $$;
