create table public.pricing_catalog (
  code text primary key check (code ~ '^[a-z][a-z0-9_]{1,63}$'),
  label text not null check (char_length(label) between 1 and 120),
  amount_cents integer not null check (amount_cents > 0),
  currency text not null default 'USD' check (currency = 'USD'),
  billing_interval text not null default 'month' check (billing_interval = 'month'),
  qualifier text not null check (qualifier in ('exact', 'starting_at')),
  active boolean not null default true,
  display_order smallint not null check (display_order > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

insert into public.pricing_catalog
  (code, label, amount_cents, qualifier, display_order)
values
  ('full_system', 'Full system (includes all tools)', 99700, 'exact', 1),
  ('individual_products', 'Individual products', 29700, 'starting_at', 2);

create table public.pricing_requests (
  id uuid primary key,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  name text not null check (char_length(name) between 1 and 120),
  email text not null check (char_length(email) between 3 and 254),
  phone_e164 text not null check (phone_e164 ~ '^\+1[2-9][0-9]{9}$'),
  service_type text not null check (service_type in ('full-system', 'voice-agents', 'sms-automation', 'managed-website', 'not-sure')),
  needs text[] not null check (cardinality(needs) between 1 and 7),
  other_need text check (other_need is null or char_length(other_need) <= 160),
  sms_consent boolean not null check (sms_consent),
  consent_version text not null check (consent_version = 'pricing-sms-v1'),
  consent_evidence text not null,
  source text not null default 'e2-pricing-page' check (source = 'e2-pricing-page'),
  ip_hash text not null check (ip_hash ~ '^[a-f0-9]{64}$'),
  pricing_snapshot jsonb not null,
  sms_status text not null default 'pending' check (sms_status in ('pending', 'queued', 'blocked', 'rate_limited', 'unavailable')),
  sms_message_id uuid,
  sms_job_id uuid,
  sms_error_code text
);

create index pricing_requests_phone_created_idx
  on public.pricing_requests (phone_e164, created_at desc);
create index pricing_requests_ip_created_idx
  on public.pricing_requests (ip_hash, created_at desc);

alter table public.pricing_catalog enable row level security;
alter table public.pricing_requests enable row level security;

revoke all on public.pricing_catalog from public, anon, authenticated;
revoke all on public.pricing_requests from public, anon, authenticated;

create function public.submit_pricing_request(input jsonb) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  request_id uuid;
  request_name text;
  request_email text;
  request_phone text;
  request_service text;
  request_needs text[];
  request_other text;
  request_ip_hash text;
  request_consent boolean;
  request_evidence text;
  snapshot jsonb;
  existing public.pricing_requests;
  sms_result jsonb;
  final_status text := 'pending';
  error_code text;
  full_amount integer;
  individual_amount integer;
begin
  request_id := nullif(input->>'requestId', '')::uuid;
  request_name := trim(coalesce(input->>'name', ''));
  request_email := lower(trim(coalesce(input->>'email', '')));
  request_phone := trim(coalesce(input->>'phone', ''));
  request_service := trim(coalesce(input->>'serviceType', ''));
  request_other := nullif(trim(coalesce(input->>'otherNeed', '')), '');
  request_ip_hash := lower(trim(coalesce(input->>'ipHash', '')));
  request_consent := coalesce((input->>'smsConsent')::boolean, false);
  request_evidence := trim(coalesce(input->>'consentEvidence', ''));

  if request_id is null then raise exception 'Valid request ID required'; end if;
  if char_length(request_name) not between 1 and 120 then raise exception 'Valid name required'; end if;
  if char_length(request_email) not between 3 and 254 or request_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then
    raise exception 'Valid email required';
  end if;
  if request_phone !~ '^\+1[2-9][0-9]{9}$' then raise exception 'Valid US or Canadian phone required'; end if;
  if request_service not in ('full-system', 'voice-agents', 'sms-automation', 'managed-website', 'not-sure') then
    raise exception 'Valid service type required';
  end if;
  if jsonb_typeof(input->'needs') <> 'array' then raise exception 'Select at least one need'; end if;

  select array_agg(value order by value) into request_needs
  from (select distinct jsonb_array_elements_text(input->'needs') as value) selected
  where value in ('customers', 'missed-calls', 'website', 'follow-up', 'booking', 'disconnected-tools', 'other');

  if coalesce(cardinality(request_needs), 0) <> jsonb_array_length(input->'needs')
     or cardinality(request_needs) not between 1 and 7 then
    raise exception 'Invalid needs selection';
  end if;
  if request_other is not null and char_length(request_other) > 160 then raise exception 'Other need is too long'; end if;
  if not request_consent then raise exception 'SMS consent is required'; end if;
  if request_evidence <> 'pricing-sms-v1' then raise exception 'Consent evidence is invalid'; end if;
  if request_ip_hash !~ '^[a-f0-9]{64}$' then raise exception 'Request fingerprint is invalid'; end if;

  select * into existing from public.pricing_requests where id = request_id;
  if found then
    return jsonb_build_object(
      'requestId', existing.id,
      'prices', existing.pricing_snapshot,
      'smsStatus', existing.sms_status
    );
  end if;

  if (select count(*) from public.pricing_requests where ip_hash = request_ip_hash and created_at > now() - interval '1 hour') >= 10 then
    raise exception 'Too many pricing requests. Please try again later.' using errcode = 'P0001';
  end if;

  select jsonb_agg(jsonb_build_object(
    'code', code,
    'label', label,
    'amountCents', amount_cents,
    'currency', currency,
    'billingInterval', billing_interval,
    'qualifier', qualifier
  ) order by display_order)
  into snapshot
  from public.pricing_catalog
  where active;

  if jsonb_array_length(coalesce(snapshot, '[]'::jsonb)) <> 2 then
    raise exception 'Pricing is temporarily unavailable';
  end if;
  select amount_cents into strict full_amount from public.pricing_catalog where code = 'full_system' and active;
  select amount_cents into strict individual_amount from public.pricing_catalog where code = 'individual_products' and active;

  if exists (
    select 1 from public.pricing_requests
    where phone_e164 = request_phone and sms_status = 'queued'
      and created_at > now() - interval '15 minutes'
  ) or (
    select count(*) from public.pricing_requests
    where phone_e164 = request_phone and sms_status = 'queued'
      and created_at > now() - interval '1 day'
  ) >= 3 then
    final_status := 'rate_limited';
  end if;

  insert into public.pricing_requests (
    id, name, email, phone_e164, service_type, needs, other_need,
    sms_consent, consent_version, consent_evidence, ip_hash,
    pricing_snapshot, sms_status
  ) values (
    request_id, request_name, request_email, request_phone, request_service, request_needs, request_other,
    true, 'pricing-sms-v1', request_evidence, request_ip_hash,
    snapshot, final_status
  );

  if final_status = 'pending' then
    begin
      insert into public.sms_contacts (tenant_id, phone, name, email, source, marketing_consent, metadata)
      values (
        'e2-local', request_phone, request_name, request_email, 'e2-pricing', false,
        jsonb_build_object('pricingRequestId', request_id, 'serviceType', request_service, 'needs', to_jsonb(request_needs))
      )
      on conflict (tenant_id, phone) do update set
        name = excluded.name,
        email = excluded.email,
        source = excluded.source,
        metadata = public.sms_contacts.metadata || excluded.metadata,
        updated_at = now();

      sms_result := sms_private.outbox(
        'e2-local',
        'pricing-request:' || request_id,
        jsonb_build_object(
          'phone', request_phone,
          'body', format(
            'E2 Local: Full system (all tools) is $%s/month. Individual products start at $%s/month. Reply STOP to opt out.',
            regexp_replace(to_char(full_amount / 100.0, 'FM999999990.00'), '\.00$', ''),
            regexp_replace(to_char(individual_amount / 100.0, 'FM999999990.00'), '\.00$', '')
          ),
          'purpose', 'transactional',
          'category_id', null,
          'pricing_request_id', request_id
        )
      );
      final_status := 'queued';
    exception when others then
      get stacked diagnostics error_code = returned_sqlstate;
      final_status := case when error_code = '42501' then 'blocked' else 'unavailable' end;
    end;
  end if;

  update public.pricing_requests set
    sms_status = final_status,
    sms_message_id = nullif(sms_result->>'messageId', '')::uuid,
    sms_job_id = nullif(sms_result->>'jobId', '')::uuid,
    sms_error_code = error_code,
    updated_at = now()
  where id = request_id;

  return jsonb_build_object(
    'requestId', request_id,
    'prices', snapshot,
    'smsStatus', final_status
  );
end
$$;

revoke all on function public.submit_pricing_request(jsonb) from public, anon, authenticated;
grant execute on function public.submit_pricing_request(jsonb) to service_role;

comment on table public.pricing_catalog is
  'Authoritative E2 Local website pricing. Changes are applied only through reviewed database migrations.';
comment on table public.pricing_requests is
  'E2 Local pricing requests and the exact authoritative pricing shown and texted for each request.';
comment on function public.submit_pricing_request(jsonb) is
  'Validates and stores one E2 pricing request, then queues the database-authored transactional pricing SMS.';
