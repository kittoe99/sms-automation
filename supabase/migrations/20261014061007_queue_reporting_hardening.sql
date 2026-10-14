-- CRM-owned forward migration. Requires current paired E2 access/cache baseline.
-- Generated from the four queue/reporting modules in supabase/sql/current/.
-- Do not apply historical migrations or these source modules directly.
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

-- Maintained repeatable function definitions. Privileged server roles only.
create or replace function sms_private.email_enroll(t text,gid text,typ text,rid uuid,
  address text,customer_name text,customer_phone text,consent_text text,fid uuid default null,
  appointment timestamptz default null) returns uuid
language plpgsql security definer set search_path='' as $$
#variable_conflict use_column
declare s sms_private.email_group_settings; b public.sms_businesses; due timestamptz; eid uuid;
begin
  if coalesce(length(btrim(consent_text)),0)=0 then return null; end if;
  address:=lower(btrim(address));
  if length(address) not between 3 and 320 or address !~ '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$' then return null; end if;
  perform pg_advisory_xact_lock(hashtext(t||':'||address));
  select * into s from sms_private.email_group_settings where tenant_id=t and group_id=gid;
  if not found or not s.enabled then return null; end if;
  if fid is not null and not exists(select from public.sms_web_form_definitions
    where tenant_id=t and public_id=fid and email_enabled and enabled) then return null; end if;
  if exists(select from sms_private.email_suppressions where tenant_id=t and email=address) then return null; end if;
  if exists(select from sms_private.email_enrollments x where x.tenant_id=t and x.email=address
    and x.status='active' and (x.source_type,x.source_id)<>(typ,rid)) then return null; end if;
  select * into b from public.sms_businesses where tenant_id=t;
  if typ='bookings' and (appointment is null or appointment<=now()) then return null; end if;
  due:=sms_private.automation_due(case when typ='bookings' then appointment else now() end,s.rule,b.time_zone,true);
  if due is null or (typ='bookings' and due>=appointment) then return null; end if;
  insert into sms_private.email_enrollments(tenant_id,group_id,source_type,source_id,form_public_id,
    email,name,phone,rule_snapshot,appointment_at,next_run_at)
    values(t,gid,typ,rid,fid,address,customer_name,customer_phone,s.rule,appointment,due)
    on conflict(tenant_id,source_type,source_id) do update set
      group_id=excluded.group_id,email=excluded.email,name=excluded.name,phone=excluded.phone,
      form_public_id=coalesce(excluded.form_public_id,email_enrollments.form_public_id),rule_snapshot=excluded.rule_snapshot,
      appointment_at=excluded.appointment_at,next_run_at=excluded.next_run_at,
      status='active',pause_reason=null,step_index=0,generation=email_enrollments.generation+1,updated_at=now()
    returning id into eid;
  return eid;
end $$;

