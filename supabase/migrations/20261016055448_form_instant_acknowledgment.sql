-- CRM-owned forward migration after the five forms MCP migrations and current paired E2 baseline.
-- Opt-in first acknowledgment only. No existing settings, versions, runs or grants change.
-- All consent, STOP, overlap, reply, lease, generation and provider-idempotency gates remain intact.

create function sms_private.form_ack_window(cfg jsonb,first_send boolean) returns jsonb
language sql immutable set search_path='' as $$
 select case when first_send and cfg->'instantAcknowledgment'='true'::jsonb
   and cfg->>'trigger'='submission' and cfg->'steps'->0->>'delayCount'='0'
 then cfg||jsonb_build_object('startHour',0,'endHour',24) else cfg end
$$;
revoke all on function sms_private.form_ack_window(jsonb,boolean) from public,anon,authenticated,sms_api,crm_mcp,sms_sender,sms_automation,sms_form_public;

create or replace function sms_private.validate_form_sequence(s jsonb,fields jsonb,booking boolean) returns void
language plpgsql immutable set search_path='' as $$
declare step jsonb; token text[]; begin
  if s ? 'instantAcknowledgment' then
    if jsonb_typeof(s->'instantAcknowledgment') is distinct from 'boolean' then raise exception 'Instant acknowledgment must be boolean'; end if;
    if s->'instantAcknowledgment'='true'::jsonb and
      (s->>'trigger' is distinct from 'submission' or s->'steps'->0->>'delayCount' is distinct from '0')
      then raise exception 'Instant acknowledgment requires a submission trigger and zero first delay'; end if;
  end if;
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

create or replace function sms_private.direct_validate(s jsonb) returns void
language plpgsql set search_path='' as $$
declare checked jsonb; begin
 if s->'instantAcknowledgment'='true'::jsonb then raise exception 'Instant acknowledgment is only available for form submissions'; end if;
 if s->>'trigger' is distinct from 'submission' or coalesce(s->>'replyPolicy','') not in ('pause','continue','stop') then raise exception 'Invalid direct sequence'; end if;
 if jsonb_typeof(s->'steps') is distinct from 'array' then raise exception 'Invalid direct messages'; end if;
 if exists(select from jsonb_array_elements(s->'steps') v where length(btrim(v->>'body')) not between 1 and 1600) then raise exception 'Messages must contain 1 to 1600 characters'; end if;
 checked:=s||jsonb_build_object('replyPolicy',case when s->>'replyPolicy'='stop' then 'pause' else s->>'replyPolicy' end,
  'steps',(select jsonb_agg(v||jsonb_build_object('body',replace(v->>'body','{{request}}','{{name}}')) order by n)
    from jsonb_array_elements(s->'steps') with ordinality a(v,n)));
 perform sms_private.validate_form_sequence(checked,'[]',false);
end $$;

create or replace function sms_private.mcp_sms_validate_sequence(s jsonb,k text,fields jsonb,preset text) returns void
language plpgsql immutable set search_path='' as $$
declare step jsonb; n text; begin
 if jsonb_typeof(s) is distinct from 'object' then raise exception 'Sequence must be an object'; end if;
 if exists(select from jsonb_object_keys(s) x where not x=any(array['trigger','leadHours','replyPolicy','startHour','endHour','steps','instantAcknowledgment']))
  or not s ?& array['trigger','leadHours','replyPolicy','startHour','endHour','steps'] then raise exception 'Invalid sequence fields'; end if;
 foreach n in array array['leadHours','startHour','endHour'] loop
  if jsonb_typeof(s->n) is distinct from 'number' then raise exception 'Sequence timing must use whole numbers'; end if;
  if (s->>n)::numeric<>trunc((s->>n)::numeric) or (s->>n)::numeric not between 0 and 8760 then raise exception 'Invalid sequence timing'; end if;
 end loop;
 if jsonb_typeof(s->'steps') is distinct from 'array' then raise exception 'Messages must be an array'; end if;
 if jsonb_array_length(s->'steps') not between 1 and 50 then raise exception 'Use 1 to 50 messages'; end if;
 for step in select value from jsonb_array_elements(s->'steps') loop
  if jsonb_typeof(step) is distinct from 'object' then raise exception 'Invalid message'; end if;
  if exists(select from jsonb_object_keys(step) x where not x=any(array['body','delayCount','delayUnit','sendCount','intervalCount','intervalUnit'])) then raise exception 'Invalid message fields'; end if;
  foreach n in array array['delayCount','sendCount','intervalCount'] loop
   if jsonb_typeof(step->n) is distinct from 'number' then raise exception 'Message timing must use whole numbers'; end if;
   if (step->>n)::numeric<>trunc((step->>n)::numeric) or (step->>n)::numeric not between 0 and 1000 then raise exception 'Invalid message timing'; end if;
  end loop;
 end loop;
 if k='form' then perform sms_private.validate_form_sequence(s,fields,preset='bookings');
 elsif k='contact' then perform sms_private.direct_validate(s);
 else raise exception 'Invalid automation kind'; end if;
