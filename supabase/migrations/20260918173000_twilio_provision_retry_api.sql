create function sms_private.queue_provision(u text,t text) returns jsonb
language plpgsql security definer set search_path='' as $$
#variable_conflict use_column
declare jid uuid; job_status text;
begin
  perform sms_private.require_admin(u);
  if not exists(select from public.sms_businesses where tenant_id=t) then raise exception 'Unknown business'; end if;
  jid:=sms_private.enqueue(t,'provisioning_jobs','twilio-bootstrap:v1',
    jsonb_build_object('name',(select name from public.sms_businesses where tenant_id=t),'operation','bootstrap'));
  select status into strict job_status from sms_private.jobs where id=jid;
  return jsonb_build_object('jobId',jid,'status',job_status);
end $$;

revoke all on function sms_private.queue_provision(text,text) from public,anon,authenticated;
grant execute on function sms_private.queue_provision(text,text) to sms_api;
