-- Use a literal plus character class so E.164 numbers route in PostgreSQL.
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
  if new.phone is null or new.phone !~ '^[+][1-9][0-9]{7,14}$' then
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
