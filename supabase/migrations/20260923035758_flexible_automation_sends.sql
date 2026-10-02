-- Allow a configurable number of fresh AI sends in every automation group.
do $$ begin
  if exists(select 1 from sms_private.edge_config where queue='automation_jobs' and enabled)
     or exists(select 1 from sms_private.jobs where queue='automation_jobs'
       and status='processing' and leased_until>now()) then
    raise exception 'Disable and drain automation_jobs before changing its schedule';
  end if;
end $$;

create or replace function sms_private.sync_group_generation() returns trigger
language plpgsql security definer set search_path='' as $$
declare extra jsonb; lead integer; sends integer; interval_count integer;
begin
  if jsonb_typeof(new.rule)<>'object' then raise exception 'Schedule required'; end if;
  if not (new.rule ?& array['anchor','firstDelayCount','firstDelayUnit','intervalCount',
      'intervalUnit','repeatCount','leadHours','startHour','endHour']) then
    raise exception 'Complete automation schedule required';
  end if;
  extra:=new.rule - 'anchor' - 'firstDelayCount' - 'firstDelayUnit' - 'intervalCount'
    - 'intervalUnit' - 'repeatCount' - 'leadHours' - 'startHour' - 'endHour';
  if extra<>'{}'::jsonb then raise exception 'Automation groups accept scheduling fields only'; end if;
  lead:=(new.rule->>'leadHours')::integer;
  sends:=(new.rule->>'repeatCount')::integer;
  interval_count:=(new.rule->>'intervalCount')::integer;
  if new.rule->>'anchor' not in ('enrollment','appointment')
     or (new.rule->>'anchor')='appointment' and new.kind<>'reminder'
     or (new.rule->>'anchor')='enrollment' and new.kind='reminder'
     or (new.rule->>'firstDelayUnit') not in ('hour','day','week','month')
     or (new.rule->>'intervalUnit') not in ('hour','day','week','month')
     or (new.rule->>'firstDelayCount')::integer not between 0 and 365
     or interval_count not between 1 and 365
     or sends not between 1 and 30
     or (new.rule->>'startHour')::integer not between 0 and 23
     or (new.rule->>'endHour')::integer not between 1 and 24
     or (new.rule->>'endHour')::integer <= (new.rule->>'startHour')::integer
     or (new.rule->>'anchor')='appointment' and
       (lead not between 1 and 720 or new.rule->>'intervalUnit'<>'hour'
        or (sends-1)*interval_count>=lead)
     or (new.rule->>'anchor')='enrollment' and lead is not null
  then raise exception 'Invalid automation schedule'; end if;
  new.deterministic_delivery:=false;
  return new;
end $$;

-- Keep existing reminder behavior at one send, while making an added send
-- immediately usable with a six-hour interval.
update public.sms_automation_groups set
  rule=jsonb_set(jsonb_set(rule,'{intervalUnit}','"hour"'::jsonb),'{intervalCount}','6'::jsonb),
  version=version+1,updated_at=now()
where kind='reminder' and rule->>'intervalUnit'<>'hour';

create or replace function sms_private.automation_due(base timestamptz,r jsonb,tz text,first_send boolean)
returns timestamptz language plpgsql immutable set search_path='' as $$
declare local_due timestamp; n integer; unit text; start_hour integer; end_hour integer;
begin
  if r->>'anchor'='appointment' and first_send then
    return base-make_interval(hours=>(r->>'leadHours')::integer);
  end if;
  n:=case when first_send then (r->>'firstDelayCount')::integer else (r->>'intervalCount')::integer end;
  unit:=case when first_send then r->>'firstDelayUnit' else r->>'intervalUnit' end;
  if unit='hour' then
    local_due:=(base+make_interval(hours=>n)) at time zone tz;
  else
    local_due:=base at time zone tz;
    if unit='month' then local_due:=local_due+make_interval(months=>n);
    elsif unit='week' then local_due:=local_due+make_interval(days=>7*n);
    else local_due:=local_due+make_interval(days=>n); end if;
  end if;
  start_hour:=(r->>'startHour')::integer;
  end_hour:=(r->>'endHour')::integer;
  if local_due::time<make_time(start_hour,0,0) then
    local_due:=date_trunc('day',local_due)+make_interval(hours=>start_hour);
  elsif end_hour<24 and local_due::time>=make_time(end_hour,0,0) then
    local_due:=date_trunc('day',local_due)+interval '1 day'+make_interval(hours=>start_hour);
  end if;
  return local_due at time zone tz;
end $$;

create or replace function sms_private.accept_attempt(aid uuid,s text) returns void
language plpgsql security definer set search_path='' as $$
#variable_conflict use_column
declare a sms_private.attempts; j sms_private.jobs; r jsonb;
  e public.sms_automation_enrollments; g public.sms_automation_groups;
  tz text; accepted_at timestamptz:=now(); next_due timestamptz;
begin
  select * into strict a from sms_private.attempts where id=aid;
  select * into strict j from sms_private.jobs where id=a.job_id for update;
  if a.sid is not null and a.sid<>s then raise exception 'SID mismatch'; end if;
  if j.status='completed' then return; end if;
  if j.status not in ('submitting','submission_unknown') then raise exception 'Submission not reconcilable'; end if;
  update sms_private.attempts set sid=s,state='accepted' where id=aid;
  update public.sms_messages set sid=s,status='accepted',error_code=null,updated_at=accepted_at
    where tenant_id=j.tenant_id and id=(j.payload->>'message_id')::uuid;
  update sms_private.jobs set status='completed',leased_until=null,error_code=null,updated_at=accepted_at
    where id=j.id;
  perform pgmq.delete(j.queue,j.queue_msg_id);
  r:=j.payload->'request';
  if r ? 'enrollment_id' then
    select * into e from public.sms_automation_enrollments
      where tenant_id=j.tenant_id and id=(r->>'enrollment_id')::uuid for update;
    if e.id is not null and e.generation>=(r->>'enrollment_generation')::bigint
       and e.step_index=(r->>'step_index')::integer and e.status in ('active','paused') then
      select * into g from public.sms_automation_groups
        where tenant_id=e.tenant_id and id=e.category_id;
      if e.step_index+1<(g.rule->>'repeatCount')::integer then
        select b.time_zone into tz from public.sms_businesses b where b.tenant_id=e.tenant_id;
        next_due:=sms_private.automation_due(accepted_at,g.rule,tz,false);
        if g.rule->>'anchor'='appointment' and
           (e.appointment_at is null or next_due>=e.appointment_at) then
          next_due:=null;
        end if;
      end if;
      update public.sms_automation_enrollments set step_index=step_index+1,last_sent_at=accepted_at,
        next_run_at=next_due,status=case when next_due is null then 'completed' else 'active' end
        where tenant_id=e.tenant_id and id=e.id;
    end if;
  end if;
  insert into public.sms_thread_contacts(tenant_id,phone,name,last_body,last_direction,last_message_at)
    values(j.tenant_id,r->>'phone','',r->>'body','outbound',accepted_at)
    on conflict(tenant_id,phone) do update set last_body=excluded.last_body,
      last_direction='outbound',last_message_at=accepted_at;
end $$;
