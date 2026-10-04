-- CRM-owned. Requires CRM 20261004021248 and paired E2 canonical access/form readers.
-- Add isolated real test runs; never publish draft rules or create customer submissions.
alter table sms_private.form_runs alter column version drop not null,
 add column test_sequence jsonb, add column test_actor text, add column test_request jsonb,
 add constraint form_run_snapshot check (
  (test_sequence is null and test_actor is null and version is not null)
  or (test_sequence is not null and jsonb_typeof(test_sequence)='object' and test_actor is not null and version is null and jsonb_typeof(test_request)='object'));
create index form_test_runs_lookup on sms_private.form_runs(tenant_id,form_id,created_at desc) where test_sequence is not null;
create function sms_private.form_run_sequence(r sms_private.form_runs) returns jsonb
language sql stable security definer set search_path='' as $$
 select coalesce(r.test_sequence,(select v.sequence from sms_private.form_sequence_versions v
  where v.tenant_id=r.tenant_id and v.form_id=r.form_id and v.version=r.version))
$$;
revoke all on function sms_private.form_run_sequence(sms_private.form_runs) from public,anon,authenticated;
create index sms_test_message_run on public.sms_messages(tenant_id,(meta->>'form_run_id'),created_at desc)
 where meta->>'test_run'='true';

