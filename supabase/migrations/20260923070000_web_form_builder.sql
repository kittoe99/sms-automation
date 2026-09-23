-- One public form for each fixed website preset in each business.
do $$ begin
  if not exists(select from pg_roles where rolname='sms_form_public') then
    create role sms_form_public nologin;
  end if;
end $$;
grant usage on schema sms_private to sms_form_public;

create table public.sms_web_form_definitions (
  tenant_id text not null references public.sms_businesses(tenant_id),
  preset text not null check(preset in ('contacts','quote_requests','bookings')),
  public_id uuid not null default gen_random_uuid(),
  title text not null,
  description text not null default '',
  button_label text not null default 'Submit',
  enabled boolean not null default true,
  version integer not null default 1,
  fields jsonb not null default '[]'::jsonb check(jsonb_typeof(fields)='array'),
  updated_at timestamptz not null default now(),
  primary key(tenant_id,preset), unique(public_id), unique(tenant_id,public_id)
);
alter table public.sms_web_form_definitions enable row level security;
create policy tenant_read on public.sms_web_form_definitions for select to authenticated
  using (sms_private.can_access(tenant_id));
revoke all on public.sms_web_form_definitions from public,anon,authenticated,sms_api,sms_webhook,sms_sender,sms_automation,sms_ai,sms_form_public;
grant select on public.sms_web_form_definitions to authenticated;

create function sms_private.seed_web_forms(t text) returns void
language plpgsql security definer set search_path='' as $$
begin
  insert into public.sms_web_form_definitions(tenant_id,preset,title,description,button_label)
  values (t,'contacts','Contact us','Send us a message and we will be in touch.','Send message'),
    (t,'quote_requests','Request a quote','Tell us what you need and we will follow up.','Request quote'),
    (t,'bookings','Book an appointment','Choose your appointment date and time.','Book appointment')
  on conflict(tenant_id,preset) do nothing;
end $$;
create function sms_private.seed_web_forms_on_business() returns trigger
language plpgsql security definer set search_path='' as $$
begin perform sms_private.seed_web_forms(new.tenant_id); return new; end $$;
create trigger sms_seed_web_forms after insert on public.sms_businesses
  for each row execute function sms_private.seed_web_forms_on_business();
do $$ declare b record; begin
  for b in select tenant_id from public.sms_businesses loop
    perform sms_private.seed_web_forms(b.tenant_id);
  end loop;
end $$;

