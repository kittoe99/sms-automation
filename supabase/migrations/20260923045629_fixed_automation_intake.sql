-- Four fixed, table-triggered SMS automation entry points. Existing CRM and
-- website tables remain operational and historical rows are never backfilled.
do $$ begin
  if exists(select 1 from sms_private.edge_config where queue='automation_jobs' and enabled)
     or exists(select 1 from sms_private.jobs where queue='automation_jobs'
       and status='processing' and leased_until>now()) then
    raise exception 'Disable and drain automation_jobs before changing intake routing';
  end if;
end $$;

alter table public.sms_automation_groups add column fixed_type text
  check(fixed_type in ('contacts','quote_requests','bookings','reviews'));
alter table public.sms_automation_groups drop constraint if exists sms_automation_groups_kind_check;
alter table public.sms_automation_groups add constraint sms_automation_groups_kind_check
  check(kind in ('contact','quote','reminder','review','custom'));
create unique index sms_one_fixed_group_per_type on public.sms_automation_groups(tenant_id,fixed_type)
  where fixed_type is not null;
update public.sms_automation_groups set fixed_type='quote_requests',name='Quote Request'
  where kind='quote';
update public.sms_automation_groups set fixed_type='bookings',name='Bookings'
  where kind='reminder';
update public.sms_automation_groups set active=false,version=version+1
  where kind='custom' and active;
update public.sms_automation_enrollments e set status='paused',generation=generation+1,next_run_at=null,
  pause_reason='LEGACY_GROUP_RETIRED',paused_at=now()
  where status in ('active','paused') and exists(select 1 from public.sms_automation_groups g
    where g.tenant_id=e.tenant_id and g.id=e.category_id and g.kind='custom');

create function sms_private.seed_fixed_automation_groups(t text) returns void
language plpgsql security definer set search_path='' as $$
begin
  insert into public.sms_automation_groups(tenant_id,id,name,description,kind,fixed_type,rule)
  values
    (t,'sms-contact','Contact','New SMS lead follow-up','contact','contacts',
      '{"anchor":"enrollment","firstDelayCount":1,"firstDelayUnit":"day","intervalCount":1,"intervalUnit":"day","repeatCount":1,"leadHours":null,"startHour":9,"endHour":19}'::jsonb),
    (t,'quote-requests','Quote Request','Follow up on a quote inquiry','quote','quote_requests',
      '{"anchor":"enrollment","firstDelayCount":1,"firstDelayUnit":"day","intervalCount":2,"intervalUnit":"day","repeatCount":6,"leadHours":null,"startHour":9,"endHour":19}'::jsonb),
    (t,'appointment-reminders','Bookings','Confirmed appointment reminder','reminder','bookings',
      '{"anchor":"appointment","firstDelayCount":0,"firstDelayUnit":"day","intervalCount":6,"intervalUnit":"hour","repeatCount":1,"leadHours":24,"startHour":0,"endHour":24}'::jsonb),
    (t,'sms-review','Reviews','Post-service feedback request','review','reviews',
      '{"anchor":"enrollment","firstDelayCount":1,"firstDelayUnit":"day","intervalCount":1,"intervalUnit":"day","repeatCount":1,"leadHours":null,"startHour":9,"endHour":19}'::jsonb)
  on conflict(tenant_id,id) do nothing;
  insert into public.sms_automation_intents(tenant_id,group_id,intent)
  select t,g.id,case g.fixed_type
    when 'contacts' then 'Help the customer take the next useful step with their new inquiry. Acknowledge what they asked for without assuming a quote or booking exists.'
    when 'quote_requests' then 'Acknowledge the quote request, clarify any missing details, and help the customer toward an estimate or decision. Never claim a quote was issued unless the record or conversation confirms it.'
    when 'bookings' then 'Remind the customer of their confirmed appointment using its actual local date and time, and invite a reply if rescheduling is needed.'
    when 'reviews' then 'Ask about the completed service and invite honest feedback. Use an approved review URL if supplied; otherwise invite a reply. Do not assume satisfaction.' end
  from public.sms_automation_groups g where g.tenant_id=t and g.fixed_type is not null
  on conflict(tenant_id,group_id) do nothing;
