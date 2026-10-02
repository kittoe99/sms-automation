-- Outgoing automation instructions and facts belong to a tenant's group.
-- Existing values stay null until an administrator writes them in the dashboard.
alter table public.sms_automation_intents
  add column system_prompt text check (system_prompt is null or length(system_prompt) between 1 and 6000),
  add column business_context text check (business_context is null or length(business_context) between 1 and 10000);

create function sms_private.automation_ai_configured(t text,gid text) returns boolean
language sql stable security definer set search_path='' as $$
  select exists(select 1 from public.sms_automation_intents i
    where i.tenant_id=t and i.group_id=gid
      and nullif(btrim(i.intent),'') is not null
      and nullif(btrim(i.system_prompt),'') is not null
      and nullif(btrim(i.business_context),'') is not null)
$$;
revoke all on function sms_private.automation_ai_configured(text,text)
  from public,anon,authenticated,sms_api,sms_webhook,sms_sender,sms_ai,sms_automation;

-- Invalidate old drafts and outbox rows. The due date is retained so eligible
-- enrollments can be evaluated when a group is configured.
update public.sms_automation_enrollments e set generation=generation+1
where e.status='active' and not sms_private.automation_ai_configured(e.tenant_id,e.category_id);

alter function sms_private.api_action(text,text,text,jsonb) rename to api_action_before_group_ai;
revoke all on function sms_private.api_action_before_group_ai(text,text,text,jsonb)
  from public,anon,authenticated,sms_api,sms_webhook,sms_sender,sms_ai,sms_automation;
