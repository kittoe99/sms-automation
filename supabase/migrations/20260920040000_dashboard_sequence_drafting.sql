-- One-time dashboard sequence generation and deterministic automation delivery.
do $$ begin
 if not exists(select from pg_roles where rolname='sms_draft') then create role sms_draft nologin; end if;
end $$;
grant usage on schema sms_private to sms_draft;

alter table sms_private.jobs drop constraint if exists jobs_queue_check;
alter table sms_private.jobs add constraint jobs_queue_check check(queue in (
 'sms_send_jobs','automation_jobs','automation_draft_jobs','ai_reply_jobs','provisioning_jobs',
 'knowledge_ingest_jobs','embedding_jobs','handoff_alert_jobs','compliance_jobs'
));
select pgmq.create('automation_draft_jobs');

create table public.sms_automation_drafts (
 tenant_id text not null references public.sms_businesses on delete cascade,
 id uuid not null default gen_random_uuid(),
 creator_id text not null,
 idempotency_key text not null check(length(idempotency_key) between 8 and 200),
 input_hash text not null,
 input jsonb not null,
 status text not null default 'queued' check(status in ('queued','processing','completed','failed')),
 generated_messages jsonb,
 model text,
 prompt_version text,
 input_tokens integer,
 output_tokens integer,
 estimated_cost_micros bigint,
 error_code text,
 error_detail text,
 created_at timestamptz not null default now(),
 started_at timestamptz,
 completed_at timestamptz,
 updated_at timestamptz not null default now(),
 primary key(tenant_id,id), unique(tenant_id,idempotency_key)
);
create index sms_automation_drafts_quota on public.sms_automation_drafts(tenant_id,created_at desc);
alter table public.sms_automation_drafts enable row level security;
create policy tenant_read on public.sms_automation_drafts for select to authenticated using(sms_private.can_access(tenant_id));
grant select on public.sms_automation_drafts to authenticated;

alter table public.sms_automation_groups
 add column if not exists deterministic_delivery boolean not null default true,
 add column if not exists generation_draft_id uuid,
 add column if not exists generated_at timestamptz,
 add column if not exists generation_prompt_version text,
 add column if not exists generation_context_label text,
 add column if not exists generated_messages_edited boolean not null default false;
alter table public.sms_automation_groups add constraint sms_group_generation_draft_fk foreign key(tenant_id,generation_draft_id) references public.sms_automation_drafts(tenant_id,id);

update public.sms_automation_groups
set rule=(rule-'aiDraft')||jsonb_build_object('deliveryMode','deterministic'),deterministic_delivery=true;

create or replace function sms_private.sync_group_generation() returns trigger
language plpgsql security definer set search_path='' as $$
declare provenance jsonb:=new.rule->'generationProvenance';
begin
 new.rule=(new.rule-'aiDraft')||jsonb_build_object('deliveryMode','deterministic');
 new.deterministic_delivery=true;
 if provenance is not null then
  new.generation_draft_id=nullif(provenance->>'draftId','')::uuid;
  new.generated_at=nullif(provenance->>'generatedAt','')::timestamptz;
  new.generation_prompt_version=nullif(provenance->>'promptVersion','');
  new.generation_context_label=nullif(provenance->>'contextLabel','');
  new.generated_messages_edited=coalesce((provenance->>'edited')::boolean,false);
 end if;
 return new;
end $$;
drop trigger if exists sync_group_generation on public.sms_automation_groups;
create trigger sync_group_generation before insert or update of rule on public.sms_automation_groups
for each row execute function sms_private.sync_group_generation();

create or replace function sms_private.worker_access(q text) returns void language plpgsql security definer set search_path='' as $$
declare r text;
begin
 r:=case q when 'sms_send_jobs' then 'sms_sender' when 'ai_reply_jobs' then 'sms_ai'
   when 'automation_draft_jobs' then 'sms_draft'
   when 'automation_jobs' then 'sms_automation' when 'provisioning_jobs' then 'sms_automation'
   when 'knowledge_ingest_jobs' then 'sms_ai' when 'embedding_jobs' then 'sms_ai'
   when 'handoff_alert_jobs' then 'sms_automation' when 'compliance_jobs' then 'sms_automation' end;
 if r is null or not pg_has_role(session_user,r,'member') then raise exception 'Worker role denied' using errcode='42501'; end if;
