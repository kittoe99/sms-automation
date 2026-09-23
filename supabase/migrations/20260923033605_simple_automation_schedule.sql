-- A group is a schedule. A separate, reviewed intent guides each fresh AI draft.
do $$ begin
  if exists(select 1 from sms_private.edge_config where queue='automation_jobs' and enabled)
     or exists(select 1 from sms_private.jobs where queue='automation_jobs' and status='processing' and leased_until>now()) then
    raise exception 'Disable and drain automation_jobs before changing its contract';
  end if;
end $$;

alter table public.sms_automation_groups
  add column if not exists deterministic_delivery boolean not null default false;
alter table public.sms_automation_enrollments
  add column if not exists pause_reason text,
  add column if not exists paused_at timestamptz;

create table public.sms_automation_intents (
  tenant_id text not null,
  group_id text not null,
  intent text not null check (length(btrim(intent)) between 1 and 1600 and position('{{' in intent)=0),
  updated_at timestamptz not null default now(),
  primary key (tenant_id,group_id),
  foreign key (tenant_id,group_id) references public.sms_automation_groups(tenant_id,id) on delete cascade
);
alter table public.sms_automation_intents enable row level security;
create policy tenant_read on public.sms_automation_intents for select to authenticated
  using (sms_private.can_access(tenant_id));
grant select on public.sms_automation_intents to authenticated;

-- Replace the older trigger that rewrites every rule into deterministic mode.
create or replace function sms_private.sync_group_generation() returns trigger
language plpgsql security definer set search_path='' as $$
declare extra jsonb; begin
  if jsonb_typeof(new.rule)<>'object' then raise exception 'Schedule required'; end if;
  if not (new.rule ?& array['anchor','firstDelayCount','firstDelayUnit','intervalCount',
      'intervalUnit','repeatCount','leadHours','startHour','endHour']) then
    raise exception 'Complete automation schedule required';
  end if;
  extra:=new.rule - 'anchor' - 'firstDelayCount' - 'firstDelayUnit' - 'intervalCount'
    - 'intervalUnit' - 'repeatCount' - 'leadHours' - 'startHour' - 'endHour';
  if extra<>'{}'::jsonb then raise exception 'Automation groups accept scheduling fields only'; end if;
  if new.rule->>'anchor' not in ('enrollment','appointment')
     or (new.rule->>'anchor')='appointment' and new.kind<>'reminder'
     or (new.rule->>'anchor')='enrollment' and new.kind='reminder'
     or (new.rule->>'firstDelayUnit') not in ('day','week','month')
     or (new.rule->>'intervalUnit') not in ('day','week','month')
     or (new.rule->>'firstDelayCount')::integer not between 0 and 365
     or (new.rule->>'intervalCount')::integer not between 1 and 365
     or (new.rule->>'repeatCount')::integer not between 1 and 30
     or (new.rule->>'startHour')::integer not between 0 and 23
     or (new.rule->>'endHour')::integer not between 1 and 24
     or (new.rule->>'endHour')::integer <= (new.rule->>'startHour')::integer
     or (new.rule->>'anchor')='appointment' and
        ((new.rule->>'repeatCount')::integer<>1 or (new.rule->>'leadHours')::integer not between 1 and 720)
  then raise exception 'Invalid automation schedule'; end if;
  new.deterministic_delivery:=false;
  return new;
end $$;
drop trigger if exists sync_group_generation on public.sms_automation_groups;
create trigger sync_group_generation before insert or update of rule on public.sms_automation_groups
  for each row execute function sms_private.sync_group_generation();

-- Known system purposes are reviewed. Custom purposes require an administrator.
insert into public.sms_automation_intents(tenant_id,group_id,intent)
select tenant_id,id,case kind
  when 'quote' then 'Follow up on the customer quote, answer relevant questions, and help with the next decision without implying acceptance or a confirmed booking.'
  when 'reminder' then 'Remind the customer of the confirmed appointment using its actual local date and time, and invite a reply if rescheduling is needed.'
end
from public.sms_automation_groups where kind in ('quote','reminder');

update public.sms_automation_enrollments e set status='paused',
  pause_reason='INTENT_REVIEW_REQUIRED',paused_at=now(),generation=generation+1
