-- Each known automation uses its group prompt and context. Unmatched inbound
-- texts use a separately authored business-wide prompt.
create table public.sms_business_ai_settings (
  tenant_id text primary key references public.sms_businesses(tenant_id) on delete cascade,
  enabled boolean not null default false,
  system_prompt text not null default '' check (length(system_prompt)<=6000),
  updated_at timestamptz not null default now(),
  check (not enabled or nullif(btrim(system_prompt),'') is not null)
);
alter table public.sms_business_ai_settings enable row level security;
create policy tenant_read on public.sms_business_ai_settings for select to authenticated
  using (sms_private.can_access(tenant_id));
grant select on public.sms_business_ai_settings to authenticated;

create function sms_private.business_ai_settings(u text,t text) returns jsonb
language plpgsql stable security definer set search_path='' as $$
begin
  if not sms_private.can_access(t,u) then raise exception 'Tenant access denied' using errcode='42501'; end if;
  return coalesce((select jsonb_build_object('enabled',enabled,'systemPrompt',system_prompt,'updatedAt',updated_at)
    from public.sms_business_ai_settings where tenant_id=t),
    jsonb_build_object('enabled',false,'systemPrompt',''));
end $$;
create function sms_private.save_business_ai_settings(u text,t text,input jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare prompt_text text; is_enabled boolean;
begin
  perform sms_private.require_admin(u);
  if not exists(select 1 from public.sms_businesses where tenant_id=t) then raise exception 'Unknown business'; end if;
  if jsonb_typeof(input->'systemPrompt')<>'string' or jsonb_typeof(input->'enabled')<>'boolean' then
    raise exception 'AI instructions and enabled state are required' using errcode='22023';
  end if;
  prompt_text:=btrim(input->>'systemPrompt');
  is_enabled:=(input->>'enabled')::boolean;
  if length(prompt_text)>6000 or (is_enabled and prompt_text='') then
    raise exception 'Add business-wide AI instructions before enabling replies' using errcode='22023';
  end if;
  insert into public.sms_business_ai_settings(tenant_id,enabled,system_prompt)
    values(t,is_enabled,prompt_text)
    on conflict(tenant_id) do update set enabled=excluded.enabled,system_prompt=excluded.system_prompt,updated_at=now();
  -- Cancel replies drafted under an older prompt.
  update public.sms_thread_contacts set generation=generation+1 where tenant_id=t;
  return sms_private.business_ai_settings(u,t);
end $$;
revoke all on function sms_private.business_ai_settings(text,text),
  sms_private.save_business_ai_settings(text,text,jsonb)
  from public,anon,authenticated,sms_api,sms_webhook,sms_sender,sms_automation,sms_ai;
grant execute on function sms_private.business_ai_settings(text,text),
  sms_private.save_business_ai_settings(text,text,jsonb) to sms_api;

create function sms_private.invalidate_group_ai_replies() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  update public.sms_thread_contacts th set generation=th.generation+1
    where th.tenant_id=new.tenant_id and exists (
      select 1 from public.sms_automation_enrollments e
      join public.sms_contacts c on c.tenant_id=e.tenant_id and c.id=e.contact_id
      where e.tenant_id=new.tenant_id and e.category_id=new.group_id
        and e.status='active' and c.phone=th.phone
    );
  return new;
end $$;
create trigger sms_group_ai_prompt_invalidate after update of system_prompt,business_context
  on public.sms_automation_intents for each row
  when (old.system_prompt is distinct from new.system_prompt
    or old.business_context is distinct from new.business_context)
  execute function sms_private.invalidate_group_ai_replies();
revoke all on function sms_private.invalidate_group_ai_replies()
  from public,anon,authenticated,sms_api,sms_webhook,sms_sender,sms_automation,sms_ai;

-- Business Context approval must no longer turn on an arbitrary group's AI.
create or replace function sms_private.auto_enable_inbound_ai(t text) returns void
language plpgsql security definer set search_path='' as $$ begin return; end $$;

alter function sms_private.job_context(uuid,uuid) rename to job_context_before_scoped_ai;
revoke all on function sms_private.job_context_before_scoped_ai(uuid,uuid)
  from public,anon,authenticated,sms_api,sms_webhook,sms_sender,sms_ai,sms_automation;
create function sms_private.job_context(jid uuid,token uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare base jsonb; j sms_private.jobs; config public.sms_automation_intents; b public.sms_business_ai_settings;
begin
  base:=sms_private.job_context_before_scoped_ai(jid,token);
  select * into strict j from sms_private.jobs where id=jid;
  if j.queue<>'ai_reply_jobs' then return base; end if;
  if nullif(j.payload->>'group_id','') is not null then
    select * into config from public.sms_automation_intents
      where tenant_id=j.tenant_id and group_id=j.payload->>'group_id';
    return (base-'profile'-case when j.payload->>'group_id'='quote-requests' then '__unused__' else 'active_request' end)
      ||jsonb_build_object('inboundAi',jsonb_build_object(
      'scope','group','systemPrompt',config.system_prompt,'businessContext',config.business_context));
  end if;
  select * into b from public.sms_business_ai_settings where tenant_id=j.tenant_id;
  return (base-'active_request'-'recent_booking'-'open_lead'-case when j.payload->>'booking_follow_up'='true' then '__unused__' else 'booking_session' end)
    ||jsonb_build_object(
    'settings',jsonb_build_object('enabled',coalesce(b.enabled,false),
      'grounded_enabled',true,'shadow_mode',false),
    'inboundAi',jsonb_build_object('scope','business','systemPrompt',b.system_prompt));
end $$;
revoke all on function sms_private.job_context(uuid,uuid)
  from public,anon,authenticated,sms_api,sms_webhook,sms_sender,sms_ai,sms_automation;
grant execute on function sms_private.job_context_before_scoped_ai(uuid,uuid),
  sms_private.job_context(uuid,uuid) to sms_ai,sms_automation;

-- The routing decision is made from a current active enrollment. A stray
-- inbound number has no group_id and can only use the business-wide prompt.
create or replace function sms_private.record_webhook(t text,event text,p jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
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
   select e.category_id into gid from public.sms_automation_enrollments e
     join public.sms_automation_intents i on i.tenant_id=e.tenant_id and i.group_id=e.category_id
     join public.sms_ai_settings setting on setting.tenant_id=e.tenant_id and setting.group_id=e.category_id
     where e.tenant_id=t and e.contact_id=c.id and e.status='active' and setting.enabled
       and sms_private.automation_ai_configured(t,e.category_id)
     order by e.created_at desc,e.id desc limit 1;
   if gid is null and not exists (
     select 1 from public.sms_automation_enrollments e
       where e.tenant_id=t and e.contact_id=c.id and e.status='active'
   ) and exists (
     select 1 from public.sms_business_ai_settings b
       where b.tenant_id=t and b.enabled and nullif(btrim(b.system_prompt),'') is not null
   ) then
     gid:='';
   end if;
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

-- Completion rechecks the selected scope after drafting and before outbox.
create or replace function sms_private.complete_grounded_ai(jid uuid,token uuid,p jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
#variable_conflict use_column
declare j sms_private.jobs; cid uuid; mid uuid; lead public.sms_leads; handoff_id uuid; result jsonb; alert text; disposition text; booking jsonb; effective_reply text;
begin
 j:=sms_private.lease(jid,token); if j.queue<>'ai_reply_jobs' then raise exception 'Wrong queue'; end if;
 if not exists(select from public.sms_thread_contacts th join public.sms_contacts c using(tenant_id,phone) where th.tenant_id=j.tenant_id and th.phone=j.payload->>'phone' and th.generation=(j.payload->>'generation')::bigint and not th.ai_paused and not c.opted_out) or not (case when nullif(j.payload->>'group_id','') is null then exists(select 1 from public.sms_business_ai_settings b where b.tenant_id=j.tenant_id and b.enabled and nullif(btrim(b.system_prompt),'') is not null) else exists(select 1 from public.sms_ai_settings a where a.tenant_id=j.tenant_id and a.group_id=j.payload->>'group_id' and a.enabled) and sms_private.automation_ai_configured(j.tenant_id,j.payload->>'group_id') end) then perform sms_private.finish(jid,token,'cancelled','STALE_REPLY'); return null; end if;
 if not coalesce((j.payload->>'booking_follow_up')::boolean,false) and (
   (nullif(j.payload->>'group_id','') is null and exists (
     select 1 from public.sms_automation_enrollments e join public.sms_contacts c
       on c.tenant_id=e.tenant_id and c.id=e.contact_id
       where e.tenant_id=j.tenant_id and c.phone=j.payload->>'phone' and e.status='active'))
   or (nullif(j.payload->>'group_id','') is not null and not exists (
     select 1 from public.sms_automation_enrollments e join public.sms_contacts c
       on c.tenant_id=e.tenant_id and c.id=e.contact_id
       where e.tenant_id=j.tenant_id and c.phone=j.payload->>'phone'
         and e.category_id=j.payload->>'group_id' and e.status='active'))
 ) then perform sms_private.finish(jid,token,'cancelled','STALE_SCOPE'); return null; end if;
 select id into strict cid from public.sms_contacts where tenant_id=j.tenant_id and phone=j.payload->>'phone' for update;
 disposition:=p->>'disposition'; if disposition not in ('answered','collect_lead','handoff') then raise exception 'Invalid AI disposition'; end if;
 if length(trim(coalesce(p->>'reply',''))) not between 1 and 600 then raise exception 'AI reply must be between 1 and 600 characters'; end if;
 if disposition='answered' and coalesce((p->>'grounded')::boolean,false) is not true then raise exception 'Direct answers must be grounded'; end if;
 if disposition='answered' and nullif(p->>'profileVersionId','') is null and jsonb_array_length(coalesce(p->'citationIds','[]'))=0 and (nullif(j.payload->>'group_id','') is null or not sms_private.automation_ai_configured(j.tenant_id,j.payload->>'group_id')) then raise exception 'Direct answers require approved evidence'; end if;
 if exists(select from jsonb_array_elements_text(coalesce(p->'citationIds','[]')) x where not exists(select from public.sms_knowledge_chunks c join public.sms_knowledge_sources s on s.tenant_id=c.tenant_id and s.id=c.source_id and s.active_version_id=c.source_version_id join public.sms_knowledge_source_versions v on v.tenant_id=c.tenant_id and v.id=c.source_version_id and v.status='approved' where c.tenant_id=j.tenant_id and c.id=x::uuid)) then raise exception 'AI cited unapproved evidence'; end if;
 if nullif(p->>'profileVersionId','') is not null and not exists(select from public.sms_businesses where tenant_id=j.tenant_id and active_profile_version_id=(p->>'profileVersionId')::uuid) then raise exception 'AI used an inactive profile'; end if;
 booking:=case when coalesce(p->>'mode','live')='shadow' then jsonb_build_object('handled',false,'state','shadow') else sms_private.apply_booking_ai(j,p,cid) end; effective_reply:=case when coalesce((booking->>'handled')::boolean,false) then booking->>'reply' else p->>'reply' end;
 insert into public.sms_ai_runs(tenant_id,job_id,contact_phone,mode,disposition,grounded,citation_ids,profile_version_id,model,prompt_version,input_tokens,output_tokens,estimated_cost_micros,latency_ms,validation_error,result)
 values(j.tenant_id,j.id,j.payload->>'phone',coalesce(p->>'mode','live'),disposition,coalesce((p->>'grounded')::boolean,false),coalesce((select array_agg(x::uuid) from jsonb_array_elements_text(coalesce(p->'citationIds','[]')) x),'{}'),nullif(p->>'profileVersionId','')::uuid,p->>'model',coalesce(p->>'promptVersion','grounded-v1'),(p->>'inputTokens')::integer,(p->>'outputTokens')::integer,(p->>'estimatedCostMicros')::bigint,(p->>'latencyMs')::integer,p->>'validationError',p||jsonb_build_object('bookingOutcome',booking));
 if coalesce(p->>'mode','live')='shadow' then perform sms_private.finish(jid,token,'completed');return jsonb_build_object('shadow',true);end if;
 if disposition in ('collect_lead','handoff') then
   perform pg_advisory_xact_lock(hashtextextended(j.tenant_id||':'||cid::text,713)); select * into lead from public.sms_leads where tenant_id=j.tenant_id and contact_id=cid and status in ('open','assigned') for update;
   if found then update public.sms_leads set fields=fields||coalesce(p->'lead','{}'),summary=coalesce(nullif(p->>'leadSummary',''),summary),updated_at=now() where tenant_id=j.tenant_id and id=lead.id returning * into lead;
   else insert into public.sms_leads(tenant_id,contact_id,fields,summary,priority,source_message_id) values(j.tenant_id,cid,coalesce(p->'lead','{}'),coalesce(p->>'leadSummary',''),coalesce(p->>'priority','normal'),nullif(j.payload->>'message_id','')::uuid) returning * into lead; end if;
 end if;
 if disposition='handoff' then
   insert into public.sms_handoffs(tenant_id,lead_id,contact_id,ai_job_id,reason,priority) values(j.tenant_id,lead.id,cid,j.id,coalesce(nullif(p->>'handoffReason',''),'Approved business knowledge did not support an answer.'),coalesce(p->>'priority','normal')) on conflict(tenant_id,contact_id) where status in ('open','assigned') do update set reason=excluded.reason,priority=excluded.priority,updated_at=now() returning id into handoff_id;
   select alert_phone into alert from public.sms_ai_settings where tenant_id=j.tenant_id and group_id=j.payload->>'group_id';
   if alert is not null and alert<>j.payload->>'phone' then begin perform sms_private.enqueue(j.tenant_id,'handoff_alert_jobs','handoff-alert:'||handoff_id,jsonb_build_object('handoff_id',handoff_id,'alert_phone',alert)); update public.sms_handoffs set alert_status='queued' where tenant_id=j.tenant_id and id=handoff_id; exception when others then update public.sms_handoffs set alert_status='failed',alert_error=left(sqlstate||':'||sqlerrm,500) where tenant_id=j.tenant_id and id=handoff_id; end; end if;
 end if;
 result:=sms_private.outbox(j.tenant_id,'ai:'||j.id,jsonb_build_object('phone',j.payload->>'phone','body',effective_reply,'purpose','transactional','category_id',nullif(j.payload->>'group_id',''),'conversation_generation',j.payload->'generation','ai_run_id',j.id));
 perform sms_private.finish(jid,token,'completed'); return result||jsonb_build_object('leadId',lead.id,'handoffId',handoff_id,'booking',booking);
end $$;

revoke all on function sms_private.record_webhook(text,text,jsonb),
  sms_private.complete_grounded_ai(uuid,uuid,jsonb)
  from public,anon,authenticated,sms_api,sms_webhook,sms_sender,sms_automation,sms_ai;
grant execute on function sms_private.record_webhook(text,text,jsonb) to sms_webhook;
grant execute on function sms_private.complete_grounded_ai(uuid,uuid,jsonb) to sms_ai;

-- Booking follow-ups also choose an actual group enrollment or the tenant
-- prompt. They never borrow the most recently edited group.
create or replace function sms_private.queue_booking_followups() returns integer
language plpgsql security definer set search_path='' as $$
#variable_conflict use_column
declare row record; gid text; jid uuid; n integer:=0;
begin
  if not (select scheduler_enabled from sms_private.runtime) then return 0; end if;
  for row in
    select s.*,c.phone,th.generation,settings.follow_up_interval_hours,settings.follow_up_max_attempts
    from public.sms_booking_sessions s
    join public.sms_booking_settings settings using(tenant_id)
    join public.sms_contacts c on c.tenant_id=s.tenant_id and c.id=s.contact_id
    join public.sms_thread_contacts th on th.tenant_id=s.tenant_id and th.phone=c.phone
    join public.sms_businesses b on b.tenant_id=s.tenant_id
    where settings.enabled and settings.follow_up_enabled and s.next_follow_up_at<=now()
      and s.expires_at>now() and s.follow_up_count<settings.follow_up_max_attempts
      and not c.opted_out and not th.ai_paused and b.status='active' and b.sending_enabled
    order by s.next_follow_up_at limit 100 for update of s skip locked
  loop
    gid:=null;
    select e.category_id into gid from public.sms_automation_enrollments e
      join public.sms_ai_settings a on a.tenant_id=e.tenant_id and a.group_id=e.category_id
      where e.tenant_id=row.tenant_id and e.contact_id=row.contact_id and e.status='active'
        and a.enabled and sms_private.automation_ai_configured(e.tenant_id,e.category_id)
      order by e.created_at desc,e.id desc limit 1;
    if gid is null and not exists (
      select 1 from public.sms_automation_enrollments e where e.tenant_id=row.tenant_id
        and e.contact_id=row.contact_id and e.status='active'
    ) and exists (
      select 1 from public.sms_business_ai_settings b where b.tenant_id=row.tenant_id and b.enabled
    ) then gid:=''; end if;
    if gid is null then continue; end if;
    jid:=sms_private.enqueue(row.tenant_id,'ai_reply_jobs',
      'booking-followup:'||row.contact_id||':'||(row.follow_up_count+1),
      jsonb_build_object('phone',row.phone,'generation',row.generation,'group_id',gid,
        'booking_follow_up',true,'follow_up_number',row.follow_up_count+1));
    update public.sms_booking_sessions set follow_up_count=follow_up_count+1,last_follow_up_at=now(),
      next_follow_up_at=case when follow_up_count+1>=row.follow_up_max_attempts then null
        else now()+make_interval(hours=>row.follow_up_interval_hours) end,updated_at=updated_at
      where tenant_id=row.tenant_id and contact_id=row.contact_id;
    n:=n+1;
  end loop;
  return n;
end $$;
revoke all on function sms_private.queue_booking_followups() from public,anon,authenticated,
  sms_api,sms_webhook,sms_sender,sms_ai,sms_automation;