end $$;
create function sms_private.seed_fixed_automation_groups_on_business() returns trigger
language plpgsql security definer set search_path='' as $$
begin perform sms_private.seed_fixed_automation_groups(new.tenant_id); return new; end $$;
create trigger sms_seed_fixed_groups after insert on public.sms_businesses
  for each row execute function sms_private.seed_fixed_automation_groups_on_business();
do $$ declare business record; begin
  for business in select tenant_id from public.sms_businesses loop
    perform sms_private.seed_fixed_automation_groups(business.tenant_id);
  end loop;
end $$;
update public.sms_automation_intents i set
  intent='Acknowledge the quote request, clarify any missing details, and help the customer toward an estimate or decision. Never claim a quote was issued unless the record or conversation confirms it.',
  updated_at=now()
from public.sms_automation_groups g
where g.tenant_id=i.tenant_id and g.id=i.group_id and g.fixed_type='quote_requests'
  and i.intent='Follow up on the customer quote, answer relevant questions, and help with the next decision without implying acceptance or a confirmed booking.';

-- A request is separate from the shared contact or operational booking.
create table public.sms_automation_contacts (
  tenant_id text not null references public.sms_businesses(tenant_id), id uuid not null default gen_random_uuid(),
  name text not null default '', phone text, details jsonb not null default '{}'::jsonb check(jsonb_typeof(details)='object'),
  source text not null default 'staff', source_record_id text,
  intake_state text not null default 'pending' check(intake_state in ('pending','enrolled','skipped','waiting_confirmation','cancelled')),
  skip_reason text, enrollment_id uuid, created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  primary key(tenant_id,id));
create table public.sms_automation_quote_requests (like public.sms_automation_contacts including defaults including constraints);
create table public.sms_automation_bookings (like public.sms_automation_contacts including defaults including constraints);
create table public.sms_automation_reviews (like public.sms_automation_contacts including defaults including constraints);
alter table public.sms_automation_bookings add column status text not null default 'requested'
  check(status in ('requested','confirmed','cancelled'));
alter table public.sms_automation_bookings add column appointment_at timestamptz;
do $$ declare table_name text; begin
  foreach table_name in array array['sms_automation_quote_requests','sms_automation_bookings','sms_automation_reviews'] loop
    execute format('alter table public.%I add primary key(tenant_id,id)',table_name);
    execute format('alter table public.%I add foreign key(tenant_id) references public.sms_businesses(tenant_id)',table_name);
  end loop;
end $$;
create unique index sms_automation_contacts_source on public.sms_automation_contacts(tenant_id,source,source_record_id) where source_record_id is not null;
create unique index sms_automation_quote_requests_source on public.sms_automation_quote_requests(tenant_id,source,source_record_id) where source_record_id is not null;
create unique index sms_automation_bookings_source on public.sms_automation_bookings(tenant_id,source,source_record_id) where source_record_id is not null;
create unique index sms_automation_reviews_source on public.sms_automation_reviews(tenant_id,source,source_record_id) where source_record_id is not null;
alter table public.sms_automation_enrollments add column source_type text
  check(source_type in ('contacts','quote_requests','bookings','reviews'));
alter table public.sms_automation_enrollments add column source_id uuid;
create index sms_enrollments_source on public.sms_automation_enrollments(tenant_id,source_type,source_id);

create function sms_private.route_automation_intake() returns trigger
language plpgsql security definer set search_path='' as $$
#variable_conflict use_column
declare typ text; c public.sms_contacts; g public.sms_automation_groups;
  tz text; due_at timestamptz; appointment timestamptz; new_enrollment uuid;
