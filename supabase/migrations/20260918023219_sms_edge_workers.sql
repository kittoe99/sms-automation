-- Execution remains paused until secrets and deployed handlers have been verified.
create extension if not exists pg_net;
alter table sms_private.runtime add column edge_enabled boolean not null default false;
alter table sms_private.runtime add column scheduler_batch_size integer not null default 500 check(scheduler_batch_size between 1 and 5000);
alter table sms_private.runtime add column last_dispatch_at timestamptz;
create table sms_private.edge_config (
 queue text primary key check(queue in ('sms_send_jobs','automation_jobs','ai_reply_jobs','provisioning_jobs')),
 function_name text not null check(function_name in ('sms-worker','automation-worker','ai-worker','provisioning-worker')),
 secret_id uuid references vault.secrets(id),
 enabled boolean not null default false,
 max_concurrency integer not null default 4 check(max_concurrency between 1 and 64),
 last_requested_at timestamptz
);
alter table sms_private.edge_config enable row level security;
create table sms_private.edge_runs (
 id uuid primary key default gen_random_uuid(), queue text not null references sms_private.edge_config(queue),
 worker_id text not null, expires_at timestamptz not null default now()+interval '120 seconds'
);
alter table sms_private.edge_runs enable row level security;
create index sms_edge_runs_queue on sms_private.edge_runs(queue,expires_at);
create index sms_jobs_dispatch_ready on sms_private.jobs(queue,available_at) where status in ('queued','retry');
insert into sms_private.edge_config(queue,function_name,max_concurrency) values
 ('sms_send_jobs','sms-worker',4),('automation_jobs','automation-worker',2),('ai_reply_jobs','ai-worker',2),('provisioning_jobs','provisioning-worker',1);

create function sms_private.edge_enter(q text,w text) returns uuid language plpgsql security definer set search_path='' as $$
declare slot uuid; capacity integer; begin
 perform sms_private.worker_access(q);
 perform pg_advisory_xact_lock(hashtextextended('edge-capacity:'||q,0));
 if not (select edge_enabled from sms_private.runtime) then return null; end if;
 select max_concurrency into capacity from sms_private.edge_config where queue=q and enabled;
 if capacity is null then return null; end if;
 delete from sms_private.edge_runs where queue=q and expires_at<now();
 if (select count(*) from sms_private.edge_runs where queue=q)>=capacity then return null; end if;
 insert into sms_private.edge_runs(queue,worker_id) values(q,w) returning id into slot;
 return slot;
end $$;
create function sms_private.edge_exit(q text,slot uuid) returns void language plpgsql security definer set search_path='' as $$
begin
 perform sms_private.worker_access(q);
 delete from sms_private.edge_runs where id=slot and queue=q;
end $$;
revoke all on function sms_private.edge_enter(text,text),sms_private.edge_exit(text,uuid) from public,anon,authenticated;
grant execute on function sms_private.edge_enter(text,text),sms_private.edge_exit(text,uuid) to sms_sender,sms_automation,sms_ai;

create function sms_private.dispatch_edge() returns integer language plpgsql security definer set search_path='' as $$
declare cfg record; bearer text; request_id bigint; sent integer:=0; begin
 perform sms_private.tick();
 if not (select edge_enabled from sms_private.runtime) then return 0; end if;
 if not pg_try_advisory_xact_lock(720491322) then return 0; end if;
 update sms_private.runtime set last_dispatch_at=now();
 for cfg in select c.* from sms_private.edge_config c where c.enabled and c.secret_id is not null
 and (c.last_requested_at is null or c.last_requested_at<=now()-interval '5 seconds')
 and exists(select from sms_private.jobs j where j.queue=c.queue and j.status in ('queued','retry') and j.available_at<=now())
 and (select count(*) from sms_private.edge_runs r where r.queue=c.queue and r.expires_at>now())<c.max_concurrency
 loop
  select decrypted_secret into strict bearer from vault.decrypted_secrets where id=cfg.secret_id;
  select net.http_post(
   url:='https://wxamwhfmelxqahkdtcci.supabase.co/functions/v1/'||cfg.function_name,
   headers:=jsonb_build_object('Authorization','Bearer '||bearer,'Content-Type','application/json'),
   body:='{}'::jsonb,timeout_milliseconds:=110000) into request_id;
  update sms_private.edge_config set last_requested_at=now() where queue=cfg.queue;
  sent:=sent+1;
 end loop;
 return sent;
end $$;
revoke all on function sms_private.dispatch_edge() from public,anon,authenticated,sms_api,sms_webhook,sms_sender,sms_ai,sms_automation;
-- Replace our existing scheduler only; website Cron jobs remain unchanged.
select cron.schedule('sms-scheduler','5 seconds','select sms_private.dispatch_edge()');
-- Draft-only AI cannot execute business tools.
revoke execute on function sms_private.ai_tool(uuid,uuid,text,jsonb,text) from sms_ai;
create or replace function sms_private.tick() returns integer language plpgsql security definer set search_path='' as $$
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
   order by e.next_run_at limit (select scheduler_batch_size from sms_private.runtime) for update of e skip locked loop
   perform sms_private.enqueue(e.tenant_id,'automation_jobs',e.id||':'||e.generation||':'||e.step_index,
     jsonb_build_object('enrollment_id',e.id,'generation',e.generation,'step_index',e.step_index)); n:=n+1;
 end loop;
 return n;
end $$;
create or replace function sms_private.claim(q text,w text) returns jsonb language plpgsql security definer set search_path='' as $$
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
   if q='ai_reply_jobs' and not pg_try_advisory_xact_lock(hashtextextended(j.tenant_id||':'||coalesce(j.payload->>'phone',''),991)) then perform pgmq.set_vt(q,m.msg_id,5); continue; end if;
   if q='ai_reply_jobs' and exists(select from sms_private.jobs other where other.tenant_id=j.tenant_id and other.queue=q
      and other.id<>j.id and other.payload->>'phone'=j.payload->>'phone' and other.leased_until>now()) then perform pgmq.set_vt(q,m.msg_id,5); continue; end if;
   update sms_private.jobs set status='processing',attempts=attempts+1,lease_token=gen_random_uuid(),leased_until=now()+interval '120 seconds',queue_msg_id=m.msg_id,updated_at=now() where id=j.id returning * into j;
   return to_jsonb(j);
 end loop;
 return null;
end $$;
