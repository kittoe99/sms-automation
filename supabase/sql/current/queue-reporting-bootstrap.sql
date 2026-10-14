-- One-time trigger installation and acceptance backfill for 20261014061007. Never replay.
insert into sms_private.email_scheduler_state(tenant_id) select distinct tenant_id from sms_private.email_enrollments on conflict do nothing;
create trigger email_scheduler_seed after insert on sms_private.email_enrollments for each row execute function sms_private.email_scheduler_seed();
insert into sms_private.activity_first_contacts(run_id,tenant_id,accepted_at)
 select r.id,r.tenant_id,min(m.provider_accepted_at) from sms_private.form_runs r
 join public.sms_messages m on m.tenant_id=r.tenant_id and m.meta->>'form_run_id'=r.id::text
 where m.provider_accepted_at is not null group by r.id,r.tenant_id;

create trigger activity_first_contact_changed after insert or delete or update of provider_accepted_at,meta on public.sms_messages
 for each row execute function sms_private.activity_first_contact_changed();

create trigger queue_heartbeat before insert on sms_private.heartbeats for each row execute function sms_private.queue_heartbeat();

create trigger email_form_disabled after update of enabled,email_enabled,archived on public.sms_web_form_definitions
 for each row execute function sms_private.email_form_disabled();
