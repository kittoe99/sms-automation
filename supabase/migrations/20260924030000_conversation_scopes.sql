-- One general conversation and one conversation per automation group, per phone.
create table public.sms_conversations (
  tenant_id text not null,
  id uuid not null default gen_random_uuid(),
  phone text not null,
  group_id text,
  generation bigint not null default 0,
  ai_paused boolean not null default false,
  created_at timestamptz not null default now(),
  primary key (tenant_id,id),
  foreign key (tenant_id,phone) references public.sms_contacts(tenant_id,phone),
  foreign key (tenant_id,group_id) references public.sms_automation_groups(tenant_id,id)
);
create unique index sms_general_conversation on public.sms_conversations(tenant_id,phone)
  where group_id is null;
create unique index sms_group_conversation on public.sms_conversations(tenant_id,phone,group_id)
  where group_id is not null;
create index sms_conversations_phone on public.sms_conversations(tenant_id,phone);
alter table public.sms_conversations enable row level security;
create policy tenant_read on public.sms_conversations for select to authenticated
  using (sms_private.can_access(tenant_id));
grant select on public.sms_conversations to authenticated;

alter table public.sms_messages add column conversation_id uuid,
  add column provider_accepted_at timestamptz,
  add column read_at timestamptz;
alter table public.sms_thread_contacts add column route_override_conversation_id uuid,
  add column route_override_at timestamptz,
  add column route_override_expires_at timestamptz;

create function sms_private.ensure_conversation(t text,ph text,gid text default null) returns uuid
language plpgsql security definer set search_path='' as $$
declare result uuid; valid_gid text;
begin
  valid_gid:=nullif(gid,'');
  if valid_gid is not null and not exists (
    select 1 from public.sms_automation_groups where tenant_id=t and id=valid_gid
  ) then raise exception 'Unknown automation group' using errcode='22023'; end if;
  insert into public.sms_conversations(tenant_id,phone,group_id)
    values(t,ph,valid_gid) on conflict do nothing;
  select id into strict result from public.sms_conversations
    where tenant_id=t and phone=ph and group_id is not distinct from valid_gid;
  return result;
end $$;
revoke all on function sms_private.ensure_conversation(text,text,text)
  from public,anon,authenticated,sms_api,sms_webhook,sms_sender,sms_automation,sms_ai;

-- Conservative history: outbound group labels are explicit; old inbound intent is unknown.
insert into public.sms_conversations(tenant_id,phone)
  select distinct tenant_id,contact_phone from public.sms_messages on conflict do nothing;
insert into public.sms_conversations(tenant_id,phone,group_id)
  select distinct m.tenant_id,m.contact_phone,m.category_id from public.sms_messages m
  join public.sms_automation_groups g on g.tenant_id=m.tenant_id and g.id=m.category_id
  where m.direction='outbound' and m.category_id is not null on conflict do nothing;
update public.sms_messages m set conversation_id=c.id
  from public.sms_conversations c
  where c.tenant_id=m.tenant_id and c.phone=m.contact_phone
    and c.group_id=m.category_id and m.direction='outbound';
update public.sms_messages m set conversation_id=c.id
  from public.sms_conversations c
  where m.conversation_id is null and c.tenant_id=m.tenant_id
    and c.phone=m.contact_phone and c.group_id is null;
update public.sms_messages set provider_accepted_at=created_at
  where direction='outbound' and status in ('accepted','sent','delivered') and provider_accepted_at is null;
with ranked as (
  select m.tenant_id,m.id,row_number() over (
    partition by m.tenant_id,m.contact_phone order by m.created_at desc,m.id desc
  ) as unread_rank,coalesce(th.unread_count,0) as old_unread
  from public.sms_messages m left join public.sms_thread_contacts th
    on th.tenant_id=m.tenant_id and th.phone=m.contact_phone
  where m.direction='inbound'
)
update public.sms_messages m set read_at=now() from ranked r
  where m.tenant_id=r.tenant_id and m.id=r.id and r.unread_rank>r.old_unread;
alter table public.sms_messages alter column conversation_id set not null;
alter table public.sms_messages add constraint sms_message_conversation_fk
  foreign key(tenant_id,conversation_id) references public.sms_conversations(tenant_id,id);
alter table public.sms_thread_contacts add constraint sms_thread_route_override_fk
  foreign key(tenant_id,route_override_conversation_id) references public.sms_conversations(tenant_id,id);
