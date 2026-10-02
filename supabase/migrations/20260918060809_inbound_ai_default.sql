alter table public.sms_ai_settings
  add column default_for_inbound boolean not null default false,
  add constraint sms_ai_default_requires_enabled check (not default_for_inbound or enabled);

create unique index sms_one_default_inbound_ai_per_tenant
  on public.sms_ai_settings(tenant_id) where default_for_inbound;

create function sms_private.configure_ai(u text,t text,gid text,is_enabled boolean,instructions text,is_default boolean) returns jsonb
language plpgsql security definer set search_path='' as $$
#variable_conflict use_column
declare result public.sms_ai_settings; begin
 perform sms_private.require_admin(u);
 if not exists(select from public.sms_automation_groups where tenant_id=t and id=gid) then raise exception 'Unknown automation group'; end if;
 if length(coalesce(instructions,''))>6000 then raise exception 'AI instructions cannot exceed 6000 characters'; end if;
 is_default:=coalesce(is_default,false) and coalesce(is_enabled,false);
 if is_default then
   update public.sms_ai_settings set default_for_inbound=false,updated_at=now()
   where tenant_id=t and group_id<>gid and default_for_inbound;
 end if;
 insert into public.sms_ai_settings(tenant_id,group_id,enabled,instructions,default_for_inbound)
 values(t,gid,coalesce(is_enabled,false),coalesce(instructions,''),is_default)
 on conflict(tenant_id,group_id) do update set enabled=excluded.enabled,instructions=excluded.instructions,
   default_for_inbound=excluded.default_for_inbound,updated_at=now()
 returning * into result;
 update public.sms_thread_contacts set generation=generation+1 where tenant_id=t;
 return to_jsonb(result);
end $$;

create or replace function sms_private.record_webhook(t text,event text,p jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
#variable_conflict use_column
declare c public.sms_contacts; mid uuid; th public.sms_thread_contacts; gid text; a sms_private.attempts; j sms_private.jobs; s text; key text; begin
 key:=event||':'||coalesce(p->>'MessageSid',p->>'CallSid')||':'||coalesce(p->>'MessageStatus',p->>'CallStatus','inbound');
 insert into sms_private.webhook_events(tenant_id,event_key) values(t,key) on conflict do nothing;
 if not found then return jsonb_build_object('duplicate',true); end if;
 if event='inbound' then
   insert into public.sms_contacts(tenant_id,phone) values(t,p->>'From') on conflict do nothing;
   select * into strict c from public.sms_contacts where tenant_id=t and phone=p->>'From' for update;
   insert into public.sms_messages(tenant_id,sid,contact_phone,direction,body,status)
   values(t,p->>'MessageSid',c.phone,'inbound',coalesce(nullif(p->>'Body',''),'[Media message]'),'received') returning id into mid;
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
   select setting.group_id into gid from public.sms_ai_settings setting
   where setting.tenant_id=t and setting.enabled and (setting.default_for_inbound or exists(
     select from public.sms_automation_enrollments enrollment where enrollment.tenant_id=setting.tenant_id and enrollment.category_id=setting.group_id
       and enrollment.contact_id=c.id and enrollment.status='active'
   )) order by exists(
     select from public.sms_automation_enrollments enrollment where enrollment.tenant_id=setting.tenant_id and enrollment.category_id=setting.group_id
       and enrollment.contact_id=c.id and enrollment.status='active'
   ) desc,setting.default_for_inbound desc,setting.updated_at desc limit 1;
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

revoke all on function sms_private.configure_ai(text,text,text,boolean,text,boolean) from public,anon,authenticated,sms_api,sms_webhook,sms_sender,sms_automation,sms_ai;
grant execute on function sms_private.configure_ai(text,text,text,boolean,text,boolean) to sms_api;