end $$;

create or replace function sms_private.mcp_sms_sequence(s jsonb) returns jsonb
language sql immutable set search_path='' as $$
 select case when s is null or s='{}' then null else jsonb_build_object(
  'trigger',s->'trigger','leadHours',coalesce(s->'leadHours','24'::jsonb),'replyPolicy',s->'replyPolicy',
  'startHour',s->'startHour','endHour',s->'endHour','steps',coalesce((select jsonb_agg(jsonb_build_object(
  'body',v->'body','delayCount',v->'delayCount','delayUnit',v->'delayUnit','sendCount',v->'sendCount',
  'intervalCount',v->'intervalCount','intervalUnit',v->'intervalUnit') order by n)
  from jsonb_array_elements(s->'steps') with ordinality a(v,n)),'[]')) || case when s ? 'instantAcknowledgment' then jsonb_build_object('instantAcknowledgment',s->'instantAcknowledgment') else '{}'::jsonb end end
$$;

create or replace function sms_private.start_form_run(fid uuid, sid uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
  perform sms_private.coordination_lock(f.tenant_id,p->>'phone');

  select * into s from sms_private.form_sequences where tenant_id=f.tenant_id and form_id=fid and enabled;
  if s.published_version is null then return result; end if;
  if exists(select from public.sms_contacts where tenant_id=f.tenant_id and phone=p->>'phone' and (opted_out or not marketing_consent)) then return result; end if;
  select sequence into cfg from sms_private.form_sequence_versions where tenant_id=f.tenant_id and form_id=fid and version=s.published_version;
  if cfg->>'trigger'='submission' and exists(select from public.sms_contacts where tenant_id=f.tenant_id and phone=p->>'phone' and enquiry_blocked) then return result||jsonb_build_object('skipReason','CONTACT_FOLLOWUPS_BLOCKED');end if;
  execute format('select to_jsonb(x) from public.%I x where tenant_id=$1 and id=$2',sms_private.web_form_table(f.preset)) into row_data using f.tenant_id,(result->>'submissionId')::uuid;
  appt:=case when cfg->>'trigger'='appointment' then (row_data->>'appointment_at')::timestamptz end;
  perform pg_advisory_xact_lock(hashtextextended(f.tenant_id||':'||fid||':'||(p->>'phone'),418));
  if exists(select from sms_private.form_runs where tenant_id=f.tenant_id and form_id=fid and phone=p->>'phone'
    and test_sequence is null and status in ('active','paused') and appointment_at is not distinct from appt) then return result; end if;
  select time_zone into tz from public.sms_businesses where tenant_id=f.tenant_id;
  cfg:=sms_private.form_ack_window(cfg,true);
  step:=cfg->'steps'->0;
  due:=sms_private.form_due(case when appt is not null then appt-make_interval(hours=>(cfg->>'leadHours')::integer) else now() end,
    (step->>'delayCount')::integer,step->>'delayUnit',tz,(cfg->>'startHour')::integer,(cfg->>'endHour')::integer);
  ctx:=jsonb_build_object('name',row_data->>'name','first_name',split_part(row_data->>'name',' ',1),'phone',row_data->>'phone','email',row_data->>'email',
    'business_name',(select name from public.sms_businesses where tenant_id=f.tenant_id),'fields',row_data->'details');
  insert into sms_private.form_runs(tenant_id,form_id,version,submission_id,intake_id,phone,context,appointment_at,next_run_at)
    values(f.tenant_id,fid,s.published_version,(result->>'submissionId')::uuid,(row_data->>'automation_intake_id')::uuid,p->>'phone',ctx,appt,due);
  return result;
end $function$
;

create or replace function sms_private.process_form_automation_before_coordination(jid uuid, token uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare j sms_private.jobs; r sms_private.form_runs; cfg jsonb; step jsonb; body text; key text[]; val text;
  tz text; due timestamptz; result jsonb;
begin
  j:=sms_private.lease(jid,token);
  if j.queue<>'automation_jobs' then raise exception 'Wrong queue'; end if;
  select * into r from sms_private.form_runs where tenant_id=j.tenant_id and id=(j.payload->>'form_run_id')::uuid for update;
  if r.id is null or not sms_private.run_enabled(r) or r.status<>'active' or r.generation<>(j.payload->>'generation')::bigint or r.send_index<>(j.payload->>'send_index')::integer then
    perform sms_private.finish(jid,token,'cancelled','STALE_FORM_RUN'); return null; end if;
  cfg:=sms_private.form_ack_window(sms_private.form_run_sequence(r),r.origin='form' and r.send_index=0 and r.message_index=0 and r.repeat_index=0);
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
    'origin',r.origin,'direct_template_id',r.direct_template_id,'message_number',r.message_index+1,'repeat_number',r.repeat_index+1) where tenant_id=r.tenant_id and id=(result->>'messageId')::uuid;
  perform sms_private.finish(jid,token,'completed'); return result;
end $function$
;

create or replace function sms_private.begin_submission_before_inbound_agent(jid uuid, token uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare j sms_private.jobs; p jsonb; r sms_private.form_runs; cfg jsonb; tz text; due timestamptz; begin
  j:=sms_private.lease(jid,token); p:=j.payload->'request';
  if p ? 'enrollment_id' or p ? 'ai_run_id' or j.dedupe_key like 'ai:%'
    or p ? 'conversation_generation' and not p ? 'form_run_id' then
    perform sms_private.finish(jid,token,'cancelled','SMS_AI_DISABLED'); return null;
  end if;
  if p ? 'form_run_id' then
    select * into r from sms_private.form_runs where tenant_id=j.tenant_id and id=(p->>'form_run_id')::uuid for update;
    if r.id is null or r.status<>'active' or r.generation<>(p->>'run_generation')::bigint or r.send_index<>(p->>'send_index')::integer
      or r.appointment_at<=now() or not sms_private.run_enabled(r) then
      perform sms_private.finish(jid,token,'cancelled','STALE_FORM_RUN'); return null;
    end if;
    cfg:=sms_private.form_ack_window(sms_private.form_run_sequence(r),r.origin='form' and r.send_index=0 and r.message_index=0 and r.repeat_index=0);
    select time_zone into tz from public.sms_businesses where tenant_id=r.tenant_id;
    due:=sms_private.form_due(now(),0,'minute',tz,(cfg->>'startHour')::integer,(cfg->>'endHour')::integer);
    if due>now() then
      update sms_private.jobs set attempts=attempts-1 where id=jid;
      perform sms_private.finish(jid,token,'retry','OUTSIDE_WINDOW',least(3600,ceil(extract(epoch from due-now()))::integer)); return null;
    end if;
  end if;
  return sms_private.begin_submission_before_form_sequences(jid,token);
end $function$
;

create or replace function sms_private.simulate_sms_sequence(cfg jsonb,ctx jsonb,start_at timestamptz,appointment timestamptz,tz text,scenario text,cap integer)
returns jsonb language plpgsql immutable set search_path='' as $$
declare step jsonb; timing jsonb; due timestamptz; quiet_until timestamptz; body text; token text[]; val text;
 rows jsonb:='[]'; total integer; mi integer:=0; ri integer; shown integer:=0; stopped text; missing text;
begin
 if scenario not in ('none','reply','opt_out') or cap not between 1 and 200 then raise exception 'Invalid simulation options'; end if;
 select sum((s->>'sendCount')::integer) into total from jsonb_array_elements(cfg->'steps') s;
 due:=case when cfg->>'trigger'='appointment' then appointment-make_interval(hours=>(cfg->>'leadHours')::integer) else start_at end;
 <<messages>>
 for step in select jsonb_array_elements(cfg->'steps') loop
  mi:=mi+1;missing:=null;
  timing:=sms_private.form_ack_window(cfg,mi=1);
  due:=sms_private.form_due(due,(step->>'delayCount')::integer,step->>'delayUnit',tz,(timing->>'startHour')::integer,(timing->>'endHour')::integer);
  due:=sms_private.form_due(greatest(due,start_at,quiet_until),0,'minute',tz,(timing->>'startHour')::integer,(timing->>'endHour')::integer);
  body:=step->>'body';
  for token in select regexp_matches(body,'\{\{([^{}]+)\}\}','g') loop
   val:=case when token[1]='appointment_at' then to_char(appointment at time zone tz,'Mon DD, YYYY HH24:MI')||' ('||tz||')'
    when token[1] like 'field.%' then ctx->'fields'->>substring(token[1] from 7) else ctx->>token[1] end;
   if nullif(btrim(val),'') is null then missing:=token[1];exit;end if;
   body:=replace(body,'{{'||token[1]||'}}',val);
  end loop;
  if missing is not null then stopped:='Paused: missing message field '||missing;exit;end if;
  if length(body)>1600 or position('{{' in body)>0 then stopped:='Paused: personalized message is too long or contains unresolved fields.';exit;end if;
  for ri in 1..(step->>'sendCount')::integer loop
   if shown>=cap then exit messages;end if;
   timing:=sms_private.form_ack_window(cfg,mi=1 and ri=1);
   due:=sms_private.form_due(greatest(due,quiet_until),0,'minute',tz,(timing->>'startHour')::integer,(timing->>'endHour')::integer);
   if cfg->>'trigger'='appointment' and due>=appointment then stopped:='Stopped at appointment time.';exit messages;end if;
   shown:=shown+1;rows:=rows||jsonb_build_array(jsonb_build_object('message',mi,'repeat',ri,'at',due,'body',body));
   if shown=1 and scenario='opt_out' then stopped:='Stopped: the test customer opted out after the first message.';exit messages;end if;
   if shown=1 and scenario='reply' then
    if cfg->>'replyPolicy'='pause' then stopped:='Paused: the test customer replied after the first message.';exit messages;
    elsif cfg->>'replyPolicy'='stop' then stopped:='Stopped: the test customer replied after the first message.';exit messages;
    elsif cfg->>'trigger'='submission' then quiet_until:=due+interval '30 minutes'; end if;
   end if;
   if ri<(step->>'sendCount')::integer then timing:=cfg;due:=sms_private.form_due(due,(step->>'intervalCount')::integer,step->>'intervalUnit',tz,(timing->>'startHour')::integer,(timing->>'endHour')::integer);end if;
  end loop;
 end loop;
 return jsonb_build_object('rows',rows,'totalSends',total,'truncated',stopped is null and shown<total,
  'outcome',coalesce(stopped,case when shown<total then 'Showing the first '||cap||' scheduled sends.' else 'Simulation completed. No messages were sent or leads saved.' end));
end $$;

create or replace function sms_private.form_due(base timestamptz,n integer,unit text,tz text,start_hour integer,end_hour integer)
returns timestamptz language plpgsql immutable set search_path='' as $$
declare d timestamp; begin
  -- Preserve the exact instant through DST folds for an unrestricted zero delay.
  if n=0 and start_hour=0 and end_hour=24 then return base; end if;
  if unit='minute' then d:=(base+make_interval(mins=>n)) at time zone tz;
  elsif unit='hour' then d:=(base+make_interval(hours=>n)) at time zone tz;
  elsif unit='month' then d:=(base at time zone tz)+make_interval(months=>n);
  else d:=(base at time zone tz)+make_interval(days=>n*case when unit='week' then 7 else 1 end); end if;
  if d::time<make_time(start_hour,0,0) then d:=date_trunc('day',d)+make_interval(hours=>start_hour);
  elsif end_hour<24 and d::time>=make_time(end_hour,0,0) then d:=date_trunc('day',d)+interval '1 day'+make_interval(hours=>start_hour); end if;
  return d at time zone tz;
end $$;