create function sms_private.list_form_test_runs(u text,t text,fid uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
begin
 perform sms_private.require_sms_reader(u,t);
 if not exists(select from public.sms_web_form_definitions where tenant_id=t and public_id=fid) then raise exception 'Form not found';end if;
 return jsonb_build_object('timeZone',(select time_zone from public.sms_businesses where tenant_id=t),
 'sendingEnabled',(select sending_enabled and status='active' from public.sms_businesses where tenant_id=t),
 'phoneNumber',(select from_number from sms_private.providers where tenant_id=t),
 'runs',coalesce((select jsonb_agg(jsonb_build_object('id',r.id,'phone',r.phone,'status',r.status,'createdAt',r.created_at,
  'nextSendAt',r.next_run_at,'accepted',r.send_index,'totalSends',(select sum((x->>'sendCount')::integer) from jsonb_array_elements(r.test_sequence->'steps') x),
  'notice',case r.reason when 'CUSTOMER_REPLIED' then 'Paused after a reply.' when 'OPTED_OUT' then 'Stopped after opt-out.'
   when 'MANUAL_STOP' then 'Stopped by staff.' when 'FORM_ARCHIVED' then 'Form archived.'
   else case when r.status='paused' then 'Paused. Check the message delivery status before starting another test.' else null end end,
  'delivered',(select count(*) from public.sms_messages m where m.tenant_id=t and m.meta->>'test_run'='true' and m.meta->>'form_run_id'=r.id::text and m.status='delivered'),
  'messages',coalesce((select jsonb_agg(jsonb_build_object('number',m.meta->'message_number','repeat',m.meta->'repeat_number',
    'body',m.body,'status',case when m.status in ('queued','sending','sent','delivered','failed','undelivered','cancelled','accepted') then m.status when m.status='submission_unknown' then 'delivery unknown' when m.status='submitting' then 'sending' else 'pending' end,
    'createdAt',m.created_at) order by m.created_at desc) from (select * from public.sms_messages where tenant_id=t and meta->>'test_run'='true' and meta->>'form_run_id'=r.id::text order by created_at desc limit 10) m),'[]'::jsonb)
 ) order by r.created_at desc) from (select * from sms_private.form_runs where tenant_id=t and form_id=fid and test_sequence is not null order by created_at desc limit 10) r),'[]'::jsonb));
end $$;

create function sms_private.start_form_test_run(u text,t text,fid uuid,p jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare f public.sms_web_form_definitions; b public.sms_businesses; old sms_private.form_runs; c public.sms_contacts;
 cfg jsonb; preview jsonb; sample jsonb:=p->'sample'; ctx jsonb; rid uuid:=(p->>'requestId')::uuid; appt timestamptz;
begin
 perform sms_private.require_admin(u); perform sms_private.require_sms_reader(u,t);
 if rid is null or p->'confirmed' is distinct from 'true'::jsonb or sample->'smsOptIn' is distinct from 'true'::jsonb then
  raise exception 'Confirm that you control this phone and consent to the full test sequence';end if;
 perform pg_advisory_xact_lock(hashtextextended('form-test:'||t||':'||rid,0));
 select * into old from sms_private.form_runs where id=rid;
 if old.id is not null then
  if old.tenant_id<>t or old.form_id<>fid or old.test_actor is distinct from u or old.test_request is distinct from p then raise exception 'Test request conflicts with an existing run';end if;
  return sms_private.list_form_test_runs(u,t,fid)||jsonb_build_object('runId',rid,'duplicate',true);
 end if;
 select * into f from public.sms_web_form_definitions where tenant_id=t and public_id=fid and not archived for share;
 if f.public_id is null then raise exception 'Form not found or archived';end if;
 select * into b from public.sms_businesses where tenant_id=t for share;
 if not b.sending_enabled or b.status<>'active' then raise exception 'Enable SMS sending for this business before starting a real test';end if;
 if not exists(select from sms_private.providers where tenant_id=t and provisioning_state='configured' and from_number is not null and auth_secret_id is not null) then raise exception 'Connect an approved business sender before starting a real test';end if;
 if sample->>'phone' ~ '^[+]1[0-9]{3}55501[0-9]{2}$' then raise exception 'Replace the sample phone with a real mobile number you control';end if;
 cfg:=coalesce(nullif(p->'sequence','null'::jsonb),(select draft from sms_private.form_sequences where tenant_id=t and form_id=fid));
 perform sms_private.validate_form_sequence(cfg,coalesce(p->'fields',f.fields),f.preset='bookings');
 preview:=sms_private.preview_form_automation(u,t,fid,p||jsonb_build_object('sequence',cfg,'submittedLocal','','scenario','none'));
 if jsonb_array_length(preview->'rows')=0 or preview->>'outcome' like 'Paused:%' then raise exception '%',preview->>'outcome';end if;
 perform pg_advisory_xact_lock(hashtextextended(t||':form-test-phone:'||(sample->>'phone'),0));
 if exists(select from sms_private.form_runs where tenant_id=t and form_id=fid and phone=sample->>'phone' and status in ('active','paused') and test_sequence is not null) then
  raise exception 'A test is already active or paused for this form and phone. Stop it before starting another';end if;
 if exists(select from sms_private.jobs where tenant_id=t and queue='sms_send_jobs' and payload->'request'->>'phone'=sample->>'phone' and status in ('submitting','submission_unknown')) then
  raise exception 'A previous send needs delivery reconciliation before another test can start';end if;
 insert into public.sms_contacts(tenant_id,phone,name,email,source,marketing_consent)
 values(t,sample->>'phone',btrim(sample->>'name'),lower(btrim(sample->>'email')),'form_test',true) on conflict(tenant_id,phone) do nothing;
 select * into c from public.sms_contacts where tenant_id=t and phone=sample->>'phone' for update;
 if c.opted_out or not c.marketing_consent then raise exception 'This phone has opted out or lacks messaging consent';end if;
 insert into public.sms_consent_events(tenant_id,contact_id,consent,source,evidence) values(t,c.id,true,'form_test','Staff confirmed control of recipient and consent to this test sequence');
 ctx:=jsonb_build_object('name',btrim(sample->>'name'),'first_name',split_part(btrim(sample->>'name'),' ',1),'phone',sample->>'phone',
  'email',lower(btrim(sample->>'email')),'business_name',b.name,'fields',coalesce(sample->'details','{}'));
 if cfg->>'trigger'='appointment' then appt:=(sample->>'appointmentLocal')::timestamp at time zone b.time_zone;end if;
 insert into sms_private.form_runs(id,tenant_id,form_id,version,submission_id,phone,context,appointment_at,next_run_at,test_sequence,test_actor,test_request)
 values(rid,t,fid,null,gen_random_uuid(),c.phone,ctx,appt,(preview->'rows'->0->>'at')::timestamptz,cfg,u,p);
 return sms_private.list_form_test_runs(u,t,fid)||jsonb_build_object('runId',rid,'duplicate',false);
exception when invalid_parameter_value or invalid_datetime_format or datetime_field_overflow then raise exception '%',sqlerrm using errcode='P0001';
end $$;

create function sms_private.stop_form_test_run(u text,t text,fid uuid,rid uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
begin
 perform sms_private.require_admin(u); perform sms_private.require_sms_reader(u,t);
 update sms_private.form_runs set status='stopped',reason='MANUAL_STOP',generation=generation+1,next_run_at=null
 where id=rid and tenant_id=t and form_id=fid and test_sequence is not null and status in ('active','paused');
 return sms_private.list_form_test_runs(u,t,fid);
end $$;
revoke all on function sms_private.list_form_test_runs(text,text,uuid),sms_private.start_form_test_run(text,text,uuid,jsonb),sms_private.stop_form_test_run(text,text,uuid,uuid) from public,anon,authenticated,sms_form_public;
grant execute on function sms_private.list_form_test_runs(text,text,uuid),sms_private.start_form_test_run(text,text,uuid,jsonb),sms_private.stop_form_test_run(text,text,uuid,uuid) to sms_api;
create or replace function sms_private.enqueue_due_automations() returns integer
language plpgsql security definer set search_path='' as $$
declare r record; n integer:=0; begin
  for r in select e.* from sms_private.form_runs e join public.sms_businesses b on b.tenant_id=e.tenant_id
    left join sms_private.form_sequences s on s.tenant_id=e.tenant_id and s.form_id=e.form_id
    join public.sms_web_form_definitions f on f.tenant_id=e.tenant_id and f.public_id=e.form_id
    where e.status='active' and e.next_run_at<=now() and b.sending_enabled and b.status='active'
      and (e.test_sequence is not null or s.enabled and f.enabled) and not f.archived
      and not exists(select from sms_private.jobs j where j.tenant_id=e.tenant_id and j.queue='automation_jobs'
        and j.dedupe_key='form:'||e.id||':'||e.generation||':'||e.send_index)
    order by e.next_run_at,e.id limit (select scheduler_batch_size from sms_private.runtime)
  loop
    perform sms_private.enqueue(r.tenant_id,'automation_jobs','form:'||r.id||':'||r.generation||':'||r.send_index,
      jsonb_build_object('form_run_id',r.id,'generation',r.generation,'send_index',r.send_index)); n:=n+1;
  end loop;
  return n;
end $$;

create or replace function sms_private.process_form_automation(jid uuid,token uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare j sms_private.jobs; r sms_private.form_runs; cfg jsonb; step jsonb; body text; key text[]; val text;
  tz text; due timestamptz; result jsonb;
begin
  j:=sms_private.lease(jid,token);
  if j.queue<>'automation_jobs' then raise exception 'Wrong queue'; end if;
  select * into r from sms_private.form_runs where tenant_id=j.tenant_id and id=(j.payload->>'form_run_id')::uuid for update;
  if r.id is null or r.status<>'active' or r.generation<>(j.payload->>'generation')::bigint or r.send_index<>(j.payload->>'send_index')::integer then
    perform sms_private.finish(jid,token,'cancelled','STALE_FORM_RUN'); return null; end if;
  cfg:=sms_private.form_run_sequence(r);
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
  update public.sms_messages set meta=meta||jsonb_build_object('form_id',r.form_id,'form_run_id',r.id,'sequence_version',r.version,'test_run',r.test_sequence is not null,
    'message_number',r.message_index+1,'repeat_number',r.repeat_index+1) where tenant_id=r.tenant_id and id=(result->>'messageId')::uuid;
  perform sms_private.finish(jid,token,'completed'); return result;
end $$;

create or replace function sms_private.begin_submission(jid uuid,token uuid) returns jsonb
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
      or r.appointment_at<=now() or not exists(select from public.sms_web_form_definitions f left join sms_private.form_sequences s on s.tenant_id=f.tenant_id and s.form_id=f.public_id
        where f.tenant_id=r.tenant_id and f.public_id=r.form_id and (r.test_sequence is not null or s.enabled and f.enabled) and not f.archived) then
      perform sms_private.finish(jid,token,'cancelled','STALE_FORM_RUN'); return null;
    end if;
    cfg:=sms_private.form_run_sequence(r);
    select time_zone into tz from public.sms_businesses where tenant_id=r.tenant_id;
    due:=sms_private.form_due(now(),0,'minute',tz,(cfg->>'startHour')::integer,(cfg->>'endHour')::integer);
    if due>now() then
      update sms_private.jobs set attempts=attempts-1 where id=jid;
      perform sms_private.finish(jid,token,'retry','OUTSIDE_WINDOW',least(3600,ceil(extract(epoch from due-now()))::integer)); return null;
    end if;
  end if;
  return sms_private.begin_submission_before_form_sequences(jid,token);
end $$;

create or replace function sms_private.accept_attempt(aid uuid,s text) returns void
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
  cfg:=sms_private.form_run_sequence(r);
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

create or replace function sms_private.form_reply_pause() returns trigger
language plpgsql security definer set search_path='' as $$ begin
  if new.direction='inbound' then
    update sms_private.form_runs r set status='paused',reason='CUSTOMER_REPLIED',generation=r.generation+1
    where r.tenant_id=new.tenant_id and r.phone=new.contact_phone and r.status='active'
      and sms_private.form_run_sequence(r)->>'replyPolicy'='pause';
  end if;
  return new;
end $$;

create or replace function sms_private.start_form_run(fid uuid,sid uuid) returns jsonb
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
    and test_sequence is null and status in ('active','paused') and appointment_at is not distinct from appt) then return result; end if;
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

-- Qualify dropdown options against the preview answer variable.
create or replace function sms_private.preview_form_automation(u text,t text,fid uuid,input jsonb) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare f public.sms_web_form_definitions; b public.sms_businesses; saved sms_private.form_sequences;
 cfg jsonb; p jsonb:=coalesce(input->'sample','{}'); step jsonb; field jsonb; answers jsonb; value jsonb;
 customer_name text; normalized_phone text; normalized_email text; k text; field_type text; keys text[]:='{}';
 start_at timestamptz; appointment timestamptz; due timestamptz; ctx jsonb; body text; token text[]; val text;
 rows jsonb:='[]'; total integer:=0; mi integer:=0; ri integer; shown integer:=0; stopped text; missing text;
 scenario text:=coalesce(input->>'scenario','none'); warnings jsonb:='[]'; result jsonb;
begin
 perform sms_private.require_sms_reader(u,t);
 select * into f from public.sms_web_form_definitions where tenant_id=t and public_id=fid;
 if f.public_id is null then raise exception 'Form not found' using errcode='P0002'; end if;
 select * into b from public.sms_businesses where tenant_id=t;
 select * into saved from sms_private.form_sequences where tenant_id=t and form_id=fid;
 if input ? 'fields' then f.fields:=input->'fields'; end if;
 if jsonb_typeof(f.fields) is distinct from 'array' or jsonb_array_length(f.fields)>20 then raise exception 'Invalid form fields'; end if;
 for field in select jsonb_array_elements(f.fields) loop
  k:=field->>'key';
  if jsonb_typeof(field) is distinct from 'object' or k is null or k!~'^[a-z][a-z0-9_]{0,39}$' or k=any(keys)
   or k=any(array['name','phone','email','appointment_at','sms_opt_in','consent_evidence'])
   or coalesce(field->>'type','') not in ('text','textarea','select','checkbox','date')
   or jsonb_typeof(coalesce(field->'required','false'::jsonb)) is distinct from 'boolean'
   or length(btrim(coalesce(field->>'label',''))) not between 1 and 100 then raise exception 'Complete each custom field before testing'; end if;
  if field->>'type'='select' then
   if jsonb_typeof(field->'options') is distinct from 'array' or jsonb_array_length(field->'options') not between 1 and 20
    or exists(select from jsonb_array_elements(field->'options') v where jsonb_typeof(v.value)<>'string' or length(btrim(v.value #>> '{}')) not between 1 and 100)
    or (select count(distinct opt.value) from jsonb_array_elements_text(field->'options') opt)<>jsonb_array_length(field->'options') then raise exception 'Select fields need 1-20 unique options';end if;
  elsif field ? 'options' then raise exception 'Only select fields may have options';end if;
  keys:=array_append(keys,k);
 end loop;
  customer_name:=btrim(coalesce(p->>'name',''));
  normalized_phone:=btrim(coalesce(p->>'phone',''));
  normalized_email:=lower(btrim(coalesce(p->>'email','')));
  if length(customer_name) not between 1 and 200 or normalized_phone !~ '^[+][1-9][0-9]{7,14}$'
     or length(normalized_email) not between 3 and 320
     or normalized_email !~ '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$'
     or jsonb_typeof(p->'smsOptIn') is distinct from 'boolean' then raise exception 'Invalid required form fields'; end if;
  answers:=coalesce(p->'details','{}'::jsonb);
  if jsonb_typeof(answers) is distinct from 'object' then raise exception 'Custom answers must be an object'; end if;
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

 if scenario not in ('none','reply','opt_out') then raise exception 'Choose a valid test scenario'; end if;
 if nullif(input->>'submittedLocal','') is not null then
  if input->>'submittedLocal' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}$' then raise exception 'Invalid test start time';end if;
  start_at:=(input->>'submittedLocal')::timestamp at time zone b.time_zone;
 else start_at:=now();end if;
 if f.preset='bookings' then
  if coalesce(p->>'appointmentLocal','') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}$' then raise exception 'Enter an appointment date and time';end if;
  appointment:=(p->>'appointmentLocal')::timestamp at time zone b.time_zone;
  if appointment<=start_at then raise exception 'The appointment must be after the test submission';end if;
 end if;
 cfg:=nullif(coalesce(nullif(input->'sequence','null'::jsonb),saved.draft),'{}'::jsonb);
 if cfg is not null and (jsonb_typeof(cfg) is distinct from 'object' or jsonb_typeof(cfg->'steps') is distinct from 'array') then raise exception 'Invalid automation rules';end if;
 result:=jsonb_build_object('simulation',true,'timeZone',b.time_zone,'submittedAt',start_at,'publishedVersion',saved.published_version,
  'automationEnabled',coalesce(saved.enabled,false),'sendingEnabled',b.sending_enabled and b.status='active');
 if not f.enabled or f.archived then warnings:=warnings||jsonb_build_array('This form is not collecting live submissions.');end if;
 if not coalesce(saved.enabled,false) then warnings:=warnings||jsonb_build_array('The published automation is not enabled for live submissions.');end if;
 if not b.sending_enabled or b.status<>'active' then warnings:=warnings||jsonb_build_array('SMS sending is disabled or paused for this business.');end if;
 if cfg is null or coalesce(jsonb_array_length(cfg->'steps'),0)=0 then
  return result||jsonb_build_object('rows','[]'::jsonb,'totalSends',0,'truncated',false,'warnings',warnings,'outcome','Form answers are valid. Add messages and timing to preview an automation.');end if;
 perform sms_private.validate_form_sequence(cfg,f.fields,f.preset='bookings');
 select sum((s->>'sendCount')::integer) into total from jsonb_array_elements(cfg->'steps') s;
 if not (p->>'smsOptIn')::boolean then
  return result||jsonb_build_object('rows','[]'::jsonb,'totalSends',total,'truncated',false,'warnings',warnings,'outcome','No automation: SMS consent was not selected.');end if;
 if exists(select from public.sms_contacts where tenant_id=t and phone=normalized_phone and (opted_out or not marketing_consent)) then
  return result||jsonb_build_object('rows','[]'::jsonb,'totalSends',total,'truncated',false,'warnings',warnings,'outcome','No automation: this phone has opted out or lacks messaging consent.');end if;
 ctx:=jsonb_build_object('name',customer_name,'first_name',split_part(customer_name,' ',1),'phone',normalized_phone,'email',normalized_email,'business_name',b.name,'fields',answers);
 due:=case when cfg->>'trigger'='appointment' then appointment-make_interval(hours=>(cfg->>'leadHours')::integer) else start_at end;
 <<messages>>
 for step in select jsonb_array_elements(cfg->'steps') loop
  mi:=mi+1; missing:=null;
  due:=sms_private.form_due(due,(step->>'delayCount')::integer,step->>'delayUnit',b.time_zone,(cfg->>'startHour')::integer,(cfg->>'endHour')::integer);
  due:=sms_private.form_due(greatest(due,start_at),0,'minute',b.time_zone,(cfg->>'startHour')::integer,(cfg->>'endHour')::integer);
  body:=step->>'body';
  for token in select regexp_matches(body,'\{\{([^{}]+)\}\}','g') loop
   val:=case when token[1]='appointment_at' then to_char(appointment at time zone b.time_zone,'Mon DD, YYYY HH24:MI')||' ('||b.time_zone||')'
    when token[1] like 'field.%' then ctx->'fields'->>substring(token[1] from 7) else ctx->>token[1] end;
   if nullif(btrim(val),'') is null then missing:=token[1];exit;end if;
   body:=replace(body,'{{'||token[1]||'}}',val);
  end loop;
  if missing is not null then stopped:='Paused: missing message field '||missing;exit;end if;
  if length(body)>1600 or position('{{' in body)>0 then stopped:='Paused: personalized message is too long or contains unresolved fields.';exit;end if;
  for ri in 1..(step->>'sendCount')::integer loop
   if shown>=200 then exit messages;end if;
   if cfg->>'trigger'='appointment' and due>=appointment then stopped:='Stopped at appointment time.';exit messages;end if;
   shown:=shown+1;
   rows:=rows||jsonb_build_array(jsonb_build_object('message',mi,'repeat',ri,'at',due,'body',body));
   if shown=1 and scenario='opt_out' then stopped:='Stopped: the test customer opted out after the first message.';exit messages;end if;
   if shown=1 and scenario='reply' and cfg->>'replyPolicy'='pause' then stopped:='Paused: the test customer replied after the first message.';exit messages;end if;
   if ri<(step->>'sendCount')::integer then due:=sms_private.form_due(due,(step->>'intervalCount')::integer,step->>'intervalUnit',b.time_zone,(cfg->>'startHour')::integer,(cfg->>'endHour')::integer);end if;
  end loop;
 end loop;
 return result||jsonb_build_object('rows',rows,'totalSends',total,'truncated',stopped is null and shown<total,'warnings',warnings,
  'outcome',coalesce(stopped,case when shown<total then 'Showing the first 200 scheduled sends.' else 'Simulation completed. No messages were sent or leads saved.' end));
exception when invalid_parameter_value or invalid_datetime_format or datetime_field_overflow then
 raise exception 'Check your rules and test dates: %',sqlerrm using errcode='P0001';
end $$;