create index sms_messages_conversation on public.sms_messages(tenant_id,conversation_id,created_at desc,id desc);
update public.sms_conversations c set ai_paused=th.ai_paused
  from public.sms_thread_contacts th where th.tenant_id=c.tenant_id and th.phone=c.phone;
update public.sms_thread_contacts set ai_paused=false where ai_paused;

create function sms_private.route_inbound_conversation(t text,ph text) returns uuid
language plpgsql security definer set search_path='' as $$
declare result uuid; override_id uuid; override_at timestamptz; expires_at timestamptz;
begin
  select route_override_conversation_id,route_override_at,route_override_expires_at
    into override_id,override_at,expires_at from public.sms_thread_contacts
    where tenant_id=t and phone=ph;
  if override_id is not null and expires_at>now() and not exists (
    select 1 from public.sms_messages m where m.tenant_id=t and m.contact_phone=ph
      and m.direction='outbound' and m.provider_accepted_at>override_at
  ) then return override_id; end if;
  select conversation_id into result from public.sms_messages
    where tenant_id=t and contact_phone=ph and direction='outbound'
      and provider_accepted_at>=now()-interval '7 days'
    order by provider_accepted_at desc,id desc limit 1;
  return coalesce(result,sms_private.ensure_conversation(t,ph,null));
end $$;
revoke all on function sms_private.route_inbound_conversation(text,text)
  from public,anon,authenticated,sms_api,sms_webhook,sms_sender,sms_automation,sms_ai;

create function sms_private.assign_message_conversation() returns trigger
language plpgsql security definer set search_path='' as $$
declare c public.sms_conversations;
begin
  if new.conversation_id is null then
    new.conversation_id:=case when new.direction='inbound'
      then sms_private.route_inbound_conversation(new.tenant_id,new.contact_phone)
      else sms_private.ensure_conversation(new.tenant_id,new.contact_phone,new.category_id) end;
  end if;
  select * into strict c from public.sms_conversations
    where tenant_id=new.tenant_id and id=new.conversation_id;
  if c.phone<>new.contact_phone or (new.direction='outbound' and
      c.group_id is distinct from new.category_id) then
    raise exception 'Message conversation does not match phone and group' using errcode='22023';
  end if;
  return new;
end $$;
create trigger sms_message_assign_conversation before insert on public.sms_messages
  for each row execute function sms_private.assign_message_conversation();

create function sms_private.conversation_message_changed() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  if tg_op='INSERT' and new.direction='inbound' then
    update public.sms_conversations set generation=generation+1
      where tenant_id=new.tenant_id and id=new.conversation_id;
  elsif tg_op='UPDATE' and new.direction='outbound'
    and old.provider_accepted_at is null and new.provider_accepted_at is not null then
    update public.sms_conversations set generation=generation+1
      where tenant_id=new.tenant_id and id=new.conversation_id;
  end if;
  return new;
end $$;
create trigger sms_conversation_message_insert after insert on public.sms_messages
  for each row execute function sms_private.conversation_message_changed();
create trigger sms_conversation_message_accept after update on public.sms_messages
  for each row when (old.provider_accepted_at is null and new.provider_accepted_at is not null)
  execute function sms_private.conversation_message_changed();
create function sms_private.mark_message_accepted() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  if new.direction='outbound' and old.provider_accepted_at is null and new.provider_accepted_at is null
    and new.status in ('accepted','sent','delivered') then new.provider_accepted_at:=now(); end if;
  return new;
end $$;
create trigger sms_message_accept_time before update of status on public.sms_messages
  for each row execute function sms_private.mark_message_accepted();
revoke all on function sms_private.assign_message_conversation(),
  sms_private.conversation_message_changed(),sms_private.mark_message_accepted()
  from public,anon,authenticated,sms_api,sms_webhook,sms_sender,sms_automation,sms_ai;

-- Old queued AI jobs carry only a phone and cannot be assigned safely.
update sms_private.jobs set status='cancelled',error_code='CONVERSATION_ID_REQUIRED',
  updated_at=now() where queue='ai_reply_jobs' and status in ('queued','retry','processing')
  and payload->>'conversation_id' is null;

