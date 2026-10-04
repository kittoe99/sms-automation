-- CRM-owned read-only preview. Requires form-first scheduling and E2 canonical CRM access.
-- No submissions, contacts, runs, jobs or messages are created.
create function sms_private.preview_form_automation(u text,t text,fid uuid,input jsonb) returns jsonb
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
    or (select count(distinct value) from jsonb_array_elements_text(field->'options'))<>jsonb_array_length(field->'options') then raise exception 'Select fields need 1-20 unique options';end if;
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
revoke all on function sms_private.preview_form_automation(text,text,uuid,jsonb) from public,anon,authenticated,sms_form_public;
grant execute on function sms_private.preview_form_automation(text,text,uuid,jsonb) to sms_api;
