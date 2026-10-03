-- CRM-owned forward migration. Requires CRM SMS summary and the deployed E2
-- canonical access/website-form contracts. Do not replay either project history.
alter table public.sms_web_form_definitions add column legacy_form boolean not null default false,
  add column archived boolean not null default false;
update public.sms_web_form_definitions set legacy_form=true;
alter table public.sms_web_form_definitions drop constraint sms_web_form_definitions_pkey;
alter table public.sms_web_form_definitions add primary key(public_id);
create unique index sms_legacy_form_type on public.sms_web_form_definitions(tenant_id,preset) where legacy_form;

create table sms_private.form_sequences (
  tenant_id text not null, form_id uuid not null, draft jsonb not null default '{}',
  published_version integer, enabled boolean not null default false, revision integer not null default 1,
  updated_at timestamptz not null default now(), primary key(tenant_id,form_id),
  foreign key(tenant_id,form_id) references public.sms_web_form_definitions(tenant_id,public_id)
);
create table sms_private.form_sequence_versions (
  tenant_id text not null, form_id uuid not null, version integer not null, sequence jsonb not null,
  created_at timestamptz not null default now(), primary key(tenant_id,form_id,version),
  foreign key(tenant_id,form_id) references sms_private.form_sequences(tenant_id,form_id)
);
create table sms_private.form_rule_presets (
  id uuid primary key default gen_random_uuid(), tenant_id text not null references public.sms_businesses(tenant_id),
  name text not null check(length(btrim(name)) between 1 and 100), sequence jsonb not null,
  created_at timestamptz not null default now()
);
create index form_presets_tenant on sms_private.form_rule_presets(tenant_id);
create table sms_private.form_runs (
  id uuid primary key default gen_random_uuid(), tenant_id text not null, form_id uuid not null,
  version integer not null, submission_id uuid not null, intake_id uuid, phone text not null,
  context jsonb not null, appointment_at timestamptz, status text not null default 'active'
    check(status in ('active','paused','completed','stopped')),
  reason text, message_index integer not null default 0, repeat_index integer not null default 0,
  send_index integer not null default 0, generation bigint not null default 1,
  next_run_at timestamptz, last_sent_at timestamptz, created_at timestamptz not null default now(),
  foreign key(tenant_id,form_id,version) references sms_private.form_sequence_versions(tenant_id,form_id,version),
  unique(tenant_id,form_id,submission_id)
);
create index form_runs_due on sms_private.form_runs(next_run_at,tenant_id) where status='active';
create index form_runs_phone on sms_private.form_runs(tenant_id,phone,form_id);
create index form_runs_version on sms_private.form_runs(tenant_id,form_id,version);
create index form_runs_intake on sms_private.form_runs(tenant_id,intake_id);
do $$ declare tab text; begin
  foreach tab in array array['form_sequences','form_sequence_versions','form_rule_presets','form_runs'] loop
    execute format('alter table sms_private.%I enable row level security',tab);
    execute format('revoke all on sms_private.%I from public,anon,authenticated,sms_api,sms_automation,sms_ai,sms_sender,sms_form_public',tab);
  end loop;
end $$;

-- Legacy groups remain for history/email; they cannot dispatch SMS.
update public.sms_automation_enrollments set status='paused',pause_reason='TEMPLATE_REVIEW_REQUIRED',
  paused_at=now(),generation=generation+1 where status='active';
update sms_private.edge_config set enabled=false where queue='ai_reply_jobs';
update sms_private.jobs set status='cancelled',error_code='SMS_AI_DISABLED',leased_until=null
  where queue in ('ai_reply_jobs','automation_jobs') and status in ('queued','retry','processing');
alter function sms_private.enqueue(text,text,text,jsonb,timestamptz) rename to enqueue_before_form_sequences;
create function sms_private.enqueue(t text,q text,k text,p jsonb,due timestamptz default now()) returns uuid
language plpgsql security definer set search_path='' as $$ begin
  if q='ai_reply_jobs' or (q='automation_jobs' and not p ? 'form_run_id') then return null; end if;
  return sms_private.enqueue_before_form_sequences(t,q,k,p,due);
end $$;

create or replace function sms_private.seed_web_forms(t text) returns void
language plpgsql security definer set search_path='' as $$ begin
  -- Retained for old callers; new workspaces begin with an empty Forms list.
  return;
end $$;