create function sms_private.general_conversation(u text,t text,ph text) returns uuid
language plpgsql security definer set search_path='' as $$
begin
  if not sms_private.can_access(t,u) then raise exception 'Tenant access denied' using errcode='42501'; end if;
  if not exists(select 1 from public.sms_contacts where tenant_id=t and phone=ph) then return null; end if;
  return sms_private.ensure_conversation(t,ph,null);
end $$;

create function sms_private.list_conversation_threads(u text,t text,p jsonb default '{}') returns jsonb
language plpgsql security definer set search_path='' as $$
declare page_number integer; page_size integer; total_count bigint; unread_total bigint; rows jsonb; search_text text;
begin
  if not sms_private.can_access(t,u) then raise exception 'Tenant access denied' using errcode='42501'; end if;
  page_number:=greatest(1,least(100000,coalesce((p->>'page')::integer,1)));
  page_size:=greatest(1,least(250,coalesce((p->>'pageSize')::integer,50)));
  search_text:=nullif(btrim(p->>'q'),'');
  with matches as (
    select c.id,c.phone,c.group_id,c.ai_paused,c.generation,c.created_at,
      coalesce(nullif(contact.name,''),c.phone) as name,
      g.name as group_name,last_message.body as last_body,
      last_message.direction as last_direction,
      last_message.created_at as last_message_at,
      (select count(*) from public.sms_messages m where m.tenant_id=t
        and m.conversation_id=c.id and m.direction='inbound' and m.read_at is null)::integer as unread_count
    from public.sms_conversations c
    join public.sms_contacts contact on contact.tenant_id=c.tenant_id and contact.phone=c.phone
    left join public.sms_automation_groups g on g.tenant_id=c.tenant_id and g.id=c.group_id
    join lateral (select body,direction,created_at from public.sms_messages m
      where m.tenant_id=c.tenant_id and m.conversation_id=c.id
      order by created_at desc,id desc limit 1) last_message on true
    where c.tenant_id=t and (search_text is null or c.phone ilike '%'||search_text||'%'
      or contact.name ilike '%'||search_text||'%')
  ), filtered as (
    select * from matches where p->>'unread' is distinct from '1' or unread_count>0
  ), page_rows as (
    select * from filtered order by last_message_at desc,id
      limit page_size offset (page_number-1)*page_size
  )
  select (select count(*) from filtered),
    (select coalesce(sum(unread_count),0) from filtered),
    (select coalesce(jsonb_agg(to_jsonb(x) order by x.last_message_at desc,x.id),'[]'::jsonb)
      from page_rows x) into total_count,unread_total,rows;
  return jsonb_build_object('rows',rows,'total',total_count,'page',page_number,
    'pageSize',page_size,'unreadTotal',unread_total,
    'totalPages',greatest(1,ceil(total_count::numeric/page_size)));
end $$;