do $$ declare tab text; begin
  foreach tab in array array['sms_web_form_contact_submissions',
    'sms_web_form_quote_request_submissions','sms_web_form_booking_submissions'] loop
    execute format('alter table public.%I add column form_public_id uuid',tab);
    execute format('alter table public.%I add column form_version integer',tab);
    execute format('alter table public.%I add column field_snapshot jsonb',tab);
    execute format('alter table public.%I add column payload_fingerprint text',tab);
    execute format('alter table public.%I add foreign key(tenant_id,form_public_id)
      references public.sms_web_form_definitions(tenant_id,public_id)',tab);
  end loop;
end $$;

create function sms_private.web_form_table(typ text) returns text
language sql immutable set search_path='' as $$
  select case typ when 'contacts' then 'sms_web_form_contact_submissions'
    when 'quote_requests' then 'sms_web_form_quote_request_submissions'
    when 'bookings' then 'sms_web_form_booking_submissions' end
$$;
create function sms_private.require_web_form_editor(u text,t text) returns void
language plpgsql security definer set search_path='' as $$
begin
  if not exists(select from sms_private.admins where clerk_user_id=u)
     and not exists(select from public.sms_business_memberships
       where tenant_id=t and clerk_user_id=u and role='admin') then
    raise exception 'Business admin access required' using errcode='42501';
  end if;
end $$;
create function sms_private.list_web_forms(u text,t text) returns jsonb
language plpgsql security definer set search_path='' as $$
begin
  if not sms_private.can_access(t,u) then raise exception 'Business access required' using errcode='42501'; end if;
  return jsonb_build_object(
    'forms',coalesce((select jsonb_agg(to_jsonb(f) order by f.preset)
      from public.sms_web_form_definitions f where f.tenant_id=t),'[]'::jsonb),
    'timeZone',(select b.time_zone from public.sms_businesses b where b.tenant_id=t),
    'consentText',(select sms_private.web_form_consent_text(b.name)
      from public.sms_businesses b where b.tenant_id=t),
    'canEdit',exists(select from sms_private.admins where clerk_user_id=u)
      or exists(select from public.sms_business_memberships where tenant_id=t and clerk_user_id=u and role='admin'));
end $$;
create function sms_private.save_web_form(u text,t text,typ text,p jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare fs jsonb; field jsonb; keys text[]:='{}'; k text; field_type text; opts jsonb;
  result public.sms_web_form_definitions;
begin
  perform sms_private.require_web_form_editor(u,t);
  if sms_private.web_form_table(typ) is null then raise exception 'Unknown Web Forms preset'; end if;
  fs:=coalesce(p->'fields','[]'::jsonb);
  if jsonb_typeof(fs)<>'array' or jsonb_array_length(fs)>20 then raise exception 'Use at most 20 custom fields'; end if;
  for field in select value from jsonb_array_elements(fs) loop
    if jsonb_typeof(field)<>'object' then raise exception 'Invalid custom field'; end if;
    k:=field->>'key'; field_type:=field->>'type'; opts:=field->'options';
    if k is null or k !~ '^[a-z][a-z0-9_]{0,39}$'
       or k=any(array['name','phone','email','appointment_at','sms_opt_in','consent_evidence'])
       or k=any(keys) then raise exception 'Custom field keys must be unique and safe'; end if;
    keys:=array_append(keys,k);
    if length(btrim(coalesce(field->>'label',''))) not between 1 and 100
       or field_type is null or field_type not in ('text','textarea','select','checkbox','date')
       or jsonb_typeof(coalesce(field->'required','false'::jsonb))<>'boolean' then
      raise exception 'Invalid custom field definition';
    end if;
    if field_type='select' then
      if jsonb_typeof(opts)<>'array' or jsonb_array_length(opts) not between 1 and 20
        or exists(select from jsonb_array_elements(opts) v
          where jsonb_typeof(v.value)<>'string' or length(btrim(v.value #>> '{}')) not between 1 and 100)
        or (select count(distinct value) from jsonb_array_elements_text(opts))<>jsonb_array_length(opts) then
        raise exception 'Select fields need 1-20 unique options';
      end if;
    elsif opts is not null then
      raise exception 'Only select fields may have options';
    end if;
  end loop;
  if length(btrim(coalesce(p->>'title',''))) not between 1 and 120
     or length(coalesce(p->>'description',''))>500
     or length(btrim(coalesce(p->>'buttonLabel',''))) not between 1 and 80
     or jsonb_typeof(p->'enabled')<>'boolean' then raise exception 'Invalid form text or enabled state'; end if;
  update public.sms_web_form_definitions set
    title=btrim(p->>'title'),description=btrim(coalesce(p->>'description','')),
    button_label=btrim(p->>'buttonLabel'),enabled=(p->>'enabled')::boolean,
    fields=fs,version=version+1,updated_at=now()
    where tenant_id=t and preset=typ returning * into result;
  if result.public_id is null then raise exception 'Web Forms preset not found'; end if;
  return to_jsonb(result);
end $$;

create function sms_private.list_web_form_submissions(u text,t text,typ text,pg integer default 1,sz integer default 50) returns jsonb
language plpgsql security definer set search_path='' as $$
declare tab text; intake text; rows jsonb; total bigint; page_number integer:=greatest(coalesce(pg,1),1);
  page_size integer:=least(greatest(coalesce(sz,50),1),100);
begin
  if not sms_private.can_access(t,u) then raise exception 'Business access required' using errcode='42501'; end if;
  tab:=sms_private.web_form_table(typ); intake:=sms_private.intake_table(typ);
  if tab is null then raise exception 'Unknown Web Forms preset'; end if;
  execute format('select count(*) from public.%I where tenant_id=$1',tab) into total using t;
  execute format('select coalesce(jsonb_agg(to_jsonb(x)||jsonb_build_object(
    ''intake_state'',i.intake_state,''skip_reason'',i.skip_reason,''enrollment_status'',e.status)
    order by x.submitted_at desc,x.id desc),''[]''::jsonb) from
    (select * from public.%I where tenant_id=$1 order by submitted_at desc,id desc limit $2 offset $3) x
    left join public.%I i on i.tenant_id=x.tenant_id and i.id=x.automation_intake_id
    left join public.sms_automation_enrollments e on e.tenant_id=i.tenant_id and e.id=i.enrollment_id',tab,intake)
    into rows using t,page_size,(page_number-1)*page_size;
  return jsonb_build_object('rows',rows,'total',total,'page',page_number,'pageSize',page_size,
    'totalPages',greatest(1,ceil(total::numeric/page_size)::integer));
end $$;

create function sms_private.web_form_consent_text(business_name text) returns text
language sql immutable set search_path='' as $$
  select 'I agree to receive SMS updates and follow-ups from '||business_name||
    ' at the number provided. Consent is optional. Message frequency varies. Message and data rates may apply. Reply STOP to opt out.'
$$;
create function sms_private.public_web_form(fid uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare f public.sms_web_form_definitions; b public.sms_businesses;
begin
  select * into f from public.sms_web_form_definitions where public_id=fid and enabled;
  if f.public_id is null then return null; end if;
  select * into b from public.sms_businesses where tenant_id=f.tenant_id;
  return jsonb_build_object('id',f.public_id,'preset',f.preset,'title',f.title,
    'description',f.description,'buttonLabel',f.button_label,'fields',f.fields,
    'version',f.version,'businessName',b.name,'timeZone',b.time_zone,
    'consentText',sms_private.web_form_consent_text(b.name));
end $$;

create table sms_private.web_form_rate_buckets (
  form_public_id uuid not null, bucket text not null, window_start timestamptz not null,
  attempts integer not null default 0, primary key(form_public_id,bucket,window_start)
);
alter table sms_private.web_form_rate_buckets enable row level security;
create index web_form_rate_bucket_expiry on sms_private.web_form_rate_buckets(window_start);
select cron.schedule('web-form-rate-cleanup','15 3 * * *',
  'delete from sms_private.web_form_rate_buckets where window_start < now() - interval ''2 days''');

create function sms_private.claim_web_form_rate(fid uuid,submission_key text,ip_hash text) returns boolean
language plpgsql security definer set search_path='' as $$
declare f public.sms_web_form_definitions; tab text; existing_id uuid;
  ip_count integer; form_count integer; ten_start timestamptz; hour_start timestamptz;
begin
  select * into f from public.sms_web_form_definitions where public_id=fid and enabled;
  if f.public_id is null then return false; end if;
  if coalesce(length(ip_hash),0) not between 32 and 128 then return false; end if;
  tab:=sms_private.web_form_table(f.preset);
  if coalesce(submission_key,'') ~ '^[0-9a-fA-F-]{36}$' then
    execute format('select id from public.%I where tenant_id=$1 and id=$2',tab)
      into existing_id using f.tenant_id,submission_key::uuid;
    if existing_id is not null then return true; end if;
  end if;
  ten_start:=to_timestamp(floor(extract(epoch from now())/600)*600);
  hour_start:=to_timestamp(floor(extract(epoch from now())/3600)*3600);
  insert into sms_private.web_form_rate_buckets(form_public_id,bucket,window_start,attempts)
    values(fid,'ip:'||ip_hash,ten_start,1)
    on conflict(form_public_id,bucket,window_start) do update set attempts=web_form_rate_buckets.attempts+1
    returning attempts into ip_count;
  insert into sms_private.web_form_rate_buckets(form_public_id,bucket,window_start,attempts)
    values(fid,'form',hour_start,1)
    on conflict(form_public_id,bucket,window_start) do update set attempts=web_form_rate_buckets.attempts+1
    returning attempts into form_count;
  return ip_count<=10 and form_count<=100;
end $$;

create function sms_private.submit_web_form(fid uuid,p jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare f public.sms_web_form_definitions; b public.sms_businesses; tab text;
  submission_id uuid; normalized_phone text; normalized_email text; customer_name text;
  answers jsonb; field jsonb; value jsonb; k text; field_type text;
  appointment timestamptz; fingerprint text; existing_hash text; inserted_id uuid;
  existing_count integer;
  evidence text;
begin
  select * into f from public.sms_web_form_definitions where public_id=fid and enabled;
  if f.public_id is null then raise exception 'Form unavailable'; end if;
  tab:=sms_private.web_form_table(f.preset);
  if p is null or jsonb_typeof(p)<>'object' or octet_length(p::text)>16384 then raise exception 'Invalid form payload'; end if;
  if p->>'submissionId' is null then raise exception 'Submission ID required'; end if;
  submission_id:=(p->>'submissionId')::uuid;
  fingerprint:=md5((p-'honeypot')::text);
  execute format('select payload_fingerprint from public.%I where tenant_id=$1 and id=$2',tab)
    into existing_hash using f.tenant_id,submission_id;
  get diagnostics existing_count = row_count;
  if existing_count>0 then
    if existing_hash is distinct from fingerprint then raise exception 'Submission ID already used'; end if;
    return jsonb_build_object('ok',true,'submissionId',submission_id,'duplicate',true);
  end if;
  customer_name:=btrim(coalesce(p->>'name',''));
  normalized_phone:=btrim(coalesce(p->>'phone',''));
  normalized_email:=lower(btrim(coalesce(p->>'email','')));
  if length(customer_name) not between 1 and 200 or normalized_phone !~ '^[+][1-9][0-9]{7,14}$'
     or length(normalized_email) not between 3 and 320
     or normalized_email !~ '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$'
     or jsonb_typeof(p->'smsOptIn')<>'boolean' then raise exception 'Invalid required form fields'; end if;
  answers:=coalesce(p->'details','{}'::jsonb);
  if jsonb_typeof(answers)<>'object' then raise exception 'Custom answers must be an object'; end if;
  for k in select jsonb_object_keys(answers) loop
    if not exists(select from jsonb_array_elements(f.fields) x where x->>'key'=k) then
      raise exception 'Unknown custom field';
    end if;
  end loop;
  for field in select x.value from jsonb_array_elements(f.fields) x loop
    k:=field->>'key'; field_type:=field->>'type'; value:=answers->k;
    if value is null or value='null'::jsonb or value='""'::jsonb then
      if coalesce((field->>'required')::boolean,false) then raise exception 'Required custom field missing'; end if;
      continue;
    end if;
    if field_type='checkbox' then
      if jsonb_typeof(value)<>'boolean' or (coalesce((field->>'required')::boolean,false) and value='false'::jsonb) then
        raise exception 'Invalid checkbox answer'; end if;
    elsif jsonb_typeof(value)<>'string' or length(value #>> '{}')>2000 then
      raise exception 'Invalid custom field answer';
    elsif field_type='text' and length(value #>> '{}')>300 then
      raise exception 'Text answer too long';
    elsif field_type='select' and not (field->'options' ? (value #>> '{}')) then
      raise exception 'Invalid select answer';
    elsif field_type='date' then
      if (value #>> '{}') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
        or to_char(to_date(value #>> '{}','YYYY-MM-DD'),'YYYY-MM-DD')<>(value #>> '{}') then
        raise exception 'Invalid date answer'; end if;
    end if;
  end loop;

  if f.preset='bookings' then
    if p->>'appointmentAt' is null then raise exception 'Appointment required'; end if;
    appointment:=(p->>'appointmentAt')::timestamptz;
    if appointment<=now() then raise exception 'Future appointment required'; end if;
  elsif p ? 'appointmentAt' then raise exception 'Appointment belongs only to Booking forms'; end if;
  select * into b from public.sms_businesses where tenant_id=f.tenant_id;
  evidence:=case when (p->>'smsOptIn')::boolean then
    sms_private.web_form_consent_text(b.name)||' | form='||fid::text||' version='||f.version::text else null end;
  begin
    if f.preset='bookings' then
      execute format('insert into public.%I
        (tenant_id,id,name,phone,email,appointment_at,details,sms_opt_in,consent_evidence,
         form_public_id,form_version,field_snapshot,payload_fingerprint)
        values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) returning id',tab)
        into inserted_id using f.tenant_id,submission_id,customer_name,normalized_phone,
          normalized_email,appointment,answers,(p->>'smsOptIn')::boolean,evidence,
          fid,f.version,f.fields,fingerprint;
    else
      execute format('insert into public.%I
        (tenant_id,id,name,phone,email,details,sms_opt_in,consent_evidence,
         form_public_id,form_version,field_snapshot,payload_fingerprint)
        values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) returning id',tab)
        into inserted_id using f.tenant_id,submission_id,customer_name,normalized_phone,
          normalized_email,answers,(p->>'smsOptIn')::boolean,evidence,
          fid,f.version,f.fields,fingerprint;
    end if;
  exception when unique_violation then
    execute format('select payload_fingerprint from public.%I where tenant_id=$1 and id=$2',tab)
      into existing_hash using f.tenant_id,submission_id;
    if existing_hash is distinct from fingerprint then raise; end if;
    return jsonb_build_object('ok',true,'submissionId',submission_id,'duplicate',true);
  end;
  return jsonb_build_object('ok',true,'submissionId',inserted_id,'duplicate',false);
end $$;

revoke all on function sms_private.list_web_forms(text,text),
  sms_private.save_web_form(text,text,text,jsonb),
  sms_private.list_web_form_submissions(text,text,text,integer,integer),
  sms_private.public_web_form(uuid),sms_private.claim_web_form_rate(uuid,text,text),
  sms_private.submit_web_form(uuid,jsonb)
  from public,anon,authenticated,sms_api,sms_webhook,sms_sender,sms_automation,sms_ai,sms_form_public;
grant execute on function sms_private.list_web_forms(text,text),
  sms_private.save_web_form(text,text,text,jsonb),
  sms_private.list_web_form_submissions(text,text,text,integer,integer) to sms_api;
grant execute on function sms_private.public_web_form(uuid),sms_private.claim_web_form_rate(uuid,text,text),
  sms_private.submit_web_form(uuid,jsonb) to sms_form_public;
