-- Website submissions are separate from staff and integration automation intake.
-- Existing fixed groups remain the one automation destination per business/type.
do $$ declare table_name text; begin
  foreach table_name in array array['sms_automation_contacts','sms_automation_quote_requests',
    'sms_automation_bookings','sms_automation_reviews'] loop
    execute format('alter table public.%I add column email text',table_name);
    execute format('alter table public.%I add column sms_opt_in boolean',table_name);
  end loop;
end $$;

-- Retain the existing lifecycle behavior while carrying email into the shared
-- contact and requiring this particular website submission to opt in.
create or replace function sms_private.route_automation_intake() returns trigger
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
  if tg_op='UPDATE' and typ='bookings' then
    if new.name is not distinct from old.name and new.phone is not distinct from old.phone
       and new.details is not distinct from old.details and new.status is not distinct from old.status
       and new.appointment_at is not distinct from old.appointment_at then return new; end if;
  end if;
  if tg_op='UPDATE' and old.enrollment_id is not null then
    update public.sms_automation_enrollments set status='cancelled',generation=generation+1,next_run_at=null
      where tenant_id=old.tenant_id and id=old.enrollment_id and status in ('active','paused');
  end if;
  new.enrollment_id:=null; new.skip_reason:=null; new.updated_at:=now();
  if new.phone is null or new.phone !~ '^[+][1-9][0-9]{7,14}$' then
    new.intake_state:='skipped'; new.skip_reason:='INVALID_PHONE'; return new;
  end if;
  insert into public.sms_contacts(tenant_id,phone,name,email,source)
    values(new.tenant_id,new.phone,coalesce(new.name,''),new.email,'automation_intake')
    on conflict(tenant_id,phone) do update set
      name=case when excluded.name<>'' then excluded.name else sms_contacts.name end,
      email=coalesce(excluded.email,sms_contacts.email),updated_at=now();
  select * into strict c from public.sms_contacts where tenant_id=new.tenant_id and phone=new.phone for update;
  if new.source='web_form' and typ in ('contacts','quote_requests') and new.sms_opt_in is not true then
    new.intake_state:='skipped'; new.skip_reason:='CONSENT_REQUIRED'; return new;
  end if;
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

create table public.sms_web_form_contact_submissions (
  tenant_id text not null references public.sms_businesses(tenant_id),
  id uuid not null default gen_random_uuid(),
  automation_group_id text not null,
  automation_intake_id uuid not null,
  name text not null check (length(btrim(name)) between 1 and 200),
  phone text not null check (phone ~ '^[+][1-9][0-9]{7,14}$'),
  email text not null check (length(btrim(email)) between 3 and 320 and email ~ '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$'),
  details jsonb not null default '{}'::jsonb check (jsonb_typeof(details)='object'),
  sms_opt_in boolean not null default false,
  consent_evidence text check (not sms_opt_in or coalesce(length(btrim(consent_evidence)),0)>0),
  submitted_at timestamptz not null default now(),
  primary key(tenant_id,id),
  foreign key(tenant_id,automation_group_id) references public.sms_automation_groups(tenant_id,id),
  foreign key(tenant_id,automation_intake_id) references public.sms_automation_contacts(tenant_id,id)
);
create table public.sms_web_form_quote_request_submissions (
  tenant_id text not null references public.sms_businesses(tenant_id),
  id uuid not null default gen_random_uuid(),
  automation_group_id text not null,
  automation_intake_id uuid not null,
  name text not null check (length(btrim(name)) between 1 and 200),
  phone text not null check (phone ~ '^[+][1-9][0-9]{7,14}$'),
  email text not null check (length(btrim(email)) between 3 and 320 and email ~ '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$'),
  details jsonb not null default '{}'::jsonb check (jsonb_typeof(details)='object'),
  sms_opt_in boolean not null default false,
  consent_evidence text check (not sms_opt_in or coalesce(length(btrim(consent_evidence)),0)>0),
  submitted_at timestamptz not null default now(),
  primary key(tenant_id,id),
  foreign key(tenant_id,automation_group_id) references public.sms_automation_groups(tenant_id,id),
  foreign key(tenant_id,automation_intake_id) references public.sms_automation_quote_requests(tenant_id,id)
);
create table public.sms_web_form_booking_submissions (
  tenant_id text not null references public.sms_businesses(tenant_id),
  id uuid not null default gen_random_uuid(),
  automation_group_id text not null,
  automation_intake_id uuid not null,
  name text not null check (length(btrim(name)) between 1 and 200),
  phone text not null check (phone ~ '^[+][1-9][0-9]{7,14}$'),
  email text not null check (length(btrim(email)) between 3 and 320 and email ~ '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$'),
  appointment_at timestamptz not null,
  details jsonb not null default '{}'::jsonb check (jsonb_typeof(details)='object'),
  sms_opt_in boolean not null default false,
  consent_evidence text check (not sms_opt_in or coalesce(length(btrim(consent_evidence)),0)>0),
  submitted_at timestamptz not null default now(),
  primary key(tenant_id,id),
  foreign key(tenant_id,automation_group_id) references public.sms_automation_groups(tenant_id,id),
  foreign key(tenant_id,automation_intake_id) references public.sms_automation_bookings(tenant_id,id)
);