create function sms_private.conversation_detail(u text,t text,cid uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare c public.sms_conversations; result jsonb;
begin
  if not sms_private.can_access(t,u) then raise exception 'Tenant access denied' using errcode='42501'; end if;
  select * into c from public.sms_conversations where tenant_id=t and id=cid;
  if c.id is null then return null; end if;
  select to_jsonb(contact)||to_jsonb(c)||jsonb_build_object(
    'group_name',g.name,
    'unread_count',(select count(*) from public.sms_messages m where m.tenant_id=t
      and m.conversation_id=cid and m.direction='inbound' and m.read_at is null),
    'message_count',(select count(*) from public.sms_messages m where m.tenant_id=t and m.conversation_id=cid),
    'messages',(select coalesce(jsonb_agg(x order by x.created_at,x.id),'[]'::jsonb) from (
      select * from public.sms_messages m where m.tenant_id=t and m.conversation_id=cid
      order by m.created_at desc,m.id desc limit 250) x)
  ) into result from public.sms_contacts contact
    left join public.sms_automation_groups g on g.tenant_id=t and g.id=c.group_id
    where contact.tenant_id=t and contact.phone=c.phone;
  return result;
end $$;

create function sms_private.conversation_action(u text,t text,cid uuid,action text,p jsonb default '{}') returns jsonb
language plpgsql security definer set search_path='' as $$
declare c public.sms_conversations; result jsonb;
begin
  perform sms_private.require_admin(u);
  select * into strict c from public.sms_conversations where tenant_id=t and id=cid for update;
  if action='read' then
    update public.sms_messages set read_at=now() where tenant_id=t and conversation_id=cid
      and direction='inbound' and read_at is null;
    return jsonb_build_object('ok',true);
  elsif action in ('pause','resume') then
    update public.sms_conversations set ai_paused=(action='pause'),generation=generation+1
      where tenant_id=t and id=cid;
    update public.sms_thread_contacts set generation=generation+1 where tenant_id=t and phone=c.phone;
    return jsonb_build_object('ok',true);
  elsif action='reply' then
    if nullif(btrim(p->>'body'),'') is null then raise exception 'Message body required' using errcode='22023'; end if;
    return sms_private.api_action(u,t,'send',jsonb_build_object(
      'phone',c.phone,'body',btrim(p->>'body'),'purpose','transactional',
      'category_id',c.group_id,'idempotencyKey',p->>'idempotencyKey'));
  end if;
  raise exception 'Unknown conversation action' using errcode='22023';
end $$;

create function sms_private.reassign_inbound_message(u text,t text,mid uuid,gid text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare m public.sms_messages; target_id uuid; ai_job_id uuid;
begin
  perform sms_private.require_admin(u);
  select * into strict m from public.sms_messages where tenant_id=t and id=mid for update;
  if m.direction<>'inbound' then raise exception 'Only inbound messages can be reassigned' using errcode='22023'; end if;
  target_id:=sms_private.ensure_conversation(t,m.contact_phone,gid);
  if target_id=m.conversation_id then return jsonb_build_object('conversationId',target_id,'changed',false); end if;
  select id into ai_job_id from sms_private.jobs where tenant_id=t and queue='ai_reply_jobs'
    and dedupe_key=m.sid order by created_at desc limit 1;
  if ai_job_id is not null then
    update sms_private.jobs set status='cancelled',error_code='MESSAGE_REASSIGNED',updated_at=now()
      where id=ai_job_id and status in ('queued','retry','processing');
    update public.sms_messages set status='cancelled',updated_at=now()
      where tenant_id=t and direction='outbound' and status='queued' and id in (
        select (j.payload->>'message_id')::uuid from sms_private.jobs j
        where j.tenant_id=t and j.queue='sms_send_jobs'
          and j.payload->'request'->>'ai_run_id'=ai_job_id::text
      );
    update sms_private.jobs set status='cancelled',error_code='MESSAGE_REASSIGNED',updated_at=now()
      where tenant_id=t and queue='sms_send_jobs' and status in ('queued','retry','processing')
        and payload->'request'->>'ai_run_id'=ai_job_id::text;
  end if;
  update public.sms_messages set conversation_id=target_id where tenant_id=t and id=mid;
  update public.sms_conversations set generation=generation+1
    where tenant_id=t and id in (m.conversation_id,target_id);
  update public.sms_thread_contacts set generation=generation+1,
    route_override_conversation_id=target_id,route_override_at=now(),
    route_override_expires_at=now()+interval '7 days'
    where tenant_id=t and phone=m.contact_phone;
  insert into sms_private.audit(tenant_id,actor,action,detail) values
    (t,u,'inbound_message_reassigned',jsonb_build_object('messageId',mid,
      'fromConversationId',m.conversation_id,'toConversationId',target_id));
  return jsonb_build_object('conversationId',target_id,'changed',true);
end $$;
revoke all on function sms_private.general_conversation(text,text,text),
  sms_private.list_conversation_threads(text,text,jsonb),sms_private.conversation_detail(text,text,uuid),
  sms_private.conversation_action(text,text,uuid,text,jsonb),
  sms_private.reassign_inbound_message(text,text,uuid,text)
  from public,anon,authenticated,sms_api,sms_webhook,sms_sender,sms_automation,sms_ai;
grant execute on function sms_private.general_conversation(text,text,text),
  sms_private.list_conversation_threads(text,text,jsonb),sms_private.conversation_detail(text,text,uuid),
  sms_private.conversation_action(text,text,uuid,text,jsonb),
  sms_private.reassign_inbound_message(text,text,uuid,text) to sms_api;

alter function sms_private.api_read(text,text,text,jsonb) rename to api_read_before_conversations;
revoke all on function sms_private.api_read_before_conversations(text,text,text,jsonb)
  from public,anon,authenticated,sms_api,sms_webhook,sms_sender,sms_automation,sms_ai;
create function sms_private.api_read(u text,t text,resource text,p jsonb default '{}') returns jsonb
language plpgsql security definer set search_path='' as $$
declare base jsonb; thread_count bigint;
begin
  base:=sms_private.api_read_before_conversations(u,t,resource,p);
  if resource<>'overview' then return base; end if;
  select count(*) into thread_count from public.sms_conversations c
    where c.tenant_id=t and exists (select 1 from public.sms_messages m
      where m.tenant_id=c.tenant_id and m.conversation_id=c.id);
  return base||jsonb_build_object('conversationCount',thread_count);
end $$;
revoke all on function sms_private.api_read(text,text,text,jsonb)
  from public,anon,authenticated,sms_api,sms_webhook,sms_sender,sms_automation,sms_ai;
grant execute on function sms_private.api_read_before_conversations(text,text,text,jsonb),
  sms_private.api_read(text,text,text,jsonb) to sms_api;

alter function sms_private.job_context(uuid,uuid) rename to job_context_before_conversations;
revoke all on function sms_private.job_context_before_conversations(uuid,uuid)
  from public,anon,authenticated,sms_api,sms_webhook,sms_sender,sms_automation,sms_ai;
create function sms_private.job_context(jid uuid,token uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare base jsonb; j sms_private.jobs; c public.sms_conversations; ph text;
  chosen uuid; recent_history jsonb; request_record jsonb;
begin
  base:=sms_private.job_context_before_conversations(jid,token);
  select * into strict j from sms_private.jobs where id=jid;
  if j.queue='automation_jobs' then
    ph:=base->'contact'->>'phone';
    chosen:=sms_private.ensure_conversation(j.tenant_id,ph,base->'group'->>'id');
  elsif j.queue='ai_reply_jobs' then
    if nullif(j.payload->>'conversation_id','') is null then
      raise exception 'Conversation ID required for AI context' using errcode='22023';
    end if;
    chosen:=(j.payload->>'conversation_id')::uuid;
    ph:=j.payload->>'phone';
  else return base; end if;
  select * into strict c from public.sms_conversations
    where tenant_id=j.tenant_id and id=chosen and phone=ph;
  select coalesce(jsonb_agg(x order by x.created_at,x.id),'[]'::jsonb) into recent_history
    from (select id,direction,body,created_at from public.sms_messages
      where tenant_id=j.tenant_id and conversation_id=chosen
      order by created_at desc,id desc limit 40) x;
  if j.queue='automation_jobs' then
    base:=base-'history';
    if c.group_id<>'quote-requests' then base:=base-'quote'; end if;
    if c.group_id<>'bookings' then base:=base-'booking'; end if;
    return base||jsonb_build_object('conversation',to_jsonb(c),'history',recent_history);
  end if;
  if c.group_id is distinct from nullif(j.payload->>'group_id','') then
    raise exception 'AI job conversation group mismatch' using errcode='22023';
  end if;
  if c.group_id='quote-requests' then
    select to_jsonb(i) into request_record from public.sms_automation_enrollments e
      join public.sms_automation_quote_requests i on i.tenant_id=e.tenant_id and i.id=e.source_id
      join public.sms_contacts contact on contact.tenant_id=e.tenant_id and contact.id=e.contact_id
      where e.tenant_id=j.tenant_id and e.category_id=c.group_id and contact.phone=ph
        and e.source_type='quote_requests'
      order by e.created_at desc,e.id desc limit 1;
  end if;
  base:=base||jsonb_build_object('conversation',to_jsonb(c),'history',recent_history);
  if c.group_id is not null then
    base:=(base-'open_lead')||jsonb_build_object('active_request',request_record);
    if c.group_id<>'bookings' then
      base:=base-'recent_booking'-'booking_session';
    end if;
  end if;
  return base;
end $$;
revoke all on function sms_private.job_context(uuid,uuid)
  from public,anon,authenticated,sms_api,sms_webhook,sms_sender,sms_automation,sms_ai;
grant execute on function sms_private.job_context_before_conversations(uuid,uuid),
  sms_private.job_context(uuid,uuid) to sms_ai,sms_automation;

alter function sms_private.record_webhook(text,text,jsonb) rename to record_webhook_before_conversations;
revoke all on function sms_private.record_webhook_before_conversations(text,text,jsonb)
  from public,anon,authenticated,sms_api,sms_webhook,sms_sender,sms_automation,sms_ai;
create function sms_private.record_webhook(t text,event text,p jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare result jsonb; m public.sms_messages; c public.sms_conversations;
  th public.sms_thread_contacts; contact public.sms_contacts; j sms_private.jobs; allowed boolean;
begin
  result:=sms_private.record_webhook_before_conversations(t,event,p);
  if event<>'inbound' or coalesce((result->>'duplicate')::boolean,false)
    or coalesce((result->>'consent_event')::boolean,false) then return result; end if;
  select * into strict m from public.sms_messages where tenant_id=t and sid=p->>'MessageSid';
  select * into strict c from public.sms_conversations where tenant_id=t and id=m.conversation_id;
  select * into strict th from public.sms_thread_contacts where tenant_id=t and phone=m.contact_phone;
  select * into strict contact from public.sms_contacts where tenant_id=t and phone=m.contact_phone;
  select * into j from sms_private.jobs where tenant_id=t and queue='ai_reply_jobs'
    and dedupe_key=p->>'MessageSid' for update;
  allowed:=not th.ai_paused and not c.ai_paused and not contact.opted_out and
    (case when c.group_id is null then exists (
      select 1 from public.sms_business_ai_settings b where b.tenant_id=t and b.enabled
        and nullif(btrim(b.system_prompt),'') is not null)
    else exists (
      select 1 from public.sms_ai_settings a where a.tenant_id=t and a.group_id=c.group_id
        and a.enabled) and sms_private.automation_ai_configured(t,c.group_id) end);
  if not allowed then
    if j.id is not null then update sms_private.jobs set status='cancelled',
      error_code='CONVERSATION_AI_DISABLED',updated_at=now() where id=j.id
      and status in ('queued','retry','processing'); end if;
    return result;
  end if;
  if j.id is null then
    perform sms_private.enqueue(t,'ai_reply_jobs',p->>'MessageSid',jsonb_build_object(
      'phone',m.contact_phone,'generation',th.generation,'group_id',coalesce(c.group_id,''),
      'conversation_id',c.id,'conversation_generation',c.generation,'message_id',m.id));
  else
    update sms_private.jobs set payload=payload||jsonb_build_object(
      'phone',m.contact_phone,'generation',th.generation,'group_id',coalesce(c.group_id,''),
      'conversation_id',c.id,'conversation_generation',c.generation,'message_id',m.id),
      updated_at=now() where id=j.id and status in ('queued','retry');
  end if;
  return result;
end $$;
revoke all on function sms_private.record_webhook(text,text,jsonb)
  from public,anon,authenticated,sms_api,sms_webhook,sms_sender,sms_automation,sms_ai;
grant execute on function sms_private.record_webhook_before_conversations(text,text,jsonb),
  sms_private.record_webhook(text,text,jsonb) to sms_webhook;

alter function sms_private.outbox(text,text,jsonb) rename to outbox_before_conversations;
revoke all on function sms_private.outbox_before_conversations(text,text,jsonb)
  from public,anon,authenticated,sms_api,sms_webhook,sms_sender,sms_automation,sms_ai;
create function sms_private.outbox(t text,k text,p jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare result jsonb; actual_id uuid;
begin
  result:=sms_private.outbox_before_conversations(t,k,p);
  if nullif(p->>'conversation_id','') is not null then
    select conversation_id into strict actual_id from public.sms_messages
      where tenant_id=t and id=(result->>'messageId')::uuid;
    if actual_id<>(p->>'conversation_id')::uuid then
      raise exception 'Outbound conversation mismatch' using errcode='22023';
    end if;
  end if;
  return result;
end $$;
revoke all on function sms_private.outbox(text,text,jsonb)
  from public,anon,authenticated,sms_api,sms_webhook,sms_sender,sms_automation,sms_ai;
grant execute on function sms_private.outbox_before_conversations(text,text,jsonb),
  sms_private.outbox(text,text,jsonb) to sms_api,sms_automation,sms_ai,sms_sender;

alter function sms_private.complete_automation(uuid,uuid,jsonb) rename to complete_automation_before_conversations;
revoke all on function sms_private.complete_automation_before_conversations(uuid,uuid,jsonb)
  from public,anon,authenticated,sms_api,sms_webhook,sms_sender,sms_automation,sms_ai;
create function sms_private.complete_automation(jid uuid,token uuid,p jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare j sms_private.jobs; e public.sms_automation_enrollments;
  c public.sms_conversations; ph text;
begin
  if p->>'action'='send' and p->>'ai_drafted'='true' then
    j:=sms_private.lease(jid,token);
    select * into strict e from public.sms_automation_enrollments
      where tenant_id=j.tenant_id and id=(j.payload->>'enrollment_id')::uuid;
    select phone into strict ph from public.sms_contacts where tenant_id=j.tenant_id and id=e.contact_id;
    select * into strict c from public.sms_conversations where tenant_id=j.tenant_id
      and id=(p->>'conversation_id')::uuid and phone=ph and group_id=e.category_id for update;
    if c.generation<>(p->>'scope_generation')::bigint then
      raise exception 'Conversation changed during AI draft' using errcode='40001';
    end if;
  end if;
  return sms_private.complete_automation_before_conversations(jid,token,p);
end $$;
revoke all on function sms_private.complete_automation(uuid,uuid,jsonb)
  from public,anon,authenticated,sms_api,sms_webhook,sms_sender,sms_automation,sms_ai;
grant execute on function sms_private.complete_automation_before_conversations(uuid,uuid,jsonb),
  sms_private.complete_automation(uuid,uuid,jsonb) to sms_automation;

alter function sms_private.begin_submission(uuid,uuid) rename to begin_submission_before_conversations;
revoke all on function sms_private.begin_submission_before_conversations(uuid,uuid)
  from public,anon,authenticated,sms_api,sms_webhook,sms_sender,sms_automation,sms_ai;
create function sms_private.begin_submission(jid uuid,token uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare j sms_private.jobs; request_payload jsonb;
begin
  j:=sms_private.lease(jid,token);
  request_payload:=j.payload->'request';
  if j.queue='sms_send_jobs' and nullif(request_payload->>'scope_generation','') is not null
    and not exists (select 1 from public.sms_conversations c where c.tenant_id=j.tenant_id
      and c.id=(request_payload->>'conversation_id')::uuid
      and c.phone=request_payload->>'phone' and not c.ai_paused
      and c.generation=(request_payload->>'scope_generation')::bigint) then
    perform sms_private.finish(jid,token,'cancelled','STALE_CONVERSATION');
    return null;
  end if;
  return sms_private.begin_submission_before_conversations(jid,token);
end $$;
revoke all on function sms_private.begin_submission(uuid,uuid)
  from public,anon,authenticated,sms_api,sms_webhook,sms_sender,sms_automation,sms_ai;
grant execute on function sms_private.begin_submission_before_conversations(uuid,uuid),
  sms_private.begin_submission(uuid,uuid) to sms_sender;

-- Completion accepts a completed enrollment when this inbound was routed to
-- its group conversation, but always checks both conversation and phone fences.
create or replace function sms_private.complete_grounded_ai(jid uuid,token uuid,p jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
#variable_conflict use_column
declare j sms_private.jobs; cid uuid; mid uuid; lead public.sms_leads; handoff_id uuid; result jsonb; alert text; disposition text; booking jsonb; effective_reply text;
begin
 j:=sms_private.lease(jid,token); if j.queue<>'ai_reply_jobs' then raise exception 'Wrong queue'; end if;
 if nullif(j.payload->>'conversation_id','') is null or not exists (
   select 1 from public.sms_thread_contacts th
   join public.sms_contacts contact on contact.tenant_id=th.tenant_id and contact.phone=th.phone
   join public.sms_conversations conversation on conversation.tenant_id=th.tenant_id
     and conversation.phone=th.phone and conversation.id=(j.payload->>'conversation_id')::uuid
   left join public.sms_messages inbound on inbound.tenant_id=th.tenant_id
     and inbound.id=nullif(j.payload->>'message_id','')::uuid
     and inbound.conversation_id=conversation.id and inbound.direction='inbound'
   where th.tenant_id=j.tenant_id and th.phone=j.payload->>'phone'
     and th.generation=(j.payload->>'generation')::bigint and not th.ai_paused
     and not contact.opted_out and not conversation.ai_paused
     and conversation.generation=(j.payload->>'conversation_generation')::bigint
     and conversation.group_id is not distinct from nullif(j.payload->>'group_id','')
     and conversation.id=sms_private.route_inbound_conversation(j.tenant_id,th.phone)
     and (coalesce((j.payload->>'booking_follow_up')::boolean,false) or inbound.id is not null)
 ) or not (case when nullif(j.payload->>'group_id','') is null then exists (
   select 1 from public.sms_business_ai_settings b where b.tenant_id=j.tenant_id
     and b.enabled and nullif(btrim(b.system_prompt),'') is not null)
   else exists(select 1 from public.sms_ai_settings a where a.tenant_id=j.tenant_id
     and a.group_id=j.payload->>'group_id' and a.enabled)
     and sms_private.automation_ai_configured(j.tenant_id,j.payload->>'group_id') end)
 then perform sms_private.finish(jid,token,'cancelled','STALE_CONVERSATION'); return null; end if;
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
 result:=sms_private.outbox(j.tenant_id,'ai:'||j.id,jsonb_build_object('phone',j.payload->>'phone','body',effective_reply,'purpose','transactional','category_id',nullif(j.payload->>'group_id',''),'conversation_id',j.payload->>'conversation_id','conversation_generation',j.payload->'generation','scope_generation',j.payload->'conversation_generation','ai_run_id',j.id));
 perform sms_private.finish(jid,token,'completed'); return result||jsonb_build_object('leadId',lead.id,'handoffId',handoff_id,'booking',booking);
end $$;
revoke all on function sms_private.complete_grounded_ai(uuid,uuid,jsonb)
  from public,anon,authenticated,sms_api,sms_webhook,sms_sender,sms_automation,sms_ai;
grant execute on function sms_private.complete_grounded_ai(uuid,uuid,jsonb) to sms_ai;

create or replace function sms_private.queue_booking_followups() returns integer
language plpgsql security definer set search_path='' as $$
#variable_conflict use_column
declare row record; c public.sms_conversations; can_reply boolean; jid uuid; n integer:=0;
begin
  if not (select scheduler_enabled from sms_private.runtime) then return 0; end if;
  for row in
    select s.*,contact.phone,th.generation,settings.follow_up_interval_hours,
      settings.follow_up_max_attempts
    from public.sms_booking_sessions s
    join public.sms_booking_settings settings using(tenant_id)
    join public.sms_contacts contact on contact.tenant_id=s.tenant_id and contact.id=s.contact_id
    join public.sms_thread_contacts th on th.tenant_id=s.tenant_id and th.phone=contact.phone
    join public.sms_businesses b on b.tenant_id=s.tenant_id
    where settings.enabled and settings.follow_up_enabled and s.next_follow_up_at<=now()
      and s.expires_at>now() and s.follow_up_count<settings.follow_up_max_attempts
      and not contact.opted_out and not th.ai_paused and b.status='active' and b.sending_enabled
    order by s.next_follow_up_at limit 100 for update of s skip locked
  loop
    select * into c from public.sms_conversations where tenant_id=row.tenant_id
      and id=sms_private.route_inbound_conversation(row.tenant_id,row.phone);
    can_reply:=not c.ai_paused and case when c.group_id is null then exists (
      select 1 from public.sms_business_ai_settings b where b.tenant_id=row.tenant_id and b.enabled)
      else exists(select 1 from public.sms_ai_settings a where a.tenant_id=row.tenant_id
        and a.group_id=c.group_id and a.enabled)
        and sms_private.automation_ai_configured(row.tenant_id,c.group_id) end;
    if not can_reply then continue; end if;
    jid:=sms_private.enqueue(row.tenant_id,'ai_reply_jobs',
      'booking-followup:'||row.contact_id||':'||(row.follow_up_count+1),
      jsonb_build_object('phone',row.phone,'generation',row.generation,
        'group_id',coalesce(c.group_id,''),'conversation_id',c.id,
        'conversation_generation',c.generation,'booking_follow_up',true,
        'follow_up_number',row.follow_up_count+1));
    update public.sms_booking_sessions set follow_up_count=follow_up_count+1,
      last_follow_up_at=now(),next_follow_up_at=case when follow_up_count+1>=row.follow_up_max_attempts
        then null else now()+make_interval(hours=>row.follow_up_interval_hours) end,
      updated_at=now() where tenant_id=row.tenant_id and contact_id=row.contact_id;
    n:=n+1;
  end loop;
  return n;
end $$;
revoke all on function sms_private.queue_booking_followups() from public,anon,authenticated,
  sms_api,sms_webhook,sms_sender,sms_ai,sms_automation;

