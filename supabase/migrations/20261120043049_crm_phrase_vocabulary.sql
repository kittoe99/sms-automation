-- Account-owned library, available to the CRM API through the staff check.
-- The paired E2 account schema is installed after CRM migrations in offline fixtures.
create table sms_private.crm_phrase_libraries (
  account_id uuid primary key,
  revision bigint not null check (revision > 0),
  categories jsonb not null check (jsonb_typeof(categories) = 'array')
);

alter table sms_private.crm_phrase_libraries enable row level security;
revoke all on sms_private.crm_phrase_libraries from public, anon, authenticated, sms_api;

create function sms_private.crm_phrase_vocabulary(u text, expected bigint, contents jsonb)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  owner_id uuid;
  library sms_private.crm_phrase_libraries%rowtype;
begin
  perform sms_private.require_admin(u);
  owner_id := sms_private.platform_actor(u);

  if expected is null and contents is null then
    select * into library from sms_private.crm_phrase_libraries where account_id = owner_id;
    return jsonb_build_object('version', 1, 'revision', coalesce(library.revision, 0),
      'categories', coalesce(library.categories, '[]'::jsonb));
  end if;

  if expected is null or expected < 0 or jsonb_typeof(contents->'categories') is distinct from 'array' then
    raise exception 'Invalid library' using errcode = '22023';
  end if;

  if expected = 0 then
    insert into sms_private.crm_phrase_libraries (account_id, revision, categories)
    values (owner_id, 1, contents->'categories')
    on conflict (account_id) do nothing
    returning * into library;
  else
    update sms_private.crm_phrase_libraries
    set categories = contents->'categories', revision = revision + 1
    where account_id = owner_id and revision = expected
    returning * into library;
  end if;
  if not found then
    raise exception 'The library changed since you opened it.' using errcode = '40001';
  end if;
  return jsonb_build_object('version', 1, 'revision', library.revision, 'categories', library.categories);
end
$$;

revoke all on function sms_private.crm_phrase_vocabulary(text, bigint, jsonb)
from public, anon, authenticated, service_role;
grant execute on function sms_private.crm_phrase_vocabulary(text, bigint, jsonb) to sms_api;
