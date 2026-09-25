create function sms_private.email_intake_lifecycle() returns trigger
language plpgsql security definer set search_path='' as $$
#variable_conflict use_column
declare typ text; gid text; evidence text; eid uuid; fid uuid;
begin
  if new.tenant_id<>'e2-local' then return new; end if;
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
do $$ declare tab text; begin
  foreach tab in array array['sms_automation_contacts','sms_automation_quote_requests',
    'sms_automation_bookings','sms_automation_reviews'] loop
    execute format('create trigger email_intake_lifecycle after insert or update on public.%I
      for each row execute function sms_private.email_intake_lifecycle()',tab);
  end loop;
end $$;

-- Keep the established form validation, rate limits and SMS route; add email
-- consent and enrollment in the same transaction as that submission.
alter function sms_private.save_web_form(text,text,text,jsonb) rename to save_web_form_before_email;
create function sms_private.save_web_form(u text,t text,typ text,p jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare base jsonb; begin
  if p ? 'emailEnabled' and jsonb_typeof(p->'emailEnabled')<>'boolean' then raise exception 'Email activation must be true or false'; end if;
  if (p->>'emailEnabled')::boolean and t<>'e2-local' then raise exception 'Email sender is not configured for this business'; end if;
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
revoke all on function sms_private.save_web_form_before_email(text,text,text,jsonb)
  from public,anon,authenticated,sms_api,sms_webhook,sms_sender,sms_automation,sms_ai,sms_form_public;
revoke all on function sms_private.save_web_form(text,text,text,jsonb)
  from public,anon,authenticated,sms_api,sms_webhook,sms_sender,sms_automation,sms_ai,sms_form_public;
grant execute on function sms_private.save_web_form(text,text,text,jsonb) to sms_api;

alter function sms_private.public_web_form(uuid) rename to public_web_form_before_email;
create function sms_private.public_web_form(fid uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare base jsonb; f public.sms_web_form_definitions; begin
  base:=sms_private.public_web_form_before_email(fid);
  if base is null then return null; end if;
  select * into f from public.sms_web_form_definitions where public_id=fid;
  return base||jsonb_build_object('emailEnabled',f.email_enabled,
    'emailConsentText',sms_private.email_consent_text(base->>'businessName'));
end $$;
revoke all on function sms_private.public_web_form_before_email(uuid)
  from public,anon,authenticated,sms_api,sms_webhook,sms_sender,sms_automation,sms_ai,sms_form_public;
revoke all on function sms_private.public_web_form(uuid)
  from public,anon,authenticated,sms_api,sms_webhook,sms_sender,sms_automation,sms_ai,sms_form_public;
grant execute on function sms_private.public_web_form(uuid) to sms_form_public;

alter function sms_private.submit_web_form(uuid,jsonb) rename to submit_web_form_before_email;
create function sms_private.submit_web_form(fid uuid,p jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
#variable_conflict use_column
declare f public.sms_web_form_definitions; b public.sms_businesses; base jsonb;
  tab text; row_data jsonb; gid text; evidence text; intake_id uuid; opted boolean;
begin
  if p ? 'emailOptIn' and jsonb_typeof(p->'emailOptIn')<>'boolean' then raise exception 'Email consent choice must be true or false'; end if;
  opted:=coalesce((p->>'emailOptIn')::boolean,false);
  select * into strict f from public.sms_web_form_definitions where public_id=fid and enabled;
  if opted and not f.email_enabled then raise exception 'Email marketing is not enabled on this form'; end if;
  base:=sms_private.submit_web_form_before_email(fid,p);
  if not opted or coalesce((base->>'duplicate')::boolean,false) then return base; end if;
  tab:=sms_private.web_form_table(f.preset);
  execute format('select to_jsonb(x) from public.%I x where tenant_id=$1 and id=$2',tab)
    into row_data using f.tenant_id,(base->>'submissionId')::uuid;
  if row_data is null then raise exception 'Form submission is missing'; end if;
  intake_id:=(row_data->>'automation_intake_id')::uuid;
  select id into gid from public.sms_automation_groups where tenant_id=f.tenant_id and fixed_type=f.preset;
  select * into b from public.sms_businesses where tenant_id=f.tenant_id;
  evidence:=sms_private.email_consent_text(b.name)||' | form='||fid::text||' version='||f.version::text;
  insert into sms_private.email_consent_events(tenant_id,group_id,source_type,source_id,email,evidence,
    form_public_id,form_version) values(f.tenant_id,gid,f.preset,intake_id,row_data->>'email',evidence,
    fid,f.version) on conflict do nothing;
  if f.preset='bookings' then
    update public.sms_automation_bookings set email_opt_in=true,email_consent_evidence=evidence
      where tenant_id=f.tenant_id and id=intake_id;
    update sms_private.email_enrollments set form_public_id=fid
      where tenant_id=f.tenant_id and source_type='bookings' and source_id=intake_id;
  else
    execute format('update public.%I set email_opt_in=true,email_consent_evidence=$1 where tenant_id=$2 and id=$3',
      sms_private.intake_table(f.preset)) using evidence,f.tenant_id,intake_id;
    perform sms_private.email_enroll(f.tenant_id,gid,f.preset,intake_id,row_data->>'email',
      row_data->>'name',row_data->>'phone',evidence,fid,null);
  end if;
  update sms_private.email_consent_events set form_public_id=fid,form_version=f.version
    where tenant_id=f.tenant_id and source_type=f.preset and source_id=intake_id;
  return base;
end $$;
revoke all on function sms_private.submit_web_form_before_email(uuid,jsonb)
  from public,anon,authenticated,sms_api,sms_webhook,sms_sender,sms_automation,sms_ai,sms_form_public;
revoke all on function sms_private.submit_web_form(uuid,jsonb)
  from public,anon,authenticated,sms_api,sms_webhook,sms_sender,sms_automation,sms_ai,sms_form_public;
grant execute on function sms_private.submit_web_form(uuid,jsonb) to sms_form_public;
