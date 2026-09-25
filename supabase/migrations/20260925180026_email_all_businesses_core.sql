-- Enable separately consented email workflows for all existing and future CRM businesses.
alter table sms_private.email_group_settings drop constraint email_group_settings_tenant_id_check;

create or replace function sms_private.seed_email_group() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  if new.fixed_type in ('contacts','quote_requests','bookings','reviews') then
    insert into sms_private.email_group_settings(tenant_id,group_id,rule)
      values(new.tenant_id,new.id,new.rule) on conflict do nothing;
  end if;
  return new;
end $$;

insert into sms_private.email_group_settings(tenant_id,group_id,rule)
  select tenant_id,id,rule from public.sms_automation_groups
  where fixed_type in ('contacts','quote_requests','bookings','reviews')
  on conflict do nothing;

create or replace function sms_private.email_enroll(t text,gid text,typ text,rid uuid,
  address text,customer_name text,customer_phone text,consent_text text,fid uuid default null,
  appointment timestamptz default null) returns uuid
language plpgsql security definer set search_path='' as $$
#variable_conflict use_column
declare s sms_private.email_group_settings; b public.sms_businesses; due timestamptz; eid uuid;
begin
  if coalesce(length(btrim(consent_text)),0)=0 then return null; end if;
  address:=lower(btrim(address));
  if length(address) not between 3 and 320 or address !~ '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$' then return null; end if;
  perform pg_advisory_xact_lock(hashtext(t||':'||address));
  select * into s from sms_private.email_group_settings where tenant_id=t and group_id=gid;
  if not found or not s.enabled then return null; end if;
  if fid is not null and not exists(select from public.sms_web_form_definitions
    where tenant_id=t and public_id=fid and email_enabled and enabled) then return null; end if;
  if exists(select from sms_private.email_suppressions where tenant_id=t and email=address) then return null; end if;
  if exists(select from sms_private.email_enrollments x where x.tenant_id=t and x.email=address
    and x.status='active' and (x.source_type,x.source_id)<>(typ,rid)) then return null; end if;
  select * into b from public.sms_businesses where tenant_id=t;
  if typ='bookings' and (appointment is null or appointment<=now()) then return null; end if;
  due:=sms_private.automation_due(case when typ='bookings' then appointment else now() end,s.rule,b.time_zone,true);
  if due is null or (typ='bookings' and due>=appointment) then return null; end if;
  insert into sms_private.email_enrollments(tenant_id,group_id,source_type,source_id,form_public_id,
    email,name,phone,rule_snapshot,appointment_at,next_run_at)
    values(t,gid,typ,rid,fid,address,customer_name,customer_phone,s.rule,appointment,due)
    on conflict(tenant_id,source_type,source_id) do update set
      group_id=excluded.group_id,email=excluded.email,name=excluded.name,phone=excluded.phone,
      form_public_id=coalesce(excluded.form_public_id,email_enrollments.form_public_id),rule_snapshot=excluded.rule_snapshot,
      appointment_at=excluded.appointment_at,next_run_at=excluded.next_run_at,
      status='active',step_index=0,generation=email_enrollments.generation+1,updated_at=now()
    returning id into eid;
  return eid;
end $$;

create or replace function sms_private.create_intake(u text,t text,typ text,p jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
#variable_conflict use_column
declare tab text; result jsonb; source_name text; source_id text; address text;
  opted boolean; evidence text; gid text;
begin
  perform sms_private.require_admin(u);
  tab:=sms_private.intake_table(typ);
  if tab is null then raise exception 'Unknown SMS automation type'; end if;
  if jsonb_typeof(coalesce(p->'details','{}'::jsonb))<>'object' then raise exception 'Details must be an object'; end if;
  if p ? 'emailOptIn' and jsonb_typeof(p->'emailOptIn')<>'boolean' then raise exception 'Email consent choice must be true or false'; end if;
  opted:=coalesce((p->>'emailOptIn')::boolean,false);
  address:=nullif(lower(btrim(coalesce(p->>'email',''))),'');
  evidence:=nullif(btrim(coalesce(p->>'emailConsentEvidence','')),'');
  if address is not null and (length(address)>320 or address !~ '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$')
    then raise exception 'Valid email address required'; end if;
  if opted and (address is null or evidence is null or length(evidence)>1500)
    then raise exception 'Record email address and consent evidence before enrolling'; end if;
  source_name:=left(coalesce(nullif(btrim(p->>'source'),''),'staff'),100);
  source_id:=left(coalesce(nullif(btrim(p->>'sourceRecordId'),''),gen_random_uuid()::text),256);
  execute format('select to_jsonb(x) from public.%I x where tenant_id=$1 and source=$2 and source_record_id=$3',tab)
    into result using t,source_name,source_id;
  if result is not null then return result; end if;
  begin
    if typ='bookings' then
      execute format('insert into public.%I(tenant_id,name,phone,email,email_opt_in,email_consent_evidence,
        details,source,source_record_id,status,appointment_at)
        values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) returning to_jsonb(%I)',tab,tab)
        into result using t,left(coalesce(p->>'name',''),200),p->>'phone',address,opted,evidence,
          coalesce(p->'details','{}'::jsonb),source_name,source_id,
          coalesce(p->>'status','requested'),nullif(p->>'appointmentAt','')::timestamptz;
    else
      execute format('insert into public.%I(tenant_id,name,phone,email,email_opt_in,email_consent_evidence,
        details,source,source_record_id)
        values($1,$2,$3,$4,$5,$6,$7,$8,$9) returning to_jsonb(%I)',tab,tab)
        into result using t,left(coalesce(p->>'name',''),200),p->>'phone',address,opted,evidence,
          coalesce(p->'details','{}'::jsonb),source_name,source_id;
    end if;
  exception when unique_violation then
    execute format('select to_jsonb(x) from public.%I x where tenant_id=$1 and source=$2 and source_record_id=$3',tab)
      into result using t,source_name,source_id;
    if result is null then raise; end if;
  end;
  if opted then
    select id into gid from public.sms_automation_groups where tenant_id=t and fixed_type=typ;
    if gid is not null then
      insert into sms_private.email_consent_events(tenant_id,group_id,source_type,source_id,email,evidence)
        values(t,gid,typ,(result->>'id')::uuid,address,evidence) on conflict do nothing;
    end if;
  end if;
  return result;
