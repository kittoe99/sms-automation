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
   return (select jsonb_build_object('account_sid',p.account_sid,'messaging_service_sid',p.messaging_service_sid,
     'phone_number_sid',p.phone_number_sid,'state',p.provisioning_state,'business_name',b.name)
     from sms_private.providers p join public.sms_businesses b using(tenant_id) where p.tenant_id=j.tenant_id);
 end if;
 raise exception 'Unsupported context';
end $$;

create function sms_private.provision_credentials(jid uuid,token uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
#variable_conflict use_column
declare j sms_private.jobs;
begin
 j:=sms_private.lease(jid,token);
 if j.queue<>'provisioning_jobs' then raise exception 'Wrong queue'; end if;
 return (select jsonb_build_object('account_sid',p.account_sid,'auth_token',s.decrypted_secret,
   'messaging_service_sid',p.messaging_service_sid,'phone_number_sid',p.phone_number_sid,
   'state',p.provisioning_state,'business_name',b.name)
   from sms_private.providers p join public.sms_businesses b using(tenant_id)
   left join vault.decrypted_secrets s on s.id=p.auth_secret_id where p.tenant_id=j.tenant_id);
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
   parent_account_sid=coalesce(p->>'parent_account_sid',parent_account_sid),
   account_friendly_name=coalesce(p->>'account_friendly_name',account_friendly_name),
   messaging_service_sid=coalesce(p->>'messaging_service_sid',messaging_service_sid),
   phone_number_sid=coalesce(p->>'phone_number_sid',phone_number_sid),
   from_number=coalesce(p->>'from_number',from_number),
   provisioning_state=p->>'state',updated_at=now() where tenant_id=j.tenant_id;
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
   select a.group_id into gid from public.sms_ai_settings a
   where a.tenant_id=t and a.enabled and (a.default_for_inbound or exists(
     select from public.sms_automation_enrollments e where e.tenant_id=a.tenant_id and e.category_id=a.group_id and e.contact_id=c.id and e.status='active'
   )) order by exists(select from public.sms_automation_enrollments e where e.tenant_id=a.tenant_id and e.category_id=a.group_id and e.contact_id=c.id and e.status='active') desc,
     a.default_for_inbound desc,a.updated_at desc limit 1;
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
grant execute on function sms_private.api_action(text,text,text,jsonb),sms_private.api_read(text,text,text,jsonb),sms_private.configure_ai(text,text,text,boolean,text,boolean),sms_private.provider_setup(text,text),sms_private.save_provider_setup(text,text,jsonb),sms_private.queue_provision(text,text) to sms_api;
grant execute on function sms_private.webhook_credentials(text),sms_private.record_webhook(text,text,jsonb),sms_private.integration_credentials(text),sms_private.ingest_event(text,jsonb) to sms_webhook;
grant execute on function sms_private.claim(text,text),sms_private.extend_lease(uuid,uuid),sms_private.finish(uuid,uuid,text,text,integer) to sms_sender,sms_automation,sms_ai;
grant execute on function sms_private.begin_submission(uuid,uuid),sms_private.accept_submission(uuid,uuid,uuid,text) to sms_sender;
grant execute on function sms_private.job_context(uuid,uuid) to sms_automation,sms_ai;
grant execute on function sms_private.provision_credentials(uuid,uuid) to sms_automation;
grant execute on function sms_private.complete_automation(uuid,uuid,jsonb),sms_private.provision_checkpoint(uuid,uuid,jsonb) to sms_automation;
grant execute on function sms_private.complete_ai(uuid,uuid,text) to sms_ai;
select cron.schedule('sms-scheduler','30 seconds','select sms_private.tick()');
do $$ declare t text; begin
 if exists(select from pg_publication where pubname='supabase_realtime') then
   foreach t in array array['sms_messages','sms_thread_contacts','sms_automation_enrollments'] loop
     execute format('alter publication supabase_realtime add table public.%I',t);
   end loop;
 end if;
end $$;