create index sms_web_form_contacts_recent on public.sms_web_form_contact_submissions(tenant_id,submitted_at desc);
create index sms_web_form_quotes_recent on public.sms_web_form_quote_request_submissions(tenant_id,submitted_at desc);
create index sms_web_form_bookings_recent on public.sms_web_form_booking_submissions(tenant_id,submitted_at desc);

create function sms_private.route_web_form_submission() returns trigger
language plpgsql security definer set search_path='' as $$
#variable_conflict use_column
declare typ text; target_table text; g public.sms_automation_groups; contact_id uuid; intake_id uuid;
begin
  typ:=case tg_table_name
    when 'sms_web_form_contact_submissions' then 'contacts'
    when 'sms_web_form_quote_request_submissions' then 'quote_requests'
    when 'sms_web_form_booking_submissions' then 'bookings' end;
  target_table:=sms_private.intake_table(typ);
  if target_table is null then raise exception 'Unknown Web Forms submission table'; end if;
  if tg_op='UPDATE' then
    if to_jsonb(new)-'details' is distinct from to_jsonb(old)-'details' then
      raise exception 'Web Forms submission fields other than details cannot change';
    end if;
    return new;
  end if;
  if new.automation_intake_id is not null then raise exception 'Automation intake ID is assigned by the database'; end if;
  new.name:=btrim(new.name);
  new.email:=lower(btrim(new.email));
  if new.sms_opt_in and coalesce(length(btrim(new.consent_evidence)),0)=0 then
    raise exception 'SMS opt-in evidence required' using errcode='23514';
  end if;
  if typ='bookings' then
    if new.appointment_at is not null and new.appointment_at<=now() then
      raise exception 'Future appointment required' using errcode='23514';
    end if;
  end if;
  select * into g from public.sms_automation_groups
    where tenant_id=new.tenant_id and fixed_type=typ;
  if g.id is null then raise exception 'Web Forms automation group is unavailable'; end if;
  if new.automation_group_id is not null and new.automation_group_id<>g.id then
    raise exception 'Web Forms automation group does not match form type';
  end if;
  new.automation_group_id:=g.id;

  insert into public.sms_contacts(tenant_id,phone,name,email,source,marketing_consent)
    values(new.tenant_id,new.phone,new.name,new.email,'web_form',new.sms_opt_in)
    on conflict(tenant_id,phone) do update set
      name=excluded.name,email=excluded.email,updated_at=now(),
      marketing_consent=case when sms_contacts.opted_out then sms_contacts.marketing_consent
        else sms_contacts.marketing_consent or excluded.marketing_consent end
    returning id into contact_id;
  if new.sms_opt_in then
    insert into public.sms_consent_events(tenant_id,contact_id,consent,source,evidence)
      values(new.tenant_id,contact_id,true,'web_form',new.consent_evidence);
  end if;

  if typ='bookings' then
    insert into public.sms_automation_bookings
      (tenant_id,name,phone,email,details,source,source_record_id,sms_opt_in,status,appointment_at)
      values(new.tenant_id,new.name,new.phone,new.email,new.details,'web_form',new.id::text,
        new.sms_opt_in,'confirmed',new.appointment_at) returning id into intake_id;
  else
    execute format('insert into public.%I
      (tenant_id,name,phone,email,details,source,source_record_id,sms_opt_in)
      values($1,$2,$3,$4,$5,$6,$7,$8) returning id',target_table)
      into intake_id using new.tenant_id,new.name,new.phone,new.email,new.details,
        'web_form',new.id::text,new.sms_opt_in;
  end if;
  new.automation_intake_id:=intake_id;
  return new;
end $$;

do $$ declare table_name text; begin
  foreach table_name in array array['sms_web_form_contact_submissions',
    'sms_web_form_quote_request_submissions','sms_web_form_booking_submissions'] loop
    execute format('create trigger route_web_form_submission before insert or update on public.%I
      for each row execute function sms_private.route_web_form_submission()',table_name);
    execute format('alter table public.%I enable row level security',table_name);
    execute format('create policy tenant_read on public.%I for select to authenticated
      using (sms_private.can_access(tenant_id))',table_name);
    execute format('revoke all on public.%I from public,anon,authenticated,sms_api,sms_webhook,sms_sender,sms_automation,sms_ai',table_name);
    execute format('grant select on public.%I to authenticated',table_name);
  end loop;
end $$;
revoke all on function sms_private.route_web_form_submission() from public,anon,authenticated,sms_api,sms_webhook,sms_sender,sms_automation,sms_ai;