begin
  typ:=case tg_table_name
    when 'sms_automation_contacts' then 'contacts'
    when 'sms_automation_quote_requests' then 'quote_requests'
    when 'sms_automation_bookings' then 'bookings'
    when 'sms_automation_reviews' then 'reviews' end;
  if typ is null then raise exception 'Unknown SMS intake table'; end if;
  if tg_op='UPDATE' and (new.tenant_id<>old.tenant_id or new.id<>old.id) then
    raise exception 'Intake identity cannot change';
  end if;
  if tg_op='UPDATE' then
    if typ='bookings' then
      if new.name is not distinct from old.name and new.phone is not distinct from old.phone
         and new.details is not distinct from old.details and new.status is not distinct from old.status
         and new.appointment_at is not distinct from old.appointment_at then return new; end if;
    end if;
  end if;
  if tg_op='UPDATE' and old.enrollment_id is not null then
    update public.sms_automation_enrollments set status='cancelled',generation=generation+1,next_run_at=null
      where tenant_id=old.tenant_id and id=old.enrollment_id and status in ('active','paused');
  end if;
  new.enrollment_id:=null; new.skip_reason:=null; new.updated_at:=now();
  if new.phone is null or new.phone !~ '^\+[1-9][0-9]{7,14}$' then
    new.intake_state:='skipped'; new.skip_reason:='INVALID_PHONE'; return new;
  end if;
  insert into public.sms_contacts(tenant_id,phone,name,source)
    values(new.tenant_id,new.phone,coalesce(new.name,''),'automation_intake')
    on conflict(tenant_id,phone) do update set
      name=case when excluded.name<>'' then excluded.name else sms_contacts.name end,
      updated_at=now();
  select * into strict c from public.sms_contacts where tenant_id=new.tenant_id and phone=new.phone for update;
  select * into g from public.sms_automation_groups
    where tenant_id=new.tenant_id and fixed_type=typ for update;
  if g.id is not null then
    update public.sms_automation_enrollments set status='cancelled',generation=generation+1,next_run_at=null
      where tenant_id=new.tenant_id and contact_id=c.id and category_id=g.id and status in ('active','paused');
  end if;
  if typ='quote_requests' then
    update public.sms_automation_enrollments e set status='cancelled',generation=generation+1,next_run_at=null
      where e.tenant_id=new.tenant_id and e.contact_id=c.id and e.status in ('active','paused')
        and exists(select 1 from public.sms_automation_groups x where x.tenant_id=e.tenant_id and x.id=e.category_id and x.fixed_type='contacts');
  elsif typ='bookings' then
    if new.status='confirmed' then
      update public.sms_automation_enrollments e set status='cancelled',generation=generation+1,next_run_at=null
        where e.tenant_id=new.tenant_id and e.contact_id=c.id and e.status in ('active','paused')
          and exists(select 1 from public.sms_automation_groups x where x.tenant_id=e.tenant_id and x.id=e.category_id and x.fixed_type in ('contacts','quote_requests'));
    end if;
  elsif typ='reviews' then
    update public.sms_automation_enrollments e set status='cancelled',generation=generation+1,next_run_at=null
      where e.tenant_id=new.tenant_id and e.contact_id=c.id and e.status in ('active','paused')
        and exists(select 1 from public.sms_automation_groups x where x.tenant_id=e.tenant_id and x.id=e.category_id and x.fixed_type='bookings');
  end if;
  if typ='bookings' then
    if new.status='cancelled' then new.intake_state:='cancelled'; return new; end if;
    if new.status='requested' then new.intake_state:='waiting_confirmation'; return new; end if;
    appointment:=new.appointment_at;
    if appointment is null or appointment<=now() then
      new.intake_state:='skipped'; new.skip_reason:='FUTURE_APPOINTMENT_REQUIRED'; return new;
    end if;
  end if;
  if c.opted_out then new.intake_state:='skipped'; new.skip_reason:='OPTED_OUT'; return new; end if;
  if typ<>'bookings' and not c.marketing_consent then
    new.intake_state:='skipped'; new.skip_reason:='CONSENT_REQUIRED'; return new;
  end if;
  if g.id is null or not g.active or not exists(select 1 from public.sms_automation_intents i
    where i.tenant_id=new.tenant_id and i.group_id=g.id and btrim(i.intent)<>'') then
    new.intake_state:='skipped'; new.skip_reason:='RULE_UNAVAILABLE'; return new;
  end if;
  select time_zone into tz from public.sms_businesses where tenant_id=new.tenant_id;
  due_at:=sms_private.automation_due(case when typ='bookings' then appointment else now() end,g.rule,tz,true);
  insert into public.sms_automation_enrollments
    (tenant_id,contact_id,category_id,appointment_at,next_run_at,metadata,source_type,source_id)
    values(new.tenant_id,c.id,g.id,appointment,due_at,
      jsonb_build_object('intake_type',typ,'intake_id',new.id,'source',new.source)
      || case when typ='bookings' and new.source_record_id is not null
        then jsonb_build_object('booking_id',new.source_record_id) else '{}'::jsonb end,
      typ,new.id) returning id into new_enrollment;
  new.enrollment_id:=new_enrollment; new.intake_state:='enrolled';
  return new;
