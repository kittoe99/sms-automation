-- Backend provisioning registry only. This does NOT migrate existing CRM tables
-- or enable multiple active businesses. Keep the application isolation guard on.
begin;

create table if not exists public.sms_business_accounts (
  id text primary key check (id ~ '^[a-z0-9][a-z0-9_-]{0,63}$'),
  name text not null check (char_length(name) between 1 and 100),
  short_name text not null,
  time_zone text not null default 'America/Denver',
  clerk_organization_id text not null unique,
  status text not null default 'pending' check (status in ('pending', 'active', 'inactive')),
  twilio_state text not null default 'not_provisioned' check (twilio_state in (
    'not_provisioned', 'subaccount_provisioning', 'subaccount_unknown',
    'subaccount_created', 'service_provisioning', 'service_unknown', 'ready'
  )),
  twilio_account_sid text unique check (twilio_account_sid ~ '^AC[0-9a-fA-F]{32}$'),
  twilio_credentials_encrypted text,
  twilio_messaging_service_sid text unique check (twilio_messaging_service_sid ~ '^MG[0-9a-fA-F]{32}$'),
  twilio_from_number text unique,
  twilio_error_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint sms_business_twilio_credentials_pair check (
    (twilio_account_sid is null) = (twilio_credentials_encrypted is null)
  ),
  constraint sms_business_twilio_ready check (
    twilio_state <> 'ready' or (twilio_account_sid is not null and twilio_messaging_service_sid is not null)
  )
);

alter table public.sms_business_accounts enable row level security;
revoke all privileges on table public.sms_business_accounts from public, anon, authenticated;
grant all privileges on table public.sms_business_accounts to service_role;
comment on table public.sms_business_accounts is
  'Platform-only business provisioning registry. Twilio secrets use AES-256-GCM, bound to business id and Account SID. No browser access.';

commit;
