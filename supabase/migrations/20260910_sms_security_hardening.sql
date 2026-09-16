-- Keep service-owned SMS data behind the authenticated application API.
-- The Supabase service_role retains BYPASSRLS; browser roles receive no direct access.

alter table if exists public.crm_admins enable row level security;
alter table if exists public.sms_messages enable row level security;
alter table if exists public.sms_thread_contacts enable row level security;
alter table if exists public.sms_automation_enrollments enable row level security;
alter table if exists public.sms_voice_conversations enable row level security;
alter table if exists public.sms_automation_groups enable row level security;
alter table if exists public.sms_automation_group_ai_settings enable row level security;

do $hardening$
declare
  table_name text;
  function_signature regprocedure;
begin
  foreach table_name in array array[
    'crm_admins',
    'sms_messages',
    'sms_thread_contacts',
    'sms_automation_enrollments',
    'sms_voice_conversations',
    'sms_automation_groups',
    'sms_automation_group_ai_settings'
  ]
  loop
    if to_regclass(format('public.%I', table_name)) is not null then
      execute format(
        'revoke all privileges on table public.%I from anon, authenticated',
        table_name
      );
      execute format(
        'grant all privileges on table public.%I to service_role',
        table_name
      );
    end if;
  end loop;

  -- PostgreSQL grants EXECUTE on new functions to PUBLIC by default. These RPCs
  -- expose cross-table CRM data and must be callable only by the server.
  for function_signature in
    select p.oid::regprocedure
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('sms_crm_list_contacts', 'sms_crm_enroll_contact')
  loop
    execute format(
      'revoke all privileges on function %s from public, anon, authenticated',
      function_signature
    );
    execute format(
      'grant execute on function %s to service_role',
      function_signature
    );
  end loop;
end
$hardening$;
