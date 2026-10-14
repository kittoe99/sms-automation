-- One-time schema changes for 20261014061007. Never replay.
alter table sms_private.email_enrollments drop constraint email_enrollments_status_check;
alter table sms_private.email_enrollments add constraint email_enrollments_status_check
 check(status in ('active','paused','resolved','cancelled','unsubscribed','completed'));
alter table sms_private.email_enrollments add column pause_reason text;
create table sms_private.email_scheduler_state (
 tenant_id text primary key references public.sms_businesses(tenant_id) on delete cascade,
 dispatched_at timestamptz not null default '-infinity', claimed_at timestamptz not null default '-infinity'
);
alter table sms_private.email_scheduler_state enable row level security;
revoke all on sms_private.email_scheduler_state from public,anon,authenticated,sms_api,sms_sender,sms_ai,sms_automation;
create index email_pending_enrollment on sms_private.email_jobs(enrollment_id,due_at,id) where status='pending';
create index email_enrollment_tenant on sms_private.email_enrollments(tenant_id,id);
-- Maintained current queue/reporting definitions. Forward migration only.
-- Requires all CRM migrations through voice_setup_flow and the existing paired
-- E2 registration/access/cache baseline. Never replay either repository history.

create index email_job_expired on sms_private.email_jobs(lease_until,id) where status='processing';

create index email_job_uncertain on sms_private.email_jobs(send_started_at,id) where status='pending' and send_started_at is not null;

create index sms_heartbeat_age on sms_private.heartbeats(seen_at);

create index sms_heartbeat_queue on sms_private.heartbeats(queue,seen_at desc);

create index sms_inbound_last on public.sms_messages(tenant_id,contact_phone,created_at desc) where direction='inbound';

create index sms_agent_last on public.sms_messages(tenant_id,contact_phone,provider_accepted_at desc)
 where direction='outbound' and provider_accepted_at is not null and meta->>'agent_version'='sms-agent-v1';

create index sms_agent_pending_phone on sms_private.jobs(tenant_id,(payload->>'phone'))
 where queue='ai_reply_jobs' and status in ('queued','retry','processing');

create index sms_agent_outbound_phone on sms_private.jobs(tenant_id,(payload->'request'->>'phone'))
 where queue='sms_send_jobs' and status in ('queued','retry','processing','submitting','submission_unknown');

-- This narrow projection makes date/cohort selection independent of all message
-- history. It is private and updated in the same transaction as message changes.
create table sms_private.activity_first_contacts (
 run_id uuid primary key references sms_private.form_runs(id) on delete cascade,
 tenant_id text not null references public.sms_businesses(tenant_id), accepted_at timestamptz not null
);

alter table sms_private.activity_first_contacts enable row level security;

revoke all on sms_private.activity_first_contacts from public,anon,authenticated,sms_api,sms_sender,sms_ai,sms_automation;

create index activity_first_contacts_date on sms_private.activity_first_contacts(tenant_id,accepted_at,run_id);

create table sms_private.automation_scheduler_state (
 tenant_id text primary key references public.sms_businesses(tenant_id) on delete cascade,
 checked_at timestamptz not null default '-infinity', cursor_due timestamptz, cursor_id uuid
);

alter table sms_private.automation_scheduler_state enable row level security;

revoke all on sms_private.automation_scheduler_state from public,anon,authenticated,sms_api,sms_sender,sms_ai,sms_automation;

create index form_runs_tenant_due on sms_private.form_runs(tenant_id,next_run_at,id) where status='active';
