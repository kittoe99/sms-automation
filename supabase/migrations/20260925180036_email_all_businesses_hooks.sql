create or replace function sms_private.email_intake_lifecycle() returns trigger
language plpgsql security definer set search_path='' as $$
#variable_conflict use_column
declare typ text; gid text; evidence text; eid uuid; fid uuid;
begin
  typ:=case tg_table_name when 'sms_automation_contacts' then 'contacts'
    when 'sms_automation_quote_requests' then 'quote_requests'
    when 'sms_automation_bookings' then 'bookings'
    when 'sms_automation_reviews' then 'reviews' end;
  if tg_op='UPDATE' and typ<>'bookings' then return new; end if;
  if tg_op='UPDATE' and typ='bookings' and (to_jsonb(new)->>'status') is not distinct from (to_jsonb(old)->>'status')
    and (to_jsonb(new)->>'appointment_at') is not distinct from (to_jsonb(old)->>'appointment_at')
    and new.email_opt_in is not distinct from old.email_opt_in then return new; end if;
  update sms_private.email_enrollments set status='cancelled',next_run_at=null,
    generation=generation+1,updated_at=now()
    where tenant_id=new.tenant_id and source_type=typ and source_id=new.id and status='active';
  if typ='quote_requests' then
    update sms_private.email_enrollments set status='cancelled',next_run_at=null,
      generation=generation+1,updated_at=now()
      where tenant_id=new.tenant_id and phone=new.phone and source_type='contacts' and status='active';
  elsif typ='bookings' and to_jsonb(new)->>'status'='confirmed' then
    update sms_private.email_enrollments set status='cancelled',next_run_at=null,
      generation=generation+1,updated_at=now()
      where tenant_id=new.tenant_id and phone=new.phone and source_type in ('contacts','quote_requests') and status='active';
  elsif typ='reviews' then
    update sms_private.email_enrollments set status='cancelled',next_run_at=null,
      generation=generation+1,updated_at=now()
      where tenant_id=new.tenant_id and phone=new.phone and source_type='bookings' and status='active';
  end if;
  if not new.email_opt_in or new.email is null or (typ='bookings' and to_jsonb(new)->>'status'<>'confirmed') then return new; end if;
  evidence:=new.email_consent_evidence;
  if coalesce(length(btrim(evidence)),0)=0 then return new; end if;
  select id into gid from public.sms_automation_groups where tenant_id=new.tenant_id and fixed_type=typ;
  insert into sms_private.email_consent_events(tenant_id,group_id,source_type,source_id,email,evidence)
    values(new.tenant_id,gid,typ,new.id,lower(new.email),evidence) on conflict do nothing;
  select form_public_id into fid from sms_private.email_consent_events
    where tenant_id=new.tenant_id and source_type=typ and source_id=new.id;
  eid:=sms_private.email_enroll(new.tenant_id,gid,typ,new.id,new.email,coalesce(new.name,''),
    new.phone,evidence,fid,nullif(to_jsonb(new)->>'appointment_at','')::timestamptz);
  return new;
end $$;

create or replace function sms_private.save_web_form(u text,t text,typ text,p jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare base jsonb; begin
  if p ? 'emailEnabled' and jsonb_typeof(p->'emailEnabled')<>'boolean' then raise exception 'Email activation must be true or false'; end if;
  base:=sms_private.save_web_form_before_email(u,t,typ,p);
  update public.sms_web_form_definitions set email_enabled=coalesce((p->>'emailEnabled')::boolean,email_enabled)
    where tenant_id=t and preset=typ;
  if p->>'emailEnabled'='false' or p->>'enabled'='false' then
    update sms_private.email_enrollments set status='cancelled',next_run_at=null,
      generation=generation+1,updated_at=now()
      where tenant_id=t and form_public_id=(select public_id from public.sms_web_form_definitions
        where tenant_id=t and preset=typ) and status='active';
  end if;
  return base||jsonb_build_object('email_enabled',(select email_enabled from public.sms_web_form_definitions
    where tenant_id=t and preset=typ));
end $$;

create or replace function sms_private.email_provider_ready(u text,t text) returns boolean
language plpgsql security definer set search_path='' as $$
begin
  perform sms_private.require_web_form_editor(u,t);
  return
    exists(select from sms_private.email_provider_secrets s
      join vault.decrypted_secrets v on v.id=s.secret_id
      where s.kind='resend_api' and length(v.decrypted_secret)>0) and
    exists(select from sms_private.email_provider_secrets s
      join vault.decrypted_secrets v on v.id=s.secret_id
      where s.kind='resend_webhook' and length(v.decrypted_secret)>0);
end $$;

create or replace function sms_private.email_record_provider_event(event_key text,provider text,
  kind text,address text) returns void
language plpgsql security definer set search_path='' as $$
begin
  if not pg_has_role(session_user,'sms_automation','member') then raise exception 'Worker role denied' using errcode='42501'; end if;
  if length(event_key) not between 1 and 200 or kind not in
    ('email.sent','email.delivered','email.delivery_delayed','email.bounced','email.complained','email.failed','email.suppressed')
    then raise exception 'Invalid email provider event'; end if;
  insert into sms_private.email_webhook_events(event_id,provider_id,event_type)
    values(event_key,provider,kind) on conflict do nothing;
  update sms_private.email_jobs set provider_status=kind,updated_at=now()
    where provider_id=provider;
  if kind in ('email.bounced','email.complained','email.suppressed') and address is not null then
    insert into sms_private.email_suppressions(tenant_id,email,reason)
      select tenant_id,lower(address),kind from public.sms_businesses
      on conflict do nothing;
    update sms_private.email_enrollments set status='cancelled',next_run_at=null,
      generation=generation+1,updated_at=now()
      where email=lower(address) and status='active';
  end if;
end $$;