where status='active' and exists(select 1 from public.sms_automation_groups g
  where g.tenant_id=e.tenant_id and g.id=e.category_id and g.kind='custom');

update public.sms_automation_groups g set
  rule=case
    when kind='quote' then jsonb_build_object('anchor','enrollment','firstDelayCount',1,'firstDelayUnit','day',
      'intervalCount',2,'intervalUnit','day','repeatCount',6,'leadHours',null,'startHour',9,'endHour',19)
    when kind='reminder' then jsonb_build_object('anchor','appointment','firstDelayCount',0,'firstDelayUnit','day',
      'intervalCount',1,'intervalUnit','day','repeatCount',1,'leadHours',24,'startHour',0,'endHour',24)
    else jsonb_build_object('anchor','enrollment',
      'firstDelayCount',least(365,greatest(0,coalesce((g.rule->'steps'->0->>'delayCount')::integer,1))),
      'firstDelayUnit',case when g.rule->'steps'->0->>'delayUnit' in ('day','week','month')
        then g.rule->'steps'->0->>'delayUnit' else 'day' end,
      'intervalCount',least(365,greatest(1,coalesce((g.rule->>'intervalCount')::integer,1))),
      'intervalUnit',case when g.rule->>'intervalUnit' in ('day','week','month')
        then g.rule->>'intervalUnit' else 'day' end,
      'repeatCount',least(30,greatest(1,coalesce(jsonb_array_length(g.rule->'steps'),(g.rule->>'repeatCount')::integer,1))),
      'leadHours',null,'startHour',least(23,greatest(0,coalesce((g.rule->>'startHour')::integer,9))),
      'endHour',least(24,greatest(1,coalesce((g.rule->>'endHour')::integer,19))))
  end,
  active=case when kind='custom' then false else active end,
  version=version+1,updated_at=now();

-- Schedule arithmetic uses the business's calendar and send window.
create function sms_private.automation_due(base timestamptz,r jsonb,tz text,first_send boolean)
returns timestamptz language plpgsql immutable set search_path='' as $$
declare local_due timestamp; n integer; unit text; start_hour integer; end_hour integer;
begin
  if r->>'anchor'='appointment' then
    return base-make_interval(hours=>(r->>'leadHours')::integer);
  end if;
  n:=case when first_send then (r->>'firstDelayCount')::integer else (r->>'intervalCount')::integer end;
  unit:=case when first_send then r->>'firstDelayUnit' else r->>'intervalUnit' end;
  local_due:=base at time zone tz;
  if unit='month' then local_due:=local_due+make_interval(months=>n);
  elsif unit='week' then local_due:=local_due+make_interval(days=>7*n);
  else local_due:=local_due+make_interval(days=>n); end if;
  start_hour:=(r->>'startHour')::integer;end_hour:=(r->>'endHour')::integer;
  if local_due::time<make_time(start_hour,0,0) then
    local_due:=date_trunc('day',local_due)+make_interval(hours=>start_hour);
  elsif local_due::time>=make_time(end_hour%24,0,0) and end_hour<24 then
    local_due:=date_trunc('day',local_due)+interval '1 day'+make_interval(hours=>start_hour);
  end if;
  return local_due at time zone tz;
end $$;

-- Preserve the other administrative operations without keeping the old group writer reachable.
alter function sms_private.api_action(text,text,text,jsonb) rename to api_action_legacy;
revoke all on function sms_private.api_action_legacy(text,text,text,jsonb)
  from public,anon,authenticated,sms_api,sms_webhook,sms_sender,sms_automation,sms_ai;