end $$;

create or replace function sms_private.email_overview(u text,t text) returns jsonb
language plpgsql security definer set search_path='' as $$
begin
  perform sms_private.require_web_form_editor(u,t);
  return jsonb_build_object(
    'configured',true,
    'workerReady',exists(select from sms_private.edge_config c
      where c.queue='automation_jobs' and c.enabled and c.secret_id is not null),
    'groups',coalesce((select jsonb_agg(to_jsonb(s)||jsonb_build_object('name',g.name,'fixedType',g.fixed_type)
      order by g.name) from sms_private.email_group_settings s
      join public.sms_automation_groups g on g.tenant_id=s.tenant_id and g.id=s.group_id
      where s.tenant_id=t),'[]'::jsonb),
    'enrollments',coalesce((select jsonb_agg(x order by x.enrolled_at desc) from
      (select id,group_id,email,name,source_type,status,step_index,next_run_at,enrolled_at
       from sms_private.email_enrollments where tenant_id=t order by enrolled_at desc limit 100)x),'[]'::jsonb),
    'jobs',coalesce((select jsonb_agg(x order by x.created_at desc) from
      (select j.id,e.group_id,e.email,j.subject,j.status,j.provider_status,j.provider_id,
         j.error_code,j.step_index,j.created_at from sms_private.email_jobs j
       join sms_private.email_enrollments e on e.id=j.enrollment_id
       where e.tenant_id=t order by j.created_at desc limit 100)x),'[]'::jsonb)
  );
end $$;

create or replace function sms_private.email_save_group(u text,t text,gid text,p jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
#variable_conflict use_column
declare s sms_private.email_group_settings; g public.sms_automation_groups;
  proposed_rule jsonb; proposed_enabled boolean;
begin
  perform sms_private.require_web_form_editor(u,t);
  select * into strict g from public.sms_automation_groups where tenant_id=t and id=gid;
  select * into strict s from sms_private.email_group_settings where tenant_id=t and group_id=gid for update;
  if jsonb_typeof(p->'enabled')<>'boolean' or jsonb_typeof(p->'rule')<>'object'
    or jsonb_typeof(p->'intent')<>'string' or jsonb_typeof(p->'systemPrompt')<>'string'
    or jsonb_typeof(p->'businessContext')<>'string'
    or jsonb_typeof(p->'mailingAddress')<>'string' then raise exception 'Invalid email settings'; end if;
  proposed_rule:=p->'rule'; proposed_enabled:=(p->>'enabled')::boolean;
  if (proposed_rule->>'anchor')<>(case when g.fixed_type='bookings' then 'appointment' else 'enrollment' end)
    or coalesce((proposed_rule->>'repeatCount')::integer,0) not between 1 and 30
    or coalesce((proposed_rule->>'intervalCount')::integer,0) not between 1 and 365
    or proposed_rule->>'intervalUnit' not in ('hour','day','week','month')
    or coalesce((proposed_rule->>'startHour')::integer,-1) not between 0 and 23
    or coalesce((proposed_rule->>'endHour')::integer,-1) not between 1 and 24
    or (proposed_rule->>'startHour')::integer >= (proposed_rule->>'endHour')::integer
    then raise exception 'Invalid email schedule'; end if;
  if g.fixed_type='bookings' then
    if coalesce((proposed_rule->>'leadHours')::integer,0) not between 1 and 720 then raise exception 'Invalid reminder lead time'; end if;
  elsif coalesce((proposed_rule->>'firstDelayCount')::integer,-1) not between 0 and 365
    or proposed_rule->>'firstDelayUnit' not in ('hour','day','week','month')
    then raise exception 'Invalid first email delay'; end if;
  if length(p->>'intent')>1600 or length(p->>'systemPrompt')>6000 or length(p->>'businessContext')>10000
    or length(p->>'mailingAddress')>300
    then raise exception 'Email instructions are too long'; end if;
  if proposed_enabled and (btrim(p->>'intent')='' or btrim(p->>'systemPrompt')=''
    or btrim(p->>'businessContext')='' or btrim(p->>'mailingAddress')=''
    or not exists(select from sms_private.edge_config c
      where c.queue='automation_jobs' and c.enabled and c.secret_id is not null))
    then raise exception 'Configure email instructions and worker before activation'; end if;
  update sms_private.email_group_settings set enabled=proposed_enabled,rule=proposed_rule,
    intent=btrim(p->>'intent'),system_prompt=btrim(p->>'systemPrompt'),
    business_context=btrim(p->>'businessContext'),mailing_address=btrim(p->>'mailingAddress'),updated_at=now()
    where tenant_id=t and group_id=gid returning * into s;
  if not proposed_enabled then
    update sms_private.email_enrollments set status='cancelled',next_run_at=null,
      generation=generation+1,updated_at=now() where tenant_id=t and group_id=gid and status='active';
  end if;
  return to_jsonb(s);
end $$;
