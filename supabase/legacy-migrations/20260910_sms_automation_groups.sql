create table if not exists public.sms_automation_groups (
  tenant_id text not null,
  id text not null,
  name text not null check (char_length(name) between 1 and 100),
  description text not null default '',
  active boolean not null default true,
  rule jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, id),
  constraint sms_automation_groups_custom_id
    check (id ~ '^custom-[a-z0-9_-]+-[a-z0-9-]+-[a-f0-9]{8}$'),
  constraint sms_automation_groups_rule_object
    check (jsonb_typeof(rule) = 'object')
);

create index if not exists sms_automation_groups_active_tenant_idx
  on public.sms_automation_groups (tenant_id, active, created_at);

alter table public.sms_automation_groups enable row level security;

comment on table public.sms_automation_groups is
  'Tenant-scoped custom SMS automation definitions. Accessed only by the server service role.';

create table if not exists public.sms_automation_group_ai_settings (
  tenant_id text not null,
  group_id text not null,
  enabled boolean not null default false,
  instructions text not null default '' check (char_length(instructions) <= 6000),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, group_id)
);

alter table public.sms_automation_group_ai_settings enable row level security;

comment on table public.sms_automation_group_ai_settings is
  'Administrator-authored AI behavior instructions for system and custom automation groups.';