create function sms_private.api_action(u text,t text,action text,p jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
#variable_conflict use_column
declare g public.sms_automation_groups; j sms_private.jobs; e public.sms_automation_enrollments;
  c public.sms_contacts; intent_text text; result jsonb;
begin
  perform sms_private.require_admin(u);
  if action='group' then
    intent_text:=btrim(p->>'intent');
    if intent_text is null or length(intent_text) not between 1 and 1600 or position('{{' in intent_text)>0
       or p ? 'template' or p ? 'steps' or p ? 'deliveryMode' or p ? 'aiDraft'
       or p->'rule' ? 'template' or p->'rule' ? 'steps' or p->'rule' ? 'deliveryMode' or p->'rule' ? 'aiDraft'
    then raise exception 'One automation intent and a schedule are required'; end if;
    if length(btrim(p->>'name')) not between 1 and 100 then raise exception 'Automation name required'; end if;
    insert into public.sms_automation_groups(tenant_id,id,name,description,kind,rule,active)
      values(t,p->>'id',btrim(p->>'name'),left(coalesce(p->>'description',''),300),'custom',
        p->'rule',coalesce((p->>'active')::boolean,true))
      on conflict(tenant_id,id) do update set name=excluded.name,description=excluded.description,
        rule=excluded.rule,active=excluded.active,version=sms_automation_groups.version+1,updated_at=now()
      returning * into g;
    insert into public.sms_automation_intents(tenant_id,group_id,intent) values(t,g.id,intent_text)
      on conflict(tenant_id,group_id) do update set intent=excluded.intent,updated_at=now();
    update public.sms_automation_enrollments set generation=generation+1,next_run_at=now()
      where tenant_id=t and category_id=g.id and status='active';
    if g.active then
      update public.sms_automation_enrollments set status='active',pause_reason=null,paused_at=null,
        generation=generation+1,next_run_at=now()
      where tenant_id=t and category_id=g.id and status='paused' and pause_reason='INTENT_REVIEW_REQUIRED';
    end if;
    insert into sms_private.audit(tenant_id,actor,action,detail)
      values(t,u,'automation_saved',jsonb_build_object('group_id',g.id));
    return to_jsonb(g)||jsonb_build_object('intent',intent_text);
  elsif action='enroll' then
    if not exists(select 1 from public.sms_automation_intents where tenant_id=t and group_id=p->>'categoryId') then
      raise exception 'Automation intent required before enrollment';
    end if;
  elsif action='retry_job' then
    select * into j from sms_private.jobs where tenant_id=t and id=(p->>'id')::uuid and status='failed';
    if j.queue='automation_jobs' then
      select * into e from public.sms_automation_enrollments
        where tenant_id=t and id=(j.payload->>'enrollment_id')::uuid for update;
      select * into c from public.sms_contacts where tenant_id=t and id=e.contact_id;
      if e.status<>'paused' or e.generation<>(j.payload->>'generation')::bigint or c.opted_out
         or not exists(select 1 from public.sms_automation_groups where tenant_id=t and id=e.category_id and active)
         or not exists(select 1 from public.sms_automation_intents where tenant_id=t and group_id=e.category_id)
      then raise exception 'Automation is no longer eligible for redraft'; end if;
      update public.sms_automation_enrollments set status='active',pause_reason=null,paused_at=null,next_run_at=now()
        where tenant_id=t and id=e.id;
    end if;
  end if;
  result:=sms_private.api_action_legacy(u,t,action,p);
  return result;
end $$;
revoke all on function sms_private.api_action(text,text,text,jsonb)
  from public,anon,authenticated,sms_api,sms_webhook,sms_sender,sms_automation,sms_ai;
grant execute on function sms_private.api_action(text,text,text,jsonb) to sms_api;

alter function sms_private.api_read(text,text,text,jsonb) rename to api_read_legacy;
revoke all on function sms_private.api_read_legacy(text,text,text,jsonb)
  from public,anon,authenticated,sms_api,sms_webhook,sms_sender,sms_automation,sms_ai;
create function sms_private.api_read(u text,t text,resource text,p jsonb default '{}') returns jsonb
language plpgsql security definer set search_path='' as $$
declare rows jsonb; n bigint; result jsonb;
begin
  if resource='groups' then
    perform sms_private.require_admin(u);
    select count(*),coalesce(jsonb_agg(to_jsonb(g)||jsonb_build_object('intent',i.intent) order by g.created_at,g.id),'[]'::jsonb)
      into n,rows from public.sms_automation_groups g
      left join public.sms_automation_intents i on i.tenant_id=g.tenant_id and i.group_id=g.id
      where g.tenant_id=t and (p->>'id' is null or g.id=p->>'id');
    return jsonb_build_object('rows',rows,'total',n,'page',1,'pageSize',250,'totalPages',1,'configured',true);
  elsif resource='steps' then
    perform sms_private.require_admin(u);
    return jsonb_build_object('rows','[]'::jsonb,'total',0,'page',1,'pageSize',250,'totalPages',1);
  end if;
  result:=sms_private.api_read_legacy(u,t,resource,p);
  if resource='operations' then
    result:=result||jsonb_build_object('automationFailures',coalesce((
      select jsonb_agg(x order by x.created_at desc) from (
        select j.id,j.error_code,j.created_at,e.id enrollment_id,e.pause_reason,g.name group_name
        from sms_private.jobs j
        left join public.sms_automation_enrollments e on e.tenant_id=j.tenant_id and e.id=(j.payload->>'enrollment_id')::uuid
        left join public.sms_automation_groups g on g.tenant_id=e.tenant_id and g.id=e.category_id
        where j.tenant_id=t and j.queue='automation_jobs' and j.status='failed'
        order by j.created_at desc limit 50
      ) x),'[]'::jsonb));
  end if;
  return result;
end $$;
revoke all on function sms_private.api_read(text,text,text,jsonb)
  from public,anon,authenticated,sms_api,sms_webhook,sms_sender,sms_automation,sms_ai;
grant execute on function sms_private.api_read(text,text,text,jsonb) to sms_api;

create or replace function sms_private.job_context(jid uuid,token uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare j sms_private.jobs;e public.sms_automation_enrollments;c public.sms_contacts;ph text;
begin
  j:=sms_private.lease(jid,token);
  if j.queue='automation_jobs' then
    select * into e from public.sms_automation_enrollments where tenant_id=j.tenant_id and id=(j.payload->>'enrollment_id')::uuid;
    select * into c from public.sms_contacts where tenant_id=j.tenant_id and id=e.contact_id;
    return jsonb_build_object(
      'enrollment',to_jsonb(e),'contact',to_jsonb(c),
      'business',(select to_jsonb(b) from public.sms_businesses b where b.tenant_id=j.tenant_id),
      'profile',(select to_jsonb(v) from public.sms_business_profile_versions v
        join public.sms_businesses b on b.tenant_id=v.tenant_id and b.active_profile_version_id=v.id
        where v.tenant_id=j.tenant_id and v.status='approved'),
      'group',(select to_jsonb(g) from public.sms_automation_groups g where g.tenant_id=j.tenant_id and g.id=e.category_id),
      'intent',(select i.intent from public.sms_automation_intents i where i.tenant_id=j.tenant_id and i.group_id=e.category_id),
      'thread',(select to_jsonb(th) from public.sms_thread_contacts th where th.tenant_id=j.tenant_id and th.phone=c.phone),
      'quote',(select to_jsonb(q) from public.sms_quotes q where q.tenant_id=j.tenant_id and q.contact_id=c.id
        order by q.created_at desc limit 1),
      'booking',(select to_jsonb(bk) from public.sms_bookings bk where bk.tenant_id=j.tenant_id and bk.contact_id=c.id
        and bk.status='confirmed' and (e.metadata->>'booking_id' is null or bk.id=e.metadata->>'booking_id')
        order by bk.updated_at desc limit 1),
      'history',(select coalesce(jsonb_agg(m order by m.created_at,m.id),'[]'::jsonb) from
        (select id,direction,body,created_at from public.sms_messages where tenant_id=j.tenant_id and contact_phone=c.phone
         order by created_at desc,id desc limit 40) m));
  elsif j.queue='ai_reply_jobs' then
    ph:=j.payload->>'phone';
    select * into c from public.sms_contacts where tenant_id=j.tenant_id and phone=ph;
    return jsonb_build_object(
      'business',(select to_jsonb(b) from public.sms_businesses b where tenant_id=j.tenant_id),
      'profile',(select to_jsonb(v) from public.sms_business_profile_versions v join public.sms_businesses b
        on b.tenant_id=v.tenant_id and b.active_profile_version_id=v.id where v.tenant_id=j.tenant_id and v.status='approved'),
      'contact',to_jsonb(c),
      'thread',(select to_jsonb(th) from public.sms_thread_contacts th where tenant_id=j.tenant_id and phone=ph),
      'settings',(select to_jsonb(a) from public.sms_ai_settings a where tenant_id=j.tenant_id and group_id=j.payload->>'group_id'),
      'open_lead',(select to_jsonb(l) from public.sms_leads l where l.tenant_id=j.tenant_id and l.contact_id=c.id
        and l.status in ('open','assigned') order by l.updated_at desc limit 1),
      'booking_settings',(select to_jsonb(s) from public.sms_booking_settings s where s.tenant_id=j.tenant_id and s.enabled),
      'booking_session',(select to_jsonb(s) from public.sms_booking_sessions s where s.tenant_id=j.tenant_id
        and s.contact_id=c.id and s.expires_at>now()),
      'history',(select coalesce(jsonb_agg(m order by created_at),'[]'::jsonb) from
        (select id,direction,body,created_at from public.sms_messages where tenant_id=j.tenant_id and contact_phone=ph
         order by created_at desc limit 20) m));
  elsif j.queue='provisioning_jobs' then
    return (select jsonb_build_object('account_sid',p.account_sid,'messaging_service_sid',p.messaging_service_sid,
      'phone_number_sid',p.phone_number_sid,'state',p.provisioning_state,'business_name',b.name)
      from sms_private.providers p join public.sms_businesses b using(tenant_id) where p.tenant_id=j.tenant_id);
  end if;
  raise exception 'Unsupported context';
end $$;
revoke all on function sms_private.job_context(uuid,uuid)
  from public,anon,authenticated,sms_api,sms_webhook,sms_sender,sms_ai,sms_automation;
grant execute on function sms_private.job_context(uuid,uuid) to sms_automation,sms_ai;

create or replace function sms_private.complete_automation(jid uuid,token uuid,p jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
#variable_conflict use_column
declare j sms_private.jobs;e public.sms_automation_enrollments;c public.sms_contacts;
  g public.sms_automation_groups; result jsonb; observed_generation bigint;
begin
  j:=sms_private.lease(jid,token);
  if j.queue<>'automation_jobs' then raise exception 'Wrong queue'; end if;
  select * into e from public.sms_automation_enrollments
    where tenant_id=j.tenant_id and id=(j.payload->>'enrollment_id')::uuid for update;
  select * into c from public.sms_contacts where tenant_id=j.tenant_id and id=e.contact_id for update;
  select * into g from public.sms_automation_groups where tenant_id=j.tenant_id and id=e.category_id;
  if e.status<>'active' or e.generation<>(j.payload->>'generation')::bigint
     or e.step_index<>(j.payload->>'step_index')::integer or c.opted_out
     or not g.active or g.version<>(p->>'group_version')::bigint
     or not exists(select 1 from public.sms_automation_intents where tenant_id=j.tenant_id and group_id=g.id)
     or e.appointment_at<=now() then
    perform sms_private.finish(jid,token,'cancelled','STALE_ENROLLMENT');
    return null;
  end if;
  if p->>'action'='complete' then
    update public.sms_automation_enrollments set status='completed',next_run_at=null
      where tenant_id=j.tenant_id and id=e.id;
  elsif p->>'action'='schedule' then
    update public.sms_automation_enrollments set next_run_at=(p->>'due')::timestamptz,generation=generation+1
      where tenant_id=j.tenant_id and id=e.id;
  elsif p->>'action'='send' then
    if p->>'ai_drafted' is distinct from 'true' or nullif(btrim(p->>'body'),'') is null
       or length(p->>'body')>600 or position('{{' in p->>'body')>0 then
      raise exception 'Fresh AI draft required' using errcode='23514';
    end if;
    insert into public.sms_thread_contacts(tenant_id,phone,name)
      values(j.tenant_id,c.phone,coalesce(c.name,'')) on conflict(tenant_id,phone) do nothing;
    select th.generation into observed_generation from public.sms_thread_contacts th
      where th.tenant_id=j.tenant_id and th.phone=c.phone for update;
    if observed_generation<>(p->>'thread_generation')::bigint then
      raise exception 'Conversation changed during AI draft' using errcode='40001';
    end if;
    result:=sms_private.outbox(j.tenant_id,'automation:'||j.dedupe_key,
      (p-'action'-'ai_drafted'-'thread_generation')
      ||jsonb_build_object('conversation_generation',observed_generation));
    update public.sms_messages set meta=meta||jsonb_build_object('ai_drafted',true,'automation_send',e.step_index+1)
      where tenant_id=j.tenant_id and id=(result->>'messageId')::uuid;
  else raise exception 'Unsupported automation action' using errcode='22023';
  end if;
  perform sms_private.finish(jid,token,'completed');
  return result;
end $$;
revoke all on function sms_private.complete_automation(uuid,uuid,jsonb)
  from public,anon,authenticated,sms_api,sms_webhook,sms_sender,sms_ai,sms_automation;
grant execute on function sms_private.complete_automation(uuid,uuid,jsonb) to sms_automation;

create function sms_private.pause_failed_automation() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  if new.queue='automation_jobs' and new.status='failed' and old.status is distinct from 'failed' then
    update public.sms_automation_enrollments set status='paused',
      pause_reason=coalesce(new.error_code,'AI_DRAFT_FAILED'),paused_at=now()
    where tenant_id=new.tenant_id and id=(new.payload->>'enrollment_id')::uuid
      and generation=(new.payload->>'generation')::bigint and status='active';
  end if;
  return new;
end $$;
create trigger pause_failed_automation after update of status on sms_private.jobs
  for each row execute function sms_private.pause_failed_automation();

-- A reply can arrive after drafting but before Twilio submission. Discard that
-- outbox body and enqueue the same send number against fresh conversation state.
create function sms_private.reschedule_stale_automation_outbox() returns trigger
language plpgsql security definer set search_path='' as $$
declare r jsonb;
begin
  r:=new.payload->'request';
  if new.queue='sms_send_jobs' and new.status='cancelled' and new.error_code='STALE_REPLY'
     and old.status is distinct from 'cancelled' and r ? 'enrollment_id' then
    update public.sms_automation_enrollments set generation=generation+1,next_run_at=now()
      where tenant_id=new.tenant_id and id=(r->>'enrollment_id')::uuid
        and generation=(r->>'enrollment_generation')::bigint
        and step_index=(r->>'step_index')::integer and status='active';
  end if;
  return new;
end $$;
create trigger reschedule_stale_automation_outbox after update of status on sms_private.jobs
  for each row execute function sms_private.reschedule_stale_automation_outbox();

create or replace function sms_private.enqueue_due_automations() returns integer
language plpgsql security definer set search_path='' as $$
declare n integer;
begin
  with due as materialized (
    select tenant_id,id,generation,step_index from (
      select e.tenant_id,e.id,e.generation,e.step_index,e.next_run_at,
        row_number() over(partition by e.tenant_id order by e.next_run_at,e.id) fair_rank
      from public.sms_automation_enrollments e join public.sms_businesses b using(tenant_id)
      join public.sms_automation_groups g on g.tenant_id=e.tenant_id and g.id=e.category_id
      join public.sms_automation_intents i on i.tenant_id=e.tenant_id and i.group_id=e.category_id
      where e.status='active' and e.next_run_at<=now() and b.sending_enabled and b.status='active'
        and g.active and e.step_index<(g.rule->>'repeatCount')::integer
        and not exists(select from sms_private.jobs j where j.tenant_id=e.tenant_id
          and j.queue='automation_jobs' and j.dedupe_key=e.id||':'||e.generation||':'||e.step_index)
    ) ranked order by fair_rank,next_run_at
    limit (select scheduler_batch_size from sms_private.runtime)
  ), queued as (
    select sms_private.enqueue(d.tenant_id,'automation_jobs',
      d.id||':'||d.generation||':'||d.step_index,
      jsonb_build_object('enrollment_id',d.id,'generation',d.generation,'step_index',d.step_index))
    from due d
  ) select count(*) into n from queued;
  return n;
end $$;

create or replace function sms_private.tick() returns integer
language plpgsql security definer set search_path='' as $$
declare j record; n integer:=0;
begin
  if not pg_try_advisory_xact_lock(720491321) then return 0; end if;
  update sms_private.runtime set last_tick_at=now();
  for j in select * from sms_private.jobs where leased_until<now() and status in ('submitting','processing')
    order by leased_until limit 500 for update skip locked loop
    if j.status='submitting' then
      update sms_private.jobs set status='submission_unknown',leased_until=null,error_code='WORKER_LOST',
        updated_at=now() where id=j.id;
      update public.sms_messages set status='submission_unknown',updated_at=now()
        where tenant_id=j.tenant_id and id=(j.payload->>'message_id')::uuid;
      update public.sms_automation_enrollments set status='paused'
        where tenant_id=j.tenant_id and id=(j.payload->'request'->>'enrollment_id')::uuid
          and generation=(j.payload->'request'->>'enrollment_generation')::bigint;
      perform pgmq.delete(j.queue,j.queue_msg_id);
    else
      update sms_private.jobs set status=case when attempts>=6 then 'failed' else 'retry' end,
        leased_until=null,updated_at=now() where id=j.id;
      if j.attempts>=6 then
        update public.sms_messages set status='failed',error_code='WORKER_LOST',updated_at=now()
          where tenant_id=j.tenant_id and id=(j.payload->>'message_id')::uuid;
      end if;
    end if;
  end loop;
  if (select scheduler_enabled from sms_private.runtime) then
    n:=sms_private.enqueue_due_automations();
  end if;
  return n;
end $$;

create or replace function sms_private.accept_attempt(aid uuid,s text) returns void
language plpgsql security definer set search_path='' as $$
#variable_conflict use_column
declare a sms_private.attempts;j sms_private.jobs;r jsonb; e public.sms_automation_enrollments;
  g public.sms_automation_groups; tz text; accepted_at timestamptz:=now(); next_due timestamptz;
begin
  select * into strict a from sms_private.attempts where id=aid;
  select * into strict j from sms_private.jobs where id=a.job_id for update;
  if a.sid is not null and a.sid<>s then raise exception 'SID mismatch'; end if;
  if j.status='completed' then return; end if;
  if j.status not in ('submitting','submission_unknown') then raise exception 'Submission not reconcilable'; end if;
  update sms_private.attempts set sid=s,state='accepted' where id=aid;
  update public.sms_messages set sid=s,status='accepted',error_code=null,updated_at=accepted_at
    where tenant_id=j.tenant_id and id=(j.payload->>'message_id')::uuid;
  update sms_private.jobs set status='completed',leased_until=null,error_code=null,updated_at=accepted_at where id=j.id;
  perform pgmq.delete(j.queue,j.queue_msg_id);
  r:=j.payload->'request';
  if r ? 'enrollment_id' then
    select * into e from public.sms_automation_enrollments
      where tenant_id=j.tenant_id and id=(r->>'enrollment_id')::uuid for update;
    if e.id is not null and e.generation>=(r->>'enrollment_generation')::bigint
       and e.step_index=(r->>'step_index')::integer and e.status in ('active','paused') then
      select * into g from public.sms_automation_groups where tenant_id=e.tenant_id and id=e.category_id;
      if e.step_index+1<(g.rule->>'repeatCount')::integer and g.rule->>'anchor'='enrollment' then
        select b.time_zone into tz from public.sms_businesses b where b.tenant_id=e.tenant_id;
        next_due:=sms_private.automation_due(accepted_at,g.rule,tz,false);
      end if;
      update public.sms_automation_enrollments set step_index=step_index+1,last_sent_at=accepted_at,
        next_run_at=next_due,status=case when next_due is null then 'completed' else 'active' end
        where tenant_id=e.tenant_id and id=e.id;
    end if;
  end if;
  insert into public.sms_thread_contacts(tenant_id,phone,name,last_body,last_direction,last_message_at)
    values(j.tenant_id,r->>'phone','',r->>'body','outbound',accepted_at)
    on conflict(tenant_id,phone) do update set last_body=excluded.last_body,last_direction='outbound',last_message_at=accepted_at;
end $$;

-- Old reusable bodies are removed only after all replacement readers and writers exist.
drop table public.sms_automation_steps;

-- The older manual generation workflow stored reusable sequences. It has no
-- active jobs or drafts in the linked project and is no longer part of this API.
drop function if exists sms_private.complete_automation_draft(uuid,uuid,jsonb);
drop function if exists sms_private.create_automation_draft(text,text,jsonb,text);
drop function if exists sms_private.draft_job_context(uuid,uuid);
drop function if exists sms_private.fail_automation_draft(uuid,uuid,text,boolean,integer);
drop function if exists sms_private.get_automation_draft(text,text,uuid);
alter table public.sms_automation_groups drop constraint if exists sms_group_generation_draft_fk;
drop table if exists public.sms_automation_drafts;
alter table public.sms_automation_groups
  drop column if exists generation_draft_id,
  drop column if exists generated_at,
  drop column if exists generation_prompt_version,
  drop column if exists generation_context_label,
  drop column if exists generated_messages_edited;