end $$;
create trigger sms_automation_contact_intake before insert on public.sms_automation_contacts
  for each row execute function sms_private.route_automation_intake();
create trigger sms_automation_quote_intake before insert on public.sms_automation_quote_requests
  for each row execute function sms_private.route_automation_intake();
create trigger sms_automation_review_intake before insert on public.sms_automation_reviews
  for each row execute function sms_private.route_automation_intake();
create trigger sms_automation_booking_intake before insert or update of name,phone,details,status,appointment_at
  on public.sms_automation_bookings for each row execute function sms_private.route_automation_intake();

-- Existing quote and booking producers flow through the same intake triggers.
create function sms_private.mirror_quote_intake() returns trigger
language plpgsql security definer set search_path='' as $$
declare c public.sms_contacts;
begin
  if exists(select 1 from public.sms_automation_quote_requests
    where tenant_id=new.tenant_id and source='sms_quotes' and source_record_id=new.id) then return new; end if;
  select * into c from public.sms_contacts where tenant_id=new.tenant_id and id=new.contact_id;
  insert into public.sms_automation_quote_requests(tenant_id,name,phone,details,source,source_record_id)
    values(new.tenant_id,c.name,c.phone,new.details,'sms_quotes',new.id);
  return new;
end $$;
create trigger sms_quote_to_intake after insert on public.sms_quotes
  for each row execute function sms_private.mirror_quote_intake();
create function sms_private.mirror_booking_intake() returns trigger
language plpgsql security definer set search_path='' as $$
declare c public.sms_contacts; existing_id uuid; record_name text; record_phone text; record_details jsonb;
begin
  select * into c from public.sms_contacts where tenant_id=new.tenant_id and id=new.contact_id;
  record_name:=coalesce(new.customer_name,c.name);
  record_phone:=coalesce(new.customer_phone,c.phone);
  record_details:=coalesce(new.metadata,'{}'::jsonb)||coalesce(new.extra_answers,'{}'::jsonb);
  select id into existing_id from public.sms_automation_bookings
    where tenant_id=new.tenant_id and source='sms_bookings' and source_record_id=new.id for update;
  if existing_id is null then
    insert into public.sms_automation_bookings(tenant_id,name,phone,details,source,source_record_id,status,appointment_at)
      values(new.tenant_id,record_name,record_phone,record_details,'sms_bookings',new.id,new.status,new.appointment_at);
  else
    update public.sms_automation_bookings set name=record_name,phone=record_phone,details=record_details,
      status=new.status,appointment_at=new.appointment_at,updated_at=now()
      where tenant_id=new.tenant_id and id=existing_id;
  end if;
  return new;
end $$;
create trigger sms_booking_to_intake after insert or update of status,appointment_at,metadata,extra_answers
  on public.sms_bookings for each row execute function sms_private.mirror_booking_intake();