create function sms_private.api_action(u text,t text,action text,p jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare previous public.sms_automation_intents; prompt_text text; context_text text; result jsonb;
begin
  if action<>'group' then return sms_private.api_action_before_group_ai(u,t,action,p); end if;
  perform sms_private.require_admin(u);
  if (p ? 'systemPrompt' and jsonb_typeof(p->'systemPrompt')<>'string')
     or (p ? 'businessContext' and jsonb_typeof(p->'businessContext')<>'string') then
    raise exception 'AI instructions and business details must be text' using errcode='22023';
  end if;
  select * into previous from public.sms_automation_intents
    where tenant_id=t and group_id=p->>'id';
  prompt_text:=nullif(btrim(case when p ? 'systemPrompt' then p->>'systemPrompt' else previous.system_prompt end),'');
  context_text:=nullif(btrim(case when p ? 'businessContext' then p->>'businessContext' else previous.business_context end),'');
  if length(prompt_text)>6000 or length(context_text)>10000 then
    raise exception 'Automation AI instructions or business details are too long' using errcode='22023';
  end if;
  if coalesce((p->>'active')::boolean,true) and (prompt_text is null or context_text is null) then
    raise exception 'Add AI instructions and business details before activating this automation' using errcode='22023';
  end if;
  result:=sms_private.api_action_before_group_ai(u,t,action,p);
  update public.sms_automation_intents set system_prompt=prompt_text,
    business_context=context_text,updated_at=now()
    where tenant_id=t and group_id=p->>'id';
  return result||jsonb_build_object('system_prompt',prompt_text,
    'business_context',context_text,'ai_configured',prompt_text is not null and context_text is not null);
end $$;
revoke all on function sms_private.api_action(text,text,text,jsonb)
  from public,anon,authenticated,sms_api,sms_webhook,sms_sender,sms_ai,sms_automation;
grant execute on function sms_private.api_action(text,text,text,jsonb) to sms_api;

alter function sms_private.api_read(text,text,text,jsonb) rename to api_read_before_group_ai;
revoke all on function sms_private.api_read_before_group_ai(text,text,text,jsonb)
  from public,anon,authenticated,sms_api,sms_webhook,sms_sender,sms_ai,sms_automation;
create function sms_private.api_read(u text,t text,resource text,p jsonb default '{}') returns jsonb
language plpgsql security definer set search_path='' as $$
declare base jsonb; rows jsonb;
begin
  base:=sms_private.api_read_before_group_ai(u,t,resource,p);
  if resource<>'groups' then return base; end if;
  select coalesce(jsonb_agg(x.item||jsonb_build_object(
      'system_prompt',i.system_prompt,'business_context',i.business_context,
      'ai_configured',sms_private.automation_ai_configured(t,x.item->>'id'))
      order by x.ordinality),'[]'::jsonb) into rows
    from jsonb_array_elements(base->'rows') with ordinality as x(item,ordinality)
    left join public.sms_automation_intents i on i.tenant_id=t and i.group_id=x.item->>'id';
  return base||jsonb_build_object('rows',rows);
end $$;
revoke all on function sms_private.api_read(text,text,text,jsonb)
  from public,anon,authenticated,sms_api,sms_webhook,sms_sender,sms_ai,sms_automation;
grant execute on function sms_private.api_read(text,text,text,jsonb) to sms_api;

-- The existing context function still serves inbound AI. Remove account-wide
-- profile data only from automation jobs and attach the group's authored data.
alter function sms_private.job_context(uuid,uuid) rename to job_context_before_group_ai;
revoke all on function sms_private.job_context_before_group_ai(uuid,uuid)
  from public,anon,authenticated,sms_api,sms_webhook,sms_sender,sms_ai,sms_automation;
create function sms_private.job_context(jid uuid,token uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare base jsonb; j sms_private.jobs; config public.sms_automation_intents;
begin
  base:=sms_private.job_context_before_group_ai(jid,token);
  select * into strict j from sms_private.jobs where id=jid;
  if j.queue<>'automation_jobs' then return base; end if;
  select * into config from public.sms_automation_intents
    where tenant_id=j.tenant_id and group_id=base->'enrollment'->>'category_id';
  return (base-'profile')||jsonb_build_object(
    'business',jsonb_build_object('name',base->'business'->>'name',
      'time_zone',base->'business'->>'time_zone'),
    'automationAi',jsonb_build_object('systemPrompt',config.system_prompt,
      'businessContext',config.business_context));
end $$;
revoke all on function sms_private.job_context(uuid,uuid)
  from public,anon,authenticated,sms_api,sms_webhook,sms_sender,sms_ai,sms_automation;
grant execute on function sms_private.job_context_before_group_ai(uuid,uuid),
  sms_private.job_context(uuid,uuid) to sms_automation,sms_ai;

-- A group without its own context cannot create new draft jobs.
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
        and nullif(btrim(i.system_prompt),'') is not null
        and nullif(btrim(i.business_context),'') is not null
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

-- Recheck under a row lock when a freshly generated draft becomes an outbox
-- message, and again when an old outbox message reaches provider submission.
alter function sms_private.complete_automation(uuid,uuid,jsonb) rename to complete_automation_before_group_ai;
revoke all on function sms_private.complete_automation_before_group_ai(uuid,uuid,jsonb)
  from public,anon,authenticated,sms_api,sms_webhook,sms_sender,sms_ai,sms_automation;
create function sms_private.complete_automation(jid uuid,token uuid,p jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare j sms_private.jobs; config public.sms_automation_intents;
begin
  if p->>'action'='send' then
    j:=sms_private.lease(jid,token);
    select i.* into config from sms_private.jobs job
      join public.sms_automation_enrollments e on e.tenant_id=job.tenant_id
        and e.id=(job.payload->>'enrollment_id')::uuid
      join public.sms_automation_intents i on i.tenant_id=e.tenant_id and i.group_id=e.category_id
      where job.id=j.id;
    if nullif(btrim(config.system_prompt),'') is null
       or nullif(btrim(config.business_context),'') is null then
      perform sms_private.finish(jid,token,'cancelled','AI_CONFIG_REQUIRED');
      return null;
    end if;
  end if;
  return sms_private.complete_automation_before_group_ai(jid,token,p);
end $$;
revoke all on function sms_private.complete_automation(uuid,uuid,jsonb)
  from public,anon,authenticated,sms_api,sms_webhook,sms_sender,sms_ai,sms_automation;
grant execute on function sms_private.complete_automation(uuid,uuid,jsonb) to sms_automation;

alter function sms_private.begin_submission(uuid,uuid) rename to begin_submission_before_group_ai;
revoke all on function sms_private.begin_submission_before_group_ai(uuid,uuid)
  from public,anon,authenticated,sms_api,sms_webhook,sms_sender,sms_ai,sms_automation;
create function sms_private.begin_submission(jid uuid,token uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare j sms_private.jobs; config public.sms_automation_intents;
begin
  j:=sms_private.lease(jid,token);
  if j.queue='sms_send_jobs' and j.payload->'request' ? 'enrollment_id' then
    select i.* into config from public.sms_automation_enrollments e
      join public.sms_automation_intents i on i.tenant_id=e.tenant_id and i.group_id=e.category_id
      where e.tenant_id=j.tenant_id and e.id=(j.payload->'request'->>'enrollment_id')::uuid;
    if nullif(btrim(config.system_prompt),'') is null
       or nullif(btrim(config.business_context),'') is null then
      perform sms_private.finish(jid,token,'cancelled','AI_CONFIG_REQUIRED');
      return null;
    end if;
  end if;
  return sms_private.begin_submission_before_group_ai(jid,token);
end $$;
revoke all on function sms_private.begin_submission(uuid,uuid)
  from public,anon,authenticated,sms_api,sms_webhook,sms_sender,sms_ai,sms_automation;
grant execute on function sms_private.begin_submission(uuid,uuid) to sms_sender;