create function sms_private.form_due(base timestamptz,n integer,unit text,tz text,start_hour integer,end_hour integer)
returns timestamptz language plpgsql immutable set search_path='' as $$
declare d timestamp; begin
  if unit='minute' then d:=(base+make_interval(mins=>n)) at time zone tz;
  elsif unit='hour' then d:=(base+make_interval(hours=>n)) at time zone tz;
  elsif unit='month' then d:=(base at time zone tz)+make_interval(months=>n);
  else d:=(base at time zone tz)+make_interval(days=>n*case when unit='week' then 7 else 1 end); end if;
  if d::time<make_time(start_hour,0,0) then d:=date_trunc('day',d)+make_interval(hours=>start_hour);
  elsif end_hour<24 and d::time>=make_time(end_hour,0,0) then d:=date_trunc('day',d)+interval '1 day'+make_interval(hours=>start_hour); end if;
  return d at time zone tz;
end $$;

create function sms_private.validate_form_sequence(s jsonb,fields jsonb,booking boolean) returns void
language plpgsql immutable set search_path='' as $$
declare step jsonb; token text[]; begin
  if s is null or jsonb_typeof(s)<>'object' or exists(select from jsonb_each(s) x where x.value='null'::jsonb) or s->>'trigger' not in ('submission','appointment')
    or s->>'replyPolicy' not in ('pause','continue') or not s ?& array['trigger','replyPolicy','startHour','endHour','steps','leadHours']
    or s->>'trigger'='appointment' and not booking
    or (s->>'leadHours')::integer not between 1 and 8760
    or (s->>'startHour')::integer not between 0 and 23 or (s->>'endHour')::integer not between 1 and 24
    or (s->>'endHour')::integer<=(s->>'startHour')::integer
    or jsonb_typeof(s->'steps')<>'array' or jsonb_array_length(s->'steps') not between 1 and 50
    then raise exception 'Invalid sequence settings' using errcode='22023'; end if;
  for step in select value from jsonb_array_elements(s->'steps') loop
    if exists(select from jsonb_each(step) x where x.value='null'::jsonb) or not step ?& array['body','delayCount','delayUnit','sendCount','intervalCount','intervalUnit']
      or jsonb_typeof(step->'body')<>'string' or length(btrim(step->>'body')) not between 1 and 1600
      or step->>'delayUnit' not in ('minute','hour','day','week','month')
      or step->>'intervalUnit' not in ('minute','hour','day','week','month')
      or (step->>'delayCount')::integer not between 0 and 365
      or (step->>'sendCount')::integer not between 1 and 1000 or (step->>'intervalCount')::integer not between 1 and 365
      then raise exception 'Invalid message or repeat settings' using errcode='22023'; end if;
    for token in select regexp_matches(step->>'body','\{\{([^{}]+)\}\}','g') loop
      if token[1] not in ('first_name','name','phone','email','business_name')
        and not (token[1]='appointment_at' and s->>'trigger'='appointment')
        and not exists(select from jsonb_array_elements(fields) f where 'field.'||(f->>'key')=token[1])
        then raise exception 'Unknown message field: %',token[1] using errcode='22023'; end if;
    end loop;
    if regexp_replace(step->>'body','\{\{([^{}]+)\}\}','','g') ~ '[{}]' then raise exception 'Malformed message field'; end if;
  end loop;
end $$;

