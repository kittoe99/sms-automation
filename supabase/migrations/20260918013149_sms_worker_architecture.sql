-- Additive CRM schema. Existing website tables are deliberately not referenced.
create extension if not exists pgmq;
create extension if not exists pg_cron;
create extension if not exists supabase_vault;
create schema if not exists sms_private;
revoke all on schema sms_private from public, anon, authenticated;
alter default privileges in schema sms_private revoke execute on functions from public;

do $$ begin
  if not exists (select from pg_roles where rolname='sms_api') then create role sms_api nologin; end if;
  if not exists (select from pg_roles where rolname='sms_webhook') then create role sms_webhook nologin; end if;
  if not exists (select from pg_roles where rolname='sms_sender') then create role sms_sender nologin; end if;
  if not exists (select from pg_roles where rolname='sms_automation') then create role sms_automation nologin; end if;
  if not exists (select from pg_roles where rolname='sms_ai') then create role sms_ai nologin; end if;
end $$;

-- Worker functions validate the login's group membership before touching any queue.
create function sms_private.worker_access(q text) returns void language plpgsql security definer set search_path='' as $$
#variable_conflict use_column

declare r text; begin
 r:=case q when 'sms_send_jobs' then 'sms_sender' when 'ai_reply_jobs' then 'sms_ai' when 'automation_jobs' then 'sms_automation' when 'provisioning_jobs' then 'sms_automation' end;
 if r is null or not pg_has_role(session_user,r,'member') then raise exception 'Worker role denied' using errcode='42501'; end if;
end $$;

create table public.sms_businesses (
  tenant_id text primary key check (tenant_id ~ '^[a-z0-9][a-z0-9_-]{0,63}$'),
  name text not null check (length(name) between 1 and 100),
  time_zone text not null default 'America/Denver',
  sending_enabled boolean not null default false,
  status text not null default 'pending' check(status in ('pending','active','paused')),
  profile jsonb not null default '{}', created_at timestamptz not null default now()
);
create table sms_private.admins (clerk_user_id text primary key);
create table public.sms_business_memberships (
  tenant_id text references public.sms_businesses on delete cascade,
  clerk_user_id text not null, role text not null default 'admin' check(role in ('admin','viewer')),
  primary key (tenant_id,clerk_user_id)
);
create table public.sms_contacts (
  tenant_id text references public.sms_businesses,
  id uuid not null default gen_random_uuid(), phone text not null check(phone ~ '^\+[1-9][0-9]{7,14}$'),
  name text not null default '', email text, source text not null default 'contact',
  marketing_consent boolean not null default false, opted_out boolean not null default false,
  generation bigint not null default 0, metadata jsonb not null default '{}',
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  primary key(tenant_id,id), unique(tenant_id,phone)
);
create table public.sms_consent_events (
  tenant_id text not null, id uuid not null default gen_random_uuid(), contact_id uuid not null,
  consent boolean not null, source text not null, evidence text not null,
  created_at timestamptz not null default now(), primary key(tenant_id,id),
  foreign key(tenant_id,contact_id) references public.sms_contacts(tenant_id,id)
);
create table public.sms_thread_contacts (
  tenant_id text not null, phone text not null, name text not null default '',
  generation bigint not null default 0, ai_paused boolean not null default false,
  unread_count integer not null default 0, last_body text, last_direction text,
  last_message_at timestamptz, last_inbound_at timestamptz,
  primary key(tenant_id,phone), foreign key(tenant_id,phone) references public.sms_contacts(tenant_id,phone)
);
create table public.sms_automation_groups (
  tenant_id text references public.sms_businesses, id text not null, name text not null,
  description text not null default '', active boolean not null default true,
  version bigint not null default 1, kind text not null default 'custom' check(kind in ('quote','reminder','custom')),
  rule jsonb not null default '{}', created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(), primary key(tenant_id,id)
);
create table public.sms_automation_steps (
  tenant_id text not null, group_id text not null, step_index integer not null check(step_index>=0),
  template text not null check(length(template) between 1 and 1600),
  delay_count integer not null check(delay_count between 0 and 365),
  delay_unit text not null check(delay_unit in ('day','week','month')),
  primary key(tenant_id,group_id,step_index),
  foreign key(tenant_id,group_id) references public.sms_automation_groups(tenant_id,id) on delete cascade
);
create table public.sms_automation_enrollments (
  tenant_id text not null, id uuid not null default gen_random_uuid(), contact_id uuid not null,
  category_id text not null, status text not null default 'active' check(status in ('active','paused','completed','cancelled')),
  generation bigint not null default 1, step_index integer not null default 0,
  next_run_at timestamptz, appointment_at timestamptz, last_sent_at timestamptz,
  metadata jsonb not null default '{}', created_at timestamptz not null default now(),
  primary key(tenant_id,id), foreign key(tenant_id,contact_id) references public.sms_contacts(tenant_id,id),
  foreign key(tenant_id,category_id) references public.sms_automation_groups(tenant_id,id)
);
create unique index sms_active_enrollment on public.sms_automation_enrollments(tenant_id,contact_id,category_id) where status='active';
create index sms_enrollments_due on public.sms_automation_enrollments(next_run_at,tenant_id) where status='active';
create table public.sms_bookings (
  tenant_id text not null, id text not null, contact_id uuid not null,
  appointment_at timestamptz not null, status text not null default 'confirmed' check(status in ('confirmed','cancelled','requested')),
  metadata jsonb not null default '{}', updated_at timestamptz not null default now(),
  primary key(tenant_id,id), foreign key(tenant_id,contact_id) references public.sms_contacts(tenant_id,id)
);
create table public.sms_quotes (
  tenant_id text not null, id text not null, contact_id uuid not null,
  details jsonb not null default '{}', created_at timestamptz not null default now(),
  primary key(tenant_id,id), foreign key(tenant_id,contact_id) references public.sms_contacts(tenant_id,id)
);
create table public.sms_ai_settings (
  tenant_id text not null, group_id text not null, enabled boolean not null default false,
  instructions text not null default '', updated_at timestamptz not null default now(),
  primary key(tenant_id,group_id), foreign key(tenant_id,group_id) references public.sms_automation_groups(tenant_id,id)
);
create table public.sms_voice_conversations (
  tenant_id text references public.sms_businesses, conversation_id text not null, phone text not null,
  direction text not null default 'inbound' check(direction='inbound'), status text,
  started_at timestamptz not null default now(), duration_secs integer, metadata jsonb not null default '{}',
  primary key(tenant_id,conversation_id)
);
create table public.sms_messages (
  tenant_id text not null, id uuid not null default gen_random_uuid(), sid text,
  contact_phone text not null, direction text not null check(direction in ('inbound','outbound')),
  body text not null check(length(body) between 1 and 1600), category_id text,
  status text not null default 'queued', error_code text, meta jsonb not null default '{}',
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  primary key(tenant_id,id), unique(tenant_id,sid),
  foreign key(tenant_id,contact_phone) references public.sms_contacts(tenant_id,phone)
);
create index sms_messages_thread on public.sms_messages(tenant_id,contact_phone,created_at desc);
create table public.sms_message_events (
  tenant_id text not null, id uuid not null default gen_random_uuid(), message_id uuid not null,
  status text not null, error_code text, created_at timestamptz not null default now(),
  primary key(tenant_id,id), foreign key(tenant_id,message_id) references public.sms_messages(tenant_id,id)
);
create table sms_private.providers (
  tenant_id text primary key references public.sms_businesses, account_sid text unique,
  auth_secret_id uuid, messaging_service_sid text, from_number text,
  integration_secret_id uuid, next_send_at timestamptz not null default now(),
  sends_per_second numeric not null default 1 check(sends_per_second>0 and sends_per_second<=100),
  provisioning_state text not null default 'pending'
);
create table sms_private.jobs (
  id uuid primary key default gen_random_uuid(), tenant_id text not null references public.sms_businesses,
  queue text not null check(queue in ('sms_send_jobs','automation_jobs','ai_reply_jobs','provisioning_jobs')),
  dedupe_key text not null, payload jsonb not null, status text not null default 'queued',
  attempts integer not null default 0, available_at timestamptz not null default now(),
  lease_token uuid, leased_until timestamptz, queue_msg_id bigint,
  error_code text, created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique(tenant_id,queue,dedupe_key)
);
create index sms_jobs_due on sms_private.jobs(queue,available_at) where status in ('queued','retry');
create table sms_private.attempts (
  id uuid primary key default gen_random_uuid(), job_id uuid not null references sms_private.jobs,
  lease_token uuid not null, state text not null default 'submitting', sid text,
  created_at timestamptz not null default now(), unique(job_id,lease_token)
);
create table sms_private.webhook_events (
  tenant_id text references public.sms_businesses, event_key text not null,
  created_at timestamptz not null default now(), primary key(tenant_id,event_key)
);
create table sms_private.audit (
  id bigint generated always as identity primary key, tenant_id text references public.sms_businesses,
  actor text not null, action text not null, detail jsonb not null default '{}', created_at timestamptz not null default now()
);
create table sms_private.heartbeats (worker_id text primary key, queue text not null, seen_at timestamptz not null default now());
create table sms_private.runtime (id boolean primary key default true check(id), scheduler_enabled boolean not null default false, last_tick_at timestamptz);
insert into sms_private.runtime(id) values(true);