create function sms_private.intake_context(jid uuid,token uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare j sms_private.jobs; e public.sms_automation_enrollments; result jsonb;
begin
  j:=sms_private.lease(jid,token);
  if j.queue<>'automation_jobs' then raise exception 'Wrong queue'; end if;
  select * into e from public.sms_automation_enrollments where tenant_id=j.tenant_id and id=(j.payload->>'enrollment_id')::uuid;
  if e.source_id is null then return null; end if;
  if e.source_type='contacts' then
    select to_jsonb(x) into result from public.sms_automation_contacts x where x.tenant_id=e.tenant_id and x.id=e.source_id;
  elsif e.source_type='quote_requests' then
    select to_jsonb(x) into result from public.sms_automation_quote_requests x where x.tenant_id=e.tenant_id and x.id=e.source_id;
  elsif e.source_type='bookings' then
    select to_jsonb(x) into result from public.sms_automation_bookings x where x.tenant_id=e.tenant_id and x.id=e.source_id;
  elsif e.source_type='reviews' then
    select to_jsonb(x) into result from public.sms_automation_reviews x where x.tenant_id=e.tenant_id and x.id=e.source_id;
  end if;
  return result;
end $$;
revoke all on function sms_private.intake_context(uuid,uuid) from public,anon,authenticated,sms_api,sms_webhook,sms_sender,sms_ai,sms_automation;
grant execute on function sms_private.intake_context(uuid,uuid) to sms_automation;

create function sms_private.intake_table(typ text) returns text
language sql immutable set search_path='' as $$
  select case typ when 'contacts' then 'sms_automation_contacts'
    when 'quote_requests' then 'sms_automation_quote_requests'
    when 'bookings' then 'sms_automation_bookings'
    when 'reviews' then 'sms_automation_reviews' end
$$;
create function sms_private.create_intake(u text,t text,typ text,p jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare tab text; result jsonb; source_name text; source_id text;
begin
  perform sms_private.require_admin(u);
  tab:=sms_private.intake_table(typ);
  if tab is null then raise exception 'Unknown SMS automation type'; end if;
  if jsonb_typeof(coalesce(p->'details','{}'::jsonb))<>'object' then raise exception 'Details must be an object'; end if;
  source_name:=left(coalesce(nullif(btrim(p->>'source'),''),'staff'),100);
  source_id:=left(coalesce(nullif(btrim(p->>'sourceRecordId'),''),gen_random_uuid()::text),256);
  execute format('select to_jsonb(x) from public.%I x where tenant_id=$1 and source=$2 and source_record_id=$3',tab)
    into result using t,source_name,source_id;
  if result is not null then return result; end if;
  begin
    if typ='bookings' then
      execute format('insert into public.%I(tenant_id,name,phone,details,source,source_record_id,status,appointment_at)
        values($1,$2,$3,$4,$5,$6,$7,$8) returning to_jsonb(%I)',tab,tab)
        into result using t,left(coalesce(p->>'name',''),200),p->>'phone',coalesce(p->'details','{}'::jsonb),
          source_name,source_id,coalesce(p->>'status','requested'),nullif(p->>'appointmentAt','')::timestamptz;
    else
      execute format('insert into public.%I(tenant_id,name,phone,details,source,source_record_id)
        values($1,$2,$3,$4,$5,$6) returning to_jsonb(%I)',tab,tab)
        into result using t,left(coalesce(p->>'name',''),200),p->>'phone',coalesce(p->'details','{}'::jsonb),source_name,source_id;
    end if;
  exception when unique_violation then
    execute format('select to_jsonb(x) from public.%I x where tenant_id=$1 and source=$2 and source_record_id=$3',tab)
      into result using t,source_name,source_id;
    if result is null then raise; end if;
  end;
  return result;
end $$;
create function sms_private.list_intake(u text,t text,typ text,page integer default 1,size integer default 50) returns jsonb
language plpgsql security definer set search_path='' as $$
declare tab text; rows jsonb; total bigint; page_number integer:=greatest(coalesce(page,1),1);
  page_size integer:=least(greatest(coalesce(size,50),1),100);
begin
  perform sms_private.require_admin(u);
  tab:=sms_private.intake_table(typ);
  if tab is null then raise exception 'Unknown SMS automation type'; end if;
  execute format('select count(*) from public.%I where tenant_id=$1',tab) into total using t;
  execute format('select coalesce(jsonb_agg(to_jsonb(x)||jsonb_build_object(''enrollment_status'',e.status)
    order by x.created_at desc,x.id desc),''[]''::jsonb) from
    (select * from public.%I where tenant_id=$1 order by created_at desc,id desc limit $2 offset $3) x
    left join public.sms_automation_enrollments e on e.tenant_id=x.tenant_id and e.id=x.enrollment_id',tab)
    into rows using t,page_size,(page_number-1)*page_size;
  return jsonb_build_object('rows',rows,'total',total,'page',page_number,'pageSize',page_size,
    'totalPages',greatest(1,ceil(total::numeric/page_size)::integer));
end $$;
create function sms_private.update_intake_booking(u text,t text,rid uuid,p jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare result public.sms_automation_bookings;
begin
  perform sms_private.require_admin(u);
  update public.sms_automation_bookings set
    name=coalesce(p->>'name',name),phone=coalesce(p->>'phone',phone),
    details=coalesce(p->'details',details),status=coalesce(p->>'status',status),
    appointment_at=case when p ? 'appointmentAt' then nullif(p->>'appointmentAt','')::timestamptz else appointment_at end
    where tenant_id=t and id=rid returning * into result;
  if result.id is null then raise exception 'SMS booking intake record not found'; end if;
  return to_jsonb(result);
end $$;
revoke all on function sms_private.create_intake(text,text,text,jsonb),
  sms_private.list_intake(text,text,text,integer,integer),
  sms_private.update_intake_booking(text,text,uuid,jsonb)
  from public,anon,authenticated,sms_api,sms_webhook,sms_sender,sms_automation,sms_ai;
grant execute on function sms_private.create_intake(text,text,text,jsonb),
  sms_private.list_intake(text,text,text,integer,integer),
  sms_private.update_intake_booking(text,text,uuid,jsonb) to sms_api;

-- The signed integration still writes canonical CRM records; their triggers
-- create intake rows. Never enroll a second time in the integration function.
create or replace function sms_private.ingest_event(t text,p jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
#variable_conflict use_column
declare c public.sms_contacts;
begin
  insert into sms_private.webhook_events(tenant_id,event_key)
    values(t,'integration:'||(p->>'eventId')) on conflict do nothing;
  if not found then return jsonb_build_object('duplicate',true); end if;
  insert into public.sms_contacts(tenant_id,phone,name,source)
    values(t,p->>'phone',coalesce(p->>'name',''),'integration') on conflict do nothing;
  select * into strict c from public.sms_contacts where tenant_id=t and phone=p->>'phone' for update;
  if p->>'type' in ('booking.created','booking.rescheduled','booking.cancelled') then
    insert into public.sms_bookings(tenant_id,id,contact_id,appointment_at,status,metadata)
      values(t,p->>'id',c.id,(p->>'appointment_at')::timestamptz,
        case when p->>'type'='booking.cancelled' then 'cancelled' else 'confirmed' end,coalesce(p->'metadata','{}'))
      on conflict(tenant_id,id) do update set appointment_at=excluded.appointment_at,
        status=excluded.status,metadata=excluded.metadata,updated_at=now();
  elsif p->>'type'='quote.created' then
    insert into public.sms_quotes(tenant_id,id,contact_id,details)
      values(t,p->>'id',c.id,coalesce(p->'metadata','{}')) on conflict do nothing;
  else raise exception 'Unsupported event'; end if;
  return jsonb_build_object('ok',true);
end $$;

do $$ declare table_name text; begin
  foreach table_name in array array['sms_automation_contacts','sms_automation_quote_requests','sms_automation_bookings','sms_automation_reviews'] loop
    execute format('alter table public.%I enable row level security',table_name);
    execute format('create policy tenant_read on public.%I for select to authenticated using (sms_private.can_access(tenant_id))',table_name);
    execute format('revoke all on public.%I from public,anon,authenticated,sms_api,sms_webhook,sms_sender,sms_automation,sms_ai',table_name);
    execute format('grant select on public.%I to authenticated',table_name);
  end loop;
end $$;