create function sms_private.save_form_definition(u text,t text,fid uuid,p jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare fs jsonb; field jsonb; keys text[]:='{}'; k text; field_type text; opts jsonb;
  result public.sms_web_form_definitions; typ text;
begin
  perform sms_private.require_web_form_editor(u,t);
  select preset into typ from public.sms_web_form_definitions where tenant_id=t and public_id=fid and not archived;
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
    where tenant_id=t and public_id=fid returning * into result;
  if result.public_id is null then raise exception 'Web Forms preset not found'; end if;
  return to_jsonb(result);
end $$;

create function sms_private.list_form_workspace(u text,t text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare base jsonb; staff boolean:=false; begin
  base:=sms_private.list_web_forms(u,t);
  begin perform sms_private.require_admin(u); staff:=true; exception when insufficient_privilege then staff:=false; end;
  return base||jsonb_build_object('canManageAutomation',staff,'forms',coalesce((select jsonb_agg(to_jsonb(f)||
    jsonb_build_object('automationEnabled',coalesce(s.enabled,false),'publishedVersion',s.published_version,
      'submissionCount',(select count(*) from (
        select form_public_id from public.sms_web_form_contact_submissions where tenant_id=t
        union all select form_public_id from public.sms_web_form_quote_request_submissions where tenant_id=t
        union all select form_public_id from public.sms_web_form_booking_submissions where tenant_id=t) x where x.form_public_id=f.public_id))
    order by f.archived,f.title,f.public_id) from public.sms_web_form_definitions f
      left join sms_private.form_sequences s on s.tenant_id=f.tenant_id and s.form_id=f.public_id where f.tenant_id=t),'[]'));
end $$;

create function sms_private.form_workspace(u text,t text,action text,fid uuid,p jsonb default '{}') returns jsonb
language plpgsql security definer set search_path='' as $$
declare f public.sms_web_form_definitions; s sms_private.form_sequences; result jsonb; n integer; copy public.sms_web_form_definitions;
begin
  if action in ('create','save','archive','restore','duplicate') then perform sms_private.require_web_form_editor(u,t);
  elsif action in ('read','submissions','presets') then perform sms_private.require_sms_reader(u,t);
  else perform sms_private.require_admin(u); if not sms_private.can_access(t,u) then raise exception 'Business access required' using errcode='42501'; end if;
  end if;
  if action='presets' then return jsonb_build_object('presets',coalesce((select jsonb_agg(to_jsonb(x) order by x.name) from sms_private.form_rule_presets x where tenant_id=t),'[]')); end if;
  if action='create' then
    if p->>'preset' not in ('contacts','quote_requests','bookings') or p->>'preset' is null then raise exception 'Choose a form type'; end if;
    insert into public.sms_web_form_definitions(tenant_id,preset,title,description,button_label,enabled)
      values(t,p->>'preset','New form','','Submit',false) returning * into f;
    return jsonb_build_object('form',sms_private.save_form_definition(u,t,f.public_id,p||jsonb_build_object('enabled',false)));
  end if;
  select * into f from public.sms_web_form_definitions where tenant_id=t and public_id=fid for update;
  if f.public_id is null then raise exception 'Form not found' using errcode='P0002'; end if;
  if action='duplicate' then
    insert into public.sms_web_form_definitions(tenant_id,preset,title,description,button_label,fields,enabled)
      values(t,f.preset,left(f.title,110)||' (copy)',f.description,f.button_label,f.fields,false) returning * into copy;
    begin
      perform sms_private.require_admin(u);
      insert into sms_private.form_sequences(tenant_id,form_id,draft)
        select t,copy.public_id,draft from sms_private.form_sequences where tenant_id=t and form_id=fid;
    exception when insufficient_privilege then null; end;
    return jsonb_build_object('form',to_jsonb(copy));
  end if;
  if action='restore' then
    update public.sms_web_form_definitions set archived=false,enabled=false,updated_at=now() where public_id=fid;
    return jsonb_build_object('ok',true);
  end if;
  if action='save' then
    if not f.legacy_form and coalesce((p->>'emailEnabled')::boolean,false) then raise exception 'Email automation is not connected to this form'; end if;
    result:=sms_private.save_form_definition(u,t,fid,p);
    if f.legacy_form then update public.sms_web_form_definitions set email_enabled=coalesce((p->>'emailEnabled')::boolean,email_enabled) where public_id=fid; end if;
    if p->>'enabled'='false' then
      update sms_private.form_runs set status='paused',reason='FORM_DISABLED',generation=generation+1 where tenant_id=t and form_id=fid and status='active';
    end if;
    if p->>'enabled'='false' or p->>'emailEnabled'='false' then
      update sms_private.email_enrollments set status='cancelled',next_run_at=null,generation=generation+1 where tenant_id=t and form_public_id=fid and status='active';
    end if;
    return jsonb_build_object('form',result||jsonb_build_object('email_enabled',(select email_enabled from public.sms_web_form_definitions where public_id=fid)));
  end if;
  if action='archive' then
    update public.sms_web_form_definitions set archived=true,enabled=false,updated_at=now() where public_id=fid;
    update sms_private.form_sequences set enabled=false where tenant_id=t and form_id=fid;
    update sms_private.form_runs set status='stopped',reason='FORM_ARCHIVED',generation=generation+1,next_run_at=null where tenant_id=t and form_id=fid and status in ('active','paused');
    update sms_private.email_enrollments set status='cancelled',next_run_at=null,generation=generation+1 where tenant_id=t and form_public_id=fid and status='active';
    return jsonb_build_object('ok',true);
  end if;
  if action='submissions' then
    n:=greatest(1,coalesce((p->>'page')::integer,1));
    execute format('select jsonb_build_object(''rows'',coalesce(jsonb_agg(to_jsonb(x)||jsonb_build_object(''enrollment_status'',r.status,''skip_reason'',r.reason,''run_id'',r.id,''send_index'',r.send_index) order by x.submitted_at desc),''[]''::jsonb),''total'',(select count(*) from public.%I where tenant_id=$1 and form_public_id=$2),''page'',$3) from (select * from public.%I where tenant_id=$1 and form_public_id=$2 order by submitted_at desc,id desc limit 50 offset ($3-1)*50) x left join sms_private.form_runs r on r.tenant_id=x.tenant_id and r.form_id=x.form_public_id and r.submission_id=x.id',sms_private.web_form_table(f.preset),sms_private.web_form_table(f.preset)) into result using t,fid,n;
    return result||jsonb_build_object('totalPages',greatest(1,ceil((result->>'total')::numeric/50)::integer));
  end if;
  if action='enroll' then
    if not exists(select from sms_private.form_sequences where tenant_id=t and form_id=fid and enabled and published_version is not null) then raise exception 'Publish and enable a sequence first'; end if;
    return sms_private.start_form_run(fid,(p->>'submissionId')::uuid);
  end if;
  if action='read' then
    select * into s from sms_private.form_sequences where tenant_id=t and form_id=fid;
    return jsonb_build_object('draft',coalesce(s.draft,'{}'),'enabled',coalesce(s.enabled,false),'revision',coalesce(s.revision,0),
      'publishedVersion',s.published_version,'published',(select sequence from sms_private.form_sequence_versions where tenant_id=t and form_id=fid and version=s.published_version));
  end if;
  if f.archived then raise exception 'Form is archived'; end if;
  insert into sms_private.form_sequences(tenant_id,form_id) values(t,fid) on conflict do nothing;
  select * into s from sms_private.form_sequences where tenant_id=t and form_id=fid for update;
  if action in ('draft','publish','preset-save') then
    perform sms_private.validate_form_sequence(p->'sequence',f.fields,f.preset='bookings');
    if action='preset-save' then
      insert into sms_private.form_rule_presets(tenant_id,name,sequence) values(t,btrim(p->>'name'),p->'sequence');
    else
      if coalesce((p->>'revision')::integer,0)<>(case when s.revision=1 and s.draft='{}' then 0 else s.revision end) then raise exception 'This automation changed. Reload before saving.' using errcode='40001'; end if;
      update sms_private.form_sequences set draft=p->'sequence',revision=revision+1,updated_at=now() where tenant_id=t and form_id=fid;
      if action='publish' then
        n:=coalesce(s.published_version,0)+1;
        insert into sms_private.form_sequence_versions values(t,fid,n,p->'sequence',now());
        update sms_private.form_sequences set published_version=n where tenant_id=t and form_id=fid;
      end if;
    end if;
  elsif action='state' then
    if jsonb_typeof(p->'enabled')<>'boolean' or not p ? 'enabled' then raise exception 'Choose an automation state'; end if;
    if p->>'enabled'='true' and (s.published_version is null or not f.enabled) then raise exception 'Publish a sequence and enable the form first'; end if;
    update sms_private.form_sequences set enabled=(p->>'enabled')::boolean,revision=revision+1,updated_at=now() where tenant_id=t and form_id=fid;
    if p->>'enabled'='false' then update sms_private.form_runs set status='paused',reason='AUTOMATION_PAUSED',generation=generation+1 where tenant_id=t and form_id=fid and status='active'; end if;
  elsif action in ('pause','resume','stop') then
    if action='resume' and (not s.enabled or not f.enabled) then raise exception 'Enable the form and automation first'; end if;
    if action='resume' and exists(select from sms_private.jobs where tenant_id=t and queue='sms_send_jobs'
      and payload->'request'->>'form_run_id'=p->>'runId' and status in ('submitting','submission_unknown')) then
      raise exception 'A previous send needs provider reconciliation before this run can resume'; end if;
    update sms_private.form_runs set status=case action when 'resume' then 'active' when 'stop' then 'stopped' else 'paused' end,
      reason=case when action='resume' then null else 'MANUAL_'||upper(action) end,generation=generation+1,
      next_run_at=case when action='stop' then null else greatest(next_run_at,now()) end
      where tenant_id=t and form_id=fid and id=(p->>'runId')::uuid and status in ('active','paused');
  else raise exception 'Unknown form action'; end if;
  return sms_private.form_workspace(u,t,'read',fid,'{}');
end $$;

create or replace function sms_private.save_web_form(u text,t text,typ text,p jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare fid uuid; begin
  select public_id into fid from public.sms_web_form_definitions where tenant_id=t and preset=typ and legacy_form;
  return sms_private.form_workspace(u,t,'save',fid,p)->'form';
end $$;

alter function sms_private.submit_web_form(uuid,jsonb) rename to submit_web_form_before_sequences;
create function sms_private.start_form_run(fid uuid,sid uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare f public.sms_web_form_definitions; result jsonb:=jsonb_build_object('submissionId',sid); row_data jsonb; s sms_private.form_sequences;
  cfg jsonb; step jsonb; due timestamptz; tz text; ctx jsonb; appt timestamptz; p jsonb;
begin
  select * into f from public.sms_web_form_definitions where public_id=fid and enabled and not archived for share;
  if f.public_id is null then raise exception 'Enable the form first'; end if;
  execute format('select to_jsonb(x) from public.%I x where tenant_id=$1 and form_public_id=$2 and id=$3',sms_private.web_form_table(f.preset)) into row_data using f.tenant_id,fid,sid;
  if row_data is null then raise exception 'Submission not found'; end if;
  if not coalesce((row_data->>'sms_opt_in')::boolean,false) then return result; end if;
  if exists(select from sms_private.form_runs where tenant_id=f.tenant_id and form_id=fid and submission_id=sid) then return result; end if;
  p:=jsonb_build_object('phone',row_data->>'phone');
  select * into s from sms_private.form_sequences where tenant_id=f.tenant_id and form_id=fid and enabled;
  if s.published_version is null then return result; end if;
  if exists(select from public.sms_contacts where tenant_id=f.tenant_id and phone=p->>'phone' and (opted_out or not marketing_consent)) then return result; end if;
  select sequence into cfg from sms_private.form_sequence_versions where tenant_id=f.tenant_id and form_id=fid and version=s.published_version;
  execute format('select to_jsonb(x) from public.%I x where tenant_id=$1 and id=$2',sms_private.web_form_table(f.preset)) into row_data using f.tenant_id,(result->>'submissionId')::uuid;
  appt:=case when cfg->>'trigger'='appointment' then (row_data->>'appointment_at')::timestamptz end;
  perform pg_advisory_xact_lock(hashtextextended(f.tenant_id||':'||fid||':'||(p->>'phone'),418));
  if exists(select from sms_private.form_runs where tenant_id=f.tenant_id and form_id=fid and phone=p->>'phone'
    and status in ('active','paused') and appointment_at is not distinct from appt) then return result; end if;
  select time_zone into tz from public.sms_businesses where tenant_id=f.tenant_id;
  step:=cfg->'steps'->0;
  due:=sms_private.form_due(case when appt is not null then appt-make_interval(hours=>(cfg->>'leadHours')::integer) else now() end,
    (step->>'delayCount')::integer,step->>'delayUnit',tz,(cfg->>'startHour')::integer,(cfg->>'endHour')::integer);
  ctx:=jsonb_build_object('name',row_data->>'name','first_name',split_part(row_data->>'name',' ',1),'phone',row_data->>'phone','email',row_data->>'email',
    'business_name',(select name from public.sms_businesses where tenant_id=f.tenant_id),'fields',row_data->'details');
  insert into sms_private.form_runs(tenant_id,form_id,version,submission_id,intake_id,phone,context,appointment_at,next_run_at)
    values(f.tenant_id,fid,s.published_version,(result->>'submissionId')::uuid,(row_data->>'automation_intake_id')::uuid,p->>'phone',ctx,appt,due);
  return result;
end $$;

create function sms_private.submit_web_form(fid uuid,p jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare f public.sms_web_form_definitions; result jsonb; row_data jsonb; s sms_private.form_sequences;
  cfg jsonb; step jsonb; due timestamptz; tz text; ctx jsonb; appt timestamptz;
begin
  select * into f from public.sms_web_form_definitions where public_id=fid and enabled and not archived for share;
  if f.public_id is null then raise exception 'Form unavailable'; end if;
  if f.legacy_form then result:=sms_private.submit_web_form_before_sequences(fid,p);
  else
    if coalesce((p->>'emailOptIn')::boolean,false) then raise exception 'Email consent is not enabled'; end if;
    result:=sms_private.submit_web_form_before_email(fid,p);
  end if;
  if coalesce((result->>'duplicate')::boolean,false) or not coalesce((p->>'smsOptIn')::boolean,false) then return result; end if;
  perform sms_private.start_form_run(fid,(result->>'submissionId')::uuid);
  return result;
end $$;

create or replace function sms_private.enqueue_due_automations() returns integer
language plpgsql security definer set search_path='' as $$
declare r record; n integer:=0; begin
  for r in select e.* from sms_private.form_runs e join public.sms_businesses b on b.tenant_id=e.tenant_id
    join sms_private.form_sequences s on s.tenant_id=e.tenant_id and s.form_id=e.form_id
    join public.sms_web_form_definitions f on f.tenant_id=e.tenant_id and f.public_id=e.form_id
    where e.status='active' and e.next_run_at<=now() and b.sending_enabled and b.status='active'
      and s.enabled and f.enabled and not f.archived
      and not exists(select from sms_private.jobs j where j.tenant_id=e.tenant_id and j.queue='automation_jobs'
        and j.dedupe_key='form:'||e.id||':'||e.generation||':'||e.send_index)
    order by e.next_run_at,e.id limit (select scheduler_batch_size from sms_private.runtime)
  loop
    perform sms_private.enqueue(r.tenant_id,'automation_jobs','form:'||r.id||':'||r.generation||':'||r.send_index,
      jsonb_build_object('form_run_id',r.id,'generation',r.generation,'send_index',r.send_index)); n:=n+1;
  end loop;
  return n;
end $$;

create function sms_private.process_form_automation(jid uuid,token uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare j sms_private.jobs; r sms_private.form_runs; cfg jsonb; step jsonb; body text; key text[]; val text;
  tz text; due timestamptz; result jsonb;
begin
  j:=sms_private.lease(jid,token);
  if j.queue<>'automation_jobs' then raise exception 'Wrong queue'; end if;
  select * into r from sms_private.form_runs where tenant_id=j.tenant_id and id=(j.payload->>'form_run_id')::uuid for update;
  if r.id is null or r.status<>'active' or r.generation<>(j.payload->>'generation')::bigint or r.send_index<>(j.payload->>'send_index')::integer then
    perform sms_private.finish(jid,token,'cancelled','STALE_FORM_RUN'); return null; end if;
  select sequence into cfg from sms_private.form_sequence_versions where tenant_id=r.tenant_id and form_id=r.form_id and version=r.version;
  step:=cfg->'steps'->r.message_index;
  if step is null or r.appointment_at<=now() then
    update sms_private.form_runs set status='completed',next_run_at=null where id=r.id;
    perform sms_private.finish(jid,token,'completed'); return null; end if;
  if exists(select from sms_private.jobs where tenant_id=r.tenant_id and queue='sms_send_jobs'
    and payload->'request'->>'form_run_id'=r.id::text and (payload->'request'->>'send_index')::integer=r.send_index
    and (status in ('submitting','submission_unknown') or status in ('queued','retry','processing') and (payload->'request'->>'run_generation')::bigint=r.generation)) then
    perform sms_private.finish(jid,token,'completed'); return null; end if;
  select time_zone into tz from public.sms_businesses where tenant_id=r.tenant_id;
  due:=sms_private.form_due(greatest(r.next_run_at,now()),0,'minute',tz,(cfg->>'startHour')::integer,(cfg->>'endHour')::integer);
  if due>now() then
    update sms_private.form_runs set next_run_at=due,generation=generation+1 where id=r.id;
    perform sms_private.finish(jid,token,'completed'); return null; end if;
  body:=step->>'body';
  for key in select regexp_matches(body,'\{\{([^{}]+)\}\}','g') loop
    val:=case when key[1]='appointment_at' then to_char(r.appointment_at at time zone tz,'Mon DD, YYYY HH24:MI')||' ('||tz||')'
      when key[1] like 'field.%' then r.context->'fields'->>substring(key[1] from 7) else r.context->>key[1] end;
    if nullif(btrim(val),'') is null then
      update sms_private.form_runs set status='paused',reason='MISSING_FIELD:'||key[1],generation=generation+1 where id=r.id;
      perform sms_private.finish(jid,token,'completed'); return null;
    end if;
    body:=replace(body,'{{'||key[1]||'}}',val);
  end loop;
  if length(body)>1600 or position('{{' in body)>0 then
    update sms_private.form_runs set status='paused',reason='MESSAGE_TOO_LONG_OR_INVALID',generation=generation+1 where id=r.id;
    perform sms_private.finish(jid,token,'completed'); return null;
  end if;
  result:=sms_private.outbox(r.tenant_id,'form:'||r.id||':'||r.generation||':'||r.send_index,
    jsonb_build_object('phone',r.phone,'body',body,'purpose',case when r.appointment_at is null then 'marketing' else 'transactional' end,
      'form_run_id',r.id,'form_id',r.form_id,'run_generation',r.generation,'send_index',r.send_index,
      'start_hour',(cfg->>'startHour')::integer,'end_hour',(cfg->>'endHour')::integer));
  update public.sms_messages set meta=meta||jsonb_build_object('form_id',r.form_id,'form_run_id',r.id,'sequence_version',r.version,
    'message_number',r.message_index+1,'repeat_number',r.repeat_index+1) where tenant_id=r.tenant_id and id=(result->>'messageId')::uuid;
  perform sms_private.finish(jid,token,'completed'); return result;
end $$;

alter function sms_private.begin_submission(uuid,uuid) rename to begin_submission_before_form_sequences;
create function sms_private.begin_submission(jid uuid,token uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare j sms_private.jobs; p jsonb; r sms_private.form_runs; cfg jsonb; tz text; due timestamptz; begin
  j:=sms_private.lease(jid,token); p:=j.payload->'request';
  if p ? 'enrollment_id' or p ? 'ai_run_id' or j.dedupe_key like 'ai:%'
    or p ? 'conversation_generation' and not p ? 'form_run_id' then
    perform sms_private.finish(jid,token,'cancelled','SMS_AI_DISABLED'); return null;
  end if;
  if p ? 'form_run_id' then
    select * into r from sms_private.form_runs where tenant_id=j.tenant_id and id=(p->>'form_run_id')::uuid for update;
    if r.id is null or r.status<>'active' or r.generation<>(p->>'run_generation')::bigint or r.send_index<>(p->>'send_index')::integer
      or r.appointment_at<=now() or not exists(select from sms_private.form_sequences s join public.sms_web_form_definitions f on f.tenant_id=s.tenant_id and f.public_id=s.form_id
        where s.tenant_id=r.tenant_id and s.form_id=r.form_id and s.enabled and f.enabled and not f.archived) then
      perform sms_private.finish(jid,token,'cancelled','STALE_FORM_RUN'); return null;
    end if;
    select sequence into cfg from sms_private.form_sequence_versions where tenant_id=r.tenant_id and form_id=r.form_id and version=r.version;
    select time_zone into tz from public.sms_businesses where tenant_id=r.tenant_id;
    due:=sms_private.form_due(now(),0,'minute',tz,(cfg->>'startHour')::integer,(cfg->>'endHour')::integer);
    if due>now() then
      update sms_private.jobs set attempts=attempts-1 where id=jid;
      perform sms_private.finish(jid,token,'retry','OUTSIDE_WINDOW',least(3600,ceil(extract(epoch from due-now()))::integer)); return null;
    end if;
  end if;
  return sms_private.begin_submission_before_form_sequences(jid,token);
end $$;

alter function sms_private.accept_attempt(uuid,text) rename to accept_attempt_before_form_sequences;
create function sms_private.accept_attempt(aid uuid,s text) returns void
language plpgsql security definer set search_path='' as $$
declare j sms_private.jobs; r sms_private.form_runs; p jsonb; cfg jsonb; step jsonb; mi integer; ri integer; due timestamptz; tz text;
begin
  select job.* into strict j from sms_private.attempts a join sms_private.jobs job on job.id=a.job_id where a.id=aid for update of job;
  if j.status='completed' then return; end if;
  perform sms_private.accept_attempt_before_form_sequences(aid,s);
  p:=j.payload->'request';
  if not p ? 'form_run_id' then return; end if;
  select * into r from sms_private.form_runs where tenant_id=j.tenant_id and id=(p->>'form_run_id')::uuid for update;
  if r.id is null or r.send_index<>(p->>'send_index')::integer then return; end if;
  select sequence into cfg from sms_private.form_sequence_versions where tenant_id=r.tenant_id and form_id=r.form_id and version=r.version;
  select time_zone into tz from public.sms_businesses where tenant_id=r.tenant_id;
  mi:=r.message_index; ri:=r.repeat_index+1; step:=cfg->'steps'->mi;
  if ri>=(step->>'sendCount')::integer then
    mi:=mi+1; ri:=0; step:=cfg->'steps'->mi;
    if step is not null then due:=sms_private.form_due(now(),(step->>'delayCount')::integer,step->>'delayUnit',tz,(cfg->>'startHour')::integer,(cfg->>'endHour')::integer); end if;
  else due:=sms_private.form_due(now(),(step->>'intervalCount')::integer,step->>'intervalUnit',tz,(cfg->>'startHour')::integer,(cfg->>'endHour')::integer); end if;
  if due>=r.appointment_at then due:=null; end if;
  update sms_private.form_runs set message_index=mi,repeat_index=ri,send_index=send_index+1,last_sent_at=now(),next_run_at=due,
    generation=generation+1,status=case when status='stopped' then 'stopped' when due is null then 'completed' else status end where id=r.id;
end $$;

create function sms_private.form_reply_pause() returns trigger
language plpgsql security definer set search_path='' as $$ begin
  if new.direction='inbound' then
    update sms_private.form_runs r set status='paused',reason='CUSTOMER_REPLIED',generation=r.generation+1
    from sms_private.form_sequence_versions v where r.tenant_id=new.tenant_id and r.phone=new.contact_phone and r.status='active'
      and v.tenant_id=r.tenant_id and v.form_id=r.form_id and v.version=r.version and v.sequence->>'replyPolicy'='pause';
  end if;
  return new;
end $$;
create trigger sms_form_reply_pause after insert on public.sms_messages for each row execute function sms_private.form_reply_pause();

create function sms_private.form_contact_stop() returns trigger
language plpgsql security definer set search_path='' as $$ begin
  if new.opted_out then update sms_private.form_runs set status='stopped',reason='OPTED_OUT',generation=generation+1,next_run_at=null
    where tenant_id=new.tenant_id and phone=new.phone and status in ('active','paused'); end if; return new;
end $$;
create trigger sms_form_contact_stop after update of opted_out on public.sms_contacts for each row execute function sms_private.form_contact_stop();

create function sms_private.form_booking_changed() returns trigger
language plpgsql security definer set search_path='' as $$
declare r sms_private.form_runs; cfg jsonb; tz text; due timestamptz; begin
  for r in select * from sms_private.form_runs where tenant_id=new.tenant_id and intake_id=new.id and appointment_at is not null and status in ('active','paused') for update loop
    select sequence into cfg from sms_private.form_sequence_versions where tenant_id=r.tenant_id and form_id=r.form_id and version=r.version;
    select time_zone into tz from public.sms_businesses where tenant_id=r.tenant_id;
    if new.status<>'confirmed' then
      update sms_private.form_runs set status='stopped',reason='APPOINTMENT_CANCELLED',next_run_at=null,generation=generation+1 where id=r.id;
    elsif new.appointment_at is distinct from old.appointment_at then
      due:=sms_private.form_due(greatest(now(),new.appointment_at-make_interval(hours=>(cfg->>'leadHours')::integer)),0,'minute',tz,(cfg->>'startHour')::integer,(cfg->>'endHour')::integer);
      update sms_private.form_runs set appointment_at=new.appointment_at,next_run_at=due,generation=generation+1 where id=r.id;
    end if;
  end loop; return new;
end $$;
create trigger sms_form_booking_changed after update of status,appointment_at on public.sms_automation_bookings for each row execute function sms_private.form_booking_changed();

create function sms_private.form_job_failed() returns trigger
language plpgsql security definer set search_path='' as $$ begin
  if new.status in ('failed','submission_unknown','cancelled') and old.status is distinct from new.status then
    update sms_private.form_runs set status='paused',reason=coalesce(new.error_code,new.status),generation=generation+1
      where tenant_id=new.tenant_id and id=coalesce(new.payload->>'form_run_id',new.payload->'request'->>'form_run_id')::uuid and status='active'
        and generation=coalesce(new.payload->>'generation',new.payload->'request'->>'run_generation')::bigint;
  end if; return new;
end $$;
create trigger sms_form_job_failed after update of status on sms_private.jobs for each row execute function sms_private.form_job_failed();

create function sms_private.form_pause_legacy_enrollment() returns trigger
language plpgsql set search_path='' as $$ begin
  if new.status='active' then new.status:='paused';new.pause_reason:='TEMPLATE_REVIEW_REQUIRED';new.paused_at:=now(); end if;return new;
end $$;
create trigger form_pause_legacy_enrollment before insert or update on public.sms_automation_enrollments
  for each row execute function sms_private.form_pause_legacy_enrollment();

-- Keep legacy RPC internals private; only bounded entrypoints are callable.
do $$ declare f record; begin
  for f in select p.oid::regprocedure sig from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='sms_private' and (p.proname like 'form_%' or p.proname in ('validate_form_sequence','save_form_definition','start_form_run','process_form_automation',
      'enqueue','enqueue_before_form_sequences','list_form_workspace','submit_web_form','submit_web_form_before_sequences',
      'begin_submission','begin_submission_before_form_sequences','accept_attempt','accept_attempt_before_form_sequences'))
  loop execute format('revoke all on function %s from public,anon,authenticated,sms_api,sms_automation,sms_ai,sms_sender,sms_webhook,sms_form_public',f.sig); end loop;
end $$;
grant execute on function sms_private.form_workspace(text,text,text,uuid,jsonb),sms_private.list_form_workspace(text,text) to sms_api;
grant execute on function sms_private.submit_web_form(uuid,jsonb) to sms_form_public;
grant execute on function sms_private.process_form_automation(uuid,uuid) to sms_automation;
grant execute on function sms_private.begin_submission(uuid,uuid) to sms_sender;
grant execute on function sms_private.enqueue(text,text,text,jsonb,timestamptz) to sms_api,sms_automation,sms_ai,sms_sender,sms_webhook;