create function sms_private.can_access(t text, u text default auth.jwt()->>'sub') returns boolean
language sql stable security definer set search_path='' as $$
 select exists(select from sms_private.admins where clerk_user_id=u)
 or exists(select from public.sms_business_memberships where tenant_id=t and clerk_user_id=u)
$$;
create function sms_private.require_admin(u text) returns void
language plpgsql security definer set search_path='' as $$
#variable_conflict use_column
 begin
 if not exists(select from sms_private.admins where clerk_user_id=u) then raise exception 'Admin access required' using errcode='42501'; end if;
end $$;
grant usage on schema sms_private to authenticated, sms_api, sms_webhook, sms_sender, sms_automation, sms_ai;
grant execute on function sms_private.can_access(text,text) to authenticated;
do $$ declare t record; begin
 for t in select tablename from pg_tables where schemaname='public' and tablename like 'sms_%' loop
   execute format('alter table public.%I enable row level security',t.tablename);
   execute format('create policy tenant_read on public.%I for select to authenticated using (sms_private.can_access(tenant_id))',t.tablename);
   execute format('grant select on public.%I to authenticated',t.tablename);
 end loop;
 for t in select tablename from pg_tables where schemaname='sms_private' loop
   execute format('alter table sms_private.%I enable row level security',t.tablename);
 end loop;
end $$;
select pgmq.create('sms_send_jobs');
select pgmq.create('automation_jobs');
select pgmq.create('ai_reply_jobs');
select pgmq.create('provisioning_jobs');

create function sms_private.enqueue(t text,q text,k text,p jsonb,due timestamptz default now()) returns uuid
language plpgsql security definer set search_path='' as $$
#variable_conflict use_column
 declare j sms_private.jobs; begin
 insert into sms_private.jobs(tenant_id,queue,dedupe_key,payload,available_at) values(t,q,k,p,due)
 on conflict(tenant_id,queue,dedupe_key) do nothing returning * into j;
 if j.id is null then
   select * into j from sms_private.jobs where tenant_id=t and queue=q and dedupe_key=k;
   if j.payload<>p then raise exception 'Idempotency key conflicts with existing payload' using errcode='23505'; end if;
   return j.id;
 end if;
 update sms_private.jobs set queue_msg_id=(select pgmq.send(q,jsonb_build_object('job_id',j.id),greatest(0,ceil(extract(epoch from due-now())))::integer)) where id=j.id;
 return j.id;
end $$;

