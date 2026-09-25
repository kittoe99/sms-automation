create function sms_private.email_claim() returns jsonb
language plpgsql security definer set search_path='' as $$
#variable_conflict use_column
declare j sms_private.email_jobs;
begin
  if not pg_has_role(session_user,'sms_automation','member') then raise exception 'Worker role denied' using errcode='42501'; end if;
  update sms_private.email_jobs set
    status=case when send_started_at is null or send_started_at>now()-interval '23 hours'
      then 'pending' else 'uncertain' end,
    error_code=case when send_started_at is null or send_started_at>now()-interval '23 hours'
      then 'LEASE_EXPIRED' else 'PROVIDER_OUTCOME_UNKNOWN' end,
    lease_token=null,lease_until=null,updated_at=now()
    where status='processing' and lease_until<now();
  select * into j from sms_private.email_jobs where status='pending' and due_at<=now()
    order by due_at,id limit 1 for update skip locked;
  if not found then return null; end if;
  update sms_private.email_jobs set status='processing',attempts=attempts+1,
    lease_token=gen_random_uuid(),lease_until=now()+interval '90 seconds',updated_at=now()
    where id=j.id returning * into j;
  return to_jsonb(j);
end $$;

create function sms_private.email_job_context(jid uuid,token uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
#variable_conflict use_column
declare j sms_private.email_jobs; e sms_private.email_enrollments;
  source_row jsonb; tab text;
begin
  if not pg_has_role(session_user,'sms_automation','member') then raise exception 'Worker role denied' using errcode='42501'; end if;
  select * into strict j from sms_private.email_jobs where id=jid and lease_token=token
    and status='processing' and lease_until>now();
  select * into strict e from sms_private.email_enrollments where id=j.enrollment_id;
  tab:=sms_private.intake_table(e.source_type);
  execute format('select to_jsonb(x) from public.%I x where tenant_id=$1 and id=$2',tab)
    into source_row using e.tenant_id,e.source_id;
  return jsonb_build_object('job',to_jsonb(j),'enrollment',to_jsonb(e),
    'settings',(select to_jsonb(s) from sms_private.email_group_settings s
      where s.tenant_id=e.tenant_id and s.group_id=e.group_id),
    'business',(select jsonb_build_object('name',b.name,'timeZone',b.time_zone)
      from public.sms_businesses b where b.tenant_id=e.tenant_id),
    'source',source_row,
    'group',(select jsonb_build_object('name',g.name,'fixedType',g.fixed_type)
      from public.sms_automation_groups g where g.tenant_id=e.tenant_id and g.id=e.group_id));
end $$;

create function sms_private.email_save_draft(jid uuid,token uuid,sub text,content text) returns jsonb
language plpgsql security definer set search_path='' as $$
#variable_conflict use_column
declare j sms_private.email_jobs;
begin
  if not pg_has_role(session_user,'sms_automation','member') then raise exception 'Worker role denied' using errcode='42501'; end if;
  if length(btrim(sub)) not between 1 and 200 or sub ~ '[\r\n]'
    or length(btrim(content)) not between 1 and 10000 then raise exception 'Invalid email draft'; end if;
  update sms_private.email_jobs set subject=coalesce(subject,btrim(sub)),
    body=coalesce(body,btrim(content)),updated_at=now()
    where id=jid and lease_token=token and status='processing' and lease_until>now()
    returning * into j;
  if j.id is null then raise exception 'Email job lease expired'; end if;
  return to_jsonb(j);
end $$;

create function sms_private.email_save_payload(jid uuid,token uuid,p jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
#variable_conflict use_column
declare j sms_private.email_jobs; e sms_private.email_enrollments;
  s sms_private.email_group_settings;
begin
  if not pg_has_role(session_user,'sms_automation','member') then raise exception 'Worker role denied' using errcode='42501'; end if;
  select * into strict j from sms_private.email_jobs where id=jid and lease_token=token
    and status='processing' and lease_until>now() for update;
  select * into strict e from sms_private.email_enrollments where id=j.enrollment_id;
  select * into strict s from sms_private.email_group_settings where tenant_id=e.tenant_id and group_id=e.group_id;
  if jsonb_typeof(p)<>'object' or length(p::text)>30000
    or p->>'to'<>e.email or p->>'from'<>s.sender or p->>'reply_to'<>s.reply_to
    or p->>'subject'<>j.subject or coalesce(length(p->>'html'),0)<100
    or coalesce(length(p->>'text'),0)<20 then raise exception 'Invalid email payload'; end if;
  update sms_private.email_jobs set provider_payload=coalesce(provider_payload,p),updated_at=now()
    where id=jid returning * into j;
  return to_jsonb(j);
end $$;

create function sms_private.email_before_send(jid uuid,token uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
#variable_conflict use_column
declare j sms_private.email_jobs; e sms_private.email_enrollments;
  s sms_private.email_group_settings; source_status text;
begin
  if not pg_has_role(session_user,'sms_automation','member') then raise exception 'Worker role denied' using errcode='42501'; end if;
  select * into strict j from sms_private.email_jobs where id=jid and lease_token=token
    and status='processing' and lease_until>now() for update;
  select * into strict e from sms_private.email_enrollments where id=j.enrollment_id for update;
  select * into s from sms_private.email_group_settings where tenant_id=e.tenant_id and group_id=e.group_id;
  if e.source_type='bookings' then
    select status into source_status from public.sms_automation_bookings
      where tenant_id=e.tenant_id and id=e.source_id;
  end if;
  if e.status<>'active' or e.generation<>j.generation or e.step_index<>j.step_index
    or not coalesce(s.enabled,false) or j.subject is null or j.body is null or j.provider_payload is null
    or exists(select from sms_private.email_suppressions where tenant_id=e.tenant_id and email=e.email)
    or (e.form_public_id is not null and not exists(select from public.sms_web_form_definitions
      where tenant_id=e.tenant_id and public_id=e.form_public_id and email_enabled and enabled))
    or (e.source_type='bookings' and (source_status<>'confirmed' or e.appointment_at<=now())) then
    update sms_private.email_jobs set status='cancelled',lease_token=null,lease_until=null,
      error_code='INELIGIBLE',updated_at=now() where id=jid;
    return null;
  end if;
  update sms_private.email_jobs set send_started_at=coalesce(send_started_at,now()),updated_at=now()
    where id=jid returning * into j;
  return jsonb_build_object('job',to_jsonb(j),'enrollment',to_jsonb(e),'settings',to_jsonb(s));
end $$;

create function sms_private.email_finish(jid uuid,token uuid,outcome text,provider text default null,
  code text default null) returns void
language plpgsql security definer set search_path='' as $$
#variable_conflict use_column
declare j sms_private.email_jobs; e sms_private.email_enrollments; b public.sms_businesses;
  due timestamptz;
begin
  if not pg_has_role(session_user,'sms_automation','member') then raise exception 'Worker role denied' using errcode='42501'; end if;
  select * into strict j from sms_private.email_jobs where id=jid and lease_token=token
    and status='processing' and lease_until>now() for update;
  if outcome not in ('sent','retry','failed','uncertain') then raise exception 'Invalid email outcome'; end if;
  update sms_private.email_jobs set
    status=case when outcome='retry' and attempts<5 then 'pending'
      when outcome='retry' then 'failed' else outcome end,
    due_at=case when outcome='retry' then now()+make_interval(secs=>least(3600,30*(2^attempts)::integer)) else due_at end,
    provider_id=coalesce(provider_id,provider),error_code=code,
    lease_token=null,lease_until=null,updated_at=now() where id=jid;
  if outcome<>'sent' then return; end if;
  select * into e from sms_private.email_enrollments where id=j.enrollment_id for update;
  if e.status<>'active' or e.generation<>j.generation then return; end if;
  select * into b from public.sms_businesses where tenant_id=e.tenant_id;
  if e.step_index+1 >= (e.rule_snapshot->>'repeatCount')::integer then
    update sms_private.email_enrollments set status='completed',step_index=step_index+1,
      next_run_at=null,updated_at=now() where id=e.id;
  else
    due:=sms_private.automation_due(now(),e.rule_snapshot,b.time_zone,false);
    if e.appointment_at is not null and due>=e.appointment_at then
      update sms_private.email_enrollments set status='completed',step_index=step_index+1,
        next_run_at=null,updated_at=now() where id=e.id;
    else
      update sms_private.email_enrollments set step_index=step_index+1,
        next_run_at=due,updated_at=now() where id=e.id;
    end if;
  end if;
end $$;

create function sms_private.email_retry(u text,t text,jid uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare j sms_private.email_jobs;
begin
  perform sms_private.require_web_form_editor(u,t);
  update sms_private.email_jobs x set status='pending',due_at=now(),error_code=null,updated_at=now()
    from sms_private.email_enrollments e where x.id=jid and x.enrollment_id=e.id
      and e.tenant_id=t and e.status='active' and x.status='failed'
      and (x.send_started_at is null or x.send_started_at>now()-interval '23 hours')
    returning x.* into j;
  if j.id is null then raise exception 'Email job cannot be retried safely'; end if;
  return to_jsonb(j);
end $$;
