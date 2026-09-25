create function sms_private.dispatch_email_edge() returns integer
language plpgsql security definer set search_path='' as $$
declare bearer text; request_id bigint; queued integer;
begin
  insert into sms_private.email_jobs(enrollment_id,step_index,generation,due_at)
    select e.id,e.step_index,e.generation,e.next_run_at
      from sms_private.email_enrollments e
      join sms_private.email_group_settings s on s.tenant_id=e.tenant_id and s.group_id=e.group_id
      where e.status='active' and e.next_run_at<=now() and s.enabled
      order by e.next_run_at,e.id limit 100
      on conflict do nothing;
  if not exists(select from sms_private.email_jobs where status='pending' and due_at<=now()) then return 0; end if;
  select v.decrypted_secret into bearer from sms_private.edge_config c
    join vault.decrypted_secrets v on v.id=c.secret_id
    where c.queue='automation_jobs' and c.enabled;
  if bearer is null then return 0; end if;
  select net.http_post(
    url:='https://wxamwhfmelxqahkdtcci.supabase.co/functions/v1/email-worker',
    headers:=jsonb_build_object('Authorization','Bearer '||bearer,'Content-Type','application/json'),
    body:='{}'::jsonb,timeout_milliseconds:=30000) into request_id;
  return 1;
end $$;