create function sms_private.outbox(t text,k text,p jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
#variable_conflict use_column
 declare mid uuid; jid uuid; old sms_private.jobs; c public.sms_contacts; begin
 if length(k) not between 1 and 200 then raise exception 'Idempotency key required'; end if;
 perform pg_advisory_xact_lock(hashtextextended(t||':sms:'||k,0));
 select * into old from sms_private.jobs where tenant_id=t and queue='sms_send_jobs' and dedupe_key=k;
 if found then
   if old.payload->'request'<>p then raise exception 'Idempotency key conflicts with existing payload' using errcode='23505'; end if;
   return jsonb_build_object('messageId',old.payload->>'message_id','jobId',old.id,'status',old.status);
 end if;
 select * into strict c from public.sms_contacts where tenant_id=t and phone=p->>'phone' for update;
 if c.opted_out or (coalesce(p->>'purpose','marketing')='marketing' and not c.marketing_consent) then raise exception 'SMS consent required' using errcode='42501'; end if;
 if not exists(select from public.sms_businesses where tenant_id=t and sending_enabled and status='active') then raise exception 'Business sending is disabled'; end if;
 insert into public.sms_messages(tenant_id,contact_phone,direction,body,category_id,meta)
 values(t,c.phone,'outbound',p->>'body',p->>'category_id',jsonb_build_object('purpose',coalesce(p->>'purpose','marketing'))) returning id into mid;
 jid:=sms_private.enqueue(t,'sms_send_jobs',k,jsonb_build_object('message_id',mid,'request',p,'contact_generation',c.generation));
 return jsonb_build_object('messageId',mid,'jobId',jid,'status','queued');
end $$;

create function sms_private.claim(q text,w text) returns jsonb language plpgsql security definer set search_path='' as $$
#variable_conflict use_column

declare m record; j sms_private.jobs; begin
 perform sms_private.worker_access(q);
 insert into sms_private.heartbeats(worker_id,queue) values(w,q) on conflict(worker_id) do update set seen_at=now(),queue=q;
 for m in select * from pgmq.read(q,120,1) loop
   select * into j from sms_private.jobs where id=(m.message->>'job_id')::uuid and queue=q for update skip locked;
   if not found then continue; end if;
   if j.status in ('completed','cancelled','failed','submission_unknown') then perform pgmq.delete(q,m.msg_id); continue; end if;
   if j.status='submitting' then continue; end if;
   if j.available_at>now() or j.leased_until>now() then continue; end if;
   if q='ai_reply_jobs' and exists(select from sms_private.jobs other where other.tenant_id=j.tenant_id and other.queue=q
      and other.id<>j.id and other.payload->>'phone'=j.payload->>'phone' and other.leased_until>now()) then continue; end if;
   update sms_private.jobs set status='processing',attempts=attempts+1,lease_token=gen_random_uuid(),leased_until=now()+interval '120 seconds',queue_msg_id=m.msg_id,updated_at=now() where id=j.id returning * into j;
   return to_jsonb(j);
 end loop;
 return null;
end $$;

create function sms_private.lease(jid uuid,token uuid) returns sms_private.jobs language plpgsql security definer set search_path='' as $$
#variable_conflict use_column

declare j sms_private.jobs; begin
 select * into strict j from sms_private.jobs where id=jid for update;
 perform sms_private.worker_access(j.queue);
 if j.lease_token is distinct from token or j.leased_until<=now() or j.status not in ('processing','submitting') then raise exception 'Lease lost' using errcode='40001'; end if;
 return j;
end $$;

create function sms_private.extend_lease(jid uuid,token uuid) returns void language plpgsql security definer set search_path='' as $$
#variable_conflict use_column

declare j sms_private.jobs; begin
 j:=sms_private.lease(jid,token);
 update sms_private.jobs set leased_until=now()+interval '120 seconds' where id=jid;
 perform pgmq.set_vt(j.queue,j.queue_msg_id,120);
end $$;

create function sms_private.finish(jid uuid,token uuid,outcome text,code text default null,delay_seconds integer default 30) returns void
language plpgsql security definer set search_path='' as $$
#variable_conflict use_column
 declare j sms_private.jobs; begin
 j:=sms_private.lease(jid,token);
 if outcome not in ('completed','cancelled','retry','failed','submission_unknown') then raise exception 'Invalid outcome'; end if;
 if j.status='submitting' and outcome not in ('failed','retry','submission_unknown') then raise exception 'Submission must be finalized'; end if;
 if outcome='retry' and j.attempts>=6 then outcome:='failed'; end if;
 update sms_private.jobs set status=outcome,error_code=code,leased_until=null,updated_at=now(),available_at=now()+make_interval(secs=>greatest(1,delay_seconds)) where id=jid;
 if outcome='retry' then
   perform pgmq.set_vt(j.queue,j.queue_msg_id,greatest(1,delay_seconds));
 else perform pgmq.delete(j.queue,j.queue_msg_id); end if;
 if j.queue='sms_send_jobs' then
   update public.sms_messages set status=case outcome when 'retry' then 'queued' else outcome end,error_code=code,updated_at=now() where tenant_id=j.tenant_id and id=(j.payload->>'message_id')::uuid;
   if outcome in ('failed','submission_unknown') then
     update public.sms_automation_enrollments set status='paused' where tenant_id=j.tenant_id and id=(j.payload->'request'->>'enrollment_id')::uuid and generation=(j.payload->'request'->>'enrollment_generation')::bigint;
   end if;
 end if;
end $$;

create function sms_private.begin_submission(jid uuid,token uuid) returns jsonb language plpgsql security definer set search_path='' as $$
#variable_conflict use_column

declare j sms_private.jobs; c public.sms_contacts; b public.sms_businesses; p sms_private.providers; e public.sms_automation_enrollments;
 r jsonb; a uuid; sec text; local_hour integer; wait_seconds integer; begin
 j:=sms_private.lease(jid,token); if j.queue<>'sms_send_jobs' or j.status<>'processing' then raise exception 'Not a send job'; end if;
 r:=j.payload->'request';
 select * into strict c from public.sms_contacts where tenant_id=j.tenant_id and phone=r->>'phone' for update;
 select * into strict b from public.sms_businesses where tenant_id=j.tenant_id;
 if c.opted_out or c.generation<>(j.payload->>'contact_generation')::bigint or not b.sending_enabled or b.status<>'active'
 or (coalesce(r->>'purpose','marketing')='marketing' and not c.marketing_consent) then
   perform sms_private.finish(jid,token,'cancelled','ELIGIBILITY_CHANGED'); return null;
 end if;
 if r ? 'conversation_generation' and not exists(select from public.sms_thread_contacts where tenant_id=j.tenant_id and phone=c.phone and not ai_paused and generation=(r->>'conversation_generation')::bigint) then
   perform sms_private.finish(jid,token,'cancelled','STALE_REPLY'); return null;
 end if;
 if r ? 'enrollment_id' then
   select * into e from public.sms_automation_enrollments where tenant_id=j.tenant_id and id=(r->>'enrollment_id')::uuid for update;
   if e.id is null or e.status<>'active' or e.generation<>(r->>'enrollment_generation')::bigint or e.step_index<>(r->>'step_index')::integer
     or not exists(select from public.sms_automation_groups where tenant_id=j.tenant_id and id=e.category_id and active and version=(r->>'group_version')::bigint)
     or e.appointment_at<=now() then
     perform sms_private.finish(jid,token,'cancelled','STALE_ENROLLMENT'); return null;
   end if;
   if e.next_run_at>now() then
     update sms_private.jobs set attempts=attempts-1 where id=jid;
     perform sms_private.finish(jid,token,'retry','RESCHEDULED',ceil(extract(epoch from e.next_run_at-now()))::integer); return null;
   end if;
 end if;
 if coalesce(r->>'purpose','marketing')='marketing' then
   local_hour:=extract(hour from now() at time zone b.time_zone);
   if local_hour<coalesce((r->>'start_hour')::int,9) or local_hour>=coalesce((r->>'end_hour')::int,19) then
     update sms_private.jobs set attempts=attempts-1 where id=jid;
     perform sms_private.finish(jid,token,'retry','OUTSIDE_WINDOW',60); return null;
   end if;
 end if;
 select * into p from sms_private.providers where tenant_id=j.tenant_id for update;
 if p.auth_secret_id is null or p.account_sid is null or (p.messaging_service_sid is null and p.from_number is null) then
   perform sms_private.finish(jid,token,'failed','SENDER_NOT_CONFIGURED'); return null;
 end if;
 if p.next_send_at>now() then
   update sms_private.jobs set attempts=attempts-1 where id=jid;
   perform sms_private.finish(jid,token,'retry','RATE_LIMIT',greatest(1,ceil(extract(epoch from p.next_send_at-now())))::int); return null;
 end if;
 select decrypted_secret into strict sec from vault.decrypted_secrets where id=p.auth_secret_id;
 insert into sms_private.attempts(job_id,lease_token) values(jid,token) returning id into a;
 update sms_private.providers set next_send_at=now()+make_interval(secs=>1/p.sends_per_second) where tenant_id=j.tenant_id;
 update sms_private.jobs set status='submitting' where id=jid;
 update public.sms_messages set status='submitting',updated_at=now() where tenant_id=j.tenant_id and id=(j.payload->>'message_id')::uuid;
 return jsonb_build_object('attempt_id',a,'account_sid',p.account_sid,'auth_token',sec,'messaging_service_sid',p.messaging_service_sid,'from_number',p.from_number,'phone',c.phone,'body',r->>'body');
end $$;

create function sms_private.accept_attempt(aid uuid,s text) returns void language plpgsql security definer set search_path='' as $$
#variable_conflict use_column

declare a sms_private.attempts; j sms_private.jobs; r jsonb; begin
 select * into strict a from sms_private.attempts where id=aid;
 select * into strict j from sms_private.jobs where id=a.job_id for update;
 if a.sid is not null and a.sid<>s then raise exception 'SID mismatch'; end if;
 if j.status='completed' then return; end if;
 if j.status not in ('submitting','submission_unknown') then raise exception 'Submission not reconcilable'; end if;
 update sms_private.attempts set sid=s,state='accepted' where id=aid;
 update public.sms_messages set sid=s,status='accepted',error_code=null,updated_at=now() where tenant_id=j.tenant_id and id=(j.payload->>'message_id')::uuid;
 update sms_private.jobs set status='completed',leased_until=null,error_code=null,updated_at=now() where id=j.id;
 perform pgmq.delete(j.queue,j.queue_msg_id);
 r:=j.payload->'request';
 if r ? 'enrollment_id' then
   update public.sms_automation_enrollments set step_index=step_index+1,last_sent_at=now(),
     next_run_at=(r->>'next_run_at')::timestamptz,
     status=case when r->>'next_run_at' is null then 'completed' else 'active' end
   where tenant_id=j.tenant_id and id=(r->>'enrollment_id')::uuid and generation=(r->>'enrollment_generation')::bigint
     and step_index=(r->>'step_index')::integer and status in ('active','paused');
 end if;
 insert into public.sms_thread_contacts(tenant_id,phone,name,last_body,last_direction,last_message_at)
 values(j.tenant_id,r->>'phone','',r->>'body','outbound',now()) on conflict(tenant_id,phone)
 do update set last_body=excluded.last_body,last_direction='outbound',last_message_at=now();
end $$;

create function sms_private.accept_submission(jid uuid,token uuid,aid uuid,s text) returns void language plpgsql security definer set search_path='' as $$
#variable_conflict use_column

declare j sms_private.jobs; begin
 select * into strict j from sms_private.jobs where id=jid;
 perform sms_private.worker_access(j.queue);
 if j.queue<>'sms_send_jobs' or not exists(select from sms_private.attempts where id=aid and job_id=jid and lease_token=token) then raise exception 'Attempt mismatch'; end if;
 perform sms_private.accept_attempt(aid,s);
end $$;

create function sms_private.tick() returns integer language plpgsql security definer set search_path='' as $$
#variable_conflict use_column

declare e record; j record; n integer:=0; begin
 if not pg_try_advisory_xact_lock(720491321) then return 0; end if;
 update sms_private.runtime set last_tick_at=now();
 for j in select * from sms_private.jobs where leased_until<now() and status in ('submitting','processing') order by leased_until limit 100 for update skip locked loop
   if j.status='submitting' then
     update sms_private.jobs set status='submission_unknown',leased_until=null,error_code='WORKER_LOST' where id=j.id;
     update public.sms_messages set status='submission_unknown',updated_at=now() where tenant_id=j.tenant_id and id=(j.payload->>'message_id')::uuid;
     update public.sms_automation_enrollments set status='paused' where tenant_id=j.tenant_id and id=(j.payload->'request'->>'enrollment_id')::uuid and generation=(j.payload->'request'->>'enrollment_generation')::bigint;
     perform pgmq.delete(j.queue,j.queue_msg_id);
   else
     update sms_private.jobs set status=case when attempts>=6 then 'failed' else 'retry' end,leased_until=null where id=j.id;
     if j.attempts>=6 then
       update public.sms_messages set status='failed',error_code='WORKER_LOST',updated_at=now() where tenant_id=j.tenant_id and id=(j.payload->>'message_id')::uuid;
     end if;
   end if;
 end loop;
 if not (select scheduler_enabled from sms_private.runtime) then return 0; end if;
 for e in select e.* from public.sms_automation_enrollments e join public.sms_businesses b using(tenant_id)
   join public.sms_automation_groups g on g.tenant_id=e.tenant_id and g.id=e.category_id
   where e.status='active' and e.next_run_at<=now() and b.sending_enabled and b.status='active' and g.active
   and not exists(select from sms_private.jobs j where j.tenant_id=e.tenant_id and j.queue='automation_jobs'
     and j.dedupe_key=e.id||':'||e.generation||':'||e.step_index)
   order by e.next_run_at limit 100 for update of e skip locked loop
   perform sms_private.enqueue(e.tenant_id,'automation_jobs',e.id||':'||e.generation||':'||e.step_index,
     jsonb_build_object('enrollment_id',e.id,'generation',e.generation,'step_index',e.step_index)); n:=n+1;
 end loop;
 return n;
end $$;

-- GENERATED FUNCTIONS BELOW
-- Included in the generated migration by scripts/assemble-migration.js.
create function sms_private.api_action(u text,t text,action text,p jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
#variable_conflict use_column

declare c public.sms_contacts; g public.sms_automation_groups; eid uuid; r jsonb; n int; v bigint; begin
 perform sms_private.require_admin(u);
 if action='create_business' then
   if not exists(select from pg_timezone_names where name=p->>'timeZone') then raise exception 'Invalid timezone'; end if;
   insert into public.sms_businesses(tenant_id,name,time_zone) values(p->>'id',p->>'name',p->>'timeZone');
   insert into sms_private.providers(tenant_id) values(p->>'id');
   insert into public.sms_business_memberships(tenant_id,clerk_user_id) values(p->>'id',u);
   return jsonb_build_object('id',p->>'id','name',p->>'name','timeZone',p->>'timeZone','status','pending');
 end if;
 if not exists(select from public.sms_businesses where tenant_id=t) then raise exception 'Unknown business'; end if;
 if action='contact' then
   insert into public.sms_contacts(tenant_id,phone,name,email,source,metadata)
   values(t,p->>'phone',coalesce(p->>'name',''),p->>'email',coalesce(p->>'source','contact'),coalesce(p->'metadata','{}'))
   on conflict(tenant_id,phone) do update set name=excluded.name,email=excluded.email,source=excluded.source,metadata=excluded.metadata,updated_at=now() returning * into c;
   return to_jsonb(c);
 elsif action='consent' then
   if coalesce(length(p->>'evidence'),0)=0 then raise exception 'Consent evidence required'; end if;
   select * into strict c from public.sms_contacts where tenant_id=t and phone=p->>'phone' for update;
   update public.sms_contacts set opted_out=not (p->>'consent')::boolean,marketing_consent=(p->>'consent')::boolean,generation=generation+1,updated_at=now() where tenant_id=t and id=c.id;
   insert into public.sms_consent_events(tenant_id,contact_id,consent,source,evidence) values(t,c.id,(p->>'consent')::boolean,'admin',p->>'evidence');
   if not (p->>'consent')::boolean then perform sms_private.cancel_contact(t,c.id); end if;
   return jsonb_build_object('ok',true);
 elsif action='send' then
   return sms_private.outbox(t,p->>'idempotencyKey',p-'idempotencyKey');
 elsif action='group' then
   if jsonb_array_length(p->'rule'->'steps') not between 1 and 30 then raise exception '1-30 steps required'; end if;
   insert into public.sms_automation_groups(tenant_id,id,name,description,kind,rule,active)
   values(t,p->>'id',p->>'name',coalesce(p->>'description',''),coalesce(p->>'kind','custom'),p->'rule',coalesce((p->>'active')::boolean,true))
   on conflict(tenant_id,id) do update set name=excluded.name,description=excluded.description,rule=excluded.rule,active=excluded.active,version=sms_automation_groups.version+1,updated_at=now() returning * into g;
   delete from public.sms_automation_steps where tenant_id=t and group_id=g.id;
   n:=0;
   for r in select value from jsonb_array_elements(p->'rule'->'steps') loop
     insert into public.sms_automation_steps values(t,g.id,n,r->>'template',(r->>'delayCount')::integer,r->>'delayUnit'); n:=n+1;
   end loop;
   update public.sms_automation_enrollments set generation=generation+1,next_run_at=now() where tenant_id=t and category_id=g.id and status='active';
   return to_jsonb(g);
 elsif action='delete_group' then
   update public.sms_automation_groups set active=false,version=version+1 where tenant_id=t and id=p->>'id';
   update public.sms_automation_enrollments set status='cancelled',generation=generation+1 where tenant_id=t and category_id=p->>'id' and status in ('active','paused');
   return jsonb_build_object('ok',true);
 elsif action='ai_settings' then
   insert into public.sms_ai_settings(tenant_id,group_id,enabled,instructions) values(t,p->>'id',coalesce((p->>'enabled')::boolean,false),coalesce(p->>'instructions',''))
   on conflict(tenant_id,group_id) do update set enabled=excluded.enabled,instructions=excluded.instructions,updated_at=now();
   update public.sms_thread_contacts set generation=generation+1 where tenant_id=t;
   return jsonb_build_object('ok',true);
 elsif action='enroll' then
   select * into strict c from public.sms_contacts where tenant_id=t and phone=p->>'phone' for update;
   select * into strict g from public.sms_automation_groups where tenant_id=t and id=p->>'categoryId' and active;
   if c.opted_out or (g.kind<>'reminder' and not c.marketing_consent) then raise exception 'Consent required' using errcode='42501'; end if;
   if g.kind='reminder' and ((p->>'appointment_at') is null or (p->>'appointment_at')::timestamptz<=now()) then raise exception 'Future appointment required'; end if;
   update public.sms_automation_enrollments set status='cancelled',generation=generation+1 where tenant_id=t and contact_id=c.id and category_id=g.id and status in ('active','paused');
   insert into public.sms_automation_enrollments(tenant_id,contact_id,category_id,next_run_at,appointment_at,metadata)
   values(t,c.id,g.id,now(),(p->>'appointment_at')::timestamptz,coalesce(p->'metadata','{}')) returning id into eid;
   return jsonb_build_object('id',eid,'status','active');
 elsif action='unenroll' then
   update public.sms_automation_enrollments set status='cancelled',generation=generation+1 where tenant_id=t
     and contact_id=(select id from public.sms_contacts where tenant_id=t and phone=p->>'phone') and category_id=p->>'categoryId' and status in ('active','paused');
   return jsonb_build_object('ok',true);
 elsif action in ('read','pause','resume') then
   update public.sms_thread_contacts set unread_count=case when action='read' then 0 else unread_count end,
     ai_paused=case when action='pause' then true when action='resume' then false else ai_paused end,
     generation=generation+case when action='read' then 0 else 1 end where tenant_id=t and phone=p->>'phone';
   return jsonb_build_object('ok',true);
 elsif action='retry_job' then
   select to_jsonb(j) into strict r from sms_private.jobs j where tenant_id=t and id=(p->>'id')::uuid and status='failed' for update;
   update sms_private.jobs set status='queued',attempts=0,available_at=now(),lease_token=null,leased_until=null,
     queue_msg_id=(select pgmq.send(r->>'queue',jsonb_build_object('job_id',r->>'id'),0)) where id=(r->>'id')::uuid;
   return jsonb_build_object('ok',true);
 elsif action='provision' then
   return jsonb_build_object('jobId',sms_private.enqueue(t,'provisioning_jobs','provision',jsonb_build_object('name',p->>'name')),'status','queued');
 end if;
 raise exception 'Unknown operation';
end $$;

create function sms_private.cancel_contact(t text,cid uuid) returns void language plpgsql security definer set search_path='' as $$
#variable_conflict use_column

declare ph text; begin
 select phone into strict ph from public.sms_contacts where tenant_id=t and id=cid;
 update public.sms_automation_enrollments set status='cancelled',generation=generation+1 where tenant_id=t and contact_id=cid and status in ('active','paused');
 update public.sms_thread_contacts set generation=generation+1 where tenant_id=t and phone=ph;
 update sms_private.jobs set status='cancelled',updated_at=now() where tenant_id=t and status in ('queued','retry','processing')
   and (payload->'request'->>'phone'=ph or payload->>'phone'=ph);
 update public.sms_messages set status='cancelled',updated_at=now() where tenant_id=t and contact_phone=ph and direction='outbound' and status='queued';
end $$;

create function sms_private.api_read(u text,t text,resource text,p jsonb default '{}') returns jsonb
language plpgsql security definer set search_path='' as $$
#variable_conflict use_column

declare rows jsonb; total bigint; tbl text; clause text:=''; page integer; size integer; begin
 perform sms_private.require_admin(u);
 if resource='businesses' then
   return jsonb_build_object('rows',coalesce((select jsonb_agg(to_jsonb(b)) from public.sms_businesses b),'[]'));
 end if;
 if not exists(select from public.sms_businesses where tenant_id=t) then raise exception 'Unknown business'; end if;
 if resource='overview' then
   return jsonb_build_object('total',(select count(*) from public.sms_messages where tenant_id=t),
     'contactCount',(select count(*) from public.sms_contacts where tenant_id=t),
     'conversationCount',(select count(*) from public.sms_thread_contacts where tenant_id=t),
     'optedOutTotal',(select count(*) from public.sms_contacts where tenant_id=t and opted_out),
     'counts',coalesce((select jsonb_object_agg(status,n) from (select status,count(*) n from public.sms_messages where tenant_id=t group by status)s),'{}'),
     'byCategory',coalesce((select jsonb_agg(jsonb_build_object('id',category_id,'total',n)) from (select category_id,count(*) n from public.sms_messages where tenant_id=t and category_id is not null group by category_id)s),'[]'));
 elsif resource='operations' then
   return jsonb_build_object('jobs',coalesce((select jsonb_agg(s) from (select queue,status,count(*) count,min(created_at) oldest from sms_private.jobs where tenant_id=t and status not in ('completed','cancelled') group by queue,status)s),'[]'),
     'workers',coalesce((select jsonb_agg(h) from sms_private.heartbeats h),'[]'),
     'scheduler',(select to_jsonb(r) from sms_private.runtime r),
     'problems',coalesce((select jsonb_agg(s) from (select id,queue,status,error_code,created_at from sms_private.jobs where tenant_id=t and status in ('failed','submission_unknown') order by created_at desc limit 50)s),'[]'));
 end if;
 tbl:=case resource when 'contacts' then 'sms_contacts' when 'threads' then 'sms_thread_contacts' when 'messages' then 'sms_messages'
 when 'groups' then 'sms_automation_groups' when 'steps' then 'sms_automation_steps' when 'enrollments' then 'sms_automation_enrollments'
 when 'calls' then 'sms_voice_conversations' when 'ai_settings' then 'sms_ai_settings' when 'bookings' then 'sms_bookings' when 'quotes' then 'sms_quotes' end;
 if tbl is null then raise exception 'Unknown resource'; end if;
 page:=greatest(1,least(100000,coalesce((p->>'page')::integer,1))); size:=greatest(1,least(250,coalesce((p->>'pageSize')::integer,50)));
 if resource in ('contacts','threads','calls') then
   if p->>'phone' is not null then clause:=clause||format(' and phone=%L',p->>'phone'); end if;
   if p->>'q' is not null then clause:=clause||format(' and (phone ilike %L%s)','%'||(p->>'q')||'%',case when resource<>'calls' then format(' or name ilike %L','%'||(p->>'q')||'%') else '' end); end if;
 end if;
 if resource='contacts' then
   if p->>'source' is not null then clause:=clause||format(' and source=%L',p->>'source'); end if;
   if p->>'consented'='1' then clause:=clause||' and marketing_consent and not opted_out'; end if;
   if p->>'opted_out'='1' then clause:=clause||' and opted_out'; end if;
 end if;
 if resource='threads' and p->>'unread'='1' then clause:=clause||' and unread_count>0'; end if;
 if resource='messages' then
   if p->>'phone' is not null then clause:=clause||format(' and contact_phone=%L',p->>'phone'); end if;
   if p->>'status' is not null then clause:=clause||format(' and status=%L',p->>'status'); end if;
   if p->>'direction' is not null then clause:=clause||format(' and direction=%L',p->>'direction'); end if;
 end if;
 if resource in ('messages','enrollments') and p->>'category' is not null then clause:=clause||format(' and category_id=%L',p->>'category'); end if;
 if resource='steps' then clause:=clause||format(' and group_id=%L',p->>'id'); end if;
 if resource='groups' and p->>'id' is not null then clause:=clause||format(' and id=%L',p->>'id'); end if;
 execute format('select count(*) from public.%I where tenant_id=$1%s',tbl,clause) into total using t;
 execute format('select coalesce(jsonb_agg(x),''[]'') from (select * from public.%I where tenant_id=$1%s order by %s limit $2 offset $3)x',tbl,clause,
 case when resource='steps' then 'step_index' when resource='threads' then 'last_message_at desc nulls last,phone' when resource='ai_settings' then 'group_id' when resource='calls' then 'started_at desc,conversation_id' when resource='bookings' then 'appointment_at desc,id' else 'created_at desc,id' end)
 into rows using t,size,(page-1)*size;
 return jsonb_build_object('rows',rows,'total',total,'page',page,'pageSize',size,'totalPages',greatest(1,ceil(total::numeric/size)),'configured',true);
end $$;

create function public.sms_crm_list_contacts(p_tenant_id text,p_options jsonb default '{}') returns jsonb language plpgsql security definer set search_path='' as $$
#variable_conflict use_column
 begin
 return sms_private.api_read(auth.jwt()->>'sub',p_tenant_id,'contacts',p_options);
end $$;
create function public.sms_crm_enroll_contact(p_tenant_id text,p_contact jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
#variable_conflict use_column
 begin
 return sms_private.api_action(auth.jwt()->>'sub',p_tenant_id,'enroll',p_contact);
end $$;
revoke all on function public.sms_crm_list_contacts(text,jsonb),public.sms_crm_enroll_contact(text,jsonb) from public,anon;
grant execute on function public.sms_crm_list_contacts(text,jsonb),public.sms_crm_enroll_contact(text,jsonb) to authenticated;

create function sms_private.job_context(jid uuid,token uuid) returns jsonb language plpgsql security definer set search_path='' as $$
#variable_conflict use_column

declare j sms_private.jobs; e public.sms_automation_enrollments; c public.sms_contacts; ph text; begin
 j:=sms_private.lease(jid,token);
 if j.queue='automation_jobs' then
   select * into e from public.sms_automation_enrollments where tenant_id=j.tenant_id and id=(j.payload->>'enrollment_id')::uuid;
   select * into c from public.sms_contacts where tenant_id=j.tenant_id and id=e.contact_id;
   return jsonb_build_object('enrollment',to_jsonb(e),'contact',to_jsonb(c),
     'business',(select to_jsonb(b) from public.sms_businesses b where tenant_id=j.tenant_id),
     'group',(select to_jsonb(g) from public.sms_automation_groups g where tenant_id=j.tenant_id and id=e.category_id),
     'steps',(select jsonb_agg(s order by step_index) from public.sms_automation_steps s where tenant_id=j.tenant_id and group_id=e.category_id));
 elsif j.queue='ai_reply_jobs' then
   ph:=j.payload->>'phone';
   return jsonb_build_object('business',(select to_jsonb(b) from public.sms_businesses b where tenant_id=j.tenant_id),
     'contact',(select to_jsonb(c) from public.sms_contacts c where tenant_id=j.tenant_id and phone=ph),
     'thread',(select to_jsonb(th) from public.sms_thread_contacts th where tenant_id=j.tenant_id and phone=ph),
     'settings',(select to_jsonb(a) from public.sms_ai_settings a where tenant_id=j.tenant_id and group_id=j.payload->>'group_id'),
     'history',(select coalesce(jsonb_agg(m order by created_at),'[]') from (select direction,body,created_at from public.sms_messages where tenant_id=j.tenant_id and contact_phone=ph order by created_at desc limit 20)m));
 elsif j.queue='provisioning_jobs' then
   return (select jsonb_build_object('account_sid',account_sid,'messaging_service_sid',messaging_service_sid,'state',provisioning_state) from sms_private.providers where tenant_id=j.tenant_id);
 end if;
 raise exception 'Unsupported context';
end $$;

create function sms_private.complete_automation(jid uuid,token uuid,p jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
#variable_conflict use_column

declare j sms_private.jobs; e public.sms_automation_enrollments; c public.sms_contacts; g public.sms_automation_groups; result jsonb; begin
 j:=sms_private.lease(jid,token); if j.queue<>'automation_jobs' then raise exception 'Wrong queue'; end if;
 select * into e from public.sms_automation_enrollments where tenant_id=j.tenant_id and id=(j.payload->>'enrollment_id')::uuid for update;
 select * into c from public.sms_contacts where tenant_id=j.tenant_id and id=e.contact_id for update;
 select * into g from public.sms_automation_groups where tenant_id=j.tenant_id and id=e.category_id;
 if e.status<>'active' or e.generation<>(j.payload->>'generation')::bigint or e.step_index<>(j.payload->>'step_index')::int or c.opted_out or not g.active or g.version<>(p->>'group_version')::bigint then
   perform sms_private.finish(jid,token,'cancelled','STALE_ENROLLMENT'); return null;
 end if;
 if p->>'action'='complete' then
   update public.sms_automation_enrollments set status='completed',next_run_at=null where tenant_id=j.tenant_id and id=e.id;
 elsif p->>'action'='schedule' then
   update public.sms_automation_enrollments set next_run_at=(p->>'due')::timestamptz,generation=generation+1 where tenant_id=j.tenant_id and id=e.id;
 else
   result:=sms_private.outbox(j.tenant_id,'automation:'||j.dedupe_key,p-'action');
 end if;
 perform sms_private.finish(jid,token,'completed'); return result;
end $$;

create function sms_private.complete_ai(jid uuid,token uuid,body text) returns jsonb language plpgsql security definer set search_path='' as $$
#variable_conflict use_column

declare j sms_private.jobs; result jsonb; begin
 j:=sms_private.lease(jid,token); if j.queue<>'ai_reply_jobs' then raise exception 'Wrong queue'; end if;
 if not exists(select from public.sms_thread_contacts th join public.sms_contacts c using(tenant_id,phone)
   where th.tenant_id=j.tenant_id and th.phone=j.payload->>'phone' and th.generation=(j.payload->>'generation')::bigint and not th.ai_paused and not c.opted_out)
   or not exists(select from public.sms_ai_settings where tenant_id=j.tenant_id and group_id=j.payload->>'group_id' and enabled) then
   perform sms_private.finish(jid,token,'cancelled','STALE_REPLY'); return null;
 end if;
 result:=sms_private.outbox(j.tenant_id,'ai:'||j.id,jsonb_build_object('phone',j.payload->>'phone','body',body,'purpose','transactional','category_id',j.payload->>'group_id','conversation_generation',j.payload->'generation'));
 perform sms_private.finish(jid,token,'completed'); return result;
end $$;

create function sms_private.ai_tool(jid uuid,token uuid,name text,args jsonb,call_id text) returns jsonb language plpgsql security definer set search_path='' as $$
#variable_conflict use_column

declare j sms_private.jobs; cid uuid; result jsonb; begin
 j:=sms_private.lease(jid,token); if j.queue<>'ai_reply_jobs' then raise exception 'Wrong queue'; end if;
 select id into strict cid from public.sms_contacts where tenant_id=j.tenant_id and phone=j.payload->>'phone' and not opted_out;
 if not exists(select from public.sms_thread_contacts where tenant_id=j.tenant_id and phone=j.payload->>'phone' and not ai_paused and generation=(j.payload->>'generation')::bigint) then raise exception 'Stale reply'; end if;
 if name='list_bookings' then
   select coalesce(jsonb_agg(b),'[]') into result from public.sms_bookings b where tenant_id=j.tenant_id and contact_id=cid;
 elsif name='request_booking' then
   if (args->>'appointment_at')::timestamptz<=now() then raise exception 'Future appointment required'; end if;
   insert into public.sms_bookings(tenant_id,id,contact_id,appointment_at,status,metadata)
   values(j.tenant_id,'ai:'||j.id||':'||md5(args::text),cid,(args->>'appointment_at')::timestamptz,'requested',jsonb_build_object('notes',args->>'notes'))
   on conflict(tenant_id,id) do nothing;
   result:=jsonb_build_object('status','requested','message','A booking request was saved; it is not confirmed.');
 else raise exception 'Tool not permitted'; end if;
 return result;
end $$;

create function sms_private.provision_checkpoint(jid uuid,token uuid,p jsonb) returns void language plpgsql security definer set search_path='' as $$
#variable_conflict use_column

declare j sms_private.jobs; sec uuid; begin
 j:=sms_private.lease(jid,token); if j.queue<>'provisioning_jobs' then raise exception 'Wrong queue'; end if;
 if p ? 'auth_token' then select vault.create_secret(p->>'auth_token') into sec; end if;
 update sms_private.providers set account_sid=coalesce(p->>'account_sid',account_sid),auth_secret_id=coalesce(sec,auth_secret_id),
   messaging_service_sid=coalesce(p->>'messaging_service_sid',messaging_service_sid),provisioning_state=p->>'state' where tenant_id=j.tenant_id;
end $$;

create function sms_private.webhook_credentials(account text) returns jsonb language sql security definer set search_path='' as $$
 select jsonb_build_object('tenant_id',p.tenant_id,'auth_token',s.decrypted_secret,'from_number',p.from_number)
 from sms_private.providers p join vault.decrypted_secrets s on s.id=p.auth_secret_id where p.account_sid=account
$$;
create function sms_private.integration_credentials(t text) returns text language sql security definer set search_path='' as $$
 select s.decrypted_secret from sms_private.providers p join vault.decrypted_secrets s on s.id=p.integration_secret_id where p.tenant_id=t
$$;

create function sms_private.record_webhook(t text,event text,p jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
#variable_conflict use_column

declare c public.sms_contacts; mid uuid; th public.sms_thread_contacts; gid text; a sms_private.attempts; j sms_private.jobs; s text; key text; begin
 key:=event||':'||coalesce(p->>'MessageSid',p->>'CallSid')||':'||coalesce(p->>'MessageStatus',p->>'CallStatus','inbound');
 insert into sms_private.webhook_events(tenant_id,event_key) values(t,key) on conflict do nothing;
 if not found then return jsonb_build_object('duplicate',true); end if;
 if event='inbound' then
   insert into public.sms_contacts(tenant_id,phone) values(t,p->>'From') on conflict do nothing;
   select * into strict c from public.sms_contacts where tenant_id=t and phone=p->>'From' for update;
   insert into public.sms_messages(tenant_id,sid,contact_phone,direction,body,status) values(t,p->>'MessageSid',c.phone,'inbound',coalesce(nullif(p->>'Body',''),'[Media message]'),'received') returning id into mid;
   insert into public.sms_thread_contacts(tenant_id,phone,name,generation,unread_count,last_body,last_direction,last_message_at,last_inbound_at)
   values(t,c.phone,c.name,1,1,p->>'Body','inbound',now(),now()) on conflict(tenant_id,phone) do update set generation=sms_thread_contacts.generation+1,
     unread_count=sms_thread_contacts.unread_count+1,last_body=excluded.last_body,last_direction='inbound',last_message_at=now(),last_inbound_at=now() returning * into th;
   s:=upper(trim(coalesce(p->>'OptOutType',p->>'Body','')));
   if s in ('STOP','STOPALL','UNSUBSCRIBE','CANCEL','END','QUIT','REVOKE','OPTOUT','START','UNSTOP') then
     update public.sms_contacts set opted_out=s not in ('START','UNSTOP'),marketing_consent=s in ('START','UNSTOP'),generation=generation+1,updated_at=now() where tenant_id=t and id=c.id;
     insert into public.sms_consent_events(tenant_id,contact_id,consent,source,evidence) values(t,c.id,s in ('START','UNSTOP'),'twilio',p->>'MessageSid');
     if s not in ('START','UNSTOP') then perform sms_private.cancel_contact(t,c.id); end if;
     return jsonb_build_object('consent_event',true);
   end if;
   update public.sms_automation_enrollments set next_run_at=greatest(next_run_at,now()+interval '24 hours'),generation=generation+1
   where tenant_id=t and contact_id=c.id and status='active' and category_id in(select id from public.sms_automation_groups where tenant_id=t and kind<>'reminder');
   select a.group_id into gid from public.sms_ai_settings a join public.sms_automation_enrollments e on e.tenant_id=a.tenant_id and e.category_id=a.group_id
   where a.tenant_id=t and e.contact_id=c.id and e.status='active' and a.enabled order by e.created_at desc limit 1;
   if gid is not null and not th.ai_paused and not c.opted_out then
     perform sms_private.enqueue(t,'ai_reply_jobs',p->>'MessageSid',jsonb_build_object('phone',c.phone,'generation',th.generation,'group_id',gid));
   end if;
 elsif event='status' then
   if p->>'attempt_id' is not null then
     select * into strict a from sms_private.attempts where id=(p->>'attempt_id')::uuid;
     select * into strict j from sms_private.jobs where id=a.job_id and tenant_id=t;
     perform sms_private.accept_attempt(a.id,p->>'MessageSid'); mid:=(j.payload->>'message_id')::uuid;
   else select id into strict mid from public.sms_messages where tenant_id=t and sid=p->>'MessageSid'; end if;
   s:=p->>'MessageStatus';
   insert into public.sms_message_events(tenant_id,message_id,status,error_code) values(t,mid,s,p->>'ErrorCode');
   update public.sms_messages set status=s,error_code=p->>'ErrorCode',updated_at=now() where tenant_id=t and id=mid
     and sms_private.status_rank(s)>sms_private.status_rank(status);
 elsif event='call' then
   if p->>'Direction' is not null and p->>'Direction'<>'inbound' then raise exception 'Only inbound calls supported'; end if;
   insert into public.sms_voice_conversations(tenant_id,conversation_id,phone,status,duration_secs)
   values(t,p->>'CallSid',p->>'From',p->>'CallStatus',(p->>'CallDuration')::integer)
   on conflict(tenant_id,conversation_id) do update set status=excluded.status,duration_secs=coalesce(excluded.duration_secs,sms_voice_conversations.duration_secs);
 else raise exception 'Unknown event'; end if;
 return jsonb_build_object('ok',true);
end $$;
create function sms_private.status_rank(s text) returns integer language sql immutable set search_path='' as $$
 select case s when 'queued' then 0 when 'submitting' then 1 when 'accepted' then 2 when 'sending' then 3 when 'sent' then 4 when 'failed' then 5 when 'undelivered' then 5 when 'delivered' then 6 when 'read' then 7 else -1 end
$$;

create function sms_private.ingest_event(t text,p jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
#variable_conflict use_column

declare c public.sms_contacts; gid text; begin
 insert into sms_private.webhook_events(tenant_id,event_key) values(t,'integration:'||(p->>'eventId')) on conflict do nothing;
 if not found then return jsonb_build_object('duplicate',true); end if;
 insert into public.sms_contacts(tenant_id,phone,name,source) values(t,p->>'phone',coalesce(p->>'name',''),'booking') on conflict do nothing;
 select * into strict c from public.sms_contacts where tenant_id=t and phone=p->>'phone' for update;
 if p->>'type' in ('booking.created','booking.rescheduled','booking.cancelled') then
   insert into public.sms_bookings(tenant_id,id,contact_id,appointment_at,status,metadata)
   values(t,p->>'id',c.id,(p->>'appointment_at')::timestamptz,case when p->>'type'='booking.cancelled' then 'cancelled' else 'confirmed' end,coalesce(p->'metadata','{}'))
   on conflict(tenant_id,id) do update set appointment_at=excluded.appointment_at,status=excluded.status,metadata=excluded.metadata,updated_at=now();
   update public.sms_automation_enrollments set status='cancelled',generation=generation+1 where tenant_id=t and contact_id=c.id and status in ('active','paused')
   and category_id in(select id from public.sms_automation_groups where tenant_id=t and kind in ('quote','reminder'));
   if p->>'type'<>'booking.cancelled' and not c.opted_out and (p->>'appointment_at')::timestamptz>now() then
     select id into gid from public.sms_automation_groups where tenant_id=t and kind='reminder' and active order by created_at limit 1;
     if gid is not null then insert into public.sms_automation_enrollments(tenant_id,contact_id,category_id,appointment_at,next_run_at,metadata)
       values(t,c.id,gid,(p->>'appointment_at')::timestamptz,now(),jsonb_build_object('booking_id',p->>'id')||coalesce(p->'metadata','{}')); end if;
   end if;
 elsif p->>'type'='quote.created' then
   insert into public.sms_quotes(tenant_id,id,contact_id,details) values(t,p->>'id',c.id,coalesce(p->'metadata','{}')) on conflict do nothing;
   select id into gid from public.sms_automation_groups where tenant_id=t and kind='quote' and active order by created_at limit 1;
   if gid is not null and c.marketing_consent and not c.opted_out then
     insert into public.sms_automation_enrollments(tenant_id,contact_id,category_id,next_run_at,metadata) values(t,c.id,gid,now(),coalesce(p->'metadata','{}')) on conflict do nothing;
   end if;
 else raise exception 'Unsupported event'; end if;
 return jsonb_build_object('ok',true);
end $$;

-- Explicit function grants; no application login gets table, queue or Vault access.
revoke all on schema pgmq from public,anon,authenticated,sms_api,sms_webhook,sms_sender,sms_automation,sms_ai;
revoke all on all functions in schema sms_private from public,anon,authenticated,sms_api,sms_webhook,sms_sender,sms_automation,sms_ai;
grant execute on function sms_private.can_access(text,text) to authenticated;
grant execute on function sms_private.api_action(text,text,text,jsonb),sms_private.api_read(text,text,text,jsonb) to sms_api;
grant execute on function sms_private.webhook_credentials(text),sms_private.record_webhook(text,text,jsonb),sms_private.integration_credentials(text),sms_private.ingest_event(text,jsonb) to sms_webhook;
grant execute on function sms_private.claim(text,text),sms_private.extend_lease(uuid,uuid),sms_private.finish(uuid,uuid,text,text,integer) to sms_sender,sms_automation,sms_ai;
grant execute on function sms_private.begin_submission(uuid,uuid),sms_private.accept_submission(uuid,uuid,uuid,text) to sms_sender;
grant execute on function sms_private.job_context(uuid,uuid) to sms_automation,sms_ai;
grant execute on function sms_private.complete_automation(uuid,uuid,jsonb),sms_private.provision_checkpoint(uuid,uuid,jsonb) to sms_automation;
grant execute on function sms_private.complete_ai(uuid,uuid,text),sms_private.ai_tool(uuid,uuid,text,jsonb,text) to sms_ai;
select cron.schedule('sms-scheduler','30 seconds','select sms_private.tick()');
do $$ declare t text; begin
 if exists(select from pg_publication where pubname='supabase_realtime') then
   foreach t in array array['sms_messages','sms_thread_contacts','sms_automation_enrollments'] loop
     execute format('alter publication supabase_realtime add table public.%I',t);
   end loop;
 end if;
end $$;

