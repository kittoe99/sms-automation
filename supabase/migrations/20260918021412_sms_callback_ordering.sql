create or replace function sms_private.delivery_failure() returns trigger language plpgsql security definer set search_path='' as $$
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