end $$;

create or replace function sms_private.create_automation_draft(u text,t text,p jsonb,k text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare d public.sms_automation_drafts; job_id uuid; step_count integer; existing public.sms_automation_drafts;
begin
 perform sms_private.require_admin(u);
 if not sms_private.can_access(t,u) then raise exception 'Business access required' using errcode='42501'; end if;
 if length(coalesce(k,'')) not between 8 and 200 then raise exception 'Idempotency-Key required'; end if;
 select * into existing from public.sms_automation_drafts where tenant_id=t and idempotency_key=k;
 if found then
  if existing.input_hash<>md5(p::text) then raise exception 'Idempotency key conflicts with existing payload' using errcode='23505'; end if;
  return jsonb_build_object('draftId',existing.id,'status',existing.status,'idempotent',true);
 end if;
 step_count:=jsonb_array_length(coalesce(p->'steps','[]'));
 if step_count not between 1 and 30 then raise exception 'Use 1-30 steps'; end if;
 if lower(coalesce(p->>'automationType','')) in ('appointment reminder','appointment-reminders','reminder') then raise exception 'Appointment reminders do not use AI'; end if;
 if length(coalesce(p->>'contextLabel','')) not between 1 and 160 then raise exception 'Service, role, or subject context is required'; end if;
 if (select count(*) from public.sms_automation_drafts where tenant_id=t and created_at>now()-interval '24 hours')>=20 then
  raise exception 'AI draft limit reached: 20 generations per rolling 24 hours' using errcode='P0001';
 end if;
 insert into public.sms_automation_drafts(tenant_id,creator_id,idempotency_key,input_hash,input)
 values(t,u,k,md5(p::text),p) returning * into d;
 job_id:=sms_private.enqueue(t,'automation_draft_jobs','draft:'||d.id,jsonb_build_object('draft_id',d.id));
 insert into sms_private.audit(tenant_id,actor,action,detail) values(t,u,'automation_draft_created',jsonb_build_object('draft_id',d.id,'job_id',job_id));
 return jsonb_build_object('draftId',d.id,'jobId',job_id,'status','queued','idempotent',false);
end $$;

create or replace function sms_private.get_automation_draft(u text,t text,did uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
begin
 perform sms_private.require_admin(u);
 if not sms_private.can_access(t,u) then raise exception 'Business access required' using errcode='42501'; end if;
 return (select jsonb_build_object('draftId',d.id,'status',d.status,'messages',d.generated_messages,'model',d.model,
  'promptVersion',d.prompt_version,'contextLabel',d.input->>'contextLabel','createdAt',d.created_at,'completedAt',d.completed_at,
  'inputTokens',d.input_tokens,'outputTokens',d.output_tokens,'estimatedCostMicros',d.estimated_cost_micros,'errorCode',d.error_code)
  from public.sms_automation_drafts d where d.tenant_id=t and d.id=did);
end $$;

create or replace function sms_private.draft_job_context(jid uuid,token uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare j sms_private.jobs; d public.sms_automation_drafts;
begin
 j:=sms_private.lease(jid,token);if j.queue<>'automation_draft_jobs' then raise exception 'Wrong queue';end if;
 select * into strict d from public.sms_automation_drafts where tenant_id=j.tenant_id and id=(j.payload->>'draft_id')::uuid for update;
 update public.sms_automation_drafts set status='processing',started_at=coalesce(started_at,now()),updated_at=now() where tenant_id=d.tenant_id and id=d.id;
 return jsonb_build_object('draft',jsonb_build_object('id',d.id,'input',d.input),
  'business',(select to_jsonb(b) from public.sms_businesses b where b.tenant_id=j.tenant_id),
  'profile',(select to_jsonb(v) from public.sms_business_profile_versions v join public.sms_businesses b on b.tenant_id=v.tenant_id and b.active_profile_version_id=v.id where v.tenant_id=j.tenant_id and v.status='approved'));
end $$;

create or replace function sms_private.complete_automation_draft(jid uuid,token uuid,p jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare j sms_private.jobs; did uuid;
begin
 j:=sms_private.lease(jid,token);if j.queue<>'automation_draft_jobs' then raise exception 'Wrong queue';end if;did:=(j.payload->>'draft_id')::uuid;
 update public.sms_automation_drafts set status='completed',generated_messages=p->'messages',model=p->>'model',prompt_version=p->>'promptVersion',
  input_tokens=(p->>'inputTokens')::integer,output_tokens=(p->>'outputTokens')::integer,estimated_cost_micros=(p->>'estimatedCostMicros')::bigint,
  error_code=null,error_detail=null,completed_at=now(),updated_at=now() where tenant_id=j.tenant_id and id=did;
 perform sms_private.finish(jid,token,'completed');return jsonb_build_object('draftId',did,'status','completed');
end $$;

create or replace function sms_private.fail_automation_draft(jid uuid,token uuid,code text,is_permanent boolean,delay_seconds integer) returns void
language plpgsql security definer set search_path='' as $$
declare j sms_private.jobs; final_failure boolean;
begin
 j:=sms_private.lease(jid,token);if j.queue<>'automation_draft_jobs' then raise exception 'Wrong queue';end if;
 final_failure:=coalesce(is_permanent,false) or j.attempts>=6;
 update public.sms_automation_drafts set status=case when final_failure then 'failed' else 'queued' end,error_code=code,updated_at=now(),
  completed_at=case when final_failure then now() else null end where tenant_id=j.tenant_id and id=(j.payload->>'draft_id')::uuid;
 perform sms_private.finish(jid,token,case when final_failure then 'failed' else 'retry' end,code,delay_seconds);
end $$;

-- Delivery jobs now fetch only data required to render the saved template.
create or replace function sms_private.job_context(jid uuid,token uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare j sms_private.jobs;e public.sms_automation_enrollments;c public.sms_contacts;ph text;
begin
 j:=sms_private.lease(jid,token);
 if j.queue='automation_jobs' then
  select * into e from public.sms_automation_enrollments where tenant_id=j.tenant_id and id=(j.payload->>'enrollment_id')::uuid;
  select * into c from public.sms_contacts where tenant_id=j.tenant_id and id=e.contact_id;
  return jsonb_build_object('enrollment',to_jsonb(e),'contact',to_jsonb(c),
   'business',(select to_jsonb(b) from public.sms_businesses b where tenant_id=j.tenant_id),
   'group',(select to_jsonb(g) from public.sms_automation_groups g where tenant_id=j.tenant_id and id=e.category_id),
   'steps',(select jsonb_agg(s order by step_index) from public.sms_automation_steps s where tenant_id=j.tenant_id and group_id=e.category_id));
 elsif j.queue='ai_reply_jobs' then
  ph:=j.payload->>'phone';select * into c from public.sms_contacts where tenant_id=j.tenant_id and phone=ph;
  return jsonb_build_object('business',(select to_jsonb(b) from public.sms_businesses b where tenant_id=j.tenant_id),
   'profile',(select to_jsonb(v) from public.sms_business_profile_versions v join public.sms_businesses b on b.tenant_id=v.tenant_id and b.active_profile_version_id=v.id where v.tenant_id=j.tenant_id and v.status='approved'),
   'contact',to_jsonb(c),'thread',(select to_jsonb(th) from public.sms_thread_contacts th where tenant_id=j.tenant_id and phone=ph),
   'settings',(select to_jsonb(a) from public.sms_ai_settings a where tenant_id=j.tenant_id and group_id=j.payload->>'group_id'),
   'open_lead',(select to_jsonb(l) from public.sms_leads l where l.tenant_id=j.tenant_id and l.contact_id=c.id and l.status in ('open','assigned') order by l.updated_at desc limit 1),
   'booking_settings',(select to_jsonb(s) from public.sms_booking_settings s where s.tenant_id=j.tenant_id and s.enabled),
   'booking_session',(select to_jsonb(s) from public.sms_booking_sessions s where s.tenant_id=j.tenant_id and s.contact_id=c.id and s.expires_at>now()),
   'history',(select coalesce(jsonb_agg(m order by created_at),'[]') from (select id,direction,body,created_at from public.sms_messages where tenant_id=j.tenant_id and contact_phone=ph order by created_at desc limit 20)m));
 elsif j.queue='provisioning_jobs' then
  return (select jsonb_build_object('account_sid',p.account_sid,'messaging_service_sid',p.messaging_service_sid,'phone_number_sid',p.phone_number_sid,'state',p.provisioning_state,'business_name',b.name) from sms_private.providers p join public.sms_businesses b using(tenant_id) where p.tenant_id=j.tenant_id);
 end if;raise exception 'Unsupported context';
end $$;

-- Fair set-based scheduler: one due row per tenant per pass, up to the configured 5,000.
create or replace function sms_private.enqueue_due_automations() returns integer language plpgsql security definer set search_path='' as $$
declare n integer;
begin
 with due as materialized(
  select tenant_id,id,generation,step_index from(
   select e.tenant_id,e.id,e.generation,e.step_index,e.next_run_at,row_number() over(partition by e.tenant_id order by e.next_run_at,e.id) fair_rank
   from public.sms_automation_enrollments e join public.sms_businesses b using(tenant_id)
   join public.sms_automation_groups g on g.tenant_id=e.tenant_id and g.id=e.category_id
   where e.status='active' and e.next_run_at<=now() and b.sending_enabled and b.status='active' and g.active
   and not exists(select from sms_private.jobs j where j.tenant_id=e.tenant_id and j.queue='automation_jobs' and j.dedupe_key=e.id||':'||e.generation||':'||e.step_index)
  ) ranked order by fair_rank,next_run_at limit(select scheduler_batch_size from sms_private.runtime)
 ),queued as(
  select sms_private.enqueue(d.tenant_id,'automation_jobs',d.id||':'||d.generation||':'||d.step_index,jsonb_build_object('enrollment_id',d.id,'generation',d.generation,'step_index',d.step_index)) from due d
 ) select count(*) into n from queued;return n;
end $$;

create table public.sms_daily_usage (
 tenant_id text not null references public.sms_businesses on delete cascade,usage_date date not null,
 total bigint not null default 0,queued bigint not null default 0,accepted bigint not null default 0,sent bigint not null default 0,delivered bigint not null default 0,
 failed bigint not null default 0,submission_unknown bigint not null default 0,cancelled bigint not null default 0,received bigint not null default 0,
 segments bigint not null default 0,estimated_sms_cost_micros bigint not null default 0,draft_input_tokens bigint not null default 0,
 draft_output_tokens bigint not null default 0,draft_cost_micros bigint not null default 0,updated_at timestamptz not null default now(),primary key(tenant_id,usage_date)
);
create table public.sms_daily_category_usage(
 tenant_id text not null references public.sms_businesses on delete cascade,usage_date date not null,category_id text not null,
 total bigint not null default 0,primary key(tenant_id,usage_date,category_id)
);
alter table public.sms_daily_usage enable row level security;
alter table public.sms_daily_category_usage enable row level security;
create policy tenant_read on public.sms_daily_usage for select to authenticated using(sms_private.can_access(tenant_id));
create policy tenant_read on public.sms_daily_category_usage for select to authenticated using(sms_private.can_access(tenant_id));
grant select on public.sms_daily_usage,public.sms_daily_category_usage to authenticated;

create or replace function sms_private.refresh_daily_usage(target_date date default current_date-1) returns integer
language plpgsql security definer set search_path='' as $$
declare n integer;
begin
 insert into public.sms_daily_usage(tenant_id,usage_date,total,queued,accepted,sent,delivered,failed,submission_unknown,cancelled,received,segments,estimated_sms_cost_micros,updated_at)
 select b.tenant_id,target_date,count(m.id),count(m.id) filter(where m.status='queued'),count(m.id) filter(where m.status='accepted'),count(m.id) filter(where m.status='sent'),count(m.id) filter(where m.status='delivered'),
  count(m.id) filter(where m.status='failed'),count(m.id) filter(where m.status='submission_unknown'),count(m.id) filter(where m.status='cancelled'),count(m.id) filter(where m.status='received'),
  coalesce(sum((m.meta->>'estimated_segments')::integer),0),coalesce(sum((m.meta->>'estimated_cost_micros')::bigint),0),now()
 from public.sms_businesses b left join public.sms_messages m on m.tenant_id=b.tenant_id and m.created_at>=target_date and m.created_at<target_date+1
 group by b.tenant_id
 on conflict(tenant_id,usage_date) do update set total=excluded.total,queued=excluded.queued,accepted=excluded.accepted,sent=excluded.sent,delivered=excluded.delivered,failed=excluded.failed,
  submission_unknown=excluded.submission_unknown,cancelled=excluded.cancelled,received=excluded.received,
  segments=excluded.segments,estimated_sms_cost_micros=excluded.estimated_sms_cost_micros,updated_at=now();
 delete from public.sms_daily_category_usage where usage_date=target_date;
 insert into public.sms_daily_category_usage(tenant_id,usage_date,category_id,total)
 select tenant_id,target_date,category_id,count(*) from public.sms_messages where created_at>=target_date and created_at<target_date+1 and category_id is not null group by tenant_id,category_id;
 get diagnostics n=row_count;return n;
end $$;

create or replace function sms_private.usage_summary(u text,t text) returns jsonb language plpgsql security definer set search_path='' as $$
declare historical jsonb;today jsonb;categories jsonb;
begin
 perform sms_private.require_admin(u);if not sms_private.can_access(t,u) then raise exception 'Business access required' using errcode='42501';end if;
 select jsonb_build_object('total',coalesce(sum(total),0),'queued',coalesce(sum(queued),0),'accepted',coalesce(sum(accepted),0),'sent',coalesce(sum(sent),0),'delivered',coalesce(sum(delivered),0),'failed',coalesce(sum(failed),0),'submission_unknown',coalesce(sum(submission_unknown),0),'cancelled',coalesce(sum(cancelled),0),'received',coalesce(sum(received),0)) into historical
 from public.sms_daily_usage where tenant_id=t and usage_date<current_date;
 select coalesce(jsonb_object_agg(status,n),'{}') into today from(select status,count(*) n from public.sms_messages where tenant_id=t and created_at>=current_date group by status)s;
 select coalesce(jsonb_agg(jsonb_build_object('id',category_id,'total',total)),'[]') into categories from(
  select category_id,sum(total) total from(
   select category_id,total from public.sms_daily_category_usage where tenant_id=t and usage_date<current_date
   union all select category_id,count(*) from public.sms_messages where tenant_id=t and created_at>=current_date and category_id is not null group by category_id
  )x group by category_id
 )c;
 return jsonb_build_object('total',coalesce((historical->>'total')::bigint,0)+(select count(*) from public.sms_messages where tenant_id=t and created_at>=current_date),
  'contactCount',(select count(*) from public.sms_contacts where tenant_id=t),'conversationCount',(select count(*) from public.sms_thread_contacts where tenant_id=t),
  'optedOutTotal',(select count(*) from public.sms_contacts where tenant_id=t and opted_out),
  'counts',jsonb_build_object('queued',coalesce((historical->>'queued')::bigint,0)+coalesce((today->>'queued')::bigint,0),
   'accepted',coalesce((historical->>'accepted')::bigint,0)+coalesce((today->>'accepted')::bigint,0),'sent',coalesce((historical->>'sent')::bigint,0)+coalesce((today->>'sent')::bigint,0),
   'delivered',coalesce((historical->>'delivered')::bigint,0)+coalesce((today->>'delivered')::bigint,0),
   'failed',coalesce((historical->>'failed')::bigint,0)+coalesce((today->>'failed')::bigint,0),'submission_unknown',coalesce((historical->>'submission_unknown')::bigint,0)+coalesce((today->>'submission_unknown')::bigint,0),
   'cancelled',coalesce((historical->>'cancelled')::bigint,0)+coalesce((today->>'cancelled')::bigint,0),'received',coalesce((historical->>'received')::bigint,0)+coalesce((today->>'received')::bigint,0)),
  'byCategory',categories);
end $$;
select cron.schedule('sms-daily-usage','17 * * * *','select sms_private.refresh_daily_usage(current_date-1)');
create table sms_private.archive_catalog(
 id uuid primary key default gen_random_uuid(),tenant_id text not null references public.sms_businesses,
 record_type text not null check(record_type in ('messages','message_events')),period_start date not null,period_end date not null,
 object_path text not null,row_count bigint not null,checksum text not null,created_at timestamptz not null default now(),deleted_at timestamptz,
 unique(tenant_id,record_type,period_start)
);
alter table sms_private.archive_catalog enable row level security;

create or replace function sms_private.retention_maintenance() returns jsonb language plpgsql security definer set search_path='' as $$
declare completed_deleted bigint;begin
 delete from sms_private.jobs where status in ('completed','cancelled') and updated_at<now()-interval '14 days';get diagnostics completed_deleted=row_count;
 delete from sms_private.jobs where status in ('failed','submission_unknown') and updated_at<now()-interval '90 days';
 return jsonb_build_object('completedJobsDeleted',completed_deleted);
end $$;

create or replace function sms_private.tick() returns integer language plpgsql security definer set search_path='' as $$
declare j record;n integer:=0;
begin
 if not pg_try_advisory_xact_lock(720491321) then return 0;end if;
 update sms_private.runtime set last_tick_at=now();
 for j in select * from sms_private.jobs where leased_until<now() and status in ('submitting','processing') order by leased_until limit 500 for update skip locked loop
  if j.status='submitting' then
   update sms_private.jobs set status='submission_unknown',leased_until=null,error_code='WORKER_LOST',updated_at=now() where id=j.id;
   update public.sms_messages set status='submission_unknown',updated_at=now() where tenant_id=j.tenant_id and id=(j.payload->>'message_id')::uuid;
   update public.sms_automation_enrollments set status='paused' where tenant_id=j.tenant_id and id=(j.payload->'request'->>'enrollment_id')::uuid and generation=(j.payload->'request'->>'enrollment_generation')::bigint;
   perform pgmq.delete(j.queue,j.queue_msg_id);
  else
   update sms_private.jobs set status=case when attempts>=6 then 'failed' else 'retry' end,leased_until=null,updated_at=now() where id=j.id;
   if j.queue='automation_draft_jobs' then update public.sms_automation_drafts set status=case when j.attempts>=6 then 'failed' else 'queued' end,error_code='WORKER_LOST',updated_at=now() where tenant_id=j.tenant_id and id=(j.payload->>'draft_id')::uuid;end if;
  end if;
 end loop;
 if (select scheduler_enabled from sms_private.runtime) then n:=sms_private.enqueue_due_automations();end if;
 return n;
end $$;

revoke all on function sms_private.create_automation_draft(text,text,jsonb,text),sms_private.get_automation_draft(text,text,uuid) from public,anon,authenticated,sms_webhook,sms_sender,sms_automation,sms_ai,sms_draft;
grant execute on function sms_private.create_automation_draft(text,text,jsonb,text),sms_private.get_automation_draft(text,text,uuid) to sms_api;
grant execute on function sms_private.usage_summary(text,text) to sms_api;
revoke all on function sms_private.draft_job_context(uuid,uuid),sms_private.complete_automation_draft(uuid,uuid,jsonb),sms_private.fail_automation_draft(uuid,uuid,text,boolean,integer) from public,anon,authenticated,sms_api,sms_webhook,sms_sender,sms_automation,sms_ai;
grant execute on function sms_private.claim(text,text),sms_private.extend_lease(uuid,uuid),sms_private.finish(uuid,uuid,text,text,integer),sms_private.draft_job_context(uuid,uuid),sms_private.complete_automation_draft(uuid,uuid,jsonb),sms_private.fail_automation_draft(uuid,uuid,text,boolean,integer) to sms_draft;
grant execute on function sms_private.job_context(uuid,uuid) to sms_automation,sms_ai;