create or replace function sms_private.email_save_group(u text,t text,gid text,p jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
#variable_conflict use_column
declare s sms_private.email_group_settings; g public.sms_automation_groups;
  proposed_rule jsonb; proposed_enabled boolean;
begin
  perform sms_private.require_web_form_editor(u,t);
  select * into strict g from public.sms_automation_groups where tenant_id=t and id=gid;
  select * into strict s from sms_private.email_group_settings where tenant_id=t and group_id=gid for update;
  if jsonb_typeof(p->'enabled')<>'boolean' or jsonb_typeof(p->'rule')<>'object'
    or jsonb_typeof(p->'intent')<>'string' or jsonb_typeof(p->'systemPrompt')<>'string'
    or jsonb_typeof(p->'businessContext')<>'string'
    or jsonb_typeof(p->'mailingAddress')<>'string' then raise exception 'Invalid email settings'; end if;
  proposed_rule:=p->'rule'; proposed_enabled:=(p->>'enabled')::boolean;
  if (proposed_rule->>'anchor')<>(case when g.fixed_type='bookings' then 'appointment' else 'enrollment' end)
    or coalesce((proposed_rule->>'repeatCount')::integer,0) not between 1 and 30
    or coalesce((proposed_rule->>'intervalCount')::integer,0) not between 1 and 365
    or proposed_rule->>'intervalUnit' not in ('hour','day','week','month')
    or coalesce((proposed_rule->>'startHour')::integer,-1) not between 0 and 23
    or coalesce((proposed_rule->>'endHour')::integer,-1) not between 1 and 24
    or (proposed_rule->>'startHour')::integer >= (proposed_rule->>'endHour')::integer
    then raise exception 'Invalid email schedule'; end if;
  if g.fixed_type='bookings' then
    if coalesce((proposed_rule->>'leadHours')::integer,0) not between 1 and 720 then raise exception 'Invalid reminder lead time'; end if;
  elsif coalesce((proposed_rule->>'firstDelayCount')::integer,-1) not between 0 and 365
    or proposed_rule->>'firstDelayUnit' not in ('hour','day','week','month')
    then raise exception 'Invalid first email delay'; end if;
  if length(p->>'intent')>1600 or length(p->>'systemPrompt')>6000 or length(p->>'businessContext')>10000
    or length(p->>'mailingAddress')>300
    then raise exception 'Email instructions are too long'; end if;
  if proposed_enabled and (btrim(p->>'intent')='' or btrim(p->>'systemPrompt')=''
    or btrim(p->>'businessContext')='' or btrim(p->>'mailingAddress')=''
    or not exists(select from sms_private.edge_config c
      where c.queue='automation_jobs' and c.enabled and c.secret_id is not null))
    then raise exception 'Configure email instructions and worker before activation'; end if;
  update sms_private.email_group_settings set enabled=proposed_enabled,rule=proposed_rule,
    intent=btrim(p->>'intent'),system_prompt=btrim(p->>'systemPrompt'),
    business_context=btrim(p->>'businessContext'),mailing_address=btrim(p->>'mailingAddress'),updated_at=now()
    where tenant_id=t and group_id=gid returning * into s;
  if not proposed_enabled then
    update sms_private.email_enrollments set status='cancelled',pause_reason=null,next_run_at=null,
      generation=generation+1,updated_at=now() where tenant_id=t and group_id=gid and status in ('active','paused');
  end if;
  return to_jsonb(s);
end $$;

create or replace function sms_private.email_intake_lifecycle() returns trigger
language plpgsql security definer set search_path='' as $$
#variable_conflict use_column
declare typ text; gid text; evidence text; eid uuid; fid uuid;
begin
  typ:=case tg_table_name when 'sms_automation_contacts' then 'contacts'
    when 'sms_automation_quote_requests' then 'quote_requests'
    when 'sms_automation_bookings' then 'bookings'
    when 'sms_automation_reviews' then 'reviews' end;
  if tg_op='UPDATE' and typ<>'bookings' then return new; end if;
  if tg_op='UPDATE' and typ='bookings' and (to_jsonb(new)->>'status') is not distinct from (to_jsonb(old)->>'status')
    and (to_jsonb(new)->>'appointment_at') is not distinct from (to_jsonb(old)->>'appointment_at')
    and new.email_opt_in is not distinct from old.email_opt_in then return new; end if;
  -- Match enrollment and retry: address lock before enrollment rows.
  if new.email is not null then perform pg_advisory_xact_lock(hashtext(new.tenant_id||':'||lower(btrim(new.email)))); end if;
  update sms_private.email_enrollments set status='cancelled',pause_reason=null,next_run_at=null,
    generation=generation+1,updated_at=now()
    where tenant_id=new.tenant_id and source_type=typ and source_id=new.id and status in ('active','paused');
  if typ='quote_requests' then
    update sms_private.email_enrollments set status='cancelled',pause_reason=null,next_run_at=null,
      generation=generation+1,updated_at=now()
      where tenant_id=new.tenant_id and phone=new.phone and source_type='contacts' and status in ('active','paused');
  elsif typ='bookings' and to_jsonb(new)->>'status'='confirmed' then
    update sms_private.email_enrollments set status='cancelled',pause_reason=null,next_run_at=null,
      generation=generation+1,updated_at=now()
      where tenant_id=new.tenant_id and phone=new.phone and source_type in ('contacts','quote_requests') and status in ('active','paused');
  elsif typ='reviews' then
    update sms_private.email_enrollments set status='cancelled',pause_reason=null,next_run_at=null,
      generation=generation+1,updated_at=now()
      where tenant_id=new.tenant_id and phone=new.phone and source_type='bookings' and status in ('active','paused');
  end if;
  if not new.email_opt_in or new.email is null or (typ='bookings' and to_jsonb(new)->>'status'<>'confirmed') then return new; end if;
  evidence:=new.email_consent_evidence;
  if coalesce(length(btrim(evidence)),0)=0 then return new; end if;
  select id into gid from public.sms_automation_groups where tenant_id=new.tenant_id and fixed_type=typ;
  insert into sms_private.email_consent_events(tenant_id,group_id,source_type,source_id,email,evidence)
    values(new.tenant_id,gid,typ,new.id,lower(new.email),evidence) on conflict do nothing;
  select form_public_id into fid from sms_private.email_consent_events
    where tenant_id=new.tenant_id and source_type=typ and source_id=new.id;
  eid:=sms_private.email_enroll(new.tenant_id,gid,typ,new.id,new.email,coalesce(new.name,''),
    new.phone,evidence,fid,nullif(to_jsonb(new)->>'appointment_at','')::timestamptz);
  return new;
end $$;

create or replace function sms_private.email_record_provider_event(event_key text,provider text,
  kind text,address text) returns void
language plpgsql security definer set search_path='' as $$
begin
  if not pg_has_role(session_user,'sms_automation','member') then raise exception 'Worker role denied' using errcode='42501'; end if;
  if length(event_key) not between 1 and 200 or kind not in
    ('email.sent','email.delivered','email.delivery_delayed','email.bounced','email.complained','email.failed','email.suppressed')
    then raise exception 'Invalid email provider event'; end if;
  insert into sms_private.email_webhook_events(event_id,provider_id,event_type)
    values(event_key,provider,kind) on conflict do nothing;
  update sms_private.email_jobs set provider_status=kind,updated_at=now()
    where provider_id=provider;
  if kind in ('email.bounced','email.complained','email.suppressed') and address is not null then
    insert into sms_private.email_suppressions(tenant_id,email,reason)
      select tenant_id,lower(address),kind from public.sms_businesses
      on conflict do nothing;
    update sms_private.email_enrollments set status='cancelled',pause_reason=null,next_run_at=null,
      generation=generation+1,updated_at=now()
      where email=lower(address) and status in ('active','paused');
  end if;
end $$;

create or replace function sms_private.email_unsubscribe(token uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare target sms_private.email_enrollments; begin
  select * into target from sms_private.email_enrollments where unsubscribe_token=token;
  if target.id is null then return jsonb_build_object('ok',true); end if;
  insert into sms_private.email_suppressions(tenant_id,email,reason)
    values(target.tenant_id,target.email,'unsubscribe') on conflict do nothing;
  update sms_private.email_enrollments set status='unsubscribed',pause_reason=null,next_run_at=null,
    generation=generation+1,updated_at=now()
    where tenant_id=target.tenant_id and email=target.email and status in ('active','paused');
  return jsonb_build_object('ok',true);
end $$;

create or replace function sms_private.email_scheduler_seed() returns trigger
language plpgsql security definer set search_path='' as $$ begin
 insert into sms_private.email_scheduler_state(tenant_id) values(new.tenant_id) on conflict do nothing;
 return new;
end $$;
revoke all on function sms_private.email_scheduler_seed() from public,anon,authenticated,sms_api,sms_sender,sms_ai,sms_automation;
create or replace function sms_private.email_retry(u text,t text,jid uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare j sms_private.email_jobs; e sms_private.email_enrollments; locked_email text; begin
 perform sms_private.require_web_form_editor(u,t);
 -- Match email_enroll: take the address lock before any job/enrollment row lock.
 select x.* into e from sms_private.email_enrollments x join sms_private.email_jobs q on q.enrollment_id=x.id
  where q.id=jid and x.tenant_id=t;
 if e.id is null then raise exception 'Email job cannot be retried safely'; end if;
 locked_email:=e.email;
 perform pg_advisory_xact_lock(hashtext(t||':'||locked_email));
 select * into j from sms_private.email_jobs where id=jid for update;
 select * into e from sms_private.email_enrollments where id=j.enrollment_id and tenant_id=t for update;
 if e.id is null or e.email is distinct from locked_email or e.status not in ('active','paused') or e.generation<>j.generation or e.step_index<>j.step_index
  or j.status<>'failed' or j.send_started_at<=now()-interval '23 hours'
  or exists(select from sms_private.email_enrollments sibling where sibling.tenant_id=t and sibling.email=e.email and sibling.id<>e.id and sibling.status='active')
  or (e.form_public_id is not null and not exists(select from public.sms_web_form_definitions where tenant_id=t and public_id=e.form_public_id and enabled and email_enabled and not archived))
  or (e.source_type='bookings' and not exists(select from public.sms_automation_bookings where tenant_id=t and id=e.source_id and status='confirmed'))
  or not exists(select from sms_private.email_group_settings where tenant_id=t and group_id=e.group_id and enabled)
  or exists(select from sms_private.email_suppressions where tenant_id=t and email=e.email)
 then raise exception 'Email job cannot be retried safely'; end if;
 update sms_private.email_enrollments set status='active',pause_reason=null,updated_at=now() where id=e.id;
 update sms_private.email_jobs set status='pending',due_at=now(),attempts=0,error_code=null,updated_at=now() where id=jid returning * into j;
 return to_jsonb(j);
end $$;
create or replace function sms_private.recover_email_jobs(batch_size integer default 100) returns integer
language plpgsql security definer set search_path='' as $$
declare n integer; begin
 with expired as (
  select id from sms_private.email_jobs
   where (status='processing' and lease_until<now())
      or (status='pending' and send_started_at<=now()-interval '23 hours')
   order by coalesce(lease_until,send_started_at),id
   limit least(500,greatest(1,batch_size)) for update skip locked
 ), recovered as (
  update sms_private.email_jobs j set
   status=case when send_started_at<=now()-interval '23 hours' then 'uncertain'
    when attempts>=5 then 'failed' else 'pending' end,
   error_code=case when send_started_at<=now()-interval '23 hours' then 'PROVIDER_OUTCOME_UNKNOWN'
    when attempts>=5 then 'LEASE_RETRIES_EXHAUSTED' else 'LEASE_EXPIRED' end,
   lease_token=null,lease_until=null,updated_at=now()
   from expired e where j.id=e.id returning j.id
 ) select count(*) into n from recovered;
 -- Reconcile historical terminal jobs as well, without changing newer runs.
 with attention as (
  select e.id,j.error_code from sms_private.email_enrollments e
  join sms_private.email_jobs j on j.enrollment_id=e.id and j.generation=e.generation and j.step_index=e.step_index
  where e.status='active' and j.status in ('failed','uncertain')
  order by j.updated_at,j.id limit least(500,greatest(1,batch_size)) for update of e skip locked
 ) update sms_private.email_enrollments e set status='paused',pause_reason=coalesce(a.error_code,'EMAIL_FAILED'),updated_at=now()
  from attention a where e.id=a.id;
 return n;
end $$;

create or replace function sms_private.activity_first_contact_changed() returns trigger
language plpgsql security definer set search_path='' as $$
declare prior jsonb; current_row jsonb; r record; first_at timestamptz; begin
 if tg_op<>'INSERT' then prior:=to_jsonb(old); end if;
 if tg_op<>'DELETE' then current_row:=to_jsonb(new); end if;
 for r in select id,tenant_id from sms_private.form_runs
  where (tenant_id=prior->>'tenant_id' and id::text=prior->'meta'->>'form_run_id')
     or (tenant_id=current_row->>'tenant_id' and id::text=current_row->'meta'->>'form_run_id') order by id
 loop
  perform pg_advisory_xact_lock(hashtextextended('activity-first-contact:'||r.id,0));
  select min(provider_accepted_at) into first_at from public.sms_messages
   where tenant_id=r.tenant_id and meta->>'form_run_id'=r.id::text and provider_accepted_at is not null;
  if first_at is null then delete from sms_private.activity_first_contacts where run_id=r.id;
  else insert into sms_private.activity_first_contacts values(r.id,r.tenant_id,first_at)
   on conflict(run_id) do update set accepted_at=excluded.accepted_at; end if;
 end loop;
 return coalesce(new,old);
end $$;

revoke all on function sms_private.activity_first_contact_changed() from public,anon,authenticated,sms_api,sms_sender,sms_ai,sms_automation;

revoke all on function sms_private.recover_email_jobs(integer) from public,anon,authenticated,sms_api,sms_sender,sms_ai;

grant execute on function sms_private.recover_email_jobs(integer) to sms_automation;

create or replace function sms_private.email_claim() returns jsonb
language plpgsql security definer set search_path='' as $$
declare j sms_private.email_jobs; selected_tenant text; begin
 if not pg_has_role(session_user,'sms_automation','member') then raise exception 'Worker role denied' using errcode='42501'; end if;
 perform sms_private.recover_email_jobs();
 select s.tenant_id into selected_tenant from sms_private.email_scheduler_state s
  where exists(select from sms_private.email_jobs x join sms_private.email_enrollments e on e.id=x.enrollment_id
   where e.tenant_id=s.tenant_id and x.status='pending' and x.due_at<=now())
  order by s.claimed_at,s.tenant_id limit 1 for update of s skip locked;
 if selected_tenant is null then return null; end if;
 select x.* into j from sms_private.email_jobs x join sms_private.email_enrollments e on e.id=x.enrollment_id
  where e.tenant_id=selected_tenant and x.status='pending' and x.due_at<=now()
  order by x.due_at,x.id limit 1 for update of x skip locked;
 if not found then return null; end if;
 update sms_private.email_scheduler_state set claimed_at=clock_timestamp() where tenant_id=selected_tenant;
 update sms_private.email_jobs set status='processing',attempts=attempts+1,
  lease_token=gen_random_uuid(),lease_until=now()+interval '90 seconds',updated_at=now()
  where id=j.id returning * into j;
 return to_jsonb(j);
end $$;

-- Intercept operations here so legacy compatibility readers cannot serialize
-- the entire heartbeat history. All non-operational reads retain their guards.
create or replace function sms_private.api_read(u text,t text,resource text,p jsonb default '{}') returns jsonb
language plpgsql security definer set search_path='' as $$
declare base jsonb; thread_count bigint; begin
 if resource='operations' then
  perform sms_private.require_admin(u);
  if not exists(select from public.sms_businesses where tenant_id=t) then raise exception 'Unknown business'; end if;
  return jsonb_build_object(
   'jobs',coalesce((select jsonb_agg(s) from (select queue,status,count(*) count,min(created_at) oldest from sms_private.jobs where tenant_id=t and status not in ('completed','cancelled') group by queue,status)s),'[]'),
   'workers',coalesce((select jsonb_agg(h) from (select distinct on(queue) queue,worker_id,seen_at from sms_private.heartbeats where seen_at>now()-interval '2 minutes' order by queue,seen_at desc limit 32)h),'[]'),
   'scheduler',(select to_jsonb(r) from sms_private.runtime r),
   'problems',coalesce((select jsonb_agg(s) from (select id,queue,status,error_code,created_at from sms_private.jobs where tenant_id=t and status in ('failed','submission_unknown') order by created_at desc limit 50)s),'[]'),
   'automationFailures',coalesce((select jsonb_agg(s) from (select j.id,j.error_code,j.created_at,e.id enrollment_id,e.pause_reason,g.name group_name
    from sms_private.jobs j left join public.sms_automation_enrollments e on e.tenant_id=j.tenant_id and e.id=(j.payload->>'enrollment_id')::uuid
    left join public.sms_automation_groups g on g.tenant_id=e.tenant_id and g.id=e.category_id
    where j.tenant_id=t and j.queue='automation_jobs' and j.status='failed' order by j.created_at desc limit 50)s),'[]'));
 end if;
 base:=sms_private.api_read_before_conversations(u,t,resource,p);
 if resource<>'overview' then return base; end if;
 select count(*) into thread_count from public.sms_conversations c where c.tenant_id=t
  and exists(select from public.sms_messages m where m.tenant_id=c.tenant_id and m.conversation_id=c.id);
 return base||jsonb_build_object('conversationCount',thread_count);
end $$;

create or replace function sms_private.dispatch_email_edge() returns integer
language plpgsql security definer set search_path='' as $$
declare bearer text; request_id bigint; capacity integer; tenant record; queued integer:=0; added integer; begin
 if not pg_try_advisory_xact_lock(720491323) then return 0; end if;
 -- Recovery must run even when no pending job can wake a worker.
 perform sms_private.recover_email_jobs();
 insert into sms_private.email_scheduler_state(tenant_id) select distinct tenant_id from sms_private.email_group_settings where enabled on conflict do nothing;
 for tenant in select st.tenant_id from sms_private.email_scheduler_state st
  where exists(select from sms_private.email_enrollments e join sms_private.email_group_settings s on s.tenant_id=e.tenant_id and s.group_id=e.group_id
   where e.tenant_id=st.tenant_id and e.status='active' and e.next_run_at<=now() and s.enabled
    and not exists(select from sms_private.email_jobs j where j.enrollment_id=e.id and j.step_index=e.step_index and j.generation=e.generation))
  order by st.dispatched_at,st.tenant_id limit 32
 loop
  insert into sms_private.email_jobs(enrollment_id,step_index,generation,due_at)
   select e.id,e.step_index,e.generation,e.next_run_at from sms_private.email_enrollments e
   join sms_private.email_group_settings s on s.tenant_id=e.tenant_id and s.group_id=e.group_id
   where e.tenant_id=tenant.tenant_id and e.status='active' and e.next_run_at<=now() and s.enabled
    and not exists(select from sms_private.email_jobs j where j.enrollment_id=e.id and j.step_index=e.step_index and j.generation=e.generation)
   order by e.next_run_at,e.id limit least(10,100-queued) on conflict do nothing;
  get diagnostics added=row_count; queued:=queued+added;
  update sms_private.email_scheduler_state set dispatched_at=clock_timestamp() where tenant_id=tenant.tenant_id;
  exit when queued>=100;
 end loop;
 if not (select edge_enabled from sms_private.runtime) then return 0; end if;
 if not exists(select from sms_private.email_jobs where status='pending' and due_at<=now()) then return 0; end if;
 select v.decrypted_secret,c.max_concurrency into bearer,capacity from sms_private.edge_config c
  join vault.decrypted_secrets v on v.id=c.secret_id where c.queue='automation_jobs' and c.enabled;
 if bearer is null or (select count(*) from sms_private.edge_runs where queue='automation_jobs' and expires_at>now())>=capacity then return 0; end if;
 select net.http_post(url:='https://wxamwhfmelxqahkdtcci.supabase.co/functions/v1/email-worker',
  headers:=jsonb_build_object('Authorization','Bearer '||bearer,'Content-Type','application/json'),
  body:='{}'::jsonb,timeout_milliseconds:=60000) into request_id;
 return 1;
end $$;

create or replace function sms_private.email_before_send(jid uuid,token uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
#variable_conflict use_column
declare j sms_private.email_jobs; e sms_private.email_enrollments;
 s sms_private.email_group_settings; source_status text; tz text; due timestamptz;
begin
 if not pg_has_role(session_user,'sms_automation','member') then raise exception 'Worker role denied' using errcode='42501'; end if;
 select * into strict j from sms_private.email_jobs where id=jid and lease_token=token
  and status='processing' and lease_until>now() for update;
 select * into strict e from sms_private.email_enrollments where id=j.enrollment_id for update;
 select * into s from sms_private.email_group_settings where tenant_id=e.tenant_id and group_id=e.group_id;
 if e.source_type='bookings' then select status into source_status from public.sms_automation_bookings where tenant_id=e.tenant_id and id=e.source_id; end if;
 if e.status<>'active' or e.generation<>j.generation or e.step_index<>j.step_index
  or not coalesce(s.enabled,false) or j.subject is null or j.body is null or j.provider_payload is null
  or exists(select from sms_private.email_suppressions where tenant_id=e.tenant_id and email=e.email)
  or (e.form_public_id is not null and not exists(select from public.sms_web_form_definitions where tenant_id=e.tenant_id and public_id=e.form_public_id and email_enabled and enabled))
  or (e.source_type='bookings' and (source_status is distinct from 'confirmed' or e.appointment_at<=now())) then
  update sms_private.email_jobs set status='cancelled',lease_token=null,lease_until=null,error_code='INELIGIBLE',updated_at=now() where id=jid;
  return null;
 end if;
 -- Resend only retains its provider idempotency key for a limited period.
 -- Never cross that horizon after a pause or a deferred sending window.
 if j.send_started_at<=now()-interval '23 hours' then
  update sms_private.email_jobs set status='uncertain',lease_token=null,lease_until=null,error_code='PROVIDER_OUTCOME_UNKNOWN',updated_at=now() where id=jid;
  update sms_private.email_enrollments set status='paused',pause_reason='PROVIDER_OUTCOME_UNKNOWN',updated_at=now()
   where id=e.id and status='active' and generation=j.generation and step_index=j.step_index;
  return null;
 end if;
 select time_zone into tz from public.sms_businesses where tenant_id=e.tenant_id;
 due:=sms_private.form_due(now(),0,'minute',tz,(e.rule_snapshot->>'startHour')::integer,(e.rule_snapshot->>'endHour')::integer);
 if due>now() then
  update sms_private.email_jobs set status='pending',due_at=due,attempts=greatest(0,attempts-1),
   lease_token=null,lease_until=null,error_code='OUTSIDE_WINDOW',updated_at=now() where id=jid;
  return null;
 end if;
 update sms_private.email_jobs set send_started_at=coalesce(send_started_at,now()),updated_at=now() where id=jid returning * into j;
 return jsonb_build_object('job',to_jsonb(j),'enrollment',to_jsonb(e),'settings',to_jsonb(s));
end $$;

-- A queue heartbeat represents recent activity, not a permanent worker process.
create or replace function sms_private.queue_heartbeat() returns trigger language plpgsql set search_path='' as $$
begin new.worker_id:='queue:'||new.queue; return new; end $$;

revoke all on function sms_private.queue_heartbeat() from public,anon,authenticated;

create or replace function sms_private.prune_worker_heartbeats() returns void language sql security definer set search_path='' as $$
 delete from sms_private.heartbeats where worker_id in (
  select worker_id from sms_private.heartbeats where seen_at<now()-interval '1 day' order by seen_at limit 500
 );
$$;

revoke all on function sms_private.prune_worker_heartbeats() from public,anon,authenticated,sms_api,sms_sender,sms_ai,sms_automation;

create or replace function sms_private.enquiry_quiet_until(t text,ph text,simulate boolean default false) returns timestamptz
language plpgsql security definer set search_path='' as $$
declare until_at timestamptz; s sms_private.inbound_ai_settings; begin
 select * into s from sms_private.inbound_ai_settings where tenant_id=t;
 if not coalesce(s.coordination_enabled,false) or (s.mode<>'live' and not(simulate and s.mode='shadow')) then return null; end if;
 select greatest(
  (select created_at from public.sms_messages where tenant_id=t and contact_phone=ph and direction='inbound' order by created_at desc limit 1),
  (select provider_accepted_at from public.sms_messages where tenant_id=t and contact_phone=ph and direction='outbound' and provider_accepted_at is not null and meta->>'agent_version'='sms-agent-v1' order by provider_accepted_at desc limit 1)
 )+interval '30 minutes' into until_at;
 if exists(select from sms_private.jobs where tenant_id=t and queue='ai_reply_jobs' and payload->>'phone'=ph
  and payload->>'agent_version'='sms-agent-v1' and (payload->>'settings_revision')::integer=s.revision and status in ('queued','retry','processing'))
 or exists(select from sms_private.jobs j join public.sms_messages m on m.tenant_id=j.tenant_id and m.id=(j.payload->>'message_id')::uuid
  where j.tenant_id=t and j.queue='sms_send_jobs' and j.payload->'request'->>'phone'=ph and j.payload->'request'->>'agent_version'='sms-agent-v1'
  and m.provider_accepted_at is null and j.status in ('queued','retry','processing','submitting','submission_unknown')) then
  until_at:=greatest(until_at,now()+interval '1 minute');
 end if;
 return until_at;
end $$;

create or replace function sms_private.run_quiet_until(r sms_private.form_runs) returns timestamptz
language plpgsql security definer set search_path='' as $$
declare due timestamptz; begin
 if r.origin<>'direct' then return sms_private.enquiry_quiet_until(r.tenant_id,r.phone); end if;
 select greatest(
  (select created_at from public.sms_messages where tenant_id=r.tenant_id and contact_phone=r.phone and direction='inbound' order by created_at desc limit 1),
  (select provider_accepted_at from public.sms_messages where tenant_id=r.tenant_id and contact_phone=r.phone and direction='outbound' and provider_accepted_at is not null and meta->>'agent_version'='sms-agent-v1' order by provider_accepted_at desc limit 1)
 )+interval '30 minutes' into due;
 return greatest(due,sms_private.enquiry_quiet_until(r.tenant_id,r.phone));
end $$;

create or replace function sms_private.enqueue_due_automations() returns integer
language plpgsql security definer set search_path='' as $$
declare tenant record; r sms_private.form_runs; n integer:=0; checked integer:=0; quota integer; batch integer; tenant_count integer; visited integer;
begin
 if not pg_try_advisory_xact_lock(720491324) then return 0; end if;
 select scheduler_batch_size into batch from sms_private.runtime;
 insert into sms_private.automation_scheduler_state(tenant_id)
  select tenant_id from public.sms_businesses where sending_enabled and status='active' on conflict do nothing;
 select least(32,count(*))::integer into tenant_count from sms_private.automation_scheduler_state s
  join public.sms_businesses b using(tenant_id) where b.sending_enabled and b.status='active';
 quota:=least(64,greatest(1,batch/greatest(1,tenant_count)));
 for tenant in select s.* from sms_private.automation_scheduler_state s join public.sms_businesses b using(tenant_id)
  where b.sending_enabled and b.status='active' order by s.checked_at,s.tenant_id limit 32
 loop
  visited:=0;
  for r in select e.* from sms_private.form_runs e where e.tenant_id=tenant.tenant_id and e.status='active' and e.next_run_at<=now()
   and (tenant.cursor_due is null or (e.next_run_at,e.id)>(tenant.cursor_due,tenant.cursor_id))
   and not exists(select from sms_private.jobs j where j.tenant_id=e.tenant_id and j.queue='automation_jobs' and j.dedupe_key='form:'||e.id||':'||e.generation||':'||e.send_index)
   order by e.next_run_at,e.id limit least(quota,batch-checked)
  loop
   checked:=checked+1; visited:=visited+1;
   update sms_private.automation_scheduler_state set cursor_due=r.next_run_at,cursor_id=r.id where tenant_id=tenant.tenant_id;
   if not sms_private.run_enabled(r) then continue; end if;
   if r.appointment_at is null and sms_private.form_run_sequence(r)->>'replyPolicy'='continue'
    and coalesce(sms_private.run_quiet_until(r),now())>now() then continue; end if;
   perform sms_private.enqueue(r.tenant_id,'automation_jobs','form:'||r.id||':'||r.generation||':'||r.send_index,
    jsonb_build_object('form_run_id',r.id,'generation',r.generation,'send_index',r.send_index));
   n:=n+1;
  end loop;
  update sms_private.automation_scheduler_state set checked_at=clock_timestamp(),
   cursor_due=case when visited<quota then null else cursor_due end,
   cursor_id=case when visited<quota then null else cursor_id end where tenant_id=tenant.tenant_id;
  exit when checked>=batch;
 end loop;
 return n;
end $$;

create or replace function sms_private.email_finish(jid uuid,token uuid,outcome text,provider text default null,
  code text default null) returns void
language plpgsql security definer set search_path='' as $$
#variable_conflict use_column
declare j sms_private.email_jobs; e sms_private.email_enrollments; b public.sms_businesses;
  due timestamptz; tz text;
begin
  if not pg_has_role(session_user,'sms_automation','member') then raise exception 'Worker role denied' using errcode='42501'; end if;
  select * into strict j from sms_private.email_jobs where id=jid and lease_token=token
    and status='processing' and lease_until>now() for update;
  if outcome not in ('sent','retry','failed','uncertain') then raise exception 'Invalid email outcome'; end if;
  select * into strict e from sms_private.email_enrollments where id=j.enrollment_id;
  select time_zone into tz from public.sms_businesses where tenant_id=e.tenant_id;
  due:=sms_private.form_due(now()+make_interval(secs=>least(3600,30*(2^least(j.attempts,10))::integer)),0,'minute',tz,(e.rule_snapshot->>'startHour')::integer,(e.rule_snapshot->>'endHour')::integer);
  update sms_private.email_jobs set
    status=case when outcome='retry' and attempts<5 then 'pending'
      when outcome='retry' then 'failed' else outcome end,
    due_at=case when outcome='retry' then due else due_at end,
    provider_id=coalesce(provider_id,provider),error_code=code,
    lease_token=null,lease_until=null,updated_at=now() where id=jid;
  if outcome<>'sent' then
    if outcome in ('failed','uncertain') or outcome='retry' and j.attempts>=5 then
      update sms_private.email_enrollments set status='paused',pause_reason=coalesce(code,'EMAIL_FAILED'),updated_at=now()
       where id=j.enrollment_id and status='active' and generation=j.generation and step_index=j.step_index;
    end if;
    return;
  end if;
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

create or replace function sms_private.tick() returns integer
language plpgsql security definer set search_path='' as $$
declare j record; n integer:=0;
begin
  if not pg_try_advisory_xact_lock(720491321) then return 0; end if;
  perform sms_private.prune_worker_heartbeats();
  perform sms_private.recover_email_jobs();
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

create or replace function sms_private.email_resolve(u text,t text,eid uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare result sms_private.email_enrollments; begin
  perform sms_private.require_web_form_editor(u,t);
  update sms_private.email_enrollments set status='resolved',next_run_at=null,
    generation=generation+1,updated_at=now()
    where id=eid and tenant_id=t and status in ('active','paused') returning * into result;
  if result.id is null then raise exception 'Active email enrollment not found' using errcode='P0002'; end if;
  return to_jsonb(result);
end $$;

create or replace function sms_private.email_overview(u text,t text) returns jsonb
language plpgsql security definer set search_path='' as $$
begin
  perform sms_private.require_web_form_editor(u,t);
  return jsonb_build_object(
    'configured',true,
    'workerReady',exists(select from sms_private.edge_config c
      where c.queue='automation_jobs' and c.enabled and c.secret_id is not null),
    'groups',coalesce((select jsonb_agg(to_jsonb(s)||jsonb_build_object('name',g.name,'fixedType',g.fixed_type)
      order by g.name) from sms_private.email_group_settings s
      join public.sms_automation_groups g on g.tenant_id=s.tenant_id and g.id=s.group_id
      where s.tenant_id=t),'[]'::jsonb),
    'enrollments',coalesce((select jsonb_agg(x order by x.enrolled_at desc) from
      (select id,group_id,email,name,source_type,status,pause_reason,step_index,next_run_at,enrolled_at
       from sms_private.email_enrollments where tenant_id=t order by enrolled_at desc limit 100)x),'[]'::jsonb),
    'jobs',coalesce((select jsonb_agg(x order by x.created_at desc) from
      (select j.id,e.group_id,e.email,j.subject,j.status,j.provider_status,j.provider_id,
         j.error_code,j.step_index,j.created_at from sms_private.email_jobs j
       join sms_private.email_enrollments e on e.id=j.enrollment_id
       where e.tenant_id=t order by j.created_at desc limit 100)x),'[]'::jsonb)
  );
end $$;

-- Form lifecycle is shared with SMS; this focused hook also terminates paused email.
create or replace function sms_private.email_form_disabled() returns trigger
language plpgsql security definer set search_path='' as $$ begin
 if not new.enabled or not new.email_enabled or new.archived then
  update sms_private.email_enrollments set status='cancelled',pause_reason=null,next_run_at=null,
   generation=generation+1,updated_at=now()
   where tenant_id=new.tenant_id and form_public_id=new.public_id and status in ('active','paused');
 end if;
 return new;
end $$;
revoke all on function sms_private.email_form_disabled() from public,anon,authenticated,sms_api,sms_sender,sms_ai,sms_automation;

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

-- Maintained current activity view and reporting API. Requires queue-reporting.sql.
create or replace view sms_private.activity_enquiries as
 select r.id,r.tenant_id,r.form_id,r.version,r.submission_id,r.intake_id,r.phone,r.context,r.appointment_at,r.status,r.reason,r.message_index,r.repeat_index,r.send_index,r.generation,r.next_run_at,r.last_sent_at,r.created_at,r.test_sequence,r.test_actor,r.test_request,coalesce(f.title,d.name) as form_title,coalesce(nullif(r.context->>'name',''),c.name,'Unknown') as customer,
 c.opted_out,cv.id as conversation_id,coalesce(cv.ai_paused,false) as ai_paused,
 case when r.test_sequence is not null then 'test' when r.appointment_at is not null or sms_private.form_run_sequence(r)->>'trigger'='appointment' then 'appointment' when r.origin='direct' then 'direct' else 'enquiry' end as scope,
 case when r.appointment_at is null and sms_private.form_run_sequence(r)->>'replyPolicy'='continue' then sms_private.run_quiet_until(r) end as quiet_until,
 (select a.accepted_at from sms_private.activity_first_contacts a where a.tenant_id=r.tenant_id and a.run_id=r.id) as first_contact_at,
 (select count(*) from sms_private.activity_responses a where a.tenant_id=r.tenant_id and a.run_id=r.id) as response_count,
 (select left(m.body,200) from sms_private.activity_responses a join public.sms_messages m on m.tenant_id=a.tenant_id and m.id=a.message_id where a.tenant_id=r.tenant_id and a.run_id=r.id order by m.created_at desc limit 1) as latest_response,
 (select count(*) from sms_private.activity_bookings a where a.tenant_id=r.tenant_id and a.run_id=r.id) as linked_bookings,
 (select count(*) from sms_private.activity_bookings a join public.sms_bookings b on b.tenant_id=a.tenant_id and b.id=a.booking_id where a.tenant_id=r.tenant_id and a.run_id=r.id and b.status='confirmed') as confirmed_bookings,
 (select count(*) from sms_private.activity_bookings a join public.sms_bookings b on b.tenant_id=a.tenant_id and b.id=a.booking_id where a.tenant_id=r.tenant_id and a.run_id=r.id and b.status='cancelled') as cancelled_bookings,
 (select count(*) from sms_private.activity_handoffs a join public.sms_handoffs h on h.tenant_id=a.tenant_id and h.id=a.handoff_id where a.tenant_id=r.tenant_id and a.run_id=r.id) as handoffs,
 (select count(*) from sms_private.activity_handoffs a join public.sms_handoffs h on h.tenant_id=a.tenant_id and h.id=a.handoff_id where a.tenant_id=r.tenant_id and a.run_id=r.id and h.status in ('open','assigned')) as unresolved_handoffs,
 coalesce((select jsonb_agg(jsonb_build_object('id',t.id,'name',t.name) order by t.name) from sms_private.activity_run_tags a join sms_private.activity_tags t on t.tenant_id=a.tenant_id and t.id=a.tag_id where a.tenant_id=r.tenant_id and a.run_id=r.id and not t.archived),'[]') as tags,r.origin,r.direct_template_id,r.direct_sequence,r.actor,r.enrollment_key
 from sms_private.form_runs r left join public.sms_web_form_definitions f on f.tenant_id=r.tenant_id and f.public_id=r.form_id left join sms_private.direct_templates d on d.tenant_id=r.tenant_id and d.id=r.direct_template_id
 left join public.sms_contacts c on c.tenant_id=r.tenant_id and c.phone=r.phone
 left join public.sms_conversations cv on cv.tenant_id=r.tenant_id and cv.phone=r.phone and cv.group_id is null;

CREATE OR REPLACE FUNCTION sms_private.automation_activity(u text, t text, action text, p jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare report_at timestamptz:=statement_timestamp(); tz text; from_at timestamptz; until_at timestamptz; result jsonb;
 r sms_private.form_runs; v_booking public.sms_bookings; v_message public.sms_messages; tag sms_private.activity_tags;
 rid uuid; old_rid uuid; rev integer; manage boolean:=false; pg integer:=greatest(1,coalesce((p->>'page')::integer,1));
 page_size integer:=least(100,greatest(1,coalesce((p->>'pageSize')::integer,25))); from_day date; end_day date;
begin
 perform sms_private.require_sms_reader(u,t);
 begin perform sms_private.require_admin(u); manage:=true; exception when insufficient_privilege then manage:=false; end;
 select time_zone into tz from public.sms_businesses where tenant_id=t; tz:=coalesce(tz,'UTC');
 from_day:=coalesce(nullif(p->>'from','')::date,(report_at at time zone tz)::date-29);
 end_day:=coalesce(nullif(p->>'to','')::date,(report_at at time zone tz)::date);
 if end_day<from_day or end_day-from_day>366 then raise exception 'Choose a date range of up to 367 days'; end if;
 from_at:=from_day::timestamp at time zone tz; until_at:=(end_day+1)::timestamp at time zone tz;
 if action in ('tag','tag_assignment','booking_link','response_link','activity_link','sequence') then
  if not manage then raise exception 'Staff management access required' using errcode='42501'; end if;
  if action='tag' then
   if nullif(p->>'id','') is null then
    insert into sms_private.activity_tags(tenant_id,name) values(t,trim(p->>'name')) returning * into tag;
   else
    select * into tag from sms_private.activity_tags where tenant_id=t and id=(p->>'id')::uuid for update;
    if tag.id is null then raise exception 'Tag not found' using errcode='42501'; end if;
    if tag.revision is distinct from (p->>'revision')::integer then raise exception 'Tag changed; refresh before editing' using errcode='40001'; end if;
    update sms_private.activity_tags set name=coalesce(trim(p->>'name'),name),archived=coalesce((p->>'archived')::boolean,archived),revision=revision+1 where tenant_id=t and id=tag.id returning * into tag;
   end if;
   perform sms_private.activity_event(t,null,'tag:'||tag.id||':'||tag.revision,'staff_tag',clock_timestamp(),jsonb_build_object('actor',u,'tagId',tag.id,'name',tag.name,'archived',tag.archived));
   return jsonb_build_object('tag',to_jsonb(tag),'reportingAt',report_at);
  end if;
  select * into r from sms_private.form_runs where tenant_id=t and id=(p->>'runId')::uuid;
  if r.id is null then raise exception 'Enquiry not found' using errcode='42501'; end if;
  perform sms_private.coordination_lock(t,r.phone);
  select * into r from sms_private.form_runs where tenant_id=t and id=r.id for update;
  if action='sequence' then
   if p->>'operation' not in ('pause','resume','stop') then raise exception 'Choose pause, resume or stop'; end if;
   if r.generation is distinct from (p->>'generation')::bigint then raise exception 'Sequence changed; refresh before editing' using errcode='40001'; end if;
   if p->>'operation'='resume' and exists(select from public.sms_contacts where tenant_id=t and phone=r.phone and opted_out) then raise exception 'STOP suppression prevents resuming'; end if;
   perform sms_private.contact_automations(u,t,'run',p||jsonb_build_object('contactId',(select id from public.sms_contacts where tenant_id=t and phone=r.phone),'idempotencyKey',coalesce(p->>'idempotencyKey','activity:'||r.id||':'||r.generation||':'||(p->>'operation'))));
  elsif action='tag_assignment' then
   select * into tag from sms_private.activity_tags where tenant_id=t and id=(p->>'tagId')::uuid for share;
   if tag.id is null or tag.archived then raise exception 'Active business tag required' using errcode='42501'; end if;
   if (p->>'present')::boolean then insert into sms_private.activity_run_tags values(t,r.id,tag.id) on conflict do nothing;
   else delete from sms_private.activity_run_tags where tenant_id=t and run_id=r.id and tag_id=tag.id; end if;
  elsif action='booking_link' then
   if r.test_sequence is not null or r.appointment_at is not null then raise exception 'Choose a real enquiry'; end if;
   select * into v_booking from public.sms_bookings where tenant_id=t and id=p->>'bookingId' for update;
   if v_booking.id is null or coalesce(v_booking.customer_phone,(select phone from public.sms_contacts where tenant_id=t and id=v_booking.contact_id)) is distinct from r.phone then raise exception 'Same-business, same-customer booking required' using errcode='42501'; end if;
   select run_id,revision into old_rid,rev from sms_private.activity_bookings where tenant_id=t and booking_id=v_booking.id;
   if coalesce(rev,0) is distinct from (p->>'revision')::integer then raise exception 'Booking attribution changed; refresh before editing' using errcode='40001'; end if;
   insert into sms_private.activity_bookings(tenant_id,booking_id,run_id,basis,actor) values(t,v_booking.id,r.id,'staff_explicit',u)
    on conflict(tenant_id,booking_id) do update set run_id=excluded.run_id,basis=excluded.basis,actor=u,revision=activity_bookings.revision+1,linked_at=clock_timestamp();
   if old_rid is not null and old_rid<>r.id then perform sms_private.activity_event(t,old_rid,'booking-unlink:'||v_booking.id||':'||rev,'booking_attribution_removed',clock_timestamp(),jsonb_build_object('actor',u,'bookingId',v_booking.id,'newRunId',r.id)); end if;
   if r.origin='direct' and v_booking.status='confirmed' and r.status in ('active','paused') then update sms_private.form_runs set status='stopped',reason='LINKED_BOOKING_CONFIRMED',next_run_at=null,generation=generation+1 where id=r.id;end if;
  elsif action='activity_link' then
   if not exists(select from sms_private.activity_events e left join public.sms_conversations cv on cv.tenant_id=e.tenant_id and cv.id::text=e.details->>'conversationId'
    where e.tenant_id=t and e.id=(p->>'eventId')::bigint and e.kind in ('ai_action','ai_run','ai_sent') and coalesce(e.details->>'phone',cv.phone)=r.phone) then raise exception 'Same-customer AI activity required' using errcode='42501'; end if;
   update sms_private.activity_events set run_id=r.id,revision=revision+1 where tenant_id=t and id=(p->>'eventId')::bigint and revision=(p->>'revision')::integer;
   if not found then raise exception 'Activity attribution changed; refresh before editing' using errcode='40001'; end if;
  elsif action='response_link' then
   select * into v_message from public.sms_messages where tenant_id=t and id=(p->>'messageId')::uuid and direction='inbound' for update;
   if v_message.id is null or v_message.contact_phone<>r.phone then raise exception 'Same-customer response required' using errcode='42501'; end if;
   select run_id,revision into old_rid,rev from sms_private.activity_responses where tenant_id=t and message_id=v_message.id;
   if coalesce(rev,0) is distinct from (p->>'revision')::integer then raise exception 'Response attribution changed; refresh before editing' using errcode='40001'; end if;
   insert into sms_private.activity_responses(tenant_id,message_id,run_id,basis,actor) values(t,v_message.id,r.id,'staff_explicit',u)
    on conflict(tenant_id,message_id) do update set run_id=excluded.run_id,basis=excluded.basis,actor=u,revision=activity_responses.revision+1;
   update sms_private.activity_events set run_id=r.id where tenant_id=t and event_key='reply:'||v_message.id;
   if old_rid is not null and old_rid<>r.id then perform sms_private.activity_event(t,old_rid,'response-unlink:'||v_message.id||':'||rev,'response_attribution_removed',clock_timestamp(),jsonb_build_object('actor',u,'messageId',v_message.id,'newRunId',r.id)); end if;
  end if;
  perform sms_private.activity_event(t,r.id,'staff:'||gen_random_uuid(),'staff_'||action,clock_timestamp(),p||jsonb_build_object('actor',u));
  return jsonb_build_object('ok',true,'reportingAt',report_at);
 end if;
 if action='timeline' then
  select * into r from sms_private.form_runs where tenant_id=t and id=(p->>'runId')::uuid;
  if r.id is null then raise exception 'Enquiry not found' using errcode='42501'; end if;
  return jsonb_build_object('reportingAt',report_at,'timeZone',tz,'canManage',manage,
   'enquiry',(select to_jsonb(x) from sms_private.activity_enquiries x where tenant_id=t and id=r.id),
   'events',coalesce((select jsonb_agg(to_jsonb(e) order by e.recorded_at,e.id) from sms_private.activity_events e where tenant_id=t and run_id=r.id),'[]'),
   'bookings',coalesce((select jsonb_agg(jsonb_build_object('id',b.id,'status',b.status,'appointmentAt',b.appointment_at,'channel',coalesce(b.source,'Unknown'),'creator',coalesce(b.metadata->>'actor','Unknown'),'linkedRunId',a.run_id,'revision',coalesce(a.revision,0))) from public.sms_bookings b left join sms_private.activity_bookings a on a.tenant_id=b.tenant_id and a.booking_id=b.id left join public.sms_contacts c on c.tenant_id=b.tenant_id and c.id=b.contact_id where b.tenant_id=t and coalesce(b.customer_phone,c.phone)=r.phone),'[]'),
   'handoffs',coalesce((select jsonb_agg(jsonb_build_object('id',h.id,'status',h.status,'reason',h.reason)) from sms_private.activity_handoffs a join public.sms_handoffs h on h.tenant_id=a.tenant_id and h.id=a.handoff_id where a.tenant_id=t and a.run_id=r.id),'[]'));
 end if;
 if action='unlinked' then
  with items as materialized (
   select e.* from sms_private.activity_events e where tenant_id=t
    and (case when p->>'shadow'='true' then simulated else run_id is null and not simulated end)
    and kind in ('customer_response','ai_action','ai_sent','ai_run')
    and coalesce(occurred_at,recorded_at)>=from_at and coalesce(occurred_at,recorded_at)<until_at
    and (coalesce(p->>'search','')='' or details::text ilike '%'||(p->>'search')||'%')
  ), paged as materialized (select * from items order by recorded_at desc,id desc limit page_size offset (pg-1)*page_size)
  select jsonb_build_object('reportingAt',report_at,'timeZone',tz,'total',(select count(*) from items),'page',pg,
   'rows',coalesce((select jsonb_agg(to_jsonb(e)||jsonb_build_object('candidates',coalesce((
    select jsonb_agg(jsonb_build_object('id',fr.id,'title',coalesce(f.title,d.name))) from sms_private.form_runs fr
    left join public.sms_web_form_definitions f on f.tenant_id=fr.tenant_id and f.public_id=fr.form_id
    left join sms_private.direct_templates d on d.tenant_id=fr.tenant_id and d.id=fr.direct_template_id
    where fr.tenant_id=t and fr.phone=e.details->>'phone' and fr.test_sequence is null and fr.appointment_at is null),'[]'))
    order by e.recorded_at desc,e.id desc) from paged e),'[]')) into result;
  return result;
 end if;
 if action not in ('report','summary','enquiries') then raise exception 'Unknown activity operation'; end if;
 -- Base carries only filtering keys. Never materialize the wide display view
 -- across history: date cohorts, the selected page, and live workload diverge.
 with base as materialized (
  select frun.id,frun.tenant_id,frun.phone,frun.status,frun.created_at,a.accepted_at as first_contact_at,
   cv.id as conversation_id,coalesce(cv.ai_paused,false) as ai_paused,sc.scope
  from sms_private.form_runs frun
  left join sms_private.activity_first_contacts a on a.run_id=frun.id and a.tenant_id=frun.tenant_id
  left join public.sms_contacts c on c.tenant_id=frun.tenant_id and c.phone=frun.phone
  left join public.sms_conversations cv on cv.tenant_id=frun.tenant_id and cv.phone=frun.phone and cv.group_id is null
  left join sms_private.form_sequence_versions v on v.tenant_id=frun.tenant_id and v.form_id=frun.form_id and v.version=frun.version
  cross join lateral (select case when frun.test_sequence is not null then 'test'
   when frun.appointment_at is not null or coalesce(frun.direct_sequence,frun.test_sequence,v.sequence)->>'trigger'='appointment' then 'appointment'
   when frun.origin='direct' then 'direct' else 'enquiry' end as scope)sc
  where frun.tenant_id=t
   and (sc.scope=coalesce(nullif(p->>'scope',''),'all') or coalesce(nullif(p->>'scope',''),'all')='all' and sc.scope in ('enquiry','direct'))
   and (coalesce(p->>'template','')='' or frun.direct_template_id::text=p->>'template')
   and (coalesce(p->>'form','')='' or frun.form_id::text=p->>'form')
   and (coalesce(p->>'status','')='' or frun.status=p->>'status')
   and (coalesce(p->>'search','')='' or coalesce(nullif(frun.context->>'name',''),c.name,'Unknown') ilike '%'||(p->>'search')||'%' or frun.phone ilike '%'||(p->>'search')||'%')
   and (coalesce(p->>'tags','')='' or exists(select from sms_private.activity_run_tags rt join sms_private.activity_tags tag_filter on tag_filter.tenant_id=rt.tenant_id and tag_filter.id=rt.tag_id
    where rt.tenant_id=t and rt.run_id=frun.id and not tag_filter.archived and tag_filter.id::text=any(string_to_array(p->>'tags',','))))
   and (coalesce(p->>'response','')='' or exists(select from sms_private.activity_responses x where x.tenant_id=t and x.run_id=frun.id)=(p->>'response'='responded'))
   and (coalesce(p->>'booking','')='' or case p->>'booking'
    when 'booked' then exists(select from sms_private.activity_bookings x join public.sms_bookings b on b.tenant_id=x.tenant_id and b.id=x.booking_id where x.tenant_id=t and x.run_id=frun.id and b.status='confirmed')
    when 'cancelled' then exists(select from sms_private.activity_bookings x join public.sms_bookings b on b.tenant_id=x.tenant_id and b.id=x.booking_id where x.tenant_id=t and x.run_id=frun.id and b.status='cancelled')
    else not exists(select from sms_private.activity_bookings x join public.sms_bookings b on b.tenant_id=x.tenant_id and b.id=x.booking_id where x.tenant_id=t and x.run_id=frun.id and b.status='confirmed') end)
   and (coalesce(p->>'handoff','')='' or case p->>'handoff'
    when 'unresolved' then exists(select from sms_private.activity_handoffs x join public.sms_handoffs h on h.tenant_id=x.tenant_id and h.id=x.handoff_id where x.tenant_id=t and x.run_id=frun.id and h.status in ('open','assigned'))
    when 'any' then exists(select from sms_private.activity_handoffs x where x.tenant_id=t and x.run_id=frun.id)
    else not exists(select from sms_private.activity_handoffs x where x.tenant_id=t and x.run_id=frun.id) end)
   and (coalesce(p->>'quick','')='' or case p->>'quick'
    when 'attention' then frun.status='paused' or cv.ai_paused or exists(select from sms_private.activity_handoffs x join public.sms_handoffs h on h.tenant_id=x.tenant_id and h.id=x.handoff_id where x.tenant_id=t and x.run_id=frun.id and h.status in ('open','assigned'))
    when 'paused' then frun.status='paused' or cv.ai_paused
    when 'responded' then exists(select from sms_private.activity_responses x where x.tenant_id=t and x.run_id=frun.id)
    when 'booked' then exists(select from sms_private.activity_bookings x join public.sms_bookings b on b.tenant_id=x.tenant_id and b.id=x.booking_id where x.tenant_id=t and x.run_id=frun.id and b.status='confirmed') else true end)
 ), cohort as materialized (
  select x.id,x.scope,x.response_count,x.confirmed_bookings,x.cancelled_bookings,x.linked_bookings,x.handoffs
  from (select id from base where first_contact_at>=from_at and first_contact_at<until_at and first_contact_at<=report_at)b
  cross join lateral (select x.id,x.scope,x.response_count,x.confirmed_bookings,x.cancelled_bookings,x.linked_bookings,x.handoffs
   from sms_private.activity_enquiries x where x.tenant_id=t and x.id=b.id offset 0)x
 ), listed as materialized (
  select * from base where coalesce(first_contact_at,created_at)>=from_at and coalesce(first_contact_at,created_at)<until_at
 ), paged as materialized (
  select * from listed order by coalesce(first_contact_at,created_at) desc,id limit page_size offset (pg-1)*page_size
 ), totals as (
  select count(*) as contacted,count(*) filter(where response_count>0) as responded,count(*) filter(where confirmed_bookings>0) as booked,count(*) filter(where cancelled_bookings>0) as cancelled from cohort where scope='enquiry'
 ), activity as (
  select e.* from sms_private.activity_events e join base b on b.id=e.run_id where e.tenant_id=t and not e.simulated and e.occurred_at>=from_at and e.occurred_at<until_at and e.occurred_at<=report_at
 ), live_candidates as materialized (
  select frun from base b join sms_private.form_runs frun on frun.id=b.id where b.status='active'
   and frun.appointment_at is null and sms_private.form_run_sequence(frun)->>'replyPolicy'='continue'
 ), live_quiet as materialized (
  select (frun).id from live_candidates where sms_private.run_quiet_until(frun)>report_at
 )
 select jsonb_build_object('reportingAt',report_at,'timeZone',tz,'from',from_day,'to',end_day,'canManage',manage,'page',pg,'pageSize',page_size,
  'definitions',jsonb_build_object('cohort','First provider-accepted automation message in the selected business-local dates. Subsequent attributed outcomes through reporting time.','conversion','Distinct contacted enquiries with a currently confirmed primary-linked booking. Cancelled, shadow, test and appointment runs excluded.','activity','Actual events in the selected dates; accepted is not delivered. Historical delivery snapshots without a known time are excluded.','workload','Current workload across all dates, using the other selected filters.'),
  'directFunnel',(select jsonb_build_object('contacted',count(*),'responded',count(*) filter(where response_count>0),'booked',count(*) filter(where confirmed_bookings>0),'cancelled',count(*) filter(where cancelled_bookings>0),'responseRate',round(100.0*count(*) filter(where response_count>0)/nullif(count(*),0),1),'conversionRate',round(100.0*count(*) filter(where confirmed_bookings>0)/nullif(count(*),0),1)) from cohort where scope='direct'),
  'templates',coalesce((select jsonb_agg(jsonb_build_object('id',id,'title',name) order by name) from sms_private.direct_templates where tenant_id=t),'[]'),
  'funnel',(select to_jsonb(totals)||jsonb_build_object('responseRate',round(100.0*responded/nullif(contacted,0),1),'conversionRate',round(100.0*booked/nullif(contacted,0),1)) from totals),
  'activity',(select jsonb_build_object('accepted',count(*) filter(where kind='automation_accepted'),'delivered',count(*) filter(where kind='message_delivered' and details->>'automation'='true'),'responses',count(*) filter(where kind='customer_response'),'aiSent',count(*) filter(where kind='ai_sent')) from activity),
  'outcomes',jsonb_build_object('linkedBookings',(select coalesce(sum(linked_bookings),0) from cohort),'handoffs',(select coalesce(sum(handoffs),0) from cohort)),
  'workload',jsonb_build_object('active',(select count(*) from base where status='active'),'quiet',(select count(*) from live_quiet),'paused',(select count(*) from base where status='paused'),
   'aiPaused',(select count(*) from public.sms_conversations cv where cv.tenant_id=t and cv.ai_paused and (exists(select from base bx where bx.conversation_id=cv.id) or (not exists(select from sms_private.form_runs fr where fr.tenant_id=t and fr.phone=cv.phone) and coalesce(p->>'form','')='' and coalesce(p->>'tags','')='' and coalesce(p->>'status','')='' and coalesce(p->>'search','')=''))),
   'unresolvedHandoffs',(select count(*) from sms_private.activity_handoffs ah join public.sms_handoffs h on h.tenant_id=ah.tenant_id and h.id=ah.handoff_id join base b on b.id=ah.run_id where ah.tenant_id=t and h.status in ('open','assigned'))
    +(select count(*) from public.sms_handoffs h where h.tenant_id=t and h.status in ('open','assigned') and not exists(select from sms_private.activity_handoffs ah where ah.tenant_id=t and ah.handoff_id=h.id) and coalesce(p->>'form','')='' and coalesce(p->>'tags','')='' and coalesce(p->>'status','')='' and coalesce(p->>'search','')='')),
  'total',(select count(*) from listed),
  'rows',coalesce((select jsonb_agg(to_jsonb(x) order by coalesce(b.first_contact_at,b.created_at) desc,b.id) from paged b
   cross join lateral (select * from sms_private.activity_enquiries x where x.tenant_id=t and x.id=b.id offset 0)x),'[]'),
  'forms',coalesce((select jsonb_agg(jsonb_build_object('id',public_id,'title',title) order by title) from public.sms_web_form_definitions where tenant_id=t),'[]'),
  'tags',coalesce((select jsonb_agg(to_jsonb(tag_row) order by name) from sms_private.activity_tags tag_row where tenant_id=t),'[]')) into result;
 return result;
end $function$;
