create index if not exists sms_audit_actor_time on sms_private.audit(actor,created_at desc);
create index if not exists sms_events_message on public.sms_message_events(tenant_id,message_id,created_at desc);
create index if not exists sms_enrollments_contact on public.sms_automation_enrollments(tenant_id,contact_id);
create index if not exists sms_jobs_lease on sms_private.jobs(leased_until) where status in ('processing','submitting');
create index if not exists sms_jobs_tenant_status on sms_private.jobs(tenant_id,status,created_at);

create function sms_private.attempt_outcome() returns trigger language plpgsql security definer set search_path='' as $$
begin
 if new.queue='sms_send_jobs' and old.status='submitting' and new.status in ('retry','failed','submission_unknown') then
   update sms_private.attempts set state=case when new.status='submission_unknown' then 'unknown' else 'rejected' end
   where job_id=new.id and lease_token=old.lease_token and sid is null;
 end if;
 return new;
end $$;
drop trigger if exists sms_attempt_outcome on sms_private.jobs;
create trigger sms_attempt_outcome after update of status on sms_private.jobs for each row execute function sms_private.attempt_outcome();
revoke all on function sms_private.attempt_outcome() from public,anon,authenticated;

create function sms_private.delivery_failure() returns trigger language plpgsql security definer set search_path='' as $$
declare current_status text;
begin
 if new.status in ('failed','undelivered') then
   select status into current_status from public.sms_messages
   where tenant_id=new.tenant_id and id=new.message_id for update;
   if sms_private.status_rank(current_status)>=sms_private.status_rank(new.status) then return new; end if;
   update public.sms_automation_enrollments e set status='paused',generation=e.generation+1
   from sms_private.jobs j where j.tenant_id=new.tenant_id and j.payload->>'message_id'=new.message_id::text
   and e.tenant_id=j.tenant_id and e.id=(j.payload->'request'->>'enrollment_id')::uuid
   and e.generation=(j.payload->'request'->>'enrollment_generation')::bigint and e.status='active';
 end if;
 return new;
end $$;
drop trigger if exists sms_delivery_failure on public.sms_message_events;
create trigger sms_delivery_failure after insert on public.sms_message_events for each row execute function sms_private.delivery_failure();
revoke all on function sms_private.delivery_failure() from public,anon,authenticated;
